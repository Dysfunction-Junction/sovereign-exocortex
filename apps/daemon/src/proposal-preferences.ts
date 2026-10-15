import type { ExocortexDatabase } from "@exocortex/core/db";
import { DEFAULT_INVARIANTS, preferenceKey, type PolicyPreference } from "@exocortex/world-model";
import { HOST_DEVICE_ID } from "./shadow-recorder.js";

export interface PreferenceMetrics {
  baseline: "fixed-0.5";
  eligibleLabels: number;
  evaluated: number;
  excluded: number;
  predictionCoverage: number | null;
  brier: number | null;
  baselineBrier: number | null;
  brierImprovement: number | null;
  logLoss: number | null;
  baselineLogLoss: number | null;
  logLossImprovement: number | null;
}

/** Rebuild from replaceable authoritative rows, never increment from ledger deliveries. */
export function loadProposalPreferences(db: ExocortexDatabase | null, asOfMs: number): {
  preferences: Map<string, PolicyPreference>;
  metrics: PreferenceMetrics;
} {
  const preferences = new Map<string, PolicyPreference>();
  const metrics: PreferenceMetrics = {
    baseline: "fixed-0.5", eligibleLabels: 0, evaluated: 0, excluded: 0, predictionCoverage: null,
    brier: null, baselineBrier: null, brierImprovement: null,
    logLoss: null, baselineLogLoss: null, logLossImprovement: null,
  };
  let brier = 0;
  let logLoss = 0;
  if (!db) return { preferences, metrics };
  for (const label of db.getShadowLabels()) {
    try {
      if (label.label !== "wanted" && label.label !== "not_wanted") continue;
      if (JSON.parse(label.actual ?? "null")?.source !== "tap" || !Number.isFinite(label.ts) || label.ts > asOfMs) continue;
      const proposal = db.getProposal(label.proposal_id);
      if (!proposal || proposal.shadow !== 1 || !["PRAGMATIC", "EPISTEMIC"].includes(proposal.policy_type)) continue;
      const event = db.getEventBySeq(proposal.created_seq);
      if (!event || event.kind !== "proposal" || event.device_id !== HOST_DEVICE_ID
        || event.ts_server > label.ts) continue;
      const payload = JSON.parse(event.payload);
      const action = JSON.parse(proposal.action);
      const invariantId = proposal.invariant_id ?? action.invariantId;
      if (!DEFAULT_INVARIANTS.some((i) => i.id === invariantId)
        || payload.proposal_id !== proposal.proposal_id || payload.invariant_id !== invariantId
        || payload.policy_type !== proposal.policy_type
        || action.command !== (proposal.policy_type === "PRAGMATIC" ? "self_heal_restore" : "diagnostic_probe")) continue;
      const key = preferenceKey(invariantId, proposal.policy_type);
      const counts = preferences.get(key) ?? { wanted: 0, notWanted: 0 };
      if (label.label === "wanted") counts.wanted++;
      else counts.notWanted++;
      preferences.set(key, counts);
      metrics.eligibleLabels++;
      const ranking = payload.ranking;
      const probability = ranking?.wantedProbability;
      if (ranking?.version !== 1 || ranking.baselinePredictor !== "fixed-0.5"
        || ranking.baselineWantedProbability !== 0.5
        || typeof probability !== "number" || !Number.isFinite(probability) || probability <= 0 || probability >= 1
        || typeof ranking.predictedAt !== "number" || !Number.isFinite(ranking.predictedAt)
        || ranking.predictedAt > event.ts_server || ranking.predictedAt > label.ts) {
        metrics.excluded++;
        continue;
      }
      const outcome = label.label === "wanted" ? 1 : 0;
      brier += (probability - outcome) ** 2;
      logLoss -= Math.log(outcome ? probability : 1 - probability);
      metrics.evaluated++;
    } catch {
      // Malformed historical rows cannot train or score the projection.
    }
  }
  if (metrics.eligibleLabels > 0) metrics.predictionCoverage = metrics.evaluated / metrics.eligibleLabels;
  if (metrics.evaluated > 0) {
    metrics.brier = brier / metrics.evaluated;
    metrics.baselineBrier = 0.25;
    metrics.brierImprovement = 0.25 - metrics.brier;
    metrics.logLoss = logLoss / metrics.evaluated;
    metrics.baselineLogLoss = Math.log(2);
    metrics.logLossImprovement = Math.log(2) - metrics.logLoss;
  }
  return { preferences, metrics };
}
