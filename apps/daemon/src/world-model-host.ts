/**
 * @file world-model-host.ts
 * Unified Host integration for the Living World Model in exocortexd.
 * 
 * Fuses:
 * 1. LivingLifeGraph (Entities, relations, decay, spreading activation)
 * 2. CognitiveModeGate (Bandwidth classification & attentional filtering)
 * 3. ActiveInferenceEngine (Homeostatic invariants & Expected Free Energy minimization)
 * 
 * Directly connected to the Exocortex Event Bus and Speculative Dry-Run Cache.
 */

import {
  seedFromPastSessions,
  seedFromComms,
  type CommsSeedResult,
  type PastSeedResult,
  LivingLifeGraph,
  CognitiveModeGate,
  ActiveInferenceEngine,
  LearnedActiveInferenceEngine,
  eventToObservation,
  systemObservationFromEvent,
  foregroundObservation,
  invariantObservation,
  rankInferencePolicies,
  type CognitiveMode,
  type ProposalEnvelope,
  type ContextualSignals,
  type SystemObservation,
  type BeliefSnapshotRecord,
  type ModelParamRecord,
  type InferencePolicy,
} from "@exocortex/world-model";
import { defaultDryRunCache, type SpeculativeProposal, type EventRecord } from "@exocortex/core";
import { mayActuateAutoExecute, type ShadowRecorder } from "./shadow-recorder.js";
import { getDatabase, hasDatabase } from "./db-host.js";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { loadProposalPreferences, type PreferenceMetrics } from "./proposal-preferences.js";

const MAX_RECORDER_FAILURES = 5;

const SCREEN_STATES = ["ON", "OFF", "UNLOCKED"];

/** Validate untrusted telemetry signals before any state is mutated. Throws TypeError on bad input. */
function validateSignals(signals: unknown): asserts signals is ContextualSignals {
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) {
    throw new TypeError("invalid telemetry: signals must be an object");
  }
  const s = signals as Record<string, unknown>;
  for (const key of ["foregroundApp", "windowTitle"]) {
    if (s[key] !== undefined && typeof s[key] !== "string") {
      throw new TypeError(`invalid telemetry: ${key} must be a string`);
    }
  }
  for (const key of ["timestamp", "idleDurationMs", "recentInteractionVelocity", "userDwellMs", "hesitationScore"]) {
    if (s[key] !== undefined && (typeof s[key] !== "number" || !Number.isFinite(s[key] as number))) {
      throw new TypeError(`invalid telemetry: ${key} must be a finite number`);
    }
  }
  if (s.hourOfDay !== undefined) {
    const h = s.hourOfDay;
    if (typeof h !== "number" || !Number.isFinite(h) || h < 0 || h > 23) {
      throw new TypeError("invalid telemetry: hourOfDay must be a number between 0 and 23");
    }
  }
  if (s.isWeekend !== undefined && typeof s.isWeekend !== "boolean") {
    throw new TypeError("invalid telemetry: isWeekend must be a boolean");
  }
  if (s.screenState !== undefined && !SCREEN_STATES.includes(s.screenState as string)) {
    throw new TypeError("invalid telemetry: screenState must be ON, OFF or UNLOCKED");
  }
  if (s.manualOverrideMode !== undefined && s.manualOverrideMode !== null && typeof s.manualOverrideMode !== "string") {
    throw new TypeError("invalid telemetry: manualOverrideMode must be a string or null");
  }
}

export class WorldModelHost {
  private static instance: WorldModelHost | null = null;

  public readonly lifeGraph: LivingLifeGraph;
  public readonly cognitiveGate: CognitiveModeGate;
  public readonly activeInference: ActiveInferenceEngine;
  public learnedEngine: LearnedActiveInferenceEngine;
  private shadowRecorder: ShadowRecorder | null = null;
  private recorderFailures = 0;
  private recorderDisabled = false;
  private autoExecutor: ((policy: InferencePolicy, proposal: ProposalEnvelope) => void) | null = null;
  private preferenceDb: ExocortexDatabase | null = null;

  private constructor() {
    this.lifeGraph = new LivingLifeGraph();
    this.seedEcosystemGraph();

    this.cognitiveGate = new CognitiveModeGate();
    this.activeInference = new ActiveInferenceEngine(this.lifeGraph);
    this.learnedEngine = new LearnedActiveInferenceEngine();

    if (hasDatabase()) {
      try {
        const db = getDatabase();
        this.preferenceDb = db;
        const params = db.listModelParams();
        if (params.length > 0) {
          this.learnedEngine.importModelParams(params);
        }
        const latestSnapshot = db.getLatestBeliefSnapshot();
        if (latestSnapshot) {
          this.learnedEngine.hydrateFromSnapshot(latestSnapshot);
        }
      } catch {
        // Database not ready or in-memory
      }
    }
  }

