/**
 * @file prediction-host.ts
 * Wires the next-action probability engine into event ingest.
 *
 * For every actionable event (screen_view or debounced passiveCapture) the phone reports, in order:
 *   1. the previous guess for that device is resolved against it (HIT / MISS / EXPIRED, with the real
 *      action and the situation it happened in kept either way),
 *   2. the engine learns from that pair,
 *   3. a new guess is made from the current screen and context and logged with its full context,
 *   4. engine state is checkpointed to prob_engine_checkpoints every 250 observations for O(1) restart hydration.
 *
 * Shadow only. Nothing here surfaces anything to the user, acts on a prediction, or feeds Precision@surface.
 */

import type { ExocortexDatabase } from "@exocortex/core/db";
import {
  ContextTracker,
  OTHER,
  ProbEngine,
  contextFeatures,
  ensurePredictionTables,
  ensureCheckpointTable,
  saveProbEngineCheckpoint,
  loadProbEngineCheckpoint,
  logPrediction,
  resolveWithAction,
  screenOf,
  type EngineOptions,
  type FeatureMap,
  type RawEvent,
} from "@exocortex/core";
import { PLAY_CATEGORIES } from "./play-categories.js";

export const DEFAULT_HORIZON_MS = 300_000;
export const DEFAULT_CHECKPOINT_INTERVAL = 250;
export const DEFAULT_DWELL_DEBOUNCE_MS = 1000;
const HISTORY_LIMIT = 5000;
const MAX_CANDIDATES = 8;

interface DeviceState {
  engine: ProbEngine;
  lastSeq: number;
  lastScreen?: string;
  lastFeatures: FeatureMap;
  lastPassiveTs?: number;
  lastPassiveAction?: string;
}

export interface PredictionHostOptions {
  horizonMs?: number;
  engine?: EngineOptions;
  tzOffsetMin?: (ts: number) => number;
  checkpointInterval?: number;
  dwellDebounceMs?: number;
  playCategories?: Record<string, string>;
}

