import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ExocortexDatabase } from "@exocortex/core/db";
import type { InferencePolicy, ProposalEnvelope, GateDecision } from "@exocortex/world-model";
import { computeShadowMetrics, loadShadowRows } from "@exocortex/core/shadow-metrics";
import { defaultWorldModelHost } from "./world-model-host.js";
import { ShadowRecorder, mapGateAction, tierForRisk } from "./shadow-recorder.js";

const NOW = 1_800_000_000_000;

function policy(over: Partial<InferencePolicy> = {}): InferencePolicy {
  return {
    id: "policy_pragmatic_inv_a_1",
    type: "PRAGMATIC",
    title: "Restart bridge",
    description: "d",
    targetEntityId: "device_phone",
    invariantId: "inv_a",
    expectedUtility: 0.8,
    informationGain: 0.1,
    expectedFreeEnergyScore: 1.25,
    estimatedRisk: 0.1,
    urgency: 0.5,
    actionPayload: { cmd: "restart", target: "bridge" },
    ...over,
  };
}

function proposal(p: InferencePolicy, confidence = 0.9): ProposalEnvelope {
  return { id: p.id, candidateId: p.invariantId, summary: p.title, urgency: p.urgency, confidence, estimatedRisk: p.estimatedRisk };
}

function decision(over: Partial<GateDecision> = {}): GateDecision {
  return {
    action: "ALLOW_PROMPT",
    mode: "DEEP_FOCUS",
    reason: "urgent",
    targetDelivery: "GLASS_MODAL",
    confidence: 0.9,
    evaluatedAt: NOW,
    ...over,
  };
}

describe("mapping helpers", () => {
  it("maps every runtime gate action", () => {
    assert.deepEqual(mapGateAction("ALLOW_PROMPT"), { decision: "SURFACE", state: "SURFACED" });
    assert.deepEqual(mapGateAction("SUPPRESS_AND_QUEUE"), { decision: "QUEUE", state: "STAGED" });
    assert.deepEqual(mapGateAction("DROP"), { decision: "SUPPRESS", state: "SUPPRESSED" });
    assert.deepEqual(mapGateAction("SILENT_AUTO_EXECUTE"), { decision: "AUTO_DRY_RUN", state: "GATED" });
  });

  it("derives risk tiers", () => {
    assert.equal(tierForRisk(0), 0);
    assert.equal(tierForRisk(0.05), 0);
    assert.equal(tierForRisk(0.15), 1);
    assert.equal(tierForRisk(0.5), 2);
    assert.equal(tierForRisk(0.85), 3);
    assert.equal(tierForRisk(0.86), 4);
  });
});

