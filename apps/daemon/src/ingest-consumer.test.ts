process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import { IngestConsumer } from "./ingest-consumer.js";
import { WorldModelHost } from "./world-model-host.js";
import { PreCognitiveHost } from "./precognitive-host.js";
import { PredictionHost } from "./prediction-host.js";
import { TriageHost } from "./triage-host.js";

function databaseWithEvents(count = 2): ExocortexDatabase {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice({
    device_id: "consumer-test", name: "consumer-test", platform: "linux", pubkey_spki: new Uint8Array([1]),
    key_attested: 0, scopes: ["telemetry:write"], enrolled_at: Date.now(), revoked_at: null,
  });
  db.ingestBatch({
    device_id: "consumer-test",
    events: Array.from({ length: count }, (_, i) => ({
      event_id: `consumer-${i + 1}`, kind: "telemetry", schema_ver: 1, ts_device: i + 1, payload: { n: i + 1 },
    })),
  });
  return db;
}

test("ingest consumer runs hooks off-turn, advances independent cursors, and resumes after restart", async () => {
  const db = databaseWithEvents();
  try {
    const seen: Record<string, number[]> = { "world-model": [], triage: [] };
    const hooks = Object.keys(seen).map((name) => ({
      name,
      apply: (events: { seq: number }[]) => { seen[name].push(...events.map((event) => event.seq)); },
    }));
    const first = new IngestConsumer({ db, hooks });
    first.wake();
    assert.deepEqual(seen["world-model"], [], "wake must defer hooks to a later event-loop turn");
    await first.idle();
    assert.deepEqual(seen["world-model"], [1, 2]);
    assert.deepEqual(seen.triage, [1, 2]);
    assert.equal(db.getConsumerCursor("world-model"), 2);
    assert.equal(db.getConsumerCursor("triage"), 2);

    first.wake();
    await first.idle();
    const restarted = new IngestConsumer({ db, hooks });
    await restarted.drain();
    assert.deepEqual(seen["world-model"], [1, 2], "reapplying the same event range must be idempotent");
  } finally {
    db.close();
  }
});

test("a failed hook keeps its cursor and retries the event", async () => {
  const db = databaseWithEvents(1);
  try {
    let attempts = 0;
    const consumer = new IngestConsumer({
      db,
      hooks: [{ name: "flaky", apply: () => { attempts++; if (attempts === 1) throw new Error("temporary"); } }],
      onError: () => {},
    });
    await consumer.drain();
    assert.equal(db.getConsumerCursor("flaky"), 0);
    await consumer.drain();
    assert.equal(attempts, 2);
    assert.equal(db.getConsumerCursor("flaky"), 1);
  } finally {
    db.close();
  }
});

test("world-model hook is idempotent when applying the same event twice", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    db.registerDevice({
      device_id: "dev_wm", name: "dev_wm", platform: "linux", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: ["telemetry:write"], enrolled_at: Date.now(), revoked_at: null,
    });
    const batch = db.ingestBatch({
      device_id: "dev_wm",
      events: [
        {
          event_id: "wm_ev_1",
          kind: "telemetry",
          schema_ver: 1,
          ts_device: Date.now(),
          payload: { app: "code.exe", foreground: "VSCode" },
        },
      ],
    });

    const host = WorldModelHost.createIsolatedForTest();
    host.onEventsAppended(batch.events, db);
    const initialEntityCount = host.lifeGraph.entityCount;
    const initialEdgeCount = host.lifeGraph.edgeCount;

    // Apply the exact same event second time
    const secondResult = host.onEventsAppended(batch.events, db);
    assert.equal(secondResult, null, "second apply of same events should produce null snapshot");
    assert.equal(host.lifeGraph.entityCount, initialEntityCount, "entity count must remain identical");
    assert.equal(host.lifeGraph.edgeCount, initialEdgeCount, "edge count must remain identical");
  } finally {
    db.close();
  }
});

