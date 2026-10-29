/**
 * @file action-of.ts
 * The single definition of "what action did this event represent": a screen name from a screen_view,
 * or a (play-store) category from a debounced passive capture. Shared by the daemon's prediction host
 * and the offline evaluator so both replay the same actions.
 */

import { screenOf, type RawEvent } from "./prediction-events.js";

export const DEFAULT_DWELL_DEBOUNCE_MS = 1000;

/** Per-device debounce memory; actionOf updates it when it returns a passive action. */
export interface PassiveActionState {
  lastPassiveTs?: number;
  lastPassiveAction?: string;
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

/**
 * The action represented by an event: a screen name from screen_view, or a category from a debounced
 * passiveCapture event. Returns null for anything else. Pass `state` to apply and record the
 * passive-event debounce (omit it for a stateless lookup).
 */
export function actionOf(ev: RawEvent, state?: PassiveActionState, opts: ActionOfOptions = {}): string | null {
  const screen = screenOf(ev);
  if (screen) return screen;

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
