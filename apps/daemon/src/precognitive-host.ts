/**
 * @file precognitive-host.ts
 * Host lifecycle and state manager for Frontier 1: PreCognitiveEngine.
 *
 * Provides real-time neuromotor/readiness telemetry processing, dynamic wake
 * threshold calibration from logged SQLite events, and pocket pre-staging integration.
 * Scoped per-device with TTL expiration on live readiness and atomic calibration.
 */

import {
  PreCognitiveEngine,
  computeWakeDeltaQuantile,
  extractWakeDeltasFromEvents,
  DEFAULT_WAKE_THRESHOLD_MS,
  type ReadinessState,
  type WakeEventRecord,
  type EventRecord,
  type SuggestionAcceptanceMetrics,
} from "@exocortex/core";
import type { ExocortexDatabase } from "@exocortex/core/db";

const RECENCY_WINDOW_MS = 60_000; // 60 seconds

export function isValidDwell(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 60_000;
}

export interface CalibrationResult {
  wakeThresholdMs: number;
  sampleCount: number;
  calibrated: boolean;
  minSamples: number;
  error?: string;
}

export interface DeviceCalibration {
  wakeThresholdMs: number;
  sampleCount: number;
  calibrated: boolean;
}

interface DeviceReadinessEntry {
  state: ReadinessState;
  updatedAt: number;
}

export interface PreCognitiveStatus {
  deviceId: string;
  wakeThresholdMs: number;
  urgencyIntent: string;
  wakeupLatencyMs: number;
  hesitationScore: number;
  isPreStaged: boolean;
  preStagedProposalId?: string;
  calibrated: boolean;
  sampleCount: number;
  source: "device" | "global" | "default";
  futureSkewDrops?: number;
  suggestionMetrics?: SuggestionAcceptanceMetrics;
}

export class PreCognitiveHost {
  private static instance: PreCognitiveHost | null = null;
  private static readonly MAX_ENGINES = 256;

  private readonly engines = new Map<string, PreCognitiveEngine>();
  private readonly deviceReadiness = new Map<string, DeviceReadinessEntry>();
  private devCal = new Map<string, DeviceCalibration>();
  private wakeThresholdMs: number = DEFAULT_WAKE_THRESHOLD_MS;
  private isCalibrated = false;
  private sampleCount = 0;
  private readonly futureSkewDropsByDevice = new Map<string, number>();
  private readonly processedDecisionEventIds = new Set<string>();

  public constructor(private readonly nowProvider: () => number = Date.now) {}

  public static getInstance(): PreCognitiveHost {
    if (!PreCognitiveHost.instance) {
      PreCognitiveHost.instance = new PreCognitiveHost();
    }
    return PreCognitiveHost.instance;
  }

  public static createIsolatedForTest(nowProvider?: () => number): PreCognitiveHost {
    return new PreCognitiveHost(nowProvider);
  }

  public resetForTest(): void {
    this.engines.clear();
    this.deviceReadiness.clear();
    this.devCal.clear();
    this.wakeThresholdMs = DEFAULT_WAKE_THRESHOLD_MS;
    this.isCalibrated = false;
    this.sampleCount = 0;
    this.futureSkewDropsByDevice.clear();
    this.processedDecisionEventIds.clear();
  }

  public getFutureSkewDropCount(deviceId?: string): number {
    if (deviceId) {
      return this.futureSkewDropsByDevice.get(deviceId) ?? 0;
    }
    let total = 0;
    for (const v of this.futureSkewDropsByDevice.values()) total += v;
    return total;
  }

  public getEngine(deviceId = "default"): PreCognitiveEngine {
    let eng = this.engines.get(deviceId);
    if (eng) {
      // LRU refresh: move accessed entry to the end of the Map iteration order
      this.engines.delete(deviceId);
      this.engines.set(deviceId, eng);
      return eng;
    }

    if (this.engines.size >= PreCognitiveHost.MAX_ENGINES) {
      const oldestKey = this.engines.keys().next().value;
      if (oldestKey !== undefined) {
        this.engines.delete(oldestKey);
        this.deviceReadiness.delete(oldestKey);
      }
    }

    const devEntry = this.devCal.get(deviceId);
    const threshold = devEntry?.calibrated ? devEntry.wakeThresholdMs : this.wakeThresholdMs;
    eng = new PreCognitiveEngine({ wakeThresholdMs: threshold });
    this.engines.set(deviceId, eng);
    return eng;
  }

