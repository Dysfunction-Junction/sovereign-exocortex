// GET /v3/proposals/pending support.
//
// Approval nonces are minted by registry-app's in-memory DryRunCache (:39403) and exist nowhere else; they are
// never persisted in the v3 DB. The only existing registry action that lists the cache (`cache_status`) omits the
// nonce, so this asks registry-app for action `pending_proposals` through the existing forwardDelegate path. If
// the registry does not implement it (HTTP 400), no proposal can carry a nonce and the list is empty (fail closed).

import type { ExocortexDatabase } from "@exocortex/core/db";
import { forwardDelegate, GATEWAY_NODE, type DelegateEnvelope } from "./network.js";
import { HOST_DEVICE_ID } from "./shadow-recorder.js";

export interface RegistryPending {
  proposalId: string;
  candidateId?: string;
  summary?: string;
  riskLevel?: string;
  approvalNonce: string;
  expiresAt: number | string;
  actionPayload?: Record<string, unknown>;
}

export type PendingFetcher = () => Promise<RegistryPending[]>;

export const defaultPendingFetcher: PendingFetcher = async () => {
  const envelope: DelegateEnvelope = {
    v: 1,
    id: `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: GATEWAY_NODE,
    to: "registry-app",
    capability: "staging",
    action: "pending_proposals",
    payload: {},
  };
  const out = await forwardDelegate(envelope);
  if (out.status !== 200 || !out.body || typeof out.body !== "object") return [];
  const body = out.body as { ok?: boolean; result?: { proposals?: unknown } };
  if (body.ok !== true || !Array.isArray(body.result?.proposals)) return [];
  return body.result!.proposals as RegistryPending[];
};

/**
 * Ask registry-app to mint (or return) the approval nonce for one of OUR proposals, keyed by our id.
 * Idempotent on the registry side: a live entry keeps its nonce, so polling never rotates it.
 */
export interface SpeculateRequest {
  proposalId: string;
  candidateId: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  actionPayload: Record<string, unknown>;
  ttlMs: number;
}
export type Speculator = (req: SpeculateRequest) => Promise<void>;

export const defaultSpeculator: Speculator = async (req) => {
  const envelope: DelegateEnvelope = {
    v: 1,
    id: `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: GATEWAY_NODE,
    to: "registry-app",
    capability: "staging",
    action: "speculate",
    payload: { ...req },
  };
  await forwardDelegate(envelope);
};

const MAX_SPECULATIONS_PER_POLL = 20;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 10 * 60 * 1000;

interface BatchPosition {
  batchId: string;
  position: number;
}

/** Reorder only occupied slots of the same recorded host batch; never trust registry/client scores. */
function orderRecordedBatches<T>(db: ExocortexDatabase, items: T[], idOf: (item: T) => string): T[] {
  const cache = new Map<string, BatchPosition | null>();
  const invalidBatches = new Set<string>();
  const positionOf = (id: string): BatchPosition | null => {
    if (cache.has(id)) return cache.get(id)!;
    let result: BatchPosition | null = null;
    try {
      const row = db.getProposal(id);
      const event = row && db.getEventBySeq(row.created_seq);
      if (row && event?.kind === "proposal" && event.device_id === HOST_DEVICE_ID) {
        const payload = JSON.parse(event.payload);
        const ranking = payload.ranking;
        const action = parseActionPayload(row.action);
        if (payload.proposal_id === id && payload.policy_type === row.policy_type
          && typeof payload.invariant_id === "string"
          && payload.invariant_id === (row.invariant_id ?? action.invariantId)
          && ranking?.version === 1 && typeof ranking.batchId === "string" && ranking.batchId) {
          if (Number.isSafeInteger(ranking.position) && ranking.position >= 0) {
            result = { batchId: ranking.batchId, position: ranking.position };
          } else {
            invalidBatches.add(ranking.batchId);
          }
        }
      }
    } catch {
      // Old, malformed or unavailable records keep their original slots.
    }
    cache.set(id, result);
    return result;
  };
  const groups = new Map<string, Array<{ index: number; item: T; position: number }>>();
  items.forEach((item, index) => {
    const ranking = positionOf(idOf(item));
    if (!ranking) return;
    const anchor = positionOf(ranking.batchId);
    if (!anchor || anchor.batchId !== ranking.batchId || anchor.position !== 0) return;
    const group = groups.get(ranking.batchId) ?? [];
    group.push({ index, item, position: ranking.position });
    groups.set(ranking.batchId, group);
  });
  const ordered = [...items];
  for (const [batchId, group] of groups) {
    if (invalidBatches.has(batchId) || new Set(group.map((entry) => entry.position)).size !== group.length) continue;
    const sorted = [...group].sort((a, b) => a.position - b.position);
    group.forEach((entry, index) => { ordered[entry.index] = sorted[index].item; });
  }
  return ordered;
}

