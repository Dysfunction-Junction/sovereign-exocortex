import { describe, it, expect, vi, beforeEach } from "vitest";
import { proposalManager, type IncomingProposal } from "./proposals";
import * as api from "./api";
import * as approvalKey from "./approvalKey";

vi.mock("./api", () => ({
  submitProposalApproval: vi.fn(),
  submitShadowLabel: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("./approvalKey", async () => {
  const actual = await vi.importActual<typeof import("./approvalKey")>("./approvalKey");
  return { ...actual, signApproval: vi.fn(), signLabel: vi.fn() };
});

const LABEL_ATTESTATION = { v: 1 as const, method: "biometric" as const, ts: 1_700_000_000_001, sig: "bGFiZWw=", nonce: "label_nonce_test" };
const ATTESTATION = { v: 1 as const, method: "biometric" as const, ts: 1_700_000_000_000, sig: "c2ln" };

describe("proposalManager", () => {
  const baseProposal: IncomingProposal = {
    proposalId: "prop_test_12345",
    candidateId: "cluster-com.android.chrome",
    summary: "Simulated browser history indexing",
    riskLevel: "low",
    requiresBiometric: false,
    approvalNonce: "nonce_abc123456789",
    expiresAt: Date.now() + 60_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(approvalKey.signApproval).mockResolvedValue(ATTESTATION);
    vi.mocked(approvalKey.signLabel).mockResolvedValue(LABEL_ATTESTATION);
    proposalManager.clear();
  });

  it("ingests a proposal in pending state", () => {
    const tracked = proposalManager.ingestProposal(baseProposal);
    expect(tracked.state).toBe("pending");
    expect(proposalManager.get("prop_test_12345")?.state).toBe("pending");
    expect(proposalManager.getPending().length).toBe(1);
  });

  it("approves low-risk proposal and marks it consumed", async () => {
    vi.mocked(api.submitProposalApproval).mockResolvedValueOnce({
      ok: true,
      status: "approved",
      proposal_id: baseProposal.proposalId,
      release: {
        ok: true,
        result: {
          status: "released",
          proposalId: baseProposal.proposalId,
          releasedPayload: { action: "dispatch" },
        },
      },
    });

    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.approve(baseProposal.proposalId);

    expect(result.ok).toBe(true);
    expect(api.submitProposalApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: baseProposal.proposalId,
        nonce: baseProposal.approvalNonce,
        action: "approve",
        biometricAttestation: ATTESTATION,
      })
    );
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("consumed");
    // The daemon records the tap "wanted" label itself after a verified approve.
    expect(api.submitShadowLabel).not.toHaveBeenCalled();
  });

  it("attaches biometric attestation when requiresBiometric is true", async () => {
    const biometricProp: IncomingProposal = {
      ...baseProposal,
      proposalId: "prop_bio_999",
      riskLevel: "high",
      requiresBiometric: true,
      expiresAt: Date.now() + 60_000,
    };

    vi.mocked(api.submitProposalApproval).mockResolvedValueOnce({
      ok: true,
      status: "approved",
      proposal_id: biometricProp.proposalId,
    });

    proposalManager.ingestProposal(biometricProp);
    const result = await proposalManager.approve(biometricProp.proposalId);

    expect(result.ok).toBe(true);
    expect(api.submitProposalApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: biometricProp.proposalId,
        action: "approve",
        biometricAttestation: ATTESTATION,
      })
    );
    expect(approvalKey.signApproval).toHaveBeenCalledWith({
      proposalId: biometricProp.proposalId,
      nonce: biometricProp.approvalNonce,
      action: "approve",
    });
    expect(proposalManager.get(biometricProp.proposalId)?.state).toBe("consumed");
  });

  it("sends nothing and restores pending when the biometric key is unavailable", async () => {
    vi.mocked(approvalKey.signApproval).mockRejectedValueOnce(
      new approvalKey.ApprovalUnavailableError("No approval key registered", "NO_KEY")
    );
    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.approve(baseProposal.proposalId);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("biometric_unavailable");
    expect(api.submitProposalApproval).not.toHaveBeenCalled();
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("pending");
  });

  it("reports a cancelled biometric prompt without sending", async () => {
    vi.mocked(approvalKey.signApproval).mockRejectedValueOnce(
      new approvalKey.ApprovalUnavailableError("cancelled", "CANCELLED")
    );
    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.approve(baseProposal.proposalId);
    expect(result.status).toBe("cancelled");
    expect(api.submitProposalApproval).not.toHaveBeenCalled();
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("pending");
  });

  it("prevents replay attacks on already consumed proposals", async () => {
    vi.mocked(api.submitProposalApproval).mockResolvedValueOnce({
      ok: true,
      status: "approved",
      proposal_id: baseProposal.proposalId,
    });

    proposalManager.ingestProposal(baseProposal);
    await proposalManager.approve(baseProposal.proposalId);

    // Second attempt must fail without calling api again
    const secondResult = await proposalManager.approve(baseProposal.proposalId);
    expect(secondResult.ok).toBe(false);
    expect(secondResult.status).toBe("already_consumed");
    expect(api.submitProposalApproval).toHaveBeenCalledTimes(1);
  });

  it("prevents race condition on concurrent double-submit via synchronous in_flight lock", async () => {
    let resolveApi!: (val: any) => void;
    const apiPromise = new Promise((resolve) => {
      resolveApi = resolve;
    });
    vi.mocked(api.submitProposalApproval).mockImplementation(() => apiPromise as any);

    proposalManager.ingestProposal(baseProposal);

    // First call begins in-flight
    const p1 = proposalManager.approve(baseProposal.proposalId);
    // Concurrent second call before first resolves
    const p2 = proposalManager.approve(baseProposal.proposalId);

    const res2 = await p2;
    expect(res2.ok).toBe(false);
    expect(res2.status).toBe("already_consumed");

    resolveApi({ ok: true, status: "approved" });
    const res1 = await p1;
    expect(res1.ok).toBe(true);
    expect(api.submitProposalApproval).toHaveBeenCalledTimes(1);
  });


  it("fails closed when proposal expires before approval", async () => {
    const expiredProp: IncomingProposal = {
      ...baseProposal,
      proposalId: "prop_expired_1",
      expiresAt: Date.now() - 1000, // already expired
    };

    proposalManager.ingestProposal(expiredProp);
    const result = await proposalManager.approve(expiredProp.proposalId);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("expired");
    expect(api.submitProposalApproval).not.toHaveBeenCalled();
    expect(proposalManager.get(expiredProp.proposalId)?.state).toBe("expired");
  });

  it("rejects proposal and evicts from pending pool", async () => {
    vi.mocked(api.submitProposalApproval).mockResolvedValueOnce({
      ok: true,
      status: "rejected",
      upstream_notified: true,
    });

    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.reject(baseProposal.proposalId, "User dismissed on UI");

    expect(result.ok).toBe(true);
    expect(api.submitProposalApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: baseProposal.proposalId,
        nonce: baseProposal.approvalNonce,
        action: "reject",
      })
    );
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("rejected");
    expect(proposalManager.getPending().length).toBe(0);
    expect(approvalKey.signLabel).toHaveBeenCalledWith({ proposalId: baseProposal.proposalId, label: "not_wanted" });
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      baseProposal.proposalId,
      "not_wanted",
      expect.objectContaining({
        source: "tap",
        attestation: LABEL_ATTESTATION,
      })
    );
  });

  it("still rejects but sends the label unsigned (inferred) when the dismiss biometric is cancelled", async () => {
    vi.mocked(approvalKey.signLabel).mockRejectedValueOnce(
      new approvalKey.ApprovalUnavailableError("cancelled", "CANCELLED")
    );
    vi.mocked(api.submitProposalApproval).mockResolvedValueOnce({ ok: true, status: "rejected" });
    proposalManager.ingestProposal(baseProposal);

    const result = await proposalManager.reject(baseProposal.proposalId);
    expect(result.ok).toBe(true);
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("rejected");
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      baseProposal.proposalId,
      "not_wanted",
      expect.objectContaining({
        source: "inferred",
        attestation: undefined,
      })
    );
  });
  it("locks the proposal in flight during reject so a concurrent approve cannot submit the same nonce", async () => {
    let resolveApi!: (val: any) => void;
    vi.mocked(api.submitProposalApproval).mockImplementation(
      () => new Promise((resolve) => { resolveApi = resolve; }) as any
    );
    proposalManager.ingestProposal(baseProposal);

    const rejectP = proposalManager.reject(baseProposal.proposalId);
    await vi.waitFor(() => expect(api.submitProposalApproval).toHaveBeenCalled());
    const approveRes = await proposalManager.approve(baseProposal.proposalId);
    expect(approveRes.ok).toBe(false);
    expect(approveRes.status).toBe("already_consumed");

    resolveApi({ ok: true, status: "rejected" });
    await rejectP;
    expect(api.submitProposalApproval).toHaveBeenCalledTimes(1);
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("rejected");
  });

  it("does not mark a proposal rejected when the upstream reject failed transiently", async () => {
    vi.mocked(api.submitProposalApproval).mockResolvedValueOnce({
      ok: false,
      status: "release_failed",
      upstream_status: 502,
      error: "HTTP 502",
    });
    proposalManager.ingestProposal(baseProposal);

    const result = await proposalManager.reject(baseProposal.proposalId);
    expect(result.ok).toBe(false);
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("pending");
    expect(api.submitShadowLabel).not.toHaveBeenCalled();
  });

  it("restores pending when the reject request throws", async () => {
    vi.mocked(api.submitProposalApproval).mockRejectedValueOnce(new Error("network down"));
    proposalManager.ingestProposal(baseProposal);

    await expect(proposalManager.reject(baseProposal.proposalId)).rejects.toThrow("network down");
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("pending");
  });

  it("labelWanted submits signed wanted label with biometric attestation", async () => {
    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.labelWanted(baseProposal.proposalId);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("approved");
    expect(approvalKey.signLabel).toHaveBeenCalledWith({ proposalId: baseProposal.proposalId, label: "wanted" });
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      baseProposal.proposalId,
      "wanted",
      expect.objectContaining({
        source: "tap",
        attestation: LABEL_ATTESTATION,
        latencyMs: expect.any(Number),
      })
    );
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("approved");
  });

  it("labelWanted cancels cleanly when biometric prompt is cancelled", async () => {
    vi.mocked(approvalKey.signLabel).mockRejectedValueOnce(
      new approvalKey.ApprovalUnavailableError("user cancelled", "CANCELLED")
    );
    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.labelWanted(baseProposal.proposalId);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(api.submitShadowLabel).not.toHaveBeenCalled();
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("pending");
  });

  it("labelWanted falls back to inferred when biometric key is not registered", async () => {
    vi.mocked(approvalKey.signLabel).mockRejectedValueOnce(
      new approvalKey.ApprovalUnavailableError("No approval key registered", "NO_KEY")
    );
    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.labelWanted(baseProposal.proposalId);

    expect(result.ok).toBe(true);
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      baseProposal.proposalId,
      "wanted",
      expect.objectContaining({
        source: "inferred",
        attestation: undefined,
      })
    );
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("approved");
  });

  it("labelNotWanted submits signed not_wanted label directly without network/approve", async () => {
    proposalManager.ingestProposal(baseProposal);
    const result = await proposalManager.labelNotWanted(baseProposal.proposalId, "Not needed");

    expect(result.ok).toBe(true);
    expect(result.status).toBe("rejected");
    expect(api.submitProposalApproval).not.toHaveBeenCalled();
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      baseProposal.proposalId,
      "not_wanted",
      expect.objectContaining({
        source: "tap",
        attestation: LABEL_ATTESTATION,
        latencyMs: expect.any(Number),
      })
    );
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("rejected");
  });

  it("approve() automatically delegates to labelWanted when proposal has shadow: true", async () => {
    const shadowProp: IncomingProposal = {
      ...baseProposal,
      proposalId: "prop_shadow_123",
      shadow: true,
    };
    proposalManager.ingestProposal(shadowProp);
    const result = await proposalManager.approve(shadowProp.proposalId);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("approved");
    expect(api.submitProposalApproval).not.toHaveBeenCalled();
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      shadowProp.proposalId,
      "wanted",
      expect.objectContaining({
        source: "tap",
        attestation: LABEL_ATTESTATION,
      })
    );
  });

  it("reject() automatically delegates to labelNotWanted when proposal has shadow: true", async () => {
    const shadowProp: IncomingProposal = {
      ...baseProposal,
      proposalId: "prop_shadow_456",
      shadow: true,
    };
    proposalManager.ingestProposal(shadowProp);
    const result = await proposalManager.reject(shadowProp.proposalId, "Irrelevant suggestion");

    expect(result.ok).toBe(true);
    expect(result.status).toBe("rejected");
    expect(api.submitProposalApproval).not.toHaveBeenCalled();
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      shadowProp.proposalId,
      "not_wanted",
      expect.objectContaining({
        source: "tap",
        attestation: LABEL_ATTESTATION,
      })
    );
  });

  it("approve() falls back to labelWanted when server rejects with 423 shadow error", async () => {
    const liveLookingProp: IncomingProposal = {
      ...baseProposal,
      proposalId: "prop_skew_789",
      shadow: false,
    };
    vi.mocked(api.submitProposalApproval).mockResolvedValueOnce({
      ok: false,
      status: "release_failed",
      upstream_status: 423,
      error: "shadow proposal cannot be approved, even when live actuation is enabled",
    });

    proposalManager.ingestProposal(liveLookingProp);
    const result = await proposalManager.approve(liveLookingProp.proposalId);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("approved");
    expect(proposalManager.get(liveLookingProp.proposalId)?.shadow).toBe(true);
    expect(api.submitShadowLabel).toHaveBeenCalledWith(
      liveLookingProp.proposalId,
      "wanted",
      expect.objectContaining({
        source: "tap",
        attestation: LABEL_ATTESTATION,
      })
    );
  });
});