  /**
   * Calibrate wake delta quantile (p20) from past wake/touch events in SQLite.
   * Bounds query with ts_server lookback and uses ROW_NUMBER() partitioned per device
   * to guarantee no node is starved by high-volume devices.
   */
  public calibrateFromDatabase(
    db: ExocortexDatabase,
    minSamples = 10,
    maxLookbackMs = 30 * 86_400_000,
  ): CalibrationResult {
    try {
      const minTsServer = this.nowProvider() - maxLookbackMs;
      const rows = db.raw
        .prepare(
          `WITH ranked AS (
             SELECT device_id, kind, ts_device, payload,
                    ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY ts_server DESC) as rn
               FROM events
              WHERE ts_server >= ?
                AND (CASE WHEN json_valid(payload)
                          THEN json_extract(payload, '$.synthetic') END IS NULL
                     OR json_extract(payload, '$.synthetic') != 1)
                AND (kind IN ('wake', 'touch', 'vibration')
                     OR (kind = 'telemetry'
                         AND CASE WHEN json_valid(payload)
                                  THEN json_extract(payload, '$.event') END
                             IN ('VIBRATION', 'SCREEN_ON', 'SCREEN_OFF', 'TOUCH', 'TAP')))
           )
           SELECT device_id, kind, ts_device, payload
             FROM ranked
            WHERE rn <= 500`,
        )
        .all(minTsServer) as Array<{ device_id: string; kind: string; ts_device: number; payload: string }>;

      // Group rows by device_id to ensure wake deltas are never interleaved across devices
      const byDevice = new Map<string, WakeEventRecord[]>();
      for (const r of rows) {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(r.payload);
        } catch {
          payload = null;
        }
        if (payload?.synthetic === true || payload?.synthetic === 1) {
          continue;
        }
        const list = byDevice.get(r.device_id) ?? [];
        list.push({
          kind: r.kind,
          ts_device: r.ts_device,
          payload,
        });
        byDevice.set(r.device_id, list);
      }

      const nextDevCal = new Map<string, DeviceCalibration>();
      const allDeltas: number[] = [];

      for (const [deviceId, devRecords] of byDevice.entries()) {
        devRecords.sort((a, b) => a.ts_device - b.ts_device);
        const devDeltas = extractWakeDeltasFromEvents(devRecords);
        allDeltas.push(...devDeltas);

        if (devDeltas.length >= minSamples) {
          const devThreshold = computeWakeDeltaQuantile(devDeltas, 0.20, DEFAULT_WAKE_THRESHOLD_MS, minSamples);
          nextDevCal.set(deviceId, {
            wakeThresholdMs: devThreshold,
            sampleCount: devDeltas.length,
            calibrated: true,
          });
        } else {
          nextDevCal.set(deviceId, {
            wakeThresholdMs: DEFAULT_WAKE_THRESHOLD_MS,
            sampleCount: devDeltas.length,
            calibrated: false,
          });
        }
      }

      const globalCalibrated = allDeltas.length >= minSamples;
      const globalThreshold = globalCalibrated
        ? computeWakeDeltaQuantile(allDeltas, 0.20, DEFAULT_WAKE_THRESHOLD_MS, minSamples)
        : DEFAULT_WAKE_THRESHOLD_MS;

      // Commit state atomically
      this.devCal = nextDevCal;
      this.wakeThresholdMs = globalThreshold;
      this.isCalibrated = globalCalibrated;
      this.sampleCount = allDeltas.length;

      // Update existing engines
      for (const [id, eng] of this.engines) {
        const devEntry = nextDevCal.get(id);
        eng.setWakeThreshold(devEntry?.calibrated ? devEntry.wakeThresholdMs : globalThreshold);
      }

      return {
        wakeThresholdMs: globalThreshold,
        sampleCount: allDeltas.length,
        calibrated: globalCalibrated,
        minSamples,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[precognitive-host] calibration error:", msg);
      return {
        wakeThresholdMs: this.wakeThresholdMs,
        sampleCount: 0,
        calibrated: false,
        minSamples,
        error: msg,
      };
    }
  }

