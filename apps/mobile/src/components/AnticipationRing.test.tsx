import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { AnticipationRing } from "./AnticipationRing";
import type { PreCognitiveStatus, PreCognitiveCalibrateResult } from "../lib/api";

const mockGetPrecognitiveStatus = vi.fn();
const mockSendPrecognitiveTelemetry = vi.fn();
const mockCalibratePrecognitive = vi.fn();

vi.mock("../lib/api", () => ({
  getPrecognitiveStatus: (...args: any[]) => mockGetPrecognitiveStatus(...args),
  sendPrecognitiveTelemetry: (...args: any[]) => mockSendPrecognitiveTelemetry(...args),
  calibratePrecognitive: (...args: any[]) => mockCalibratePrecognitive(...args),
}));

const SAMPLE_STATUS: PreCognitiveStatus = {
  deviceId: "pixel-9-pro",
  wakeThresholdMs: 410,
  urgencyIntent: "CASUAL",
  wakeupLatencyMs: 385,
  hesitationScore: 0.2,
  isPreStaged: false,
  calibrated: true,
  sampleCount: 18,
  source: "device",
};

describe("AnticipationRing component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPrecognitiveStatus.mockResolvedValue(SAMPLE_STATUS);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders with initial status correctly", () => {
    render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

    expect(screen.getByText("Pre-Cognitive Dynamic Wake")).toBeTruthy();
    expect(screen.getByText("device")).toBeTruthy();
    expect(screen.getByText("Calibrated (18)")).toBeTruthy();
    expect(screen.getByTestId("urgency-badge").textContent).toBe("CASUAL");
    expect(screen.getByTestId("wake-threshold").textContent).toBe("410ms");
    expect(screen.getByTestId("readiness-score").textContent).toBe("80%");
  });

  it("fetches status on mount when no initialStatus is provided", async () => {
    render(<AnticipationRing autoPoll={false} />);

    expect(screen.getByText("Initializing Obsidian Glass anticipation ring...")).toBeTruthy();
    await waitFor(() => {
      expect(mockGetPrecognitiveStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Calibrated (18)")).toBeTruthy();
      expect(screen.getByTestId("urgency-badge").textContent).toBe("CASUAL");
    });
  });

  it("renders PREPARED urgency styling and readiness properly", () => {
    const preparedStatus: PreCognitiveStatus = {
      ...SAMPLE_STATUS,
      urgencyIntent: "PREPARED",
      hesitationScore: 0.1,
      wakeThresholdMs: 320,
    };

    render(<AnticipationRing initialStatus={preparedStatus} autoPoll={false} />);

    const badge = screen.getByTestId("urgency-badge");
    expect(badge.textContent).toBe("PREPARED");
    expect(screen.getByTestId("wake-threshold").textContent).toBe("320ms");
    expect(screen.getByTestId("readiness-score").textContent).toBe("90%");
  });

  it("renders HIGH_URGENCY and pre-staged indicator with urgent pulse animation class", () => {
    const urgentStatus: PreCognitiveStatus = {
      ...SAMPLE_STATUS,
      urgencyIntent: "HIGH_URGENCY",
      hesitationScore: 0.0,
      isPreStaged: true,
      preStagedProposalId: "prop-urgent-99",
      wakeThresholdMs: 250,
    };

    render(<AnticipationRing initialStatus={urgentStatus} autoPoll={false} />);

    expect(screen.getByTestId("urgency-badge").textContent).toBe("HIGH_URGENCY");
    expect(screen.getByText("PRE-STAGED")).toBeTruthy();
    expect(screen.getByTestId("readiness-score").textContent).toBe("100%");

    const card = screen.getByTestId("anticipation-ring-card");
    const urgentPulse = card.querySelector(".anticipation-ring-pulse.urgent");
    expect(urgentPulse).not.toBeNull();
  });

  it("dispatches telemetry on dwell probe press & release", async () => {
    const updatedStatus: PreCognitiveStatus = {
      ...SAMPLE_STATUS,
      urgencyIntent: "PREPARED",
      hesitationScore: 0.08,
      wakeThresholdMs: 340,
    };
    mockSendPrecognitiveTelemetry.mockResolvedValue(updatedStatus);

    render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

    const probeTarget = screen.getByTestId("dwell-probe-target");
    expect(probeTarget.textContent).toContain("Hold probe target to measure touch dwell");

    // Pointer down
    fireEvent.pointerDown(probeTarget);
    expect(probeTarget.textContent).toContain("Recording Dwell");

    // Pointer up commits dwell telemetry
    fireEvent.pointerUp(probeTarget);

    expect(mockSendPrecognitiveTelemetry).toHaveBeenCalledTimes(1);
    const callArg = mockSendPrecognitiveTelemetry.mock.calls[0][0];
    expect(callArg.dwell_ms).toBeGreaterThanOrEqual(1);
    expect(callArg.touch_duration_ms).toBeGreaterThanOrEqual(1);

    await waitFor(() => {
      expect(screen.getByTestId("urgency-badge").textContent).toBe("PREPARED");
      expect(screen.getByTestId("wake-threshold").textContent).toBe("340ms");
    });
  });

  it("discards dwell measurement on pointercancel or pointerleave without sending telemetry", () => {
    render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

    const probeTarget = screen.getByTestId("dwell-probe-target");

    // Pointer down followed by pointercancel (e.g. scroll gesture)
    fireEvent.pointerDown(probeTarget);
    fireEvent.pointerCancel(probeTarget);

    expect(mockSendPrecognitiveTelemetry).not.toHaveBeenCalled();
    expect(probeTarget.textContent).toContain("Hold probe target to measure touch dwell");

    // Pointer down followed by pointerleave
    fireEvent.pointerDown(probeTarget);
    fireEvent.pointerLeave(probeTarget);

    expect(mockSendPrecognitiveTelemetry).not.toHaveBeenCalled();
  });

  it("Probe Pulse button triggers telemetry with simulated dwell and synthetic marker", async () => {
    const pulseUpdated: PreCognitiveStatus = {
      ...SAMPLE_STATUS,
      urgencyIntent: "PREPARED",
      hesitationScore: 0.05,
    };
    mockSendPrecognitiveTelemetry.mockResolvedValue(pulseUpdated);

    render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

    const probeBtn = screen.getByTestId("probe-pulse-btn");
    fireEvent.click(probeBtn);

    expect(mockSendPrecognitiveTelemetry).toHaveBeenCalledWith({
      dwell_ms: 125,
      vibration: false,
      synthetic: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("urgency-badge").textContent).toBe("PREPARED");
    });
  });

  it("Calibrate button displays error when calibratePrecognitive returns error", async () => {
    const errorResult: PreCognitiveCalibrateResult = {
      wakeThresholdMs: 400,
      sampleCount: 2,
      calibrated: false,
      minSamples: 5,
      error: "insufficient_empirical_variance",
    };
    mockCalibratePrecognitive.mockResolvedValue(errorResult);

    render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

    const calBtn = screen.getByTestId("calibrate-btn");
    fireEvent.click(calBtn);

    await waitFor(() => {
      expect(screen.getByText("Calibration error: insufficient_empirical_variance")).toBeTruthy();
    });
  });

  it("Calibrate button updates calibration status when successful", async () => {
    const calResult: PreCognitiveCalibrateResult = {
      wakeThresholdMs: 360,
      sampleCount: 22,
      calibrated: true,
      minSamples: 5,
    };
    mockCalibratePrecognitive.mockResolvedValue(calResult);

    render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

    const calBtn = screen.getByTestId("calibrate-btn");
    fireEvent.click(calBtn);

    expect(mockCalibratePrecognitive).toHaveBeenCalledWith(5);
    await waitFor(() => {
      expect(screen.getByText("Calibrated: 360ms (22 samples)")).toBeTruthy();
    });
  });

  it("handles initial fetch error gracefully with retry option", async () => {
    mockGetPrecognitiveStatus.mockRejectedValue(new Error("Precognitive backend offline"));

    render(<AnticipationRing autoPoll={false} />);

    await waitFor(() => {
      expect(screen.getByText("Precognitive backend offline")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    // Retry succeeds
    mockGetPrecognitiveStatus.mockResolvedValueOnce(SAMPLE_STATUS);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByTestId("urgency-badge").textContent).toBe("CASUAL");
    });
  });

  it("polls periodically when autoPoll is true", async () => {
    vi.useFakeTimers();
    try {
      render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={true} pollIntervalMs={3000} />);

      expect(mockGetPrecognitiveStatus).not.toHaveBeenCalled();

      // Fast-forward 3s
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(mockGetPrecognitiveStatus).toHaveBeenCalledTimes(1);

      // Fast-forward another 3s
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(mockGetPrecognitiveStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles guided 5-step calibration flow and auto-triggers calibration on 5th step", async () => {
    let mockTime = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => mockTime);

    try {
      mockSendPrecognitiveTelemetry.mockResolvedValue(SAMPLE_STATUS);
      mockCalibratePrecognitive.mockResolvedValue({
        wakeThresholdMs: 330,
        sampleCount: 5,
        calibrated: true,
        minSamples: 5,
      });

      render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

      const guidedBtn = screen.getByTestId("guided-calibrate-btn");
      expect(guidedBtn.textContent).toBe("Guided Calibrate (5x)");

      fireEvent.click(guidedBtn);
      expect(screen.getByTestId("guided-calibrate-btn").textContent).toBe("Cancel Guided (0/5)");
      expect(screen.getByText("Guided Calibration: Sample 1 of 5 (Hold target ~250ms)")).toBeTruthy();

      const probeTarget = screen.getByTestId("dwell-probe-target");

      // Perform 4 valid dwells (~250ms each)
      for (let i = 0; i < 4; i++) {
        mockTime += 100;
        fireEvent.pointerDown(probeTarget);
        mockTime += 250;
        fireEvent.pointerUp(probeTarget);
        await waitFor(() => {
          expect(mockSendPrecognitiveTelemetry).toHaveBeenCalledTimes(i + 1);
        });
      }

      expect(screen.getByText("Guided Calibration: Sample 5 of 5 (Hold target ~250ms)")).toBeTruthy();
      expect(screen.getByTestId("guided-calibrate-btn").textContent).toBe("Cancel Guided (4/5)");

      // 5th dwell triggers calibration
      mockTime += 100;
      fireEvent.pointerDown(probeTarget);
      mockTime += 250;
      fireEvent.pointerUp(probeTarget);

      await waitFor(() => {
        expect(mockSendPrecognitiveTelemetry).toHaveBeenCalledTimes(5);
        expect(mockCalibratePrecognitive).toHaveBeenCalledWith(5);
        expect(screen.getByText(/Calibration complete: 330ms/)).toBeTruthy();
        expect(screen.getByTestId("guided-calibrate-btn").textContent).toBe("Guided Calibrate (5x)");
      });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("guided mode validates dwell duration window (<80ms too brief, >800ms too long)", async () => {
    let mockTime = 2_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => mockTime);

    try {
      render(<AnticipationRing initialStatus={SAMPLE_STATUS} autoPoll={false} />);

      const guidedBtn = screen.getByTestId("guided-calibrate-btn");
      fireEvent.click(guidedBtn);

      const probeTarget = screen.getByTestId("dwell-probe-target");

      // 1. Touch too brief (50ms < 80ms)
      mockTime += 100;
      fireEvent.pointerDown(probeTarget);
      mockTime += 50;
      fireEvent.pointerUp(probeTarget);

      expect(mockSendPrecognitiveTelemetry).not.toHaveBeenCalled();
      expect(screen.getByText("Touch too brief (50ms). Aim for ~250ms and try again.")).toBeTruthy();

      // 2. Touch held too long (950ms > 800ms)
      mockTime += 100;
      fireEvent.pointerDown(probeTarget);
      mockTime += 950;
      fireEvent.pointerUp(probeTarget);

      expect(mockSendPrecognitiveTelemetry).not.toHaveBeenCalled();
      expect(screen.getByText("Touch held too long (950ms). Aim for ~250ms and try again.")).toBeTruthy();
    } finally {
      dateSpy.mockRestore();
    }
  });
});

