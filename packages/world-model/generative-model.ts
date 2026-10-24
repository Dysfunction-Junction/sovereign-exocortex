/**
 * @file generative-model.ts
 * Discrete Learned Generative Model for Active Inference (Architecture & Schema v3).
 *
 * Implements Karl Friston's Free Energy Principle with exact discrete Dirichlet
 * count tables (A, B, C, D) per hidden factor, Bayesian belief updates, Shannon
 * surprisal, Expected Free Energy (EFE = Risk + Ambiguity), and event-store replay.
 */

import { canonicalJsonStringify } from "@exocortex/core/canonical";
import type {
  ModelParamRecord,
  BeliefSnapshotRecord,
  EventRecord,
} from "@exocortex/core";
import type { SystemObservation } from "./active-inference.js";

export type { ModelParamRecord, BeliefSnapshotRecord, EventRecord };

export interface ExtractedObservation {
  factor: string;
  obs: string;
  action?: string;
}

const INVARIANT_SIGNALS: Record<string, { factor: string; positive: string; negative: string }> = {
  inv_clean_test_suite: { factor: "repo_health", positive: "tests_pass", negative: "tests_fail" },
  inv_zero_broken_commits: { factor: "repo_health", positive: "clean_checkout", negative: "uncommitted_edits" },
  inv_bridge_connected: { factor: "link_health", positive: "ping_fast", negative: "ws_dropped" },
};

const SUPPORTED_SIGNALS: Record<string, { observations: string[]; actions: string[] }> = {
  user_mode: {
    observations: ["typing_burst", "test_running", "docs_reading", "idle_long", "window_switch"],
    actions: ["focus_lock", "prompt_suggest", "run_tests", "notify_user", "no_op"],
  },
  repo_health: {
    observations: ["tests_pass", "tests_fail", "type_error", "clean_checkout", "uncommitted_edits"],
    actions: ["self_heal_patch", "run_diagnostics", "stage_commit", "revert_candidate", "no_op"],
  },
  link_health: {
    observations: ["ping_fast", "ping_slow", "ws_dropped", "packet_loss"],
    actions: ["reconnect_ws", "flush_outbox", "throttle_telemetry", "no_op"],
  },
};

export type ObservationSupport = (factor: string) => { observations: readonly string[]; actions: readonly string[] } | undefined;

export function isSupportedObservation(value: ExtractedObservation, support?: ObservationSupport): boolean {
  const supported = support ? support(value.factor)
    : Object.hasOwn(SUPPORTED_SIGNALS, value.factor) ? SUPPORTED_SIGNALS[value.factor] : undefined;
  return !!supported && supported.observations.includes(value.obs)
    && (value.action === undefined || supported.actions.includes(value.action));
}

export function foregroundObservation(payload: Record<string, unknown>): ExtractedObservation | null {
  const app = payload.foregroundApp ?? payload.app ?? payload.foreground;
  if (typeof app !== "string" || !app.trim()) return null;
  return { factor: "user_mode", obs: /(?:vscode|code\.exe|\bantigravity\b)/i.test(app) ? "typing_burst" : "window_switch" };
}

export function invariantObservation(obs: SystemObservation, support?: ObservationSupport): ExtractedObservation | null {
  const signal = Object.hasOwn(INVARIANT_SIGNALS, obs.invariantId) ? INVARIANT_SIGNALS[obs.invariantId] : undefined;
  const metadata = obs.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new TypeError("invalid observation: metadata must be an object");
  }
  const explicit = metadata?.factor !== undefined || metadata?.observation !== undefined || metadata?.action !== undefined;
  if (explicit) {
    const extracted = { factor: metadata?.factor, obs: metadata?.observation, action: metadata?.action };
    if (typeof extracted.factor !== "string" || typeof extracted.obs !== "string"
      || (extracted.action !== undefined && typeof extracted.action !== "string")
      || !isSupportedObservation(extracted as ExtractedObservation, support)) {
      throw new TypeError("invalid observation: unsupported factor, observation or action");
    }
    const value = extracted as ExtractedObservation;
    if (!signal || typeof obs.observedState !== "boolean") return null;
    const allowed = signal && value.factor === signal.factor && (
      value.obs === (obs.observedState === true ? signal.positive : signal.negative)
      || (obs.invariantId === "inv_bridge_connected" && obs.observedState === true && value.obs === "ping_slow")
    );
    if (!allowed) throw new TypeError("invalid observation: inconsistent invariant mapping");
    return value;
  }
  return signal && typeof obs.observedState === "boolean"
    ? { factor: signal.factor, obs: obs.observedState === true ? signal.positive : signal.negative }
    : null;
}

