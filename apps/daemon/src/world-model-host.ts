import { ChannelVault } from "./channels/channel-vault.js";
import type { EntityType, RelationType } from "@exocortex/world-model";
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
  seedCanonicalProjects,
  normalizeProjectCategories,
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
  linkEventToGraph,
  type EventGraphContext,
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
import { defaultAutoExecutor } from "./scripted-executors.js";

const MAX_RECORDER_FAILURES = 5;

const SCREEN_STATES = ["ON", "OFF", "UNLOCKED"];

/** Validate untrusted telemetry signals before any state is mutated. Throws TypeError on bad input. */
function validateSignals(signals: unknown): asserts signals is ContextualSignals {
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) {
    throw new TypeError("invalid telemetry: signals must be an object");
  }
  const s = signals as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (s[key] === null && key !== "manualOverrideMode") {
      delete s[key];
    }
  }
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
  for (const key of ["inCall", "networkMetered", "carAudioConnected", "dndActive"]) {
    if (s[key] !== undefined && typeof s[key] !== "boolean") {
      throw new TypeError(`invalid telemetry: ${key} must be a boolean`);
    }
  }
  for (const key of ["audioOutput", "motionState", "thermalStatus", "physicalState", "interruptionFilter"]) {
    if (s[key] !== undefined && typeof s[key] !== "string") {
      throw new TypeError(`invalid telemetry: ${key} must be a string`);
    }
  }
  if (s.thermalHeadroom !== undefined && (typeof s.thermalHeadroom !== "number" || !Number.isFinite(s.thermalHeadroom))) {
    throw new TypeError("invalid telemetry: thermalHeadroom must be a finite number");
  }
  if (s.appTransitions !== undefined) {
    if (!Array.isArray(s.appTransitions)) {
      throw new TypeError("invalid telemetry: appTransitions must be an array");
    }
    if (s.appTransitions.length > 50) {
      s.appTransitions = s.appTransitions.slice(0, 50);
    }
  }
  if (s.clipboardIntent !== undefined && (typeof s.clipboardIntent !== "object" || s.clipboardIntent === null || Array.isArray(s.clipboardIntent))) {
    throw new TypeError("invalid telemetry: clipboardIntent must be an object");
  }
}

const HYDRATE_PAGE_SIZE = 1000;
const WORLD_MODEL_CONSUMER = "world-model";

export class WorldModelHost {
  private readonly processedEventSeqByDb = new WeakMap<ExocortexDatabase, number>();
  // First seq applied live in this process; hydration must stop before it or those events would be applied twice.
  private readonly firstLiveSeqByDb = new WeakMap<ExocortexDatabase, number>();
  private static instance: WorldModelHost | null = null;

  public readonly lifeGraph: LivingLifeGraph;
  public readonly cognitiveGate: CognitiveModeGate;
  public readonly activeInference: ActiveInferenceEngine;
  public learnedEngine: LearnedActiveInferenceEngine;
  private shadowRecorder: ShadowRecorder | null = null;
  private recorderFailures = 0;
  private recorderDisabled = false;
  private hydrated = false;
  private autoExecutor: ((policy: InferencePolicy, proposal: ProposalEnvelope) => void) | null = null;
  private preferenceDb: ExocortexDatabase | null = null;
  private lastGraphContextByDevice = new Map<string, EventGraphContext>();
  private graphListeners = new Set<(ctx: EventGraphContext, event: EventRecord) => void>();

  /** Subscribe to live graph mutations when events are linked to the Living Life Graph. */
  public onGraphUpdated(listener: (ctx: EventGraphContext, event: EventRecord) => void): () => void {
    this.graphListeners.add(listener);
    return () => {
      this.graphListeners.delete(listener);
    };
  }

  private constructor() {
    this.lifeGraph = new LivingLifeGraph();
    this.seedEcosystemGraph();

    this.cognitiveGate = new CognitiveModeGate();
    this.activeInference = new ActiveInferenceEngine(this.lifeGraph);
    this.learnedEngine = new LearnedActiveInferenceEngine();
    this.autoExecutor = (policy, proposal) => {
      defaultAutoExecutor(policy, proposal, {
        lifeGraph: this.lifeGraph,
        db: this.preferenceDb ?? (hasDatabase() ? getDatabase() : null),
      });
    };

    if (hasDatabase()) {
      try {
        this.hydrateFromDatabase(getDatabase());
      } catch {
        // Database not ready or in-memory
      }
    }
  }

  /** Restore learned params, belief snapshot and graph projection. Runs once; retried when a recorder attaches after a cold start. */
  public rehydrate(db: ExocortexDatabase): void {
    this.hydrated = false;
    this.hydrateFromDatabase(db);
  }

