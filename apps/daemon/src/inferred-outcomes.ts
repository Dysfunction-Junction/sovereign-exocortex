/**
 * @file inferred-outcomes.ts
 * Inferred outcome label engine for Sovereign Exocortex (Sub-project 4 of Shadow Mode).
 *
 * Scans surfaced shadow proposals (shadow = 1) lacking human tap labels:
 * 1. 'already_did': The target invariant was subsequently restored out-of-band by the user
 *    (as evidenced by a subsequent observation event where observedState matches preferredState
 *    within the proposal's active horizon) without an approval or rejection tap.
 * 2. 'ignored': The proposal reached its expiration horizon plus grace period without user interaction or restoration.
 *
 * Strict Calibration Invariant:
 * All inferred labels MUST specify `{ source: "inferred" }`.
 * Per packages/core/src/shadow-metrics.ts, only labels with source = "tap" feed Precision@surface.
 * Inferred labels are counted separately in `alreadyDid` and `ignored`, contributing to pessimistic
 * precision and coverage without altering the tap-calibrated >= 0.90 gate.
 */

import type { ExocortexDatabase } from "@exocortex/core/db";
import { EventIdConflictError } from "@exocortex/core/db";
import { canonicalJsonStringify } from "@exocortex/core/canonical";
import type { ProposalState, ShadowLabel } from "@exocortex/core";
import { DEFAULT_INVARIANTS } from "@exocortex/world-model";
import { HOST_DEVICE_ID } from "./shadow-recorder.js";

export const INFER_GRACE_MS = 5 * 60 * 1000; // 5-minute ingest grace period before finalizing ignored
export const UPGRADE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24-hour upgrade window for ignored proposals

export interface InferOutcomesOptions {
  nowMs?: number;
  horizonMs?: number;
  dryRun?: boolean;
  emitEvents?: boolean;
}

export interface ProposalOutcomeEvaluation {
  proposalId: string;
  label: "already_did" | "ignored" | "skipped_tap" | "pending" | "unresolvable";
  reason: string;
  restoringSeq?: number;
  latencyMs?: number;
}

export interface InferredOutcomeReport {
  evaluatedCount: number;
  alreadyDidCount: number;
  ignoredCount: number;
  skippedTapCount: number;
  stillPendingCount: number;
  unresolvableCount: number;
  finalizedCount: number;
  upgradedCount: number;
  results: ProposalOutcomeEvaluation[];
}

export interface ApplyShadowLabelParams {
  proposalId: string;
  label: ShadowLabel;
  source: "tap" | "inferred";
  actual?: unknown;
  latencyMs?: number | null;
  /** false when the label already arrived as a ledger event (avoids writing it twice). */
  emitEvent?: boolean;
  nowMs?: number;
}

/**
 * Persists a shadow label into shadow_labels and appends a corresponding 'label' event.
 * Reusable across server routes, approval handlers, and inferred outcome evaluation.
 * Respects the database conflict clause: an inferred label will never overwrite a human tap label.
 */
export function applyShadowLabel(
  db: ExocortexDatabase,
  deviceId: string,
  params: ApplyShadowLabelParams,
): { proposalId: string; label: ShadowLabel; source: string; recordedAt: number } {
  const proposal = db.getProposal(params.proposalId);
  if (!proposal) {
    throw new Error(`proposal not found: ${params.proposalId}`);
  }

  let sanitizedActual: Record<string, unknown> = {};
  if (params.actual && typeof params.actual === "object" && !Array.isArray(params.actual)) {
    sanitizedActual = { ...(params.actual as Record<string, unknown>) };
  } else if (params.actual !== undefined && params.actual !== null) {
    sanitizedActual = { actual: String(params.actual) };
  }
  sanitizedActual.source = params.source;
  const actualStr = JSON.stringify(sanitizedActual);

  const now = params.nowMs ?? Date.now();
  const latencyMs = Number.isSafeInteger(params.latencyMs) && (params.latencyMs as number) >= 0
    ? (params.latencyMs as number)
    : null;

  db.withTransaction(() => {
    db.recordShadowLabel({
      proposal_id: params.proposalId,
      label: params.label,
      actual: actualStr,
      latency_ms: latencyMs,
      ts: now,
    });

    if (params.emitEvent === false) return;
    // Deterministic event ID for inferred labels to prevent duplicate ledger events upon re-runs
    const eventId = params.source === "inferred"
      ? `label:inferred:${params.proposalId}:${params.label}`
      : `label:${params.proposalId}:${now}:${Math.random().toString(36).slice(2, 8)}`;

    try {
      db.ingestEvent(deviceId, {
        event_id: eventId,
        kind: "label",
        ts_device: now,
        schema_ver: 1,
        payload: {
          proposal_id: params.proposalId,
          label: params.label,
          source: params.source,
          latency_ms: latencyMs,
        },
      });
    } catch (err) {
      if (err instanceof EventIdConflictError) {
        // Idempotent retry: label event was already appended
        return;
      }
      // Re-throw unexpected errors for inferred labels so transaction rolls back cleanly
      if (params.source === "inferred") {
        throw err;
      }
      console.warn(`[shadow-label] could not append event for ${params.proposalId}:`, err instanceof Error ? err.message : err);
    }
  });

  return {
    proposalId: params.proposalId,
    label: params.label,
    source: params.source,
    recordedAt: now,
  };
}

