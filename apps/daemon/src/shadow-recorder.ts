/**
 * @file shadow-recorder.ts
 * Persists would-be proposals and their gate decisions to the SQLite event store
 * so shadow-mode precision can be measured (see shadow-metrics in @exocortex/core).
 *
 * Maps the runtime gate vocabulary onto the v3 schema, appends a `proposal` event to the
 * hash-chained log for `created_seq`, and writes event + proposal + decision atomically.
 */

import { createHash } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { canonicalJsonStringify } from "@exocortex/core/canonical";
import type {
  GateDecisionAction,
  ProposalRecord,
  ProposalState,
  RiskTier,
} from "@exocortex/core";
import { DEFAULT_INVARIANTS, isAutoExecuteAllowlisted } from "@exocortex/world-model";
import type { GateAction, GateDecision, InferencePolicy, ProposalEnvelope } from "@exocortex/world-model";

export const HOST_DEVICE_ID = "host:exocortexd";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

export function mapGateAction(action: GateAction): { decision: GateDecisionAction; state: ProposalState } {
  switch (action) {
    case "ALLOW_PROMPT":
      return { decision: "SURFACE", state: "SURFACED" };
    case "SUPPRESS_AND_QUEUE":
      return { decision: "QUEUE", state: "STAGED" };
    case "DROP":
      return { decision: "SUPPRESS", state: "SUPPRESSED" };
    case "SILENT_AUTO_EXECUTE":
      return { decision: "AUTO_DRY_RUN", state: "GATED" };
    default: {
      const unmapped: never = action;
      throw new Error(`unmapped gate action: ${String(unmapped)}`);
    }
  }
}

/**
 * Executor-side re-check for SILENT_AUTO_EXECUTE decisions. Returns true only when the decision
 * really is an auto-execute, the proposal's action is allowlisted, SHADOW=0, and the canonical
 * circuit breaker is readable and not tripped. Anything else (including errors) => record only.
 */
export function mayActuateAutoExecute(
  gate: GateDecision,
  proposal: ProposalEnvelope,
  db: Pick<ExocortexDatabase, "isCircuitBreakerTripped"> | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (gate.action !== "SILENT_AUTO_EXECUTE") return false;
  if (!isAutoExecuteAllowlisted(proposal)) return false;
  if (env.SHADOW !== "0") return false;
  if (!db) return false;
  try {
    return !db.isCircuitBreakerTripped();
  } catch {
    return false;
  }
}

export function tierForRisk(risk: number): RiskTier {
  if (risk <= 0.05) return 0;
  if (risk <= 0.15) return 1;
  if (risk <= 0.5) return 2;
  if (risk <= 0.85) return 3;
  return 4;
}

export interface ShadowRecorderOptions {
  nowMs?: () => number;
  /** true (default) records shadow=1; false records live proposals. */
  shadow?: boolean;
  ttlMs?: number;
  /** Skip a repeat of the same invariant + policy + action within this window (default 1 h). */
  cooldownMs?: number;
}

function hostPlatform(): "android" | "windows" | "linux" {
  return process.platform === "win32" ? "windows" : "linux";
}

export class ShadowRecorder {
  private readonly nowMs: () => number;
  private readonly shadow: boolean;
  private readonly ttlMs: number;
  private readonly cooldownMs: number;
  /** dedupe key -> last recorded ms. In-memory: a restart resets the cooldown. */
  private readonly lastRecorded = new Map<string, number>();
  private hostReady = false;
  private invariantsReady = false;

