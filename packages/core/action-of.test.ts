import { describe, it, expect } from "vitest";
import { actionOf, passiveCapturePackage } from "./action-of.js";
import type { RawEvent } from "./prediction-events.js";

const ev = (payload: unknown, ts = 1000, kind = "telemetry"): RawEvent => ({
  seq: 1,
  device_id: "d",
  kind,
  ts_device: ts,
  payload: JSON.stringify(payload),
});
const pkgEv = (pkg: string, ts: number, extra: Record<string, unknown> = {}) =>
  ev({ type: "system_telemetry", telemetry: `Package: ${pkg}\n\nbody`, package: pkg, ...extra }, ts);

describe("passiveCapturePackage", () => {
  it("reads passive_capture and Package: telemetry, skips SMS and notifications", () => {
    expect(passiveCapturePackage(ev({ type: "passive_capture", package: "com.a" }))).toBe("com.a");
    expect(passiveCapturePackage(ev({ type: "system_telemetry", telemetry: "Package: com.b\nx" }))).toBe("com.b");
    expect(passiveCapturePackage(ev({ type: "system_telemetry", telemetry: "SMS from x", package: "com.c" }))).toBeNull();
    expect(passiveCapturePackage(ev({ type: "system_telemetry", telemetry: "Notification from x" }))).toBeNull();
    expect(passiveCapturePackage(ev({ type: "passive_capture", package: "com.a" }, 1, "touch"))).toBeNull();
    expect(passiveCapturePackage({ ...ev({}), payload: "not json" })).toBeNull();
  });
});

describe("actionOf", () => {
  const playCategories = { "com.a": "Social", "com.b": "Productivity" };

  it("returns the screen for a screen_view", () => {
    expect(actionOf(ev({ type: "screen_view", screen: "ask" }, 1, "touch"))).toBe("ask");
  });

  it("maps packages via the injected playCategories, prefers payload category, else Uncategorized", () => {
    expect(actionOf(pkgEv("com.a", 5000), undefined, { playCategories })).toBe("Social");
    expect(actionOf(pkgEv("com.a", 5000, { category: "Games" }), undefined, { playCategories })).toBe("Games");
    expect(actionOf(pkgEv("com.zzz", 5000), undefined, { playCategories })).toBe("Uncategorized");
    expect(actionOf(pkgEv("com.a", 5000))).toBe("Uncategorized"); // nothing injected
  });

  it("debounces by dwell and by time since the last passive action, and records state", () => {
    const state: { lastPassiveTs?: number; lastPassiveAction?: string } = {};
    const o = { playCategories, dwellDebounceMs: 1000 };
    expect(actionOf(pkgEv("com.a", 5000, { dwell_ms: 200 }), state, o)).toBeNull();
    expect(state.lastPassiveTs).toBeUndefined();
    expect(actionOf(pkgEv("com.a", 5000), state, o)).toBe("Social");
    expect(state).toEqual({ lastPassiveTs: 5000, lastPassiveAction: "Social" });
    expect(actionOf(pkgEv("com.b", 5500), state, o)).toBeNull();
    expect(actionOf(pkgEv("com.b", 6000), state, o)).toBe("Productivity");
  });
});