function parseActionPayload(action: string): Record<string, unknown> {
  try {
    const v = JSON.parse(action);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Speculate every live SURFACED/STAGED proposal so each has a nonce to list. Failures are non-fatal. */
export async function ensureSpeculated(db: ExocortexDatabase, speculator: Speculator, now: number): Promise<void> {
  const rows = orderRecordedBatches(db, db.listProposalsByState(["SURFACED", "STAGED"], now), (row) => row.proposal_id)
    .slice(0, MAX_SPECULATIONS_PER_POLL);
  for (const row of rows) {
    const ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, row.expires_at - now));
    try {
      await speculator({
        proposalId: row.proposal_id,
        candidateId: row.invariant_id ?? row.policy_type,
        summary: row.summary,
        riskLevel: riskFrom(undefined, row.risk_term),
        actionPayload: parseActionPayload(row.action),
        ttlMs,
      });
    } catch {
      // registry-app down: nothing to list for this proposal (fail closed)
    }
  }
}

function toMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

function riskFrom(reg: string | undefined, riskTerm: number): "low" | "medium" | "high" {
  if (reg === "low" || reg === "medium" || reg === "high") return reg;
  return riskTerm < 0.33 ? "low" : riskTerm < 0.66 ? "medium" : "high";
}

export interface PendingProposal {
  proposalId: string;
  candidateId: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  requiresBiometric: boolean;
  approvalNonce: string;
  expiresAt: number;
  actionPayload?: Record<string, unknown>;
  shadow?: boolean;
}

export async function buildPendingProposals(
  db: ExocortexDatabase,
  fetcher: PendingFetcher = defaultPendingFetcher,
  now = Date.now(),
  speculator: Speculator | null = null,
): Promise<PendingProposal[]> {
  if (speculator) await ensureSpeculated(db, speculator, now);
  let reg: RegistryPending[] = [];
  try {
    reg = await fetcher();
  } catch {
    return [];
  }
  const out: PendingProposal[] = [];
  for (const r of reg) {
    if (!r || typeof r.proposalId !== "string" || typeof r.approvalNonce !== "string" || !r.approvalNonce) continue;
    const row = db.getProposal(r.proposalId);
    if (!row || (row.state !== "SURFACED" && row.state !== "STAGED")) continue;
    const regExp = toMs(r.expiresAt);
    if (!Number.isFinite(regExp)) continue;
    const expiresAt = Math.min(row.expires_at, regExp);
    if (expiresAt <= now) continue;
    out.push({
      proposalId: row.proposal_id,
      candidateId: typeof r.candidateId === "string" ? r.candidateId : row.invariant_id ?? row.proposal_id,
      summary: typeof r.summary === "string" && r.summary ? r.summary : row.summary,
      riskLevel: riskFrom(r.riskLevel, row.risk_term),
      requiresBiometric: true,
      approvalNonce: r.approvalNonce,
      expiresAt,
      ...(r.actionPayload && typeof r.actionPayload === "object" ? { actionPayload: r.actionPayload } : {}),
    });
  }
  return orderRecordedBatches(db, out, (item) => item.proposalId);
}
