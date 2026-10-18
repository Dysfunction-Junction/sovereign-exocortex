import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";
import { ExocortexDatabase } from "@exocortex/core/db";
import { computeShadowMetrics, loadShadowRows } from "@exocortex/core/shadow-metrics";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";
import {
  applyShadowLabel,
  inferProposalOutcomes,
  InferredOutcomeScheduler,
  isStateMatching,
  type InferredOutcomeReport,
} from "./inferred-outcomes.js";

const NOW = 1_700_000_000_000;

function createTestDb(dir: string): ExocortexDatabase {
  const dbPath = join(dir, "test.db");
  const db = new ExocortexDatabase({ path: dbPath });
  const rec = new ShadowRecorder(db, { nowMs: () => NOW });
  rec.ensureHostDevice();
  rec.ensureInvariants();
  db.registerDevice({
    device_id: "device_phone_galaxy_s26",
    name: "Samsung Galaxy S26",
    platform: "android",
    pubkey_spki: new Uint8Array([1, 2, 3]),
    key_attested: 1,
    scopes: ["mobile:label"],
    enrolled_at: NOW,
    revoked_at: null,
  });
  return db;
}

function insertProposal(
  db: ExocortexDatabase,
  id: string,
  options: {
    invariantId?: string | null;
    decision?: "SURFACE" | "SUPPRESS" | "QUEUE";
    state?: "SURFACED" | "SUPPRESSED" | "STAGED" | "APPROVED" | "REJECTED";
    gateTs?: number;
    expiresAt?: number;
    action?: Record<string, unknown>;
  } = {},
): number {
  const gateTs = options.gateTs ?? NOW;
  const expiresAt = options.expiresAt ?? NOW + 86_400_000;
  const decision = options.decision ?? "SURFACE";
  const state = options.state ?? (decision === "SURFACE" ? "SURFACED" : "SUPPRESSED");
  const actionPayload = options.action ?? {
    command: "self_heal_restore",
    ...(options.invariantId !== undefined ? { invariantId: options.invariantId } : { invariantId: "inv_zero_broken_commits" }),
    targetState: true,
  };
  const actionStr = JSON.stringify(actionPayload);

  const { event } = db.ingestEvent(HOST_DEVICE_ID, {
    event_id: `prop-event:${id}`,
    kind: "proposal",
    ts_device: gateTs,
    schema_ver: 1,
    payload: {
      proposal_id: id,
      invariant_id: options.invariantId !== undefined ? options.invariantId : "inv_zero_broken_commits",
      summary: `Proposal ${id}`,
      shadow: 1,
    },
  });

  db.insertProposal({
    proposal_id: id,
    created_seq: event.seq,
    invariant_id: options.invariantId !== undefined ? options.invariantId : "inv_zero_broken_commits",
    policy_type: "PRAGMATIC",
    tier: 1,
    summary: `Proposal ${id}`,
    action: actionStr,
    action_hash: new Uint8Array(32),
    efe: 0.8,
    risk_term: 0.1,
    ambiguity_term: 0.1,
    state,
    shadow: 1,
    expires_at: expiresAt,
    updated_at: gateTs,
  });

  db.recordGateDecision({
    proposal_id: id,
    mode: "MAINTENANCE",
    decision,
    reason: "test gate decision",
    ts: gateTs,
  });

  return event.seq;
}

