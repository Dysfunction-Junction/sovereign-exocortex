import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import { recordChannelIngest, CHANNEL_INGEST_KIND } from "./channel-audit.js";
import { ChannelManager } from "./channel-manager.js";
import { WorldModelHost } from "../world-model-host.js";
import type { IngestedDocument, IngestedEntity } from "./types.js";

const doc = (body: string): IngestedDocument => ({
  id: "gmail:thread:t1", channelId: "gmail", title: "Invoice", body, tags: ["billing"],
  wikilinks: [], metadata: {}, createdAt: 1, updatedAt: 1, untrusted: true,
});

describe("channel ingest audit", () => {
  it("logs metadata and a content hash, never the body", () => {
    const db = new ExocortexDatabase({ path: ":memory:" });
    try {
      assert.equal(recordChannelIngest(db, doc("SECRET BODY TEXT")), true);
      const events = db.listEvents({ kind: CHANNEL_INGEST_KIND });
      assert.equal(events.length, 1);
      const raw = String(events[0].payload);
      assert.ok(!raw.includes("SECRET BODY TEXT"));
      const payload = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(payload.title, "Invoice");
      assert.match(String(payload.content_sha256), /^[0-9a-f]{64}$/);
    } finally {
      db.close();
    }
  });

  it("is idempotent per content and records a new event when content changes", () => {
    const db = new ExocortexDatabase({ path: ":memory:" });
    try {
      assert.equal(recordChannelIngest(db, doc("v1")), true);
      assert.equal(recordChannelIngest(db, doc("v1")), false);
      assert.equal(recordChannelIngest(db, doc("v2")), true);
      assert.equal(db.listEvents({ kind: CHANNEL_INGEST_KIND }).length, 2);
    } finally {
      db.close();
    }
  });

  it("logs entities by digest only (no contact address)", () => {
    const db = new ExocortexDatabase({ path: ":memory:" });
    try {
      const ent: IngestedEntity = { id: "person:alice@example.com", type: "PERSON", name: "Alice", channelId: "gmail", untrusted: true };
      recordChannelIngest(db, ent);
      const raw = String(db.listEvents({ kind: CHANNEL_INGEST_KIND })[0].payload);
      assert.ok(!raw.includes("alice@example.com"));
      assert.ok(!raw.includes("Alice"));
    } finally {
      db.close();
    }
  });

  it("manager forwards ingested items to the audit sink", () => {
    const manager = new ChannelManager({});
    const seen: string[] = [];
    manager.setAuditSink((item) => seen.push(item.id));
    manager.attachToWorldModel(WorldModelHost.createIsolatedForTest());
    (manager as unknown as { onDocumentIngested: (d: IngestedDocument) => void }).onDocumentIngested(doc("x"));
    assert.deepEqual(seen, ["gmail:thread:t1"]);
    manager.dispose();
  });

  it("log replay of a channel_ingest event does not touch the graph", () => {
    const db = new ExocortexDatabase({ path: ":memory:" });
    try {
      recordChannelIngest(db, doc("body"));
      const before = WorldModelHost.createIsolatedForTest().lifeGraph.entityCount;
      const host = WorldModelHost.createIsolatedForTest();
      host.replayEvents(db.listEvents(), db);
      assert.equal(host.lifeGraph.entityCount, before);
    } finally {
      db.close();
    }
  });
});
