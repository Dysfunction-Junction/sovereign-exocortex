import { EventEmitter } from "node:events";
import { DryRunCache, defaultDryRunCache, type SpeculativeProposal } from "./dry-run.js";
import { clusterEventsToPatterns, computeSurprisalFeedback, rankSuppliedCandidates } from "./mishmash-rank.js";
import type { WorkflowPattern } from "./types.js";

export interface TelemetryEvent {
  packageName?: string;
  className?: string;
  text?: string;
  contentDescription?: string;
  eventType?: string | number;
  timestamp?: number;
  [key: string]: unknown;
}

export interface SurprisalFeedbackEvent {
  feedbackId: string;
  candidateId: string;
  outcome: "approved" | "dismissed" | "undone" | "diverged" | "rejected";
  priorConfidence?: number;
  surprisal: number;
  weightMultiplier: number;
  recommendDemotion: boolean;
  timestamp: string;
}

export class ExocortexEventBus extends EventEmitter {
  private dryRunCache: DryRunCache;

  constructor(cache: DryRunCache = defaultDryRunCache) {
    super();
    this.dryRunCache = cache;
  }

  get cache(): DryRunCache {
    return this.dryRunCache;
  }

  /**
   * Ingest a batch of raw telemetry events from phone sensorium,
   * cluster them into actionable patterns in-memory, and return ranked candidates.
   */
  ingestTelemetry(events: TelemetryEvent[]): WorkflowPattern[] {
    const patterns = clusterEventsToPatterns(events);
    this.emit("telemetry:clustered", { eventsCount: events.length, patterns });
    return patterns;
  }

  /**
   * Pre-compiles and stages an action into the high-speed dry-run cache.
   */
  speculate(
    candidateId: string,
    actionPayload: Record<string, unknown>,
    summary: string,
    ttlMs?: number
  ): SpeculativeProposal {
    const proposal = this.dryRunCache.set(candidateId, actionPayload, summary, ttlMs);
    this.emit("proposal:speculated", proposal);
    return proposal;
  }

  /**
   * Validates hardware nonce and releases the pre-compiled payload for execution.
   */
  release(
    proposalId: string,
    nonce: string
  ): { ok: true; proposal: SpeculativeProposal } | { ok: false; error: string; code: number } {
    const res = this.dryRunCache.release(proposalId, nonce);
    if (res.ok) {
      this.emit("proposal:released", res.proposal);
    }
    return res;
  }

  /**
   * Rejects and evicts a speculative proposal from cache.
   */
  reject(proposalId: string, reason: string): boolean {
    const deleted = this.dryRunCache.clearProposal(proposalId);
    if (deleted) {
      this.emit("proposal:rejected", { proposalId, reason });
    }
    return deleted;
  }

  /**
   * Ingest human friction / outcome feedback and compute Shannon surprisal.
   */
  feedback(
    candidateId: string,
    outcome: "approved" | "dismissed" | "undone" | "diverged" | "rejected",
    priorConfidence: number = 0.5
  ) {
    const fb = computeSurprisalFeedback({ candidateId, outcome, priorConfidence });
    if (!("error" in fb)) {
      this.emit("feedback:surprisal", fb);
    }
    return fb;
  }
}

export const defaultEventBus = new ExocortexEventBus();
