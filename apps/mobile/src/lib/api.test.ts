import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config", () => ({
  getConnectionTargets: vi.fn().mockResolvedValue([{ baseUrl: "http://pc:1", token: "t", mode: "lan" }]),
}));

import { getPendingProposals, postPushToken, submitShadowLabel, postApprovalKey } from "./api";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api contracts", () => {
  it("getPendingProposals GETs /v3/proposals/pending and drops malformed rows", async () => {
    fetchMock.mockResolvedValue(
      json({
        ok: true,
        proposals: [
          { proposalId: "a", candidateId: "c", summary: "s", riskLevel: "high", requiresBiometric: true, approvalNonce: "n", expiresAt: 5 },
          { proposalId: "bad" },
        ],
      })
    );
    const out = await getPendingProposals();
    expect(fetchMock.mock.calls[0][0]).toBe("http://pc:1/v3/proposals/pending");
    expect(out.map((p) => p.proposalId)).toEqual(["a"]);
  });

  it("getPendingProposals throws on HTTP errors", async () => {
    fetchMock.mockResolvedValue(json({}, 404));
    await expect(getPendingProposals()).rejects.toThrow(/404/);
  });

  it("postPushToken sends {token, platform:'fcm'}", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await postPushToken("tok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://pc:1/v3/devices/push-token");
    expect(JSON.parse(init.body)).toEqual({ token: "tok", platform: "fcm" });
  });

  it("submitShadowLabel includes the attestation when given", async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    const attestation = { v: 1 as const, method: "biometric" as const, ts: 1, sig: "s" };
    await submitShadowLabel("p1", "not_wanted", { source: "tap", attestation });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ proposal_id: "p1", label: "not_wanted", source: "tap", attestation });
  });

  it("postApprovalKey posts attestation_chain and surfaces the server error text", async () => {
    fetchMock.mockResolvedValue(json({ error: "software-only key rejected" }, 400));
    await expect(
      postApprovalKey({ pubkey_b64: "k", challenge: "c", signature_b64: "s", attestation_chain: ["x"] }, "enroll")
    ).rejects.toThrow("software-only key rejected");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).attestation_chain).toEqual(["x"]);
    expect(init.headers["X-Enroll-Token"]).toBe("enroll");
  });
});
