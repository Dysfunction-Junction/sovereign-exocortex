process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import type { EventIn } from "@exocortex/core";
import { WorldModelHost } from "./world-model-host.js";
import { PredictionHost } from "./prediction-host.js";
import { TriageHost } from "./triage-host.js";
import { PreCognitiveHost } from "./precognitive-host.js";
import { loadProposalPreferences } from "./proposal-preferences.js";

const PHONE = "dev_phone_p1";
const HOST = "host:exocortexd";
const START = Date.UTC(2026, 9, 1);

function scratchDatabase(): ExocortexDatabase {
  const db = new ExocortexDatabase({ path: ":memory:" });
  for (const [device_id, platform] of [[PHONE, "android"], [HOST, "windows"]] as const) {
    db.registerDevice({
      device_id,
      name: device_id,
      platform,
      pubkey_spki: new Uint8Array([1, 2, 3]),
      key_attested: 0,
      scopes: ["telemetry:write", "admin:write"],
      enrolled_at: START,
      revoked_at: null,
    });
  }
  return db;
}

function createHostAt(fixedNow: number): WorldModelHost {
  const realNow = Date.now;
  Date.now = () => fixedNow;
  try {
    return WorldModelHost.createIsolatedForTest();
  } finally {
    Date.now = realNow;
  }
}