function explicitInvariantObservation(
  payload: Record<string, unknown>, timestamp: number, support?: ObservationSupport,
): SystemObservation | null {
  const state = payload.observedState;
  if (typeof payload.invariantId !== "string" || !payload.invariantId.trim()
    || !(typeof state === "boolean" || typeof state === "string" || (typeof state === "number" && Number.isFinite(state)))) return null;
  const rawMetadata = payload.metadata;
  if (rawMetadata !== undefined && (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata))) return null;
  const metadata: Record<string, unknown> = { ...(rawMetadata as Record<string, unknown> | undefined) };
  for (const key of ["factor", "observation", "action"]) {
    if (payload[key] === undefined) continue;
    if (metadata[key] !== undefined && metadata[key] !== payload[key]) return null;
    metadata[key] = payload[key];
  }
  if (payload.source === "local_vision" || metadata.source === "local_vision") metadata.source = "local_vision";
  else if (typeof payload.source === "string") metadata.source = payload.source;
  const observation: SystemObservation = {
    invariantId: payload.invariantId, observedState: state,
    observedAt: typeof payload.observedAt === "number" ? payload.observedAt : timestamp,
    confidence: typeof payload.confidence === "number" ? payload.confidence : 1,
    metadata,
  };
  try {
    invariantObservation(observation, support);
    return observation;
  } catch {
    return null;
  }
}

export function systemObservationFromEvent(
  event: EventRecord, extracted: ExtractedObservation | null, support?: ObservationSupport,
): SystemObservation | null {
  if (event.kind !== "observation" || !Number.isFinite(event.ts_device)) return null;
  let payload: Record<string, unknown>;
  try {
    const raw = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    payload = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.observedAt !== undefined && (typeof payload.observedAt !== "number" || !Number.isFinite(payload.observedAt))) return null;
  if (payload.confidence !== undefined && (typeof payload.confidence !== "number" || !Number.isFinite(payload.confidence)
    || payload.confidence < 0 || payload.confidence > 1)) return null;
  if (payload.invariantId !== undefined || payload.observedState !== undefined) {
    return explicitInvariantObservation(payload, event.ts_device, support);
  }
  if (!extracted || !isSupportedObservation(extracted, support)) return null;
  for (const [invariantId, signal] of Object.entries(INVARIANT_SIGNALS)) {
    if (extracted.factor !== signal.factor) continue;
    const positive = extracted.obs === signal.positive
      || (invariantId === "inv_bridge_connected" && extracted.obs === "ping_slow");
    if (!positive && extracted.obs !== signal.negative) continue;
    if (payload.invariantId !== undefined && payload.invariantId !== invariantId) return null;
    if (payload.observedState !== undefined && payload.observedState !== positive) return null;
    return {
      invariantId, observedState: positive,
      observedAt: typeof payload.observedAt === "number" ? payload.observedAt : event.ts_device,
      confidence: typeof payload.confidence === "number" ? payload.confidence : 1,
      metadata: {
        factor: extracted.factor, observation: extracted.obs,
        ...(extracted.action ? { action: extracted.action } : {}),
        ...(typeof payload.source === "string" ? { source: payload.source } : {}),
      },
    };
  }
  return null;
}

/**
 * Pure function to extract factor observation and optional action from an immutable EventRecord.
 */
