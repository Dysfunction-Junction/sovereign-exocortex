import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, generateKeyPairSync as rsa, randomBytes, type KeyObject } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { approvalMessage, labelMessage, verifyLabelAttestation } from "./approval-attestation.js";
import { PushNotifier } from "./push-notifier.js";

const SECRET = "followup-jwt-secret";
const ENROLL = "followup-enroll-token";
process.env.GATEWAY_JWT_SECRET = SECRET;
process.env.GATEWAY_ENROLL_TOKEN = ENROLL;
process.env.NODE_ENV = "test";
const { server, setPendingFetcherForTest } = await import("./server.js");

type KP = { publicKey: KeyObject; privateKey: KeyObject };
const p256 = (): KP => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = (k: KP) => new Uint8Array(k.publicKey.export({ type: "spki", format: "der" }));
const sign = (k: KP, m: Buffer) => {
  const s = createSign("sha256");
  s.update(m);
  return s.sign(k.privateKey).toString("base64");
};

function device(db: ExocortexDatabase, id: string, key: KP, scopes: string[], attested = 1) {
  db.registerDevice({
    device_id: id, name: id, platform: "android", pubkey_spki: spki(key),
    key_attested: attested, scopes, enrolled_at: Date.now(), revoked_at: null,
  });
}
function proposal(db: ExocortexDatabase, id: string, state: "SURFACED" | "STAGED" | "SUPPRESSED" = "SURFACED", expiresIn = 3_600_000) {
  const ev = db.ingestEvent("dev_a", { event_id: `evt_${id}`, kind: "observation", ts_device: Date.now(), schema_ver: 1, payload: {} });
  db.insertProposal({
    proposal_id: id, created_seq: ev.event.seq, invariant_id: null, policy_type: "PRAGMATIC", tier: 1,
    summary: `summary ${id}`, action: "{}", action_hash: new Uint8Array([1]), efe: 1, risk_term: 0.1, ambiguity_term: 0,
    state, shadow: 1, expires_at: Date.now() + expiresIn, updated_at: Date.now(),
  });
}

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  try {
    return await fn(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    setDatabase(null);
  }
}
const bearer = (id: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${issueToken(id, SECRET)}` });

// ---- P3 scopes -------------------------------------------------------------

test("P3: enroll validates scopes against a per-platform allowlist", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(db);
  await withServer(async (base) => {
    const enroll = (id: string, platform: string, scopes?: unknown) =>
      fetch(`${base}/v3/devices/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ENROLL}` },
        body: JSON.stringify({
          device_id: id, name: id, platform, pubkey_b64: Buffer.from(spki(p256())).toString("base64"),
          ...(scopes !== undefined ? { scopes } : {}),
        }),
      });
    let r = await enroll("a1", "android", ["telemetry:write", "admin", "admin:read"]);
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.deepEqual(body.offending_scopes, ["admin", "admin:read"]);
    assert.match(body.error, /admin/);
    assert.equal(db.getDevice("a1"), null);
    assert.equal((await enroll("a2", "android", ["admin"])).status, 400);
    assert.equal((await enroll("a3", "android", [42])).status, 400);
    assert.equal((await enroll("w0", "windows", ["admin"])).status, 400, "admin is never grantable via enroll");
    assert.equal((await enroll("a4", "android", ["telemetry:write", "approval:write"])).status, 200);
    assert.deepEqual(db.getDevice("a4")?.scopes, ["telemetry:write", "approval:write"]);
    assert.equal((await enroll("w1", "windows", ["telemetry:write", "admin:read"])).status, 200);
    assert.equal((await enroll("a5", "android")).status, 200);
    assert.deepEqual(db.getDevice("a5")?.scopes, ["telemetry:write"], "default scopes");
    // grant-scope path (PC only) can add admin
    assert.equal(db.grantDeviceScope("a5", "admin"), true);
    assert.ok(db.getDevice("a5")?.scopes.includes("admin"));
    assert.equal(db.grantDeviceScope("nope", "admin"), false);
  });
});

// ---- P1 labels ---------------------------------------------------------------

test("P1: label helpers bind device, proposal, label and ts", () => {
  const k = p256();
  const ctx = { deviceId: "dev_a", proposalId: "p1", label: "wanted", nonce: randomBytes(24).toString("hex") };
  const ts = Date.now();
  const att = { v: 1, method: "biometric", ts, sig: sign(k, labelMessage(ctx, ts)), nonce: ctx.nonce };
  assert.equal(labelMessage(ctx, 5).toString(), `exo-label-v2\ndev_a\np1\nwanted\n${ctx.nonce}\n5`);
  assert.equal(verifyLabelAttestation(att, ctx, spki(k), true).ok, true);
  for (const bad of [{ ...ctx, label: "not_wanted" }, { ...ctx, proposalId: "p2" }, { ...ctx, deviceId: "dev_b" }]) {
    assert.equal(verifyLabelAttestation(att, bad, spki(k), true).ok, false);
  }
  assert.equal(verifyLabelAttestation({ ...att, ts: ts - 3_600_000, sig: sign(k, labelMessage(ctx, ts - 3_600_000)) }, ctx, spki(k), true).ok, false);
  // an approval signature must not be accepted as a label signature
  const approvalSig = sign(k, approvalMessage({ ...ctx, nonce: "n", action: "approve" }, ts));
  assert.equal(verifyLabelAttestation({ ...att, sig: approvalSig }, ctx, spki(k), true).ok, false);
});

test("P1: tap source requires a valid signed attestation (labels endpoint and /v3/events)", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const k = p256();
  device(db, "dev_a", k, ["telemetry:write", "approval:write"]);
  setDatabase(db);
  proposal(db, "pl1");
  proposal(db, "pl2");
  proposal(db, "pl3");
  proposal(db, "pl4");
  await withServer(async (base) => {
    const post = (b: Record<string, unknown>) =>
      fetch(`${base}/v3/shadow/labels`, { method: "POST", headers: bearer("dev_a"), body: JSON.stringify(b) });
    const att = (pid: string, label: string, key = k, dev = "dev_a") => {
      const ts = Date.now();
      const nonce = randomBytes(24).toString("hex");
      return { v: 1, method: "biometric", ts, nonce, sig: sign(key, labelMessage({ deviceId: dev, proposalId: pid, label, nonce }, ts)) };
    };
    // no attestation, claims tap -> inferred
    let r = await (await post({ proposal_id: "pl1", label: "wanted", source: "tap" })).json();
    assert.equal(r.source, "inferred");
    // attestation signed by another key -> inferred
    r = await (await post({ proposal_id: "pl2", label: "wanted", source: "tap", attestation: att("pl2", "wanted", p256()) })).json();
    assert.equal(r.source, "inferred");
    // attestation for a different label -> inferred
    r = await (await post({ proposal_id: "pl2", label: "wanted", attestation: att("pl2", "not_wanted") })).json();
    assert.equal(r.source, "inferred");
    // valid -> tap
    r = await (await post({ proposal_id: "pl3", label: "wanted", attestation: att("pl3", "wanted") })).json();
    assert.equal(r.source, "tap");
    assert.equal(JSON.parse(db.getShadowLabels("pl3")[0]!.actual!).source, "tap");
    // a later inferred label does not overwrite the tap label
    await post({ proposal_id: "pl3", label: "ignored", source: "inferred" });
    assert.equal(db.getShadowLabels("pl3")[0]!.label, "wanted");

    // /v3/events kind "label"
    const ev = (id: string, payload: Record<string, unknown>) =>
      fetch(`${base}/v3/events`, {
        method: "POST", headers: bearer("dev_a"),
        body: JSON.stringify({ device_id: "dev_a", events: [{ event_id: id, kind: "label", ts_device: Date.now(), schema_ver: 1, payload }] }),
      });
    assert.equal((await ev("lbl1", { proposal_id: "pl4", label: "wanted", source: "tap" })).status, 200);
    assert.equal(JSON.parse(db.getShadowLabels("pl4")[0]!.actual!).source, "inferred", "unsigned event label is inferred");
    // forged attestation naming another device in the body is irrelevant: the JWT device is used
    assert.equal((await ev("lbl2", { proposal_id: "pl4", label: "wanted", source: "tap", attestation: att("pl4", "wanted") })).status, 200);
    assert.equal(JSON.parse(db.getShadowLabels("pl4")[0]!.actual!).source, "tap");
  });
});

test("P1: verified approve whose triad forward is ok records the tap 'wanted' label itself", async () => {
  const prevShadow = process.env.SHADOW;
  process.env.SHADOW = "0";
  const db = new ExocortexDatabase({ path: ":memory:" });
  const k = p256();
  device(db, "dev_a", k, ["telemetry:write", "approval:write"]);
  setDatabase(db);
  proposal(db, "pa1");
  proposal(db, "pa2");
  let triadOk = true;
  const triad = createServer((rq, rs) => {
    rq.resume();
    rs.writeHead(triadOk ? 200 : 409, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ ok: triadOk }));
  });
  await new Promise<void>((r) => triad.listen(0, "127.0.0.1", () => r()));
  process.env.TRIAD_UPSTREAM = `http://127.0.0.1:${(triad.address() as { port: number }).port}`;
  try {
    await withServer(async (base) => {
      const approve = (pid: string, withAtt: boolean) => {
        const ts = Date.now();
        const sig = sign(k, approvalMessage({ deviceId: "dev_a", proposalId: pid, nonce: "n1", action: "approve" }, ts));
        return fetch(`${base}/network/approve`, {
          method: "POST", headers: bearer("dev_a"),
          body: JSON.stringify({ proposal_id: pid, nonce: "n1", ...(withAtt ? { biometricAttestation: { v: 1, method: "biometric", ts, sig } } : {}) }),
        });
      };
      assert.equal((await approve("pa1", true)).status, 200);
      const l = db.getShadowLabels("pa1");
      assert.equal(l.length, 1);
      assert.equal(l[0]!.label, "wanted");
      assert.equal(JSON.parse(l[0]!.actual!).source, "tap");
      // rejected by the attestation check: no label
      assert.equal((await approve("pa2", false)).status, 422);
      assert.equal(db.getShadowLabels("pa2").length, 0);
      // triad refuses: no label
      triadOk = false;
      assert.equal((await approve("pa2", true)).status, 409);
      assert.equal(db.getShadowLabels("pa2").length, 0);
    });
  } finally {
    delete process.env.TRIAD_UPSTREAM;
    if (prevShadow === undefined) delete process.env.SHADOW;
    else process.env.SHADOW = prevShadow;
    await new Promise<void>((r) => triad.close(() => r()));
  }
});