  public static getInstance(): WorldModelHost {
    if (!WorldModelHost.instance) {
      WorldModelHost.instance = new WorldModelHost();
    }
    return WorldModelHost.instance;
  }

  public static createIsolatedForTest(): WorldModelHost {
    return new WorldModelHost();
  }

  /** Attach (or detach with null) the actuator invoked for SILENT_AUTO_EXECUTE decisions that pass `mayActuateAutoExecute`. */
  public setAutoExecutor(fn: ((policy: InferencePolicy, proposal: ProposalEnvelope) => void) | null): void {
    this.autoExecutor = fn;
  }

  /** Attach (or detach with null) the recorder that persists proposals + gate decisions. */
  public setShadowRecorder(recorder: ShadowRecorder | null): void {
    this.shadowRecorder = recorder;
    if (recorder) this.preferenceDb = recorder.database;
    this.recorderFailures = 0;
    this.recorderDisabled = false;
  }

  /** Stop recording for this process (e.g. the database could not be opened). */
  public disableShadowRecording(): void {
    this.shadowRecorder = null;
    this.recorderDisabled = true;
  }

  /** True once a recorder is attached or recording was deliberately given up on. */
  public get shadowRecordingSettled(): boolean {
    return this.shadowRecorder !== null || this.recorderDisabled;
  }

  /**
   * Seed Michael's core sovereign ecosystem entities, projects, routines, and hardware nodes.
   */
  private seedEcosystemGraph(): void {
    // 1. Core Human & Hardware Nodes
    this.lifeGraph.addEntity({ id: "person_michael", name: "Michael", type: "PERSON" });
    this.lifeGraph.addEntity({ id: "device_host_pc", name: "Windows 11 Workstation", type: "DEVICE" });
    this.lifeGraph.addEntity({ id: "device_phone_galaxy_s26", name: "Samsung Galaxy S26 Ultra", type: "DEVICE" });

    // 2. Active Projects & Invariants
    this.lifeGraph.addEntity({ id: "project_sovereign_exocortex", name: "Sovereign Exocortex Monorepo", type: "PROJECT" });
    this.lifeGraph.addEntity({ id: "project_bear_house_classic", name: "Bear House Classic", type: "PROJECT" });
    this.lifeGraph.addEntity({ id: "project_cafeteria_menu", name: "2nd Helpings Cafeteria Manager", type: "PROJECT" });
    this.lifeGraph.addEntity({ id: "project_autonomous_triad", name: "Autonomous Triad Advisory", type: "PROJECT" });

    // 3. Systemic Goals & States
    this.lifeGraph.addEntity({ id: "goal_zero_cafeteria_disruption", name: "Zero Cafeteria Meal Disruption", type: "GOAL" });
    this.lifeGraph.addEntity({ id: "goal_100_percent_tests_pass", name: "100% Monorepo Test Pass Rate", type: "GOAL" });
    this.lifeGraph.addEntity({ id: "state_deep_focus", name: "Deep Focus Flow State", type: "CONTEXT_STATE" });

    // 4. Multi-Relational Associative Edges
    this.lifeGraph.addEdge("person_michael", "project_sovereign_exocortex", "WORKS_ON", 1.0);
    this.lifeGraph.addEdge("person_michael", "project_bear_house_classic", "WORKS_ON", 0.95);
    this.lifeGraph.addEdge("person_michael", "project_cafeteria_menu", "WORKS_ON", 0.9);
    this.lifeGraph.addEdge("person_michael", "goal_zero_cafeteria_disruption", "CARES_ABOUT", 1.0);
    this.lifeGraph.addEdge("person_michael", "goal_100_percent_tests_pass", "CARES_ABOUT", 1.0);

    this.lifeGraph.addEdge("device_phone_galaxy_s26", "device_host_pc", "INTERACTS_WITH", 1.0);
    this.lifeGraph.addEdge("project_sovereign_exocortex", "goal_100_percent_tests_pass", "DEPENDS_ON", 1.0);
    this.lifeGraph.addEdge("project_sovereign_exocortex", "project_autonomous_triad", "DEPENDS_ON", 0.95);
  }

  private pastSeeded = false;

