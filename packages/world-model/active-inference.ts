/**
 * @file active-inference.ts
 * Pillar 3 of the Magic Piece: The Active Inference Engine.
 * 
 * Implements Karl Friston's Free Energy Principle for autonomous personal computing.
 * Rather than pure reactive pattern matching, the Active Inference Loop:
 * 1. Maintains homeostatic prior preferences over system and human states.
 * 2. Ingests multimodal observations and computes variational surprisal (-ln P(o|m)).
 * 3. Minimizes Expected Free Energy (EFE) via dual pathways:
 *    - Pragmatic Value: Goal-directed actions restoring preferred invariants.
 *    - Epistemic Value: Information-seeking actions resolving entropy/uncertainty.
 * 4. Integrates with the Living Life Graph to propagate belief updates and predict cascades.
 */

import { LivingLifeGraph, type GraphEntity, type RelationType } from './life-graph.js';
import type { ProposalEnvelope } from './cognitive-gate.js';

export interface SystemInvariant {
  id: string;
  name: string;
  targetEntityId: string;
  preferredState: string | number | boolean;
  priorProbability: number; // e.g. 0.99 (high confidence expectation)
  toleranceThreshold: number; // 0.0 to 1.0 (acceptable deviation)
  category: 'CODE_HEALTH' | 'HARDWARE_LINK' | 'FAMILY_HOME' | 'PROJECT_GOAL';
}

export interface SystemObservation {
  invariantId: string;
  observedState: string | number | boolean;
  observedAt: number;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface SurprisalMetric {
  invariantId: string;
  observedState: string | number | boolean;
  preferredState: string | number | boolean;
  surprisalNats: number; // -ln P(o)
  isAnomaly: boolean;
  divergence: number; // 0.0 to 1.0
}

export type PolicyType = 'PRAGMATIC' | 'EPISTEMIC';

export interface PolicyRankingMetadata {
  version: 1;
  method: "baseline" | "learned";
  baselineScore: number;
  wantedProbability: number;
  baselineWantedProbability: number;
  baselinePredictor: "fixed-0.5";
  preferenceSamples: number;
  predictedAt: number;
  factor?: string;
  action?: string;
  expectedFreeEnergy?: number;
  riskTerm?: number;
  ambiguityTerm?: number;
  associations: Array<{ entityId: string; activation: number }>;
  batchId?: string;
  position?: number;
}

export interface InferencePolicy {
  id: string;
  type: PolicyType;
  title: string;
  description: string;
  targetEntityId: string;
  invariantId: string;
  expectedUtility: number; // pragmatic value (0.0 to 1.0)
  informationGain: number; // epistemic value (0.0 to 1.0)
  expectedFreeEnergyScore: number; // composite ranking score
  estimatedRisk: number; // 0.0 to 1.0
  urgency: number; // 0.0 to 1.0
  actionPayload: Record<string, unknown>;
  ranking?: PolicyRankingMetadata;
}

/**
 * Default homeostatic invariants for sovereign personal computing. Exported so callers that
 * persist proposals (e.g. ShadowRecorder) can seed the database's `invariants` table with the
 * same ids the engine evaluates against -- `proposals.invariant_id` is a foreign key into that
 * table, so a proposal referencing one of these ids fails to persist unless it's been seeded.
 */
export const DEFAULT_INVARIANTS: SystemInvariant[] = [
  {
    id: 'inv_clean_test_suite',
    name: 'All Workspace Tests Passing',
    targetEntityId: 'project_sovereign_exocortex',
    preferredState: true,
    priorProbability: 0.99,
    toleranceThreshold: 0.01,
    category: 'CODE_HEALTH',
  },
  {
    id: 'inv_zero_broken_commits',
    name: 'Zero Uncommitted Syntax or Type Errors',
    targetEntityId: 'project_sovereign_exocortex',
    preferredState: true,
    priorProbability: 0.98,
    toleranceThreshold: 0.02,
    category: 'CODE_HEALTH',
  },
  {
    id: 'inv_bridge_connected',
    name: 'Mobile Sensorium WebSocket Connected',
    targetEntityId: 'device_phone_galaxy_s26',
    preferredState: true,
    priorProbability: 0.95,
    toleranceThreshold: 0.05,
    category: 'HARDWARE_LINK',
  },
  {
    id: 'inv_cafeteria_synced',
    name: 'Oakridge 2nd Helpings Menu In Sync',
    targetEntityId: 'project_oakridge_smokehouse',
    preferredState: true,
    priorProbability: 0.96,
    toleranceThreshold: 0.05,
    category: 'PROJECT_GOAL',
  },
  {
    id: 'inv_bear_house_online',
    name: 'Bear House Classic Edge & Postgres Healthy',
    targetEntityId: 'project_bear_house_classic',
    preferredState: true,
    priorProbability: 0.99,
    toleranceThreshold: 0.02,
    category: 'FAMILY_HOME',
  },
];

export class ActiveInferenceEngine {
  private invariants = new Map<string, SystemInvariant>();
  private lastObservations = new Map<string, SystemObservation>();
  private lifeGraph: LivingLifeGraph;
  private anomalyThresholdNats = 2.0; // ~ln(7.4) unexpectedness threshold
  private policySeq = 0; // disambiguates policy ids generated within the same millisecond

