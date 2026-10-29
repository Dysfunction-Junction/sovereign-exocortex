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
 *
 * Typed device-signal events (type: app_foreground, screen_session, sensor_window, sensor_caps,
 * sensor_consent) are handled by explicit branches and never go through the flat keys above, so a
 * foreground arrival cannot clobber app.package and a sensor window cannot set ambient.temp_c.
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

export const HARDWARE_SIGNAL_TTL_MS = {
  audio: 30_000,          // 30 seconds for call & VoIP meeting state
  thermal: 30_000,        // 30 seconds for thermal throttling
  battery_micro: 120_000, // 2 minutes for battery micro-telemetry
  motion: 60_000,         // 60 seconds for motion prior
  notification_actions: 120_000, // 2 minutes for 1-tap notification actions
  physical_surface: 30_000, // 30 seconds for physical surface state
  network: 60_000,        // 60 seconds for network quality & metering
} as const;

/** How long a 5-minute sensor window (and what it feeds: motion, battery_micro) stays usable after window_end. */
export const SENSOR_WINDOW_TTL_MS = 10 * 60_000;

/** Window sensor key -> the `PredictionContext.sensors` fields it fills (dropped on consent revocation). */
const SENSOR_FIELDS: Readonly<Record<string, readonly string[]>> = {
  motion: ["motion_energy"],
  rotation: ["orient"],
  steps: ["steps_delta"],
  sig_motion: ["sig_motion"],
  pressure: ["pressure_trend"],
  light: ["light"],
  proximity: ["near_frac"],
  activity: ["activity"],
};

interface DeviceState {
  app: { package?: string; label?: string; screen?: string };
  device: NonNullable<PredictionContext["device"]>;
  ambient: NonNullable<PredictionContext["ambient"]>;
  location: NonNullable<PredictionContext["location"]>;
  system_suggestions?: NonNullable<PredictionContext["system_suggestions"]>;
  audio?: { data: NonNullable<PredictionContext["audio"]>; observed_ts: number };
  thermal?: { data: NonNullable<PredictionContext["thermal"]>; observed_ts: number };
  battery_micro?: { data: NonNullable<PredictionContext["battery_micro"]>; observed_ts: number; ttl?: number; from_sensor?: boolean };
  motion?: { data: NonNullable<PredictionContext["motion"]>; observed_ts: number; ttl?: number; from_sensor?: boolean };
  notification_actions?: { data: NonNullable<PredictionContext["notification_actions"]>; observed_ts: number };
  physical_surface?: { data: NonNullable<PredictionContext["physical_surface"]>; observed_ts: number };
  network_telemetry?: { data: NonNullable<PredictionContext["network_telemetry"]>; observed_ts: number };
  triage?: { category: string; observed_ts: number };
  /** Newest accepted sensor window; `keys` are the sensors that appeared in it. */
  sensors?: { window_end: number; data: NonNullable<PredictionContext["sensors"]>; keys: Set<string> };
  /** Latest sensor_caps: sensors the probe reported present, and the toggles it reported. */
  caps?: { present: Set<string>; toggles: Record<string, boolean> };
  /** Latest sensor_consent per sensor key. `false` means later windows must not feed that key. */
  consent: Map<string, boolean>;
}

/** Running per-device context. Feed it every event in order, then ask for a snapshot at a moment. */
export class ContextTracker {
  private readonly state = new Map<string, DeviceState>();
  private externalAmbient: NonNullable<PredictionContext["ambient"]> = {};

  private readonly sensorContext: boolean;

  /** `sensorContext` defaults to on; EXO_SENSOR_CONTEXT=0 makes sensor windows ignored here (they stay stored). */
  constructor(
    private readonly tzOffsetMin: (ts: number) => number = (ts) => -new Date(ts).getTimezoneOffset(),
    opts: { sensorContext?: boolean } = {},
  ) {
    this.sensorContext = opts.sensorContext ?? process.env.EXO_SENSOR_CONTEXT !== "0";
  }

