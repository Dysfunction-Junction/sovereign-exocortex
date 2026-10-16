/**
 * @file precognitive.ts
 * Frontier 1: Pre-Cognitive Readiness Engine.
 * 
 * Intercepts subconscious neuromuscular micro-telemetry (hesitation deltas,
 * scroll curves, dwell intervals) and pocket screen transitions (SCREEN_OFF -> SCREEN_ON):
 * 1. Wakeup Delta (\Delta t): Time between ambient notification/vibration and user waking screen.
 *    - \Delta t < 4000ms: High-urgency triage intent.
 *    - \Delta t > 30000ms: Casual browsing intent.
 * 2. Dwell & Hesitation: Freeze frames (>1800ms pause) on error messages or inputs.
 * 3. Pocket Pre-Staging: On SCREEN_OFF, pre-compiles the next predicted state into RAM,
 *    allowing instant (<0.05s) 1-tap surfacing on screen wake.
 */

import { DryRunCache, defaultDryRunCache, type SpeculativeProposal } from "./dry-run.js";

export const DEFAULT_WAKE_THRESHOLD_MS = 4000;
export const MIN_WAKE_THRESHOLD_MS = 500;
export const MAX_WAKE_THRESHOLD_MS = 15000;

export interface NeuromuscularSignals {
  lastVibrationAt?: number;
  screenOnAt?: number;
  screenOffAt?: number;
  lastTouchInteractionAt?: number;
  touchDwellDurationMs?: number;
  scrollDecelerationCurve?: number[]; // Velocity decay deltas
}

export interface ReadinessState {
  urgencyIntent: 'HIGH_URGENCY' | 'MODERATE' | 'CASUAL';
  wakeupLatencyMs: number;
  hesitationScore: number; // 0.0 to 1.0
  isPreStaged: boolean;
  preStagedProposalId?: string;
}

export interface PreCognitiveOptions {
  cache?: DryRunCache;
  wakeThresholdMs?: number;
  moderateMultiplier?: number;
}

/**
 * Computes an empirical wake delta quantile (e.g. p20) from logged deltas (in milliseconds).
 * Clamps result between MIN_WAKE_THRESHOLD_MS (500ms) and MAX_WAKE_THRESHOLD_MS (15000ms).
 * Returns fallback (4000ms) when empty or invalid.
 */
