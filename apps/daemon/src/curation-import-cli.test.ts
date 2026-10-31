import test from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID } from "@exocortex/core";
import type { RawNeo4jExport } from "@exocortex/world-model";
import { importCurationArtifacts, parseCurationImportArgs } from "./curation-import-cli.js";
import { WorldModelHost } from "./world-model-host.js";
import { IngestConsumer } from "./ingest-consumer.js";

const SAMPLE_EXPORT: RawNeo4jExport = {
  nodes: [
    {
      eid: "n1",
      labels: ["Entity", "Topic"],
      props: {
        id: "topic_exocortex",
        name: "Exocortex",
        type: "TOPIC",
        vocab: true,
        generic: false,
        aliases: ["sovereign exocortex"],
      },
    },
    {
      eid: "n2",
      labels: ["Entity", "Topic"],
      props: {
        id: "topic_misc",
        name: "misc",
        type: "TOPIC",
        vocab: true,
        generic: true,
      },
    },
    {
      eid: "n3",
      labels: ["Entity", "Project"],
      props: {
        id: "project_sovereign_exocortex",
        name: "Sovereign Exocortex",
        type: "PROJECT",
      },
    },
    {
      eid: "n4",
      labels: ["Entity", "Folder"],
      props: {
        id: "folder_packages",
        name: "packages",
        type: "FOLDER",
        path: "packages",
      },
    },
    {
      eid: "n5",
      labels: ["Entity", "File"],
      props: {
        id: "file_graph_store",
        name: "graph-store.ts",
        type: "FILE",
        path: "packages/world-model/graph-store.ts",
      },
    },
  ],
  relationships: [
    {
      eid: "r1",
      type: "HAS_TOPIC",
      start: "n3",
      end: "n1",
      props: { id: "project_sovereign_exocortex:HAS_TOPIC:topic_exocortex", source: "entity-rule", weight: 0.9 },
    },
    {
      eid: "r2",
      type: "HAS_TOPIC",
      start: "n5",
      end: "n1",
      props: { id: "file_graph_store:HAS_TOPIC:topic_exocortex", source: "path-rule", weight: 0.7 },
    },
    {
      eid: "r3",
      type: "CONTAINS",
      start: "n4",
      end: "n5",
      props: { id: "folder_packages:CONTAINS:file_graph_store", weight: 1.0 },
    },
  ],
};

test("curation-import: dry-run computes canonical SHA-256 hashes identical to --apply without mutating the database", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const dry = importCurationArtifacts(SAMPLE_EXPORT, { db, apply: false });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.acceptedEvents, 0);
    assert.equal(dry.artifacts.length, 4);
    assert.equal(db.listEvents().length, 0);

    const artifactCount = (db.raw.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
    assert.equal(artifactCount, 0);

    const applied = importCurationArtifacts(SAMPLE_EXPORT, { db, apply: true });
    assert.deepEqual(
      dry.artifacts.map((a) => ({ name: a.name, eventId: a.eventId, sha256: a.sha256, bytes: a.bytes })),
      applied.artifacts.map((a) => ({ name: a.name, eventId: a.eventId, sha256: a.sha256, bytes: a.bytes })),
    );

    // Host device uses ShadowRecorder's unprivileged host:proposal scope, never admin
    const hostDev = db.getDevice(HOST_DEVICE_ID);
    assert.ok(hostDev);
    assert.deepEqual(hostDev.scopes, ["host:proposal"]);
  } finally {
    db.close();
  }
});

test("curation-import: --apply stores artifacts first, appends idempotent curation_import events, and hydrates cleanly", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const now = Date.now();
    const applied = importCurationArtifacts(SAMPLE_EXPORT, {
      db,
      apply: true,
      tsDeviceMs: now,
    });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.acceptedEvents, 4);
    assert.equal(applied.duplicateEvents, 0);
    assert.deepEqual(db.verifyCurationArtifacts(), {
      ok: true,
      checked: 4,
      missing: [],
      altered: [],
    });

    // Re-running --apply on the same export is 100% idempotent
    const second = importCurationArtifacts(SAMPLE_EXPORT, {
      db,
      apply: true,
      tsDeviceMs: now + 5_000,
    });
    assert.equal(second.acceptedEvents, 0);
    assert.equal(second.duplicateEvents, 4);

    // Deliver events via IngestConsumer and verify cold-restart hydration
    const liveHost = WorldModelHost.createIsolatedForTest();
    const consumer = new IngestConsumer({
      db,
      hooks: [{ name: "world-model", apply: (evs, target) => { liveHost.onEventsAppended(evs, target); } }],
    });
    await consumer.drain();

    assert.equal(liveHost.graphServing, true);
    assert.equal(liveHost.graphStore.status().vocabularyCount, 2);
    assert.equal(liveHost.graphStore.status().entityRuleLinkCount, 1);

    const restarted = WorldModelHost.createIsolatedForTest();
    restarted.rehydrate(db);
    assert.equal(restarted.graphServing, true);
    assert.equal(restarted.graphStore.status().vocabularyCount, 2);
    assert.equal(restarted.graphStore.status().entityRuleLinkCount, 1);
  } finally {
    db.close();
  }
});

test("curation-import: parseCurationImportArgs validates conflicting flags, missing --db value, and extra positionals", () => {
  const parsedDefault = parseCurationImportArgs(["./export.json"]);
  assert.equal(parsedDefault.apply, false);

  const parsedApply = parseCurationImportArgs(["./export.json", "--db", "./scratch.db", "--apply"]);
  assert.equal(parsedApply.apply, true);
  assert.ok(parsedApply.dbPath.endsWith("scratch.db"));

  assert.throws(() => parseCurationImportArgs(["./export.json", "--apply", "--dry-run"]), /cannot combine/i);
  assert.throws(() => parseCurationImportArgs(["./export.json", "--db", "--apply"]), /--db requires/i);
  assert.throws(() => parseCurationImportArgs(["./a.json", "./b.json"]), /extra positional/i);
});
