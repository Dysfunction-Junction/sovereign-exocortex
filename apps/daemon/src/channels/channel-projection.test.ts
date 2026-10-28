import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { WorldModelHost } from "../world-model-host.js";
import { ChannelVault } from "./channel-vault.js";
import { ChannelManager } from "./channel-manager.js";
import type { IngestedDocument, IngestedEntity } from "./types.js";

test("world model projects channel events: live ingest equals replay, and disconnect purges on replay (spec R7 / row 1.3)", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const keyDir = mkdtempSync(join(tmpdir(), "wm-channel-projection-test-"));

  try {
    const vault = new ChannelVault(db, { keyDir });
    const liveHost = WorldModelHost.createIsolatedForTest();
    liveHost.setVault(vault);

    const manager = new ChannelManager({
      db,
      vault,
      configPath: join(keyDir, "channels.json"),
    });
    manager.attachToWorldModel(liveHost);

    // 1. Ingest Obsidian documents with a wikilink
    const doc1: IngestedDocument = {
      id: "doc:obsidian:Roadmap.md",
      title: "Project Alpha Roadmap",
      body: "Confidential launch plans. See [[Design.md]] and [[Meeting Notes]].",
      sourcePath: "/vault/Roadmap.md",
      channelId: "obsidian",
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      tags: ["planning", "alpha"],
      wikilinks: ["Design.md", "Meeting Notes"],
      metadata: {},
      untrusted: false,
    };

    const doc2: IngestedDocument = {
      id: "doc:obsidian:Design.md",
      title: "System Design Spec",
      body: "Architecture of Alpha core engine.",
      sourcePath: "/vault/Design.md",
      channelId: "obsidian",
      createdAt: 1700000002000,
      updatedAt: 1700000003000,
      tags: ["design"],
      wikilinks: ["Roadmap.md"],
      metadata: {},
      untrusted: false,
    };

    // 2. Ingest Gmail person entity
    const person: IngestedEntity = {
      id: "alice@example.com",
      type: "PERSON",
      name: "Alice Smith",
      channelId: "gmail",
      properties: { email: "alice@example.com", role: "lead" },
      untrusted: false,
    };

    // 3. Ingest Notion project entity
    const project: IngestedEntity = {
      id: "notion:project-999",
      type: "PROJECT",
      name: "Alpha Initiative",
      channelId: "notion",
      properties: { url: "https://notion.so/project-999" },
      untrusted: false,
    };

    // Simulate adapter ingestion through ChannelManager private handlers
    (manager as unknown as { handleDocumentIngested: (d: IngestedDocument) => void }).handleDocumentIngested(doc1);
    (manager as unknown as { handleDocumentIngested: (d: IngestedDocument) => void }).handleDocumentIngested(doc2);
    (manager as unknown as { handleEntityIngested: (e: IngestedEntity) => void }).handleEntityIngested(person);
    (manager as unknown as { handleEntityIngested: (e: IngestedEntity) => void }).handleEntityIngested(project);

    // Verify live host has projected the nodes
    const liveEntities = liveHost.lifeGraph.snapshot().entities.filter((e: any) => {
      const props = e.properties as Record<string, unknown> | undefined;
      return props?.channelId === "obsidian" || props?.channelId === "gmail" || props?.channelId === "notion";
    });
    assert.equal(liveEntities.length, 7); // doc1, doc2, 3 stubs from wikilinks, person Alice, project Alpha

    const liveDoc = liveEntities.find((e: any) => e.name === "Project Alpha Roadmap");
    assert.ok(liveDoc, "Roadmap document projected");
    assert.equal(liveDoc.type, "DOC");

    const livePerson = liveEntities.find((e: any) => e.name === "Alice Smith");
    assert.ok(livePerson, "Alice person projected");
    assert.equal(livePerson.type, "PERSON");

    const liveEdges = liveHost.lifeGraph.snapshot().edges;
    assert.ok(liveEdges.length >= 2, "Wikilink edges created in live graph");

    // 4. Test REPLAY: Fresh WorldModelHost replaying all events from database
    const replayHost = WorldModelHost.createIsolatedForTest();
    replayHost.setVault(vault);

    const allEvents = db.listEvents({});
    assert.ok(allEvents.length >= 5, "Database contains channel events");
    replayHost.onEventsAppended(allEvents, db);

    // Compare live and replay graph entity sets and edge sets
    const liveSnapshot = liveHost.lifeGraph.snapshot();
    const replaySnapshot = replayHost.lifeGraph.snapshot();

    const liveChannelEntities = liveSnapshot.entities
      .filter((e: any) => (e.properties as Record<string, unknown> | undefined)?.channelId)
      .map((e: any) => ({ id: e.id, type: e.type, name: e.name, channel: (e.properties as Record<string, unknown>).channelId }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id));

    const replayChannelEntities = replaySnapshot.entities
      .filter((e: any) => (e.properties as Record<string, unknown> | undefined)?.channelId)
      .map((e: any) => ({ id: e.id, type: e.type, name: e.name, channel: (e.properties as Record<string, unknown>).channelId }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id));

    assert.deepEqual(replayChannelEntities, liveChannelEntities, "Live and replay entity sets must be identical");

    const liveChannelEdges = liveSnapshot.edges
      .map((e: any) => ({ source: e.sourceId, target: e.targetId, rel: e.relation }))
      .sort((a: any, b: any) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`));

    const replayChannelEdges = replaySnapshot.edges
      .map((e: any) => ({ source: e.sourceId, target: e.targetId, rel: e.relation }))
      .sort((a: any, b: any) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`));

    assert.deepEqual(replayChannelEdges, liveChannelEdges, "Live and replay edge sets must be identical");

    // 5. Test DISCONNECT: disconnect Obsidian channel
    await manager.disconnectChannel("obsidian");

    // Verify live host purged obsidian entities
    const liveEntitiesAfterDisconnect = liveHost.lifeGraph.snapshot().entities.filter((e: any) => {
      const props = e.properties as Record<string, unknown> | undefined;
      return props?.channelId === "obsidian" || props?.sourceChannel === "obsidian";
    });
    assert.equal(liveEntitiesAfterDisconnect.length, 0, "Live host has 0 obsidian entities after disconnect");

    // 6. Test REPLAY after disconnect: replaying from seq 0 must show NO obsidian entities
    const postDisconnectReplayHost = WorldModelHost.createIsolatedForTest();
    postDisconnectReplayHost.setVault(new ChannelVault(db, { keyDir }));

    const postDisconnectEvents = db.listEvents({});
    postDisconnectReplayHost.onEventsAppended(postDisconnectEvents, db);

    const replayEntitiesAfterDisconnect = postDisconnectReplayHost.lifeGraph.snapshot().entities.filter((e: any) => {
      const props = e.properties as Record<string, unknown> | undefined;
      return props?.channelId === "obsidian" || props?.sourceChannel === "obsidian";
    });
    assert.equal(replayEntitiesAfterDisconnect.length, 0, "Replay host has 0 obsidian entities after disconnect");

    // Gmail and Notion entities must still remain
    const remainingReplayEntities = postDisconnectReplayHost.lifeGraph.snapshot().entities.filter((e: any) => {
      const props = e.properties as Record<string, unknown> | undefined;
      return props?.channelId === "gmail" || props?.channelId === "notion";
    });
    assert.equal(remainingReplayEntities.length, 2, "Gmail and Notion entities remain intact");
  } finally {
    db.close();
    try {
      rmSync(keyDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  }
});
