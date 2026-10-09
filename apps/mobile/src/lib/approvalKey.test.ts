import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config", () => ({
  getConnectionTargets: vi.fn().mockResolvedValue([{ baseUrl: "http://x", token: "tok", mode: "lan" }]),
}));
vi.mock("./jwtDisplay", () => ({ extractDeviceIdFromToken: vi.fn(() => "dev-1") }));
vi.mock("./api", () => ({
  postApprovalKeyChallenge: vi.fn(),
  postApprovalKey: vi.fn(),
}));

import * as api from "./api";
import { ApprovalKey, registerApprovalKey, signLabel, labelMessage, ApprovalUnavailableError } from "./approvalKey";

// registerPlugin is stubbed to {} in test/setup.ts; attach the native methods here.
const native = ApprovalKey as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  native.isAvailable = vi.fn().mockResolvedValue({ available: true, status: 0 });
  native.ensureKey = vi.fn().mockResolvedValue({ publicKeyB64: "cHVi", attestationChain: ["bGVhZg==", "cm9vdA=="] });
  native.sign = vi.fn().mockResolvedValue({ signatureB64: "c2ln" });
  vi.mocked(api.postApprovalKeyChallenge).mockResolvedValue("chal-123");
  vi.mocked(api.postApprovalKey).mockResolvedValue(undefined);
});

describe("signLabel (K1)", () => {
  it("signs exo-label-v1\\n{deviceId}\\n{proposalId}\\n{label}\\n{ts} behind a 'Confirm dismiss' biometric prompt", async () => {
    const before = Date.now();
    const att = await signLabel({ proposalId: "prop-9", label: "not_wanted" });
    expect(att).toEqual({ v: 1, method: "biometric", ts: expect.any(Number), sig: "c2ln" });
    expect(att.ts).toBeGreaterThanOrEqual(before);
    const arg = native.sign.mock.calls[0][0] as { message: string; title: string };
    expect(arg.message).toBe(`exo-label-v1\ndev-1\nprop-9\nnot_wanted\n${att.ts}`);
    expect(arg.message).toBe(labelMessage({ deviceId: "dev-1", proposalId: "prop-9", label: "not_wanted" }, att.ts));
    expect(arg.title).toBe("Confirm dismiss");
  });

  it("throws (never fabricates a signature) when the prompt is cancelled", async () => {
    native.sign.mockRejectedValueOnce({ code: "CANCELLED", message: "Cancel" });
    await expect(signLabel({ proposalId: "p", label: "not_wanted" })).rejects.toMatchObject({
      name: "ApprovalUnavailableError",
      code: "CANCELLED",
    });
  });
});

describe("registerApprovalKey (K2)", () => {
  it("fetches the challenge first, regenerates the key with it as attestation challenge, and posts the chain", async () => {
    const order: string[] = [];
    vi.mocked(api.postApprovalKeyChallenge).mockImplementation(async () => {
      order.push("challenge");
      return "chal-123";
    });
    native.ensureKey.mockImplementation(async () => {
      order.push("ensureKey");
      return { publicKeyB64: "cHVi", attestationChain: ["bGVhZg==", "cm9vdA=="] };
    });

    await registerApprovalKey("  enroll-tok ");

    expect(order).toEqual(["challenge", "ensureKey"]);
    expect(native.ensureKey).toHaveBeenCalledWith({ attestationChallenge: "chal-123" });
    expect((native.sign.mock.calls[0][0] as { message: string }).message).toBe("exo-approval-key-v1\ndev-1\nchal-123");
    expect(api.postApprovalKey).toHaveBeenCalledWith(
      { pubkey_b64: "cHVi", challenge: "chal-123", signature_b64: "c2ln", attestation_chain: ["bGVhZg==", "cm9vdA=="] },
      "enroll-tok"
    );
  });

  it("refuses to register when the phone returns no attestation chain", async () => {
    native.ensureKey.mockResolvedValueOnce({ publicKeyB64: "cHVi", attestationChain: [] });
    await expect(registerApprovalKey("t")).rejects.toBeInstanceOf(ApprovalUnavailableError);
    expect(api.postApprovalKey).not.toHaveBeenCalled();
  });

  it("propagates the daemon's rejection text (e.g. software-only key) so Setup can show it", async () => {
    vi.mocked(api.postApprovalKey).mockRejectedValueOnce(new Error("key is not hardware-backed"));
    await expect(registerApprovalKey("t")).rejects.toThrow("key is not hardware-backed");
  });
});
