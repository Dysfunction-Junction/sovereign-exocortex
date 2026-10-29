import { describe, it, expect } from "vitest";
import { ContextTracker, SENSOR_WINDOW_TTL_MS, buildScreenExamples, screenOf, type RawEvent } from "./prediction-events.js";
import { EXPECTED_CONTEXT_FIELDS, finalizeContext } from "./prediction-log.js";

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

  it("captures native Android system suggestions and extracted entities in snapshot", () => {
    const t = new ContextTracker(utc);
    const event = ev("dev-1", "telemetry", {
      package: "com.google.android.apps.messaging",
      contextual_suggestions: ["open_url", "view_map"],
      extracted_entities: [
        { type: "address", value: "1600 Amphitheatre Pkwy", confidence: 0.95 },
        { type: "url", value: "https://example.com", confidence: 0.98 },
      ],
      sys_suggest: "open_url",
    }, T0);
    t.update(event);
    const snap = t.snapshot("dev-1", T0);
    expect(snap.system_suggestions?.primary_action).toBe("open_url");
    expect(snap.system_suggestions?.actions).toEqual(["open_url", "view_map"]);
    expect(snap.system_suggestions?.entities).toHaveLength(2);
    expect(snap.system_suggestions?.entities?.[0].type).toBe("address");
  });

  it("clears system suggestions when transitioning to a screen without suggestions", () => {
    const t = new ContextTracker(utc);
    const eventWithSugg = ev("dev-1", "telemetry", {
      package: "com.google.android.apps.messaging",
      contextual_suggestions: ["open_url"],
      sys_suggest: "open_url",
    }, T0);
    t.update(eventWithSugg);
    expect(t.snapshot("dev-1", T0).system_suggestions?.primary_action).toBe("open_url");

    // Transition to settings screen without suggestions
    const eventNextScreen = ev("dev-1", "telemetry", {
      package: "com.android.settings",
      screen: "settings",
    }, T0 + 1000);
    t.update(eventNextScreen);
    expect(t.snapshot("dev-1", T0 + 1000).system_suggestions).toBeUndefined();
  });

  it("expires system suggestions after 5-minute TTL", () => {
    const t = new ContextTracker(utc);
    const eventWithSugg = ev("dev-1", "telemetry", {
      package: "com.google.android.apps.messaging",
      contextual_suggestions: ["open_url"],
      sys_suggest: "open_url",
    }, T0);
    t.update(eventWithSugg);

    // Within TTL (4 minutes later)
    expect(t.snapshot("dev-1", T0 + 4 * 60_000).system_suggestions?.primary_action).toBe("open_url");

    // Past TTL (5 minutes and 1 second later)
    expect(t.snapshot("dev-1", T0 + 5 * 60_000 + 1000).system_suggestions).toBeUndefined();
  });

  it("captures audio mode, in_call, music_active, and audio output routing in snapshot", () => {
    const t = new ContextTracker(utc);
    const audioEvent = ev("dev-1", "telemetry", {
      audio: {
        mode: "in_communication",
        in_call: true,
        music_active: false,
        output_type: "bluetooth_headset",
      },
    }, T0);
    t.update(audioEvent);
    const snap = t.snapshot("dev-1", T0);
    expect(snap.audio).toEqual({
      mode: "in_communication",
      in_call: true,
      music_active: false,
      output_type: "bluetooth_headset",
    });
  });

  it("captures thermal headroom and throttling status in snapshot", () => {
    const t = new ContextTracker(utc);
    const thermalEvent = ev("dev-1", "telemetry", {
      thermal: {
        headroom: 1.05,
        status: "throttling",
      },
    }, T0);
    t.update(thermalEvent);
    const snap = t.snapshot("dev-1", T0);
    expect(snap.thermal).toEqual({
      headroom: 1.05,
      status: "throttling",
    });
  });

  it("captures battery micro-telemetry (temp, voltage, charging type, current) in snapshot", () => {
    const t = new ContextTracker(utc);
    const batteryEvent = ev("dev-1", "telemetry", {
      battery_micro: {
        temp_c: 32.5,
        voltage_mv: 4120,
        plugged: "ac",
        current_ma: -450,
      },
    }, T0);
    t.update(batteryEvent);
    const snap = t.snapshot("dev-1", T0);
    expect(snap.battery_micro).toEqual({
      temp_c: 32.5,
      voltage_mv: 4120,
      plugged: "ac",
      current_ma: -450,
    });
  });

  it("captures low-power motion state prior in snapshot", () => {
    const t = new ContextTracker(utc);
    const motionEvent = ev("dev-1", "telemetry", {
      motion: {
        state: "in_vehicle",
        confidence: 0.95,
      },
    }, T0);
    t.update(motionEvent);
    const snap = t.snapshot("dev-1", T0);
    expect(snap.motion).toEqual({
      state: "in_vehicle",
      confidence: 0.95,
    });
  });

  it("captures actionable notification actions in snapshot", () => {
    const t = new ContextTracker(utc);
    const notifEvent = ev("dev-1", "telemetry", {
      notification_actions: [
        { action_id: "act_101", title: "Archive" },
        { action_id: "act_102", title: "Reply" },
      ],
    }, T0);
    t.update(notifEvent);
    const snap = t.snapshot("dev-1", T0);
    expect(snap.notification_actions).toEqual([
      { action_id: "act_101", title: "Archive" },
      { action_id: "act_102", title: "Reply" },
    ]);
  });

  it("excludes hardware signals when snapshot ts is before observed_ts (negative delta)", () => {
    const t = new ContextTracker(utc);
    const audioEvent = ev("dev-1", "telemetry", {
      audio: { in_call: true, mode: "in_call" },
    }, T0);
    t.update(audioEvent);

    // Snapshot before event was observed should not leak future state
    const pastSnap = t.snapshot("dev-1", T0 - 1000);
    expect(pastSnap.audio).toBeUndefined();

    // Snapshot at or after observation contains it
    const presentSnap = t.snapshot("dev-1", T0);
    expect(presentSnap.audio?.in_call).toBe(true);
  });

  it("expires hardware signals past their respective TTLs", () => {
    const t = new ContextTracker(utc);
    const hwEvent = ev("dev-1", "telemetry", {
      audio: { in_call: true },
      thermal: { headroom: 1.1, status: "throttling" },
      motion: { state: "in_vehicle" },
    }, T0);
    t.update(hwEvent);

    // At T0 + 29s (within audio 30s TTL)
    expect(t.snapshot("dev-1", T0 + 29_000).audio?.in_call).toBe(true);

    // At T0 + 31s (audio expired, but motion 60s still active)
    const snap31 = t.snapshot("dev-1", T0 + 31_000);
    expect(snap31.audio).toBeUndefined();
    expect(snap31.motion?.state).toBe("in_vehicle");

    // At T0 + 61s (motion expired)
    expect(t.snapshot("dev-1", T0 + 61_000).motion).toBeUndefined();
  });

  it("replaces audio and battery data cleanly on partial updates without stale accumulation", () => {
    const t = new ContextTracker(utc);
    // Event 1: in call
    t.update(ev("dev-1", "telemetry", { audio: { in_call: true, mode: "in_call" } }, T0));
    expect(t.snapshot("dev-1", T0).audio?.in_call).toBe(true);

    // Event 2: call ended, normal mode, in_call not set
    t.update(ev("dev-1", "telemetry", { audio: { mode: "normal" } }, T0 + 1000));
    const snap = t.snapshot("dev-1", T0 + 1000);
    expect(snap.audio?.mode).toBe("normal");
    expect(snap.audio?.in_call).toBeUndefined(); // Old in_call: true was not leaked
  });

  it("captures physical_surface and network_telemetry with ambient and device mirroring", () => {
    const t = new ContextTracker(utc);
    const event = ev("dev-1", "telemetry", {
      hardware_telemetry: {
        physical_surface: {
          state: "in_pocket",
          proximity_cm: 0.0,
          lux: 1.2,
          gravity_z: 1.5,
        },
        network: {
          transport: "wifi",
          metered: false,
          downstream_kbps: 150_000,
          upstream_kbps: 45_000,
          validated: true,
        },
      },
    }, T0);
    t.update(event);

    const snap = t.snapshot("dev-1", T0);
    expect(snap.physical_surface).toEqual({
      state: "in_pocket",
      proximity_cm: 0.0,
      lux: 1.2,
      gravity_z: 1.5,
    });
    expect(snap.ambient?.physical_state).toBe("in_pocket");
    expect(snap.ambient?.proximity_cm).toBe(0.0);
    expect(snap.ambient?.lux).toBe(1.2);

    expect(snap.network_telemetry).toEqual({
      transport: "wifi",
      metered: false,
      downstream_kbps: 150_000,
      upstream_kbps: 45_000,
      validated: true,
    });
    expect(snap.device?.metered).toBe(false);
    expect(snap.device?.network_bandwidth_kbps).toBe(150_000);
    expect(snap.device?.network).toBe("wifi");

    // Surface TTL is 30s: active at +25s, expired at +35s
    const snap25 = t.snapshot("dev-1", T0 + 25_000);
    expect(snap25.physical_surface?.state).toBe("in_pocket");
    expect(snap25.ambient?.physical_state).toBe("in_pocket");

    const snap35 = t.snapshot("dev-1", T0 + 35_000);
    expect(snap35.physical_surface).toBeUndefined();
    expect(snap35.ambient?.physical_state).toBeUndefined(); // Mirrored state cleanly expired!

    // Network TTL is 60s: active at +50s, expired at +65s
    const snap50 = t.snapshot("dev-1", T0 + 50_000);
    expect(snap50.network_telemetry?.metered).toBe(false);
    expect(snap50.device?.metered).toBe(false);

    const snap65 = t.snapshot("dev-1", T0 + 65_000);
    expect(snap65.network_telemetry).toBeUndefined();
    expect(snap65.device?.metered).toBeUndefined(); // Mirrored state cleanly expired!
  });
});