export function computeWakeDeltaQuantile(
  deltas: number[],
  quantile = 0.20,
  fallbackMs = DEFAULT_WAKE_THRESHOLD_MS,
  minSamples = 20
): number {
  const valid = deltas.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (valid.length < minSamples) return fallbackMs;
  const q = Math.max(0, Math.min(1, quantile));
  const pos = (valid.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const raw = valid[base + 1] !== undefined ? valid[base] + rest * (valid[base + 1] - valid[base]) : valid[base];
  const rounded = Math.round(raw);
  return Math.max(MIN_WAKE_THRESHOLD_MS, Math.min(MAX_WAKE_THRESHOLD_MS, rounded));
}

export interface WakeEventRecord {
  kind: string;
  ts_device: number;
  payload?: Record<string, unknown> | null;
}

/**
 * Extracts wake-to-screen-on / wake-to-touch deltas (in ms) from an event stream.
 * Specifically measures the interval between vibration (or wake notification) and
 * the subsequent user wake action (SCREEN_ON or TOUCH) within maxWindowMs.
 */
export function extractWakeDeltasFromEvents(
  events: WakeEventRecord[],
  maxWindowMs = 30000
): number[] {
  const deltas: number[] = [];
  const sorted = [...events].sort((a, b) => a.ts_device - b.ts_device);
  let pendingWakeTs: number | null = null;

  for (const ev of sorted) {
    const isVibrationOrWake =
      ev.kind === "vibration" ||
      ev.kind === "wake" ||
      (ev.kind === "telemetry" && ev.payload?.event === "VIBRATION");

    const isScreenOnOrWakeResponse =
      (ev.kind === "telemetry" && (ev.payload?.event === "SCREEN_ON" || ev.payload?.event === "TOUCH" || ev.payload?.event === "TAP")) ||
      ev.kind === "touch";

    if (isVibrationOrWake) {
      // Use latest vibration timestamp in a burst
      pendingWakeTs = ev.ts_device;
    } else if (isScreenOnOrWakeResponse && pendingWakeTs !== null) {
      const delta = ev.ts_device - pendingWakeTs;
      if (delta >= 0 && delta <= maxWindowMs) {
        deltas.push(delta);
      }
      pendingWakeTs = null;
    }
  }
  return deltas;
}

export class PreCognitiveEngine {
  private cache: DryRunCache;
  private lastSignals: NeuromuscularSignals = {};
  private preStagedProposal: SpeculativeProposal | null = null;
  private wakeThresholdMs: number;
  private moderateMultiplier: number;

  constructor(cacheOrOpts: DryRunCache | PreCognitiveOptions = defaultDryRunCache) {
    if (cacheOrOpts instanceof DryRunCache) {
      this.cache = cacheOrOpts;
      this.wakeThresholdMs = DEFAULT_WAKE_THRESHOLD_MS;
      this.moderateMultiplier = 3;
    } else {
      this.cache = cacheOrOpts.cache ?? defaultDryRunCache;
      this.wakeThresholdMs = cacheOrOpts.wakeThresholdMs ?? DEFAULT_WAKE_THRESHOLD_MS;
      this.moderateMultiplier = cacheOrOpts.moderateMultiplier ?? 3;
    }
  }

  public get wakeThreshold(): number {
    return this.wakeThresholdMs;
  }

  public setWakeThreshold(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) {
      this.wakeThresholdMs = Math.max(MIN_WAKE_THRESHOLD_MS, Math.min(MAX_WAKE_THRESHOLD_MS, Math.round(ms)));
    }
  }

  /**
   * Process a screen state change.
   * If SCREEN_OFF: initiates pocket pre-staging of candidate routines.
   * If SCREEN_ON: measures wakeup latency and determines urgency intent.
   */
  public handleScreenStateChange(
    state: 'SCREEN_ON' | 'SCREEN_OFF',
    timestamp: number = Date.now(),
    predictiveStagingCallback?: () => { candidateId: string; payload: Record<string, unknown>; summary: string } | null
  ): ReadinessState {
    if (state === 'SCREEN_OFF') {
      this.lastSignals.screenOffAt = timestamp;
      
      // Pocket Pre-Staging: Pre-compile predicted next action while device is resting in pocket
      if (predictiveStagingCallback) {
        const candidate = predictiveStagingCallback();
        if (candidate) {
          this.preStagedProposal = this.cache.set(
            candidate.candidateId,
            candidate.payload,
            candidate.summary,
            300000 // 5-minute TTL
          );
        }
      }

      const ready = this.getReadyProposal();
      return {
        urgencyIntent: 'CASUAL',
        wakeupLatencyMs: 0,
        hesitationScore: 0,
        isPreStaged: ready !== null,
        preStagedProposalId: ready?.proposalId,
      };
    }

    // state === 'SCREEN_ON'
    this.lastSignals.screenOnAt = timestamp;
    const refTime = this.lastSignals.lastVibrationAt ?? this.lastSignals.screenOffAt ?? (timestamp - 60000);
    const wakeupLatencyMs = Math.max(0, timestamp - refTime);

    let urgencyIntent: 'HIGH_URGENCY' | 'MODERATE' | 'CASUAL';
    const highLimit = this.wakeThresholdMs;
    const moderateLimit = Math.max(12000, highLimit * this.moderateMultiplier);
    if (this.lastSignals.lastVibrationAt !== undefined && wakeupLatencyMs < highLimit) {
      urgencyIntent = 'HIGH_URGENCY';
    } else if (wakeupLatencyMs < moderateLimit) {
      urgencyIntent = 'MODERATE';
    } else {
      urgencyIntent = 'CASUAL';
    }

    const readyOnWake = this.getReadyProposal();
    return {
      urgencyIntent,
      wakeupLatencyMs,
      hesitationScore: this.computeHesitationScore(),
      isPreStaged: readyOnWake !== null,
      preStagedProposalId: readyOnWake?.proposalId,
    };
  }

  /**
   * Record an ambient vibration or alert signal.
   */
  public recordVibration(timestamp: number = Date.now()): void {
    this.lastSignals.lastVibrationAt = timestamp;
  }

  /**
   * Ingest touch interaction and dwell micro-telemetry.
   */
  public recordTouchInteraction(dwellMs: number, timestamp: number = Date.now()): number {
    this.lastSignals.lastTouchInteractionAt = timestamp;
    this.lastSignals.touchDwellDurationMs = dwellMs;
    return this.computeHesitationScore();
  }

  /**
   * Computes neuromuscular hesitation score (0.0 to 1.0).
   * Freeze frames (>1800ms dwell) on complex screens indicate hesitation.
   */
  public computeHesitationScore(): number {
    const rawDwell = this.lastSignals.touchDwellDurationMs ?? 0;
    const dwell = Number.isNaN(rawDwell) ? 0 : rawDwell; // NaN would otherwise propagate as a NaN score
    if (dwell <= 400) return 0.05; // Fluid, automatic interaction
    if (dwell <= 1200) return 0.25; // Normal consideration
    if (dwell <= 1800) return 0.55; // Moderate pause
    // > 1800ms: Significant hesitation or friction detected
    return Math.min(1.0, 0.6 + (dwell - 1800) / 2000);
  }

  /**
   * Retrieve the active pre-staged proposal ready for instant 1-tap thumb approval.
   */
  public getReadyProposal(): SpeculativeProposal | null {
    if (!this.preStagedProposal) return null;
    // Also drop it if it was released/rejected/evicted from the cache (single-use)
    if (this.cache.isExpired(this.preStagedProposal) || this.cache.get(this.preStagedProposal.proposalId) === null) {
      this.preStagedProposal = null;
      return null;
    }
    return this.preStagedProposal;
  }

  private suggestionRecords: SuggestionDecisionRecord[] = [];
  private static readonly MAX_SUGGESTION_RECORDS = 500;

  /**
   * Record human decision (acceptance vs ignore) and dwell time when system suggestions are presented.
   */
  public recordSuggestionDecision(
    decision: SuggestionDecision,
    dwellMs: number,
    suggestionType?: string,
    action?: string,
    timestamp: number = Date.now()
  ): SuggestionAcceptanceMetrics {
    const record: SuggestionDecisionRecord = { decision, dwellMs, suggestionType, action, timestamp };
    this.suggestionRecords.push(record);
    if (this.suggestionRecords.length > PreCognitiveEngine.MAX_SUGGESTION_RECORDS) {
      this.suggestionRecords.shift();
    }
    return computeSuggestionAcceptanceMetrics(this.suggestionRecords);
  }

  /**
   * Returns empirical acceptance rate and dwell time metrics across recorded suggestion decisions.
   */
  public getSuggestionMetrics(): SuggestionAcceptanceMetrics {
    return computeSuggestionAcceptanceMetrics(this.suggestionRecords);
  }
}