function canonicalGraphDump(host: WorldModelHost) {
  const snap = host.lifeGraph.snapshot();
  return {
    entities: snap.entities.map((e) => ({ id: e.id, type: e.type, name: e.name })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: snap.edges
      .map((e) => ({ id: e.id, observedCount: e.observedCount, lastObserved: e.lastObserved }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function learnerState(db: ExocortexDatabase) {
  return {
    params: db.listModelParams().map((p) => ({ factor: p.factor, kind: p.kind, version: p.version, counts: p.counts, as_of_seq: p.as_of_seq })),
    snapshots: (db.raw.prepare("SELECT as_of_seq, mode, q, surprisal FROM belief_snapshots ORDER BY as_of_seq").all() as unknown[]),
  };
}

function ingest(db: ExocortexDatabase, host: WorldModelHost, deviceId: string, events: EventIn[]): void {
  for (let i = 0; i < events.length; i += 200) {
    const batch = db.ingestBatch({ device_id: deviceId, events: events.slice(i, i + 200) });
    if (batch.insertedEvents.length === 0) continue;
    host.onEventsAppended(batch.insertedEvents, db);
    db.setConsumerCursor("world-model", batch.insertedEvents[batch.insertedEvents.length - 1].seq);
  }
}

function baseEvents(): EventIn[] {
  const tags = ["sovereign-exocortex", "bear house", "oakridge", "pieces", "triad"];
  return Array.from({ length: 600 }, (_, i): EventIn => {
    const ts_device = START + i * 60_000;
    if (i % 3 === 0) {
      return {
        event_id: `p1_obs_${i}`,
        kind: "observation",
        schema_ver: 1,
        ts_device,
        payload: { factor: "repo_health", observation: i % 2 ? "tests_pass" : "tests_fail" },
      };
    }
    return {
      event_id: `p1_tel_${i}`,
      kind: i % 3 === 1 ? "telemetry" : "touch",
      schema_ver: 1,
      ts_device,
      payload: { summary_id: `doc_${i % 40}`, name: `Doc ${i % 40}`, tags: [tags[i % tags.length]], persons: ["Operator"] },
    };
  });
}

/** System-emitted events written to look like evidence: if any of them were projected, the graph would change. */
function poisonEvents(count: number): { host: EventIn[]; phone: EventIn[] } {
  const poison = (i: number) => ({
    summary_id: `poison_doc_${i % 97}`,
    name: `Poison ${i % 97}`,
    tags: [`poison topic ${i % 31}`],
    persons: [`Poison Person ${i % 13}`],
    extracted_entities: [{ type: "url", value: `https://poison.test/${i % 7}`, confidence: 0.9 }],
    factor: "repo_health",
    observation: "tests_fail",
    type: "screen_view",
    screen: `poison_screen_${i % 5}`,
    telemetry: `Poison urgent telemetry ${i}`,
  });
  const hostEvents: EventIn[] = [];
  const phoneEvents: EventIn[] = [];
  for (let i = 0; i < count; i++) {
    const ts_device = START + 600 * 60_000 + i * 1_000;
    switch (i % 3) {
      case 0:
        hostEvents.push({ event_id: `p1_prop_${i}`, kind: "proposal", schema_ver: 1, ts_device, payload: poison(i) });
        break;
      case 1:
        hostEvents.push({
          event_id: `p1_label_${i}`,
          kind: "label",
          schema_ver: 1,
          ts_device,
          payload: { ...poison(i), source: "inferred", proposal_id: `prop_${i}`, label: "wanted" },
        });
        break;
      default:
        // query is observed, but its model-generated result must never be read
        phoneEvents.push({ event_id: `p1_query_${i}`, kind: "query", schema_ver: 1, ts_device, payload: { result: poison(i) } });
    }
  }
  return { host: hostEvents, phone: phoneEvents };
}

test("system-emitted events and query results change neither the graph, learner, predictions, nor triage (P1-G4)", async () => {
  const db = scratchDatabase();
  try {
    const fixedNow = Date.UTC(2026, 10, 15);
    const live = createHostAt(fixedNow);
    const predHost = new PredictionHost();
    const triageHost = new TriageHost({
      enabled: true,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ category: "routine", reason: "ok" }) } }] }),
      })) as unknown as typeof fetch,
    });
    const precogHost = PreCognitiveHost.createIsolatedForTest(() => START + 30_000);

    const base = baseEvents().map((e, idx): EventIn => {
      if (e.kind === "telemetry") {
        return {
          ...e,
          payload: {
            ...(e.payload as Record<string, unknown>),
            type: "system_telemetry",
            telemetry: `Incoming message ${idx}`,
            event: "SCREEN_ON",
          },
        };
      }
      if (e.kind === "touch") {
        return {
          ...e,
          payload: {
            ...(e.payload as Record<string, unknown>),
            type: "screen_view",
            screen: idx % 2 === 0 ? "status" : "ask",
          },
        };
      }
      return e;
    });
    ingest(db, live, PHONE, base);
    const baseRows = db.listEvents({});
    predHost.onEventsAppended(baseRows, db);
    triageHost.onEventsAppended(baseRows.slice(0, 10), db);
    await triageHost.idle();
    precogHost.onEventsAppended(baseRows, db);

    const graphBefore = canonicalGraphDump(live);
    const learnerBefore = learnerState(db);
    const predictionsBefore = db.raw.prepare("SELECT prediction_id, made_seq, context_key, candidates FROM predictions ORDER BY made_seq").all();
    const triageBefore = db.raw.prepare("SELECT event_seq, category, reason FROM triage_results ORDER BY event_seq").all();
    const precogBefore = precogHost.getStatus(PHONE);
    const prefsBefore = loadProposalPreferences(db, fixedNow);

    assert.ok(graphBefore.edges.length > 20, "base events must build a graph");
    assert.ok(learnerBefore.params.length > 0, "base events must train the learner");
    assert.ok(predictionsBefore.length > 0, "base events must produce predictions");
    assert.ok(triageBefore.length > 0, "base events must produce triage results");

    const { host, phone } = poisonEvents(10_000);
    ingest(db, live, HOST, host);
    ingest(db, live, PHONE, phone);
    const allRows = db.listEvents({});
    assert.equal(allRows.length, 600 + 10_000);

    const poisonRows = allRows.slice(600);
    const predRes = predHost.onEventsAppended(poisonRows, db);
    const triageRes = triageHost.onEventsAppended(poisonRows, db);
    await triageHost.idle();
    precogHost.onEventsAppended(poisonRows, db);

    assert.equal(predRes.guesses, 0, "poison events must not trigger new predictions");
    assert.equal(triageRes.queued, 0, "poison events must not queue triage jobs");
    assert.deepEqual(canonicalGraphDump(live), graphBefore, "live graph must ignore system-emitted events");
    assert.deepEqual(learnerState(db), learnerBefore, "model_params and belief_snapshots must not move");
    assert.deepEqual(
      db.raw.prepare("SELECT prediction_id, made_seq, context_key, candidates FROM predictions ORDER BY made_seq").all(),
      predictionsBefore,
      "predictions table must not change",
    );
    assert.deepEqual(
      db.raw.prepare("SELECT event_seq, category, reason FROM triage_results ORDER BY event_seq").all(),
      triageBefore,
      "triage_results table must not change",
    );
    assert.deepEqual(precogHost.getStatus(PHONE), precogBefore, "precognitive status must not change");
    assert.deepEqual(loadProposalPreferences(db, fixedNow), prefsBefore, "proposal preferences must not change");

    const dump = JSON.stringify(canonicalGraphDump(live));
    assert.ok(!/poison/i.test(dump), "no poisoned id or name may enter the graph");

    const status = live.getStoreStatus();
    assert.equal(status.unclassified.total, 0);
    assert.ok(status.graphSkipped >= Math.floor((10_000 * 2) / 3), "every proposal and inferred label is skipped");

    const restarted = createHostAt(fixedNow);
    restarted.rehydrate(db);
    assert.deepEqual(canonicalGraphDump(restarted), graphBefore, "restart must agree with live");
  } finally {
    db.close();
  }
});

