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
  LivingLifeGraph,
  CognitiveModeGate,
  ActiveInferenceEngine,
  type CognitiveMode,
  type ProposalEnvelope,
  type ContextualSignals,
  type SystemObservation,
} from "@exocortex/world-model";
import { defaultDryRunCache, type SpeculativeProposal } from "@exocortex/core";
import type { ShadowRecorder } from "./shadow-recorder.js";

const MAX_RECORDER_FAILURES = 5;

export class WorldModelHost {
  private static instance: WorldModelHost | null = null;

  public readonly lifeGraph: LivingLifeGraph;
  public readonly cognitiveGate: CognitiveModeGate;
  public readonly activeInference: ActiveInferenceEngine;
  private shadowRecorder: ShadowRecorder | null = null;
  private recorderFailures = 0;
  private recorderDisabled = false;

  private constructor() {
    this.lifeGraph = new LivingLifeGraph();
    this.seedEcosystemGraph();

    this.cognitiveGate = new CognitiveModeGate();
    this.activeInference = new ActiveInferenceEngine(this.lifeGraph);
  }

  public static getInstance(): WorldModelHost {
    if (!WorldModelHost.instance) {
      WorldModelHost.instance = new WorldModelHost();
    }
    return WorldModelHost.instance;
  }

  /** Attach (or detach with null) the recorder that persists proposals + gate decisions. */
  public setShadowRecorder(recorder: ShadowRecorder | null): void {
    this.shadowRecorder = recorder;
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

  /**
   * Ingest real-time telemetry from phone sensorium or local desktop activity.
   */
  public ingestTelemetry(signals: ContextualSignals): {
    mode: CognitiveMode;
    stagedProposals: ProposalEnvelope[];
    drainedQueue: ProposalEnvelope[];
  } {
    const prevMode = this.cognitiveGate.mode;
    const mode = this.cognitiveGate.classifyMode(signals);

    // Stimulate relevant nodes in the Life Graph
    if (signals.foregroundApp) {
      const app = signals.foregroundApp.toLowerCase();
      if (app.includes("code") || app.includes("antigravity")) {
        this.lifeGraph.stimulate("project_sovereign_exocortex", 0.3);
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
  public ingestObservation(obs: SystemObservation): {
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
    const metric = this.activeInference.evaluateObservation(obs);

    const policies = this.activeInference.generatePolicies([metric]);
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

      // Persistence must never break observation ingest.
      try {
        this.shadowRecorder?.record(policy, proposal, gateDecision);
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
  } {
    return {
      entityCount: this.lifeGraph.entityCount,
      edgeCount: this.lifeGraph.edgeCount,
      cognitiveMode: this.cognitiveGate.mode,
      queuedProposalsCount: this.cognitiveGate.queueSize,
      registeredInvariantsCount: this.activeInference.registeredInvariants.length,
    };
  }
}

export const defaultWorldModelHost = WorldModelHost.getInstance();
