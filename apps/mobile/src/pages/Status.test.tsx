import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import type { ServiceInfo } from "../lib/api";

const scanner = vi.hoisted(() => ({
  getPassiveModeEnabled: vi.fn(),
  getAllowlist: vi.fn(),
  listInstalledApps: vi.fn(),
  isUsageAccessGranted: vi.fn(),
  getRecentlyUsedPackages: vi.fn(),
  setAllowlist: vi.fn(),
  setPassiveModeEnabled: vi.fn(),
  isAccessibilityServiceEnabled: vi.fn(),
}));

let isNative = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNative },
  registerPlugin: () => scanner,
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));

const mockGetServices = vi.fn();
const mockRestartService = vi.fn();

const defaultMockServices: ServiceInfo[] = [
  {
    id: "daemon",
    label: "Daemon API",
    port: 8788,
    status: "healthy",
    detail: "serving (pid 1234, uptime 50s)",
    latency_ms: 0,
    checked_at: Date.now(),
    pid: 1234,
    uptime_s: 50,
    restart: { available: true, in_progress: false, last_at: null, last_result: null },
  },
  {
    id: "proxy",
    label: "Proxy Bus",
    port: 8787,
    status: "healthy",
    detail: "HTTP 200 ok (/mobile/health)",
    latency_ms: 5,
    checked_at: Date.now(),
    restart: { available: true, in_progress: false, last_at: null, last_result: null },
  },
  {
    id: "piecesos",
    label: "PiecesOS Engine",
    port: 39300,
    status: "healthy",
    detail: "HTTP 200 ok (.well-known/health)",
    latency_ms: 12,
    checked_at: Date.now(),
    restart: { available: true, in_progress: false, last_at: null, last_result: null },
  },
  {
    id: "worldmodel",
    label: "World Model Store",
    status: "healthy",
    detail: "quick_check ok, wal 120 KB",
    latency_ms: 2,
    checked_at: Date.now(),
    restart: { available: true, in_progress: false, last_at: null, last_result: null },
  },
];

vi.mock("../lib/api", () => ({
  getStatus: vi.fn().mockResolvedValue({ health: "ok", version: "1" }),
  getCachedStatus: vi.fn().mockResolvedValue(null),
  getPendingShadowProposals: vi.fn().mockResolvedValue([]),
  getPrecognitiveStatus: vi.fn().mockResolvedValue({
    deviceId: "mock-phone",
    wakeThresholdMs: 400,
    urgencyIntent: "CASUAL",
    wakeupLatencyMs: 380,
    hesitationScore: 0.1,
    isPreStaged: false,
    calibrated: true,
    sampleCount: 12,
    source: "device",
  }),
  sendPrecognitiveTelemetry: vi.fn().mockResolvedValue({
    deviceId: "mock-phone",
    wakeThresholdMs: 350,
    urgencyIntent: "PREPARED",
    wakeupLatencyMs: 340,
    hesitationScore: 0.05,
    isPreStaged: false,
    calibrated: true,
    sampleCount: 13,
    source: "device",
  }),
  calibratePrecognitive: vi.fn().mockResolvedValue({
    wakeThresholdMs: 350,
    sampleCount: 13,
    calibrated: true,
    minSamples: 5,
  }),
  getLivingGraphContext: vi.fn().mockResolvedValue({
    cognitiveMode: "CALM",
    entityCount: 10,
    edgeCount: 20,
    activeEntities: [],
  }),
  getServices: (...args: any[]) => mockGetServices(...args),
  restartService: (...args: any[]) => mockRestartService(...args),
  ProxyNotConfiguredError: class extends Error {},
  HomeNodeUnreachableError: class extends Error {},
}));
vi.mock("../lib/usage", () => ({ recordEvent: vi.fn() }));
vi.mock("../lib/flush", () => ({ flushUsageEvents: vi.fn() }));
vi.mock("../lib/config", () => ({
  isScreenContextEnabled: vi.fn().mockResolvedValue(true),
  tryAutoConnectLocalPc: vi.fn().mockResolvedValue(false),
}));
vi.mock("../lib/passiveCapture", () => ({
  onPassiveCapture: vi.fn(() => () => {}),
  getLastPassiveCapture: vi.fn(() => null),
  startPassiveCaptureListener: vi.fn(),
}));

import Status from "./Status";

const APPS = [
  { packageName: "com.a", label: "Alpha", isSystemApp: false, hasLauncherIcon: true, category: "Tools" },
  { packageName: "com.b", label: "Beta", isSystemApp: false, hasLauncherIcon: true, category: "Tools" },
];