  /**
   * Batch ingest hook called when new events are appended to the event store.
   * Correctly isolates engine state per device and gates live readiness on recency.
   */
  public onEventsAppended(events: EventRecord[], _db?: ExocortexDatabase): void {
    const now = this.nowProvider();
    // Fast path: filter by recency (server + device clocks) and relevant kind before grouping/parsing
    const byDevice = new Map<string, EventRecord[]>();
    for (const ev of events) {
      if (Math.abs(now - ev.ts_server) >= RECENCY_WINDOW_MS) continue;
      const deviceAgeMs = now - ev.ts_device;
      if (deviceAgeMs < -5000) {
        const cur = this.futureSkewDropsByDevice.get(ev.device_id) ?? 0;
        this.futureSkewDropsByDevice.set(ev.device_id, cur + 1);
        continue;
      }
      if (deviceAgeMs >= RECENCY_WINDOW_MS) continue;
      if (ev.kind !== "vibration" && ev.kind !== "wake" && ev.kind !== "touch" && ev.kind !== "telemetry") continue;
      const list = byDevice.get(ev.device_id) ?? [];
      list.push(ev);
      byDevice.set(ev.device_id, list);
    }

    for (const [deviceId, devEvents] of byDevice.entries()) {
      const engine = this.getEngine(deviceId);
      const sorted = [...devEvents].sort((a, b) => a.ts_device - b.ts_device);

      for (const ev of sorted) {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(ev.payload);
        } catch {
          payload = null;
        }

        if (ev.kind === "wake" || ev.kind === "vibration" || (ev.kind === "telemetry" && payload?.event === "VIBRATION")) {
          engine.recordVibration(ev.ts_device);
        }
        if (ev.kind === "telemetry" && payload?.event === "SCREEN_ON") {
          const state = engine.handleScreenStateChange("SCREEN_ON", ev.ts_device);
          this.deviceReadiness.set(deviceId, { state: { ...state }, updatedAt: now });
        }
        if (ev.kind === "telemetry" && payload?.event === "SCREEN_OFF") {
          const state = engine.handleScreenStateChange("SCREEN_OFF", ev.ts_device);
          this.deviceReadiness.set(deviceId, { state: { ...state }, updatedAt: now });
        }
        if (ev.kind === "touch" || (ev.kind === "telemetry" && (payload?.event === "TOUCH" || payload?.event === "TAP"))) {
          const rawDwell = payload?.dwell_ms ?? payload?.touch_duration_ms;
          if (isValidDwell(rawDwell)) {
            const hesitation = engine.recordTouchInteraction(rawDwell);
            const current = this.deviceReadiness.get(deviceId)?.state ?? {
              urgencyIntent: "CASUAL",
              wakeupLatencyMs: 0,
              hesitationScore: 0,
              isPreStaged: false,
            };
            this.deviceReadiness.set(deviceId, {
              state: { ...current, hesitationScore: hesitation },
              updatedAt: now,
            });
          }
        }
        if (ev.kind === "telemetry" && (payload?.event === "SUGGESTION_DECISION" || payload?.suggestion_decision)) {
          const decision = payload?.decision ?? payload?.suggestion_decision;
          if (decision === "ACCEPTED" || decision === "IGNORED") {
            if (ev.event_id && this.processedDecisionEventIds.has(ev.event_id)) continue;
            if (ev.event_id) {
              this.processedDecisionEventIds.add(ev.event_id);
              if (this.processedDecisionEventIds.size > 500) {
                const oldest = this.processedDecisionEventIds.values().next().value;
                if (oldest) this.processedDecisionEventIds.delete(oldest);
              }
            }
            const rawDwell = payload?.dwell_ms ?? payload?.touch_duration_ms;
            const dwell = isValidDwell(rawDwell) ? rawDwell : -1;
            const suggType = typeof payload?.suggestion_type === "string" ? payload.suggestion_type : undefined;
            const action = typeof payload?.action === "string" ? payload.action : undefined;
            engine.recordSuggestionDecision(decision, dwell, suggType, action, ev.ts_device);
          }
        }
      }
    }
  }

  public recordScreenState(deviceId: string, state: "SCREEN_ON" | "SCREEN_OFF", timestamp?: number): ReadinessState {
    const engine = this.getEngine(deviceId);
    const result = engine.handleScreenStateChange(state, timestamp);
    this.deviceReadiness.set(deviceId, { state: { ...result }, updatedAt: this.nowProvider() });
    return result;
  }

  public recordVibration(deviceId: string, timestamp?: number): void {
    const engine = this.getEngine(deviceId);
    engine.recordVibration(timestamp);
  }

  public recordTouch(deviceId: string, durationMs: number): number {
    const engine = this.getEngine(deviceId);
    const score = engine.recordTouchInteraction(durationMs);
    const current = this.deviceReadiness.get(deviceId)?.state ?? {
      urgencyIntent: "CASUAL",
      wakeupLatencyMs: 0,
      hesitationScore: 0,
      isPreStaged: false,
    };
    this.deviceReadiness.set(deviceId, {
      state: { ...current, hesitationScore: score },
      updatedAt: this.nowProvider(),
    });
    return score;
  }

  public getStatus(deviceId = "default"): PreCognitiveStatus {
    const engine = this.getEngine(deviceId);
    const devCalEntry = this.devCal.get(deviceId);
    const entry = this.deviceReadiness.get(deviceId);
    const now = this.nowProvider();

    // Expire live readiness if older than RECENCY_WINDOW_MS (decay all fields back to CASUAL)
    const isExpired = !entry || (now - entry.updatedAt > RECENCY_WINDOW_MS);
    const readiness: ReadinessState = (entry && !isExpired)
      ? entry.state
      : {
          urgencyIntent: "CASUAL",
          wakeupLatencyMs: 0,
          hesitationScore: 0,
          isPreStaged: false,
        };

    const devCalibrated = devCalEntry?.calibrated === true;
    const calibrated = devCalibrated || this.isCalibrated;
    const sampleCount = devCalibrated ? devCalEntry.sampleCount : this.sampleCount;
    const source: "device" | "global" | "default" = devCalibrated
      ? "device"
      : this.isCalibrated
        ? "global"
        : "default";

    return {
      deviceId,
      wakeThresholdMs: engine.wakeThreshold,
      urgencyIntent: readiness.urgencyIntent,
      wakeupLatencyMs: readiness.wakeupLatencyMs,
      hesitationScore: readiness.hesitationScore,
      isPreStaged: readiness.isPreStaged,
      preStagedProposalId: readiness.preStagedProposalId,
      calibrated,
      sampleCount,
      source,
      futureSkewDrops: this.futureSkewDropsByDevice.get(deviceId) ?? 0,
      suggestionMetrics: engine.getSuggestionMetrics(),
    };
  }
}

export const defaultPreCognitiveHost = PreCognitiveHost.getInstance();
