/**
 * @file prediction-events.ts
 * Turns the append-only event log into (current action, context, next action) examples.
 *
 * The only action recognised today is a `screen_view` event from the phone app. Context is whatever
 * the events themselves carry, tracked per device as a running state, plus the wall clock. Nothing
 * is invented: a signal that never arrived stays absent and is reported as missing.
 *
 * Recognised payload keys (flat, on any touch/telemetry event) update the running state:
 *   app:      package, app_label, screen
 *   device:   screen_state | screenState, mode, battery_pct, charging, network, idle_ms
 *   ambient:  temp_c | ambient_temp_c, humidity_pct
 *   location: place, lat, lon, accuracy_m
 */

import type { Example } from "./prob-engine.js";
import { contextFeatures } from "./prob-engine.js";
import { timeContext, type PredictionContext } from "./prediction-log.js";

export interface RawEvent {
  seq: number;
  device_id: string;
  kind: string;
  ts_device: number;
  /** JSON text of the payload. */
  payload: string;
}

const ACTION_KINDS = new Set(["touch", "telemetry"]);

function parse(ev: RawEvent): Record<string, unknown> | null {
  try {
    const p = JSON.parse(ev.payload);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The screen a `screen_view` event opened, or null when the event is not a screen view. */
export function screenOf(ev: RawEvent): string | null {
  if (!ACTION_KINDS.has(ev.kind)) return null;
  const p = parse(ev);
  if (!p || p.type !== "screen_view") return null;
  return typeof p.screen === "string" && p.screen.length > 0 && p.screen.length <= 128 ? p.screen : null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 128 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

interface DeviceState {
  app: { package?: string; label?: string; screen?: string };
  device: NonNullable<PredictionContext["device"]>;
  ambient: NonNullable<PredictionContext["ambient"]>;
  location: NonNullable<PredictionContext["location"]>;
}

/** Running per-device context. Feed it every event in order, then ask for a snapshot at a moment. */
export class ContextTracker {
  private readonly state = new Map<string, DeviceState>();
  private externalAmbient: NonNullable<PredictionContext["ambient"]> = {};

  constructor(private readonly tzOffsetMin: (ts: number) => number = (ts) => -new Date(ts).getTimezoneOffset()) {}

  /** Ambient reading from a source other than the phone (for example a home sensor); phone readings win. */
  setAmbient(ambient: NonNullable<PredictionContext["ambient"]>): void {
    this.externalAmbient = { ...ambient };
  }

  private get(deviceId: string): DeviceState {
    let s = this.state.get(deviceId);
    if (!s) this.state.set(deviceId, (s = { app: {}, device: {}, ambient: {}, location: {} }));
    return s;
  }

  update(ev: RawEvent): void {
    if (!ACTION_KINDS.has(ev.kind)) return;
    const p = parse(ev);
    if (!p) return;
    const s = this.get(ev.device_id);
    const pkg = str(p.package);
    if (pkg) s.app.package = pkg;
    const label = str(p.app_label);
    if (label) s.app.label = label;
    const screen = str(p.screen);
    if (screen) s.app.screen = screen;

    const screenState = str(p.screen_state) ?? str(p.screenState);
    if (screenState) s.device.screen_state = screenState;
    const mode = str(p.mode);
    if (mode) s.device.mode = mode;
    const battery = num(p.battery_pct);
    if (battery !== undefined && battery >= 0 && battery <= 100) s.device.battery_pct = battery;
    const charging = bool(p.charging);
    if (charging !== undefined) s.device.charging = charging;
    const network = str(p.network);
    if (network) s.device.network = network;
    const idle = num(p.idle_ms);
    if (idle !== undefined && idle >= 0) s.device.idle_ms = idle;

    const temp = num(p.temp_c) ?? num(p.ambient_temp_c);
    if (temp !== undefined && temp > -90 && temp < 70) {
      s.ambient.temp_c = temp;
      s.ambient.source = "phone";
    }
    const humidity = num(p.humidity_pct);
    if (humidity !== undefined && humidity >= 0 && humidity <= 100) s.ambient.humidity_pct = humidity;

    const place = str(p.place);
    if (place) s.location.place = place;
    const lat = num(p.lat);
    const lon = num(p.lon);
    if (lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      s.location.lat = lat;
      s.location.lon = lon;
    }
    const acc = num(p.accuracy_m);
    if (acc !== undefined && acc >= 0) s.location.accuracy_m = acc;
  }

  /** Context at `ts` for a device: wall clock plus the latest tracked signals. */
  snapshot(deviceId: string, ts: number): PredictionContext {
    const s = this.state.get(deviceId);
    const ctx: PredictionContext = { time: timeContext(ts, this.tzOffsetMin(ts)) };
    if (!s) {
      if (Object.keys(this.externalAmbient).length > 0) ctx.ambient = { ...this.externalAmbient };
      return ctx;
    }
    if (Object.keys(s.app).length > 0) ctx.app = { ...s.app };
    if (Object.keys(s.device).length > 0) ctx.device = { ...s.device };
    const ambient = Object.keys(s.ambient).length > 0 ? s.ambient : Object.keys(this.externalAmbient).length > 0 ? this.externalAmbient : null;
    if (ambient) ctx.ambient = { ...ambient };
    if (Object.keys(s.location).length > 0) ctx.location = { ...s.location };
    return ctx;
  }
}

export interface ScreenExample extends Example {
  device_id: string;
  /** Sequence and time of the screen_view that was the guess point, and of the one that answered it. */
  from_seq: number;
  to_seq: number;
  from_ts: number;
  to_ts: number;
  context: PredictionContext;
}

/**
 * Consecutive screen views per device become examples: the guess point is the earlier view with the
 * context as it was then, and the answer is the next view.
 */
export function buildScreenExamples(events: readonly RawEvent[], tracker = new ContextTracker()): ScreenExample[] {
  const out: ScreenExample[] = [];
  const last = new Map<string, { screen: string; prev?: string; seq: number; ts: number; context: PredictionContext }>();
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    tracker.update(ev);
    const screen = screenOf(ev);
    if (!screen) continue;
    const prior = last.get(ev.device_id);
    if (prior) {
      out.push({
        device_id: ev.device_id,
        current: prior.screen,
        features: contextFeatures(prior.context, prior.prev),
        actual: screen,
        from_seq: prior.seq,
        to_seq: ev.seq,
        from_ts: prior.ts,
        to_ts: ev.ts_device,
        context: prior.context,
      });
    }
    last.set(ev.device_id, { screen, prev: prior?.screen, seq: ev.seq, ts: ev.ts_device, context: tracker.snapshot(ev.device_id, ev.ts_device) });
  }
  return out;
}
