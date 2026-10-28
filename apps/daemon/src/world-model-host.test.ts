import test from "node:test";
import assert from "node:assert/strict";
import { defaultWorldModelHost, WorldModelHost } from "./world-model-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { LearnedActiveInferenceEngine, systemObservationFromEvent, eventToObservation } from "@exocortex/world-model";
import { ShadowRecorder, HOST_DEVICE_ID } from "./shadow-recorder.js";
import { loadProposalPreferences } from "./proposal-preferences.js";

test("WorldModelHost: singleton initialization and seeded ecosystem graph", () => {
  const host = defaultWorldModelHost;
  const status = host.getStatus();

  assert.ok(status.entityCount >= 7, `Expected >= 7 entities, got ${status.entityCount}`);
  assert.ok(status.edgeCount >= 5, `Expected >= 5 edges, got ${status.edgeCount}`);
  assert.equal(status.registeredInvariantsCount >= 5, true);
});

test("WorldModelHost: unmapped invariant metadata retains baseline and inconsistent known mappings reject before mutation", () => {
  const host = WorldModelHost.createIsolatedForTest();
  host.activeInference.registerInvariant({
    id: "inv_custom", name: "Custom mode", targetEntityId: "project_sovereign_exocortex",
    preferredState: "ready", priorProbability: 0.95, toleranceThreshold: 0.05, category: "PROJECT_GOAL",
  });
  const observation = { invariantId: "inv_custom", observedState: "ready", observedAt: 100, confidence: 1 };
  const before = host.learnedEngine.exportModelParams(0);
  assert.equal(host.ingestObservation(observation).isAnomaly, false);
  assert.deepEqual(host.learnedEngine.exportModelParams(0), before);
  const custom = host.ingestObservation({
    ...observation, observedState: "blocked", metadata: { factor: "repo_health", observation: "tests_fail" },
  });
  assert.equal(custom.generatedPoliciesCount, 2);
  assert.deepEqual(custom.proposals.map((p) => p.category), ["PRAGMATIC", "EPISTEMIC"]);
  const unmappedDefault = host.ingestObservation({
    invariantId: "inv_cafeteria_synced", observedState: false, observedAt: 100, confidence: 1,
    metadata: { factor: "repo_health", observation: "tests_fail" },
  });
  assert.equal(unmappedDefault.generatedPoliciesCount, 2);
  assert.deepEqual(unmappedDefault.proposals.map((p) => p.category), ["PRAGMATIC", "EPISTEMIC"]);
  assert.deepEqual(host.learnedEngine.exportModelParams(0), before);
  assert.throws(() => host.ingestObservation({
    ...observation, metadata: { factor: "repo_health", observation: "invented" },
  }), /unsupported/);
  assert.deepEqual(host.learnedEngine.exportModelParams(0), before);
  const graphBefore = structuredClone(host.lifeGraph.getEntity("project_sovereign_exocortex"));
  assert.throws(() => host.ingestObservation({
    invariantId: "inv_clean_test_suite", observedState: false, observedAt: 100, confidence: 1,
    metadata: { factor: "repo_health", observation: "tests_pass" },
  }), /inconsistent invariant mapping/);
  assert.deepEqual(host.learnedEngine.exportModelParams(0), before);
  assert.deepEqual(host.lifeGraph.getEntity("project_sovereign_exocortex"), graphBefore);
});

