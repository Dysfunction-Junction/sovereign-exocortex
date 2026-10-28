process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { WorldModelHost } from "./world-model-host.js";
import { ChannelVault } from "./channels/channel-vault.js";
import { ChannelManager } from "./channels/channel-manager.js";
import { resyncChannels } from "./channel-resync-cli.js";
import type { ChannelAdapter, ChannelStatus, SyncResult } from "./channels/types.js";

class MockAdapter implements ChannelAdapter {
  readonly id = "gmail" as const;
  readonly name = "Gmail";
  private onDoc?: (doc: any) => void;
  private onEnt?: (ent: any) => void;

  async getStatus(): Promise<ChannelStatus> {
    return {
      id: "gmail",
      name: "Gmail",
      description: "Mock Gmail Adapter",
      status: "connected",
      itemCount: 1,
      airGapped: false,
    };
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async configure(): Promise<void> {}
  setAirGap(): void {}
  dispose(): void {}

  onDocumentIngested(handler: (doc: any) => void): void {
    this.onDoc = handler;
  }

  onEntityIngested(handler: (ent: any) => void): void {
    this.onEnt = handler;
  }

  async sync(): Promise<SyncResult> {
    this.onEnt?.({
      id: "alice@example.com",
      type: "PERSON",
      name: "Alice Smith",
      channelId: "gmail",
      untrusted: false,
    });
    return { channelId: "gmail", itemsSynced: 1, durationMs: 5 };
  }
}

test("resyncChannels re-reads adapters and replaces legacy person:<email> graph IDs with keyed IDs", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const keyDir = mkdtempSync(join(tmpdir(), "resync-keys-"));
  try {
    const vault = new ChannelVault(db, { keyDir });
    const host = WorldModelHost.createIsolatedForTest();
    host.setVault(vault);

    // Seed legacy person:<email> entity and doc edge in lifeGraph
    host.lifeGraph.addEntity({
      id: "person:alice@example.com",
      type: "PERSON",
      name: "Alice Smith",
    });
    host.lifeGraph.addEntity({
      id: "doc:doc_101",
      type: "DOC",
      name: "Important Project Spec",
    });
    host.lifeGraph.addEdge("person:alice@example.com", "doc:doc_101", "WORKS_ON", 1.0);

    const beforeCount = host.lifeGraph.entityCount;
    // 15 baseline ecosystem entities + 2 seeded = 17
    assert.equal(beforeCount, 17);
    assert.ok(host.lifeGraph.getEntity("person:alice@example.com"));

    // Set up ChannelManager with MockAdapter
    const manager = new ChannelManager({ db, vault });
    const mockAdapter = new MockAdapter();
    (manager as any).adapters.set("gmail", mockAdapter);
    mockAdapter.onDocumentIngested((doc) => (manager as any).handleDocumentIngested(doc));
    mockAdapter.onEntityIngested((ent) => (manager as any).handleEntityIngested(ent));

    const result = await resyncChannels({ manager, host, db });

    assert.equal(result.beforeCount, beforeCount);
    assert.equal(result.afterCount, beforeCount, "before and after entity count must match");
    assert.deepEqual(result.replacedLegacyIds, ["person:alice@example.com"]);

    // Legacy entity removed
    assert.equal(host.lifeGraph.getEntity("person:alice@example.com"), undefined);

    // Keyed entity exists
    const allEntities = host.lifeGraph.snapshot().entities;
    const keyedPerson = allEntities.find((e) => e.type === "PERSON" && e.name === "Alice Smith");
    assert.ok(keyedPerson);
    assert.ok(!keyedPerson.id.includes("@"), "keyed person ID must not contain email");

    // Edge rewired to the new keyed entity
    const edges = host.lifeGraph.snapshot().edges;
    assert.ok(edges.some((edge) => edge.sourceId === keyedPerson.id && edge.targetId === "doc:doc_101"));
  } finally {
    db.close();
    rmSync(keyDir, { recursive: true, force: true });
  }
});
