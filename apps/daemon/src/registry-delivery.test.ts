import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { approvalMessage } from "./approval-attestation.js";
import {
  ActiveInferenceEngine, LearnedActiveInferenceEngine, LivingLifeGraph, rankInferencePolicies,
} from "@exocortex/world-model";
import { ShadowRecorder } from "./shadow-recorder.js";
import { surfaceTestProposal } from "./dev-tools.js";
import {
  buildPendingProposals,
  type PendingFetcher,
  type RegistryPending,
  type SpeculateRequest,
  type Speculator,
  type PendingProposal,
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
  opts: { state?: "SURFACED" | "STAGED" | "SUPPRESSED" | "GATED"; expiresIn?: number; risk?: number; action?: string; invariant?: string | null; shadow?: 0 | 1; ranking?: unknown } = {},
) {
  const ev = db.ingestEvent("dev_a", {
    event_id: `evt_${id}`, kind: opts.ranking ? "proposal" : "observation", ts_device: Date.now(), schema_ver: 1,
    payload: opts.ranking ? { proposal_id: id, invariant_id: opts.invariant ?? null, policy_type: "PRAGMATIC", ranking: opts.ranking } : {},
  });
  db.insertProposal({
    proposal_id: id, created_seq: ev.event.seq, invariant_id: opts.invariant ?? null, policy_type: "PRAGMATIC", tier: 1,
    summary: `summary ${id}`, action: opts.action ?? "{}", action_hash: new Uint8Array([1]), efe: 1,
    risk_term: opts.risk ?? 0.1, ambiguity_term: 0,
    state: opts.state ?? "SURFACED", shadow: opts.shadow ?? 1, expires_at: Date.now() + (opts.expiresIn ?? 3_600_000), updated_at: Date.now(),
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

function recordedLearnedBatch(db: ExocortexDatabase, prefix: string, invalidPositions = false) {
  const graph = new LivingLifeGraph();
  graph.addEntity({ id: "project_sovereign_exocortex", name: "Project", type: "PROJECT" });
  const active = new ActiveInferenceEngine(graph);
  const candidates = active.generatePolicies([active.evaluateObservation({
    invariantId: "inv_clean_test_suite", observedState: false, observedAt: Date.now(), confidence: 1,
  })]).map((policy) => ({ ...policy, id: `${prefix}:${policy.id}` }));
  const policies = rankInferencePolicies(
    candidates, new LearnedActiveInferenceEngine(), graph,
    new Map([["inv_clean_test_suite:EPISTEMIC", { wanted: 4, notWanted: 0 }]]), Date.now(), Date.now(),
  );
  const recorder = new ShadowRecorder(db, { cooldownMs: 0 });
  // Persist opposite to rank order to exercise ordering before speculation as well as after fetching.
  for (const policy of [...policies].reverse()) {
    if (invalidPositions) policy.ranking!.position = 0;
    const envelope = active.policyToProposal(policy);
    recorder.record(policy, envelope, {
      action: "ALLOW_PROMPT", mode: "HIGH_VELOCITY_EXECUTION", reason: "test",
      targetDelivery: "GLASS_MODAL", confidence: envelope.confidence, evaluatedAt: Date.now(),
    });
  }
  return policies;
}

test("pending endpoint preserves learned batch rank despite reversed registry order without changing approval material", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256());
  proposal(db, "legacy_before");
  const ranked = recordedLearnedBatch(db, "ranked-delivery");
  assert.equal(ranked[0].type, "EPISTEMIC");
  proposal(db, "legacy_after");
  const registry = fakeRegistry();
  const registryOrder = ["legacy_after", ...ranked.map((p) => p.id).reverse(), "legacy_before"];
  setDatabase(db);
  setPendingFetcherForTest(async () => registryOrder.map((id) => registry.live.get(id)!).filter(Boolean));
  setPendingSpeculatorForTest(registry.speculator);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/v3/proposals/pending`;
  try {
    const before = ranked.map((p) => db.getProposal(p.id));
    const poll = async () => {
      const response = await fetch(url, { headers: { Authorization: "Bearer " + issueToken("dev_a", SECRET) } });
      assert.equal(response.status, 200);
      return (await response.json()) as { proposals: PendingProposal[] };
    };
    const first = (await poll()).proposals;
    assert.deepEqual(first.map((p) => p.proposalId), ["legacy_after", ...ranked.map((p) => p.id), "legacy_before"]);
    const second = (await poll()).proposals;
    assert.deepEqual(second.map((p) => p.proposalId), first.map((p) => p.proposalId));
    for (const delivered of first) {
      const original = registry.live.get(delivered.proposalId)!;
      assert.equal(delivered.approvalNonce, original.approvalNonce);
      assert.equal(delivered.riskLevel, original.riskLevel);
      assert.deepEqual(delivered.actionPayload, original.actionPayload);
      assert.equal(delivered.requiresBiometric, true);
      assert.equal(second.find((p) => p.proposalId === delivered.proposalId)!.approvalNonce, delivered.approvalNonce);
    }
    assert.deepEqual(ranked.map((p) => db.getProposal(p.id)), before);
    const calls = registry.calls.map((call) => call.proposalId);
    assert.ok(calls.indexOf(ranked[0].id) < calls.indexOf(ranked[1].id));
  } finally {
    setPendingFetcherForTest(null);
    setPendingSpeculatorForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDatabase(null);
  }
});

test("batch ranking applies before the speculation cap", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    device(db, "dev_a", p256());
    for (let i = 0; i < 19; i++) proposal(db, `older_${i}`);
    const ranked = recordedLearnedBatch(db, "cap");
    const registry = fakeRegistry();
    await buildPendingProposals(db, registry.fetcher, Date.now(), registry.speculator);
    assert.equal(registry.calls.length, 20);
    assert.equal(registry.calls[19].proposalId, ranked[0].id);
    assert.equal(registry.live.has(ranked[1].id), false);
  } finally {
    db.close();
  }
});

test("invalid host batch positions and client-supplied ranking retain original pending order", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    device(db, "dev_a", p256());
    const ranked = recordedLearnedBatch(db, "duplicate-position", true);
    proposal(db, "client_first", { ranking: { version: 1, batchId: "client_first", position: 0 } });
    proposal(db, "client_second", { ranking: { version: 1, batchId: "client_first", position: 1 } });
    const ids = ["client_second", ranked[1].id, "client_first", ranked[0].id];
    const delivered = await buildPendingProposals(db, async () => ids.map((proposalId) => ({
      proposalId, approvalNonce: `nonce:${proposalId}`, expiresAt: Date.now() + 60_000,
    })));
    assert.deepEqual(delivered.map((p) => p.proposalId), ids);
  } finally {
    db.close();
  }
});

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
  proposal(db, "pol_ok", { shadow: 0 });
  proposal(db, "pol_no", { shadow: 0 });
  proposal(db, "pol_refused", { shadow: 0 });
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

test("a shadow proposal cannot be approved after live actuation is enabled", async () => {
  const prevShadow = process.env.SHADOW;
  process.env.SHADOW = "0";
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256());
  proposal(db, "pol_shadow");
  setDatabase(db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const res = await fetch(`${base}/network/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + issueToken("dev_a", SECRET),
      },
      body: JSON.stringify({ proposal_id: "pol_shadow", action: "approve", nonce: "unused" }),
    });
    assert.equal(res.status, 423, await res.clone().text());
    const body = await res.json();
    assert.match(body.error, /shadow proposal cannot be approved/);
    assert.equal(body.code, "SHADOW_PROPOSAL_LABEL_ONLY");
    assert.equal(body.label_endpoint, "/v3/shadow/labels");
    assert.equal(db.getProposal("pol_shadow")?.state, "SURFACED");
  } finally {
    if (prevShadow === undefined) delete process.env.SHADOW;
    else process.env.SHADOW = prevShadow;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDatabase(null);
  }
});

