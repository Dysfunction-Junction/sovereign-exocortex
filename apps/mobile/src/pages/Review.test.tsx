import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import Review from "./Review";
import type { PendingProposal } from "../lib/api";

const mockGetPendingShadowProposals = vi.fn();
const mockLabelWanted = vi.fn();
const mockLabelNotWanted = vi.fn();
const mockLabelAlreadyDid = vi.fn();
const mockLabelIgnored = vi.fn();
const mockNavigate = vi.fn();

let mockProposals: any[] = [];
let listeners: Array<() => void> = [];

vi.mock("react-router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("../lib/api", () => ({
  getPendingShadowProposals: () => mockGetPendingShadowProposals(),
  ProxyNotConfiguredError: class extends Error {},
  HomeNodeUnreachableError: class extends Error {},
}));

vi.mock("../lib/fireAndForget", () => ({
  fireAndForget: (p: Promise<any>) => void p,
  recordEventSafe: vi.fn(),
}));

vi.mock("../lib/flush", () => ({
  flushUsageEvents: vi.fn(),
}));

vi.mock("../lib/proposals", () => ({
  proposalManager: {
    getProposals: () => mockProposals,
    ingestProposal: vi.fn((p) => {
      const existing = mockProposals.find((x) => x.proposalId === p.proposalId);
      if (!existing) {
        mockProposals.push({ ...p, state: "pending", receivedAt: Date.now() });
      }
    }),
    subscribe: (fn: () => void) => {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    labelWanted: (...args: any[]) => mockLabelWanted(...args),
    labelNotWanted: (...args: any[]) => mockLabelNotWanted(...args),
    labelAlreadyDid: (...args: any[]) => mockLabelAlreadyDid(...args),
    labelIgnored: (...args: any[]) => mockLabelIgnored(...args),
  },
}));

describe("Review page", () => {
  const sampleProposals: PendingProposal[] = [
    {
      proposalId: "prop_surfaced_1",
      candidateId: "inv_clean_test_suite",
      summary: "Run automated self-heal test suite probe",
      riskLevel: "low",
      requiresBiometric: false,
      approvalNonce: "nonce-1",
      expiresAt: Date.now() + 3600000,
      shadow: true,
      state: "SURFACED",
      efe: 0.85,
    },
    {
      proposalId: "prop_gated_2",
      candidateId: "inv_bridge_connected",
      summary: "Silent dry-run auto-reconnect phone bridge",
      riskLevel: "medium",
      requiresBiometric: false,
      approvalNonce: "nonce-2",
      expiresAt: Date.now() + 3600000,
      shadow: true,
      state: "GATED",
      efe: 0.62,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockProposals = [];
    listeners = [];
    mockLabelWanted.mockResolvedValue({ ok: true, status: "approved" });
    mockLabelNotWanted.mockResolvedValue({ ok: true, status: "rejected" });
    mockLabelAlreadyDid.mockResolvedValue({ ok: true, status: "approved" });
    mockLabelIgnored.mockResolvedValue({ ok: true, status: "rejected" });
  });

  test("renders shadow proposals and filter badges", async () => {
    mockGetPendingShadowProposals.mockResolvedValueOnce(sampleProposals);

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText("Daily Shadow Review")).toBeTruthy();
      expect(screen.getByText(/2 Shadow Proposals to Review/i)).toBeTruthy();
    });

    // Both SURFACED and GATED are rendered
    expect(screen.getByText("Run automated self-heal test suite probe")).toBeTruthy();
    expect(screen.getByText("Silent dry-run auto-reconnect phone bridge")).toBeTruthy();
    expect(screen.getByText("GATED")).toBeTruthy();
    expect(screen.getByText("SURFACED")).toBeTruthy();
  });

  test("one-tap Wanted label calls proposalManager.labelWanted", async () => {
    mockGetPendingShadowProposals.mockResolvedValueOnce(sampleProposals);

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText("Run automated self-heal test suite probe")).toBeTruthy();
    });

    const wantedButtons = screen.getAllByRole("button", { name: /Wanted/i });
    fireEvent.click(wantedButtons[0]);

    await waitFor(() => {
      expect(mockLabelWanted).toHaveBeenCalledWith("prop_surfaced_1");
      expect(screen.getByText(/Marked as Wanted/i)).toBeTruthy();
    });
  });

  test("one-tap Not Wanted reveals reason presets and records reason", async () => {
    mockGetPendingShadowProposals.mockResolvedValueOnce(sampleProposals);

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText("Silent dry-run auto-reconnect phone bridge")).toBeTruthy();
    });

    const notWantedButtons = screen.getAllByRole("button", { name: /Not Wanted/i });
    fireEvent.click(notWantedButtons[1]);

    await waitFor(() => {
      expect(screen.getByText(/Why is this not wanted/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Wrong time" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Already did" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Wrong time" }));

    await waitFor(() => {
      expect(mockLabelNotWanted).toHaveBeenCalledWith("prop_gated_2", "Wrong time");
      expect(screen.getByText(/Not Wanted \(Wrong time\)/i)).toBeTruthy();
    });
  });

  test("Already Did button calls proposalManager.labelAlreadyDid", async () => {
    mockGetPendingShadowProposals.mockResolvedValueOnce(sampleProposals);

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText("Run automated self-heal test suite probe")).toBeTruthy();
    });

    const alreadyDidButtons = screen.getAllByRole("button", { name: "Already Did" });
    fireEvent.click(alreadyDidButtons[0]);

    await waitFor(() => {
      expect(mockLabelAlreadyDid).toHaveBeenCalledWith("prop_surfaced_1");
      expect(screen.getByText(/Marked as Already Done/i)).toBeTruthy();
    });
  });

  test("filters proposals by Gated and Surfaced tabs", async () => {
    mockGetPendingShadowProposals.mockResolvedValueOnce(sampleProposals);

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText("Run automated self-heal test suite probe")).toBeTruthy();
    });

    // Click Gated filter tab
    const gatedTab = screen.getByRole("button", { name: /Gated \(1\)/i });
    fireEvent.click(gatedTab);

    expect(screen.queryByText("Run automated self-heal test suite probe")).toBeNull();
    expect(screen.getByText("Silent dry-run auto-reconnect phone bridge")).toBeTruthy();

    // Click Surfaced filter tab
    const surfacedTab = screen.getByRole("button", { name: /Surfaced \(1\)/i });
    fireEvent.click(surfacedTab);

    expect(screen.getByText("Run automated self-heal test suite probe")).toBeTruthy();
    expect(screen.queryByText("Silent dry-run auto-reconnect phone bridge")).toBeNull();
  });

  test("renders empty caught-up state when no proposals exist", async () => {
    mockGetPendingShadowProposals.mockResolvedValueOnce([]);

    render(<Review />);

    await waitFor(() => {
      expect(screen.getByText("All Caught Up!")).toBeTruthy();
      expect(screen.getByText(/No shadow proposals are currently waiting/i)).toBeTruthy();
    });
  });
});