interface CandidateRow {
  proposal_id: string;
  shadow: number;
  decision: string | null;
  mode: string;
  gate_ts: number;
  label: ShadowLabel | null;
  actual: string | null;
  created_seq: number;
  invariant_id: string | null;
  action: string;
  expires_at: number;
  state: ProposalState;
}

function parseLabelSource(actual: string | null | undefined): "tap" | "inferred" | null {
  if (!actual) return null;
  try {
    const parsed = JSON.parse(actual) as { source?: unknown };
    return parsed.source === "tap" || parsed.source === "inferred" ? parsed.source : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether an observed state matches the target state symmetrically,
 * handling boolean, number, string and JSON representations without accidental object coercion.
 */
export function isStateMatching(observed: unknown, target: unknown): boolean {
  if (typeof target === "boolean") {
    if (target === true) {
      return observed === true || observed === 1 || observed === "true" || observed === "TRUE";
    } else {
      return observed === false || observed === 0 || observed === "false" || observed === "FALSE";
    }
  }
  if (typeof target === "number") {
    return typeof observed === "number"
      ? observed === target
      : typeof observed === "string" && observed.trim() !== "" && !Number.isNaN(Number(observed)) && Number(observed) === target;
  }
  if (typeof target === "string") {
    return String(observed) === target;
  }
  if (target === null || target === undefined) {
    return observed === target;
  }
  if (typeof target === "object" && typeof observed === "object" && observed !== null) {
    try {
      return canonicalJsonStringify(observed) === canonicalJsonStringify(target);
    } catch {
      return false;
    }
  }
  return observed === target;
}

/**
 * Computes the effective expiry timestamp for a proposal, unifying dry-run horizon simulation
 * with live proposal expiration protection.
 */
export function computeEffectiveExpiry(
  row: { gate_ts: number; expires_at: number },
  options: { dryRun?: boolean; horizonMs?: number },
): number {
  return options.dryRun && options.horizonMs !== undefined
    ? row.gate_ts + options.horizonMs
    : Math.max(row.expires_at, row.gate_ts + (options.horizonMs ?? 0));
}

/**
 * Evaluates candidate shadow proposals and infers 'already_did' or 'ignored' outcomes.
 *
 * Idempotent: repeated runs produce the same labels without duplicate event entries
 * or state corruption.
 */
export function inferProposalOutcomes(
  db: ExocortexDatabase,
  options: InferOutcomesOptions = {},
): InferredOutcomeReport {
  const nowMs = options.nowMs ?? Date.now();
  const emitEvents = options.emitEvents ?? true;
  const dryRun = options.dryRun ?? false;

  const rows = db.raw
    .prepare(
      `WITH ranked AS (
         SELECT g.proposal_id, g.mode, g.decision, g.ts,
                ROW_NUMBER() OVER (PARTITION BY g.proposal_id ORDER BY g.ts DESC, g.rowid DESC) AS rn
           FROM gate_decisions g
       ),
       first_surface AS (
         SELECT proposal_id, MIN(ts) AS first_surface_ts
           FROM gate_decisions
          WHERE decision = 'SURFACE'
          GROUP BY proposal_id
       )
       SELECT p.proposal_id, p.shadow, r.decision AS decision,
              COALESCE(r.mode, 'MAINTENANCE') AS mode,
              COALESCE(fs.first_surface_ts, r.ts, p.updated_at) AS gate_ts,
              l.label, l.actual,
              p.created_seq, p.invariant_id, p.action, p.expires_at, p.state
         FROM proposals p
         JOIN ranked r ON r.proposal_id = p.proposal_id AND r.rn = 1
         LEFT JOIN first_surface fs ON fs.proposal_id = p.proposal_id
         LEFT JOIN shadow_labels l ON l.proposal_id = p.proposal_id
        WHERE p.shadow = 1
          AND r.decision = 'SURFACE'
        ORDER BY p.created_seq ASC`,
    )
    .all() as unknown as CandidateRow[];

  const report: InferredOutcomeReport = {
    evaluatedCount: 0,
    alreadyDidCount: 0,
    ignoredCount: 0,
    skippedTapCount: 0,
    stillPendingCount: 0,
    unresolvableCount: 0,
    finalizedCount: 0,
    upgradedCount: 0,
    results: [],
  };

  for (const row of rows) {
    try {
      // 1. State filter: only active surfaced proposals or expired candidates can be evaluated
    // (Proposals that were approved or rejected via triad/biometrics are terminal and excluded)
    if (row.state !== "SURFACED" && row.state !== "EXPIRED") {
      continue;
    }

    report.evaluatedCount++;

    const labelSource = parseLabelSource(row.actual);

    // 2. Strict Whitelist: Only unlabeled proposals or 'ignored' proposals with source='inferred'
    // are eligible. All human tap labels (wanted/not_wanted/source='tap') and finalized 'already_did'
    // are strictly protected.
    const isUnlabeled = row.label === null;
    const isUpgradableIgnored = row.label === "ignored" && labelSource === "inferred";
    if (!isUnlabeled && !isUpgradableIgnored) {
      if (row.label === "already_did") {
        report.finalizedCount++;
      } else {
        report.skippedTapCount++;
        report.results.push({
          proposalId: row.proposal_id,
          label: "skipped_tap",
          reason: `protected label: ${row.label} (source: ${labelSource ?? "tap"})`,
        });
      }
      continue;
    }

    // 3. Upgrade window cutoff: bound the rescan period for 'ignored' proposals to UPGRADE_WINDOW_MS
    if (row.label === "ignored") {
      const effectiveExpiry = computeEffectiveExpiry(row, { dryRun, horizonMs: options.horizonMs });
      if (nowMs > effectiveExpiry + UPGRADE_WINDOW_MS) {
        report.finalizedCount++;
        continue;
      }
    }

    // 4. Resolve target invariant and preferred target state
    let invariantId: string | null = row.invariant_id ?? null;
    let targetState: unknown = undefined;

    if (row.action) {
      try {
        const act = JSON.parse(row.action);
        if (!invariantId && act.invariantId) {
          invariantId = String(act.invariantId);
        } else if (!invariantId && act.invariant_id) {
          invariantId = String(act.invariant_id);
        }
        if (act.targetState !== undefined) {
          targetState = act.targetState;
        } else if (act.target_state !== undefined) {
          targetState = act.target_state;
        }
      } catch {
        // Non-JSON action payload fallback
      }
    }

    // Fallback A: extract invariant from known default invariants mentioned in proposal ID (longest match wins)
    if (!invariantId) {
      const candidates = DEFAULT_INVARIANTS.filter((inv) => row.proposal_id.includes(inv.id));
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.id.length - a.id.length);
        invariantId = candidates[0].id;
      } else {
        const match = row.proposal_id.match(/(inv_[a-z0-9]+(?:_[a-z0-9]+)*)/);
        if (match) {
          const candidateId = match[1];
          if (
            DEFAULT_INVARIANTS.some((inv) => inv.id === candidateId) ||
            Boolean(db.raw.prepare("SELECT 1 FROM invariants WHERE invariant_id = ?").get(candidateId))
          ) {
            invariantId = candidateId;
          }
        }
      }
    }

    // Fallback B: resolve from creation event payload if historical proposal row omitted invariant_id
    if (!invariantId && row.created_seq) {
      try {
        const evRow = db.raw
          .prepare("SELECT payload FROM events WHERE seq = ?")
          .get(row.created_seq) as { payload: string } | undefined;
        if (evRow) {
          const payload = JSON.parse(evRow.payload);
          invariantId = payload.invariant_id ?? payload.invariantId ?? null;
        }
      } catch {
        // Non-fatal event lookup fallback
      }
    }

    if (invariantId) {
      const defaultInv = DEFAULT_INVARIANTS.find((inv) => inv.id === invariantId);
      if (defaultInv && targetState === undefined) {
        targetState = defaultInv.preferredState;
      }
    }

    if (targetState === undefined) {
      targetState = true; // homeostatic preference across all default invariants
    }

    // If invariant cannot be resolved from the proposal or action, do not mislabel as ignored
    if (!invariantId) {
      report.unresolvableCount++;
      report.results.push({
        proposalId: row.proposal_id,
        label: "unresolvable",
        reason: "proposal has no resolvable invariant_id",
      });
      continue;
    }

    // Coherent effective horizon: dryRun allows explicit horizon simulation; live execution protects live proposals
    const effectiveExpiry = computeEffectiveExpiry(row, { dryRun, horizonMs: options.horizonMs });
    const maxRestoringTs = effectiveExpiry;

    // 5. Search for subsequent observation events restoring the preferred invariant state
    // Bounded in time: restoration must have occurred after gate_ts and on or before effectiveExpiry
    let restoringEvent: { seq: number; ts_device: number } | null = null;
    const invIdParam = invariantId;
    const obsRows = db.raw
      .prepare(
        `SELECT seq, ts_device, payload
           FROM events
          WHERE kind = 'observation'
            AND seq > ?
            AND ts_device >= ?
            AND ts_device <= ?
            AND (json_extract(payload, '$.invariantId') = ? OR json_extract(payload, '$.invariant_id') = ?)
          ORDER BY seq ASC`,
      )
      .all(row.created_seq, row.gate_ts, maxRestoringTs, invIdParam, invIdParam) as Array<{ seq: number; ts_device: number; payload: string }>;

    for (const obs of obsRows) {
      try {
        const payload = JSON.parse(obs.payload);
        const observedState = payload.observedState ?? payload.observed_state;
        if (isStateMatching(observedState, targetState)) {
          restoringEvent = { seq: Number(obs.seq), ts_device: Number(obs.ts_device) };
          break;
        }
      } catch {
        // Non-fatal JSON parse error
      }
    }

    // 6. If restored within horizon -> label 'already_did' atomically
    if (restoringEvent) {
      const targetInvId = invariantId;
      const targetRestoringEvent = restoringEvent;
      const latencyMs = Math.max(0, targetRestoringEvent.ts_device - row.gate_ts);
      const isUpgrade = row.label === "ignored";

      let wasCommitted = true;
      if (!dryRun) {
        wasCommitted = db.withTransaction(() => {
          // Concurrency guard: verify another process (CLI / HTTP) didn't tap-label during scan
          const currentLabels = db.getShadowLabels(row.proposal_id);
          if (currentLabels.some((l) => l.label === "wanted" || l.label === "not_wanted" || parseLabelSource(l.actual) === "tap")) {
            return false;
          }

          applyShadowLabel(db, HOST_DEVICE_ID, {
            proposalId: row.proposal_id,
            label: "already_did",
            source: "inferred",
            latencyMs,
            nowMs,
            actual: {
              source: "inferred",
              reason: "invariant_restored",
              invariant_id: targetInvId,
              restoring_seq: targetRestoringEvent.seq,
              restoring_ts: targetRestoringEvent.ts_device,
              ...(isUpgrade ? { upgraded_from: "ignored" } : {}),
            },
            emitEvent: emitEvents,
          });

          if (row.state === "SURFACED") {
            try {
              db.updateProposalState(row.proposal_id, "EXPIRED");
            } catch (err) {
              console.warn(`[inferred-outcomes] failed to transition proposal ${row.proposal_id} to EXPIRED:`, err);
            }
          }
          return true;
        });
      }

      if (!wasCommitted) {
        report.skippedTapCount++;
        report.results.push({
          proposalId: row.proposal_id,
          label: "skipped_tap",
          reason: "concurrent tap label detected during evaluation",
        });
        continue;
      }

      if (isUpgrade) {
        report.upgradedCount++;
      } else {
        report.alreadyDidCount++;
      }
      report.results.push({
        proposalId: row.proposal_id,
        label: "already_did",
        reason: isUpgrade
          ? `upgraded from ignored: invariant ${targetInvId} was restored at event seq ${targetRestoringEvent.seq}`
          : `invariant ${targetInvId} restored at event seq ${targetRestoringEvent.seq}`,
        restoringSeq: targetRestoringEvent.seq,
        latencyMs,
      });
      continue;
    }

    // If already labeled as 'ignored' and no restoration occurred, it is finalized
    if (row.label === "ignored") {
      report.finalizedCount++;
      continue;
    }

    // 7. If not restored, check if the proposal has reached expiration plus grace period
    const isExpired = nowMs >= (effectiveExpiry + INFER_GRACE_MS);

    if (isExpired) {
      let wasCommitted = true;
      if (!dryRun) {
        wasCommitted = db.withTransaction(() => {
          const currentLabels = db.getShadowLabels(row.proposal_id);
          if (currentLabels.some((l) => l.label === "wanted" || l.label === "not_wanted" || parseLabelSource(l.actual) === "tap")) {
            return false;
          }

          applyShadowLabel(db, HOST_DEVICE_ID, {
            proposalId: row.proposal_id,
            label: "ignored",
            source: "inferred",
            latencyMs: null,
            nowMs,
            actual: {
              source: "inferred",
              reason: "expired_without_interaction",
              effective_expiry: effectiveExpiry,
              gate_ts: row.gate_ts,
              expires_at: row.expires_at,
              delivery: "unknown",
            },
            emitEvent: emitEvents,
          });

          if (row.state === "SURFACED") {
            try {
              db.updateProposalState(row.proposal_id, "EXPIRED");
            } catch (err) {
              console.warn(`[inferred-outcomes] failed to transition proposal ${row.proposal_id} to EXPIRED:`, err);
            }
          }
          return true;
        });
      }

      if (!wasCommitted) {
        report.skippedTapCount++;
        report.results.push({
          proposalId: row.proposal_id,
          label: "skipped_tap",
          reason: "concurrent tap label detected during evaluation",
        });
        continue;
      }

      report.ignoredCount++;
      report.results.push({
        proposalId: row.proposal_id,
        label: "ignored",
        reason: `proposal expired after ${effectiveExpiry - row.gate_ts}ms with no user interaction or restoration`,
      });
    } else {
      // 8. Proposal remains open within its active interaction window
      report.stillPendingCount++;
      report.results.push({
        proposalId: row.proposal_id,
        label: "pending",
        reason: `interaction horizon active (${Math.max(0, effectiveExpiry - nowMs)}ms remaining)`,
      });
      }
    } catch (err) {
      report.unresolvableCount++;
      report.results.push({
        proposalId: row.proposal_id,
        label: "unresolvable",
        reason: `evaluation error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return report;
}

export interface InferredOutcomeSchedulerOptions {
  db?: ExocortexDatabase;
  getDb?: () => ExocortexDatabase;
  intervalMs?: number;
  horizonMs?: number;
  nowMs?: () => number;
  onPassComplete?: (report: InferredOutcomeReport) => void;
}

/**
 * Background daemon scheduler running periodic outcome inference passes.
 */
export class InferredOutcomeScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly horizonMs?: number;
  private readonly nowMs: () => number;
  private readonly getDb: () => ExocortexDatabase;
  private readonly onPassComplete?: (report: InferredOutcomeReport) => void;

  constructor(options: InferredOutcomeSchedulerOptions) {
    // Clamp to at least 10s to prevent hot-looping
    this.intervalMs = Math.max(10_000, options.intervalMs ?? 15 * 60 * 1000);
    this.horizonMs = options.horizonMs;
    this.nowMs = options.nowMs ?? Date.now;
    this.onPassComplete = options.onPassComplete;

    if (options.db) {
      const fixedDb = options.db;
      this.getDb = () => fixedDb;
    } else if (options.getDb) {
      this.getDb = options.getDb;
    } else {
      throw new Error("InferredOutcomeScheduler requires either 'db' or 'getDb'");
    }
  }

  public start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.runPass();
    }, this.intervalMs);
    this.timer.unref();

    setImmediate(() => {
      if (!this.stopped) {
        void this.runPass();
      }
    });
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async runPass(): Promise<InferredOutcomeReport | null> {
    if (this.running || this.stopped) return null;
    this.running = true;
    try {
      const db = this.getDb();
      const report = inferProposalOutcomes(db, {
        nowMs: this.nowMs(),
        horizonMs: this.horizonMs,
      });
      this.onPassComplete?.(report);
      return report;
    } catch (err) {
      console.error("[inferred-outcomes] pass encountered an error:", err instanceof Error ? err.message : err);
      return null;
    } finally {
      this.running = false;
    }
  }
}