export function eventToObservation(event: EventRecord, support?: ObservationSupport): ExtractedObservation | null {
  if (!event || typeof event !== "object") return null;
  if (event.kind !== "observation" && event.kind !== "telemetry") return null;

  let payload: Record<string, unknown>;
  try {
    const raw = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    payload = raw as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const key of ["observedAt", "confidence"]) {
    if (payload[key] !== undefined && (typeof payload[key] !== "number" || !Number.isFinite(payload[key]))) return null;
  }
  if (typeof payload.confidence === "number" && (payload.confidence < 0 || payload.confidence > 1)) return null;
  if (!Number.isFinite(event.ts_device)) return null;
  if (payload.invariantId !== undefined && typeof payload.invariantId !== "string") return null;
  if (payload.observedState !== undefined && typeof payload.observedState !== "boolean"
    && typeof payload.observedState !== "string"
    && !(typeof payload.observedState === "number" && Number.isFinite(payload.observedState))) return null;
  if (payload.invariantId !== undefined || payload.observedState !== undefined) {
    const observation = explicitInvariantObservation(payload, event.ts_device, support);
    if (!observation) return null;
    try {
      return invariantObservation(observation, support);
    } catch {
      return null;
    }
  }

  // 1. Explicit factor and observation payload
  if (payload.factor !== undefined || payload.observation !== undefined || payload.action !== undefined) {
    if (typeof payload.factor !== "string" || typeof payload.observation !== "string"
      || (payload.action !== undefined && typeof payload.action !== "string")) return null;
    const extracted = { factor: payload.factor, obs: payload.observation, action: payload.action as string | undefined };
    if (!isSupportedObservation(extracted, support)) return null;
    return extracted;
  }

  const foreground = foregroundObservation(payload);
  if (foreground) return foreground;

  if (payload.invariant === "clean_suite" || payload.tests !== undefined) {
    if (payload.state !== undefined && typeof payload.state !== "boolean") return null;
    if (payload.tests !== undefined && (typeof payload.tests !== "string"
      || !["passed", "ok", "failed", "fail"].includes(payload.tests))) return null;
    if (payload.state === undefined && payload.tests === undefined) return null;
    if (typeof payload.state === "boolean" && payload.tests !== undefined
      && payload.state !== (payload.tests === "passed" || payload.tests === "ok")) return null;
    const isPass = payload.state === true || payload.tests === "passed" || payload.tests === "ok";
    return {
      factor: "repo_health",
      obs: isPass ? "tests_pass" : "tests_fail",
    };
  }

  return null;
}

export interface FactorDefinition {
  name: string;
  states: string[];
  observations: string[];
  actions: string[];
  initialPriorCounts?: number[]; // D counts, length = states.length
  initialLikelihoodCounts?: number[][]; // A counts, size = observations.length x states.length
  initialTransitionCounts?: number[][][]; // B counts, size = actions.length x states.length x states.length
  preferredObservations?: number[]; // C log-probabilities, length = observations.length
}

export interface EFEPolicyEvaluation {
  actionIndex: number;
  actionName: string;
  expectedFreeEnergy: number; // G(u) = Risk + Ambiguity (lower is better)
  riskTerm: number; // Pragmatic divergence from C
  ambiguityTerm: number; // Epistemic conditional entropy of sensors
  predictedNextState: number[]; // q(s_{t+1} | u)
  predictedObservation: number[]; // q(o_{t+1} | u)
}

export class DiscreteGenerativeFactor {
  public readonly name: string;
  public readonly states: string[];
  public readonly observations: string[];
  public readonly actions: string[];

  // Dirichlet count tables
  public aCounts: number[][]; // [obs][state]
  public bCounts: number[][][]; // [action][nextState][currState]
  public cPreferences: number[]; // [obs] log-probabilities
  public dCounts: number[]; // [state] prior counts

  public version = 1;
  public currentBelief: number[]; // q(s)
  public lastActionIndex: number;

  constructor(def: FactorDefinition) {
    this.name = def.name;
    this.states = [...def.states];
    this.observations = [...def.observations];
    this.actions = [...def.actions];

    const nStates = this.states.length;
    const nObs = this.observations.length;
    const nActions = this.actions.length;

    // D prior counts (default pseudocount 1.0)
    this.dCounts = def.initialPriorCounts
      ? [...def.initialPriorCounts]
      : Array.from({ length: nStates }, () => 1.0);

    // A likelihood counts (default pseudocount 1.0)
    if (def.initialLikelihoodCounts) {
      this.aCounts = def.initialLikelihoodCounts.map((row) => [...row]);
    } else {
      this.aCounts = Array.from({ length: nObs }, () =>
        Array.from({ length: nStates }, () => 1.0)
      );
    }

    // B transition counts (default pseudocount 1.0)
    if (def.initialTransitionCounts) {
      this.bCounts = def.initialTransitionCounts.map((mat) =>
        mat.map((row) => [...row])
      );
    } else {
      this.bCounts = Array.from({ length: nActions }, () =>
        Array.from({ length: nStates }, () =>
          Array.from({ length: nStates }, () => 1.0)
        )
      );
    }

    // C preferences (log-probabilities over preferred outcomes)
    if (def.preferredObservations) {
      this.cPreferences = [...def.preferredObservations];
    } else {
      // Default uniform preference (0)
      this.cPreferences = Array.from({ length: nObs }, () => -Math.log(nObs));
    }

    // Initial belief q(s) is normalized D
    this.currentBelief = this.getD();
    this.lastActionIndex = 0;
  }