  /**
   * Seed the life graph from past events (Pieces backfill, kind "past"). Runs at most once per process and never
   * throws; past events are history, so this changes only entity activation and edge weights, not the event log.
   */
  public seedFromPastEvents(db: ExocortexDatabase): PastSeedResult | null {
    if (this.pastSeeded) return null;
    this.pastSeeded = true;
    try {
      const sessions = db.listEvents({ kind: "past" }).flatMap((e) => {
        try {
          const p = JSON.parse(String(e.payload)) as { origin?: unknown; tags?: unknown; persons?: unknown };
          if (p.origin !== "pieces-backfill") return [];
          const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
          return [{ ts: e.ts_device, tags: strs(p.tags), persons: strs(p.persons) }];
        } catch {
          return [];
        }
      });
      return sessions.length > 0 ? seedFromPastSessions(this.lifeGraph, sessions) : null;
    } catch (err) {
      console.error("[life-graph] past seeding skipped:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  private commsSeeded = false;

  /**
   * Seed real people into the life graph from past call/text events (kind "past", origin "comms-backfill").
   * Runs at most once per process and never throws; only entity activation and edge weights change.
   */
  public seedCommsFromPastEvents(db: ExocortexDatabase): CommsSeedResult | null {
    if (this.commsSeeded) return null;
    this.commsSeeded = true;
    try {
      const events = db.listEvents({ kind: "past" }).flatMap((e) => {
        try {
          const p = JSON.parse(String(e.payload)) as { origin?: unknown; people?: unknown; labels?: unknown };
          if (p.origin !== "comms-backfill" || !Array.isArray(p.people) || typeof p.people[0] !== "string") return [];
          const labels = Array.isArray(p.labels) ? p.labels.filter((x): x is string => typeof x === "string") : [];
          return [{ ts: e.ts_device, person: p.people[0] as string, labels }];
        } catch {
          return [];
        }
      });
      return events.length > 0 ? seedFromComms(this.lifeGraph, events) : null;
    } catch (err) {
      console.error("[life-graph] comms seeding skipped:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Ingest real-time telemetry from phone sensorium or local desktop activity.
   */
  public ingestTelemetry(signals: ContextualSignals): {
    mode: CognitiveMode;
    stagedProposals: ProposalEnvelope[];
    drainedQueue: ProposalEnvelope[];
  } {
    validateSignals(signals);
    const prevMode = this.cognitiveGate.mode;
    const mode = this.cognitiveGate.classifyMode(signals);

    const extracted = foregroundObservation(signals as unknown as Record<string, unknown>);
    const timestamp = signals.timestamp ?? Date.now();
    this.lifeGraph.decay(timestamp);
    if (extracted) {
      if (extracted.obs === "typing_burst") {
        this.lifeGraph.stimulate("project_sovereign_exocortex", 0.3, timestamp);
      }
      try {
        this.learnedEngine.processObservation(extracted.factor, extracted.obs, extracted.action);
      } catch {
        // Retain telemetry classification if a learned table is unavailable.
      }
    }

    let drainedQueue: ProposalEnvelope[] = [];
    if (prevMode === "DEEP_FOCUS" && mode !== "DEEP_FOCUS") {
      drainedQueue = this.cognitiveGate.drainQueue();
    }

    return {
      mode,
      stagedProposals: this.cognitiveGate.getPendingQueue(),
      drainedQueue,
    };
  }

  /**
   * Ingest a system observation into the Active Inference loop.
   * If an anomaly is observed, synthesizes policies, pre-compiles them into
   * the DryRunCache, and routes them through the CognitiveModeGate.
   */
  public ingestObservation(
    obs: SystemObservation,
    options: { allowAutoExecute?: boolean; db?: ExocortexDatabase } = {},
  ): {
    surprisalNats: number;
    isAnomaly: boolean;
    generatedPoliciesCount: number;
    proposals: ProposalEnvelope[];
  } {
    if (!obs || typeof obs !== "object") {
      throw new TypeError("invalid observation: malformed or missing payload");
    }
    if (typeof obs.invariantId !== "string" || obs.invariantId.trim().length === 0) {
      throw new TypeError("invalid observation: missing or invalid invariantId");
    }
    const truncatedId = obs.invariantId.slice(0, 64);
    const known = this.activeInference.registeredInvariants.some((i) => i.id === obs.invariantId);
    if (!known) {
      throw new Error(`unknown invariantId: ${truncatedId}`);
    }
    const s = obs.observedState;
    const isScalar =
      typeof s === "string" ||
      typeof s === "boolean" ||
      (typeof s === "number" && Number.isFinite(s));
    if (!isScalar) {
      throw new TypeError("invalid observation: non-primitive or non-finite observedState");
    }
    if (obs.confidence !== undefined) {
      if (typeof obs.confidence !== "number" || !Number.isFinite(obs.confidence) || obs.confidence < 0 || obs.confidence > 1) {
        throw new TypeError("invalid observation: confidence must be a finite number between 0 and 1");
      }
    }
    if (obs.observedAt !== undefined) {
      if (typeof obs.observedAt !== "number" || !Number.isFinite(obs.observedAt)) {
        throw new TypeError("invalid observation: observedAt must be a finite timestamp");
      }
    }
    const extracted = invariantObservation(obs, (name) => this.learnedEngine.getFactor(name));
    const forceShadow = obs.metadata?.source === "local_vision";
    if (options.db) this.preferenceDb = options.db;
    const timestamp = obs.observedAt ?? Date.now();
    this.lifeGraph.decay(timestamp);
    if (extracted) {
      try {
        this.learnedEngine.processObservation(extracted.factor, extracted.obs, extracted.action);
      } catch {
        // A damaged learned model cannot disable deterministic anomaly handling.
      }
    }
    const metric = this.activeInference.evaluateObservation(obs);

    const predictedAt = Date.now();
    let preferences = new Map();
    try {
      preferences = loadProposalPreferences(this.preferenceDb, predictedAt).preferences;
    } catch {
      // Database failures leave the deterministic scorer available.
    }
    const policies = rankInferencePolicies(
      this.activeInference.generatePolicies([metric]), this.learnedEngine, this.lifeGraph,
      preferences, timestamp, predictedAt,
    );
    const proposals: ProposalEnvelope[] = [];

    for (const policy of policies) {
      const proposal = this.activeInference.policyToProposal(policy);
      const gateDecision = this.cognitiveGate.evaluateProposal(proposal);

      // Pre-compile into the high-speed speculative dry-run cache
      if (gateDecision.action === "SILENT_AUTO_EXECUTE" || gateDecision.action === "ALLOW_PROMPT") {
        defaultDryRunCache.set(
          policy.id,
          policy.actionPayload,
          policy.title,
          300000 // 5 minute TTL
        );
      }

      // Executor re-check: actuate only if allowlisted, SHADOW=0 and the breaker is clear; else record only.
      if (this.autoExecutor && options.allowAutoExecute !== false && !forceShadow) {
        let db: ExocortexDatabase | null = null;
        try {
          db = hasDatabase() ? getDatabase() : null;
        } catch {
          db = null;
        }
        if (mayActuateAutoExecute(gateDecision, proposal, db)) {
          try {
            this.autoExecutor(policy, proposal);
          } catch (err) {
            console.error(`[auto-execute] failed for ${policy.id}:`, err instanceof Error ? err.message : err);
          }
        }
      }

      // Persistence must never break observation ingest.
      try {
        this.shadowRecorder?.record(policy, proposal, gateDecision, { forceShadow });
        this.recorderFailures = 0;
      } catch (err) {
        console.error(`[shadow-recorder] failed to record ${policy.id}:`, err instanceof Error ? err.message : err);
        if (++this.recorderFailures >= MAX_RECORDER_FAILURES) {
          console.error(`[shadow-recorder] disabled after ${MAX_RECORDER_FAILURES} consecutive failures`);
          this.disableShadowRecording();
        }
      }

      proposals.push(proposal);
    }

    return {
      surprisalNats: metric.surprisalNats,
      isAnomaly: metric.isAnomaly,
      generatedPoliciesCount: policies.length,
      proposals,
    };
  }

  /**
   * Diagnostic summary of the living world model state.
   */
  public getStatus(): {
    entityCount: number;
    edgeCount: number;
    cognitiveMode: CognitiveMode;
    queuedProposalsCount: number;
    registeredInvariantsCount: number;
    learnedFactorsCount: number;
    learnedModelVersion: number;
    preferenceMetrics: PreferenceMetrics;
  } {
    const factors = this.learnedEngine.listFactors();
    const maxVersion = factors.reduce((max, f) => Math.max(max, f.version), 1);
    return {
      entityCount: this.lifeGraph.entityCount,
      edgeCount: this.lifeGraph.edgeCount,
      cognitiveMode: this.cognitiveGate.mode,
      queuedProposalsCount: this.cognitiveGate.queueSize,
      registeredInvariantsCount: this.activeInference.registeredInvariants.length,
      learnedFactorsCount: factors.length,
      learnedModelVersion: maxVersion,
      preferenceMetrics: this.getPreferenceMetrics(),
    };
  }

  private getPreferenceMetrics(): PreferenceMetrics {
    try {
      return loadProposalPreferences(this.preferenceDb, Date.now()).metrics;
    } catch {
      return loadProposalPreferences(null, Date.now()).metrics;
    }
  }

  /**
   * Persist current belief snapshot and Dirichlet model params to SQLite.
   */
  public persistBeliefState(asOfSeq: number, db?: ExocortexDatabase): BeliefSnapshotRecord | null {
    const targetDb = db ?? (hasDatabase() ? getDatabase() : null);
    if (targetDb) this.preferenceDb = targetDb;
    if (!targetDb) return null;

    const snapshot = this.learnedEngine.createBeliefSnapshot(asOfSeq);
    targetDb.saveBeliefSnapshot(snapshot);

    const params = this.learnedEngine.exportModelParams(asOfSeq);
    for (const p of params) {
      targetDb.saveModelParams(p);
    }
    return snapshot;
  }

  /**
   * Batch ingest newly appended events, updating generative models and persisting
   * belief snapshots and parameters in a single transaction.
   */
  public onEventsAppended(events: EventRecord[], db?: ExocortexDatabase): BeliefSnapshotRecord | null {
    const targetDb = db ?? (hasDatabase() ? getDatabase() : null);
    if (targetDb) this.preferenceDb = targetDb;
    const touchedFactors = new Set<string>();
    const batchSnapshots: BeliefSnapshotRecord[] = [];
    let lastObsSeq: number | null = null;

    for (const ev of events) {
      try {
        const extracted = eventToObservation(ev, (name) => this.learnedEngine.getFactor(name));
        const systemObservation = systemObservationFromEvent(ev, extracted, (name) => this.learnedEngine.getFactor(name));
        if (systemObservation) {
          // Unmapped/scalar invariants retain baseline proposals without updating a learned factor.
          this.ingestObservation(systemObservation, {
            ...(targetDb ? { db: targetDb } : {}),
            allowAutoExecute: systemObservation.metadata?.source !== "local_vision",
          });
        } else if (extracted && this.learnedEngine.getFactor(extracted.factor)) {
          this.learnedEngine.processObservation(extracted.factor, extracted.obs, extracted.action);
        }
        if (extracted && this.learnedEngine.getFactor(extracted.factor)) {
          touchedFactors.add(extracted.factor);
          lastObsSeq = ev.seq;
          batchSnapshots.push(this.learnedEngine.createBeliefSnapshot(ev.seq));
        }
      } catch (err) {
        console.warn(`[world-model-host] observation extraction error for seq ${ev.seq}:`, err);
      }
    }

    if (lastObsSeq !== null && targetDb && batchSnapshots.length > 0) {
      try {
        const params = this.learnedEngine.exportModelParams(lastObsSeq);
        targetDb.withTransaction(() => {
          for (const snap of batchSnapshots) {
            targetDb.saveBeliefSnapshot(snap);
          }
          for (const p of params) {
            if (touchedFactors.has(p.factor)) {
              targetDb.saveModelParams(p);
            }
          }
        });
        return batchSnapshots[batchSnapshots.length - 1];
      } catch (err) {
        console.error(`[world-model-host] transaction save error:`, err);
      }
    }

    return null;
  }

  /**
   * Single-event convenience wrapper.
   */
  public onEventAppended(event: EventRecord, db?: ExocortexDatabase): BeliefSnapshotRecord | null {
    return this.onEventsAppended([event], db);
  }

  /**
   * Replays immutable event stream and rebuilds generative models & belief snapshots in SQLite.
   * Rebuilds into a fresh engine and atomically swaps it in only after transaction commit.
   */
  public replayEvents(events?: EventRecord[], db?: ExocortexDatabase): {
    replayedCount: number;
    snapshots: BeliefSnapshotRecord[];
    latestParams: ModelParamRecord[];
  } {
    const targetDb = db ?? (hasDatabase() ? getDatabase() : null);
    const eventList = events ?? (targetDb ? targetDb.listEvents() : []);

    const freshEngine = new LearnedActiveInferenceEngine();
    const result = freshEngine.replayEventStream(eventList);

    if (targetDb) {
      targetDb.withTransaction(() => {
        for (const snap of result.snapshots) {
          targetDb.saveBeliefSnapshot(snap);
        }
        for (const param of result.latestParams) {
          targetDb.saveModelParams(param);
        }
      });
    }

    this.learnedEngine = freshEngine;
    if (targetDb) this.preferenceDb = targetDb;
    return result;
  }
}

export const defaultWorldModelHost = WorldModelHost.getInstance();