test("triage hook is idempotent when applying the same event twice", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    db.registerDevice({
      device_id: "dev_triage", name: "dev_triage", platform: "linux", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: ["telemetry:write"], enrolled_at: Date.now(), revoked_at: null,
    });
    const batch = db.ingestBatch({
      device_id: "dev_triage",
      events: [
        {
          event_id: "triage_ev_1",
          kind: "telemetry",
          schema_ver: 1,
          ts_device: Date.now(),
          payload: { type: "system_telemetry", telemetry: "Water bill is due tomorrow morning", app_label: "Messages" },
        },
      ],
    });

    const triage = new TriageHost({ enabled: true });
    const firstResult = triage.onEventsAppended(batch.events, db);
    assert.equal(firstResult.queued, 1, "first call should queue the event");

    // Reapply identical event
    const secondResult = triage.onEventsAppended(batch.events, db);
    assert.equal(secondResult.queued, 0, "second call with same event seq must queue 0");
  } finally {
    db.close();
  }
});

test("precognitive hook is idempotent when applying the same event twice", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    db.registerDevice({
      device_id: "dev_precog", name: "dev_precog", platform: "linux", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: ["telemetry:write"], enrolled_at: Date.now(), revoked_at: null,
    });
    const now = Date.now();
    const batch = db.ingestBatch({
      device_id: "dev_precog",
      events: [
        {
          event_id: "precog_ev_1",
          kind: "vibration",
          schema_ver: 1,
          ts_device: now,
          payload: { event: "VIBRATION" },
        },
      ],
    });

    const precog = PreCognitiveHost.createIsolatedForTest(() => now);
    precog.onEventsAppended(batch.events, db);
    const baselineReadiness = precog.getStatus("dev_precog");

    // Reapply identical event
    precog.onEventsAppended(batch.events, db);
    assert.deepEqual(precog.getStatus("dev_precog"), baselineReadiness);
  } finally {
    db.close();
  }
});

test("prediction hook is idempotent when applying the same event twice", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    db.registerDevice({
      device_id: "dev_pred", name: "dev_pred", platform: "linux", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: ["telemetry:write"], enrolled_at: Date.now(), revoked_at: null,
    });
    const batch = db.ingestBatch({
      device_id: "dev_pred",
      events: [
        {
          event_id: "pred_ev_1",
          kind: "telemetry",
          schema_ver: 1,
          ts_device: Date.now(),
          payload: { view: "status" },
        },
      ],
    });

    const pred = new PredictionHost();
    pred.onEventsAppended(batch.events, db);

    // Reapply identical event
    const second = pred.onEventsAppended(batch.events, db);
    assert.equal(second.guesses, 0);
    assert.equal(second.resolved, 0);
  } finally {
    db.close();
  }
});

test("shadow-labels hook in ingestConsumerForDatabase is idempotent", async () => {
  const { ingestConsumerForDatabase } = await import("./server.js");
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    db.registerDevice({
      device_id: "dev_label", name: "dev_label", platform: "linux", pubkey_spki: new Uint8Array([1]),
      key_attested: 0, scopes: ["telemetry:write"], enrolled_at: Date.now(), revoked_at: null,
    });
    const ev = db.ingestEvent("dev_label", {
      event_id: "prop_creation_ev",
      kind: "telemetry",
      schema_ver: 1,
      ts_device: Date.now(),
      payload: { app: "test" },
    });
    db.insertProposal({
      proposal_id: "prop_id_123",
      created_seq: ev.event.seq,
      invariant_id: null,
      policy_type: "PRAGMATIC",
      tier: 1,
      summary: "test proposal",
      action: JSON.stringify({ type: "test" }),
      action_hash: new Uint8Array(32),
      efe: 0.1,
      risk_term: 0.05,
      ambiguity_term: 0.05,
      state: "STAGED",
      shadow: 1,
      expires_at: Date.now() + 60000,
      updated_at: Date.now(),
    });

    db.ingestEvent("dev_label", {
      event_id: "label_ev_1",
      kind: "label",
      schema_ver: 1,
      ts_device: Date.now(),
      payload: { proposal_id: "prop_id_123", label: "wanted", source: "inferred" },
    });

    const consumer = ingestConsumerForDatabase(db);
    await consumer.drain();

    const labels = db.getShadowLabels("prop_id_123");
    assert.equal(labels.length, 1);
    assert.equal(labels[0].label, "wanted");

    // Replay drain (simulating consumer pass on already processed range)
    await consumer.drain();
    const labelsAfter = db.getShadowLabels("prop_id_123");
    assert.equal(labelsAfter.length, 1);
    assert.equal(labelsAfter[0].label, "wanted");
  } finally {
    db.close();
  }
});