  /**
   * Get normalized initial state distribution D(s).
   */
  public getD(): number[] {
    const sum = this.dCounts.reduce((acc, v) => acc + v, 0);
    return this.dCounts.map((v) => (sum > 0 ? v / sum : 1 / this.states.length));
  }

  /**
   * Get normalized likelihood matrix A[o, s] = P(o | s).
   */
  public getA(): number[][] {
    const nObs = this.observations.length;
    const nStates = this.states.length;
    const aNorm: number[][] = Array.from({ length: nObs }, () => new Array(nStates).fill(0));

    for (let s = 0; s < nStates; s++) {
      let colSum = 0;
      for (let o = 0; o < nObs; o++) {
        colSum += this.aCounts[o][s];
      }
      for (let o = 0; o < nObs; o++) {
        aNorm[o][s] = colSum > 0 ? this.aCounts[o][s] / colSum : 1 / nObs;
      }
    }
    return aNorm;
  }

  /**
   * Get normalized transition matrix for an action B[action, nextState, currState] = P(s' | s, a).
   */
  public getB(actionIndex: number): number[][] {
    const actIdx = Math.max(0, Math.min(actionIndex, this.actions.length - 1));
    const nStates = this.states.length;
    const bNorm: number[][] = Array.from({ length: nStates }, () => new Array(nStates).fill(0));

    for (let s = 0; s < nStates; s++) {
      let colSum = 0;
      for (let nextS = 0; nextS < nStates; nextS++) {
        colSum += this.bCounts[actIdx][nextS][s];
      }
      for (let nextS = 0; nextS < nStates; nextS++) {
        bNorm[nextS][s] = colSum > 0 ? this.bCounts[actIdx][nextS][s] / colSum : 1 / nStates;
      }
    }
    return bNorm;
  }

  /**
   * Update beliefs given an observation and compute Shannon surprisal.
   *
   * q(s_t) \propto A[o_t, \cdot] \odot (B[a_{t-1}] q(s_{t-1}))
   */
  public updateBelief(
    obsIndex: number,
    prevActionIndex = this.lastActionIndex,
    prevBelief = this.currentBelief
  ): {
    posterior: number[];
    surprisalNats: number;
    predictedObsProb: number;
  } {
    const nStates = this.states.length;
    const A = this.getA();
    const B = this.getB(prevActionIndex);

    // Prior prediction: q_prior(s_t) = B[a_{t-1}] q(s_{t-1})
    const qPrior = new Array(nStates).fill(0);
    for (let nextS = 0; nextS < nStates; nextS++) {
      for (let s = 0; s < nStates; s++) {
        qPrior[nextS] += B[nextS][s] * prevBelief[s];
      }
    }

    // Predicted probability of observation o_t: P(o_t) = \sum_s A[o_t, s] q_prior(s)
    let predictedObsProb = 0;
    for (let s = 0; s < nStates; s++) {
      predictedObsProb += A[obsIndex][s] * qPrior[s];
    }
    const safeObsProb = Math.max(predictedObsProb, 1e-12);
    const surprisalNats = -Math.log(safeObsProb);

    // Bayesian posterior update: q(s_t) \propto A[o_t, s] * q_prior(s)
    const unnormalized = new Array(nStates).fill(0);
    let normSum = 0;
    for (let s = 0; s < nStates; s++) {
      unnormalized[s] = A[obsIndex][s] * qPrior[s];
      normSum += unnormalized[s];
    }

    const posterior = unnormalized.map((val) => (normSum > 0 ? val / normSum : 1 / nStates));

    this.currentBelief = posterior;
    return { posterior, surprisalNats, predictedObsProb };
  }

