/**
 * @file prediction-host.ts
 * Wires the next-action probability engine into event ingest.
 *
 * For every actionable event (screen_view, debounced passiveCapture, or an app_foreground arrival) the
 * phone reports, in order:
 *   1. the previous guess for that device is resolved against it (HIT / MISS / EXPIRED, with the real
 *      action and the situation it happened in kept either way),
 *   2. the engine learns from that pair,
 *   3. a new guess is made from the current screen and context and logged with its full context,
 *   4. engine state is checkpointed to prob_engine_checkpoints every 250 observations for O(1) restart hydration.
 *
 * Two independent streams per device: "screen" (screen views and passive captures) and "app"
 * (foreground arrivals). Each has its own engine, baselines, checkpoint and ledger rows
 * (`context.stream`), so late-arriving app events cannot resolve screen guesses. In the app stream an
 * action older than the newest on-time one (see core isLate) updates context and baselines only.
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
  UsageBaseline,
  actionOf as coreActionOf,
  isLate,
  streamOf,
  APP_LABEL_RULE,
  passiveCapturePackage,
  timeContext,
  DEFAULT_DWELL_DEBOUNCE_MS,
  BASELINE_WINDOW_MS,
  type Daypart,
  type EngineOptions,
  type FeatureMap,
  type PassiveActionState,
  type PredictionStream,
  type RawEvent,
} from "@exocortex/core";
import { PLAY_CATEGORIES } from "./play-categories.js";

export const DEFAULT_HORIZON_MS = 300_000;
export const DEFAULT_CHECKPOINT_INTERVAL = 250;
export { DEFAULT_DWELL_DEBOUNCE_MS, passiveCapturePackage };

const stateKey = (deviceId: string, stream: PredictionStream): string => `${deviceId}\u0000${stream}`;
/** The checkpoint table has one row per key and no stream column; the app stream gets its own key (no schema change). */
const checkpointKey = (deviceId: string, stream: PredictionStream): string => (stream === "app" ? `${deviceId}#app` : deviceId);
const HISTORY_LIMIT = 5000;
const MAX_CANDIDATES = 8;

interface DeviceState extends PassiveActionState {
  stream: PredictionStream;
  engine: ProbEngine;
  /** Pre-registered average-usage and persistence baselines (14-day window). */
  baseline: UsageBaseline;
  lastSeq: number;
  lastScreen?: string;
  lastFeatures: FeatureMap;
  /** Late app actions skipped since the last logged row (reported as context.model.late_skipped). */
  lateSkipped: number;
}

export interface PredictionHostOptions {
  horizonMs?: number;
  engine?: EngineOptions;
  tzOffsetMin?: (ts: number) => number;
  checkpointInterval?: number;
  dwellDebounceMs?: number;
  playCategories?: Record<string, string>;
}

/**
 * Action represented by an event (screen name or passive-capture category), with the package -> category
 * map injected. The logic lives in core so offline evaluation replays exactly what the host sees.
 */
export function actionOf(
  ev: RawEvent,
  state?: { lastPassiveTs?: number; lastPassiveAction?: string },
  opts: { playCategories?: Record<string, string>; dwellDebounceMs?: number } = {},
): string | null {
  return coreActionOf(ev, state, { playCategories: PLAY_CATEGORIES, ...opts });
}

export class PredictionHost {
  private readonly horizonMs: number;
  private readonly engineOptions: EngineOptions;
  private readonly tracker: ContextTracker;
  private readonly tz?: (ts: number) => number;
  private readonly checkpointInterval: number;
  private readonly dwellDebounceMs: number;
  private readonly playCategories: Record<string, string>;
  /** One state per (device, stream). */
  private readonly devices = new Map<string, DeviceState>();
  /** Devices whose live context tracker has been seeded from history (each event reaches it exactly once). */
  private readonly trackerReady = new Set<string>();
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

  /** Determine the action represented by an event (see core actionOf). */
  public actionOf(ev: RawEvent, state?: DeviceState): string | null {
    return coreActionOf(ev, state, { playCategories: this.playCategories, dwellDebounceMs: this.dwellDebounceMs });
  }

  private daypartAt(ts: number): Daypart {
    return timeContext(ts, (this.tz ?? ((t: number) => -new Date(t).getTimezoneOffset()))(ts)).daypart;
  }

  /** Action of an event for one stream, or null when the event belongs to the other stream. */
  private streamAction(ev: RawEvent, state: DeviceState): string | null {
    return streamOf(ev) === state.stream ? this.actionOf(ev, state) : null;
  }

  /** The late rule applies to the app stream only: screen events arrive live, and its ledger must stay comparable. */
  private isLateAction(ev: RawEvent, state: DeviceState): boolean {
    return state.stream === "app" && isLate(ev, state);
  }

