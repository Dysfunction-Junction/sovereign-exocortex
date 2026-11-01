import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID } from "@exocortex/core";
import {
  GraphClient,
  PIECES_GRAPH_MEDIA_TYPE as CLIENT_PIECES_GRAPH_MEDIA_TYPE,
  type PiecesGraphArtifact as ClientPiecesGraphArtifact,
} from "@exocortex/memory/graph-client";
import {
  PIECES_GRAPH_MEDIA_TYPE as WM_PIECES_GRAPH_MEDIA_TYPE,
  type PiecesGraphArtifact as WorldModelPiecesGraphArtifact,
  type RawNeo4jExport,
} from "@exocortex/world-model";
import { importCurationArtifacts, parseCurationImportArgs } from "./curation-import-cli.js";
import { WorldModelHost } from "./world-model-host.js";
import { IngestConsumer } from "./ingest-consumer.js";

// Compile-time cross-package contract equality check (Phase 5)
const _assertClientAssignableFromWm: ClientPiecesGraphArtifact =
  null as unknown as WorldModelPiecesGraphArtifact;
const _assertWmAssignableFromClient: WorldModelPiecesGraphArtifact =
  null as unknown as ClientPiecesGraphArtifact;
void _assertClientAssignableFromWm;
void _assertWmAssignableFromClient;

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
    assert.match(dry.note, /0 PiecesRecord\/Doc nodes/);
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

test("curation-import: emits pieces-graph curation_import event and rejects oversize pieces-graph (§8.2)", async () => {
  const withPieces: RawNeo4jExport = {
    nodes: [
      ...SAMPLE_EXPORT.nodes,
      {
        eid: "d1",
        labels: ["Doc", "Summaries"],
        props: { id: "pieces_sum_1", name: "Pieces Export Summary", path: "summaries/1.json" },
      },
    ],
    relationships: SAMPLE_EXPORT.relationships,
  };

  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    assert.throws(
      () => importCurationArtifacts(withPieces, { db, apply: false, maxPiecesGraphBytes: 32 }),
      /pieces-graph artifact .* exceeds cap/i,
    );
    assert.throws(
      () => importCurationArtifacts(withPieces, { db, apply: true, maxPiecesGraphBytes: 32 }),
      /pieces-graph artifact .* exceeds cap/i,
    );

    const res = importCurationArtifacts(withPieces, { db, apply: true, tsDeviceMs: 1_700_000_000_000 });
    assert.equal(res.acceptedEvents, 5);
    assert.equal(res.artifacts.some((a) => a.name === "pieces-graph"), true);
    assert.deepEqual(db.verifyCurationArtifacts(), {
      ok: true,
      checked: 5,
      missing: [],
      altered: [],
    });

    const host = WorldModelHost.createIsolatedForTest();
    host.rehydrate(db);
    assert.equal(host.graphServing, true);
    assert.equal(host.getStoreStatus().unclassified.total, 0);
  } finally {
    db.close();
  }

  // Real ExocortexDatabase on-disk -> importCurationArtifacts -> @exocortex/memory GraphClient recall
  assert.equal(CLIENT_PIECES_GRAPH_MEDIA_TYPE, WM_PIECES_GRAPH_MEDIA_TYPE);
  const dir = mkdtempSync(join(tmpdir(), "exo-curation-p5-"));
  try {
    const dbPath = join(dir, "exocortex.db");
    importCurationArtifacts(withPieces, { dbPath, apply: true, tsDeviceMs: 1_700_000_000_000 });
    const graphClient = GraphClient.fromEnv({ EXOCORTEX_DB_PATH: dbPath });
    assert.ok(graphClient);
    const searchRes = await graphClient.search("Pieces Export", 5);
    assert.equal(searchRes.available, true);
    if (searchRes.available) {
      assert.equal(searchRes.hits.length, 1);
      assert.equal(searchRes.hits[0]?.title, "Pieces Export Summary");
      assert.equal(searchRes.hits[0]?.untrusted, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
