import { describe, it, expect } from "vitest";
import { LivingLifeGraph } from "./life-graph.js";
import { ActiveInferenceEngine } from "./active-inference.js";
import { CognitiveModeGate, MAX_QUEUED_PROPOSALS, type ProposalEnvelope } from "./cognitive-gate.js";
import { LearnedActiveInferenceEngine } from "./generative-model.js";
import type { EventRecord } from "@exocortex/core";

const DAY = 24 * 60 * 60 * 1000;

const proposal = (over: Partial<ProposalEnvelope> = {}): ProposalEnvelope => ({
  id: "p",
  candidateId: "c",
  summary: "s",
  urgency: 0.1,
  confidence: 0.95,
  estimatedRisk: 0.05,
  ...over,
});

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

describe("audit regressions (world-model)", () => {
  it("LivingLifeGraph.decay does not compound when called repeatedly at the same time", () => {
    const g = new LivingLifeGraph();
    const e = g.addEntity({ id: "a", name: "a", type: "TOPIC", activation: 1, lastActive: 0 });
    g.addEntity({ id: "b", name: "b", type: "TOPIC" });
    g.addEdge("a", "b", "TRIGGERS", 1.0, 30);
    const t = 7 * DAY;
    g.decay(t);
    const once = e.activation;
    g.decay(t);
    g.decay(t + 1000);
    expect(g.getEntity("a")!.activation).toBeCloseTo(once, 3);
    expect(once).toBeCloseTo(0.5, 2);
  });

  it("LivingLifeGraph.addEdge sanitizes NaN weight and non-positive half-life", () => {
    const g = new LivingLifeGraph();
    g.addEntity({ id: "a", name: "a", type: "TOPIC" });
    g.addEntity({ id: "b", name: "b", type: "TOPIC" });
    const edge = g.addEdge("a", "b", "TRIGGERS", Number.NaN, -5);
    expect(edge.weight).toBe(0);
    expect(edge.halfLifeDays).toBe(30);
    expect(g.addEdge("a", "b", "BLOCKS", -3).weight).toBe(0);
  });

  it("ActiveInferenceEngine does not retain observations for unknown invariants", () => {
    const eng = new ActiveInferenceEngine(new LivingLifeGraph());
    for (let i = 0; i < 50; i++) {
      eng.evaluateObservation({ invariantId: `bogus_${i}`, observedState: true, observedAt: i, confidence: 1 });
    }
    expect((eng as any).lastObservations.size).toBe(0);
  });

  it("ActiveInferenceEngine produces finite surprisal for invalid priorProbability", () => {
    const eng = new ActiveInferenceEngine(new LivingLifeGraph());
    eng.registerInvariant({
      id: "zero_prior",
      name: "z",
      targetEntityId: "x",
      preferredState: true,
      priorProbability: 0,
      toleranceThreshold: 0.5,
      category: "CODE_HEALTH",
    });
    const m = eng.evaluateObservation({ invariantId: "zero_prior", observedState: true, observedAt: 1, confidence: 1 });
    expect(Number.isFinite(m.surprisalNats)).toBe(true);
  });

  it("ActiveInferenceEngine generates unique policy ids for same-millisecond duplicates", () => {
    const eng = new ActiveInferenceEngine(new LivingLifeGraph());
    const m = eng.evaluateObservation({ invariantId: "inv_clean_test_suite", observedState: false, observedAt: 1, confidence: 1 });
    const policies = eng.generatePolicies([m, m, m]);
    const ids = policies.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("CognitiveModeGate never auto-executes on out-of-range confidence/risk", () => {
    const gate = new CognitiveModeGate();
    const sig = { manualOverrideMode: "MAINTENANCE_SURFACING" as const };
    expect(gate.evaluateProposal(proposal({ estimatedRisk: -1 }), sig).action).not.toBe("SILENT_AUTO_EXECUTE");
    expect(gate.evaluateProposal(proposal({ confidence: Number.POSITIVE_INFINITY }), sig).action).not.toBe("SILENT_AUTO_EXECUTE");
    expect(gate.evaluateProposal(proposal({ estimatedRisk: Number.NaN }), sig).action).not.toBe("SILENT_AUTO_EXECUTE");
    expect(gate.evaluateProposal(proposal(), sig).action).toBe("SILENT_AUTO_EXECUTE");
  });

  it("CognitiveModeGate ignores an invalid manual override and always returns a decision", () => {
    const gate = new CognitiveModeGate();
    const d = gate.evaluateProposal(proposal(), { manualOverrideMode: "BOGUS" as any, foregroundApp: "code" });
    expect(d).toBeDefined();
    expect(d.mode).toBe("DEEP_FOCUS");
  });

  it("CognitiveModeGate bounds the suppressed queue", () => {
    const gate = new CognitiveModeGate();
    const sig = { manualOverrideMode: "REST_RECOVERY" as const };
    for (let i = 0; i < MAX_QUEUED_PROPOSALS + 50; i++) {
      gate.evaluateProposal(proposal({ id: `p${i}`, confidence: 0.1 }), sig);
    }
    expect(gate.queueSize).toBe(MAX_QUEUED_PROPOSALS);
    expect(gate.getPendingQueue()[MAX_QUEUED_PROPOSALS - 1].id).toBe(`p${MAX_QUEUED_PROPOSALS + 49}`);
  });

  it("replayEventStream skips poison events instead of aborting the whole replay", () => {
    const eng = new LearnedActiveInferenceEngine();
    const res = eng.replayEventStream([
      ev(1, { factor: "user_mode", observation: "typing_burst" }),
      ev(2, { factor: "user_mode", observation: "NOT_AN_OBSERVATION" }),
      ev(3, { factor: "user_mode", observation: "typing_burst", action: "NOT_AN_ACTION" }),
      ev(4, { factor: "user_mode", observation: "test_running" }),
    ]);
    expect(res.replayedCount).toBe(4);
    expect(res.snapshots).toHaveLength(4);
  });

  it("importModelParams rejects malformed or non-finite tables", () => {
    const eng = new LearnedActiveInferenceEngine();
    const before = JSON.stringify(eng.getFactor("user_mode")!.aCounts);
    eng.importModelParams([
      { factor: "user_mode", kind: "A", version: 9, counts: "[[1,2],[3,4]]", as_of_seq: 1 },
      { factor: "user_mode", kind: "D", version: 9, counts: "[1,1,1,1,-1]", as_of_seq: 1 },
    ]);
    const f = eng.getFactor("user_mode")!;
    expect(JSON.stringify(f.aCounts)).toBe(before);
    expect(f.dCounts.every((v) => v >= 0)).toBe(true);
    expect(f.version).toBe(1);
    expect(() => eng.processObservation("user_mode", "typing_burst")).not.toThrow();
  });

  it("hydrateFromSnapshot ignores negative / non-finite belief values", () => {
    const eng = new LearnedActiveInferenceEngine();
    const f = eng.getFactor("user_mode")!;
    const before = [...f.currentBelief];
    eng.hydrateFromSnapshot({
      as_of_seq: 1,
      mode: "DEEP_FOCUS",
      q: JSON.stringify({ user_mode: { DEEP_FOCUS: -1, HIGH_VELOCITY: 3 } }),
      surprisal: 0,
    });
    expect(f.currentBelief).toEqual(before);
  });
});
