import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { approvalMessage } from "./approval-attestation.js";
import {
  buildPendingProposals,
  type PendingFetcher,
  type RegistryPending,
  type SpeculateRequest,
  type Speculator,
} from "./pending-proposals.js";

const SECRET = "registry-delivery-jwt-secret";
process.env.GATEWAY_JWT_SECRET = SECRET;
process.env.GATEWAY_ENROLL_TOKEN = "registry-delivery-enroll";
process.env.NODE_ENV = "test";
const { server, setPendingFetcherForTest, setPendingSpeculatorForTest } = await import("./server.js");

type KP = { publicKey: KeyObject; privateKey: KeyObject };
const p256 = (): KP => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = (k: KP) => new Uint8Array(k.publicKey.export({ type: "spki", format: "der" }));
const sign = (k: KP, m: Buffer) => {
  const s = createSign("sha256");
  s.update(m);
  return s.sign(k.privateKey).toString("base64");
};

function device(db: ExocortexDatabase, id: string, key: KP) {
  db.registerDevice({
    device_id: id, name: id, platform: "android", pubkey_spki: spki(key),
    key_attested: 1, scopes: ["telemetry:write", "approval:write"], enrolled_at: Date.now(), revoked_at: null,
  });
}

function proposal(
  db: ExocortexDatabase,
  id: string,
  opts: { state?: "SURFACED" | "STAGED" | "SUPPRESSED" | "GATED"; expiresIn?: number; risk?: number; action?: string; invariant?: string | null } = {},
) {
  const ev = db.ingestEvent("dev_a", { event_id: `evt_${id}`, kind: "observation", ts_device: Date.now(), schema_ver: 1, payload: {} });
  db.insertProposal({
    proposal_id: id, created_seq: ev.event.seq, invariant_id: opts.invariant ?? null, policy_type: "PRAGMATIC", tier: 1,
    summary: `summary ${id}`, action: opts.action ?? "{}", action_hash: new Uint8Array([1]), efe: 1,
    risk_term: opts.risk ?? 0.1, ambiguity_term: 0,
    state: opts.state ?? "SURFACED", shadow: 1, expires_at: Date.now() + (opts.expiresIn ?? 3_600_000), updated_at: Date.now(),
  });
}

/** In-memory stand-in for registry-app's DryRunCache keyed by caller-supplied ids (idempotent speculate). */
function fakeRegistry() {
  const live = new Map<string, RegistryPending>();
  let n = 0;
  const calls: SpeculateRequest[] = [];
  const speculator: Speculator = async (req) => {
    calls.push(req);
    if (!live.has(req.proposalId)) {
      live.set(req.proposalId, {
        proposalId: req.proposalId,
        candidateId: req.candidateId,
        summary: req.summary,
        riskLevel: req.riskLevel,
        approvalNonce: `nonce-${++n}`,
        expiresAt: Date.now() + req.ttlMs,
        actionPayload: req.actionPayload,
      });
    }
  };
  const fetcher: PendingFetcher = async () => Array.from(live.values());
  return { live, calls, speculator, fetcher };
}

test("pending list speculates our live SURFACED/STAGED proposals, keyed by our id, and nothing else", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256());
  proposal(db, "pol_a", { risk: 0.1, action: JSON.stringify({ command: "probe", n: 1 }) });
  proposal(db, "pol_b", { state: "STAGED", risk: 0.5 });
  proposal(db, "pol_c", { state: "SUPPRESSED" });
  proposal(db, "pol_d", { state: "GATED" });
  proposal(db, "pol_e", { expiresIn: -1000 });
  proposal(db, "pol_f", { risk: 0.9, action: "[1,2]" });
  const reg = fakeRegistry();

  const out = await buildPendingProposals(db, reg.fetcher, Date.now(), reg.speculator);

  assert.deepEqual(reg.calls.map((c) => c.proposalId).sort(), ["pol_a", "pol_b", "pol_f"]);
  const a = reg.calls.find((c) => c.proposalId === "pol_a")!;
  assert.equal(a.candidateId, "PRAGMATIC", "falls back to the policy type when there is no invariant");
  assert.equal(a.riskLevel, "low");
  assert.deepEqual(a.actionPayload, { command: "probe", n: 1 });
  assert.equal(reg.calls.find((c) => c.proposalId === "pol_b")!.riskLevel, "medium");
  const f = reg.calls.find((c) => c.proposalId === "pol_f")!;
  assert.equal(f.riskLevel, "high");
  assert.deepEqual(f.actionPayload, {}, "non-object actions become an empty payload");
  assert.ok(a.ttlMs >= 1000 && a.ttlMs <= 600_000, "ttl is clamped to the registry's range");

  assert.deepEqual(out.map((p) => p.proposalId).sort(), ["pol_a", "pol_b", "pol_f"]);
  assert.ok(out.every((p) => p.approvalNonce.startsWith("nonce-")));
});

