import test from "node:test";
import assert from "node:assert/strict";
import { WorldModelHost } from "./world-model-host.js";

test("D1: ingestTelemetry rejects invalid signals and leaves cognitive mode and lastSignals unchanged", () => {
  const host = WorldModelHost.getInstance();
  host.ingestTelemetry({ foregroundApp: "com.microsoft.VSCode", windowTitle: "x" });
  const before = host.cognitiveGate.mode;
  assert.equal(before, "DEEP_FOCUS");

  const bad: unknown[] = [
    { foregroundApp: 123, manualOverrideMode: "REST_RECOVERY" },
    { windowTitle: { a: 1 }, manualOverrideMode: "REST_RECOVERY" },
    { hourOfDay: "3", manualOverrideMode: "REST_RECOVERY" },
    { screenState: "SIDEWAYS", manualOverrideMode: "REST_RECOVERY" },
    { idleDurationMs: Number.NaN, manualOverrideMode: "REST_RECOVERY" },
    null,
    "string",
  ];
  for (const signals of bad) {
    assert.throws(() => host.ingestTelemetry(signals as never), TypeError, JSON.stringify(signals));
    assert.equal(host.cognitiveGate.mode, before, `mode mutated by ${JSON.stringify(signals)}`);
  }
});