beforeEach(() => {
  vi.clearAllMocks();
  isNative = false;
  mockGetServices.mockResolvedValue([...defaultMockServices]);
  mockRestartService.mockResolvedValue({ accepted: true, id: "daemon" });
  scanner.getPassiveModeEnabled.mockResolvedValue({ enabled: false });
  scanner.getAllowlist.mockResolvedValue({ packages: [] });
  scanner.listInstalledApps.mockResolvedValue({ apps: APPS });
  scanner.isUsageAccessGranted.mockResolvedValue({ granted: true });
  scanner.getRecentlyUsedPackages.mockResolvedValue({ packages: ["com.a"], usageMs: {} });
  scanner.setAllowlist.mockResolvedValue(undefined);
  scanner.setPassiveModeEnabled.mockResolvedValue(undefined);
  scanner.isAccessibilityServiceEnabled.mockResolvedValue({ enabled: true });
});

async function openPicker() {
  render(<Status />);
  const btn = await screen.findByRole("button", { name: /choose allowed apps/i });
  fireEvent.click(btn);
  await screen.findByRole("button", { name: /^save/i });
}

describe("Status app picker (P8)", () => {
  test("pre-checks recent apps for an empty allowlist but persists nothing until Save", async () => {
    await openPicker();
    expect(scanner.getRecentlyUsedPackages).toHaveBeenCalled();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const alpha = boxes.find((b) => b.closest("label")?.textContent?.includes("com.a"))!;
    expect(alpha.checked).toBe(true);
    expect(scanner.setAllowlist).not.toHaveBeenCalled();

    fireEvent.click(alpha);
    expect(scanner.setAllowlist).not.toHaveBeenCalled();
  });

  test("Cancel leaves the allowlist unchanged", async () => {
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /^cancel/i }));
    expect(scanner.setAllowlist).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /choose allowed apps \(0 selected\)/i })).toBeTruthy();
  });

  test("Save persists the draft exactly once", async () => {
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    await waitFor(() => expect(scanner.setAllowlist).toHaveBeenCalledTimes(1));
    expect(scanner.setAllowlist).toHaveBeenCalledWith({ packages: ["com.a"] });
  });
});

