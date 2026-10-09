import { describe, it, expect, vi, beforeEach } from "vitest";
import { proposalManager, type IncomingProposal } from "./proposals";
import * as api from "./api";

vi.mock("./api", () => ({
  submitProposalApproval: vi.fn(),
  submitShadowLabel: vi.fn().mockResolvedValue({ ok: true }),
}));

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
        biometricAttestation: undefined,
      })
    );
    expect(proposalManager.get(baseProposal.proposalId)?.state).toBe("consumed");
    expect(api.submitShadowLabel).toHaveBeenCalledWith(baseProposal.proposalId, "wanted", { source: "tap" });
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
    const result = await proposalManager.approve(biometricProp.proposalId, {
      biometricMethod: "fingerprint",
    });

    expect(result.ok).toBe(true);
    expect(api.submitProposalApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: biometricProp.proposalId,
        action: "approve",
        biometricAttestation: expect.objectContaining({
          method: "fingerprint",
          signature: expect.stringContaining("attest_sig_prop_bio_999"),
        }),
      })
    );
    expect(proposalManager.get(biometricProp.proposalId)?.state).toBe("consumed");
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
    expect(api.submitShadowLabel).toHaveBeenCalledWith(baseProposal.proposalId, "not_wanted", { source: "tap" });
  });
  it("locks the proposal in flight during reject so a concurrent approve cannot submit the same nonce", async () => {
    let resolveApi!: (val: any) => void;
    vi.mocked(api.submitProposalApproval).mockImplementation(
      () => new Promise((resolve) => { resolveApi = resolve; }) as any
    );
    proposalManager.ingestProposal(baseProposal);

    const rejectP = proposalManager.reject(baseProposal.proposalId);
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
});