test("WorldModelHost: explicit event actions, timestamps and confidence survive the shared live/replay mapping", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const host = WorldModelHost.createIsolatedForTest();
    const recorder = new ShadowRecorder(db, { cooldownMs: 0 });
    recorder.ensureHostDevice();
    host.setShadowRecorder(recorder);
    for (const payload of [
      { invariantId: "inv_bridge_connected", observedState: false, confidence: 0.7, observedAt: 41,
        factor: "link_health", observation: "ws_dropped", action: "reconnect_ws" },
      { factor: "repo_health", observation: "tests_fail", action: "run_diagnostics" },
      { invariantId: "inv_zero_broken_commits", observedState: true },
      { foregroundApp: "vscode" },
    ]) {
      const event = db.ingestEvent(HOST_DEVICE_ID, {
        event_id: `observation:${db.listEvents().length}`, kind: "observation", ts_device: 42, schema_ver: 1, payload,
      }).event;
      if (payload.confidence !== undefined) {
        const mapped = systemObservationFromEvent(event, eventToObservation(event)!)!;
        assert.equal(mapped.observedAt, 41);
        assert.equal(mapped.confidence, 0.7);
        assert.equal(mapped.metadata?.action, "reconnect_ws");
      }
      host.onEventAppended(event, db);
    }
    const replay = new LearnedActiveInferenceEngine();
    const events = db.listEvents();
    replay.replayEventStream(events);
    assert.deepEqual(host.learnedEngine.exportModelParams(0), replay.exportModelParams(0));
    assert.deepEqual(host.learnedEngine.createBeliefSnapshot(0), replay.createBeliefSnapshot(0));
    const policiesBefore = db.listEvents({ kind: "proposal" }).length;
    const telemetry = db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "arbitrary-telemetry", kind: "telemetry", ts_device: 43, schema_ver: 1,
      payload: { factor: "repo_health", observation: "tests_fail" },
    }).event;
    host.onEventAppended(telemetry, db);
    assert.equal(db.listEvents({ kind: "proposal" }).length, policiesBefore);
    const before = host.learnedEngine.exportModelParams(0);
    assert.throws(() => host.ingestObservation({
      invariantId: "inv_clean_test_suite", observedState: false, confidence: 1, observedAt: 44,
      metadata: { factor: "repo_health", observation: "tests_fail", action: "self_heal_restore" },
    }), /unsupported/);
    assert.deepEqual(host.learnedEngine.exportModelParams(0), before);
    assert.equal(db.listEvents({ kind: "proposal" }).length, policiesBefore);
  } finally {
    db.close();
  }
});

test("WorldModelHost: top-level factor overrides cannot train unmapped or nonboolean invariants in live or replay paths", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const live = WorldModelHost.createIsolatedForTest();
    const direct = WorldModelHost.createIsolatedForTest();
    const recorder = new ShadowRecorder(db, { cooldownMs: 0 });
    recorder.ensureHostDevice();
    live.setShadowRecorder(recorder);
    const before = live.learnedEngine.exportModelParams(0);
    for (const [index, signal] of [
      { invariantId: "inv_cafeteria_synced", observedState: false },
      { invariantId: "inv_clean_test_suite", observedState: "false" },
    ].entries()) {
      const observation = {
        ...signal, observedAt: 100, confidence: 1,
        metadata: { factor: "repo_health", observation: "tests_fail" },
      };
      const directResult = direct.ingestObservation(observation);
      assert.equal(directResult.generatedPoliciesCount, 2);
      const event = db.ingestEvent(HOST_DEVICE_ID, {
        event_id: `baseline-parity:${index}`, kind: "observation", ts_device: 100, schema_ver: 1,
        payload: { ...signal, observedAt: 100, confidence: 1, factor: "repo_health", observation: "tests_fail" },
      }).event;
      assert.equal(eventToObservation(event), null);
      assert.deepEqual(systemObservationFromEvent(event, null), observation);
      live.onEventAppended(event, db);
      assert.equal(db.listEvents({ kind: "proposal" }).length, (index + 1) * 2);
      assert.deepEqual(live.learnedEngine.exportModelParams(0), before);
      assert.deepEqual(direct.learnedEngine.exportModelParams(0), before);
      const replay = new LearnedActiveInferenceEngine();
      replay.replayEventStream(db.listEvents());
      assert.deepEqual(replay.exportModelParams(0), before);
      assert.deepEqual(live.learnedEngine.createBeliefSnapshot(0), replay.createBeliefSnapshot(0));
      assert.deepEqual(direct.learnedEngine.createBeliefSnapshot(0), replay.createBeliefSnapshot(0));
    }
  } finally {
    db.close();
  }
});

