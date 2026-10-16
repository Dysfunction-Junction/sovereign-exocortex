import { describe, it, expect } from "vitest";
import { ContextTracker, buildScreenExamples, screenOf, type RawEvent } from "./prediction-events.js";

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
let seq = 0;
function ev(device: string, kind: string, payload: Record<string, unknown> | string, ts: number): RawEvent {
  return { seq: ++seq, device_id: device, kind, ts_device: ts, payload: typeof payload === "string" ? payload : JSON.stringify(payload) };
}
const view = (device: string, screen: string, ts: number) => ev(device, "touch", { type: "screen_view", screen }, ts);
const utc = () => 0;

describe("screenOf", () => {
  it("accepts a screen_view on touch or telemetry and rejects everything else", () => {
    expect(screenOf(view("d", "status", T0))).toBe("status");
    expect(screenOf(ev("d", "telemetry", { type: "screen_view", screen: "ask" }, T0))).toBe("ask");
    expect(screenOf(ev("d", "label", { type: "screen_view", screen: "ask" }, T0))).toBeNull();
    expect(screenOf(ev("d", "touch", { type: "tap", screen: "ask" }, T0))).toBeNull();
    expect(screenOf(ev("d", "touch", "not json", T0))).toBeNull();
    expect(screenOf(ev("d", "touch", { type: "screen_view", screen: "" }, T0))).toBeNull();
    expect(screenOf(ev("d", "touch", { type: "screen_view", screen: "x".repeat(200) }, T0))).toBeNull();
  });
});

describe("ContextTracker", () => {
  it("tracks the latest valid signals per device and leaves others absent", () => {
    const t = new ContextTracker(utc);
    t.update(ev("a", "telemetry", { package: "com.x", app_label: "X", screen_state: "ON", battery_pct: 42, charging: true, network: "wifi" }, T0));
    t.update(ev("a", "touch", { mode: "touch" }, T0 + 1));
    t.update(ev("b", "telemetry", { package: "com.other" }, T0));
    const ctx = t.snapshot("a", T0 + 5000);
    expect(ctx.app).toEqual({ package: "com.x", label: "X" });
    expect(ctx.device).toEqual({ screen_state: "ON", battery_pct: 42, charging: true, network: "wifi", mode: "touch" });
    expect(ctx.ambient).toBeUndefined();
    expect(ctx.location).toBeUndefined();
    expect(ctx.time).toMatchObject({ ts: T0 + 5000, hour: 15, daypart: "afternoon", is_weekend: true });
    expect(t.snapshot("b", T0).app).toEqual({ package: "com.other" });
  });

  it("rejects out-of-range or wrong-typed values", () => {
    const t = new ContextTracker(utc);
    t.update(ev("a", "telemetry", { battery_pct: 250, charging: "yes", temp_c: 400, lat: 999, lon: 0, idle_ms: -5 }, T0));
    const ctx = t.snapshot("a", T0);
    expect(ctx.device).toBeUndefined();
    expect(ctx.ambient).toBeUndefined();
    expect(ctx.location).toBeUndefined();
  });

  it("prefers a phone temperature reading over an external one", () => {
    const t = new ContextTracker(utc);
    t.setAmbient({ temp_c: 19, source: "home-sensor" });
    expect(t.snapshot("a", T0).ambient).toEqual({ temp_c: 19, source: "home-sensor" });
    t.update(ev("a", "telemetry", { temp_c: 23 }, T0));
    expect(t.snapshot("a", T0).ambient).toMatchObject({ temp_c: 23, source: "phone" });
  });

  it("uses the supplied timezone offset for local time", () => {
    const t = new ContextTracker(() => -300);
    expect(t.snapshot("a", Date.UTC(2026, 9, 10, 3, 0)).time).toMatchObject({ hour: 22, daypart: "evening", dow: 5, is_weekend: false });
  });
});

describe("buildScreenExamples", () => {
  it("pairs consecutive screen views per device with the context at the guess point", () => {
    const t = new ContextTracker(utc);
    const events = [
      view("a", "status", T0),
      ev("a", "telemetry", { battery_pct: 80 }, T0 + 1000),
      view("a", "ask", T0 + 2000),
      view("b", "status", T0 + 2500),
      ev("a", "telemetry", { battery_pct: 10 }, T0 + 2600),
      view("a", "setup", T0 + 3000),
    ];
    const ex = buildScreenExamples(events, t);
    expect(ex).toHaveLength(2);
    expect(ex[0]).toMatchObject({ device_id: "a", current: "status", actual: "ask", to_ts: T0 + 2000 });
    // No look-ahead: the battery reading arrives after the first guess point, so it must not be visible there.
    expect(ex[0].features).toMatchObject({ daypart: "afternoon" });
    expect(ex[0].features.battery).toBeUndefined();
    expect(ex[0].features.prev).toBeUndefined();
    expect(ex[1]).toMatchObject({ current: "ask", actual: "setup" });
    expect(ex[1].features).toMatchObject({ prev: "status", battery: "80-100" });
    expect(ex[1].context.device?.battery_pct).toBe(80);
  });

  it("ignores non-view events and sorts by sequence", () => {
    const a = view("a", "status", T0);
    const b = ev("a", "label", { x: 1 }, T0 + 1);
    const c = view("a", "ask", T0 + 2);
    const ex = buildScreenExamples([c, b, a], new ContextTracker(utc));
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ current: "status", actual: "ask", from_seq: a.seq, to_seq: c.seq });
  });
});
