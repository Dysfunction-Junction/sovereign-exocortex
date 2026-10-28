import test from "node:test";
import assert from "node:assert/strict";
import { LivingLifeGraph } from "@exocortex/world-model";
import {
  executeScriptedAction,
  handleDiagnosticProbe,
  handleSelfHealRestore,
  defaultAutoExecutor,
  DiagnosticProbeSchema,
  SelfHealRestoreSchema,
  SCRIPTED_ACTION_TIERS,
  getScriptedActionTier,
} from "./scripted-executors.js";
import type { InferencePolicy, ProposalEnvelope } from "@exocortex/world-model";

test("diagnostic_probe: schema validation accepts valid arguments and rejects invalid ones", () => {
  // Valid cases
  const valid1 = DiagnosticProbeSchema.safeParse({ command: "diagnostic_probe" });
  assert.equal(valid1.success, true);

  const valid2 = DiagnosticProbeSchema.safeParse({
    command: "diagnostic_probe",
    invariantId: "inv_clean_test_suite",
    targetEntityId: "project_sovereign_exocortex",
    maxHops: 3,
    note: "periodic health probe",
  });
  assert.equal(valid2.success, true);

  // Invalid: wrong command
  const badCommand = DiagnosticProbeSchema.safeParse({ command: "probe" });
  assert.equal(badCommand.success, false);

  // Invalid: maxHops out of range
  const badHops = DiagnosticProbeSchema.safeParse({
    command: "diagnostic_probe",
    maxHops: -1,
  });
  assert.equal(badHops.success, false);

  // Invalid: extra unknown fields refused by strict()
  const extraFields = DiagnosticProbeSchema.safeParse({
    command: "diagnostic_probe",
    unrecognizedField: "malicious_injection",
  });
  assert.equal(extraFields.success, false);
});