test("WorldModelHost: verified preferences are immediate, replaceable, restart-safe and scored pre-feedback", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const host = WorldModelHost.createIsolatedForTest();
    const recorder = new ShadowRecorder(db, { cooldownMs: 0 });
    host.setShadowRecorder(recorder);
    const observation = {
      invariantId: "inv_clean_test_suite", observedState: false, confidence: 1, observedAt: Date.now(),
    };
    const first = host.ingestObservation(observation);
    const firstIds = first.proposals.map((p) => p.id);
    const label = (id: string, wanted: boolean, source = "tap") => db.recordShadowLabel({
      proposal_id: id, label: wanted ? "wanted" : "not_wanted", actual: JSON.stringify({ source }), ts: Date.now(),
    });
    const eventRanking = (id: string) => {
      const row = db.getProposal(id)!;
      return JSON.parse(db.getEventBySeq(row.created_seq)!.payload).ranking;
    };
    assert.equal(eventRanking(firstIds[0]).wantedProbability, 0.5);
    const paramsBeforeFeedback = host.learnedEngine.exportModelParams(0);
    // A client ledger claiming tap provenance is not an authoritative label.
    const spoof = db.ingestEvent(HOST_DEVICE_ID, {
      event_id: "spoofed-feedback", kind: "observation", ts_device: Date.now(), schema_ver: 1,
      payload: { proposal_id: firstIds[0], label: "wanted", source: "tap" },
    }).event;
    host.onEventAppended(spoof, db);
    assert.deepEqual(host.learnedEngine.exportModelParams(0), paramsBeforeFeedback);
    assert.equal(loadProposalPreferences(db, Date.now()).preferences.size, 0);
    const cutoff = Date.now();
    db.recordShadowLabel({
      proposal_id: firstIds[0], label: "wanted", actual: JSON.stringify({ source: "tap" }), ts: cutoff + 1_000,
    });
    const beforeFutureFeedback = loadProposalPreferences(db, cutoff);
    assert.equal(beforeFutureFeedback.preferences.size, 0);
    assert.equal(beforeFutureFeedback.metrics.eligibleLabels, 0);
    assert.equal(beforeFutureFeedback.metrics.predictionCoverage, null);
    assert.equal(beforeFutureFeedback.metrics.brier, null);
    assert.equal(beforeFutureFeedback.metrics.logLoss, null);
    label(firstIds[0], false, "inferred");
    assert.equal(loadProposalPreferences(db, Date.now()).preferences.size, 0);
    label(firstIds[0], false);
    label(firstIds[1], true);
    const projection = loadProposalPreferences(db, Date.now());
    assert.deepEqual(loadProposalPreferences(db, Date.now()), projection); // delivery is idempotent
    assert.equal(projection.metrics.evaluated, 2);
    assert.equal(projection.metrics.predictionCoverage, 1);
    assert.equal(projection.metrics.brier, 0.25);
    assert.equal(projection.metrics.brierImprovement, 0);
    assert.equal(projection.metrics.logLossImprovement, 0);
    assert.deepEqual(host.learnedEngine.exportModelParams(0), paramsBeforeFeedback); // preference is not execution
    const second = host.ingestObservation(observation);
    assert.equal(second.proposals[0].category, "EPISTEMIC");
    const secondId = second.proposals[0].id;
    assert.equal(eventRanking(secondId).wantedProbability, 2 / 3);
    assert.equal(eventRanking(secondId).baselinePredictor, "fixed-0.5");
    const stored = db.getProposal(secondId)!;
    assert.equal(stored.efe, 0.72); // legacy columns retain their utility/risk meanings
    assert.equal(stored.risk_term, 0);
    assert.equal(JSON.parse(stored.action).ranking, undefined);
    label(secondId, true);
    const metrics = host.getStatus().preferenceMetrics;
    assert.equal(metrics.evaluated, 3);
    assert.ok(Math.abs(metrics.brier! - (0.25 + 0.25 + 1 / 9) / 3) < 1e-12);
    assert.ok(metrics.brierImprovement! > 0);
    assert.ok(metrics.logLossImprovement! > 0);
    assert.equal(eventRanking(secondId).wantedProbability, 2 / 3); // never recomputed after feedback
    label(firstIds[1], false); // replacement, not another increment
    const replaced = loadProposalPreferences(db, Date.now());
    assert.deepEqual(replaced.preferences.get("inv_clean_test_suite:EPISTEMIC"), { wanted: 1, notWanted: 1 });
    const restarted = WorldModelHost.createIsolatedForTest();
    restarted.setShadowRecorder(new ShadowRecorder(db, { cooldownMs: 0 }));
    assert.deepEqual(restarted.getStatus().preferenceMetrics, host.getStatus().preferenceMetrics);
    const afterRestart = restarted.ingestObservation(observation);
    assert.equal(afterRestart.proposals[0].category, "EPISTEMIC");
    assert.equal(eventRanking(afterRestart.proposals[0].id).wantedProbability, 0.5);
    assert.equal(afterRestart.proposals.find((p) => p.category === "PRAGMATIC")!.estimatedRisk, 0.20);
    const legacy = host.activeInference.generatePolicies([host.activeInference.evaluateObservation(observation)])[0];
    for (const [suffix, ranking] of [
      ["missing", undefined],
      ["invalid", { ...eventRanking(secondId), wantedProbability: 2 }],
      ["post-feedback", { ...eventRanking(secondId), predictedAt: Date.now() + 86_400_000 }],
    ] as const) {
      const policy = { ...legacy, id: `${legacy.id}:${suffix}`, ranking };
      const proposal = host.activeInference.policyToProposal(policy);
      recorder.record(policy, proposal, host.cognitiveGate.evaluateProposal(proposal));
      label(policy.id, true);
    }
    const excluded = loadProposalPreferences(db, Date.now()).metrics;
    assert.equal(excluded.evaluated, 3);
    assert.equal(excluded.excluded, 3);
    assert.equal(excluded.eligibleLabels, 6);
    assert.equal(excluded.predictionCoverage, 0.5);
    assert.equal(excluded.baselineBrier, metrics.baselineBrier);
    assert.equal(excluded.brier, metrics.brier); // same scoring population, no retroactive predictions
  } finally {
    db.close();
  }
});

