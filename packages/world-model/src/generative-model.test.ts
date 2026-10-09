import { describe, it, expect } from "vitest";
import {
  DiscreteGenerativeFactor,
  LearnedActiveInferenceEngine,
  type FactorDefinition,
} from "./generative-model.js";
import type { EventRecord } from "@exocortex/core";

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