test("two full replays under fake clocks 30 days apart produce identical dumps (P1-G2)", () => {
  const db = scratchDatabase();
  try {
    const live = WorldModelHost.createIsolatedForTest();
    ingest(db, live, PHONE, [
      ...baseEvents().slice(0, 100),
      {
        event_id: "p1_g2_past_pieces",
        kind: "past",
        schema_ver: 1,
        ts_device: START + 5_000,
        payload: { origin: "pieces-backfill", summary_id: "sum_p1_g2", name: "Exocortex session", tags: ["sovereign-exocortex"], persons: ["Operator"] },
      },
      ...Array.from({ length: 6 }, (_, i): EventIn => ({
        event_id: `p1_g2_past_comms_${i}`,
        kind: "past",
        schema_ver: 1,
        ts_device: START + 10_000 + i * 1_000,
        payload: { origin: "comms-backfill", people: ["person_mom"], labels: ["family"] },
      })),
    ]);

    const realNow = Date.now;
    const clockA = Date.UTC(2026, 9, 1);
    const clockB = clockA + 30 * 86_400_000;
    let dumpA: ReturnType<typeof canonicalGraphDump>;
    let dumpB: ReturnType<typeof canonicalGraphDump>;
    try {
      Date.now = () => clockA;
      const hostA = WorldModelHost.createIsolatedForTest();
      hostA.rehydrate(db);
      dumpA = canonicalGraphDump(hostA);

      Date.now = () => clockB;
      const hostB = WorldModelHost.createIsolatedForTest();
      hostB.rehydrate(db);
      dumpB = canonicalGraphDump(hostB);
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(dumpA, dumpB, "replay dumps 30 days apart must be identical");
  } finally {
    db.close();
  }
});

test("restart equals live across all event kinds including past, label, proposal, and query (P1-G3)", () => {
  const db = scratchDatabase();
  try {
    const live = WorldModelHost.createIsolatedForTest();
    const phoneBatch: EventIn[] = [];
    const hostBatch: EventIn[] = [];
    const tags = ["sovereign-exocortex", "bear house", "oakridge", "pieces", "triad"];
    for (let i = 0; i < 1500; i++) {
      const ts_device = START + i * 10_000;
      const m = i % 7;
      if (m === 0) {
        phoneBatch.push({
          event_id: `p1_g3_tel_${i}`,
          kind: "telemetry",
          schema_ver: 1,
          ts_device,
          payload: { summary_id: `doc_g3_${i % 60}`, name: `Doc G3 ${i % 60}`, tags: [tags[i % tags.length]], persons: ["Operator"] },
        });
      } else if (m === 1) {
        phoneBatch.push({
          event_id: `p1_g3_touch_${i}`,
          kind: "touch",
          schema_ver: 1,
          ts_device,
          payload: { summary_id: `doc_g3_${i % 60}`, tags: [tags[(i + 1) % tags.length]] },
        });
      } else if (m === 2) {
        phoneBatch.push({
          event_id: `p1_g3_past_pieces_${i}`,
          kind: "past",
          schema_ver: 1,
          ts_device,
          payload: { origin: "pieces-backfill", summary_id: `pieces_g3_${i % 30}`, name: `Session ${i % 30}`, tags: [tags[i % tags.length]], persons: ["Operator"] },
        });
      } else if (m === 3) {
        phoneBatch.push({
          event_id: `p1_g3_past_comms_${i}`,
          kind: "past",
          schema_ver: 1,
          ts_device,
          payload: { origin: "comms-backfill", people: [i % 2 === 0 ? "person_mom" : "person_sam_vendor"], labels: ["family"] },
        });
      } else if (m === 4) {
        phoneBatch.push({
          event_id: `p1_g3_query_${i}`,
          kind: "query",
          schema_ver: 1,
          ts_device,
          payload: { query: "status", tags: [tags[i % tags.length]], result: { tags: ["poison_query_result"], summary_id: "poison_doc" } },
        });
      } else if (m === 5) {
        hostBatch.push({
          event_id: `p1_g3_prop_${i}`,
          kind: "proposal",
          schema_ver: 1,
          ts_device,
          payload: { proposal_id: `prop_g3_${i}`, summary_id: "poison_prop_doc", tags: ["poison_prop_tag"] },
        });
      } else {
        hostBatch.push({
          event_id: `p1_g3_label_${i}`,
          kind: "label",
          schema_ver: 1,
          ts_device,
          payload: { proposal_id: `prop_g3_${i}`, label: "wanted", source: i % 2 === 0 ? "inferred" : "tap", tags: ["poison_label_tag"] },
        });
      }
    }
    ingest(db, live, PHONE, phoneBatch);
    ingest(db, live, HOST, hostBatch);
    assert.equal(db.listEvents({}).length, 1500);

    const liveDump = canonicalGraphDump(live);
    assert.ok(liveDump.entities.some((e) => e.id === "person_mom" && e.type === "PERSON"), "comms-backfill past events must project frequent contacts");
    assert.ok(!JSON.stringify(liveDump).includes("poison_"), "proposals, labels, and query.result must not leak into graph");

    const restarted = WorldModelHost.createIsolatedForTest();
    restarted.rehydrate(db);
    assert.deepEqual(canonicalGraphDump(restarted), liveDump, "restart dump must equal live dump across all event kinds");
  } finally {
    db.close();
  }
});

test("unclassified events are counted and project nowhere", () => {
  const db = scratchDatabase();
  try {
    const host = createHostAt(Date.UTC(2026, 10, 15));
    const before = canonicalGraphDump(host);
    ingest(db, host, PHONE, [
      { event_id: "p1_unknown_1", kind: "mystery_kind", schema_ver: 1, ts_device: START, payload: { tags: ["leak"], summary_id: "leak" } },
    ]);
    assert.deepEqual(canonicalGraphDump(host), before);
    assert.deepEqual(host.getStoreStatus().unclassified, { total: 1, byRule: { "unknown-kind:mystery_kind": 1 } });
  } finally {
    db.close();
  }
});

function curationImport(sha: string): EventIn {
  return {
    event_id: `p1_curation_${sha.slice(0, 8)}`,
    kind: "curation_import",
    schema_ver: 1,
    ts_device: START,
    payload: { artifact_sha256: sha, media_type: "application/vnd.exocortex.vocabulary+json", count: 1 },
  };
}

test("a missing or altered curation artifact makes the world model refuse to serve (P1-G5)", () => {
  const db = scratchDatabase();
  try {
    const { sha256 } = db.putArtifact("application/vnd.exocortex.vocabulary+json", { topics: [{ id: "topic_triad" }] });
    const missing = "cd".repeat(32);
    const host = createHostAt(Date.UTC(2026, 10, 15));
    ingest(db, host, HOST, [curationImport(sha256)]);
    assert.equal(host.graphServing, true);

    ingest(db, host, HOST, [curationImport(missing)]);
    assert.equal(host.graphServing, false, "live import of a missing artifact must stop serving");
    assert.deepEqual(host.getStoreStatus().artifacts?.missing, [missing]);

    const restarted = createHostAt(Date.UTC(2026, 10, 15));
    restarted.rehydrate(db);
    assert.equal(restarted.graphServing, false);
    assert.deepEqual(restarted.getStoreStatus().artifacts, { ok: false, checked: 2, missing: [missing], altered: [] });

    db.raw.exec("DROP TRIGGER artifacts_no_update");
    db.raw.prepare("UPDATE artifacts SET bytes = ? WHERE sha256 = ?").run(Buffer.from("{}"), Buffer.from(sha256, "hex"));
    const tampered = createHostAt(Date.UTC(2026, 10, 15));
    tampered.rehydrate(db);
    assert.deepEqual(tampered.getStoreStatus().artifacts?.altered, [sha256]);
  } finally {
    db.close();
  }
});

test("a ledger whose artifacts are intact serves", () => {
  const db = scratchDatabase();
  try {
    const { sha256 } = db.putArtifact("application/vnd.exocortex.vocabulary+json", { topics: [] });
    const host = createHostAt(Date.UTC(2026, 10, 15));
    ingest(db, host, HOST, [curationImport(sha256)]);
    const restarted = createHostAt(Date.UTC(2026, 10, 15));
    restarted.rehydrate(db);
    assert.equal(restarted.graphServing, true);
    assert.deepEqual(restarted.getStoreStatus().artifacts, { ok: true, checked: 1, missing: [], altered: [] });
  } finally {
    db.close();
  }
});
