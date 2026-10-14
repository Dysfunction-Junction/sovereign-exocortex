import assert from "node:assert/strict";
import test from "node:test";
import { ExocortexDatabase } from "@exocortex/core/db";
import { defaultWorldModelHost } from "./world-model-host.js";
import { recordTestScreenshotClassification } from "./vision-observation.js";

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
