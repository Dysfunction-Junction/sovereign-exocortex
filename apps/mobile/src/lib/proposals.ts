import { ApprovalUnavailableError, signApproval, signLabel, type ApprovalAttestation, type LabelAttestation } from "./approvalKey";
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
  shadow?: boolean;
  serverState?: string;
  tier?: number;
  efe?: number;
  updatedAt?: number;
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
    // A re-poll of the same still-pending proposal must not restart the clock the answer latency is measured from.
    const tracked: TrackedProposal = {
      ...proposal,
      state: "pending",
      receivedAt: existing?.receivedAt ?? Date.now(),
    };
    this.proposals.set(tracked.proposalId, tracked);
    this.notify();
    return tracked;
  }

  private checkReplayOrExpiry(item: TrackedProposal): ProposalApprovalResult | null {
    if (item.state === "consumed" || item.state === "approved" || item.state === "in_flight") {
      return { ok: false, status: "already_consumed", error: "This request was already handled." };
    }
    if (item.state === "rejected") {
      return { ok: false, status: "already_rejected", error: "You already said no to this one." };
    }
    if (item.state === "expired" || Date.now() >= item.expiresAt) {
      if (item.state !== "expired") {
        item.state = "expired";
        this.notify();
      }
      return { ok: false, status: "expired", error: "This request timed out and is no longer needed." };
    }
    if (item.state !== "pending") {
      return { ok: false, status: "invalid_state", error: "This request was already handled." };
    }
    return null;
  }

  private async submitDirectLabel(
    proposalId: string,
    label: "wanted" | "not_wanted" | "already_did" | "ignored",
    terminalState: ProposalState,
    okStatus: "approved" | "rejected",
    actual?: Record<string, unknown>,
  ): Promise<ProposalApprovalResult> {
    this.cleanExpired();
    const item = this.proposals.get(proposalId);
    if (!item) {
      return { ok: false, status: "not_found", error: "This request is no longer available." };
    }
    const guard = this.checkReplayOrExpiry(item);
    if (guard) return guard;

    item.state = "in_flight";
    this.notify();

    let labelAttestation: LabelAttestation | undefined;
    try {
      labelAttestation = await signLabel({ proposalId: item.proposalId, label });
    } catch (err) {
      if (err instanceof ApprovalUnavailableError && err.code === "CANCELLED") {
        item.state = "pending";
        this.notify();
        return { ok: false, status: "cancelled", error: "You cancelled the fingerprint or face check, so nothing was done." };
      }
      if (err instanceof ApprovalUnavailableError && (err.code === "NO_KEY" || err.code === "UNAVAILABLE")) {
        labelAttestation = undefined;
      } else {
        item.state = "pending";
        this.notify();
        return { ok: false, status: "error", error: err instanceof Error ? err.message : "The fingerprint or face check did not work, so nothing was done." };
      }
    }

    const latencyMs = Math.max(0, Date.now() - item.receivedAt);
    let result: { ok: boolean; error?: string };
    try {
      result = await submitShadowLabel(item.proposalId, label, {
        source: labelAttestation ? "tap" : "inferred",
        attestation: labelAttestation,
        latencyMs,
        actual,
      });
    } catch (err) {
      item.state = "pending";
      this.notify();
      throw err;
    }

    if (result.ok) {
      item.state = terminalState;
      item.consumedAt = Date.now();
      this.notify();
      return { ok: true, status: okStatus };
    } else {
      item.state = "pending";
      this.notify();
      return { ok: false, status: "error", error: result.error || "Could not save your answer. Please try again." };
    }
  }

  public async labelWanted(proposalId: string): Promise<ProposalApprovalResult> {
    return this.submitDirectLabel(proposalId, "wanted", "approved", "approved");
  }

  public async labelNotWanted(proposalId: string, reason?: string): Promise<ProposalApprovalResult> {
    return this.submitDirectLabel(proposalId, "not_wanted", "rejected", "rejected", reason ? { reason } : undefined);
  }

  public async labelAlreadyDid(proposalId: string): Promise<ProposalApprovalResult> {
    return this.submitDirectLabel(proposalId, "already_did", "consumed", "approved");
  }

  public async labelIgnored(proposalId: string): Promise<ProposalApprovalResult> {
    return this.submitDirectLabel(proposalId, "ignored", "consumed", "rejected");
  }

  public async approve(
    proposalId: string,
    options?: { reason?: string }
  ): Promise<ProposalApprovalResult> {
    this.cleanExpired();
    const item = this.proposals.get(proposalId);
    if (!item) {
      return { ok: false, status: "not_found", error: "This request is no longer available." };
    }
    if (item.shadow) {
      return this.labelWanted(proposalId);
    }
    const guard = this.checkReplayOrExpiry(item);
    if (guard) return guard;

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
      if (
        result.upstream_status === 423 &&
        (result.error?.includes("shadow proposal cannot be approved") ||
          result.error?.includes("shadow mode") ||
          (result as { shadow_mode?: boolean }).shadow_mode)
      ) {
        // Fallback: If server rejects because proposal is shadow, convert to shadow mode and submit shadow label
        item.shadow = true;
        item.state = "pending";
        this.notify();
        return this.labelWanted(proposalId);
      }
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
      return { ok: false, status: "not_found", error: "This request is no longer available." };
    }
    if (item.shadow) {
      return this.labelNotWanted(proposalId, reason);
    }
    const guard = this.checkReplayOrExpiry(item);
    if (guard) return guard;

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
        latencyMs: Math.max(0, Date.now() - item.receivedAt),
      }).catch(() => {});
    } else {
      if (
        result.upstream_status === 423 &&
        (result.error?.includes("shadow proposal cannot be approved") ||
          result.error?.includes("shadow mode") ||
          (result as { shadow_mode?: boolean }).shadow_mode)
      ) {
        item.shadow = true;
        item.state = "pending";
        this.notify();
        return this.labelNotWanted(proposalId, reason);
      }
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
