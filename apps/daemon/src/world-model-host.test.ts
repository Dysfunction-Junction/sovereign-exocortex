import test from "node:test";
import assert from "node:assert/strict";
import { defaultWorldModelHost, WorldModelHost } from "./world-model-host.js";

test("WorldModelHost: singleton initialization and seeded ecosystem graph", () => {
  const host = defaultWorldModelHost;
  const status = host.getStatus();

  assert.ok(status.entityCount >= 7, `Expected >= 7 entities, got ${status.entityCount}`);
  assert.ok(status.edgeCount >= 5, `Expected >= 5 edges, got ${status.edgeCount}`);
  assert.equal(status.registeredInvariantsCount >= 5, true);
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


