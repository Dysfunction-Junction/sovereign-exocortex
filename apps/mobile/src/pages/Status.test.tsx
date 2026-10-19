import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

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

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => scanner,
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../lib/api", () => ({
  getStatus: vi.fn().mockResolvedValue({ health: "ok", version: "1" }),
  getCachedStatus: vi.fn().mockResolvedValue(null),
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
    expect(alpha.checked).toBe(true); // pre-checked suggestion
    expect(scanner.setAllowlist).not.toHaveBeenCalled();

    fireEvent.click(alpha); // toggling is still only a draft edit
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
