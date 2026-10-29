import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import {
  MASTER_COPY, SENSORS, SensorConsent, getSensorState, isAvailable, isCollecting,
  needsActivityPermissionNow, refreshSensors, setSensorMaster, setSensorToggle, type SensorState,
} from "./sensorConsent";

// registerPlugin is stubbed to {} in test/setup.ts; attach the native methods here.
const native = SensorConsent as unknown as Record<string, ReturnType<typeof vi.fn>>;

const OFF: SensorState = {
  master: false,
  toggles: Object.fromEntries(SENSORS.map((s) => [s.key, false])) as SensorState["toggles"],
  caps: { motion: true, pressure: false },
  activityPermission: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  native.getState = vi.fn().mockResolvedValue(OFF);
  native.setToggle = vi.fn().mockResolvedValue({ ...OFF, toggles: { ...OFF.toggles, motion: true } });
  native.setMaster = vi.fn().mockResolvedValue({ ...OFF, master: true });
  native.refresh = vi.fn().mockResolvedValue(OFF);
});

describe("sensorConsent", () => {
  it("lists each sensor once, never includes mic, location, text or magnetometer", () => {
    const keys = SENSORS.map((s) => s.key as string);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("app_switches");
    for (const banned of ["microphone", "mic", "location", "text", "typed_text", "magnetometer", "camera"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("uses the spec consent copy", () => {
    const copy = (k: string) => SENSORS.find((s) => s.key === k)!.copy;
    expect(copy("motion")).toBe(
      "Motion: how much the phone moved in each 5-minute window (a number, not a recording). " +
        "Stays between your phone and your PC. Off stops collection immediately; data already sent stays in your log.",
    );
    expect(copy("pressure")).toContain("Changes in air pressure can reveal stairs, elevators and travel.");
    expect(copy("app_switches")).toContain(
      "Which app you opened and when. Banking, password, authenticator and health apps are recorded only as 'excluded'.",
    );
    for (const s of SENSORS) expect(s.copy).toContain("Off stops collection immediately; data already sent stays in your log.");
    expect(MASTER_COPY).toMatch(/Off stops all/);
  });

  it("does nothing off-device", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await getSensorState()).toBeNull();
    expect(await setSensorToggle("motion", true)).toBeNull();
    expect(await setSensorMaster(true)).toBeNull();
    expect(await refreshSensors()).toBeNull();
    expect(native.getState).not.toHaveBeenCalled();
    expect(native.setToggle).not.toHaveBeenCalled();
  });

  it("passes toggles through to the native plugin and returns the new state", async () => {
    const next = await setSensorToggle("motion", true);
    expect(native.setToggle).toHaveBeenCalledWith({ key: "motion", enabled: true });
    expect(next?.toggles.motion).toBe(true);
    expect((await setSensorMaster(true))?.master).toBe(true);
    expect(native.setMaster).toHaveBeenCalledWith({ enabled: true });
  });

  it("rejects an unknown sensor key before calling native", async () => {
    await expect(setSensorToggle("magnetometer" as never, true)).rejects.toThrow(/unknown sensor/);
    expect(native.setToggle).not.toHaveBeenCalled();
  });

  it("collects only when master and the sensor are both on", () => {
    const on = { ...OFF, toggles: { ...OFF.toggles, motion: true } };
    expect(isCollecting(on, "motion")).toBe(false); // master off
    expect(isCollecting({ ...on, master: true }, "motion")).toBe(true);
    expect(isCollecting({ ...on, master: true }, "light")).toBe(false);
  });

  it("flags missing hardware and the pending activity permission", () => {
    expect(isAvailable(OFF, "pressure")).toBe(false);
    expect(isAvailable(OFF, "motion")).toBe(true);
    expect(isAvailable(OFF, "app_switches")).toBe(true);
    const steps = SENSORS.find((s) => s.key === "steps")!;
    expect(needsActivityPermissionNow(OFF, steps)).toBe(false); // off: nothing to ask for
    const asked = { ...OFF, toggles: { ...OFF.toggles, steps: true } };
    expect(needsActivityPermissionNow(asked, steps)).toBe(true);
    expect(needsActivityPermissionNow({ ...asked, activityPermission: true }, steps)).toBe(false);
    expect(needsActivityPermissionNow(asked, SENSORS.find((s) => s.key === "motion")!)).toBe(false);
  });
});