test("GET /v3/proposals/pending?include_shadow=1 marks shadow: true and requiresBiometric: false", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  device(db, "dev_a", p256());
  proposal(db, "pol_live", { shadow: 0 });
  proposal(db, "pol_shadow", { shadow: 1 });
  setDatabase(db);
  const reg = fakeRegistry();
  setPendingFetcherForTest(reg.fetcher);
  setPendingSpeculatorForTest(reg.speculator);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const res = await fetch(`${base}/v3/proposals/pending?include_shadow=1`, {
      headers: { Authorization: "Bearer " + issueToken("dev_a", SECRET) },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const live = body.proposals.find((p: any) => p.proposalId === "pol_live");
    const shadow = body.proposals.find((p: any) => p.proposalId === "pol_shadow");
    assert.ok(live, "live proposal should be listed");
    assert.ok(shadow, "shadow proposal should be listed");
    assert.equal(live.requiresBiometric, true);
    assert.equal(live.shadow, undefined);
    assert.equal(shadow.requiresBiometric, false);
    assert.equal(shadow.shadow, true);
  } finally {
    setPendingFetcherForTest(null);
    setPendingSpeculatorForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDatabase(null);
  }
});

test("surfaceTestProposal respects process.env.SHADOW === '0' and creates shadow: 0 proposal", () => {
  const prevShadow = process.env.SHADOW;
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    delete process.env.SHADOW;
    const shadowId = surfaceTestProposal(db);
    assert.equal(db.getProposal(shadowId)?.shadow, 1, "defaults to shadow: 1 when SHADOW is not '0'");

    process.env.SHADOW = "0";
    const liveId = surfaceTestProposal(db);
    assert.equal(db.getProposal(liveId)?.shadow, 0, "creates shadow: 0 when SHADOW is '0'");

    const forcedShadow = surfaceTestProposal(db, Date.now(), 60000, { shadow: true });
    assert.equal(db.getProposal(forcedShadow)?.shadow, 1, "honors explicit shadow: true override");
  } finally {
    if (prevShadow === undefined) delete process.env.SHADOW;
    else process.env.SHADOW = prevShadow;
  }
});

