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

export class PreCognitiveEngine {
  private cache: DryRunCache;
  private lastSignals: NeuromuscularSignals = {};
  private preStagedProposal: SpeculativeProposal | null = null;

  constructor(cache: DryRunCache = defaultDryRunCache) {
    this.cache = cache;
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

      return {
        urgencyIntent: 'CASUAL',
        wakeupLatencyMs: 0,
        hesitationScore: 0,
        isPreStaged: this.preStagedProposal !== null,
        preStagedProposalId: this.preStagedProposal?.proposalId,
      };
    }

    // state === 'SCREEN_ON'
    this.lastSignals.screenOnAt = timestamp;
    const refTime = this.lastSignals.lastVibrationAt ?? this.lastSignals.screenOffAt ?? (timestamp - 60000);
    const wakeupLatencyMs = Math.max(0, timestamp - refTime);

    let urgencyIntent: 'HIGH_URGENCY' | 'MODERATE' | 'CASUAL';
    if (this.lastSignals.lastVibrationAt && wakeupLatencyMs < 4000) {
      urgencyIntent = 'HIGH_URGENCY';
    } else if (wakeupLatencyMs < 12000) {
      urgencyIntent = 'MODERATE';
    } else {
      urgencyIntent = 'CASUAL';
    }

    return {
      urgencyIntent,
      wakeupLatencyMs,
      hesitationScore: this.computeHesitationScore(),
      isPreStaged: this.preStagedProposal !== null && !this.cache.isExpired(this.preStagedProposal),
      preStagedProposalId: this.preStagedProposal?.proposalId,
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
    const dwell = this.lastSignals.touchDwellDurationMs ?? 0;
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
    if (this.cache.isExpired(this.preStagedProposal)) {
      this.preStagedProposal = null;
      return null;
    }
    return this.preStagedProposal;
  }
}
