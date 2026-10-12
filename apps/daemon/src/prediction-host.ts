/**
 * @file prediction-host.ts
 * Wires the next-action probability engine into event ingest.
 *
 * For every `screen_view` the phone reports, in order:
 *   1. the previous guess for that device is resolved against it (HIT / MISS / EXPIRED, with the real
 *      action and the situation it happened in kept either way),
 *   2. the engine learns from that pair,
 *   3. a new guess is made from the current screen and context and logged with its full context.
 *
 * Shadow only. Nothing here surfaces anything to the user, acts on a prediction, or feeds Precision@surface.
 * Engine state is rebuilt from the latest 5,000 eligible events for a device the first time it is seen
 * after a restart. This bounded warm start is deterministic for that window, but it does not reproduce
 * a model trained on the device's full history once the history exceeds the limit.
 *
 * Guesses are left open until the next screen view arrives; the horizon is applied then (a late next
 * action resolves as EXPIRED). They are not expired against the server clock, because device clocks drift.
 */

import type { ExocortexDatabase } from "@exocortex/core/db";
import {
  ContextTracker,
  OTHER,
  ProbEngine,
  buildScreenExamples,
  contextFeatures,
  ensurePredictionTables,
  logPrediction,
  resolveWithAction,
  screenOf,
  type EngineOptions,
  type FeatureMap,
  type RawEvent,
} from "@exocortex/core";

export const DEFAULT_HORIZON_MS = 300_000;
const HISTORY_LIMIT = 5000;
const MAX_CANDIDATES = 8;

interface DeviceState {
  engine: ProbEngine;
  lastSeq: number;
  lastScreen?: string;
  lastFeatures: FeatureMap;
}

export interface PredictionHostOptions {
  horizonMs?: number;
  engine?: EngineOptions;
  tzOffsetMin?: (ts: number) => number;
}

export class PredictionHost {
  private readonly horizonMs: number;
  private readonly engineOptions: EngineOptions;
  private readonly tracker: ContextTracker;
  private readonly tz?: (ts: number) => number;
  private readonly devices = new Map<string, DeviceState>();
  private readonly ready = new WeakSet<object>();

  constructor(opts: PredictionHostOptions = {}) {
    this.horizonMs = opts.horizonMs ?? DEFAULT_HORIZON_MS;
    this.engineOptions = opts.engine ?? {};
    this.tz = opts.tzOffsetMin;
    this.tracker = new ContextTracker(this.tz);
  }

  /** Rebuild a device's engine and tracked context from events before `beforeSeq`. */
  private hydrate(db: ExocortexDatabase, deviceId: string, beforeSeq: number): DeviceState {
    const rows = db.raw
      .prepare(
        `SELECT seq, device_id, kind, ts_device, payload FROM events
          WHERE device_id = ? AND kind IN ('touch','telemetry') AND seq < ?
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(deviceId, beforeSeq, HISTORY_LIMIT) as unknown as RawEvent[];
    rows.reverse();

    const engine = new ProbEngine(this.engineOptions);
    for (const ex of buildScreenExamples(rows, this.tracker)) engine.observe(ex.current, ex.features, ex.actual);

    const state: DeviceState = { engine, lastSeq: rows.length > 0 ? rows[rows.length - 1].seq : 0, lastFeatures: {} };
    // The guess point for the next screen view is the last screen view in history, with the context then.
    const views = rows.filter((r) => screenOf(r) !== null);
    const last = views[views.length - 1];
    if (last) {
      const before = views[views.length - 2];
      state.lastScreen = screenOf(last) ?? undefined;
      const upTo = rows.filter((r) => r.seq <= last.seq);
      const t = new ContextTracker(this.tz);
      for (const r of upTo) t.update(r);
      state.lastFeatures = contextFeatures(t.snapshot(deviceId, last.ts_device), before ? screenOf(before) ?? undefined : undefined);
    }
    this.devices.set(deviceId, state);
    return state;
  }

  /** Process newly appended events. Never throws into the caller's ingest path; see server wiring. */
  onEventsAppended(events: readonly RawEvent[], db: ExocortexDatabase): { guesses: number; resolved: number } {
    if (!this.ready.has(db)) {
      ensurePredictionTables(db.raw);
      this.ready.add(db);
    }
    let guesses = 0;
    let resolved = 0;
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
      const state = this.devices.get(ev.device_id) ?? this.hydrate(db, ev.device_id, ev.seq);
      if (ev.seq <= state.lastSeq) continue;
      state.lastSeq = ev.seq;
      this.tracker.update(ev);

      const screen = screenOf(ev);
      if (!screen) continue;

      const ctx = this.tracker.snapshot(ev.device_id, ev.ts_device);
      resolved += resolveWithAction(db.raw, ev.device_id, { seq: ev.seq, ts: ev.ts_device, value: screen, context: ctx });
      if (state.lastScreen) state.engine.observe(state.lastScreen, state.lastFeatures, screen);

      const features = contextFeatures(ctx, state.lastScreen);
      const dist = state.engine.predict(screen, features);
      const candidates = dist.probs.filter((p) => p.value !== OTHER).slice(0, MAX_CANDIDATES);
      if (candidates.length > 0 && ctx.time) {
        const other = dist.probs.find((p) => p.value === OTHER)?.prob ?? 0;
        const id = logPrediction(db.raw, {
          device_id: ev.device_id,
          made_seq: ev.seq,
          made_at: ev.ts_device,
          horizon_ms: this.horizonMs,
          context_key: `${screen}|${ctx.time.daypart}`,
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
      state.lastScreen = screen;
      state.lastFeatures = features;
    }
    return { guesses, resolved };
  }
}

export const defaultPredictionHost = new PredictionHost({
  horizonMs: Number(process.env.PREDICTION_HORIZON_MS) > 0 ? Number(process.env.PREDICTION_HORIZON_MS) : DEFAULT_HORIZON_MS,
});