test("polling twice keeps the same nonce and never calls the speculator when none is supplied", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256());
  proposal(db, "pol_a");
  const reg = fakeRegistry();
  const first = await buildPendingProposals(db, reg.fetcher, Date.now(), reg.speculator);
  const second = await buildPendingProposals(db, reg.fetcher, Date.now(), reg.speculator);
  assert.equal(first[0]!.approvalNonce, second[0]!.approvalNonce);

  const quiet = fakeRegistry();
  await buildPendingProposals(db, quiet.fetcher, Date.now(), null);
  assert.equal(quiet.calls.length, 0);
});

test("a down registry fails closed: speculator errors never throw and nothing is listed", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256());
  proposal(db, "pol_a");
  const out = await buildPendingProposals(
    db,
    async () => {
      throw new Error("registry down");
    },
    Date.now(),
    async () => {
      throw new Error("registry down");
    },
  );
  assert.deepEqual(out, []);
});

test("at most 20 proposals are speculated per poll", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256());
  for (let i = 0; i < 25; i++) proposal(db, `pol_${String(i).padStart(2, "0")}`);
  const reg = fakeRegistry();
  await buildPendingProposals(db, reg.fetcher, Date.now(), reg.speculator);
  assert.equal(reg.calls.length, 20);
});

test("a confirmed approve/reject advances the DB state, so the proposal leaves the pending list for good", async () => {
  const prevShadow = process.env.SHADOW;
  process.env.SHADOW = "0";
  const db = new ExocortexDatabase({ path: ":memory:" });
  const k = p256();
  device(db, "dev_a", k);
  setDatabase(db);
  proposal(db, "pol_ok");
  proposal(db, "pol_no");
  proposal(db, "pol_refused");
  const reg = fakeRegistry();
  setPendingFetcherForTest(reg.fetcher);
  setPendingSpeculatorForTest(reg.speculator);

  let triadOk = true;
  const triad = createServer((rq, rs) => {
    rq.resume();
    rs.writeHead(triadOk ? 200 : 409, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ ok: triadOk }));
  });
  await new Promise<void>((r) => triad.listen(0, "127.0.0.1", () => r()));
  process.env.TRIAD_UPSTREAM = `http://127.0.0.1:${(triad.address() as { port: number }).port}`;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken("dev_a", SECRET)}` };
  const pendingIds = async () =>
    ((await (await fetch(`${base}/v3/proposals/pending`, { headers })).json()) as { proposals: { proposalId: string }[] })
      .proposals.map((p) => p.proposalId).sort();
  const approve = (pid: string, nonce: string) => {
    const ts = Date.now();
    const sig = sign(k, approvalMessage({ deviceId: "dev_a", proposalId: pid, nonce, action: "approve" }, ts));
    return fetch(`${base}/network/approve`, {
      method: "POST", headers,
      body: JSON.stringify({ proposal_id: pid, nonce, biometricAttestation: { v: 1, method: "biometric", ts, sig } }),
    });
  };

  try {
    assert.deepEqual(await pendingIds(), ["pol_no", "pol_ok", "pol_refused"]);
    const nonceOf = (id: string) => reg.live.get(id)!.approvalNonce;

    // approve confirmed by the triad -> APPROVED, gone from the list
    assert.equal((await approve("pol_ok", nonceOf("pol_ok"))).status, 200);
    assert.equal(db.getProposal("pol_ok")?.state, "APPROVED");

    // the registry consumed the nonce on release; a poll must NOT mint a fresh one for pol_ok
    reg.live.delete("pol_ok");
    assert.deepEqual(await pendingIds(), ["pol_no", "pol_refused"]);

    // reject confirmed by the triad -> REJECTED
    const rej = await fetch(`${base}/network/approve`, {
      method: "POST", headers, body: JSON.stringify({ proposal_id: "pol_no", action: "reject" }),
    });
    assert.equal(rej.status, 200);
    assert.equal(db.getProposal("pol_no")?.state, "REJECTED");

    // the triad refuses -> state untouched, still pending
    triadOk = false;
    assert.equal((await approve("pol_refused", nonceOf("pol_refused"))).status, 409);
    assert.equal(db.getProposal("pol_refused")?.state, "SURFACED");
    assert.deepEqual(await pendingIds(), ["pol_refused"]);
  } finally {
    setPendingFetcherForTest(null);
    setPendingSpeculatorForTest(null);
    delete process.env.TRIAD_UPSTREAM;
    if (prevShadow === undefined) delete process.env.SHADOW;
    else process.env.SHADOW = prevShadow;
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => triad.close(() => r()));
    setDatabase(null);
  }
});
