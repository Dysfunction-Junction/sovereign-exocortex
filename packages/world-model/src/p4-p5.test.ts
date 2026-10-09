import { describe, it, expect } from "vitest";
import { LivingLifeGraph } from "./life-graph.js";
import { ActiveInferenceEngine } from "./active-inference.js";
import {
  CognitiveModeGate,
  AUTO_EXECUTE_ALLOWLIST,
  type CognitiveMode,
} from "./cognitive-gate.js";
import { LearnedActiveInferenceEngine } from "./generative-model.js";
import type { EventRecord } from "@exocortex/core";

const ev = (seq: number, payload: Record<string, unknown>): EventRecord => ({
  seq,
  event_id: `e${seq}`,
  device_id: "d",
  kind: "observation",
  ts_device: seq,
  ts_server: seq,
  schema_ver: 1,
  payload: JSON.stringify(payload),
  prev_hash: new Uint8Array(32),
  hash: new Uint8Array(32),
});

describe("P4 self-heal gating", () => {
  const modes: CognitiveMode[] = ["DEEP_FOCUS", "HIGH_VELOCITY_EXECUTION", "MAINTENANCE_SURFACING"];

  it("allowlist excludes self_heal_restore", () => {
    expect(AUTO_EXECUTE_ALLOWLIST.has("self_heal_restore")).toBe(false);
  });

  it("CODE_HEALTH pragmatic self_heal_restore is never SILENT_AUTO_EXECUTE in any mode", () => {
    const eng = new ActiveInferenceEngine(new LivingLifeGraph());
    const m = eng.evaluateObservation({ invariantId: "inv_clean_test_suite", observedState: false, observedAt: 1, confidence: 1 });
    const pragmatic = eng.generatePolicies([m]).find((p) => p.type === "PRAGMATIC")!;
    expect((pragmatic.actionPayload as any).command).toBe("self_heal_restore");
    const prop = eng.policyToProposal(pragmatic);
    for (const mode of modes) {
      const d = new CognitiveModeGate().evaluateProposal(prop, { manualOverrideMode: mode });
      expect(d.action).not.toBe("SILENT_AUTO_EXECUTE");
      expect(d.targetDelivery).not.toBe("SILENT_EXECUTE");
    }
    // High urgency (>= deep-focus cutoff) is surfaced for approval instead.
    const urgent = { ...prop, urgency: 0.9 };
    expect(new CognitiveModeGate().evaluateProposal(urgent, { manualOverrideMode: "DEEP_FOCUS" }).action).toBe("ALLOW_PROMPT");
  });

  it("allowlisted read-only diagnostic_probe still auto-executes (no regression)", () => {
    const eng = new ActiveInferenceEngine(new LivingLifeGraph());
    const m = eng.evaluateObservation({ invariantId: "inv_clean_test_suite", observedState: false, observedAt: 1, confidence: 1 });
    const epistemic = eng.generatePolicies([m]).find((p) => p.type === "EPISTEMIC")!;
    const d = new CognitiveModeGate().evaluateProposal(eng.policyToProposal(epistemic), { manualOverrideMode: "MAINTENANCE_SURFACING" });
    expect(d.action).toBe("SILENT_AUTO_EXECUTE");
  });

  it("an unknown or malformed action command fails closed", () => {
    const base = { id: "p", candidateId: "c", summary: "s", urgency: 0.1, confidence: 0.99, estimatedRisk: 0 };
    const sig = { manualOverrideMode: "MAINTENANCE_SURFACING" as const };
    expect(new CognitiveModeGate().evaluateProposal({ ...base, suggestedAction: { command: "rm_rf" } }, sig).action).not.toBe("SILENT_AUTO_EXECUTE");
    expect(new CognitiveModeGate().evaluateProposal({ ...base, suggestedAction: { command: 42 } }, sig).action).not.toBe("SILENT_AUTO_EXECUTE");
    expect(new CognitiveModeGate().evaluateProposal({ ...base, suggestedAction: {} }, sig).action).not.toBe("SILENT_AUTO_EXECUTE");
  });
});

describe("P5 totalSurprisal accumulation", () => {
  const log = [
    ev(1, { factor: "user_mode", observation: "typing_burst" }),
    ev(2, { factor: "repo_health", observation: "tests_fail" }),
    ev(3, { factor: "user_mode", observation: "idle_long" }),
    ev(4, { factor: "link_health", observation: "ws_dropped" }),
  ];

  it("accumulates per-step surprisal into snapshots (monotone, equals sum of steps)", () => {
    const eng = new LearnedActiveInferenceEngine();
    expect(eng.createBeliefSnapshot(0).surprisal).toBe(0);
    let sum = 0;
    let prev = 0;
    for (const [f, o] of [["user_mode", "typing_burst"], ["repo_health", "tests_fail"], ["link_health", "ws_dropped"]]) {
      const r = eng.processObservation(f, o);
      sum += r.surprisalNats;
      const snap = eng.createBeliefSnapshot(1).surprisal;
      expect(snap).toBeGreaterThan(prev);
      prev = snap;
    }
    expect(prev).toBeCloseTo(sum, 2); // per-step values are rounded to 3 dp in the return value
  });

  it("is deterministic across two replays of the same log", () => {
    const a = new LearnedActiveInferenceEngine().replayEventStream(log);
    const b = new LearnedActiveInferenceEngine().replayEventStream(log);
    expect(a.snapshots.map((s) => s.surprisal)).toEqual(b.snapshots.map((s) => s.surprisal));
    expect(a.snapshots[3].surprisal).toBeGreaterThan(0);
    expect(a.snapshots[3].surprisal).toBeGreaterThan(a.snapshots[0].surprisal);
  });

  it("hydrateFromSnapshot restores the accumulator and replay continues from it", () => {
    const first = new LearnedActiveInferenceEngine();
    first.replayEventStream(log.slice(0, 2));
    const snap = first.createBeliefSnapshot(2);
    expect(snap.surprisal).toBeGreaterThan(0);
    const resumed = new LearnedActiveInferenceEngine();
    resumed.hydrateFromSnapshot(snap);
    expect(resumed.createBeliefSnapshot(2).surprisal).toBe(snap.surprisal);
    resumed.processObservation("user_mode", "idle_long");
    expect(resumed.createBeliefSnapshot(3).surprisal).toBeGreaterThan(snap.surprisal);
  });

  it("ignores non-finite / negative surprisal steps and bad hydrate values", () => {
    const eng = new LearnedActiveInferenceEngine();
    const factor = eng.getFactor("user_mode")!;
    const real = factor.updateBelief.bind(factor);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      (factor as any).updateBelief = (...args: any[]) => ({ ...(real as any)(...args), surprisalNats: bad });
      eng.processObservation("user_mode", "typing_burst");
      const s = eng.createBeliefSnapshot(1).surprisal;
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBe(0);
    }
    const h = new LearnedActiveInferenceEngine();
    for (const bad of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      h.hydrateFromSnapshot({ as_of_seq: 1, mode: "DEEP_FOCUS", q: "{}", surprisal: bad as number });
      expect(h.createBeliefSnapshot(1).surprisal).toBe(0);
    }
  });
});
