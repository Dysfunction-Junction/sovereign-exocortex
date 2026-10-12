import { ApprovalUnavailableError, signApproval, signLabel, type LabelAttestation } from "./approvalKey";
import { submitProposalApproval, submitShadowLabel, type ProposalApprovalResult } from "./api";

export interface IncomingProposal {
  proposalId: string;
  candidateId: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  requiresBiometric: boolean;
  approvalNonce: string;
  expiresAt: number;
  actionPayload?: Record<string, unknown>;
}

export type ProposalState = "pending" | "in_flight" | "approved" | "rejected" | "expired" | "consumed";

export interface TrackedProposal extends IncomingProposal {
  state: ProposalState;
  receivedAt: number;
  consumedAt?: number;
}

class ProposalManager {
  private proposals = new Map<string, TrackedProposal>();
  private listeners = new Set<(proposals: TrackedProposal[]) => void>();

  public getProposals(): TrackedProposal[] {
    this.cleanExpired();
    return Array.from(this.proposals.values());
  }

  public getPending(): TrackedProposal[] {
    this.cleanExpired();
    return Array.from(this.proposals.values()).filter((p) => p.state === "pending");
  }

  public get(proposalId: string): TrackedProposal | null {
    this.cleanExpired();
    return this.proposals.get(proposalId) ?? null;
  }

  public ingestProposal(proposal: IncomingProposal): TrackedProposal {
    this.cleanExpired();
    const existing = this.proposals.get(proposal.proposalId);
    if (existing && existing.state !== "pending") {
      return existing;
    }
    const tracked: TrackedProposal = {
      ...proposal,
      state: "pending",
      receivedAt: Date.now(),
    };
    this.proposals.set(tracked.proposalId, tracked);
    this.notify();
    return tracked;
  }

  public async approve(
    proposalId: string,
    options?: { reason?: string }
  ): Promise<ProposalApprovalResult> {
    this.cleanExpired();
    const item = this.proposals.get(proposalId);
    if (!item) {
      return { ok: false, status: "not_found", error: "Proposal not found or expired" };
    }
    if (item.state === "consumed" || item.state === "approved" || item.state === "in_flight") {
      return { ok: false, status: "already_consumed", error: "Replay prevented: proposal already in flight or consumed" };
    }
    if (item.state === "rejected") {
      return { ok: false, status: "already_rejected", error: "Proposal was previously rejected" };
    }
    if (Date.now() >= item.expiresAt) {
      item.state = "expired";
      this.notify();
      return { ok: false, status: "expired", error: "Proposal TTL expired" };
    }

    // Synchronously consume/lock in-flight state BEFORE any await to prevent race condition
    item.state = "in_flight";
    this.notify();

    // Every approval is signed by the device-bound Keystore key after a fresh biometric. There is no
    // fallback: if the plugin is missing, the key is unregistered, or the user cancels, nothing is sent.
    let attestation: ApprovalAttestation;
    try {
      attestation = await signApproval({ proposalId: item.proposalId, nonce: item.approvalNonce, action: "approve" });
    } catch (err) {
      item.state = "pending"; // allow retry
      this.notify();
      const cancelled = err instanceof ApprovalUnavailableError && err.code === "CANCELLED";
      return {
        ok: false,
        status: cancelled ? "cancelled" : "biometric_unavailable",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let result: ProposalApprovalResult;
    try {
      result = await submitProposalApproval({
        proposalId: item.proposalId,
        nonce: item.approvalNonce,
        action: "approve",
        reason: options?.reason ?? "Approved on mobile glass with biometric confirmation",
        biometricAttestation: attestation,
      });
    } catch (err) {
      item.state = "pending"; // network exception allows retry
      this.notify();
      throw err;
    }

    if (result.ok) {
      item.state = "consumed";
      item.consumedAt = Date.now();
      // No "wanted" tap label from the phone: the daemon records it itself after a verified approve.
    } else {
      // If rejected upstream as expired or nonce mismatch, lock terminal state
      if (result.upstream_status === 404) item.state = "expired";
      else if (result.upstream_status === 403 || result.upstream_status === 409) item.state = "consumed";
      else item.state = "pending"; // transient failure, restore to pending
    }
    this.notify();
    return result;
  }


  public async reject(proposalId: string, reason?: string): Promise<ProposalApprovalResult> {
    this.cleanExpired();
    const item = this.proposals.get(proposalId);
    if (!item) {
      return { ok: false, status: "not_found", error: "Proposal not found or expired" };
    }
    if (item.state !== "pending") {
      return { ok: false, status: "invalid_state", error: `Proposal already ${item.state}` };
    }

    // Lock synchronously (like approve) so a concurrent approve/reject can't
    // submit the same nonce while this request is in flight.
    item.state = "in_flight";
    this.notify();

    // A dismiss counts as a human "tap" label only if signed with a fresh biometric. If the user cancels
    // (or the key is unavailable) the reject still proceeds and its label is sent unsigned, which the
    // daemon stores as "inferred".
    let labelAttestation: LabelAttestation | undefined;
    try {
      labelAttestation = await signLabel({ proposalId: item.proposalId, label: "not_wanted" });
    } catch {
      labelAttestation = undefined;
    }

    let result: ProposalApprovalResult;
    try {
      result = await submitProposalApproval({
        proposalId: item.proposalId,
        nonce: item.approvalNonce,
        action: "reject",
        reason: reason ?? "User rejected on mobile UI",
      });
    } catch (err) {
      item.state = "pending"; // network exception allows retry
      this.notify();
      throw err;
    }

    if (result.ok || result.upstream_status === 404 || result.upstream_status === 409) {
      item.state = "rejected";
      item.consumedAt = Date.now();
      submitShadowLabel(item.proposalId, "not_wanted", {
        source: labelAttestation ? "tap" : "inferred",
        attestation: labelAttestation,
      }).catch(() => {});
    } else {
      item.state = "pending"; // transient upstream failure: the reject did not land, allow retry
    }
    this.notify();
    return result;
  }

  public subscribe(cb: (proposals: TrackedProposal[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private cleanExpired() {
    const now = Date.now();
    let changed = false;
    for (const item of this.proposals.values()) {
      if (item.state === "pending" && now >= item.expiresAt) {
        item.state = "expired";
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  private notify() {
    const list = Array.from(this.proposals.values());
    for (const listener of this.listeners) {
      try {
        listener(list);
      } catch {
        // Safe listener execution
      }
    }
  }

  public clear(): void {
    this.proposals.clear();
    this.notify();
  }
}

export const proposalManager = new ProposalManager();