test("diagnostic_probe: executes deterministically against LivingLifeGraph with zero model calls", () => {
  const graph = new LivingLifeGraph();
  graph.addEntity({
    id: "project_sovereign_exocortex",
    type: "PROJECT",
    name: "Sovereign Exocortex",
    properties: { status: "active" },
  });
  graph.addEntity({
    id: "pkg_core",
    type: "PROJECT",
    name: "Core Package",
    properties: {},
  });
  graph.addEdge("project_sovereign_exocortex", "pkg_core", "DEPENDS_ON", 1.0);

  // Spy on global fetch to verify zero model/network calls
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error("Model or remote endpoint must NOT be called in scripted execution");
  }) as unknown as typeof fetch;

  try {
    const outcome = handleDiagnosticProbe(
      {
        command: "diagnostic_probe",
        invariantId: "inv_clean_test_suite",
        targetEntityId: "project_sovereign_exocortex",
        maxHops: 2,
      },
      { lifeGraph: graph, now: () => 1700000000000 },
    );

    assert.equal(fetchCallCount, 0, "No model client or network call must occur");
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.command, "diagnostic_probe");
      assert.equal(outcome.targetEntityId, "project_sovereign_exocortex");
      assert.equal(outcome.invariantId, "inv_clean_test_suite");
      assert.equal(outcome.hops, 2);
      assert.equal(outcome.executedAt, 1700000000000);
      assert.ok(outcome.graphContext);
      assert.equal(outcome.graphContext.entityFound, true);
      assert.equal(outcome.graphContext.entityType, "PROJECT");
      assert.deepEqual(outcome.graphContext.neighbors, ["pkg_core"]);
      assert.equal(outcome.graphContext.subgraphEntityCount, 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("self_heal_restore: schema validation accepts valid arguments and rejects invalid ones", () => {
  // Valid
  const valid = SelfHealRestoreSchema.safeParse({
    command: "self_heal_restore",
    invariantId: "inv_clean_test_suite",
    targetEntityId: "project_sovereign_exocortex",
    targetState: true,
  });
  assert.equal(valid.success, true);

  // Invalid: missing targetState
  const missingState = SelfHealRestoreSchema.safeParse({
    command: "self_heal_restore",
    invariantId: "inv_clean_test_suite",
    targetEntityId: "project_sovereign_exocortex",
  });
  assert.equal(missingState.success, false);

  // Invalid: unexpected extra fields refused by strict()
  const extraFields = SelfHealRestoreSchema.safeParse({
    command: "self_heal_restore",
    invariantId: "inv_clean_test_suite",
    targetEntityId: "project_sovereign_exocortex",
    targetState: true,
    extraArg: 123,
  });
  assert.equal(extraFields.success, false);
});

test("self_heal_restore: executes deterministically with zero model calls", () => {
  const graph = new LivingLifeGraph();
  graph.addEntity({
    id: "project_sovereign_exocortex",
    type: "PROJECT",
    name: "Sovereign Exocortex",
    properties: {},
  });

  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error("Model or remote endpoint must NOT be called in scripted execution");
  }) as unknown as typeof fetch;

  try {
    const outcome = handleSelfHealRestore(
      {
        command: "self_heal_restore",
        invariantId: "inv_clean_test_suite",
        targetEntityId: "project_sovereign_exocortex",
        targetState: true,
      },
      { lifeGraph: graph, now: () => 1700000000000 },
    );

    assert.equal(fetchCallCount, 0, "No model client or network call must occur");
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.command, "self_heal_restore");
      assert.equal(outcome.invariantId, "inv_clean_test_suite");
      assert.equal(outcome.targetEntityId, "project_sovereign_exocortex");
      assert.equal(outcome.targetState, true);
      assert.equal(outcome.restored, true);
      assert.equal(outcome.executedAt, 1700000000000);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("executeScriptedAction: refuses unknown commands, non-objects, and invalid schemas", () => {
  let fetchCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error("Model or remote endpoint must NOT be called");
  }) as unknown as typeof fetch;

  try {
    // Non-object
    const res1 = executeScriptedAction(null);
    assert.equal(res1.ok, false);
    assert.match(res1.error, /non-null object/);

    // Missing command
    const res2 = executeScriptedAction({});
    assert.equal(res2.ok, false);
    assert.match(res2.error, /missing or non-string command/);

    // Unknown command
    const res3 = executeScriptedAction({ command: "rm_rf" });
    assert.equal(res3.ok, false);
    assert.match(res3.error, /unknown or unmapped/i);

    // Malformed arguments for diagnostic_probe
    const res4 = executeScriptedAction({
      command: "diagnostic_probe",
      maxHops: "five", // invalid type
    });
    assert.equal(res4.ok, false);
    assert.match(res4.error, /invalid diagnostic_probe arguments/i);

    // Assert zero model calls
    assert.equal(fetchCallCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("defaultAutoExecutor: dispatches proposal suggestedAction deterministically", () => {
  const policy: InferencePolicy = {
    id: "pol_test_1",
    type: "EPISTEMIC",
    title: "Test Epistemic Policy",
    description: "Probe anomaly",
    targetEntityId: "project_sovereign_exocortex",
    invariantId: "inv_clean_test_suite",
    expectedUtility: 0.5,
    informationGain: 0.8,
    expectedFreeEnergyScore: 0.7,
    estimatedRisk: 0.0,
    urgency: 0.5,
    actionPayload: { command: "diagnostic_probe", invariantId: "inv_clean_test_suite" },
  };

  const proposal: ProposalEnvelope = {
    id: "prop_test_1",
    candidateId: "inv_clean_test_suite",
    summary: "Probe anomaly",
    urgency: 0.5,
    confidence: 0.98,
    estimatedRisk: 0.0,
    category: "EPISTEMIC",
    suggestedAction: {
      command: "diagnostic_probe",
      invariantId: "inv_clean_test_suite",
      targetEntityId: "project_sovereign_exocortex",
      maxHops: 2,
    },
  };

  const outcome = defaultAutoExecutor(policy, proposal);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.command, "diagnostic_probe");
  }
});

test("self_heal_restore is tier T2 and refused by defaultAutoExecutor (never auto-executed)", () => {
  assert.equal(SCRIPTED_ACTION_TIERS.diagnostic_probe, 0);
  assert.equal(SCRIPTED_ACTION_TIERS.self_heal_restore, 2);
  assert.equal(getScriptedActionTier("diagnostic_probe"), 0);
  assert.equal(getScriptedActionTier("self_heal_restore"), 2);

  const policy: InferencePolicy = {
    id: "pol_test_2",
    type: "PRAGMATIC",
    title: "Restore Clean Test Suite",
    description: "Apply self-heal restore",
    targetEntityId: "project_sovereign_exocortex",
    invariantId: "inv_clean_test_suite",
    expectedUtility: 0.9,
    informationGain: 0.1,
    expectedFreeEnergyScore: 0.85,
    estimatedRisk: 0.2,
    urgency: 0.7,
    actionPayload: {
      command: "self_heal_restore",
      invariantId: "inv_clean_test_suite",
      targetEntityId: "project_sovereign_exocortex",
      targetState: true,
    },
  };

  const proposal: ProposalEnvelope = {
    id: "prop_test_2",
    candidateId: "inv_clean_test_suite",
    summary: "Restore Clean Test Suite",
    urgency: 0.7,
    confidence: 0.9,
    estimatedRisk: 0.2,
    category: "PRAGMATIC",
    suggestedAction: {
      command: "self_heal_restore",
      invariantId: "inv_clean_test_suite",
      targetEntityId: "project_sovereign_exocortex",
      targetState: true,
    },
  };

  const outcome = defaultAutoExecutor(policy, proposal);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /not allowlisted for autonomous execution/i);
  assert.equal(outcome.command, "self_heal_restore");
});
