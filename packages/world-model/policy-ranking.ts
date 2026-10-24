import type { InferencePolicy } from "./active-inference.js";
import type { LearnedActiveInferenceEngine, EFEPolicyEvaluation } from "./generative-model.js";
import type { LivingLifeGraph } from "./life-graph.js";
import type { CognitiveMode } from "./cognitive-gate.js";

export interface PolicyPreference {
  wanted: number;
  notWanted: number;
}

export interface ContextualPreferenceContext {
  mode?: CognitiveMode | string;
  daypart?: "morning" | "afternoon" | "evening" | "night" | string;
}

export function preferenceKey(invariantId: string, policyType: string): string {
  return `${invariantId}:${policyType}`;
}

export function contextualPreferenceKey(
  invariantId: string,
  policyType: string,
  ctx?: ContextualPreferenceContext,
): string {
  const base = preferenceKey(invariantId, policyType);
  if (!ctx?.mode && !ctx?.daypart) return base;
  const mode = ctx.mode ?? "ANY_MODE";
  const daypart = ctx.daypart ?? "any_daypart";
  return `${base}|mode=${mode}|daypart=${daypart}`;
}

export function computeWantedProbability(
  preferences: ReadonlyMap<string, PolicyPreference>,
  invariantId: string,
  policyType: string,
  ctx?: ContextualPreferenceContext,
): { wantedProbability: number; samples: number } {
  const baseKey = preferenceKey(invariantId, policyType);
  const globalPref = preferences.get(baseKey);
  const globalWanted = globalPref?.wanted ?? 0;
  const globalNotWanted = globalPref?.notWanted ?? 0;
  const samples = globalWanted + globalNotWanted;

  const c0 = 2.0;
  const bGlobal = (globalWanted + c0 * 0.5) / (samples + c0);

  if (!ctx?.mode && !ctx?.daypart) {
    return { wantedProbability: clampProb(bGlobal), samples };
  }

  const fullKey = contextualPreferenceKey(invariantId, policyType, ctx);
  const modeOnlyKey = contextualPreferenceKey(invariantId, policyType, { mode: ctx.mode });

  const localPref = preferences.get(fullKey) ?? preferences.get(modeOnlyKey);
  if (!localPref || (localPref.wanted + localPref.notWanted) === 0) {
    return { wantedProbability: clampProb(bGlobal), samples };
  }

  const localWanted = localPref.wanted;
  const localNotWanted = localPref.notWanted;
  const localSamples = localWanted + localNotWanted;

  const c1 = 3.0;
  const posteriorMean = (localWanted + c1 * bGlobal) / (localSamples + c1);

  return { wantedProbability: clampProb(posteriorMean), samples };
}

export function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(0.995, Math.max(0.005, p));
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
  context?: ContextualPreferenceContext,
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
    const { wantedProbability, samples } = computeWantedProbability(
      preferences,
      policy.invariantId,
      policy.type,
      context,
    );
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
