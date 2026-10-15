import assert from "node:assert/strict";
import test from "node:test";
import { ExocortexDatabase } from "@exocortex/core/db";
import { defaultWorldModelHost, WorldModelHost } from "./world-model-host.js";
import { recordTestScreenshotClassification } from "./vision-observation.js";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";
import { setDatabase } from "./db-host.js";

test("high-confidence failed test screenshot yields only shadow proposals and no image/summary persistence", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const recorded = recordTestScreenshotClassification(
      { status: "failed", confidence: 0.99, summary: "Sensitive screenshot text must not persist." },
      db,
    );
    const observation = db.listEvents({ kind: "observation" }).find((event) => event.event_id === recorded.eventId);
    assert.ok(observation);
    assert.equal(JSON.parse(observation.payload).source, "local_vision");
    assert.equal(observation.payload.includes("Sensitive screenshot text"), false);
    assert.equal(recorded.generatedPoliciesCount, 2);
    assert.ok(recorded.proposalIds.every((id) => db.getProposal(id)?.shadow === 1));
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    defaultWorldModelHost.setShadowRecorder(null);
    db.close();
  }
});

test("low-confidence screenshot is recorded as untrusted metadata and creates no proposal", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const recorded = recordTestScreenshotClassification(
      { status: "failed", confidence: 0.5, summary: "Uncertain." },
      db,
    );
    const observation = db.listEvents({ kind: "vision_observation" })[0];
    assert.ok(observation);
    assert.equal(JSON.parse(observation.payload).classification, "failed");
    assert.equal(observation.payload.includes("Uncertain."), false);
    assert.equal(recorded.generatedPoliciesCount, 0);
    assert.deepEqual(recorded.proposalIds, []);
    assert.equal(db.listEvents({ kind: "proposal" }).length, 0);
  } finally {
    defaultWorldModelHost.setShadowRecorder(null);
    db.close();
  }
});

test("vision-triggered observations never invoke an auto-executor", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  let executions = 0;
  defaultWorldModelHost.setAutoExecutor(() => executions++);
  try {
    recordTestScreenshotClassification(
      { status: "failed", confidence: 1, summary: "Tests failed." },
      db,
    );
    assert.equal(executions, 0);
  } finally {
    defaultWorldModelHost.setAutoExecutor(null);
    defaultWorldModelHost.setShadowRecorder(null);
    db.close();
  }
});

test("shared event ingestion keeps local vision forced-shadow even with a live recorder and auto gate", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const previousShadow = process.env.SHADOW;
  process.env.SHADOW = "0";
  setDatabase(db);
  try {
    const host = WorldModelHost.createIsolatedForTest();
    const recorder = new ShadowRecorder(db, { shadow: false, cooldownMs: 0 });
    recorder.ensureHostDevice();
    host.setShadowRecorder(recorder);
    let executions = 0;
    host.setAutoExecutor(() => executions++);
    const evaluate = host.cognitiveGate.evaluateProposal.bind(host.cognitiveGate);
    host.cognitiveGate.evaluateProposal = (proposal) => ({
      ...evaluate(proposal), action: "SILENT_AUTO_EXECUTE",
    });
    const append = (source: string) => {
      const event = db.ingestEvent(HOST_DEVICE_ID, {
        event_id: `source:${source}`, kind: "observation", ts_device: Date.now(), schema_ver: 1,
        payload: {
          invariantId: "inv_clean_test_suite", observedState: false, confidence: 1,
          factor: "repo_health", observation: "tests_fail", source,
        },
      }).event;
      host.onEventAppended(event, db);
    };
    append("local_vision");
    assert.equal(executions, 0);
    assert.equal(host.learnedEngine.getFactor("repo_health")!.version, 2); // one learning update
    const visionEvents = db.listEvents({ kind: "proposal" });
    assert.equal(visionEvents.length, 2);
    for (const event of visionEvents) {
      const payload = JSON.parse(event.payload);
      assert.equal(payload.shadow, true);
      assert.equal(db.getProposal(payload.proposal_id)!.shadow, 1);
    }
    append("local_test"); // control: the diagnostic really can actuate on the same live setup
    assert.equal(executions, 1);
    assert.equal(host.learnedEngine.getFactor("repo_health")!.version, 3);
    for (const event of db.listEvents({ kind: "proposal" }).slice(2)) {
      const payload = JSON.parse(event.payload);
      assert.equal(payload.shadow, false);
      assert.equal(db.getProposal(payload.proposal_id)!.shadow, 0);
    }
  } finally {
    if (previousShadow === undefined) delete process.env.SHADOW;
    else process.env.SHADOW = previousShadow;
    setDatabase(null);
  }
});
