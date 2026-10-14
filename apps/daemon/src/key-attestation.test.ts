import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { approvalKeyMessage } from "./approval-attestation.js";
import { setAttestationRootsForTest, verifyKeyAttestationChain, pinnedRoots } from "./key-attestation.js";
import { GOOD_TEE, keyDescription, makeCert, makeChain } from "./test-pki.js";

const SECRET = "key-attestation-jwt-secret";
const ENROLL = "key-attestation-enroll-token";
process.env.GATEWAY_JWT_SECRET = SECRET;
process.env.GATEWAY_ENROLL_TOKEN = ENROLL;
process.env.NODE_ENV = "test";
delete process.env.EXOCORTEX_ALLOW_UNATTESTED_KEYS;
const { server } = await import("./server.js");

const CHALLENGE = "challenge-abc_123";
type KP = { publicKey: KeyObject; privateKey: KeyObject };
const dk = (): KP => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spkiOf = (k: KP) => new Uint8Array(k.publicKey.export({ type: "spki", format: "der" }));
function build(over: Partial<Parameters<typeof keyDescription>[0]> = {}) {
  const key = dk();
  const kd = keyDescription({ challenge: Buffer.from(CHALLENGE), ...over });
  return { key, ...makeChain(key, kd) };
}
const verify = (c: ReturnType<typeof build>, extra: { challenge?: string; now?: number } = {}) =>
  verifyKeyAttestationChain(
    c.chainB64,
    { pubkeySpki: spkiOf(c.key), challenge: extra.challenge ?? CHALLENGE },
    { roots: [c.rootPem], now: extra.now },
  );

test("pinned Google roots parse (2 anchors)", () => {
  assert.equal(pinnedRoots().length, 2);
});

test("accepts a hardware-backed, biometric-gated chain", () => {
  const r = verify(build());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(verify(build({ level: 2 })).ok, true, "StrongBox");
});

test("production pins reject a chain that ends at an unpinned root", () => {
  const c = build();
  assert.equal(verifyKeyAttestationChain(c.chainB64, { pubkeySpki: spkiOf(c.key), challenge: CHALLENGE }).ok, false);
});

test("negative: software-only, wrong challenge, missing/bad auth fields, key mismatch", () => {
  const bad = (r: { ok: boolean }, why: string) => assert.equal(r.ok, false, why);
  bad(verify(build({ level: 0 })), "software-only");
  bad(verify(build({ level: 1, kmLevel: 0 })), "keymaster software");
  bad(verify(build(), { challenge: "other-challenge" }), "challenge");
  bad(verify(build({ tee: { ...GOOD_TEE, noAuthRequired: true } })), "noAuthRequired");
  bad(verify(build({ tee: { ...GOOD_TEE, userAuthType: 1 } })), "password only");
  bad(verify(build({ tee: { ...GOOD_TEE, userAuthType: undefined } })), "no userAuthType");
  bad(verify(build({ tee: { ...GOOD_TEE, purpose: [3] } })), "purpose");
  bad(verify(build({ tee: { ...GOOD_TEE, algorithm: 1 } })), "algorithm");
  bad(verify(build({ tee: { ...GOOD_TEE, origin: 2 } })), "origin");
  bad(verify(build({ tee: {}, software: GOOD_TEE })), "software-enforced only");
  const c = build();
  bad(
    verifyKeyAttestationChain(c.chainB64, { pubkeySpki: spkiOf(dk()), challenge: CHALLENGE }, { roots: [c.rootPem] }),
    "leaf key mismatch",
  );
});