test("WorldModelHost: ingests telemetry and updates cognitive mode", () => {
  const host = WorldModelHost.getInstance();

  const outcome = host.ingestTelemetry({
    foregroundApp: "com.microsoft.VSCode",
    windowTitle: "sovereign-exocortex/apps/daemon/server.ts",
  });

  assert.equal(outcome.mode, "DEEP_FOCUS");
  assert.equal(host.cognitiveGate.mode, "DEEP_FOCUS");
});

test("WorldModelHost: ingests unexpected observation and stages active inference proposal", () => {
  const host = WorldModelHost.getInstance();

  const anomalyOutcome = host.ingestObservation({
    invariantId: "inv_clean_test_suite",
    observedState: false, // Broken tests anomaly
    observedAt: Date.now(),
    confidence: 1.0,
  });

  assert.equal(anomalyOutcome.isAnomaly, true);
  assert.ok(anomalyOutcome.surprisalNats > 3.0);
  assert.equal(anomalyOutcome.generatedPoliciesCount, 2);
  assert.ok(anomalyOutcome.proposals.length >= 1);
});

test("WorldModelHost: rejects invalid or uncalibrated observations", () => {
  const host = WorldModelHost.getInstance();

  // Unknown invariant ID
  assert.throws(
    () => {
      host.ingestObservation({
        invariantId: "non_existent_invariant",
        observedState: true,
        observedAt: Date.now(),
        confidence: 1.0,
      });
    },
    /unknown invariantId/,
  );

  // Object / non-primitive observedState
  assert.throws(
    () => {
      host.ingestObservation({
        invariantId: "inv_clean_test_suite",
        observedState: { bad: "object" } as unknown as boolean,
        observedAt: Date.now(),
        confidence: 1.0,
      });
    },
    /non-primitive or non-finite observedState/,
  );

  // NaN observedState
  assert.throws(
    () => {
      host.ingestObservation({
        invariantId: "inv_clean_test_suite",
        observedState: NaN,
        observedAt: Date.now(),
        confidence: 1.0,
      });
    },
    /non-primitive or non-finite observedState/,
  );

  // Invalid confidence (> 1 or NaN)
  assert.throws(
    () => {
      host.ingestObservation({
        invariantId: "inv_clean_test_suite",
        observedState: true,
        observedAt: Date.now(),
        confidence: 1.5,
      });
    },
    /confidence must be a finite number between 0 and 1/,
  );

  // Positive controls: string, boolean, finite number
  const outcomeBool = host.ingestObservation({
    invariantId: "inv_clean_test_suite",
    observedState: true,
    observedAt: Date.now(),
    confidence: 0.95,
  });
  assert.equal(typeof outcomeBool.surprisalNats, "number");

  const outcomeStr = host.ingestObservation({
    invariantId: "inv_clean_test_suite",
    observedState: "pass",
    observedAt: Date.now(),
    confidence: 1.0,
  });
  assert.equal(typeof outcomeStr.surprisalNats, "number");

  const outcomeNum = host.ingestObservation({
    invariantId: "inv_clean_test_suite",
    observedState: 0,
    observedAt: Date.now(),
    confidence: 1.0,
  });
  assert.equal(typeof outcomeNum.surprisalNats, "number");
});