  constructor(lifeGraph: LivingLifeGraph) {
    this.lifeGraph = lifeGraph;
    this.registerDefaultInvariants();
  }

  /**
   * Register default homeostatic invariants for sovereign personal computing.
   */
  private registerDefaultInvariants(): void {
    for (const inv of DEFAULT_INVARIANTS) {
      this.invariants.set(inv.id, inv);
    }
  }

  /**
   * Register a custom invariant.
   */
  public registerInvariant(invariant: SystemInvariant): void {
    this.invariants.set(invariant.id, invariant);
  }

  /**
   * Ingest an observation and evaluate its variational surprisal against prior beliefs.
   */
  public evaluateObservation(obs: SystemObservation): SurprisalMetric {
    const invariant = this.invariants.get(obs.invariantId);
    // Only retain observations for registered invariants; arbitrary ids would grow the map unboundedly
    if (invariant) this.lastObservations.set(obs.invariantId, obs);

    if (!invariant) {
      return {
        invariantId: obs.invariantId,
        observedState: obs.observedState,
        preferredState: obs.observedState,
        surprisalNats: 0,
        isAnomaly: false,
        divergence: 0,
      };
    }

    const matches = obs.observedState === invariant.preferredState;
    // priorProbability outside (0,1) (or NaN) would give Infinity/negative/NaN surprisal; clamp to a valid range
    const prior = Number.isFinite(invariant.priorProbability)
      ? Math.min(0.999, Math.max(0.001, invariant.priorProbability))
      : 0.5;
    let probObserved: number;
    let divergence: number;

    if (matches) {
      probObserved = prior;
      divergence = 0;
    } else {
      // Divergence from expected prior
      probObserved = Math.max(0.001, 1.0 - prior);
      divergence = 1.0;
    }

    // Shannon Surprisal: s(o) = -ln P(o)
    const surprisalNats = -Math.log(probObserved);
    const isAnomaly = surprisalNats >= this.anomalyThresholdNats || divergence > invariant.toleranceThreshold;

    // Stimulate target entity in the Living Life Graph upon surprise
    if (isAnomaly) {
      this.lifeGraph.stimulate(invariant.targetEntityId, 0.8, obs.observedAt);
    }

    return {
      invariantId: obs.invariantId,
      observedState: obs.observedState,
      preferredState: invariant.preferredState,
      surprisalNats: Math.round(surprisalNats * 1000) / 1000,
      isAnomaly,
      divergence,
    };
  }