  /**
   * Evaluate Expected Free Energy (EFE = Risk + Ambiguity) for candidate actions.
   */
  public evaluatePolicies(currentBelief = this.currentBelief): EFEPolicyEvaluation[] {
    const evaluations: EFEPolicyEvaluation[] = [];
    const nStates = this.states.length;
    const nObs = this.observations.length;
    const A = this.getA();

    for (let a = 0; a < this.actions.length; a++) {
      const B = this.getB(a);

      // Predicted next state: q(s_{t+1} | a) = B[a] q(s_t)
      const qNextState = new Array(nStates).fill(0);
      for (let nextS = 0; nextS < nStates; nextS++) {
        for (let s = 0; s < nStates; s++) {
          qNextState[nextS] += B[nextS][s] * currentBelief[s];
        }
      }

      // Predicted observation: q(o_{t+1} | a) = A q(s_{t+1} | a)
      const qObs = new Array(nObs).fill(0);
      for (let o = 0; o < nObs; o++) {
        for (let s = 0; s < nStates; s++) {
          qObs[o] += A[o][s] * qNextState[s];
        }
      }

      // Risk term: D_KL(q(o_{t+1} | a) || p_C(o)) = \sum_o q(o) [ ln q(o) - C(o) ]
      let riskTerm = 0;
      for (let o = 0; o < nObs; o++) {
        const pObs = Math.max(qObs[o], 1e-12);
        const cPref = this.cPreferences[o];
        riskTerm += pObs * (Math.log(pObs) - cPref);
      }

      // Ambiguity term: \sum_s q(s) H[A(\cdot | s)]
      let ambiguityTerm = 0;
      for (let s = 0; s < nStates; s++) {
        let colEntropy = 0;
        for (let o = 0; o < nObs; o++) {
          const aProb = Math.max(A[o][s], 1e-12);
          colEntropy -= aProb * Math.log(aProb);
        }
        ambiguityTerm += qNextState[s] * colEntropy;
      }

      const expectedFreeEnergy = riskTerm + ambiguityTerm;

      evaluations.push({
        actionIndex: a,
        actionName: this.actions[a],
        expectedFreeEnergy,
        riskTerm,
        ambiguityTerm,
        predictedNextState: qNextState,
        predictedObservation: qObs,
      });
    }

    // Sort by EFE ascending (lowest free energy is optimal)
    return evaluations.sort((a, b) => a.expectedFreeEnergy - b.expectedFreeEnergy);
  }

  /**
   * Dirichlet conjugate update: increment counts based on observed transition.
   */
  public learn(
    obsIndex: number,
    posterior: number[],
    prevActionIndex = this.lastActionIndex,
    prevBelief = this.currentBelief,
    learningRate = 1.0
  ): void {
    const nStates = this.states.length;

    // 1. Increment A likelihood counts: a_{o_t, s} += lr * q(s_t)
    for (let s = 0; s < nStates; s++) {
      this.aCounts[obsIndex][s] += learningRate * posterior[s];
    }

    // 2. Increment B transition counts: b_{s_t, s, a_{t-1}} += lr * q(s_t) * q(s_{t-1})
    const actIdx = Math.max(0, Math.min(prevActionIndex, this.actions.length - 1));
    for (let nextS = 0; nextS < nStates; nextS++) {
      for (let s = 0; s < nStates; s++) {
        this.bCounts[actIdx][nextS][s] += learningRate * posterior[nextS] * prevBelief[s];
      }
    }

    // 3. Dirichlet forgetting / count cap to prevent count explosion
    const MAX_COUNT_PER_STATE = 500.0;
    for (let s = 0; s < nStates; s++) {
      let aSum = 0;
      for (let o = 0; o < this.observations.length; o++) {
        aSum += this.aCounts[o][s];
      }
      if (aSum > MAX_COUNT_PER_STATE) {
        for (let o = 0; o < this.observations.length; o++) {
          this.aCounts[o][s] *= 0.9;
        }
      }
    }

    this.version++;
  }
}

/** True when `v` is a nested array with exactly the given dims whose leaves are finite numbers (>= 0 if nonNeg). */
function hasShape(v: unknown, dims: number[], nonNeg: boolean): boolean {
  if (dims.length === 0) {
    return typeof v === "number" && Number.isFinite(v) && (!nonNeg || v >= 0);
  }
  if (!Array.isArray(v) || v.length !== dims[0]) return false;
  return v.every((child) => hasShape(child, dims.slice(1), nonNeg));
}