  private hydrateFromDatabase(db: ExocortexDatabase): void {
    if (this.hydrated) return;
    this.preferenceDb = db;
    const params = db.listModelParams();
    if (params.length > 0) {
      this.learnedEngine.importModelParams(params);
    }
    const latestSnapshot = db.getLatestBeliefSnapshot();
    if (latestSnapshot) {
      this.learnedEngine.hydrateFromSnapshot(latestSnapshot);
    }

    // Rebuild the graph from every event the world-model consumer has already delivered. Later events arrive
    // through onEventsAppended, so each event reaches the graph exactly once and with the same linker options.
    const firstLive = this.firstLiveSeqByDb.get(db);
    const cursor = db.getConsumerCursor(WORLD_MODEL_CONSUMER);
    const toSeq = firstLive !== undefined ? Math.min(cursor, firstLive - 1) : cursor;
    let lastSeq = 0;
    while (lastSeq < toSeq) {
      const page = db.listEvents({ sinceSeq: lastSeq, to_seq: toSeq, limit: HYDRATE_PAGE_SIZE });
      if (page.length === 0) break;
      for (const ev of page) {
        try {
          this.projectEventToGraph(ev, db);
        } catch {
          // Ignore unparsable legacy payloads during replay
        }
      }
      const pageEnd = page[page.length - 1].seq;
      if (pageEnd <= lastSeq) break;
      lastSeq = pageEnd;
    }
    if (toSeq > (this.processedEventSeqByDb.get(db) ?? 0)) {
      this.processedEventSeqByDb.set(db, toSeq);
    }
    this.hydrated = true;
  }

