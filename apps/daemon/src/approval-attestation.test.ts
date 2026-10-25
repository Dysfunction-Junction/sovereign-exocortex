import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import {
  ChallengeStore,
  approvalKeyMessage,
  approvalMessage,
  verifyApprovalAttestation,
} from "./approval-attestation.js";

const TEST_SECRET = "approval-attestation-jwt-secret";
const ENROLL = "approval-enroll-token";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.GATEWAY_ENROLL_TOKEN = ENROLL;
process.env.NODE_ENV = "test";

const { server } = await import("./server.js");

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, spki: new Uint8Array(publicKey.export({ format: "der", type: "spki" })) };
}

function sign(privateKey: KeyObject, message: Buffer): string {
  const s = createSign("sha256");
  s.update(message);
  return s.sign(privateKey).toString("base64"); // DER, like Android SHA256withECDSA
}

const ctx = { deviceId: "dev_a", proposalId: "prop_1", nonce: "nonce_1", action: "approve" };

function attestation(privateKey: KeyObject, c = ctx, ts = Date.now()) {
  return { v: 1, method: "biometric", ts, sig: sign(privateKey, approvalMessage(c, ts)) };
}

test("verifyApprovalAttestation: accepts a valid signature from the bound key", () => {
  const k = p256();
  assert.equal(verifyApprovalAttestation(attestation(k.privateKey), ctx, k.spki, true).ok, true);
  // string (canonical JSON) form, as forwarded by the phone/gateway
  assert.equal(verifyApprovalAttestation(JSON.stringify(attestation(k.privateKey)), ctx, k.spki, true).ok, true);
});

test("verifyApprovalAttestation: rejects wrong nonce, proposal, action, device and tampered fields", () => {
  const k = p256();
  const att = attestation(k.privateKey);
  for (const bad of [
    { ...ctx, nonce: "nonce_2" },
    { ...ctx, proposalId: "prop_2" },
    { ...ctx, action: "reject" },
    { ...ctx, deviceId: "dev_b" },
  ]) {
    assert.equal(verifyApprovalAttestation(att, bad, k.spki, true).ok, false);
  }
  assert.equal(verifyApprovalAttestation({ ...att, ts: att.ts + 1 }, ctx, k.spki, true).ok, false);
});

test("verifyApprovalAttestation: rejects another device's key, a missing key and a stale timestamp", () => {
  const k = p256();
  const other = p256();
  const att = attestation(k.privateKey);
  assert.equal(verifyApprovalAttestation(att, ctx, other.spki, true).ok, false);
  assert.equal(verifyApprovalAttestation(att, ctx, null, true).ok, false);
  assert.equal(verifyApprovalAttestation(att, ctx, k.spki, false).ok, false);
  const stale = attestation(k.privateKey, ctx, Date.now() - 60 * 60 * 1000);
  assert.equal(verifyApprovalAttestation(stale, ctx, k.spki, true).ok, false);
});

test("verifyApprovalAttestation: rejects the old fabricated attest_sig shape and garbage", () => {
  const k = p256();
  const fake = { method: "fingerprint", timestamp: new Date().toISOString(), signature: "attest_sig_prop_1_123" };
  assert.equal(verifyApprovalAttestation(fake, ctx, k.spki, true).ok, false);
  assert.equal(verifyApprovalAttestation("not json", ctx, k.spki, true).ok, false);
  assert.equal(verifyApprovalAttestation(undefined, ctx, k.spki, true).ok, false);
  assert.equal(verifyApprovalAttestation({ v: 1, method: "biometric", ts: Date.now(), sig: "AAAA" }, ctx, k.spki, true).ok, false);
  // a newline in a field cannot be used to smuggle extra signed fields
  assert.equal(
    verifyApprovalAttestation(attestation(k.privateKey), { ...ctx, nonce: "nonce_1\nextra" }, k.spki, true).ok,
    false,
  );
});

test("ChallengeStore: single use and expiring", () => {
  const store = new ChallengeStore();
  const c = store.issue("dev_a", 1000);
  assert.equal(store.consume("dev_a", "wrong", 1001), false);
  assert.equal(store.consume("dev_a", c, 1002), false, "a failed attempt consumes the challenge");
  const c2 = store.issue("dev_a", 1000);
  assert.equal(store.consume("dev_a", c2, 1001), true);
  assert.equal(store.consume("dev_a", c2, 1002), false, "second use fails");
  const c3 = store.issue("dev_a", 1000);
  assert.equal(store.consume("dev_a", c3, 1000 + 3 * 60 * 1000), false, "expired");
});