  /** Seed the live tracker once per device with recent history (also covers the other stream's events). */
  private seedTracker(db: ExocortexDatabase, deviceId: string, beforeSeq: number): void {
    if (this.trackerReady.has(deviceId)) return;
    this.trackerReady.add(deviceId);
    const rows = db.raw
      .prepare(
        `SELECT seq, device_id, kind, ts_device, payload FROM events
          WHERE device_id = ? AND kind IN ('touch','telemetry') AND seq < ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(deviceId, beforeSeq, HISTORY_LIMIT) as unknown as RawEvent[];
    for (const r of rows.reverse()) this.tracker.update(r);
  }

  /**
   * Rebuild one stream's engine and baselines from the log in a single ordered pass,
   * through the same action and late rules the live path uses. The pass covers the 14-day baseline window
   * plus every row after the engine's starting point (the checkpoint, or the last HISTORY_LIMIT rows);
   * only rows after that point train the engine.
   */
  private hydrate(db: ExocortexDatabase, deviceId: string, stream: PredictionStream, beforeSeq: number, nowTs: number): DeviceState {
    const ckptKey = checkpointKey(deviceId, stream);
    const checkpoint = loadProbEngineCheckpoint(db, ckptKey);
    const fromCheckpoint = !!checkpoint && checkpoint.last_seq < beforeSeq;

    let engineFloor: number; // rows with seq > engineFloor train the engine
    let engine: ProbEngine;
    let lastFeatures: FeatureMap = {};
    if (fromCheckpoint) {
      engineFloor = checkpoint!.last_seq;
      engine = ProbEngine.fromJSON(JSON.parse(checkpoint!.engine_json), this.engineOptions);
      try {
        lastFeatures = JSON.parse(checkpoint!.last_features);
      } catch {}
    } else {
      const edge = db.raw
        .prepare(
          `SELECT seq FROM events WHERE device_id = ? AND kind IN ('touch','telemetry') AND seq < ?
            ORDER BY seq DESC LIMIT 1 OFFSET ?`,
        )
        .get(deviceId, beforeSeq, HISTORY_LIMIT - 1) as { seq: number } | undefined;
      engineFloor = edge ? edge.seq - 1 : 0;
      engine = new ProbEngine(this.engineOptions);
    }

    const rows = db.raw
      .prepare(
        `SELECT seq, device_id, kind, ts_device, payload FROM events
          WHERE device_id = ? AND kind IN ('touch','telemetry') AND seq < ? AND (seq > ? OR ts_device >= ?)
          ORDER BY seq ASC`,
      )
      .all(deviceId, beforeSeq, engineFloor, nowTs - BASELINE_WINDOW_MS) as unknown as RawEvent[];

    const state: DeviceState = {
      stream,
      engine,
      baseline: new UsageBaseline(),
      lastSeq: fromCheckpoint ? checkpoint!.last_seq : 0,
      lastScreen: fromCheckpoint ? (checkpoint!.last_screen ?? undefined) : undefined,
      lastFeatures,
      lateSkipped: 0,
    };
    const featTracker = new ContextTracker(this.tz);

    for (const r of rows) {
      state.lastSeq = Math.max(state.lastSeq, r.seq);
      featTracker.update(r);
      const action = this.streamAction(r, state);
      if (!action) continue;
      const late = this.isLateAction(r, state);
      if (!late) state.lastActionTs = r.ts_device;
      if (r.ts_device >= nowTs - BASELINE_WINDOW_MS) state.baseline.observe(action, r.ts_device, this.daypartAt(r.ts_device));
      if (r.seq <= engineFloor || late) continue;
      if (state.lastScreen) state.engine.observe(state.lastScreen, state.lastFeatures, action);
      state.lastFeatures = contextFeatures(featTracker.snapshot(deviceId, r.ts_device), state.lastScreen);
      state.lastScreen = action;
    }

    this.devices.set(stateKey(deviceId, stream), state);
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
      const stream = streamOf(ev);
      const state = this.devices.get(stateKey(ev.device_id, stream)) ?? this.hydrate(db, ev.device_id, stream, ev.seq, ev.ts_device);
      if (ev.seq <= state.lastSeq) continue;
      state.lastSeq = ev.seq;
      this.seedTracker(db, ev.device_id, ev.seq);
      this.tracker.update(ev);

      const action = this.actionOf(ev, state);
      if (!action) continue;

      const daypart = this.daypartAt(ev.ts_device);
      if (this.isLateAction(ev, state)) {
        // Context and baselines still learn it; it makes no guess, resolves nothing and trains no engine.
        state.baseline.observe(action, ev.ts_device, daypart);
        state.lateSkipped++;
        continue;
      }
      state.lastActionTs = ev.ts_device;

      const ctx = this.tracker.snapshot(ev.device_id, ev.ts_device);
      resolved += resolveWithAction(db.raw, ev.device_id, { seq: ev.seq, ts: ev.ts_device, value: action, context: ctx }, stream);

      if (state.lastScreen) {
        state.engine.observe(state.lastScreen, state.lastFeatures, action);
        if (state.engine.examplesSeen > 0 && state.engine.examplesSeen % this.checkpointInterval === 0) {
          saveProbEngineCheckpoint(db, checkpointKey(ev.device_id, stream), ev.seq, action, state.lastFeatures, state.engine);
        }
      }

      const day = ctx.time?.daypart ?? daypart;
      // Pre-registered: the baselines see every action up to and including this one, and not the next.
      state.baseline.observe(action, ev.ts_device, day);
      const baselines = state.baseline.predict(ev.ts_device, day);

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
            stream,
            ...(stream === "app" ? { label_rule: APP_LABEL_RULE } : {}),
            baselines,
            model: {
              other_prob: other,
              temperature: dist.temperature,
              active_experts: dist.active,
              weights: dist.weights,
              examples_seen: state.engine.examplesSeen,
              ...(stream === "app" ? { late_skipped: state.lateSkipped } : {}),
            },
          },
        });
        if (id) {
          guesses++;
          state.lateSkipped = 0;
        }
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