  /** Ambient reading from a source other than the phone (for example a home sensor); phone readings win. */
  setAmbient(ambient: NonNullable<PredictionContext["ambient"]>): void {
    this.externalAmbient = { ...ambient };
  }

  updateTriage(deviceId: string, category: string, ts?: number): void {
    const s = this.get(deviceId);
    s.triage = { category, observed_ts: ts ?? 0 };
  }

  private get(deviceId: string): DeviceState {
    let s = this.state.get(deviceId);
    if (!s) this.state.set(deviceId, (s = { app: {}, device: {}, ambient: {}, location: {}, consent: new Map() }));
    return s;
  }

  update(ev: RawEvent): void {
    if (!ACTION_KINDS.has(ev.kind)) return;
    const p = parse(ev);
    if (!p) return;
    const s = this.get(ev.device_id);
    switch (p.type) {
      case "app_foreground": // an action (see actionOf), not context: must not touch app.package
      case "screen_session":
        return;
      case "sensor_window":
        this.applySensorWindow(s, p);
        return;
      case "sensor_caps":
        this.applySensorCaps(s, p);
        return;
      case "sensor_consent":
        this.applySensorConsent(s, p);
        return;
    }
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

    // Native Android system contextual suggestions & on-device TextClassifier priors
    const sysSuggest = str(p.sys_suggest) ?? str(p.suggested_action);
    const rawSuggestions = Array.isArray(p.contextual_suggestions)
      ? p.contextual_suggestions
      : Array.isArray(p.suggested_actions)
        ? p.suggested_actions
        : null;
    const actions: string[] = [];
    if (sysSuggest) actions.push(sysSuggest);
    if (rawSuggestions) {
      for (const item of rawSuggestions) {
        if (typeof item === "string" && item.length > 0 && item.length <= 128) {
          if (!actions.includes(item)) actions.push(item);
        } else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).action === "string") {
          const act = (item as Record<string, unknown>).action as string;
          if (act.length > 0 && act.length <= 128 && !actions.includes(act)) actions.push(act);
        }
      }
    }
    const rawEntities = Array.isArray(p.extracted_entities) ? p.extracted_entities : Array.isArray(p.entities) ? p.entities : null;
    const entities: Array<{ type: string; value: string; confidence?: number }> = [];
    if (rawEntities) {
      for (const ent of rawEntities) {
        if (
          ent &&
          typeof ent === "object" &&
          typeof (ent as Record<string, unknown>).type === "string" &&
          typeof (ent as Record<string, unknown>).value === "string"
        ) {
          entities.push({
            type: (ent as Record<string, unknown>).type as string,
            value: (ent as Record<string, unknown>).value as string,
            confidence: typeof (ent as Record<string, unknown>).confidence === "number" ? ((ent as Record<string, unknown>).confidence as number) : undefined,
          });
        }
      }
    }
    const ts = ev.ts_device || Date.now();
    if (actions.length > 0 || entities.length > 0) {
      s.system_suggestions = {
        primary_action: actions[0],
        actions: actions.length > 0 ? [...actions] : undefined,
        entities: entities.length > 0 ? entities.map((e) => ({ ...e })) : undefined,
        observed_ts: ts,
      };
    } else if (typeof p.package === "string" || typeof p.screen === "string") {
      // Clear suggestions when transitioning to a new screen context that lacks them
      delete s.system_suggestions;
    }

    const triageCat = str(p.triage) ?? str(p.triage_category) ?? (p.category === "urgent" || p.category === "routine" || p.category === "noise" ? str(p.category) : undefined);
    if (triageCat && (triageCat === "urgent" || triageCat === "routine" || triageCat === "noise")) {
      s.triage = { category: triageCat, observed_ts: ts };
    }

    // Hardware telemetry container support
    const hw = (p.hardware_telemetry && typeof p.hardware_telemetry === "object" ? p.hardware_telemetry : null) as Record<string, unknown> | null;

    // Native Android audio mode & headset routing
    const rawAudio = ((hw?.audio && typeof hw.audio === "object" ? hw.audio : null) ?? (p.audio && typeof p.audio === "object" ? p.audio : null)) as Record<string, unknown> | null;
    const audioMode = str(rawAudio?.mode) ?? str(p.audio_mode);
    const inCall = bool(rawAudio?.in_call) ?? bool(p.in_call);
    const musicActive = bool(rawAudio?.music_active) ?? bool(p.music_active);
    const outputType = str(rawAudio?.output_type) ?? str(p.audio_output_type);
    if (audioMode || inCall !== undefined || musicActive !== undefined || outputType) {
      s.audio = {
        data: {
          ...(audioMode ? { mode: audioMode } : {}),
          ...(inCall !== undefined ? { in_call: inCall } : {}),
          ...(musicActive !== undefined ? { music_active: musicActive } : {}),
          ...(outputType ? { output_type: outputType } : {}),
        },
        observed_ts: ts,
      };
    }

    // Native Android thermal headroom & throttling
    const rawThermal = ((hw?.thermal && typeof hw.thermal === "object" ? hw.thermal : null) ?? (p.thermal && typeof p.thermal === "object" ? p.thermal : null)) as Record<string, unknown> | null;
    const headroom = num(rawThermal?.headroom) ?? num(p.thermal_headroom);
    const thermalStatus = str(rawThermal?.status) ?? str(p.thermal_status);
    if (headroom !== undefined || thermalStatus) {
      s.thermal = {
        data: {
          ...(headroom !== undefined ? { headroom } : {}),
          ...(thermalStatus ? { status: thermalStatus } : {}),
        },
        observed_ts: ts,
      };
    }

    // Native Android battery micro-telemetry
    const rawBattery = ((hw?.battery_micro && typeof hw.battery_micro === "object" ? hw.battery_micro : null) ?? (p.battery_micro && typeof p.battery_micro === "object" ? p.battery_micro : null)) as Record<string, unknown> | null;
    const bTemp = num(rawBattery?.temp_c) ?? num(p.battery_temp_c);
    const bVolt = num(rawBattery?.voltage_mv) ?? num(p.battery_voltage_mv);
    const bPlugged = str(rawBattery?.plugged) ?? str(p.battery_plugged);
    const bCurrent = num(rawBattery?.current_ma) ?? num(p.battery_current_ma);
    if (bTemp !== undefined || bVolt !== undefined || bPlugged || bCurrent !== undefined) {
      s.battery_micro = {
        data: {
          ...(bTemp !== undefined ? { temp_c: bTemp } : {}),
          ...(bVolt !== undefined ? { voltage_mv: bVolt } : {}),
          ...(bPlugged ? { plugged: bPlugged } : {}),
          ...(bCurrent !== undefined ? { current_ma: bCurrent } : {}),
        },
        observed_ts: ts,
      };
    }

    // Physical motion prior
    const rawMotion = ((hw?.motion && typeof hw.motion === "object" ? hw.motion : null) ?? (p.motion && typeof p.motion === "object" ? p.motion : null)) as Record<string, unknown> | null;
    const motionState = str(rawMotion?.state) ?? str(p.motion_state);
    const motionConf = num(rawMotion?.confidence) ?? num(p.motion_confidence);
    if (motionState) {
      s.motion = {
        data: {
          state: motionState,
          ...(motionConf !== undefined ? { confidence: motionConf } : {}),
        },
        observed_ts: ts,
      };
    }

    // Actionable notification actions
    const rawNotifActions = Array.isArray(p.notification_actions) ? p.notification_actions : null;
    if (rawNotifActions && rawNotifActions.length > 0) {
      const actionsList: Array<{ action_id: string; title: string }> = [];
      for (const item of rawNotifActions) {
        if (item && typeof item === "object") {
          const aId = str((item as Record<string, unknown>).action_id);
          const aTitle = str((item as Record<string, unknown>).title);
          if (aId && aTitle) {
            actionsList.push({ action_id: aId, title: aTitle.slice(0, 64) });
          }
        }
      }
      if (actionsList.length > 0) {
        s.notification_actions = {
          data: actionsList.slice(0, 8),
          observed_ts: ts,
        };
      }
    }

    // Native Android physical surface / pocket detection
    const rawSurface = ((hw?.physical_surface && typeof hw.physical_surface === "object" ? hw.physical_surface : null) ??
      (p.physical_surface && typeof p.physical_surface === "object" ? p.physical_surface : null)) as Record<string, unknown> | null;
    const surfaceState = str(rawSurface?.state) ?? str(p.physical_state);
    const proxCm = num(rawSurface?.proximity_cm) ?? num(p.proximity_cm);
    const lux = num(rawSurface?.lux) ?? num(p.lux);
    const gravityZ = num(rawSurface?.gravity_z) ?? num(p.gravity_z);
    if ((surfaceState && surfaceState !== "unknown") || proxCm !== undefined || lux !== undefined || gravityZ !== undefined) {
      s.physical_surface = {
        data: {
          ...(surfaceState ? { state: surfaceState } : {}),
          ...(proxCm !== undefined ? { proximity_cm: proxCm } : {}),
          ...(lux !== undefined ? { lux } : {}),
          ...(gravityZ !== undefined ? { gravity_z: gravityZ } : {}),
        },
        observed_ts: ts,
      };
    }

    // Native Android network quality & metered gating
    const rawNet = ((hw?.network && typeof hw.network === "object" ? hw.network : null) ??
      (p.network_telemetry && typeof p.network_telemetry === "object" ? p.network_telemetry : null)) as Record<string, unknown> | null;
    const connected = bool(rawNet?.connected) ?? bool(p.network_connected);
    const vpn = bool(rawNet?.vpn) ?? bool(p.network_vpn);
    const transport = str(rawNet?.transport) ?? str(p.network_transport);
    const metered = bool(rawNet?.metered) ?? bool(p.metered);
    const downKbps = num(rawNet?.downstream_kbps) ?? num(p.downstream_kbps);
    const upKbps = num(rawNet?.upstream_kbps) ?? num(p.upstream_kbps);
    const validated = bool(rawNet?.validated) ?? bool(p.network_validated);
    if (connected !== undefined || vpn !== undefined || transport || metered !== undefined || downKbps !== undefined || upKbps !== undefined || validated !== undefined) {
      s.network_telemetry = {
        data: {
          ...(connected !== undefined ? { connected } : {}),
          ...(vpn !== undefined ? { vpn } : {}),
          ...(transport ? { transport } : {}),
          ...(metered !== undefined ? { metered } : {}),
          ...(downKbps !== undefined ? { downstream_kbps: downKbps } : {}),
          ...(upKbps !== undefined ? { upstream_kbps: upKbps } : {}),
          ...(validated !== undefined ? { validated } : {}),
        },
        observed_ts: ts,
      };
    }
  }

  /**
   * A 5-minute sensor aggregate. Accepted only when newer than the stored window, so a late older
   * window never overwrites a newer one. Never touches ambient.temp_c (battery temperature goes to
   * battery_micro only).
   */
  private applySensorWindow(s: DeviceState, p: Record<string, unknown>): void {
    if (!this.sensorContext) return;
    const end = num(p.window_end);
    const raw = p.sensors && typeof p.sensors === "object" && !Array.isArray(p.sensors) ? (p.sensors as Record<string, unknown>) : null;
    if (end === undefined || end <= 0 || !raw) return;
    if (s.sensors && end <= s.sensors.window_end) return;
    const grp = (k: string): Record<string, unknown> | null =>
      s.consent.get(k) !== false && raw[k] && typeof raw[k] === "object" && !Array.isArray(raw[k]) ? (raw[k] as Record<string, unknown>) : null;

    const data: NonNullable<PredictionContext["sensors"]> = { window_end: end };
    const keys = new Set<string>();
    const energy = str(grp("motion")?.energy_class);
    if (energy) {
      data.motion_energy = energy;
      keys.add("motion");
    }
    const orient = str(grp("rotation")?.orient);
    if (orient) {
      data.orient = orient;
      keys.add("rotation");
    }
    const steps = num(grp("steps")?.delta);
    if (steps !== undefined && steps >= 0) {
      data.steps_delta = steps;
      keys.add("steps");
    }
    const sig = bool(grp("sig_motion")?.fired);
    if (sig !== undefined) {
      data.sig_motion = sig;
      keys.add("sig_motion");
    }
    const trend = str(grp("pressure")?.trend);
    if (trend) {
      data.pressure_trend = trend;
      keys.add("pressure");
    }
    const light = str(grp("light")?.bucket);
    if (light) {
      data.light = light;
      keys.add("light");
    }
    const near = num(grp("proximity")?.near_frac);
    if (near !== undefined && near >= 0 && near <= 1) {
      data.near_frac = near;
      keys.add("proximity");
    }
    const activity = grp("activity");
    const activityState = str(activity?.state);
    if (activityState) {
      data.activity = activityState;
      keys.add("activity");
      if (!s.motion || end > s.motion.observed_ts) {
        const conf = num(activity?.conf);
        s.motion = {
          data: { state: activityState, ...(conf !== undefined ? { confidence: conf } : {}) },
          observed_ts: end,
          ttl: SENSOR_WINDOW_TTL_MS,
          from_sensor: true,
        };
      }
    }
    const battery = grp("battery");
    if (battery) {
      keys.add("battery");
      const pct = num(battery.pct);
      if (pct !== undefined && pct >= 0 && pct <= 100) s.device.battery_pct = pct;
      const plugged = str(battery.plugged);
      if (plugged) s.device.charging = plugged !== "unplugged" && plugged !== "none";
      const bTemp = num(battery.batt_temp_c);
      if (bTemp !== undefined || plugged) {
        s.battery_micro = {
          data: { ...(bTemp !== undefined ? { temp_c: bTemp } : {}), ...(plugged ? { plugged } : {}) },
          observed_ts: end,
          ttl: SENSOR_WINDOW_TTL_MS,
          from_sensor: true,
        };
      }
    }
    s.sensors = { window_end: end, data, keys };
  }

  private applySensorCaps(s: DeviceState, p: Record<string, unknown>): void {
    const raw = p.sensors && typeof p.sensors === "object" && !Array.isArray(p.sensors) ? (p.sensors as Record<string, unknown>) : null;
    if (!raw) return;
    const present = new Set<string>();
    for (const [k, v] of Object.entries(raw)) if (v && typeof v === "object" && (v as Record<string, unknown>).present === true) present.add(k);
    const toggles: Record<string, boolean> = {};
    if (p.toggles && typeof p.toggles === "object" && !Array.isArray(p.toggles)) {
      for (const [k, v] of Object.entries(p.toggles as Record<string, unknown>)) if (typeof v === "boolean") toggles[k] = v;
    }
    s.caps = { present, toggles };
  }

  /** Revocation: later windows ignore the key, and what it already put into the running state is dropped. */
  private applySensorConsent(s: DeviceState, p: Record<string, unknown>): void {
    const key = str(p.key);
    const enabled = bool(p.enabled);
    if (!key || enabled === undefined) return;
    s.consent.set(key, enabled);
    if (enabled) return;
    if (s.sensors) {
      for (const f of SENSOR_FIELDS[key] ?? []) delete (s.sensors.data as Record<string, unknown>)[f];
      s.sensors.keys.delete(key);
    }
    if (key === "activity" && s.motion?.from_sensor) delete s.motion;
    if (key === "battery" && s.battery_micro?.from_sensor) delete s.battery_micro;
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
    if (s.system_suggestions && (s.system_suggestions.actions?.length || s.system_suggestions.entities?.length || s.system_suggestions.primary_action)) {
      const observed = s.system_suggestions.observed_ts ?? ts;
      const d = ts - observed;
      // Stale suggestion guard: discard suggestions older than 5 minutes or from the future
      if (d >= 0 && d <= 5 * 60_000) {
        ctx.system_suggestions = {
          primary_action: s.system_suggestions.primary_action,
          actions: s.system_suggestions.actions ? [...s.system_suggestions.actions] : undefined,
          entities: s.system_suggestions.entities ? s.system_suggestions.entities.map((e) => ({ ...e })) : undefined,
          observed_ts: s.system_suggestions.observed_ts,
        };
      }
    }
    if (s.audio) {
      const d = ts - s.audio.observed_ts;
      if (d >= 0 && d <= HARDWARE_SIGNAL_TTL_MS.audio) {
        ctx.audio = { ...s.audio.data };
      }
    }
    if (s.thermal) {
      const d = ts - s.thermal.observed_ts;
      if (d >= 0 && d <= HARDWARE_SIGNAL_TTL_MS.thermal) {
        ctx.thermal = { ...s.thermal.data };
      }
    }
    if (s.battery_micro) {
      const d = ts - s.battery_micro.observed_ts;
      if (d >= 0 && d <= (s.battery_micro.ttl ?? HARDWARE_SIGNAL_TTL_MS.battery_micro)) {
        ctx.battery_micro = { ...s.battery_micro.data };
      }
    }
    if (s.motion) {
      const d = ts - s.motion.observed_ts;
      if (d >= 0 && d <= (s.motion.ttl ?? HARDWARE_SIGNAL_TTL_MS.motion)) {
        ctx.motion = { ...s.motion.data };
      }
    }
    if (s.notification_actions) {
      const d = ts - s.notification_actions.observed_ts;
      if (d >= 0 && d <= HARDWARE_SIGNAL_TTL_MS.notification_actions) {
        ctx.notification_actions = s.notification_actions.data.map((a) => ({ ...a }));
      }
    }
    if (s.physical_surface) {
      const d = ts - s.physical_surface.observed_ts;
      if (d >= 0 && d <= HARDWARE_SIGNAL_TTL_MS.physical_surface) {
        ctx.physical_surface = { ...s.physical_surface.data };
        if (ctx.physical_surface.state && ctx.physical_surface.state !== "unknown") {
          ctx.ambient = { ...ctx.ambient, physical_state: ctx.physical_surface.state };
        }
        if (typeof ctx.physical_surface.proximity_cm === "number") {
          ctx.ambient = { ...ctx.ambient, proximity_cm: ctx.physical_surface.proximity_cm };
        }
        if (typeof ctx.physical_surface.lux === "number") {
          ctx.ambient = { ...ctx.ambient, lux: ctx.physical_surface.lux };
        }
      }
    }
    if (s.triage) {
      if (s.triage.observed_ts === 0) {
        ctx.triage = s.triage.category;
      } else {
        const d = ts - s.triage.observed_ts;
        if (d >= 0 && d <= 7_200_000) {
          ctx.triage = s.triage.category;
        }
      }
    }
    if (s.network_telemetry) {
      const d = ts - s.network_telemetry.observed_ts;
      if (d >= 0 && d <= HARDWARE_SIGNAL_TTL_MS.network) {
        ctx.network_telemetry = { ...s.network_telemetry.data };
        if (typeof ctx.network_telemetry.metered === "boolean") {
          ctx.device = { ...ctx.device, metered: ctx.network_telemetry.metered };
        }
        if (typeof ctx.network_telemetry.downstream_kbps === "number") {
          ctx.device = { ...ctx.device, network_bandwidth_kbps: ctx.network_telemetry.downstream_kbps };
        }
        if (ctx.network_telemetry.transport && !ctx.device?.network) {
          ctx.device = { ...ctx.device, network: ctx.network_telemetry.transport };
        }
      }
    }
    if (this.sensorContext) {
      const fresh = !!s.sensors && ts - s.sensors.window_end >= 0 && ts - s.sensors.window_end <= SENSOR_WINDOW_TTL_MS;
      if (fresh) ctx.sensors = { ...s.sensors!.data };
      if (s.caps) {
        // Present and toggled on, yet absent from the fresh window: a real gap, not an opt-out.
        const stale = [...s.caps.present]
          .filter((k) => (s.consent.get(k) ?? s.caps!.toggles[k]) === true && !(fresh && s.sensors!.keys.has(k)))
          .map((k) => `sensors.${k}`);
        if (stale.length > 0) ctx.missing = stale;
      }
    }
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