describe("ShadowRecorder", () => {
  let db: ExocortexDatabase;
  let rec: ShadowRecorder;
  let dir: string;
  let dbPath: string;

  // listGateDecisions does not exist on the driver; read rows through a second handle.
  function gateRows(proposalId: string): Array<{ decision: string; mode: string; ts: number }> {
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return raw
        .prepare("SELECT decision, mode, ts FROM gate_decisions WHERE proposal_id = ?")
        .all(proposalId) as unknown as Array<{ decision: string; mode: string; ts: number }>;
    } finally {
      raw.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shadow-rec-"));
    dbPath = join(dir, "t.db");
    db = new ExocortexDatabase({ path: dbPath });
    // proposals.invariant_id is a foreign key into invariants; policy()'s placeholder
    // "inv_a" is a test fixture, not one of the engine's real DEFAULT_INVARIANTS, so it
    // needs to be seeded here for record() to be able to persist a proposal against it.
    db.registerInvariant({ invariant_id: "inv_a", name: "test invariant", category: "TEST", enabled: 1 });
    rec = new ShadowRecorder(db, { nowMs: () => NOW });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers the host device once and appends a hash-chained proposal event", () => {
    const p = policy();
    rec.record(p, proposal(p), decision());
    const second = policy({ id: "policy_pragmatic_inv_a_2", actionPayload: { cmd: "other" } });
    rec.record(second, proposal(second), decision());
    assert.equal(db.listDevices().filter((d) => d.device_id === "host:exocortexd").length, 1);
    const events = db.listEvents({ kind: "proposal" });
    assert.equal(events.length, 2);
    assert.equal(db.verifyEventChain().valid, true);
  });

  it("writes proposal + gate decision rows with the mapped vocabulary", () => {
    const p = policy();
    const out = rec.record(p, proposal(p, 0.9), decision());
    assert.ok(out);
    const row = db.getProposal(p.id)!;
    assert.equal(row.state, "SURFACED");
    assert.equal(row.shadow, 1);
    assert.equal(row.tier, 1);
    assert.equal(row.policy_type, "PRAGMATIC");
    assert.equal(row.efe, 1.25);
    assert.equal(row.risk_term, 0.1);
    assert.ok(Math.abs(row.ambiguity_term - 0.1) < 1e-9);
    assert.equal(row.expires_at, NOW + 24 * 3600 * 1000);
    assert.equal(row.action, JSON.stringify({ cmd: "restart", target: "bridge" }));
    assert.equal(row.action_hash.length, 32);
    assert.ok(row.created_seq >= 1);
    const g = gateRows(p.id);
    assert.equal(g.length, 1);
    assert.equal(g[0].decision, "SURFACE");
    assert.equal(g[0].mode, "DEEP_FOCUS");
    assert.equal(g[0].ts, NOW);
  });

  it("is idempotent for a repeated proposal id", () => {
    const p = policy();
    assert.ok(rec.record(p, proposal(p), decision()));
    assert.equal(rec.record(p, proposal(p), decision()), null);
    assert.equal(gateRows(p.id).length, 1);
  });

  it("records shadow=0 when constructed for live mode", () => {
    const live = new ShadowRecorder(db, { nowMs: () => NOW, shadow: false });
    const p = policy({ id: "policy_live" });
    live.record(p, proposal(p), decision());
    assert.equal(db.getProposal("policy_live")!.shadow, 0);
  });

  it("is atomic: a failure after the event append rolls back and leaves the chain valid", () => {
    const bad = policy({ id: "policy_bad" });
    (bad as { title: unknown }).title = null; // NOT NULL violation on proposals.summary, after ingestEvent
    assert.throws(() => rec.record(bad, proposal(bad), decision()));
    assert.equal(db.getProposal("policy_bad"), null);
    assert.equal(db.listEvents({ kind: "proposal" }).length, 0);
    assert.equal(gateRows("policy_bad").length, 0);

    const good = policy({ id: "policy_good", actionPayload: { cmd: "other" } });
    assert.ok(rec.record(good, proposal(good), decision()));
    const verify = db.verifyEventChain();
    assert.equal(verify.valid, true);
    const seqs = db.listEvents({}).map((e) => e.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => seqs[0] + i), "seqs are contiguous");
  });

  it("rejects non-finite inputs before writing anything", () => {
    for (const bad of [
      policy({ id: "nan_risk", estimatedRisk: Number.NaN }),
      policy({ id: "inf_efe", expectedFreeEnergyScore: Number.POSITIVE_INFINITY }),
    ]) {
      assert.throws(() => rec.record(bad, proposal(bad), decision()), /finite number/);
      assert.equal(db.getProposal(bad.id), null);
    }
    const p = policy({ id: "nan_conf" });
    assert.throws(() => rec.record(p, proposal(p, Number.NaN), decision()), /finite number/);
    assert.equal(db.listEvents({ kind: "proposal" }).length, 0);
  });

  it("skips a repeat of the same invariant + action inside the cooldown, records after it", () => {
    let t = NOW;
    const cd = new ShadowRecorder(db, { nowMs: () => t, cooldownMs: 1000 });
    const first = policy({ id: "policy_cd_1" });
    assert.ok(cd.record(first, proposal(first), decision()));
    const again = policy({ id: "policy_cd_2" }); // same invariant + action, new id
    assert.equal(cd.record(again, proposal(again), decision()), null);
    assert.equal(db.getProposal("policy_cd_2"), null);
    t += 1001;
    assert.ok(cd.record(again, proposal(again), decision()));
    const other = policy({ id: "policy_cd_3", actionPayload: { cmd: "different" } });
    assert.ok(cd.record(other, proposal(other), decision()), "different action is not deduped");
  });

  it("host isolates recorder failures and disables recording after repeated ones", () => {
    const failing = { record: () => { throw new Error("db locked"); } } as unknown as ShadowRecorder;
    const origErr = console.error;
    console.error = () => {};
    try {
      defaultWorldModelHost.setShadowRecorder(failing);
      for (let i = 0; i < 6; i++) {
        const out = defaultWorldModelHost.ingestObservation({
          invariantId: "inv_clean_test_suite",
          observedState: false,
          observedAt: Date.now(),
          confidence: 0.95,
        });
        assert.ok(out.proposals.length > 0, "ingest still returns proposals");
      }
      assert.equal(defaultWorldModelHost.shadowRecordingSettled, true);
    } finally {
      console.error = origErr;
      defaultWorldModelHost.setShadowRecorder(null);
    }
  });

  it("end to end: observation -> persisted rows -> shadow-metrics evaluator", () => {
    defaultWorldModelHost.setShadowRecorder(rec);
    try {
      const out = defaultWorldModelHost.ingestObservation({
        invariantId: "inv_clean_test_suite",
        observedState: false,
        observedAt: Date.now(),
        confidence: 0.95,
      });
      assert.ok(out.proposals.length > 0, "anomaly should yield proposals");
      for (const p of out.proposals) {
        const row = db.getProposal(p.id);
        assert.ok(row, `proposal ${p.id} persisted`);
        assert.equal(row.shadow, 1);
        assert.equal(gateRows(p.id).length, 1);
      }
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = loadShadowRows(raw);
        assert.equal(rows.length, out.proposals.length);
        const m = computeShadowMetrics(rows, { nowMs: Date.now() + 1000 });
        const surfaced = rows.filter((r) => r.decision === "SURFACE").length;
        assert.equal(m.surfaced, surfaced);
        assert.equal(m.verdict, "insufficient_data");
      } finally {
        raw.close();
      }
    } finally {
      defaultWorldModelHost.setShadowRecorder(null);
    }
  });
});