describe("Workstation Node controls (spec section 2 & 4)", () => {
  test("rows render collapsed with status text and roll-up badge", async () => {
    render(<Status />);

    await waitFor(() => {
      expect(screen.getByText("All services healthy")).toBeTruthy();
    });

    // Check four service rows exist and are collapsed
    const daemonRow = screen.getByTestId("service-row-daemon");
    const proxyRow = screen.getByTestId("service-row-proxy");
    const piecesRow = screen.getByTestId("service-row-piecesos");
    const worldModelRow = screen.getByTestId("service-row-worldmodel");

    expect(daemonRow).toBeTruthy();
    expect(proxyRow).toBeTruthy();
    expect(piecesRow).toBeTruthy();
    expect(worldModelRow).toBeTruthy();

    const daemonBtn = daemonRow.querySelector("button.service-row-header-btn")!;
    expect(daemonBtn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("service-row-expanded-daemon")).toBeNull();
  });

  test("expand shows detail, latency, pid/uptime, and Restart button", async () => {
    render(<Status />);
    await waitFor(() => expect(screen.getByText("All services healthy")).toBeTruthy());

    const daemonRow = screen.getByTestId("service-row-daemon");
    const btn = daemonRow.querySelector("button.service-row-header-btn")!;
    fireEvent.click(btn);

    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const expanded = screen.getByTestId("service-row-expanded-daemon");
    expect(expanded).toBeTruthy();
    expect(expanded.textContent).toContain("serving (pid 1234, uptime 50s)");
    expect(expanded.textContent).toContain("PID: 1234 (Uptime: 50s)");
    expect(expanded.textContent).toContain("0 ms");

    const restartBtn = expanded.querySelector("button:not(.secondary)")!;
    expect(restartBtn.textContent).toBe("Restart");
  });

  test("restart flow: confirm step is required before calling API", async () => {
    render(<Status />);
    await waitFor(() => expect(screen.getByText("All services healthy")).toBeTruthy());

    const proxyRow = screen.getByTestId("service-row-proxy");
    fireEvent.click(proxyRow.querySelector("button.service-row-header-btn")!);

    const expanded = screen.getByTestId("service-row-expanded-proxy");
    const restartBtn = expanded.querySelector("button:not(.secondary)")!;
    fireEvent.click(restartBtn);

    // Inline confirm prompt should appear
    expect(expanded.textContent).toContain("Restart Proxy Bus?");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });

    expect(mockRestartService).not.toHaveBeenCalled();

    // Cancel should close confirmation without calling restart
    fireEvent.click(cancelBtn);
    expect(mockRestartService).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  test("restart: disabled and shows Restarting… while restart is in progress", async () => {
    let resolveRestart: any;
    mockRestartService.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRestart = resolve;
        })
    );

    render(<Status />);
    await waitFor(() => expect(screen.getByText("All services healthy")).toBeTruthy());

    const proxyRow = screen.getByTestId("service-row-proxy");
    fireEvent.click(proxyRow.querySelector("button.service-row-header-btn")!);

    const expanded = screen.getByTestId("service-row-expanded-proxy");
    fireEvent.click(expanded.querySelector("button:not(.secondary)")!);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(mockRestartService).toHaveBeenCalledWith("proxy");
    });

    const activeBtn = expanded.querySelector("button:disabled") as HTMLButtonElement;
    expect(activeBtn).toBeTruthy();
    expect(activeBtn.textContent).toContain("Restarting");
    expect(activeBtn.disabled).toBe(true);

    if (resolveRestart) resolveRestart({ accepted: true, id: "proxy" });
  });

  test("restart failure shows error detail banner", async () => {
    mockRestartService.mockRejectedValue(new Error("Privilege boundary error"));

    render(<Status />);
    await waitFor(() => expect(screen.getByText("All services healthy")).toBeTruthy());

    const proxyRow = screen.getByTestId("service-row-proxy");
    fireEvent.click(proxyRow.querySelector("button.service-row-header-btn")!);

    const expanded = screen.getByTestId("service-row-expanded-proxy");
    fireEvent.click(expanded.querySelector("button:not(.secondary)")!);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(expanded.textContent).toContain("Restart failed: Privilege boundary error");
    });
  });

  test("daemon-restart connection loss shows Reconnecting… and recovers smoothly", async () => {
    mockRestartService.mockRejectedValue(new Error("Failed to fetch"));

    render(<Status />);
    await waitFor(() => expect(screen.getByText("All services healthy")).toBeTruthy());

    const daemonRow = screen.getByTestId("service-row-daemon");
    fireEvent.click(daemonRow.querySelector("button.service-row-header-btn")!);

    const expanded = screen.getByTestId("service-row-expanded-daemon");
    fireEvent.click(expanded.querySelector("button:not(.secondary)")!);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(expanded.textContent).toContain("Reconnecting…");
    });
  });

  test("roll-up badge reflects unhealthy counts and daemon unreachable", async () => {
    // 1 unhealthy service
    const oneUnhealthy = defaultMockServices.map((s) =>
      s.id === "piecesos" ? { ...s, status: "unhealthy" as const } : s
    );
    mockGetServices.mockResolvedValueOnce(oneUnhealthy);

    const { unmount } = render(<Status />);
    await waitFor(() => {
      expect(screen.getByText("1 unhealthy")).toBeTruthy();
    });
    unmount();

    // 2 unhealthy services
    const twoUnhealthy = defaultMockServices.map((s) =>
      s.id === "piecesos" || s.id === "proxy" ? { ...s, status: "unhealthy" as const } : s
    );
    mockGetServices.mockResolvedValueOnce(twoUnhealthy);

    const { unmount: unmount2 } = render(<Status />);
    await waitFor(() => {
      expect(screen.getByText("2 unhealthy")).toBeTruthy();
    });
    unmount2();

    // Daemon unreachable (API throws)
    mockGetServices.mockRejectedValueOnce(new Error("Connection refused"));
    render(<Status />);
    await waitFor(() => {
      expect(screen.getByText("Daemon unreachable")).toBeTruthy();
    });
    expect(screen.getAllByText("Unknown (daemon unreachable)").length).toBeGreaterThanOrEqual(1);
  });

  test("polling stops on component unmount", async () => {
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(<Status />);

    await waitFor(() => expect(screen.getByText("All services healthy")).toBeTruthy());
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  test("native (Android) build does not render the workstation node card", async () => {
    isNative = true;
    render(<Status />);

    await waitFor(() => {
      expect(screen.queryByText("Windows Workstation Node")).toBeNull();
    });
    expect(screen.queryByTestId("service-row-daemon")).toBeNull();
  });
});