test("WorldModelHost: validateSignals strictly enforces types and rejects coerced string booleans or NaN", () => {
  const host = WorldModelHost.createIsolatedForTest();

  // String boolean for inCall must throw TypeError
  assert.throws(
    () => host.ingestTelemetry({ inCall: "false" as any }),
    /invalid telemetry: inCall must be a boolean/,
  );

  // String boolean for networkMetered must throw TypeError
  assert.throws(
    () => host.ingestTelemetry({ networkMetered: "true" as any }),
    /invalid telemetry: networkMetered must be a boolean/,
  );

  // NaN for thermalHeadroom must throw TypeError
  assert.throws(
    () => host.ingestTelemetry({ thermalHeadroom: NaN }),
    /invalid telemetry: thermalHeadroom must be a finite number/,
  );

  // Non-array appTransitions must throw TypeError
  assert.throws(
    () => host.ingestTelemetry({ appTransitions: "bad" as any }),
    /invalid telemetry: appTransitions must be an array/,
  );

  // Non-object clipboardIntent must throw TypeError
  assert.throws(
    () => host.ingestTelemetry({ clipboardIntent: "bad" as any }),
    /invalid telemetry: clipboardIntent must be an object/,
  );

  // Valid signals ingest cleanly
  const result = host.ingestTelemetry({
    inCall: false,
    networkMetered: true,
    thermalHeadroom: 0.85,
    appTransitions: [{ from: "app_a", to: "app_b" }],
    clipboardIntent: { entity_type: "url", value: "https://example.com" },
  });
  assert.ok(result);

  // Null fields (serialized by mobile when unknown) normalize cleanly without throwing
  const nullResult = host.ingestTelemetry({
    inCall: null as any,
    networkMetered: null as any,
    thermalHeadroom: null as any,
    manualOverrideMode: null,
  });
  assert.ok(nullResult);
});


test("WorldModelHost: cold start hydrates learned params when the recorder attaches after construction", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const seeded = WorldModelHost.createIsolatedForTest();
    const recorder = new ShadowRecorder(db, { cooldownMs: 0 });
    recorder.ensureHostDevice();
    seeded.setShadowRecorder(recorder);
    seeded.ingestObservation({ invariantId: "inv_clean_test_suite", observedState: false, confidence: 0.9, observedAt: 1, factor: "repo_health", observation: "tests_fail" } as never);
    seeded.persistBeliefState(1, db);
    const saved = db.listModelParams();
    assert.ok(saved.length > 0, "fixture must persist model params");

    // Constructed with no database open (normal cold start); recorder attaches later.
    const cold = WorldModelHost.createIsolatedForTest();
    const key = (h: WorldModelHost) => JSON.stringify(h.learnedEngine.exportModelParams(0));
    const before = key(cold);
    assert.notEqual(before, key(seeded), "fixture must differ from a fresh engine");
    cold.setShadowRecorder(new ShadowRecorder(db, { cooldownMs: 0 }));
    assert.equal(key(cold), key(seeded), "learned state restored on attach");
  } finally {
    db.close();
  }
});

test("WorldModelHost: self_heal_restore is tier T2 while diagnostic_probe is T0 (spec R10 / row 2.3a)", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const host = WorldModelHost.createIsolatedForTest();
    const recorder = new ShadowRecorder(db, { cooldownMs: 0 });
    recorder.ensureHostDevice();
    host.setShadowRecorder(recorder);

    const executedActions: string[] = [];
    host.setAutoExecutor((_policy, proposal) => {
      executedActions.push(String((proposal.suggestedAction as any)?.command));
    });

    const res = host.ingestObservation({
      invariantId: "inv_clean_test_suite",
      observedState: false,
      observedAt: Date.now(),
      confidence: 1.0,
    });

    assert.equal(res.generatedPoliciesCount, 2);

    const rows = db.raw.prepare("SELECT proposal_id, tier, risk_term, action FROM proposals").all() as Array<{
      proposal_id: string;
      tier: number;
      risk_term: number;
      action: string;
    }>;

    assert.equal(rows.length, 2, "must persist 2 proposals in shadow store");

    const selfHealRow = rows.find((r) => r.action.includes("self_heal_restore"));
    const diagRow = rows.find((r) => r.action.includes("diagnostic_probe"));

    assert.ok(selfHealRow, "must find self_heal_restore proposal");
    assert.ok(diagRow, "must find diagnostic_probe proposal");

    // Tier assertions: self_heal_restore is T2 (writes local graph state), diagnostic_probe is T0 (read-only inspection)
    assert.equal(selfHealRow.tier, 2, "self_heal_restore proposal must be tier T2");
    assert.equal(selfHealRow.risk_term, 0.2, "self_heal_restore estimatedRisk must be 0.20");

    assert.equal(diagRow.tier, 0, "diagnostic_probe proposal must be tier T0");
    assert.equal(diagRow.risk_term, 0.0, "diagnostic_probe estimatedRisk must be 0.0");

    // Assert self_heal_restore is never auto-executed even if SHADOW mode was cleared
    assert.ok(!executedActions.includes("self_heal_restore"), "self_heal_restore must never be auto-executed");
  } finally {
    db.close();
  }
});