describe("device-signal events (app_foreground, sensor_window, sensor_caps, sensor_consent)", () => {
  const T = T0 + 3_600_000;
  const win = (end: number, sensors: Record<string, unknown>) =>
    ev("p", "telemetry", { type: "sensor_window", window_start: end - 300_000, window_end: end, dur_ms: 300_000, sensors }, end);

  it("a late older sensor_window does not overwrite a newer one", () => {
    const t = new ContextTracker(utc);
    t.update(win(T + 300_000, { motion: { energy_rms: 1, energy_class: "vigorous" } }));
    t.update(win(T, { motion: { energy_rms: 0, energy_class: "still" } }));
    expect(t.snapshot("p", T + 310_000).sensors).toEqual({ window_end: T + 300_000, motion_energy: "vigorous" });
  });

  it("sensor_window and app_foreground never set ambient.temp_c or clobber app.package", () => {
    const t = new ContextTracker(utc);
    t.update(ev("p", "telemetry", { package: "com.real", app_label: "Real", temp_c: 21 }, T));
    t.update(
      ev("p", "telemetry", { type: "app_foreground", event: "APP_TRANSITION", to: "com.spotify.music", category: "Audio", from: "com.real", temp_c: 99, package: "com.clobber" }, T + 1),
    );
    t.update(win(T + 300_000, { battery: { pct: 55, plugged: "usb", batt_temp_c: 33 }, ambient_temp: { c: 44 } }));
    const snap = t.snapshot("p", T + 301_000);
    expect(snap.app).toEqual({ package: "com.real", label: "Real" });
    expect(snap.ambient?.temp_c).toBe(21);
    expect(snap.battery_micro).toEqual({ temp_c: 33, plugged: "usb" });
    expect(snap.device).toMatchObject({ battery_pct: 55, charging: true });
    // Without any phone temperature at all, a sensor window still leaves ambient empty.
    const t2 = new ContextTracker(utc);
    t2.update(win(T, { battery: { pct: 50, plugged: "unplugged", batt_temp_c: 30 } }));
    expect(t2.snapshot("p", T + 1).ambient).toBeUndefined();
  });

  it("expires a window after the 10 minute TTL and never shows one from the future", () => {
    const t = new ContextTracker(utc);
    t.update(win(T, { light: { bucket: "dim" } }));
    expect(t.snapshot("p", T + SENSOR_WINDOW_TTL_MS).sensors?.light).toBe("dim");
    expect(t.snapshot("p", T + SENSOR_WINDOW_TTL_MS + 1).sensors).toBeUndefined();
    expect(t.snapshot("p", T - 1).sensors).toBeUndefined();
  });

  it("feeds activity into motion with the sensor TTL", () => {
    const t = new ContextTracker(utc);
    t.update(win(T, { activity: { state: "walking", conf: 0.8, src: "heuristic" } }));
    expect(t.snapshot("p", T + 120_000).motion).toEqual({ state: "walking", confidence: 0.8 });
  });

  it("ignores windows for a revoked key, drops what it already fed, and honours EXO_SENSOR_CONTEXT=0", () => {
    const t = new ContextTracker(utc);
    t.update(win(T, { motion: { energy_class: "light" }, pressure: { trend: "rising" } }));
    t.update(ev("p", "telemetry", { type: "sensor_consent", key: "pressure", enabled: false }, T + 1));
    expect(t.snapshot("p", T + 2).sensors).toEqual({ window_end: T, motion_energy: "light" });
    t.update(win(T + 300_000, { motion: { energy_class: "still" }, pressure: { trend: "falling" } }));
    expect(t.snapshot("p", T + 300_001).sensors).toEqual({ window_end: T + 300_000, motion_energy: "still" });
    const off = new ContextTracker(utc, { sensorContext: false });
    off.update(win(T, { motion: { energy_class: "light" } }));
    expect(off.snapshot("p", T + 1).sensors).toBeUndefined();
  });

  it("lists sensors.<key> as missing only when present, toggled on and stale", () => {
    const t = new ContextTracker(utc);
    t.update(
      ev("p", "telemetry", {
        type: "sensor_caps",
        sensors: { motion: { present: true }, pressure: { present: true }, light: { present: true }, ambient_temp: { present: false } },
        toggles: { motion: true, pressure: true, light: false, ambient_temp: true },
      }, T),
    );
    t.update(win(T + 300_000, { motion: { energy_class: "still" } }));
    // pressure is on and present but absent from the fresh window; light is off; ambient_temp is absent.
    expect(t.snapshot("p", T + 301_000).missing).toEqual(["sensors.pressure"]);
    // Window expired: every present+on sensor is stale.
    expect(t.snapshot("p", T + 300_000 + SENSOR_WINDOW_TTL_MS + 1).missing).toEqual(["sensors.motion", "sensors.pressure"]);
    t.update(ev("p", "telemetry", { type: "sensor_consent", key: "pressure", enabled: false }, T + 400_000));
    expect(t.snapshot("p", T + 401_000).missing).toBeUndefined();
  });

  it("keeps missing sensors.<key> through finalizeContext without touching EXPECTED_CONTEXT_FIELDS", () => {
    const out = finalizeContext({ missing: ["sensors.motion", "ambient.temp_c"] });
    expect(out.missing).toContain("sensors.motion");
    expect(out.missing).toContain("ambient.temp_c"); // recomputed because it is genuinely absent
    expect(EXPECTED_CONTEXT_FIELDS.some((f) => f.startsWith("sensors"))).toBe(false);
  });
});