  /**
   * Synthesize active inference policies (pragmatic interventions & epistemic probes)
   * to minimize Expected Free Energy (EFE) across all anomalous observations.
   */
  public generatePolicies(metrics: SurprisalMetric[]): InferencePolicy[] {
    const policies: InferencePolicy[] = [];

    for (const metric of metrics) {
      if (!metric.isAnomaly) continue;

      const invariant = this.invariants.get(metric.invariantId);
      if (!invariant) continue;
      // A phone link drop is only reported after the link is back, and no action can fix it from here.
      // The daemon's link watchdog notifies the user instead of asking a question.
      if (invariant.category === 'HARDWARE_LINK') continue;

      // 1. Pragmatic Policy: Direct corrective action restoring the prior preferred state
      const pragmaticPolicy: InferencePolicy = {
        id: `policy_pragmatic_${invariant.id}_${Date.now()}_${this.policySeq++}`,
        type: 'PRAGMATIC',
        title: `Restore Homeostasis: ${invariant.name}`,
        description: `Direct action to bring state '${String(metric.observedState)}' back to preferred '${String(metric.preferredState)}'.`,
        targetEntityId: invariant.targetEntityId,
        invariantId: invariant.id,
        expectedUtility: 0.92, // High expected utility towards preference
        informationGain: 0.15, // Low uncertainty resolution
        expectedFreeEnergyScore: 0.85,
        estimatedRisk: 0.20, // Tier T2: writes local graph state (0.15 < risk <= 0.50)
        urgency: metric.surprisalNats > 3.0 ? 0.90 : 0.65,
        actionPayload: {
          command: 'self_heal_restore',
          invariantId: invariant.id,
          targetEntityId: invariant.targetEntityId,
          targetState: invariant.preferredState,
        },
      };
      policies.push(pragmaticPolicy);

      // 2. Epistemic Policy: Exploratory diagnostic probe reducing entropy/ambiguity
      const epistemicPolicy: InferencePolicy = {
        id: `policy_epistemic_${invariant.id}_${Date.now()}_${this.policySeq++}`,
        type: 'EPISTEMIC',
        title: `Investigate Anomaly: ${invariant.name}`,
        description: `Inspect causal context and collect diagnostic telemetry around entity ${invariant.targetEntityId}.`,
        targetEntityId: invariant.targetEntityId,
        invariantId: invariant.id,
        expectedUtility: 0.35,
        informationGain: 0.88, // High information gain / entropy reduction
        expectedFreeEnergyScore: 0.72,
        estimatedRisk: 0.0, // Read-only probe is zero risk
        urgency: 0.50,
        actionPayload: {
          command: 'diagnostic_probe',
          invariantId: invariant.id,
          targetEntityId: invariant.targetEntityId,
          maxHops: 2,
        },
      };
      policies.push(epistemicPolicy);
    }

    // Sort by Expected Free Energy composite score descending
    return policies.sort((a, b) => b.expectedFreeEnergyScore - a.expectedFreeEnergyScore);
  }

  /**
   * Convert an Active Inference Policy into a staged ProposalEnvelope
   * suitable for evaluation by the Cognitive Mode Gate.
   */
  public policyToProposal(policy: InferencePolicy): ProposalEnvelope {
    return {
      id: policy.id,
      candidateId: policy.invariantId,
      summary: policy.title,
      urgency: policy.urgency,
      // Scores are informational; auto-execution is granted only by AUTO_EXECUTE_ALLOWLIST in the gate.
      confidence: policy.type === 'PRAGMATIC' ? 0.90 : 0.98,
      estimatedRisk: policy.estimatedRisk,
      category: policy.type,
      suggestedAction: policy.actionPayload,
    };
  }

  /**
   * Retrieve all registered invariants.
   */
  public get registeredInvariants(): SystemInvariant[] {
    return Array.from(this.invariants.values());
  }
}
