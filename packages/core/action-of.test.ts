import { describe, it, expect } from "vitest";
import { actionOf, isLate, passiveCapturePackage, streamOf, type PassiveActionState } from "./action-of.js";
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

describe("app_foreground", () => {
  const fg = (to: string | undefined, ts: number, extra: Record<string, unknown> = {}) =>
    ev({ type: "app_foreground", event: "APP_TRANSITION", ...(to ? { to } : {}), category: "Audio", excluded: false, ...extra }, ts);
  const DAY = 86_400_000;

  it("switches from cat to pkg at exactly the 5th arrival inside 14 days", () => {
    const state: PassiveActionState = {};
    const labels = [0, 1, 2, 3, 4, 5].map((i) => actionOf(fg("com.spotify.music", 1000 + i * 1000), state));
    expect(labels).toEqual(["cat:Audio", "cat:Audio", "cat:Audio", "cat:Audio", "pkg:com.spotify.music", "pkg:com.spotify.music"]);
  });

  it("does not count arrivals older than 14 days toward k=5", () => {
    const state: PassiveActionState = {};
    for (let i = 0; i < 4; i++) actionOf(fg("com.old", 1000 + i), state);
    expect(actionOf(fg("com.old", 1000 + 15 * DAY), state)).toBe("cat:Audio");
  });

  it("counts per package", () => {
    const state: PassiveActionState = {};
    for (let i = 0; i < 4; i++) actionOf(fg("com.a", 1000 + i), state);
    expect(actionOf(fg("com.b", 2000), state)).toBe("cat:Audio");
  });

  it("returns cat:excluded for excluded events, whether flagged or categorised", () => {
    const state: PassiveActionState = {};
    expect(actionOf(fg(undefined, 1000, { category: "excluded", excluded: true }), state)).toBe("cat:excluded");
    expect(actionOf(fg(undefined, 2000, { category: undefined, excluded: true }), state)).toBe("cat:excluded");
    expect(state.pkgArrivals).toBeUndefined();
  });

  it("maps noise to cat:home or cat:system and never to a package", () => {
    const state: PassiveActionState = {};
    for (let i = 0; i < 6; i++) expect(actionOf(fg("com.sec.android.app.launcher", 1000 + i, { category: "home" }), state)).toBe("cat:home");
    expect(actionOf(fg("com.android.systemui", 9000, { category: "system" }), state)).toBe("cat:system");
  });

  it("is a stateless category lookup without state, and ignores non-telemetry kinds", () => {
    expect(actionOf(fg("com.a", 1000))).toBe("cat:Audio");
    expect(actionOf(ev({ type: "app_foreground", to: "com.a", category: "Audio" }, 1, "touch"))).toBeNull();
    expect(actionOf(ev({ type: "app_foreground" }, 1))).toBeNull();
  });

  it("does not take the passive debounce path", () => {
    const state: PassiveActionState = {};
    expect(actionOf(fg("com.a", 1000, { dwell_ms: 10 }), state)).toBe("cat:Audio");
    expect(actionOf(fg("com.b", 1100), state)).toBe("cat:Audio");
    expect(state.lastPassiveTs).toBeUndefined();
  });

  it("streamOf separates arrivals from everything else", () => {
    expect(streamOf(fg("com.a", 1))).toBe("app");
    expect(streamOf(ev({ type: "screen_view", screen: "ask" }, 1, "touch"))).toBe("screen");
    expect(streamOf(pkgEv("com.a", 1))).toBe("screen");
  });
});

describe("isLate", () => {
  it("is true only for timestamps older than the newest on-time action", () => {
    expect(isLate({ ts_device: 100 }, {})).toBe(false);
    expect(isLate({ ts_device: 99 }, { lastActionTs: 100 })).toBe(true);
    expect(isLate({ ts_device: 100 }, { lastActionTs: 100 })).toBe(false);
    expect(isLate({ ts_device: 101 }, { lastActionTs: 100 })).toBe(false);
  });
});
