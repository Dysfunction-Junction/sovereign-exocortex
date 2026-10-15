import { describe, it, expect } from "vitest";
import {
  DiscreteGenerativeFactor,
  LearnedActiveInferenceEngine,
  eventToObservation,
  type FactorDefinition,
} from "./generative-model.js";
import type { EventRecord } from "@exocortex/core";

describe("shared validated observations", () => {
  function event(payload: Record<string, unknown>, kind: "observation" | "telemetry" | "shadow_label" = "observation"): EventRecord {
    return { seq: 1, kind, ts_device: 100, payload: JSON.stringify(payload) } as EventRecord;
  }

  it("maps invariant booleans and foreground aliases identically and rejects unsupported signals", () => {
    expect(eventToObservation(event({ invariantId: "inv_bridge_connected", observedState: false })))
      .toEqual({ factor: "link_health", obs: "ws_dropped" });
    for (const alias of ["app", "foreground", "foregroundApp"]) {
      expect(eventToObservation(event({ [alias]: "com.microsoft.VSCode" }, "telemetry")))
        .toEqual({ factor: "user_mode", obs: "typing_burst" });
      expect(eventToObservation(event({ [alias]: "decoder" }, "telemetry"))?.obs).toBe("window_switch");
    }
    for (const payload of [
      { factor: "repo_health", observation: "invented" },
      { factor: "constructor", observation: "tests_fail" },
      { factor: "__proto__", observation: "tests_fail" },
      { factor: "toString", observation: "tests_fail" },
      { invariantId: "constructor", observedState: false },
      { invariantId: "__proto__", observedState: false },
      { invariantId: "toString", observedState: false },
      { factor: "repo_health", observation: "tests_fail", action: "self_heal_restore" },
      { invariantId: "inv_clean_test_suite", observedState: "false" },
      { invariantId: "inv_clean_test_suite", observedState: true, factor: "repo_health", observation: "tests_fail" },
      { factor: "repo_health", observation: "tests_fail", confidence: NaN },
      { tests: "maybe" },
      { tests: "passed", state: false },
      { invariant: "clean_suite", state: "false" },
    ]) expect(eventToObservation(event(payload))).toBeNull();
    expect(eventToObservation(event({ factor: "repo_health", observation: "tests_pass", action: "self_heal_patch" }, "shadow_label"))).toBeNull();
  });

  it("learns transitions only for recorded actions, never proposed actions", () => {
    const learned = new LearnedActiveInferenceEngine();
    const factor = learned.getFactor("repo_health")!;
    const before = structuredClone(factor.bCounts);
    learned.processObservation("repo_health", "tests_fail");
    expect(factor.bCounts.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(factor.bCounts.at(-1)).not.toEqual(before.at(-1));
    expect(factor.lastActionIndex).toBe(factor.actions.indexOf("no_op"));
    const after = structuredClone(factor.bCounts);
    learned.processObservation("repo_health", "tests_pass", "self_heal_patch");
    expect(factor.bCounts[0]).not.toEqual(after[0]);
    expect(factor.bCounts.slice(1)).toEqual(after.slice(1));
  });

  it("validates custom registered factor observations during replay without freezing support to defaults", () => {
    const definition = {
      name: "custom_health", states: ["ready", "broken"],
      observations: ["green", "red"], actions: ["repair", "no_op"],
    };
    const live = new LearnedActiveInferenceEngine();
    const replay = new LearnedActiveInferenceEngine();
    live.registerFactor(definition);
    replay.registerFactor(definition);
    const events = [
      event({ factor: "custom_health", observation: "red" }),
      event({ factor: "custom_health", observation: "red", action: "invented" }),
      event({ factor: "custom_health", observation: "green", action: "repair" }),
    ].map((e, i) => ({ ...e, seq: i + 1 }));
    expect(eventToObservation(events[0])).toBeNull(); // callers without a model know only defaults
    expect(eventToObservation(events[0], (name) => live.getFactor(name))?.obs).toBe("red");
    expect(eventToObservation(events[1], (name) => live.getFactor(name))).toBeNull();
    live.processObservation("custom_health", "red");
    live.processObservation("custom_health", "green", "repair");
    replay.replayEventStream(events);
    expect(replay.exportModelParams(0)).toEqual(live.exportModelParams(0));
    expect(replay.createBeliefSnapshot(0)).toEqual(live.createBeliefSnapshot(0));
  });

  it("skips poison invariant metadata and prototype keys without aborting replay or mutating learned state", () => {
    const poisonedPayloads = [
      { tests: { toString: null } },
      { invariantId: "inv_clean_test_suite", observedState: false, metadata: { factor: "repo_health", observation: "tests_pass" } },
      { invariantId: "inv_clean_test_suite", observedState: false, metadata: { factor: "repo_health", observation: "invented" } },
      { invariantId: "inv_clean_test_suite", observedState: false, metadata: { action: "run_diagnostics" } },
      { invariantId: "inv_clean_test_suite", observedState: false, metadata: [] },
      { invariantId: "inv_clean_test_suite", observedState: false, metadata: "malformed" },
      { invariantId: "inv_clean_test_suite", observedState: false, factor: "repo_health", observation: "tests_fail", metadata: "malformed" },
      ...["__proto__", "toString", "constructor"].flatMap((key) => [
        { factor: key, observation: "tests_fail" },
        { invariantId: key, observedState: false },
        { invariantId: "inv_clean_test_suite", observedState: false, metadata: { factor: key, observation: "tests_fail" } },
      ]),
    ];
    const replay = new LearnedActiveInferenceEngine();
    const before = replay.exportModelParams(0);
    for (const payload of poisonedPayloads) {
      expect(eventToObservation(event(payload))).toBeNull();
      replay.replayEventStream([event(payload)]);
      expect(replay.exportModelParams(0)).toEqual(before);
    }
    const events = [
      ...poisonedPayloads.map((payload) => event(payload)),
      event({ factor: "repo_health", observation: "tests_pass", action: "run_diagnostics" }),
    ].map((e, i) => ({ ...e, seq: i + 1 }));
    const result = replay.replayEventStream(events);
    expect(result.replayedCount).toBe(events.length);
    expect(result.snapshots).toHaveLength(events.length);
    const expected = new LearnedActiveInferenceEngine();
    expected.processObservation("repo_health", "tests_pass", "run_diagnostics");
    expect(replay.exportModelParams(0)).toEqual(expected.exportModelParams(0));
    expect(replay.createBeliefSnapshot(0)).toEqual(expected.createBeliefSnapshot(0));
  });
});

describe("DiscreteGenerativeFactor", () => {
  const testFactorDef: FactorDefinition = {
    name: "test_health",
    states: ["HEALTHY", "DEGRADED", "FAILING"],
    observations: ["green_metric", "warning_metric", "critical_metric"],
    actions: ["restart_service", "apply_hotfix", "noop"],
    initialPriorCounts: [8.0, 1.0, 1.0], // Mostly healthy prior
    initialLikelihoodCounts: [
      [9.0, 1.0, 0.1], // green_metric mostly in HEALTHY
      [1.0, 8.0, 1.0], // warning_metric mostly in DEGRADED
      [0.1, 1.0, 9.0], // critical_metric mostly in FAILING
    ],
    // High self-persistence on transitions
    initialTransitionCounts: [
      // action 0: restart_service
      [
        [8.0, 5.0, 5.0],
        [1.0, 4.0, 4.0],
        [1.0, 1.0, 1.0],
      ],
      // action 1: apply_hotfix
      [
        [5.0, 8.0, 5.0],
        [4.0, 1.0, 4.0],
        [1.0, 1.0, 1.0],
      ],
      // action 2: noop (state persistence)
      [
        [9.0, 0.5, 0.5],
        [0.5, 9.0, 0.5],
        [0.5, 0.5, 9.0],
      ],
    ],
    preferredObservations: [
      Math.log(0.9), // strong preference for green_metric
      Math.log(0.09), // mild penalty for warning_metric
      Math.log(0.01), // severe penalty for critical_metric
    ],
  };

  it("normalizes prior vector D and likelihood matrix A correctly", () => {
    const factor = new DiscreteGenerativeFactor(testFactorDef);

    const D = factor.getD();
    expect(D).toHaveLength(3);
    const sumD = D.reduce((a, b) => a + b, 0);
    expect(sumD).toBeCloseTo(1.0, 5);
    expect(D[0]).toBeCloseTo(8 / 10, 4);

    const A = factor.getA();
    expect(A).toHaveLength(3); // 3 observations
    // Each column (state) must sum to 1.0
    for (let s = 0; s < 3; s++) {
      let colSum = 0;
      for (let o = 0; o < 3; o++) {
        colSum += A[o][s];
      }
      expect(colSum).toBeCloseTo(1.0, 5);
    }
  });

  it("normalizes transition tensor B per action", () => {
    const factor = new DiscreteGenerativeFactor(testFactorDef);

    for (let a = 0; a < factor.actions.length; a++) {
      const B = factor.getB(a);
      expect(B).toHaveLength(3);
      for (let s = 0; s < 3; s++) {
        let colSum = 0;
        for (let nextS = 0; nextS < 3; nextS++) {
          colSum += B[nextS][s];
        }
        expect(colSum).toBeCloseTo(1.0, 5);
      }
    }
  });

  it("calculates exact Shannon surprisal and updates Bayesian beliefs", () => {
    const factor = new DiscreteGenerativeFactor(testFactorDef);

    // Initial belief is D = [0.8, 0.1, 0.1]
    // Observing critical_metric (index 2) should yield high surprisal because state is believed to be HEALTHY
    const resultCrit = factor.updateBelief(2, 2, factor.getD());
    expect(resultCrit.surprisalNats).toBeGreaterThan(1.8); // High surprisal (~1.96 nats)
    // Posterior should now shift towards FAILING (index 2)
    expect(resultCrit.posterior[2]).toBeGreaterThan(resultCrit.posterior[0]);

    // Conversely, observing green_metric (index 0) from HEALTHY prior should yield very low surprisal
    const factorGreen = new DiscreteGenerativeFactor(testFactorDef);
    const resultGreen = factorGreen.updateBelief(0, 2, factorGreen.getD());
    expect(resultGreen.surprisalNats).toBeLessThan(1.0); // Low surprisal
    expect(resultGreen.posterior[0]).toBeGreaterThan(0.8);
  });

  it("evaluates candidate policies via Expected Free Energy (Risk + Ambiguity)", () => {
    const factor = new DiscreteGenerativeFactor(testFactorDef);

    const policies = factor.evaluatePolicies();
    expect(policies).toHaveLength(3);
    // Policies are sorted by expectedFreeEnergy ascending
    expect(policies[0].expectedFreeEnergy).toBeLessThanOrEqual(policies[1].expectedFreeEnergy);
    expect(policies[1].expectedFreeEnergy).toBeLessThanOrEqual(policies[2].expectedFreeEnergy);

    // Verify all components exist and are finite numbers
    for (const p of policies) {
      expect(Number.isFinite(p.expectedFreeEnergy)).toBe(true);
      expect(Number.isFinite(p.riskTerm)).toBe(true);
      expect(Number.isFinite(p.ambiguityTerm)).toBe(true);
      expect(p.predictedNextState).toHaveLength(3);
      expect(p.predictedObservation).toHaveLength(3);
    }
  });

  it("performs Dirichlet conjugate learning increments", () => {
    const factor = new DiscreteGenerativeFactor(testFactorDef);
    const prevA00 = factor.aCounts[0][0];
    const prevVersion = factor.version;

    // Observe green_metric with belief centered on state 0
    factor.learn(0, [1.0, 0.0, 0.0], 0, [1.0, 0.0, 0.0], 1.5);

    expect(factor.aCounts[0][0]).toBeCloseTo(prevA00 + 1.5, 4);
    expect(factor.version).toBe(prevVersion + 1);
  });
});

describe("LearnedActiveInferenceEngine", () => {
  it("initializes with default factors: user_mode, repo_health, link_health", () => {
    const engine = new LearnedActiveInferenceEngine();
    const factors = engine.listFactors();
    expect(factors).toHaveLength(3);

    const userMode = engine.getFactor("user_mode");
    expect(userMode).toBeDefined();
    expect(userMode?.states).toContain("DEEP_FOCUS");
    expect(userMode?.observations).toContain("typing_burst");

    const repoHealth = engine.getFactor("repo_health");
    expect(repoHealth).toBeDefined();
    expect(repoHealth?.states).toContain("CLEAN");

    const linkHealth = engine.getFactor("link_health");
    expect(linkHealth).toBeDefined();
    expect(linkHealth?.states).toContain("CONNECTED_FAST");
  });

  it("processes observations end-to-end and selects optimal policy", () => {
    const engine = new LearnedActiveInferenceEngine();

    const result = engine.processObservation("user_mode", "typing_burst");
    expect(result.factor).toBe("user_mode");
    expect(result.obsName).toBe("typing_burst");
    expect(result.surprisalNats).toBeGreaterThanOrEqual(0);
    expect(result.bestPolicy).toBeDefined();
    expect(result.allPolicies.length).toBeGreaterThan(0);
    expect(result.posterior["DEEP_FOCUS"]).toBeDefined();
  });

  it("throws for unknown factors or observations", () => {
    const engine = new LearnedActiveInferenceEngine();
    expect(() => engine.processObservation("non_existent_factor", "xyz")).toThrow(/Unknown generative factor/);
    expect(() => engine.processObservation("user_mode", "non_existent_obs")).toThrow(/Observation 'non_existent_obs' not found/);
  });

  it("exports and imports model parameters seamlessly to SQLite records", () => {
    const engine = new LearnedActiveInferenceEngine();

    // Mutate state with learning
    engine.processObservation("repo_health", "tests_pass");
    const exported = engine.exportModelParams(42);

    expect(exported.length).toBe(3 * 4); // 3 factors * 4 kinds (A, B, C, D)
    expect(exported[0].as_of_seq).toBe(42);

    // Import into fresh engine
    const freshEngine = new LearnedActiveInferenceEngine();
    freshEngine.importModelParams(exported);

    const repoFactor = freshEngine.getFactor("repo_health");
    expect(repoFactor?.version).toBeGreaterThanOrEqual(2);
  });

  it("creates accurate BeliefSnapshotRecord", () => {
    const engine = new LearnedActiveInferenceEngine();
    const snapshot = engine.createBeliefSnapshot(100);

    expect(snapshot.as_of_seq).toBe(100);
    expect(snapshot.mode).toBeDefined();
    expect(typeof snapshot.q).toBe("string");

    const parsedQ = JSON.parse(snapshot.q);
    expect(parsedQ.user_mode).toBeDefined();
    expect(parsedQ.repo_health).toBeDefined();
    expect(parsedQ.link_health).toBeDefined();
  });

  it("hydrates in-memory beliefs from a BeliefSnapshotRecord", () => {
    const engine = new LearnedActiveInferenceEngine();
    const mockSnapshot: BeliefSnapshotRecord = {
      as_of_seq: 55,
      mode: "HIGH_VELOCITY",
      q: JSON.stringify({
        user_mode: {
          DEEP_FOCUS: 0.1,
          HIGH_VELOCITY: 0.8,
          EXPLORATORY: 0.05,
          MAINTENANCE: 0.03,
          REST: 0.02,
        },
      }),
      surprisal: 0.5,
    };

    engine.hydrateFromSnapshot(mockSnapshot);
    const userFactor = engine.getFactor("user_mode");
    expect(userFactor?.currentBelief[1]).toBeCloseTo(0.8, 3); // HIGH_VELOCITY is index 1
  });

  it("deterministically replays an immutable event stream reconstructing model state", () => {
    const engine = new LearnedActiveInferenceEngine();

    const fakeEvents: EventRecord[] = [
      {
        seq: 1,
        event_id: "evt_1",
        device_id: "dev_test",
        kind: "observation",
        ts_device: 1000,
        ts_server: 1000,
        schema_ver: 1,
        payload: JSON.stringify({
          factor: "user_mode",
          observation: "typing_burst",
        }),
        prev_hash: null,
        hash: "h1",
      },
      {
        seq: 2,
        event_id: "evt_2",
        device_id: "dev_test",
        kind: "observation",
        ts_device: 1001,
        ts_server: 1001,
        schema_ver: 1,
        payload: JSON.stringify({
          factor: "repo_health",
          observation: "tests_pass",
        }),
        prev_hash: "h1",
        hash: "h2",
      },
      {
        seq: 3,
        event_id: "evt_3",
        device_id: "dev_test",
        kind: "telemetry",
        ts_device: 1002,
        ts_server: 1002,
        schema_ver: 1,
        payload: JSON.stringify({
          foreground: "code.exe",
        }),
        prev_hash: "h2",
        hash: "h3",
      },
    ];

    const replayResult = engine.replayEventStream(fakeEvents);
    expect(replayResult.replayedCount).toBe(3);
    expect(replayResult.snapshots).toHaveLength(3);
    expect(replayResult.snapshots[0].as_of_seq).toBe(1);
    expect(replayResult.snapshots[2].as_of_seq).toBe(3);
    expect(replayResult.latestParams.length).toBe(12);
  });

  it("guarantees live execution and deterministic replay produce identical models", () => {
    const liveEngine = new LearnedActiveInferenceEngine();

    const events: EventRecord[] = [
      {
        seq: 1,
        event_id: "evt_1",
        device_id: "dev_test",
        kind: "observation",
        ts_device: 1000,
        ts_server: 1000,
        schema_ver: 1,
        payload: JSON.stringify({
          factor: "user_mode",
          observation: "typing_burst",
        }),
        prev_hash: null,
        hash: "h1",
      },
      {
        seq: 2,
        event_id: "evt_2",
        device_id: "dev_test",
        kind: "observation",
        ts_device: 1001,
        ts_server: 1001,
        schema_ver: 1,
        payload: JSON.stringify({
          factor: "repo_health",
          observation: "tests_pass",
        }),
        prev_hash: "h1",
        hash: "h2",
      },
    ];

    // Live processing using pure event-to-observation
    for (const ev of events) {
      const extracted = liveEngine.processObservation(
        ev.kind === "observation" ? JSON.parse(ev.payload).factor : "user_mode",
        ev.kind === "observation" ? JSON.parse(ev.payload).observation : "typing_burst"
      );
      expect(extracted).toBeDefined();
    }
    const liveSnapshot = liveEngine.createBeliefSnapshot(2);
    const liveParams = liveEngine.exportModelParams(2);

    // Replay processing from clean initial engine
    const replayEngine = new LearnedActiveInferenceEngine();
    const replayResult = replayEngine.replayEventStream(events);

    expect(replayResult.snapshots[1].q).toBe(liveSnapshot.q);
    expect(replayResult.snapshots[1].mode).toBe(liveSnapshot.mode);
    expect(replayResult.latestParams).toEqual(liveParams);
  });
});
