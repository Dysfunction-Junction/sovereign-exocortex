import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";

function nonceMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface SpeculativeProposal {
  proposalId: string;
  candidateId: string;
  actionPayload: Record<string, unknown>;
  summary: string;
  createdAt: number;
  expiresAt: number;
  approvalNonce: string;
  status: "dry_run_ready" | "released";
}

export const MAX_CACHE_SIZE = 100;
export const DEFAULT_TTL_MS = 60_000;

export class DryRunCache {
  private cache = new Map<string, SpeculativeProposal>();

  private prune() {
    const now = Date.now();
    for (const [id, item] of this.cache.entries()) {
      if (item.expiresAt <= now) {
        this.cache.delete(id);
      }
    }
    while (this.cache.size > MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
      else break;
    }
  }

  set(
    candidateId: string,
    actionPayload: Record<string, unknown>,
    summary: string,
    ttlMs: number = DEFAULT_TTL_MS
  ): SpeculativeProposal {
    this.prune();
    const now = Date.now();
    const proposal: SpeculativeProposal = {
      proposalId: `prop_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      candidateId,
      actionPayload,
      summary,
      createdAt: now,
      expiresAt: now + (ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS),
      approvalNonce: randomBytes(16).toString("hex"),
      status: "dry_run_ready",
    };
    this.cache.set(proposal.proposalId, proposal);
    return proposal;
  }

  get(proposalId: string): SpeculativeProposal | null {
    this.prune();
    const item = this.cache.get(proposalId);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.cache.delete(proposalId);
      return null;
    }
    return item;
  }

  release(
    proposalId: string,
    nonce: string
  ): { ok: true; proposal: SpeculativeProposal } | { ok: false; error: string; code: number } {
    this.prune();
    const item = this.cache.get(proposalId);
    if (!item || item.expiresAt <= Date.now()) {
      if (item) this.cache.delete(proposalId);
      return { ok: false, error: "proposal expired or not found", code: 404 };
    }
    if (!nonceMatches(item.approvalNonce, nonce)) {
      return { ok: false, error: "invalid approval nonce", code: 403 };
    }
    this.cache.delete(proposalId);
    item.status = "released";
    return { ok: true, proposal: item };
  }

  status() {
    this.prune();
    return {
      size: this.cache.size,
      maxSize: MAX_CACHE_SIZE,
      proposals: Array.from(this.cache.values()).map((p) => ({
        proposalId: p.proposalId,
        candidateId: p.candidateId,
        expiresAt: new Date(p.expiresAt).toISOString(),
        status: p.status,
      })),
    };
  }

  isExpired(proposal: SpeculativeProposal): boolean {
    return proposal.expiresAt <= Date.now();
  }

  clearProposal(proposalId: string): boolean {
    return this.cache.delete(proposalId);
  }

  clear() {
    this.cache.clear();
  }
}

export const defaultDryRunCache = new DryRunCache();
