/**
 * @file action-of.ts
 * The single definition of "what action did this event represent": a screen name from a screen_view,
 * a (play-store) category from a debounced passive capture, or an app label from a foreground arrival
 * (`app_foreground`). Shared by the daemon's prediction host and the offline evaluator so both replay
 * the same actions, including which events are late.
 */

import { screenOf, type RawEvent } from "./prediction-events.js";
import type { PredictionStream } from "./prediction-log.js";
import { BASELINE_WINDOW_MS } from "./usage-baseline.js";

export const DEFAULT_DWELL_DEBOUNCE_MS = 1000;

/** Pre-registered (k=5): an app is labelled `pkg:<package>` once it has this many arrivals in the trailing window. */
export const APP_PKG_MIN_ARRIVALS = 5;
export const APP_PKG_WINDOW_MS = BASELINE_WINDOW_MS;
/** Logged as `context.label_rule` on app-stream predictions. */
export const APP_LABEL_RULE = "k5";

/** Per-device (and per-stream) memory; actionOf updates it when it returns a passive or app action. */
export interface PassiveActionState {
  lastPassiveTs?: number;
  lastPassiveAction?: string;
  /** Timestamp of the newest on-time action; the host maintains it, `isLate` reads it. */
  lastActionTs?: number;
  /** Arrival timestamps per package inside the trailing window (counted by actionOf for app_foreground). */
  pkgArrivals?: Map<string, number[]>;
}

export interface ActionOfOptions {
  /** package -> category map (injected; the daemon owns the data). */
  playCategories?: Record<string, string>;
  dwellDebounceMs?: number;
}

function payloadOf(ev: RawEvent): Record<string, unknown> | null {
  try {
    const p = typeof ev.payload === "string" ? JSON.parse(ev.payload) : (ev.payload as unknown as Record<string, unknown>);
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract package name from a passiveCapture telemetry event, or null. */
export function passiveCapturePackage(ev: RawEvent): string | null {
  if (ev.kind !== "telemetry") return null;
  const p = payloadOf(ev);
  if (!p) return null;
  if (p.type === "passive_capture" && typeof p.package === "string" && p.package) {
    return p.package;
  }
  if (p.type === "system_telemetry" && typeof p.telemetry === "string") {
    if (p.telemetry.startsWith("SMS ") || p.telemetry.startsWith("Notification from ")) {
      return null;
    }
    if (typeof p.package === "string" && p.package && p.telemetry.startsWith("Package: ")) {
      return p.package;
    }
    if (p.telemetry.startsWith("Package: ")) {
      const match = p.telemetry.match(/^Package:\s*([^\s\n]+)/);
      if (match && match[1]) return match[1];
    }
  }
  return null;
}

/** True for a telemetry event carrying `type: "app_foreground"`. */
function isAppForeground(p: Record<string, unknown> | null, ev: RawEvent): p is Record<string, unknown> {
  return ev.kind === "telemetry" && p?.type === "app_foreground";
}

/** Prediction stream an action belongs to: foreground arrivals are "app", everything else "screen". */
export function streamOf(ev: RawEvent): PredictionStream {
  return isAppForeground(payloadOf(ev), ev) ? "app" : "screen";
}

/**
 * An action older than the newest on-time action of its stream. Arrivals reach the daemon up to five
 * minutes late; such an action may update context and baselines but must not predict or resolve,
 * or it would resolve newer guesses with latency 0.
 */
export function isLate(ev: Pick<RawEvent, "ts_device">, state: Pick<PassiveActionState, "lastActionTs">): boolean {
  return state.lastActionTs !== undefined && ev.ts_device < state.lastActionTs;
}

const shortStr = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 128 ? v : undefined);

/** Records an arrival and returns how many the package has in the trailing window ending at `ts` (including this one). */
function countArrival(state: PassiveActionState, pkg: string, ts: number): number {
  const all: Map<string, number[]> = (state.pkgArrivals ??= new Map());
  const list = all.get(pkg) ?? [];
  list.push(ts);
  // Drop arrivals that fell out of the window of the newest one, so the list stays bounded.
  const newest = list.reduce((m, t) => Math.max(m, t), ts);
  const kept = list.filter((t) => t >= newest - APP_PKG_WINDOW_MS);
  all.set(pkg, kept);
  return kept.filter((t) => t >= ts - APP_PKG_WINDOW_MS && t <= ts).length;
}

/**
 * Label for a foreground arrival. Excluded apps are `cat:excluded` and noise (launcher, system UI) is
 * `cat:home` or `cat:system`, so a privacy-redacted package never becomes a label. Otherwise
 * `pkg:<to>` once the package has APP_PKG_MIN_ARRIVALS arrivals in the trailing 14 days (counted in
 * `state`; a stateless lookup never reaches it), else `cat:<category>`.
 */
function appForegroundAction(p: Record<string, unknown>, ev: RawEvent, state: PassiveActionState | undefined, opts: ActionOfOptions): string | null {
  const category = shortStr(p.category);
  if (p.excluded === true || category === "excluded") return "cat:excluded";
  if (category === "home" || category === "system") return `cat:${category}`;
  const to = shortStr(p.to);
  if (!to && !category) return null;
  if (to && state && countArrival(state, to, ev.ts_device) >= APP_PKG_MIN_ARRIVALS) return `pkg:${to}`;
  const resolved = category && category !== "Uncategorized" ? category : ((to ? opts.playCategories?.[to] : undefined) ?? category ?? "Uncategorized");
  return `cat:${resolved}`;
}

/**
 * The action represented by an event: a screen name from screen_view, a label from an app_foreground
 * arrival, or a category from a debounced passiveCapture event. Returns null for anything else. Pass
 * `state` to apply and record the passive-event debounce and the arrival counts (omit it for a
 * stateless lookup).
 */
export function actionOf(ev: RawEvent, state?: PassiveActionState, opts: ActionOfOptions = {}): string | null {
  const screen = screenOf(ev);
  if (screen) return screen;

  const fg = payloadOf(ev);
  if (isAppForeground(fg, ev)) return appForegroundAction(fg, ev, state, opts);

  const pkg = passiveCapturePackage(ev);
  if (!pkg) return null;

  const debounceMs = opts.dwellDebounceMs ?? DEFAULT_DWELL_DEBOUNCE_MS;
  const p = payloadOf(ev);

  const rawDwell = p?.dwell_ms ?? p?.touch_duration_ms;
  if (typeof rawDwell === "number" && Number.isFinite(rawDwell) && rawDwell < debounceMs) {
    return null;
  }

  if (state && state.lastPassiveTs !== undefined) {
    const dt = ev.ts_device - state.lastPassiveTs;
    if (dt >= 0 && dt < debounceMs) {
      return null;
    }
  }

  const category =
    typeof p?.category === "string" && p.category !== "Uncategorized" ? p.category : (opts.playCategories?.[pkg] ?? "Uncategorized");

  if (state) {
    state.lastPassiveTs = ev.ts_device;
    state.lastPassiveAction = category;
  }
  return category;
}
