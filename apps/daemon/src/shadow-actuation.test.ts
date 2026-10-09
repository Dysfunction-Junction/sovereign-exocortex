import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GateDecision, ProposalEnvelope } from "@exocortex/world-model";
import { mayActuateAutoExecute } from "./shadow-recorder.js";
import { WorldModelHost } from "./world-model-host.js";

function gate(action: GateDecision["action"] = "SILENT_AUTO_EXECUTE"): GateDecision {
  return { action, mode: "MAINTENANCE_SURFACING", reason: "r", targetDelivery: "SILENT_EXECUTE", confidence: 0.99, evaluatedAt: 1 };
}
function prop(command?: unknown): ProposalEnvelope {
  return {
    id: "p", candidateId: "c", summary: "s", urgency: 0.1, confidence: 0.99, estimatedRisk: 0,
    suggestedAction: command === undefined ? undefined : { command },
  };
}
const clear = { isCircuitBreakerTripped: () => false };
const tripped = { isCircuitBreakerTripped: () => true };
const broken = { isCircuitBreakerTripped: () => { throw new Error("db down"); } };

describe("mayActuateAutoExecute (executor-side shadow re-check)", () => {
  it("actuates only with SHADOW=0, a clear breaker and an allowlisted action", () => {
    assert.equal(mayActuateAutoExecute(gate(), prop("diagnostic_probe"), clear, { SHADOW: "0" }), true);
  });
  it("never actuates while SHADOW is on, unset or anything but 0", () => {
    for (const shadow of [undefined, "1", "", "true"]) {
      assert.equal(mayActuateAutoExecute(gate(), prop("diagnostic_probe"), clear, { SHADOW: shadow }), false);
    }
  });
  it("never actuates when the breaker is tripped, unreadable or the db is missing", () => {
    assert.equal(mayActuateAutoExecute(gate(), prop("diagnostic_probe"), tripped, { SHADOW: "0" }), false);
    assert.equal(mayActuateAutoExecute(gate(), prop("diagnostic_probe"), broken, { SHADOW: "0" }), false);
    assert.equal(mayActuateAutoExecute(gate(), prop("diagnostic_probe"), null, { SHADOW: "0" }), false);
  });
  it("never actuates a non-allowlisted command or a non-auto decision", () => {
    assert.equal(mayActuateAutoExecute(gate(), prop("self_heal_restore"), clear, { SHADOW: "0" }), false);
    assert.equal(mayActuateAutoExecute(gate("ALLOW_PROMPT"), prop("diagnostic_probe"), clear, { SHADOW: "0" }), false);
  });
});

describe("WorldModelHost auto-executor wiring", () => {
  it("self_heal_restore is never handed to the executor, even with SHADOW=0", () => {
    const prev = process.env.SHADOW;
    process.env.SHADOW = "0";
    const host = WorldModelHost.getInstance();
    const calls: string[] = [];
    host.setAutoExecutor((_p, proposal) => calls.push(String((proposal.suggestedAction as any)?.command)));
    try {
      host.cognitiveGate.classifyMode({ manualOverrideMode: "MAINTENANCE_SURFACING" });
      host.ingestObservation({ invariantId: "inv_clean_test_suite", observedState: false, observedAt: Date.now(), confidence: 1 });
      assert.ok(!calls.includes("self_heal_restore"), `executor received ${calls.join(",")}`);
    } finally {
      host.setAutoExecutor(null);
      if (prev === undefined) delete process.env.SHADOW; else process.env.SHADOW = prev;
    }
  });
});