// ---- P6 delivery ---------------------------------------------------------------

test("P6a: GET /v3/proposals/pending returns only live, nonce-bearing SURFACED/STAGED proposals", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256(), ["telemetry:write", "approval:write"]);
  device(db, "dev_nope", p256(), ["telemetry:write"]);
  setDatabase(db);
  proposal(db, "pp1");
  proposal(db, "pp2", "STAGED");
  proposal(db, "pp3", "SUPPRESSED");
  proposal(db, "pp4", "SURFACED", -1000); // expired
  proposal(db, "pp5"); // no nonce at the registry
  const exp = Date.now() + 60_000;
  setPendingFetcherForTest(async () => [
    { proposalId: "pp1", candidateId: "c1", summary: "Do it", riskLevel: "high", approvalNonce: "nonce1", expiresAt: new Date(exp).toISOString(), actionPayload: { x: 1 } },
    { proposalId: "pp2", approvalNonce: "nonce2", expiresAt: exp },
    { proposalId: "pp3", approvalNonce: "nonce3", expiresAt: exp },
    { proposalId: "pp4", approvalNonce: "nonce4", expiresAt: exp },
    { proposalId: "pp6_unknown", approvalNonce: "nonce6", expiresAt: exp },
    { proposalId: "pp1x", approvalNonce: "", expiresAt: exp },
  ]);
  try {
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/v3/proposals/pending`)).status, 401);
      assert.equal((await fetch(`${base}/v3/proposals/pending`, { headers: bearer("dev_nope") })).status, 403);
      const r = await fetch(`${base}/v3/proposals/pending`, { headers: bearer("dev_a") });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.proposals.map((p: { proposalId: string }) => p.proposalId).sort(), ["pp1", "pp2"]);
      const p1 = body.proposals.find((p: { proposalId: string }) => p.proposalId === "pp1");
      assert.deepEqual(Object.keys(p1).sort(), ["actionPayload", "approvalNonce", "candidateId", "expiresAt", "proposalId", "requiresBiometric", "riskLevel", "summary"]);
      assert.equal(p1.approvalNonce, "nonce1");
      assert.equal(p1.riskLevel, "high");
      assert.equal(p1.requiresBiometric, true);
      assert.equal(p1.expiresAt, exp);
      const p2 = body.proposals.find((p: { proposalId: string }) => p.proposalId === "pp2");
      assert.equal(p2.riskLevel, "low", "derived from risk_term");
      assert.equal("actionPayload" in p2, false);
    });
  } finally {
    setPendingFetcherForTest(null);
  }
});

test("P6b: POST /v3/devices/push-token stores latest token; revoked devices refused", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256(), ["telemetry:write"]);
  device(db, "dev_r", p256(), ["telemetry:write"]);
  setDatabase(db);
  await withServer(async (base) => {
    const reg = (id: string, b: Record<string, unknown>) =>
      fetch(`${base}/v3/devices/push-token`, { method: "POST", headers: bearer(id), body: JSON.stringify(b) });
    assert.equal((await reg("dev_a", { token: "t1", platform: "fcm" })).status, 200);
    assert.equal((await reg("dev_a", { token: "t2", platform: "fcm" })).status, 200);
    assert.deepEqual(db.listActivePushTokens().map((t) => t.token), ["t2"]);
    assert.equal((await reg("dev_a", { token: "", platform: "fcm" })).status, 400);
    assert.equal((await reg("dev_a", { token: "x".repeat(4097), platform: "fcm" })).status, 400);
    assert.equal((await reg("dev_a", { token: "t", platform: "apns" })).status, 400);
    const unauth = await fetch(`${base}/v3/devices/push-token`, { method: "POST", body: "{}" });
    assert.equal(unauth.status, 401);
    // a device revoked after registering stops receiving; a revoked device cannot register
    db.revokeDevice("dev_r");
    assert.equal(db.setDevicePushToken("dev_r", "tr", "fcm"), false);
    db.setDevicePushToken("dev_a", "t3", "fcm");
    db.revokeDevice("dev_a");
    assert.deepEqual(db.listActivePushTokens(), []);
  });
});

test("P6c: PushNotifier is a no-op without config, sends data-only FCM v1 push, polls for new SURFACED rows", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256(), ["telemetry:write"]);
  db.setDevicePushToken("dev_a", "fcm-token-1", "fcm");
  proposal(db, "pn_old");
  const logs: string[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  // unconfigured: clean no-op, logs once, no network
  const off = new PushNotifier({ getDb: () => db, env: {}, fetchImpl, log: (m) => logs.push(m) });
  assert.equal((await off.notifyProposalSurfaced("a")).sent, 0);
  await off.notifyProposalSurfaced("b");
  assert.equal(calls.length, 0);
  assert.equal(logs.filter((l) => /not configured/.test(l)).length, 1);

  // configured
  const { privateKey } = rsa("rsa", { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: "svc@x.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const n = new PushNotifier({
    getDb: () => db, env: { FCM_PROJECT_ID: "proj-1", GOOGLE_APPLICATION_CREDENTIALS: "/sa.json" },
    fetchImpl, readFile: () => sa, log: (m) => logs.push(m),
  });
  n.start(60_000); // catches up surfaced proposals that may have appeared while the daemon was offline
  assert.equal(await n.pollOnce(), 1);
  proposal(db, "pn_new");
  assert.equal(await n.pollOnce(), 1);
  assert.equal(await n.pollOnce(), 0, "not re-sent");
  n.stop();
  const before = calls.length;
  assert.equal((await n.notifyProposalSurfaced("pn_new")).sent, 0, "direct re-notify is deduped");
  assert.equal(calls.length, before);
  const oauth = calls.find((c) => c.url.includes("oauth2"))!;
  assert.match(String(oauth.init.body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  const jwtParts = new URLSearchParams(String(oauth.init.body)).get("assertion")!.split(".");
  assert.equal(jwtParts.length, 3);
  assert.equal(JSON.parse(Buffer.from(jwtParts[1]!, "base64url").toString()).scope, "https://www.googleapis.com/auth/firebase.messaging");
  const send = calls.find((c) => c.url.includes("fcm.googleapis.com"))!;
  assert.equal(send.url, "https://fcm.googleapis.com/v1/projects/proj-1/messages:send");
  assert.equal((send.init.headers as Record<string, string>).Authorization, "Bearer ya29.x");
  const msg = JSON.parse(String(send.init.body)).message;
  assert.equal(msg.token, "fcm-token-1");
  assert.deepEqual(msg.data, { type: "proposal", proposal_id: "pn_new" });
  assert.equal(JSON.stringify(msg).includes("summary"), false, "no summary or nonce in the payload");
  assert.deepEqual(msg.notification, { title: "Approval requested", body: "Open Exocortex to review." }, "visible banner with generic text");
});