function makePersistenceB(nStates: number, nActions: number, noOpIndex: number): number[][][] {
  const bCounts: number[][][] = [];
  for (let a = 0; a < nActions; a++) {
    const mat: number[][] = [];
    for (let nextS = 0; nextS < nStates; nextS++) {
      const row: number[] = [];
      for (let s = 0; s < nStates; s++) {
        if (a === noOpIndex) {
          row.push(nextS === s ? 8.0 : 0.5);
        } else {
          row.push(nextS === s ? 5.0 : 1.0);
        }
      }
      mat.push(row);
    }
    bCounts.push(mat);
  }
  return bCounts;
}

/**
 * LearnedActiveInferenceEngine: High-level multi-factor generative world model.
 */
export class LearnedActiveInferenceEngine {
  private factors = new Map<string, DiscreteGenerativeFactor>();
  /** Running sum of per-step surprisal (nats): -ln P(o_t) under the predictive distribution. */
  private totalSurprisal = 0;

  constructor() {
    this.registerDefaultFactors();
  }

  private registerDefaultFactors(): void {
    // Factor 1: user_mode
    this.registerFactor({
      name: "user_mode",
      states: ["DEEP_FOCUS", "HIGH_VELOCITY", "EXPLORATORY", "MAINTENANCE", "REST"],
      observations: SUPPORTED_SIGNALS.user_mode.observations,
      actions: SUPPORTED_SIGNALS.user_mode.actions,
      initialPriorCounts: [5.0, 3.0, 2.0, 1.0, 1.0],
      initialLikelihoodCounts: [
        [8.0, 5.0, 1.0, 0.5, 0.1], // typing_burst
        [2.0, 8.0, 0.5, 1.0, 0.1], // test_running
        [1.0, 0.5, 8.0, 1.0, 0.5], // docs_reading
        [0.1, 0.1, 0.5, 1.0, 8.0], // idle_long
        [0.5, 1.0, 3.0, 8.0, 1.0], // window_switch
      ],
      initialTransitionCounts: makePersistenceB(5, 5, 4),
      preferredObservations: [
        Math.log(0.40), // typing_burst (productive flow)
        Math.log(0.30), // test_running
        Math.log(0.15), // docs_reading
        Math.log(0.05), // idle_long (undesirable lag)
        Math.log(0.10), // window_switch
      ],
    });

    // Factor 2: repo_health
    this.registerFactor({
      name: "repo_health",
      states: ["CLEAN", "DIRTY_SAFE", "BROKEN_TESTS", "TYPE_ERROR", "STALE_BRANCH"],
      observations: SUPPORTED_SIGNALS.repo_health.observations,
      actions: SUPPORTED_SIGNALS.repo_health.actions,
      initialPriorCounts: [7.0, 3.0, 0.5, 0.5, 1.0],
      initialLikelihoodCounts: [
        [8.0, 6.0, 0.05, 0.05, 1.0], // tests_pass
        [0.05, 0.1, 9.0, 0.5, 0.2], // tests_fail
        [0.05, 0.1, 0.5, 9.0, 0.2], // type_error
        [8.0, 0.2, 0.2, 0.2, 0.5], // clean_checkout
        [0.2, 8.0, 1.0, 1.0, 4.0], // uncommitted_edits
      ],
      initialTransitionCounts: makePersistenceB(5, 5, 4),
      preferredObservations: [
        Math.log(0.50), // tests_pass
        Math.log(0.01), // tests_fail (heavily penalized)
        Math.log(0.01), // type_error (heavily penalized)
        Math.log(0.35), // clean_checkout
        Math.log(0.13), // uncommitted_edits
      ],
    });

    // Factor 3: link_health
    this.registerFactor({
      name: "link_health",
      states: ["CONNECTED_FAST", "CONNECTED_SLOW", "RECONNECTING", "OFFLINE"],
      observations: SUPPORTED_SIGNALS.link_health.observations,
      actions: SUPPORTED_SIGNALS.link_health.actions,
      initialPriorCounts: [8.0, 2.0, 0.5, 0.5],
      initialLikelihoodCounts: [
        [9.0, 1.0, 0.05, 0.01], // ping_fast
        [1.0, 8.0, 0.2, 0.05], // ping_slow
        [0.05, 0.2, 8.0, 8.0], // ws_dropped
        [0.1, 4.0, 4.0, 6.0], // packet_loss
      ],
      initialTransitionCounts: makePersistenceB(4, 4, 3),
      preferredObservations: [
        Math.log(0.80), // ping_fast
        Math.log(0.15), // ping_slow
        Math.log(0.02), // ws_dropped
        Math.log(0.03), // packet_loss
      ],
    });
  }