describe("Inferred Outcome Label Engine", () => {
  let dir: string;
  let db: ExocortexDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inferred-test-"));
    db = createTestDb(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("marks proposal already_did when target invariant is restored without a tap", () => {
    const proposalId = "p_restore_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_zero_broken_commits",
      gateTs: NOW,
    });

    // Subsequent observation event restoring the invariant state to true
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_restored_1",
      kind: "observation",
      ts_device: NOW + 300_000, // 5 min later
      schema_ver: 1,
      payload: {
        invariantId: "inv_zero_broken_commits",
        observedState: true,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 600_000 });

    assert.equal(report.alreadyDidCount, 1);
    assert.equal(report.ignoredCount, 0);
    assert.equal(report.skippedTapCount, 0);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].label, "already_did");
    assert.equal(labels[0].latency_ms, 300_000);

    const actual = JSON.parse(labels[0].actual!);
    assert.equal(actual.source, "inferred");
    assert.equal(actual.reason, "invariant_restored");
    assert.equal(actual.invariant_id, "inv_zero_broken_commits");

    // Proposal transitioned to EXPIRED so it does not linger in pending lists
    const updated = db.getProposal(proposalId);
    assert.equal(updated?.state, "EXPIRED");
  });

  test("does not count observation before gate_ts or skewed timestamp as already_did", () => {
    const proposalId = "p_skew_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_zero_broken_commits",
      gateTs: NOW,
      expiresAt: NOW + 86_400_000,
    });

    // Skewed observation event with ts_device earlier than gate_ts
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_skewed_old",
      kind: "observation",
      ts_device: NOW - 50_000, // earlier than proposal
      schema_ver: 1,
      payload: {
        invariantId: "inv_zero_broken_commits",
        observedState: true,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 10_000 });

    // Must not count as already_did
    assert.equal(report.alreadyDidCount, 0);
    assert.equal(report.stillPendingCount, 1);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 0);
  });

  test("marks proposal ignored when interaction horizon expires without tap or restoration", () => {
    const proposalId = "p_ignore_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
      expiresAt: NOW + 86_400_000,
    });

    // 25 hours later, horizon elapsed with zero events
    const report = inferProposalOutcomes(db, { nowMs: NOW + 90_000_000 });

    assert.equal(report.ignoredCount, 1);
    assert.equal(report.alreadyDidCount, 0);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].label, "ignored");
    assert.equal(labels[0].latency_ms, null);

    const actual = JSON.parse(labels[0].actual!);
    assert.equal(actual.source, "inferred");
    assert.equal(actual.reason, "expired_without_interaction");

    const updated = db.getProposal(proposalId);
    assert.equal(updated?.state, "EXPIRED");
  });

  test("upgrades ignored to already_did when late evidence arrives within effective horizon", () => {
    const proposalId = "p_upgrade_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_zero_broken_commits",
      gateTs: NOW,
      expiresAt: NOW + 86_400_000,
    });

    // First pass: proposal expired without evidence -> labeled ignored
    const pass1 = inferProposalOutcomes(db, { nowMs: NOW + 90_000_000 });
    assert.equal(pass1.ignoredCount, 1);
    assert.equal(db.getShadowLabels(proposalId)[0].label, "ignored");

    // Later: buffered telemetry from offline device arrives with ts_device within the horizon
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_late_buffered",
      kind: "observation",
      ts_device: NOW + 40_000_000, // arrived late, but happened during active horizon
      schema_ver: 1,
      payload: {
        invariantId: "inv_zero_broken_commits",
        observedState: true,
      },
    });

    // Second pass: upgrades from ignored to already_did
    const pass2 = inferProposalOutcomes(db, { nowMs: NOW + 95_000_000 });
    assert.equal(pass2.upgradedCount, 1);
    assert.equal(pass2.alreadyDidCount, 0);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels[0].label, "already_did");
    const actual = JSON.parse(labels[0].actual!);
    assert.equal(actual.upgraded_from, "ignored");
    assert.equal(actual.source, "inferred");
  });

  test("leaves proposal pending when active inside its interaction window", () => {
    const proposalId = "p_pending_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_cafeteria_synced",
      gateTs: NOW,
      expiresAt: NOW + 86_400_000,
    });

    // Only 2 hours in
    const report = inferProposalOutcomes(db, { nowMs: NOW + 7_200_000 });

    assert.equal(report.stillPendingCount, 1);
    assert.equal(report.alreadyDidCount, 0);
    assert.equal(report.ignoredCount, 0);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 0);

    const proposal = db.getProposal(proposalId);
    assert.equal(proposal?.state, "SURFACED");
  });

  test("strictly never overwrites an existing human tap label", () => {
    const proposalId = "p_tap_protected";
    insertProposal(db, proposalId, {
      invariantId: "inv_zero_broken_commits",
      gateTs: NOW,
    });

    // Human taps 'wanted' on device
    applyShadowLabel(db, "device_phone_galaxy_s26", {
      proposalId,
      label: "wanted",
      source: "tap",
      latencyMs: 1200,
      actual: { via: "biometric_modal" },
    });

    // Later: invariant is restored AND expiration timestamp passes
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_restored_tap",
      kind: "observation",
      ts_device: NOW + 1_000_000,
      schema_ver: 1,
      payload: {
        invariantId: "inv_zero_broken_commits",
        observedState: true,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 100_000_000 });

    assert.equal(report.skippedTapCount, 1);
    assert.equal(report.alreadyDidCount, 0);
    assert.equal(report.ignoredCount, 0);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].label, "wanted");

    const actual = JSON.parse(labels[0].actual!);
    assert.equal(actual.source, "tap");
    assert.equal(actual.via, "biometric_modal");
  });

  test("never labels non-surfaced proposals (SUPPRESS / DROP)", () => {
    const proposalId = "p_suppressed_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_clean_test_suite",
      decision: "SUPPRESS",
      state: "SUPPRESSED",
      gateTs: NOW,
      expiresAt: NOW + 3600_000,
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 10_000_000 });

    assert.equal(report.evaluatedCount, 0);
    assert.equal(report.alreadyDidCount, 0);
    assert.equal(report.ignoredCount, 0);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 0);
  });

  test("does not count late restoration after horizon expiry as already_did (labels ignored)", () => {
    const proposalId = "p_late_restore";
    insertProposal(db, proposalId, {
      invariantId: "inv_zero_broken_commits",
      gateTs: NOW,
      expiresAt: NOW + 86_400_000,
    });

    // Observation event restoring the invariant arrived AFTER proposal expiration (e.g. 30 hours later)
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_too_late",
      kind: "observation",
      ts_device: NOW + 108_000_000, // 30h later
      schema_ver: 1,
      payload: {
        invariantId: "inv_zero_broken_commits",
        observedState: true,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 110_000_000 });

    assert.equal(report.alreadyDidCount, 0);
    assert.equal(report.ignoredCount, 1);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels[0].label, "ignored");
  });

  test("supports symmetrical matching for targetState: false", () => {
    const proposalId = "p_false_state";
    insertProposal(db, proposalId, {
      invariantId: "inv_bridge_connected",
      gateTs: NOW,
      action: {
        command: "disconnect_probe",
        invariantId: "inv_bridge_connected",
        targetState: false,
      },
    });

    // Ingest restoring observation matching false
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_false_match",
      kind: "observation",
      ts_device: NOW + 5000,
      schema_ver: 1,
      payload: {
        invariantId: "inv_bridge_connected",
        observedState: false,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 10_000 });
    assert.equal(report.alreadyDidCount, 1);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels[0].label, "already_did");
  });

  test("skips unresolvable proposal without invariant_id rather than mislabeling as ignored", () => {
    const proposalId = "p_unresolvable";
    insertProposal(db, proposalId, {
      invariantId: null,
      action: { command: "custom_unregistered_action" },
      gateTs: NOW,
      expiresAt: NOW - 1000, // already expired
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW });
    assert.equal(report.unresolvableCount, 1);
    assert.equal(report.ignoredCount, 0);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 0);
  });

  test("idempotent execution: multiple passes produce zero duplicate events and consistent report", () => {
    const proposalId = "p_idempotent_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
      expiresAt: NOW + 10_000,
    });

    const pass1 = inferProposalOutcomes(db, { nowMs: NOW + 400_000 });
    assert.equal(pass1.ignoredCount, 1);

    const pass2 = inferProposalOutcomes(db, { nowMs: NOW + 500_000 });
    assert.equal(pass2.ignoredCount, 0);
    assert.equal(pass2.finalizedCount, 1);

    const labelEvents = db.listEvents({ kind: "label" });
    assert.equal(labelEvents.length, 1);
  });

  test("dryRun=true makes no modifications to database", () => {
    const proposalId = "p_dry_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
      expiresAt: NOW + 10_000,
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 400_000, dryRun: true });
    assert.equal(report.ignoredCount, 1);

    const labels = db.getShadowLabels(proposalId);
    assert.equal(labels.length, 0);

    const prop = db.getProposal(proposalId);
    assert.equal(prop?.state, "SURFACED");
  });

  test("verifies strict calibration isolation with shadow-metrics", () => {
    // 1. Create 5 proposals with human tap labels: 4 wanted, 1 not_wanted => Tap Precision = 4/5 = 80%
    for (let i = 1; i <= 5; i++) {
      const pid = `p_tap_${i}`;
      insertProposal(db, pid, { gateTs: NOW + i * 1000 });
      applyShadowLabel(db, "device_phone_galaxy_s26", {
        proposalId: pid,
        label: i <= 4 ? "wanted" : "not_wanted",
        source: "tap",
        latencyMs: 500,
        nowMs: NOW + i * 1000,
      });
    }

    // 2. Create 4 proposals that will be inferred: 2 already_did, 2 ignored
    for (let i = 1; i <= 4; i++) {
      const pid = `p_infer_${i}`;
      insertProposal(db, pid, {
        invariantId: i <= 2 ? "inv_zero_broken_commits" : "inv_clean_test_suite",
        gateTs: NOW + (10 + i) * 1000,
        expiresAt: NOW + 30_000,
      });
    }

    // Restoring observation for the first 2
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_batch_restore",
      kind: "observation",
      ts_device: NOW + 20_000,
      schema_ver: 1,
      payload: {
        invariantId: "inv_zero_broken_commits",
        observedState: true,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 400_000 });
    assert.equal(report.alreadyDidCount, 2);
    assert.equal(report.ignoredCount, 2);

    // 3. Evaluate shadow metrics over all proposals
    const rows = loadShadowRows(db.raw);
    const metrics = computeShadowMetrics(rows, { nowMs: NOW + 400_000, minLabels: 5 });

    // CRITICAL INVARIANT: Inferred labels NEVER pollute tap-calibrated Precision@surface
    assert.equal(metrics.wanted, 4);
    assert.equal(metrics.notWanted, 1);
    assert.equal(metrics.precision, 4 / 5); // 0.80 exactly

    // Inferred counts are captured independently
    assert.equal(metrics.alreadyDid, 2);
    assert.equal(metrics.ignored, 2);
    assert.equal(metrics.tapped, 5);
    assert.equal(metrics.inferred, 4);

    // Pessimistic precision counts ignored as a miss: 4 / (4 + 1 + 2 ignored) = 4/7
    assert.equal(metrics.pessimisticPrecision, 4 / 7);
  });

  test("InferredOutcomeScheduler executes periodic passes and cancels cleanly", async () => {
    const box: { report?: InferredOutcomeReport } = {};
    const scheduler = new InferredOutcomeScheduler({
      db,
      intervalMs: 10_000,
      nowMs: () => NOW,
      onPassComplete: (r: InferredOutcomeReport) => {
        box.report = r;
      },
    });

    insertProposal(db, "p_sched_1", {
      invariantId: "inv_zero_broken_commits",
      gateTs: NOW - 500_000,
      expiresAt: NOW - 400_000,
    });

    const manualPass = await scheduler.runPass();
    assert.ok(manualPass);
    assert.equal(manualPass.ignoredCount, 1);
    assert.equal(box.report?.ignoredCount, 1);

    scheduler.start();
    scheduler.stop();
  });

  test("isStateMatching handles 0 vs null/empty-string and canonical json object matching", () => {
    // Zero must not match null, empty string, or false
    assert.equal(isStateMatching(null, 0), false);
    assert.equal(isStateMatching("", 0), false);
    assert.equal(isStateMatching(false, 0), false);
    assert.equal(isStateMatching(0, 0), true);
    assert.equal(isStateMatching("0", 0), true);
    assert.equal(isStateMatching(" 0 ", 0), true);

    // Objects match regardless of key order
    assert.equal(isStateMatching({ b: 2, a: 1 }, { a: 1, b: 2 }), true);
    assert.equal(isStateMatching({ a: 1 }, { a: 2 }), false);
  });

  test("re-gated proposal uses first surface timestamp so intervening observations are matched", () => {
    const proposalId = "p_regated_1";
    insertProposal(db, proposalId, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
    });

    // Re-gate occurs 5 seconds later
    db.recordGateDecision({
      proposal_id: proposalId,
      mode: "MAINTENANCE",
      decision: "SURFACE",
      reason: "periodic re-eval",
      ts: NOW + 5000,
    });

    // Observation occurs between first surface (NOW) and re-gate (NOW + 5000)
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_intervening_regated",
      kind: "observation",
      ts_device: NOW + 2000,
      schema_ver: 1,
      payload: {
        invariantId: "inv_clean_test_suite",
        observedState: true,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 10_000 });
    assert.equal(report.alreadyDidCount, 1);
    assert.equal(report.results[0].label, "already_did");
    assert.equal(report.results[0].latencyMs, 2000);
  });

  test("protects legacy labels with null actual via strict whitelist", () => {
    const proposalId = "p_legacy_null_actual";
    insertProposal(db, proposalId, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
    });

    // Directly insert a legacy label with actual = NULL
    db.raw.prepare("INSERT INTO shadow_labels (proposal_id, label, actual, latency_ms, ts) VALUES (?, ?, NULL, 500, ?)").run(
      proposalId,
      "wanted",
      NOW,
    );

    const report = inferProposalOutcomes(db, { nowMs: NOW + 1_000_000 });
    assert.equal(report.skippedTapCount, 1);
    assert.equal(report.results[0].label, "skipped_tap");
  });

  test("late human tap strictly overwrites inferred label in database conflict clause", () => {
    const proposalId = "p_late_tap_override";
    insertProposal(db, proposalId, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
      expiresAt: NOW + 10_000,
    });

    // First: infer proposal as 'ignored'
    const report1 = inferProposalOutcomes(db, { nowMs: NOW + 400_000 });
    assert.equal(report1.ignoredCount, 1);

    const labelsBefore = db.getShadowLabels(proposalId);
    assert.equal(labelsBefore[0].label, "ignored");

    // Later: human tap arrives out-of-band (e.g. offline device reconnecting)
    applyShadowLabel(db, "device_phone_galaxy_s26", {
      proposalId,
      label: "wanted",
      source: "tap",
      latencyMs: 1500,
      nowMs: NOW + 500_000,
    });

    const labelsAfter = db.getShadowLabels(proposalId);
    assert.equal(labelsAfter.length, 1);
    assert.equal(labelsAfter[0].label, "wanted");

    // Subsequent inference pass respects the human tap and skips it
    const report2 = inferProposalOutcomes(db, { nowMs: NOW + 600_000 });
    assert.equal(report2.skippedTapCount, 1);
  });

  test("resolves invariant fallback from proposal_id naming pattern", () => {
    const proposalId = "policy_pragmatic_inv_clean_test_suite_12345";
    // Insert proposal with null invariant_id on the proposal record
    insertProposal(db, proposalId, {
      invariantId: null,
      gateTs: NOW,
    });

    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_fallback_resolve",
      kind: "observation",
      ts_device: NOW + 1000,
      schema_ver: 1,
      payload: {
        invariantId: "inv_clean_test_suite",
        observedState: true,
      },
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW + 2000 });
    assert.equal(report.alreadyDidCount, 1);
    assert.equal(report.unresolvableCount, 0);
  });

  test("per-row error isolation ensures a corrupted proposal does not block valid proposals", () => {
    const pid1 = "p_corrupt_row";
    insertProposal(db, pid1, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
    });

    // Valid proposal
    const pid2 = "p_valid_row";
    insertProposal(db, pid2, {
      invariantId: "inv_clean_test_suite",
      gateTs: NOW,
    });
    db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "obs_valid_row",
      kind: "observation",
      ts_device: NOW + 1000,
      schema_ver: 1,
      payload: { invariantId: "inv_clean_test_suite", observedState: true },
    });

    // Simulate an unexpected error thrown while evaluating pid1
    const origGetShadowLabels = db.getShadowLabels.bind(db);
    db.getShadowLabels = (id?: string) => {
      if (id === pid1) throw new Error("Simulated transient error evaluating proposal 1");
      return origGetShadowLabels(id);
    };

    const report = inferProposalOutcomes(db, { nowMs: NOW + 2000 });
    // Corrupted proposal isolated and recorded as unresolvable
    assert.equal(report.unresolvableCount, 1);
    const unres = report.results.find((r) => r.proposalId === pid1);
    assert.ok(unres);
    assert.match(unres.reason, /Simulated transient error/);

    // Valid proposal still evaluated and labeled already_did
    assert.equal(report.alreadyDidCount, 1);
    const validRes = report.results.find((r) => r.proposalId === pid2);
    assert.ok(validRes);
    assert.equal(validRes.label, "already_did");
  });

  test("rejects unknown invariant string as unresolvable instead of falsely ignoring it", () => {
    const proposalId = "policy_pragmatic_inv_unknown_fake_subsystem_12345";
    insertProposal(db, proposalId, {
      invariantId: null,
      gateTs: NOW - 500_000,
      expiresAt: NOW - 400_000,
    });

    const report = inferProposalOutcomes(db, { nowMs: NOW });
    assert.equal(report.unresolvableCount, 1);
    assert.equal(report.ignoredCount, 0);
    assert.equal(report.results[0].label, "unresolvable");
  });

  test("isStateMatching does not accidentally coerce null, undefined, or objects to target strings", () => {
    assert.equal(isStateMatching("active", "active"), true);
    assert.equal(isStateMatching(123, "123"), true);
    assert.equal(isStateMatching(true, "true"), true);

    // Negative cases: null, undefined, objects, or arrays should never match literal string names
    assert.equal(isStateMatching(null, "null"), false);
    assert.equal(isStateMatching(undefined, "undefined"), false);
    assert.equal(isStateMatching({}, "[object Object]"), false);
    assert.equal(isStateMatching([], ""), false);
    assert.equal(isStateMatching({}, ""), false);
  });
});
