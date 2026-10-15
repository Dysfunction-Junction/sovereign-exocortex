import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AmbientGraphHud } from "./AmbientGraphHud";
import type { LivingGraphStatus } from "../lib/api";

const mockGetLivingGraphContext = vi.fn();

vi.mock("../lib/api", () => ({
  getLivingGraphContext: (...args: any[]) => mockGetLivingGraphContext(...args),
}));

const SAMPLE_GRAPH_STATUS: LivingGraphStatus = {
  cognitiveMode: "DEEP_FOCUS",
  entityCount: 42,
  edgeCount: 108,
  context: {
    eventId: "ev-test-123",
    timestamp: 1729000000000,
    matchedEntities: [
      { id: "person_michael", name: "Michael", type: "PERSON", activation: 0.95 },
    ],
    activatedEntities: [
      { id: "person_michael", name: "Michael", type: "PERSON", activation: 0.95 },
      { id: "project_sovereign_exocortex", name: "Sovereign Exocortex", type: "PROJECT", activation: 0.88 },
      { id: "goal_100_percent_tests_pass", name: "100% Tests Pass", type: "GOAL", activation: 0.82 },
    ],
    predictedNextStates: ["code_verification_passed", "deployment_initiated"],
    recommendedActions: [
      "Keep deep focus active during testing",
      "Stash ephemeral artifacts before git commit",
    ],
  },
};

describe("AmbientGraphHud component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLivingGraphContext.mockResolvedValue(SAMPLE_GRAPH_STATUS);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders with initial status properly", () => {
    render(<AmbientGraphHud initialStatus={SAMPLE_GRAPH_STATUS} autoPoll={false} />);

    expect(screen.getByText("Ambient Living Graph HUD")).toBeTruthy();
    expect(screen.getByTestId("cognitive-mode-badge").textContent).toBe("DEEP_FOCUS");
    expect(screen.getByTestId("graph-size-badge").textContent).toBe("42 entities · 108 edges");

    // Check activated entities
    expect(screen.getByText("Michael")).toBeTruthy();
    expect(screen.getByText("Sovereign Exocortex")).toBeTruthy();
    expect(screen.getByText("100% Tests Pass")).toBeTruthy();

    // Check recommended actions
    expect(screen.getByText("Keep deep focus active during testing")).toBeTruthy();
    expect(screen.getByText("Stash ephemeral artifacts before git commit")).toBeTruthy();

    // Check predicted next states
    expect(screen.getByText("→ code_verification_passed")).toBeTruthy();
    expect(screen.getByText("→ deployment_initiated")).toBeTruthy();
  });

  it("fetches status on mount when initialStatus is not provided", async () => {
    render(<AmbientGraphHud autoPoll={false} />);

    expect(screen.getByTestId("ambient-graph-hud-loading")).toBeTruthy();

    await waitFor(() => {
      expect(mockGetLivingGraphContext).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("ambient-graph-hud")).toBeTruthy();
      expect(screen.getByTestId("cognitive-mode-badge").textContent).toBe("DEEP_FOCUS");
    });
  });

  it("handles offline or fetch error gracefully with retry", async () => {
    mockGetLivingGraphContext.mockRejectedValue(new Error("Graph service offline"));

    render(<AmbientGraphHud autoPoll={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("ambient-graph-hud-error")).toBeTruthy();
      expect(screen.getByText("Graph service offline")).toBeTruthy();
    });

    mockGetLivingGraphContext.mockResolvedValueOnce(SAMPLE_GRAPH_STATUS);
    fireEvent.click(screen.getByRole("button", { name: "Retry Sync" }));

    await waitFor(() => {
      expect(screen.getByTestId("ambient-graph-hud")).toBeTruthy();
    });
  });

  it("refresh button triggers manual sync", async () => {
    render(<AmbientGraphHud initialStatus={SAMPLE_GRAPH_STATUS} autoPoll={false} />);

    const refreshBtn = screen.getByTestId("graph-hud-refresh-btn");
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(mockGetLivingGraphContext).toHaveBeenCalledTimes(1);
    });
  });
});
