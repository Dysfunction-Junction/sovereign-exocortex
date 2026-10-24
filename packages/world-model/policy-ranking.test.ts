import { describe, it, expect } from "vitest";
import {
  preferenceKey,
  contextualPreferenceKey,
  computeWantedProbability,
  rankInferencePolicies,
  type PolicyPreference,
} from "./policy-ranking.js";
import { LearnedActiveInferenceEngine } from "./generative-model.js";
import { LivingLifeGraph } from "./life-graph.js";
import type { InferencePolicy } from "./active-inference.js";

describe("Hierarchical Beta-Bernoulli Preference Ranking", () => {
  it("maintains backward compatibility with global keys when context is omitted", () => {
    const prefs = new Map<string, PolicyPreference>([
      [preferenceKey("inv_clean_test_suite", "PRAGMATIC"), { wanted: 4, notWanted: 1 }],
    ]);

    const result = computeWantedProbability(prefs, "inv_clean_test_suite", "PRAGMATIC");
    // global samples = 5. c0 = 2.0. bGlobal = (4 + 1) / (5 + 2) = 5/7 ~= 0.7142857
    expect(result.samples).toBe(5);
    expect(result.wantedProbability).toBeCloseTo(5 / 7, 5);
  });

  it("falls back to global prior when context has no local observations", () => {
    const prefs = new Map<string, PolicyPreference>([
      [preferenceKey("inv_clean_test_suite", "PRAGMATIC"), { wanted: 8, notWanted: 2 }],
    ]);

    const result = computeWantedProbability(prefs, "inv_clean_test_suite", "PRAGMATIC", {
      mode: "DEEP_FOCUS",
      daypart: "morning",
    });
    // bGlobal = (8 + 1) / (10 + 2) = 9/12 = 0.75
    expect(result.samples).toBe(10);
    expect(result.wantedProbability).toBeCloseTo(0.75, 5);
  });

  it("performs hierarchical empirical Bayes shrinkage when local observations exist", () => {
    const baseKey = preferenceKey("inv_clean_test_suite", "PRAGMATIC");
    const ctx = { mode: "DEEP_FOCUS", daypart: "morning" };
    const fullKey = contextualPreferenceKey("inv_clean_test_suite", "PRAGMATIC", ctx);

    // Global: 10 wanted, 10 not wanted -> bGlobal = (10 + 1)/(20 + 2) = 11/22 = 0.5
    // Local: 2 wanted, 0 not wanted -> localSamples = 2
    // With c1 = 3.0: posteriorMean = (2 + 3 * 0.5) / (2 + 3) = 3.5 / 5 = 0.7
    const prefs = new Map<string, PolicyPreference>([
      [baseKey, { wanted: 10, notWanted: 10 }],
      [fullKey, { wanted: 2, notWanted: 0 }],
    ]);

    const result = computeWantedProbability(prefs, "inv_clean_test_suite", "PRAGMATIC", ctx);
    expect(result.wantedProbability).toBeCloseTo(0.7, 5);
  });

  it("falls back to mode-only key when full daypart key is absent", () => {
    const baseKey = preferenceKey("inv_zero_broken_commits", "EPISTEMIC");
    const modeKey = contextualPreferenceKey("inv_zero_broken_commits", "EPISTEMIC", { mode: "REST_RECOVERY" });

    // Global: bGlobal = (0 + 1) / (0 + 2) = 0.5
    // Local (mode-only): 0 wanted, 5 not wanted -> localSamples = 5
    // posteriorMean = (0 + 3 * 0.5) / (5 + 3) = 1.5 / 8 = 0.1875
    const prefs = new Map<string, PolicyPreference>([
      [modeKey, { wanted: 0, notWanted: 5 }],
    ]);

    const result = computeWantedProbability(prefs, "inv_zero_broken_commits", "EPISTEMIC", {
      mode: "REST_RECOVERY",
      daypart: "evening",
    });
    expect(result.wantedProbability).toBeCloseTo(0.1875, 5);
  });

  it("clamps probabilities strictly within [0.005, 0.995]", () => {
    const baseKey = preferenceKey("inv_clean_test_suite", "PRAGMATIC");
    const prefs = new Map<string, PolicyPreference>([
      [baseKey, { wanted: 1000, notWanted: 0 }],
    ]);

    const result = computeWantedProbability(prefs, "inv_clean_test_suite", "PRAGMATIC");
    expect(result.wantedProbability).toBeLessThanOrEqual(0.995);
  });

  it("context shifts policy rankings in rankInferencePolicies", () => {
    const engine = new LearnedActiveInferenceEngine();
    const graph = new LivingLifeGraph();
    const now = Date.now();

    const policyA: InferencePolicy = {
      id: "pol-1",
      invariantId: "inv_clean_test_suite",
      type: "PRAGMATIC",
      description: "pragmatic",
      expectedFreeEnergyScore: 10,
      targetEntityId: "ent-1",
      actionPayload: { command: "self_heal_restore" },
    };

    const policyB: InferencePolicy = {
      id: "pol-2",
      invariantId: "inv_zero_broken_commits",
      type: "PRAGMATIC",
      description: "pragmatic b",
      expectedFreeEnergyScore: 10,
      targetEntityId: "ent-2",
      actionPayload: { command: "self_heal_restore" },
    };

    const baseKeyA = preferenceKey("inv_clean_test_suite", "PRAGMATIC");
    const baseKeyB = preferenceKey("inv_zero_broken_commits", "PRAGMATIC");
    const ctxMorning = { mode: "DEEP_FOCUS", daypart: "morning" };
    const morningKeyB = contextualPreferenceKey("inv_zero_broken_commits", "PRAGMATIC", ctxMorning);

    // Globally A is preferred (wanted 10 vs 2)
    // But in DEEP_FOCUS morning, B has strong local preference (wanted 10 vs 0)
    const prefs = new Map<string, PolicyPreference>([
      [baseKeyA, { wanted: 10, notWanted: 2 }],
      [baseKeyB, { wanted: 2, notWanted: 10 }],
      [morningKeyB, { wanted: 20, notWanted: 0 }],
    ]);

    // Without context: policyA ranks higher
    const rankedGlobal = rankInferencePolicies([policyA, policyB], engine, graph, prefs, now, now);
    expect(rankedGlobal[0].id).toBe("pol-1");

    // With context: policyB ranks higher due to contextual shrinkage
    const rankedContext = rankInferencePolicies([policyA, policyB], engine, graph, prefs, now, now, ctxMorning);
    expect(rankedContext[0].id).toBe("pol-2");
  });
});
