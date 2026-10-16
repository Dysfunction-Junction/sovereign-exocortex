import type { InferencePolicy } from "./active-inference.js";
import type { LearnedActiveInferenceEngine, EFEPolicyEvaluation } from "./generative-model.js";
import type { LivingLifeGraph } from "./life-graph.js";

export interface PolicyPreference {
  wanted: number;
  notWanted: number;
}

export function preferenceKey(invariantId: string, policyType: string): string {
  return `${invariantId}:${policyType}`;
}

/** Model action names are planning analogues, never executable commands. */
const MODEL_ACTIONS: Record<string, { factor: string; action: string; command: string }> = {
  "inv_clean_test_suite:PRAGMATIC": { factor: "repo_health", action: "self_heal_patch", command: "self_heal_restore" },
  "inv_clean_test_suite:EPISTEMIC": { factor: "repo_health", action: "run_diagnostics", command: "diagnostic_probe" },
  "inv_zero_broken_commits:PRAGMATIC": { factor: "repo_health", action: "self_heal_patch", command: "self_heal_restore" },
  "inv_zero_broken_commits:EPISTEMIC": { factor: "repo_health", action: "run_diagnostics", command: "diagnostic_probe" },
  "inv_bridge_connected:PRAGMATIC": { factor: "link_health", action: "reconnect_ws", command: "self_heal_restore" },
};

function modelAction(policy: InferencePolicy): { factor: string; action: string } | null {
  const key = preferenceKey(policy.invariantId, policy.type);
  const mapping = Object.hasOwn(MODEL_ACTIONS, key) ? MODEL_ACTIONS[key] : undefined;
  // No diagnostic link action exists; do not substitute no_op or another command.
  return mapping && policy.actionPayload.command === mapping.command
    ? { factor: mapping.factor, action: mapping.action } : null;
}

export function rankInferencePolicies(
  policies: InferencePolicy[],
  engine: LearnedActiveInferenceEngine,
  graph: LivingLifeGraph,
  preferences: ReadonlyMap<string, PolicyPreference>,
  observedAt: number,
  predictedAt: number,
): InferencePolicy[] {
  graph.decay(observedAt);
  const ranked = policies.map((policy, index) => {
    const mapping = modelAction(policy);
    let evaluation: EFEPolicyEvaluation | undefined;
    try {
      const factor = mapping && engine.getFactor(mapping.factor);
      if (factor && factor.version > 1) {
        const values = [...factor.aCounts.flat(), ...factor.bCounts.flat(2), ...factor.dCounts, ...factor.currentBelief];
        if (values.every((v) => Number.isFinite(v) && v >= 0) && factor.cPreferences.every(Number.isFinite)) {
          evaluation = factor.evaluatePolicies(factor.currentBelief).find((e) => e.actionName === mapping.action);
          if (evaluation && ![evaluation.expectedFreeEnergy, evaluation.riskTerm, evaluation.ambiguityTerm].every(Number.isFinite)) {
            evaluation = undefined;
          }
        }
      }
    } catch {
      // A damaged/unavailable model must leave deterministic baseline ordering intact.
    }
    const preference = preferences.get(preferenceKey(policy.invariantId, policy.type));
    const samples = preference ? preference.wanted + preference.notWanted : 0;
    const wantedProbability = preference ? (1 + preference.wanted) / (2 + samples) : 0.5;
    const associations = [...graph.spreadActivation(
      [policy.targetEntityId], graph.getEntity(policy.targetEntityId)?.activation ?? 0, 0.6, 2, 128,
    )].filter(([id]) => id !== policy.targetEntityId)
      .map(([entityId, activation]) => ({ entityId, activation }))
      .sort((a, b) => b.activation - a.activation || a.entityId.localeCompare(b.entityId));
    return {
      policy: {
        ...policy,
        ranking: {
          version: 1 as const, method: "baseline" as "baseline" | "learned",
          baselineScore: policy.expectedFreeEnergyScore,
          wantedProbability, baselineWantedProbability: 0.5, baselinePredictor: "fixed-0.5" as const,
          preferenceSamples: samples, predictedAt, associations,
          ...(evaluation && mapping ? {
            ...mapping, expectedFreeEnergy: evaluation.expectedFreeEnergy,
            riskTerm: evaluation.riskTerm, ambiguityTerm: evaluation.ambiguityTerm,
          } : {}),
        },
      },
      index, evaluation, samples, wantedProbability,
    };
  });
  // Compare the same candidates on the same scale, or fall back as a whole.
  const useEFE = ranked.length > 1 && ranked.every((r) => r.evaluation !== undefined)
    && new Set(ranked.map((r) => r.evaluation!.expectedFreeEnergy)).size > 1;
  const usePreference = ranked.some((r) => r.samples > 0)
    && new Set(ranked.map((r) => r.wantedProbability)).size > 1;
  if (useEFE || usePreference) {
    for (const r of ranked) r.policy.ranking.method = "learned";
    ranked.sort((a, b) => {
      const score = (r: typeof a) => (useEFE ? r.evaluation!.expectedFreeEnergy : 0)
        - (usePreference ? Math.log(r.wantedProbability) : 0);
      return score(a) - score(b) || a.index - b.index;
    });
  }
  const batchId = ranked[0]?.policy.id;
  return ranked.map((r, position) => ({
    ...r.policy, ranking: { ...r.policy.ranking, batchId, position },
  }));
}