  public registerFactor(def: FactorDefinition): DiscreteGenerativeFactor {
    const factor = new DiscreteGenerativeFactor(def);
    this.factors.set(def.name, factor);
    return factor;
  }

  public getFactor(name: string): DiscreteGenerativeFactor | undefined {
    return this.factors.get(name);
  }

  public listFactors(): DiscreteGenerativeFactor[] {
    return Array.from(this.factors.values());
  }

  /**
   * Process an observation for a given factor, updating beliefs and learning in-place.
   */
  public processObservation(
    factorName: string,
    obsName: string,
    actionName?: string
  ): {
    factor: string;
    obsName: string;
    posterior: Record<string, number>;
    surprisalNats: number;
    bestPolicy: EFEPolicyEvaluation;
    allPolicies: EFEPolicyEvaluation[];
  } {
    const factor = this.factors.get(factorName);
    if (!factor) {
      throw new Error(`Unknown generative factor: ${factorName}`);
    }

    const obsIndex = factor.observations.indexOf(obsName);
    if (obsIndex === -1) {
      throw new Error(`Observation '${obsName}' not found in factor '${factorName}'`);
    }

    let actionIdx: number;
    if (actionName !== undefined) {
      actionIdx = factor.actions.indexOf(actionName);
      if (actionIdx === -1) {
        throw new Error(`Action '${actionName}' not found in factor '${factorName}'`);
      }
    } else {
      const noOpIdx = factor.actions.indexOf("no_op");
      actionIdx = noOpIdx !== -1 ? noOpIdx : factor.actions.length - 1;
    }
    const prevBelief = [...factor.currentBelief];

    // 1. Inference: Bayesian update & Surprisal
    const { posterior, surprisalNats } = factor.updateBelief(obsIndex, actionIdx, prevBelief);

    // Accumulate surprisal (finite-guarded so one bad step cannot poison the running total)
    if (Number.isFinite(surprisalNats) && surprisalNats >= 0) {
      this.totalSurprisal += surprisalNats;
    }

    // 2. Learning: Dirichlet conjugate count increments under the observed action
    factor.learn(obsIndex, posterior, actionIdx, prevBelief);

    // 3. Planning: Evaluate candidate policies via EFE
    const policies = factor.evaluatePolicies(posterior);
    const bestPolicy = policies[0];
    // Planning is not evidence that the proposed action was executed.
    factor.lastActionIndex = actionIdx;

    const posteriorMap: Record<string, number> = {};
    factor.states.forEach((stateName, idx) => {
      posteriorMap[stateName] = Math.round(posterior[idx] * 10000) / 10000;
    });

    return {
      factor: factorName,
      obsName,
      posterior: posteriorMap,
      surprisalNats: Math.round(surprisalNats * 1000) / 1000,
      bestPolicy,
      allPolicies: policies,
    };
  }

  /**
   * Export all factors' Dirichlet count tables to ModelParamRecords for SQLite persistence.
   */
  public exportModelParams(asOfSeq: number): ModelParamRecord[] {
    const records: ModelParamRecord[] = [];

    for (const factor of this.factors.values()) {
      // Kind A: Likelihood counts
      records.push({
        factor: factor.name,
        kind: "A",
        version: factor.version,
        counts: canonicalJsonStringify(factor.aCounts),
        as_of_seq: asOfSeq,
      });

      // Kind B: Transition counts
      records.push({
        factor: factor.name,
        kind: "B",
        version: factor.version,
        counts: canonicalJsonStringify(factor.bCounts),
        as_of_seq: asOfSeq,
      });

      // Kind C: Preference vector
      records.push({
        factor: factor.name,
        kind: "C",
        version: factor.version,
        counts: canonicalJsonStringify(factor.cPreferences),
        as_of_seq: asOfSeq,
      });

      // Kind D: Prior counts
      records.push({
        factor: factor.name,
        kind: "D",
        version: factor.version,
        counts: canonicalJsonStringify(factor.dCounts),
        as_of_seq: asOfSeq,
      });
    }

    return records;
  }