/** Extract package name from a passiveCapture telemetry event, or null. */
export function passiveCapturePackage(ev: RawEvent): string | null {
  if (ev.kind !== "telemetry") return null;
  let p: Record<string, unknown>;
  try {
    p = typeof ev.payload === "string" ? JSON.parse(ev.payload) : (ev.payload as Record<string, unknown>);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
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

export class PredictionHost {
  private readonly horizonMs: number;
  private readonly engineOptions: EngineOptions;
  private readonly tracker: ContextTracker;
  private readonly tz?: (ts: number) => number;
  private readonly checkpointInterval: number;
  private readonly dwellDebounceMs: number;
  private readonly playCategories: Record<string, string>;
  private readonly devices = new Map<string, DeviceState>();
  private readonly ready = new WeakSet<object>();

  constructor(opts: PredictionHostOptions = {}) {
    this.horizonMs = opts.horizonMs ?? DEFAULT_HORIZON_MS;
    this.engineOptions = opts.engine ?? {};
    this.tz = opts.tzOffsetMin;
    this.tracker = new ContextTracker(this.tz);
    this.checkpointInterval = opts.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
    this.dwellDebounceMs = opts.dwellDebounceMs ?? DEFAULT_DWELL_DEBOUNCE_MS;
    this.playCategories = opts.playCategories ?? PLAY_CATEGORIES;
  }

  public get contextTracker(): ContextTracker {
    return this.tracker;
  }

  /** Update triage classification in the context tracker. */
  public updateTriage(deviceId: string, category: string, ts?: number): void {
    this.tracker.updateTriage(deviceId, category, ts);
  }

  /**
   * Determine the action represented by an event: either screen name from screen_view,
   * or category name from a debounced passiveCapture event.
   */
  public actionOf(ev: RawEvent, state?: DeviceState): string | null {
    const screen = screenOf(ev);
    if (screen) return screen;

    const pkg = passiveCapturePackage(ev);
    if (!pkg) return null;

    let p: Record<string, unknown> | null = null;
    try {
      p = typeof ev.payload === "string" ? JSON.parse(ev.payload) : (ev.payload as Record<string, unknown>);
    } catch {}

    const rawDwell = (p as any)?.dwell_ms ?? (p as any)?.touch_duration_ms;
    if (typeof rawDwell === "number" && Number.isFinite(rawDwell) && rawDwell < this.dwellDebounceMs) {
      return null;
    }

    if (state && state.lastPassiveTs !== undefined) {
      const dt = ev.ts_device - state.lastPassiveTs;
      if (dt >= 0 && dt < this.dwellDebounceMs) {
        return null;
      }
    }

    const category = (typeof p?.category === "string" && p.category !== "Uncategorized")
      ? p.category
      : (this.playCategories[pkg] ?? "Uncategorized");

    if (state) {
      state.lastPassiveTs = ev.ts_device;
      state.lastPassiveAction = category;
    }
    return category;
  }

  /** Rebuild a device's engine and tracked context from checkpoint or recent history. */
  private hydrate(db: ExocortexDatabase, deviceId: string, beforeSeq: number): DeviceState {
    const checkpoint = loadProbEngineCheckpoint(db, deviceId);
    if (checkpoint && checkpoint.last_seq < beforeSeq) {
      // O(1) Checkpoint load
      const engine = ProbEngine.fromJSON(JSON.parse(checkpoint.engine_json), this.engineOptions);
      let lastFeatures: FeatureMap = {};
      try {
        lastFeatures = JSON.parse(checkpoint.last_features);
      } catch {}

      const state: DeviceState = {
        engine,
        lastSeq: checkpoint.last_seq,
        lastScreen: checkpoint.last_screen ?? undefined,
        lastFeatures,
      };

      // Replay any delta events strictly between checkpoint.last_seq and beforeSeq
      const deltaRows = db.raw
        .prepare(
          `SELECT seq, device_id, kind, ts_device, payload FROM events
            WHERE device_id = ? AND kind IN ('touch','telemetry') AND seq > ? AND seq < ?
            ORDER BY seq ASC`,
        )
        .all(deviceId, checkpoint.last_seq, beforeSeq) as unknown as RawEvent[];

      for (const r of deltaRows) {
        state.lastSeq = r.seq;
        this.tracker.update(r);
        const action = this.actionOf(r, state);
        if (action) {
          if (state.lastScreen) {
            state.engine.observe(state.lastScreen, state.lastFeatures, action);
          }
          state.lastFeatures = contextFeatures(this.tracker.snapshot(deviceId, r.ts_device), state.lastScreen);
          state.lastScreen = action;
        }
      }

      this.devices.set(deviceId, state);
      return state;
    }

    // Cold-start history re-scan bounded to HISTORY_LIMIT
    const rows = db.raw
      .prepare(
        `SELECT seq, device_id, kind, ts_device, payload FROM events
          WHERE device_id = ? AND kind IN ('touch','telemetry') AND seq < ?
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(deviceId, beforeSeq, HISTORY_LIMIT) as unknown as RawEvent[];
    rows.reverse();

    const engine = new ProbEngine(this.engineOptions);
    const tempTracker = new ContextTracker(this.tz);
    const state: DeviceState = { engine, lastSeq: rows.length > 0 ? rows[rows.length - 1].seq : 0, lastFeatures: {} };

    for (const r of rows) {
      tempTracker.update(r);
      const action = this.actionOf(r, state);
      if (action) {
        if (state.lastScreen) {
          state.engine.observe(state.lastScreen, state.lastFeatures, action);
        }
        state.lastFeatures = contextFeatures(tempTracker.snapshot(deviceId, r.ts_device), state.lastScreen);
        state.lastScreen = action;
      }
    }

    for (const r of rows) {
      this.tracker.update(r);
    }

    this.devices.set(deviceId, state);
    return state;
  }

  /** Process newly appended events. Never throws into the caller's ingest path; see server wiring. */
  public onEventsAppended(events: readonly RawEvent[], db: ExocortexDatabase): { guesses: number; resolved: number } {
    if (!this.ready.has(db)) {
      ensurePredictionTables(db.raw);
      ensureCheckpointTable(db.raw);
      this.ready.add(db);
    }
    let guesses = 0;
    let resolved = 0;
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
      const state = this.devices.get(ev.device_id) ?? this.hydrate(db, ev.device_id, ev.seq);
      if (ev.seq <= state.lastSeq) continue;
      state.lastSeq = ev.seq;
      this.tracker.update(ev);

      const action = this.actionOf(ev, state);
      if (!action) continue;

      const ctx = this.tracker.snapshot(ev.device_id, ev.ts_device);
      resolved += resolveWithAction(db.raw, ev.device_id, { seq: ev.seq, ts: ev.ts_device, value: action, context: ctx });

      if (state.lastScreen) {
        state.engine.observe(state.lastScreen, state.lastFeatures, action);
        if (state.engine.examplesSeen > 0 && state.engine.examplesSeen % this.checkpointInterval === 0) {
          saveProbEngineCheckpoint(db, ev.device_id, ev.seq, action, state.lastFeatures, state.engine);
        }
      }

      const features = contextFeatures(ctx, state.lastScreen);
      const dist = state.engine.predict(action, features);
      const candidates = dist.probs.filter((p) => p.value !== OTHER).slice(0, MAX_CANDIDATES);
      if (candidates.length > 0 && ctx.time) {
        const other = dist.probs.find((p) => p.value === OTHER)?.prob ?? 0;
        const id = logPrediction(db.raw, {
          device_id: ev.device_id,
          made_seq: ev.seq,
          made_at: ev.ts_device,
          horizon_ms: this.horizonMs,
          context_key: `${action}|${ctx.time.daypart}`,
          candidates,
          context: {
            ...ctx,
            model: {
              other_prob: other,
              temperature: dist.temperature,
              active_experts: dist.active,
              weights: dist.weights,
              examples_seen: state.engine.examplesSeen,
            },
          },
        });
        if (id) guesses++;
      }
      state.lastScreen = action;
      state.lastFeatures = features;
    }
    return { guesses, resolved };
  }
}

export const defaultPredictionHost = new PredictionHost({
  horizonMs: Number(process.env.PREDICTION_HORIZON_MS) > 0 ? Number(process.env.PREDICTION_HORIZON_MS) : DEFAULT_HORIZON_MS,
});
