import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { DevicePermissions, PERMISSIONS, getPermissionStatus, requestPermission, sendUsageSnapshot } from "./devicePermissions";

// registerPlugin is stubbed to {} in test/setup.ts; attach the native methods here.
const native = DevicePermissions as unknown as Record<string, ReturnType<typeof vi.fn>>;
const ALL_OFF = Object.fromEntries(PERMISSIONS.map((p) => [p.name, false]));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  native.status = vi.fn().mockResolvedValue(ALL_OFF);
  native.requestRuntime = vi.fn().mockResolvedValue({ ...ALL_OFF, activity: true });
  native.openSetting = vi.fn().mockResolvedValue(undefined);
  native.sendUsageSnapshot = vi.fn().mockResolvedValue({ queued: true, result: "queued" });
});

describe("devicePermissions", () => {
  it("lists every permission exactly once with a known kind", () => {
    const names = PERMISSIONS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(PERMISSIONS.filter((p) => p.kind === "runtime").map((p) => p.name).sort()).toEqual(["activity", "calendar", "callLog"]);
  });

  it("does nothing off-device", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await getPermissionStatus()).toBeNull();
    expect(await requestPermission("battery")).toBeNull();
    expect(await sendUsageSnapshot()).toBeNull();
    expect(native.status).not.toHaveBeenCalled();
  });

  it("shows the system prompt for runtime permissions and returns the new state", async () => {
    const next = await requestPermission("activity");
    expect(native.requestRuntime).toHaveBeenCalledWith({ name: "activity" });
    expect(next?.activity).toBe(true);
  });

  it("opens Settings for special grants", async () => {
    expect(await requestPermission("usageAccess")).toBeNull();
    expect(native.openSetting).toHaveBeenCalledWith({ name: "usageAccess" });
    expect(native.requestRuntime).not.toHaveBeenCalled();
  });

  it("asks the native side for a usage summary over the given window", async () => {
    const r = await sendUsageSnapshot(30);
    expect(native.sendUsageSnapshot).toHaveBeenCalledWith({ minutes: 30 });
    expect(r).toEqual({ queued: true, result: "queued" });
  });
});