  /** Project one event into the life graph. Live ingest and restart hydration both go through here. */
  private projectEventToGraph(ev: EventRecord, db: ExocortexDatabase | null): EventGraphContext | null {
    if (typeof ev.kind === "string" && ev.kind.startsWith("channel.")) {
      this.projectChannelEvent(ev, db);
      return null;
    }
    const autoCreate = this.lifeGraph.entityCount < 20000;
    const linkCtx = linkEventToGraph(
      {
        event_id: ev.event_id,
        kind: ev.kind,
        ts_device: ev.ts_device,
        ts_server: ev.ts_server,
        payload: ev.payload,
      },
      this.lifeGraph,
      { autoCreate, createMissingTopics: autoCreate },
    );
    this.lastGraphContextByDevice.delete(ev.device_id);
    this.lastGraphContextByDevice.set(ev.device_id, linkCtx);
    if (this.lastGraphContextByDevice.size > 100) {
      const firstKey = this.lastGraphContextByDevice.keys().next().value;
      if (firstKey !== undefined) this.lastGraphContextByDevice.delete(firstKey);
    }
    return linkCtx;
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
    if (recorder) {
      this.preferenceDb = recorder.database;
      try {
        this.hydrateFromDatabase(recorder.database);
      } catch {
        // Stay un-hydrated; the learned engine starts cold rather than failing recorder attach
      }
    }
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
   * Seed the operator's core sovereign ecosystem entities, projects, routines, and hardware nodes.
   */
  private seedEcosystemGraph(): void {
    const selfId = process.env.EXOCORTEX_OPERATOR_ID || "person_operator";
    const selfName = process.env.EXOCORTEX_OPERATOR_NAME || "Operator";
    // 1. Core Human & Hardware Nodes
    this.lifeGraph.addEntity({ id: selfId, name: selfName, type: "PERSON" });
    this.lifeGraph.addEntity({ id: "device_host_pc", name: "Primary Workstation", type: "DEVICE" });
    this.lifeGraph.addEntity({ id: "device_phone_galaxy_s26", name: "Mobile Companion", type: "DEVICE" });

    // 2. Active Projects & Invariants
    seedCanonicalProjects(this.lifeGraph);

    // 3. Systemic Goals & States
    this.lifeGraph.addEntity({ id: "goal_zero_cafeteria_disruption", name: "Zero Cafeteria Meal Disruption", type: "GOAL" });
    this.lifeGraph.addEntity({ id: "goal_100_percent_tests_pass", name: "100% Monorepo Test Pass Rate", type: "GOAL" });
    this.lifeGraph.addEntity({ id: "state_deep_focus", name: "Deep Focus Flow State", type: "CONTEXT_STATE" });

    // 4. Operator-to-project links are the graph's top-level organization.
    this.lifeGraph.addEdge(selfId, "project_sovereign_exocortex", "WORKS_ON", 1.0);
    this.lifeGraph.addEdge(selfId, "project_bear_house_classic", "WORKS_ON", 0.95);
    this.lifeGraph.addEdge(selfId, "project_oakridge_smokehouse", "WORKS_ON", 0.9);
    this.lifeGraph.addEdge(selfId, "goal_zero_cafeteria_disruption", "CARES_ABOUT", 1.0);
    this.lifeGraph.addEdge(selfId, "goal_100_percent_tests_pass", "CARES_ABOUT", 1.0);

    // Operator physical substrate & cognitive state links
    this.lifeGraph.addEdge(selfId, "device_host_pc", "INTERACTS_WITH", 1.0);
    this.lifeGraph.addEdge(selfId, "device_phone_galaxy_s26", "INTERACTS_WITH", 1.0);
    this.lifeGraph.addEdge(selfId, "state_deep_focus", "CARES_ABOUT", 1.0);

    // Inter-hardware & systemic dependency edges
    this.lifeGraph.addEdge("device_phone_galaxy_s26", "device_host_pc", "INTERACTS_WITH", 1.0);
    this.lifeGraph.addEdge("project_sovereign_exocortex", "goal_100_percent_tests_pass", "DEPENDS_ON", 1.0);
    this.lifeGraph.addEdge("project_sovereign_exocortex", "project_autonomous_triad", "DEPENDS_ON", 0.95);
    for (const project of this.lifeGraph.snapshot().entities.filter((entity) => entity.type === "PROJECT")) {
      this.lifeGraph.addEdge(selfId, project.id, "WORKS_ON", 0.85);
    }
  }

  private pastSeeded = false;

  /**
   * Seed the life graph from past events (Pieces backfill, kind "past"), then apply the boot-time category
   * normalization. Runs at most once per process and never throws; past events are history, so this changes only
   * entity activation and edge weights, not the event log.
   */
  public seedFromPastEvents(db: ExocortexDatabase): PastSeedResult | null {
    if (this.pastSeeded) return null;
    this.pastSeeded = true;
    try {
      return this.seedPastSessions(db);
    } finally {
      this.normalizeCategories();
    }
  }

  /** Boot-time category normalization: drop tag hubs and file each document under one owner. Never throws. */
  public normalizeCategories(): void {
    try {
      normalizeProjectCategories(this.lifeGraph, process.env.EXOCORTEX_OPERATOR_ID || "person_operator");
    } catch (err) {
      console.error("[life-graph] category normalization skipped:", err instanceof Error ? err.message : err);
    }
  }

  private seedPastSessions(db: ExocortexDatabase): PastSeedResult | null {
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
      if (!sessions.length) return null;
      return seedFromPastSessions(this.lifeGraph, sessions);
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

  private vault?: ChannelVault | null;

  public setVault(vault: ChannelVault | null): void {
    this.vault = vault;
  }

  public getVault(db?: ExocortexDatabase | null): ChannelVault | null {
    if (this.vault) return this.vault;
    const targetDb = db ?? this.preferenceDb ?? (hasDatabase() ? getDatabase() : null);
    if (targetDb) {
      this.vault = new ChannelVault(targetDb);
      return this.vault;
    }
    return null;
  }

  private resolveEntityId(key: string): string | null {
    if (this.lifeGraph.getEntity(key)) return key;
    if (this.lifeGraph.getEntity(`doc:${key}`)) return `doc:${key}`;
    if (this.lifeGraph.getEntity(`person:${key}`)) return `person:${key}`;
    if (this.lifeGraph.getEntity(`project:${key}`)) return `project:${key}`;
    return null;
  }

  public purgeChannelEntities(channel: string): number {
    let removed = 0;
    const graph = this.lifeGraph;
    for (const entity of graph.snapshot().entities) {
      const props = entity.properties as Record<string, unknown> | undefined;
      if (!props) continue;
      const isTagged =
        props.sourceChannel === channel ||
        props.channelId === channel ||
        (Array.isArray(props.tags) && (props.tags.includes(`source:${channel}`) || props.tags.includes(channel)));
      if (isTagged) {
        if (graph.removeEntity(entity.id)) {
          removed++;
        }
      }
    }
    return removed;
  }

  public projectChannelEvent(ev: EventRecord, db?: ExocortexDatabase | null): void {
    let payload: Record<string, unknown>;
    try {
      payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : (ev.payload as Record<string, unknown>);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;

    const kind = ev.kind;
    const channel = String(payload.channel ?? "");
    const observedAt = typeof payload.observed_at === "number" ? payload.observed_at : (ev.ts_device || Date.now());

    if (kind === "channel.entity.upserted") {
      const entityType = String(payload.entity_type ?? "").toLowerCase();
      const entityKey = String(payload.entity_key ?? "");
      const ref = String(payload.ref ?? "");
      if (!entityKey || !ref) return;

      const vault = this.getVault(db);
      const content = vault?.get(ref);
      if (!content) return;

      const entityId = `${entityType}:${entityKey}`;
      const label = content.display_name ?? entityId;
      const existing = this.lifeGraph.getEntity(entityId);
      const activation = existing ? existing.activation : 1.0;
      const lastActive = existing ? existing.lastActive : observedAt;

      const normalizedType = (entityType === "project" ? "PROJECT" : "PERSON") as EntityType;

      this.lifeGraph.addEntity({
        id: entityId,
        type: normalizedType,
        name: label,
        properties: {
          ...(existing?.properties ?? {}),
          channelId: channel,
          sourceChannel: channel,
          tags: [`source:${channel}`, channel],
        },
        activation,
        lastActive,
      });
    } else if (kind === "channel.document.upserted") {
      const docKey = String(payload.doc_key ?? "");
      const ref = String(payload.ref ?? "");
      if (!docKey) return;

      const docId = `doc:${docKey}`;
      const vault = this.getVault(db);
      const content = ref ? vault?.get(ref) : null;
      const title = content?.title ?? "(document)";

      const existing = this.lifeGraph.getEntity(docId);
      const activation = existing ? existing.activation : 1.0;
      const lastActive = existing ? existing.lastActive : observedAt;

      this.lifeGraph.addEntity({
        id: docId,
        type: "DOC",
        name: title,
        properties: {
          ...(existing?.properties ?? {}),
          channelId: channel,
          sourceChannel: channel,
          contentSha256: payload.content_sha256,
          tags: [`source:${channel}`, channel],
        },
        activation,
        lastActive,
      });
    } else if (kind === "channel.link.upserted") {
      const fromKey = String(payload.from_key ?? "");
      const toKey = String(payload.to_key ?? "");
      const relStr = String(payload.rel ?? "links_to");
      if (!fromKey || !toKey) return;

      let sourceId = this.resolveEntityId(fromKey);
      if (!sourceId) sourceId = `doc:${fromKey}`;

      let targetId = this.resolveEntityId(toKey);
      if (!targetId) {
        targetId = `doc:${toKey}`;
        this.lifeGraph.addEntity({
          id: targetId,
          type: "DOC",
          name: "(document)",
          properties: {
            channelId: channel,
            sourceChannel: channel,
            tags: [`source:${channel}`, channel],
          },
          activation: 0.5,
          lastActive: observedAt,
        });
      }

      const relMap: Record<string, RelationType> = {
        mentions: "MENTIONS",
        links_to: "REFERENCES",
        authored: "WORKS_ON",
        member_of: "CARES_ABOUT",
      };
      const relation = relMap[relStr] ?? "REFERENCES";

      if (this.lifeGraph.getEntity(sourceId) && this.lifeGraph.getEntity(targetId)) {
        try {
          this.lifeGraph.addEdge(sourceId, targetId, relation, 1.0, undefined, observedAt);
        } catch {
          // ignore duplicate
        }
      }
    } else if (kind === "channel.disconnected") {
      if (channel) {
        this.purgeChannelEntities(channel);
      }
    }
  }

  public onEventsAppended(events: EventRecord[], db?: ExocortexDatabase): BeliefSnapshotRecord | null {
    const targetDb = db ?? (hasDatabase() ? getDatabase() : null);
    if (targetDb) this.preferenceDb = targetDb;
    const lastProcessed = targetDb ? (this.processedEventSeqByDb.get(targetDb) ?? 0) : 0;
    const pendingEvents = [...events].sort((a, b) => a.seq - b.seq).filter((ev) => ev.seq > lastProcessed);
    if (pendingEvents.length === 0) return null;
    if (targetDb && !this.firstLiveSeqByDb.has(targetDb)) this.firstLiveSeqByDb.set(targetDb, pendingEvents[0].seq);
    const touchedFactors = new Set<string>();
    const batchSnapshots: BeliefSnapshotRecord[] = [];
    let lastObsSeq: number | null = null;

    for (const ev of pendingEvents) {
      if (typeof ev.kind === "string" && ev.kind.startsWith("channel.")) {
        this.projectEventToGraph(ev, targetDb);
        if (targetDb) this.processedEventSeqByDb.set(targetDb, ev.seq);
        continue;
      }
      try {
        const linkCtx = this.projectEventToGraph(ev, targetDb)!;
        for (const listener of this.graphListeners) {
          try {
            listener(linkCtx, ev);
          } catch (listenerErr) {
            console.warn("[world-model-host] graph update listener error:", listenerErr);
          }
        }
      } catch (graphErr) {
        console.warn(`[world-model-host] graph link error for seq ${ev.seq}:`, graphErr);
      }

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
      if (targetDb) this.processedEventSeqByDb.set(targetDb, ev.seq);
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
   * Return the latest EventGraphContext produced by linkEventToGraph strictly scoped to a deviceId.
   */
  public getLastGraphContext(deviceId: string): EventGraphContext | null {
    if (!deviceId) return null;
    return this.lastGraphContextByDevice.get(deviceId) ?? null;
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