  constructor(private readonly db: ExocortexDatabase, options: ShadowRecorderOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.shadow = options.shadow ?? true;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  public ensureHostDevice(): void {
    if (this.hostReady) return;
    if (!this.db.getDevice(HOST_DEVICE_ID)) {
      // The one-byte key is not a valid SPKI, so any signature check against this device fails closed.
      try {
        this.db.registerDevice({
          device_id: HOST_DEVICE_ID,
          name: "exocortexd host",
          platform: hostPlatform(),
          pubkey_spki: new Uint8Array([0]), // placeholder: the host never signs approvals
          key_attested: 0,
          scopes: ["host:proposal"],
          enrolled_at: this.nowMs(),
          revoked_at: null,
        });
      } catch (err) {
        // Another process (daemon + CLI) may have registered it between check and insert.
        if (!this.db.getDevice(HOST_DEVICE_ID)) throw err;
      }
    }
    this.hostReady = true;
  }

  /**
   * `proposals.invariant_id` is a foreign key into the `invariants` table. The engine's
   * default invariants only ever lived in its in-memory map, so without this the first
   * proposal referencing one would fail the foreign key. registerInvariant() is an
   * idempotent upsert, so this is safe to run once per recorder lifetime.
   */
  public ensureInvariants(): void {
    if (this.invariantsReady) return;
    for (const inv of DEFAULT_INVARIANTS) {
      this.db.registerInvariant({
        invariant_id: inv.id,
        name: inv.name,
        category: inv.category,
        enabled: 1,
      });
    }
    this.invariantsReady = true;
  }

  /**
   * Returns the stored row, or null when skipped (id already recorded, or the same
   * invariant/policy/action was recorded within the cooldown).
   * Throws on non-finite numeric inputs rather than storing guesses.
   * Clocks: row timestamps use `nowMs`; the event `ts_device` and gate `ts` use the gate's `evaluatedAt`.
   */
  public record(policy: InferencePolicy, proposal: ProposalEnvelope, gate: GateDecision): ProposalRecord | null {
    for (const [name, v] of [
      ["estimatedRisk", policy.estimatedRisk],
      ["expectedFreeEnergyScore", policy.expectedFreeEnergyScore],
      ["confidence", proposal.confidence],
      ["evaluatedAt", gate.evaluatedAt],
    ] as const) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new TypeError(`shadow-recorder: ${name} must be a finite number for ${policy.id}`);
      }
    }
    // Synchronous driver: this precheck cannot race with the insert below.
    if (this.db.getProposal(policy.id)) return null;

    const now = this.nowMs();
    const action = canonicalJsonStringify(policy.actionPayload ?? {});
    const dedupeKey = `${policy.invariantId}|${policy.type}|${action}`;
    const last = this.lastRecorded.get(dedupeKey);
    if (last !== undefined && now - last < this.cooldownMs) return null;

    this.ensureHostDevice();
    this.ensureInvariants();
    const { decision, state } = mapGateAction(gate.action);

    const stored = this.db.withTransaction(() => {
      const { event } = this.db.ingestEvent(HOST_DEVICE_ID, {
        event_id: `proposal:${policy.id}`,
        kind: "proposal",
        ts_device: gate.evaluatedAt,
        schema_ver: 1,
        payload: {
          proposal_id: policy.id,
          invariant_id: policy.invariantId,
          policy_type: policy.type,
          summary: policy.title,
          shadow: this.shadow,
        },
      });

      const row: ProposalRecord = {
        proposal_id: policy.id,
        created_seq: event.seq,
        invariant_id: null,
        policy_type: policy.type,
        tier: tierForRisk(policy.estimatedRisk),
        summary: policy.title,
        action,
        action_hash: new Uint8Array(createHash("sha256").update(action).digest()),
        efe: policy.expectedFreeEnergyScore,
        risk_term: policy.estimatedRisk,
        ambiguity_term: Math.min(1, Math.max(0, 1 - proposal.confidence)),
        state,
        shadow: this.shadow ? 1 : 0,
        expires_at: now + this.ttlMs,
        updated_at: now,
      };
      this.db.insertProposal(row);
      this.db.recordGateDecision({
        proposal_id: policy.id,
        mode: gate.mode,
        decision,
        reason: gate.reason,
        ts: gate.evaluatedAt,
      });
      return row;
    });
    this.lastRecorded.set(dedupeKey, now);
    return stored;
  }
}