test("negative: broken signature, expired cert, short or malformed chain", () => {
  const c = build();
  const key = dk();
  const forgedLeaf = makeCert({
    subject: "Test Attestation Leaf",
    issuer: "Test Attestation Intermediate",
    issuerKey: dk().privateKey,
    subjectKey: key,
    keyDescription: keyDescription({ challenge: Buffer.from(CHALLENGE) }),
  });
  assert.equal(
    verifyKeyAttestationChain(
      [forgedLeaf.b64, c.inter.b64, c.root.b64],
      { pubkeySpki: spkiOf(key), challenge: CHALLENGE },
      { roots: [c.rootPem] },
    ).ok,
    false,
    "bad signature",
  );
  assert.equal(verify(c, { now: Date.now() + 2 * 365 * 86400_000 }).ok, false, "expired");
  for (const chain of [undefined, null, "x", [], [c.leaf.b64], ["nope", "nope2"], [c.leaf.b64, c.leaf.b64]]) {
    assert.equal(
      verifyKeyAttestationChain(chain, { pubkeySpki: spkiOf(c.key), challenge: CHALLENGE }, { roots: [c.rootPem] }).ok,
      false,
    );
  }
  assert.equal(
    verifyKeyAttestationChain([c.leaf.b64, c.inter.b64], { pubkeySpki: spkiOf(c.key), challenge: CHALLENGE }, { roots: [c.rootPem] }).ok,
    false,
    "stops short of root",
  );
});

test("POST /v3/devices/approval-key: chain required, key_attested only after verification, hatch skips only the chain", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice({
    device_id: "dev_att",
    name: "att",
    platform: "android",
    pubkey_spki: new Uint8Array([0]),
    key_attested: 0,
    scopes: ["telemetry:write"],
    enrolled_at: Date.now(),
    revoked_at: null,
  });
  setDatabase(db);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  const jwt = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken("dev_att", SECRET)}` };
  const challenge = async () =>
    (await (await fetch(`${base}/v3/devices/approval-key/challenge`, { method: "POST", headers: jwt })).json()).challenge as string;
  const register = async (key: KP, chain: unknown, ch: string, signer: KP = key) => {
    const s = createSign("sha256");
    s.update(approvalKeyMessage("dev_att", ch));
    return fetch(`${base}/v3/devices/approval-key`, {
      method: "POST",
      headers: { ...jwt, "X-Enroll-Token": ENROLL },
      body: JSON.stringify({
        pubkey_b64: Buffer.from(spkiOf(key)).toString("base64"),
        challenge: ch,
        signature_b64: s.sign(signer.privateKey).toString("base64"),
        ...(chain !== undefined ? { attestation_chain: chain } : {}),
      }),
    });
  };
  try {
    const key = dk();
    assert.equal((await register(key, undefined, await challenge())).status, 400, "missing chain");
    assert.equal(db.getDevice("dev_att")?.key_attested, 0);

    let ch = await challenge();
    let c = makeChain(key, keyDescription({ challenge: Buffer.from(ch), level: 0 }));
    setAttestationRootsForTest([c.rootPem]);
    assert.equal((await register(key, c.chainB64, ch)).status, 400, "software-only");
    assert.equal(db.getDevice("dev_att")?.key_attested, 0);

    ch = await challenge();
    c = makeChain(key, keyDescription({ challenge: Buffer.from("stale") }));
    setAttestationRootsForTest([c.rootPem]);
    assert.equal((await register(key, c.chainB64, ch)).status, 400, "wrong challenge");

    ch = await challenge();
    c = makeChain(key, keyDescription({ challenge: Buffer.from(ch) }));
    setAttestationRootsForTest([c.rootPem]);
    const ok = await register(key, c.chainB64, ch);
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(db.getDevice("dev_att")?.key_attested, 1);

    setAttestationRootsForTest(null);
    const key2 = dk();
    ch = await challenge();
    c = makeChain(key2, keyDescription({ challenge: Buffer.from(ch) }));
    assert.equal((await register(key2, c.chainB64, ch)).status, 400, "unpinned root");

    process.env.EXOCORTEX_ALLOW_UNATTESTED_KEYS = "1";
    ch = await challenge();
    const hatchResult = await register(key2, undefined, ch);
    assert.equal(hatchResult.status, 200, "hatch skips chain");
    assert.equal((await hatchResult.json()).attested, false, "hatch key is recorded as unattested");
    assert.equal(db.getDevice("dev_att")?.key_attested, 0);
    ch = await challenge();
    assert.equal((await register(key2, undefined, ch, dk())).status, 400, "hatch must not skip proof of possession");
  } finally {
    delete process.env.EXOCORTEX_ALLOW_UNATTESTED_KEYS;
    setAttestationRootsForTest(null);
    await new Promise<void>((r) => server.close(() => r()));
    setDatabase(null);
  }
});
