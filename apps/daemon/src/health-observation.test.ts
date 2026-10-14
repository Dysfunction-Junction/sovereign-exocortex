import assert from "node:assert/strict";
import test from "node:test";
import { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID } from "./shadow-recorder.js";
import { recordCodeHealthObservation } from "./health-observation.js";

test("passing local tests append a host observation without producing proposals", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const result = recordCodeHealthObservation(true, db);
    const events = db.listEvents();

    assert.equal(result.generatedPoliciesCount, 0);
    assert.equal(result.proposalIds.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].device_id, HOST_DEVICE_ID);
    assert.equal(JSON.parse(events[0].payload).observedState, true);
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    db.close();
  }
});

test("failing local tests produce persisted shadow proposals without actuation", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const result = recordCodeHealthObservation(false, db);
    const proposals = result.proposalIds.map((id) => db.getProposal(id));

    assert.equal(result.generatedPoliciesCount, 2);
    assert.equal(proposals.length, 2);
    assert.ok(proposals.every((proposal) => proposal?.shadow === 1));
    assert.equal(db.listEvents({ kind: "proposal" }).length, 2);
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    db.close();
  }
});
