import test from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import type { GateDecision, InferencePolicy, ProposalEnvelope } from "@exocortex/world-model";
import { CalibrationSampler } from "./calibration-sampler.js";
import { ShadowRecorder } from "./shadow-recorder.js";

const localTime = (hour: number) => new Date(2026, 9, 28, hour).getTime();

function record(db: ExocortexDatabase, id: string, options: { efe?: number; queued?: boolean; shadow?: boolean; ttlMs?: number } = {}) {
  const now = localTime(8);
  const recorder = new ShadowRecorder(db, { nowMs: () => now, ttlMs: options.ttlMs ?? 60_000, shadow: options.shadow ?? true, cooldownMs: 0 });
  const policy: InferencePolicy = {
    id,
    type: "PRAGMATIC",
    title: id,
    description: "test proposal",
    targetEntityId: "device_phone",
    invariantId: "inv_test_sampler",
    expectedUtility: 0.5,
    informationGain: 0.1,
    expectedFreeEnergyScore: options.efe ?? 1,
    estimatedRisk: 0.1,
    urgency: 0.5,
    actionPayload: { proposal: id },
  };
  const proposal: ProposalEnvelope = { id, candidateId: "inv_test_sampler", summary: id, urgency: 0.5, confidence: 0.9, estimatedRisk: 0.1 };
  const gate: GateDecision = {
    action: options.queued === false ? "ALLOW_PROMPT" : "SUPPRESS_AND_QUEUE",
    mode: "MAINTENANCE_SURFACING",
    reason: "queued for test",
    targetDelivery: "GLASS_MODAL",
    confidence: 0.9,
    evaluatedAt: now,
  };
  return recorder.record(policy, proposal, gate)!;
}

function database(): ExocortexDatabase {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerInvariant({ invariant_id: "inv_test_sampler", name: "sampler test", category: "TEST", enabled: 1 });
  return db;
}

test("calibration sampler enforces the daily cap and orders lowest EFE first", () => {
  const db = database();
  const env: NodeJS.ProcessEnv = { SHADOW: "1", CALIBRATION_DAILY_CAP: "2" };
  try {
    record(db, "sample-high", { efe: 3 });
    record(db, "sample-low-a", { efe: 1 });
    record(db, "sample-low-b", { efe: 1 });
    const sampler = new CalibrationSampler(() => localTime(8), env);
    assert.equal(sampler.run(db), 2);
    assert.equal(sampler.run(db), 0, "only one run per local hour");
    assert.equal(new CalibrationSampler(() => localTime(9), env).run(db), 0, "daily cap carries across hours");
    const promoted = db.raw.prepare("SELECT proposal_id FROM gate_decisions WHERE reason LIKE 'calibration:%' ORDER BY rowid").all() as Array<{ proposal_id: string }>;
    assert.deepEqual(promoted.map((row) => row.proposal_id), ["sample-low-b", "sample-low-a"], "newest wins equal EFE");
    assert.ok(promoted.every((row) => db.getProposal(row.proposal_id)?.state === "SURFACED"));
  } finally {
    db.close();
  }
});

test("sampler checks SHADOW on each run and skips outside local 08:00-21:00", () => {
  const db = database();
  const env: NodeJS.ProcessEnv = { SHADOW: "0" };
  try {
    record(db, "shadow-disabled");
    const sampler = new CalibrationSampler(() => localTime(8), env);
    assert.equal(sampler.run(db), 0);
    env.SHADOW = "1";
    assert.equal(sampler.run(db), 1, "re-reads SHADOW after it changes");

    record(db, "too-early");
    assert.equal(new CalibrationSampler(() => localTime(7), env).run(db), 0);
    record(db, "too-late");
    assert.equal(new CalibrationSampler(() => localTime(21), env).run(db), 0);
  } finally {
    db.close();
  }
});

test("only staged, shadow, unlabeled, unexpired proposals with latest QUEUE are eligible", () => {
  const db = database();
  try {
    const eligible = record(db, "eligible");
    const live = record(db, "live", { shadow: false });
    const labeled = record(db, "labeled");
    db.recordShadowLabel({ proposal_id: labeled.proposal_id, label: "wanted", actual: JSON.stringify({ source: "tap" }), ts: localTime(8) });
    record(db, "expired", { ttlMs: -1 });
    record(db, "surfaced", { queued: false });
    const changed = record(db, "latest-not-queue");
    db.recordGateDecision({ proposal_id: changed.proposal_id, mode: "MAINTENANCE_SURFACING", decision: "SURFACE", reason: "other", ts: localTime(8) + 1 });
    const sampler = new CalibrationSampler(() => localTime(8), { SHADOW: "1" });
    assert.equal(sampler.run(db), 1);
    assert.equal(db.getProposal(eligible.proposal_id)?.state, "SURFACED");
    assert.equal(db.getProposal(live.proposal_id)?.state, "STAGED");
    assert.equal(db.getProposal(labeled.proposal_id)?.state, "STAGED");
    assert.equal(db.getProposal("expired")?.state, "STAGED");
    assert.equal(db.getProposal("surfaced")?.state, "SURFACED");
    assert.equal(db.getProposal(changed.proposal_id)?.state, "STAGED");
  } finally {
    db.close();
  }
});