// ---- end to end over HTTP -------------------------------------------------

function deviceRow(id: string) {
  return {
    device_id: id,
    name: id,
    platform: "android" as const,
    pubkey_spki: new Uint8Array([0]),
    key_attested: 0,
    scopes: ["telemetry:write", "approval:write"],
    enrolled_at: Date.now(),
    revoked_at: null,
  };
}

test("approval key registration + /network/approve enforce the device-bound signature", async () => {
  const prevShadow = process.env.SHADOW;
  process.env.SHADOW = "0";
  process.env.EXOCORTEX_ALLOW_UNATTESTED_KEYS = "1"; // chain verification has its own tests (key-attestation.test.ts)
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice(deviceRow("dev_phone"));
  setDatabase(db);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const jwt = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken("dev_phone", TEST_SECRET)}` };
  const approve = (att: unknown, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/network/approve`, {
      method: "POST",
      headers: jwt,
      body: JSON.stringify({ proposal_id: "prop_1", nonce: "nonce_1", biometricAttestation: att, ...extra }),
    });

  try {
    const k = p256();

    // 1. no key registered yet -> 428, regardless of what the caller sends
    assert.equal((await approve(attestation(k.privateKey, { ...ctx, deviceId: "dev_phone" }))).status, 428);

    // 2. registration needs the enrollment token
    const ch1 = (await (await fetch(`${base}/v3/devices/approval-key/challenge`, { method: "POST", headers: jwt })).json()).challenge;
    const reg = (token: string | undefined, body: Record<string, unknown>) =>
      fetch(`${base}/v3/devices/approval-key`, {
        method: "POST",
        headers: { ...jwt, ...(token ? { "X-Enroll-Token": token } : {}) },
        body: JSON.stringify(body),
      });
    const goodBody = (challenge: string) => ({
      pubkey_b64: Buffer.from(k.spki).toString("base64"),
      challenge,
      signature_b64: sign(k.privateKey, approvalKeyMessage("dev_phone", challenge)),
    });
    assert.equal((await reg(undefined, goodBody(ch1))).status, 401);
    assert.equal((await reg("wrong-token", goodBody(ch1))).status, 401);

    // 3. proof of possession: signature by a different key is refused
    const ch2 = (await (await fetch(`${base}/v3/devices/approval-key/challenge`, { method: "POST", headers: jwt })).json()).challenge;
    const attacker = p256();
    const forged = { ...goodBody(ch2), signature_b64: sign(attacker.privateKey, approvalKeyMessage("dev_phone", ch2)) };
    assert.equal((await reg(ENROLL, forged)).status, 400);

    // 4. valid registration (fresh challenge; the failed attempt consumed ch2)
    const ch3 = (await (await fetch(`${base}/v3/devices/approval-key/challenge`, { method: "POST", headers: jwt })).json()).challenge;
    assert.equal((await reg(ENROLL, goodBody(ch3))).status, 200);
    assert.equal(db.getDevice("dev_phone")?.key_attested, 0, "the dev escape hatch must not claim hardware attestation");
    // Chain parsing has separate coverage. For the approval-route signature checks, represent
    // the state after a trusted chain has verified this same key.
    assert.equal(db.setDeviceApprovalKey("dev_phone", k.spki, true), true);

    // 5. approvals: fabricated / missing / wrong-key signatures are refused before anything is forwarded
    const fake = { method: "fingerprint", timestamp: new Date().toISOString(), signature: "attest_sig_prop_1_1" };
    assert.equal((await approve(fake)).status, 422);
    assert.equal((await approve(undefined)).status, 422);
    assert.equal((await approve(attestation(attacker.privateKey, { ...ctx, deviceId: "dev_phone" }))).status, 422);
    const good = attestation(k.privateKey, { ...ctx, deviceId: "dev_phone" });
    assert.equal((await approve(good, { nonce: "other_nonce" })).status, 422, "signature is bound to the nonce");

    // 6. a valid signature passes verification; the triad is not running here so the forward itself is unreachable
    const ok = await approve(good);
    assert.notEqual(ok.status, 422);
    assert.notEqual(ok.status, 428);
  } finally {
    delete process.env.EXOCORTEX_ALLOW_UNATTESTED_KEYS;
    if (prevShadow === undefined) delete process.env.SHADOW;
    else process.env.SHADOW = prevShadow;
    await new Promise<void>((r) => server.close(() => r()));
    setDatabase(null);
  }
});