  /**
   * Import Dirichlet count tables from SQLite records.
   */
  public importModelParams(records: ModelParamRecord[]): void {
    // Oldest first, so the newest valid record wins and a malformed newest one falls back to the previous version.
    for (const rec of [...records].sort((a, b) => a.version - b.version)) {
      const factor = this.factors.get(rec.factor);
      if (!factor) continue;

      try {
        const parsed = JSON.parse(rec.counts);
        const nS = factor.states.length;
        const nO = factor.observations.length;
        const nA = factor.actions.length;
        // Reject tables with wrong dimensions / non-finite / negative counts: they would
        // crash or silently poison every later belief update.
        if (rec.kind === "A" && hasShape(parsed, [nO, nS], true)) {
          factor.aCounts = parsed;
        } else if (rec.kind === "B" && hasShape(parsed, [nA, nS, nS], true)) {
          factor.bCounts = parsed;
        } else if (rec.kind === "C" && hasShape(parsed, [nO], false)) {
          factor.cPreferences = parsed;
        } else if (rec.kind === "D" && hasShape(parsed, [nS], true)) {
          factor.dCounts = parsed;
        } else {
          continue;
        }
        factor.version = Math.max(factor.version, rec.version);
      } catch {
        // Ignore malformed counts
      }
    }
  }

  /**
   * Create a BeliefSnapshotRecord for the current cognitive state.
   */
  public createBeliefSnapshot(asOfSeq: number): BeliefSnapshotRecord {
    const userModeFactor = this.factors.get("user_mode");
    const modeStates = userModeFactor?.states ?? ["DEEP_FOCUS"];
    const modeBeliefs = userModeFactor?.currentBelief ?? [1.0];

    // Pick state with maximum probability
    let maxIdx = 0;
    for (let i = 1; i < modeBeliefs.length; i++) {
      if (modeBeliefs[i] > modeBeliefs[maxIdx]) maxIdx = i;
    }
    const mode = (modeStates[maxIdx] ?? "DEEP_FOCUS") as any;

    const allBeliefs: Record<string, Record<string, number>> = {};
    const totalSurprisal = this.totalSurprisal;

    for (const factor of this.factors.values()) {
      const map: Record<string, number> = {};
      factor.states.forEach((s, idx) => {
        map[s] = Math.round(factor.currentBelief[idx] * 10000) / 10000;
      });
      allBeliefs[factor.name] = map;
    }

    return {
      as_of_seq: asOfSeq,
      mode,
      q: canonicalJsonStringify(allBeliefs),
      surprisal: totalSurprisal,
    };
  }

  /**
   * Hydrate in-memory belief states across all factors from a saved BeliefSnapshotRecord.
   */
  public hydrateFromSnapshot(snapshot: BeliefSnapshotRecord): void {
    if (typeof snapshot.surprisal === "number" && Number.isFinite(snapshot.surprisal) && snapshot.surprisal >= 0) {
      this.totalSurprisal = snapshot.surprisal;
    }
    try {
      const qObj = JSON.parse(snapshot.q) as Record<string, Record<string, number>>;
      if (!qObj || typeof qObj !== "object") return;
      for (const [factorName, stateMap] of Object.entries(qObj)) {
        const factor = this.factors.get(factorName);
        if (!factor || !stateMap || typeof stateMap !== "object") continue;
        const newBelief = factor.states.map((s) => Number(stateMap[s] ?? 0));
        if (!newBelief.every((v) => Number.isFinite(v) && v >= 0)) continue;
        const sum = newBelief.reduce((a, b) => a + b, 0);
        if (sum > 0) {
          factor.currentBelief = newBelief.map((v) => v / sum);
        }
      }
    } catch {
      // Ignore malformed snapshot
    }
  }

  /**
   * Replay an event stream and deterministically rebuild all generative models and snapshots.
   */
  public replayEventStream(events: EventRecord[]): {
    replayedCount: number;
    snapshots: BeliefSnapshotRecord[];
    latestParams: ModelParamRecord[];
  } {
    const snapshots: BeliefSnapshotRecord[] = [];
    let count = 0;

    for (const event of events) {
      count++;
      try {
        const extracted = eventToObservation(event, (name) => this.factors.get(name));
        if (extracted && this.factors.has(extracted.factor)) {
          this.processObservation(extracted.factor, extracted.obs, extracted.action);
        }
      } catch {
        // Malformed payloads and unsupported signals must not abort the append-only log.
      }
      snapshots.push(this.createBeliefSnapshot(event.seq));
    }

    const latestParams = this.exportModelParams(events.length > 0 ? events[events.length - 1].seq : 0);
    return {
      replayedCount: count,
      snapshots,
      latestParams,
    };
  }
}