export type SuggestionDecision = 'ACCEPTED' | 'IGNORED';

export interface SuggestionDecisionRecord {
  decision: SuggestionDecision;
  dwellMs: number;
  suggestionType?: string;
  action?: string;
  timestamp?: number;
}

export interface SuggestionAcceptanceMetrics {
  sampleCount: number;
  acceptedCount: number;
  ignoredCount: number;
  acceptanceRate: number;
  meanAcceptedDwellMs: number;
  meanIgnoredDwellMs: number;
  overallMeanDwellMs: number;
}

/**
 * Computes acceptance rate and dwell time distributions when system suggestions were presented.
 */
export function computeSuggestionAcceptanceMetrics(
  records: readonly SuggestionDecisionRecord[]
): SuggestionAcceptanceMetrics {
  const sampleCount = records.length;
  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      acceptedCount: 0,
      ignoredCount: 0,
      acceptanceRate: 0,
      meanAcceptedDwellMs: 0,
      meanIgnoredDwellMs: 0,
      overallMeanDwellMs: 0,
    };
  }

  let acceptedCount = 0;
  let ignoredCount = 0;
  let totalAcceptedDwell = 0;
  let totalIgnoredDwell = 0;
  let totalDwell = 0;
  let acceptedDwellCount = 0;
  let ignoredDwellCount = 0;
  let validDwellCount = 0;

  for (const r of records) {
    const hasValidDwell = Number.isFinite(r.dwellMs) && r.dwellMs >= 0;
    if (r.decision === 'ACCEPTED') {
      acceptedCount++;
      if (hasValidDwell) {
        totalAcceptedDwell += r.dwellMs;
        acceptedDwellCount++;
        totalDwell += r.dwellMs;
        validDwellCount++;
      }
    } else {
      ignoredCount++;
      if (hasValidDwell) {
        totalIgnoredDwell += r.dwellMs;
        ignoredDwellCount++;
        totalDwell += r.dwellMs;
        validDwellCount++;
      }
    }
  }

  return {
    sampleCount,
    acceptedCount,
    ignoredCount,
    acceptanceRate: acceptedCount / sampleCount,
    meanAcceptedDwellMs: acceptedDwellCount > 0 ? totalAcceptedDwell / acceptedDwellCount : 0,
    meanIgnoredDwellMs: ignoredDwellCount > 0 ? totalIgnoredDwell / ignoredDwellCount : 0,
    overallMeanDwellMs: validDwellCount > 0 ? totalDwell / validDwellCount : 0,
  };
}
