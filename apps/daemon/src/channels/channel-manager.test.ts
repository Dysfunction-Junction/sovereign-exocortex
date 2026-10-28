import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelManager } from "./channel-manager.js";
import { getDefaultVaultPath } from "./obsidian-adapter.js";
import { WorldModelHost } from "../world-model-host.js";
import { AirGapPolicy, AirGapViolationError } from "./air-gap.js";

describe("channel-manager and air-gap", () => {
  let manager: ChannelManager;

  beforeEach(() => {
    AirGapPolicy.setAirGapActive(false);
    manager = new ChannelManager({ obsidianVaultPath: getDefaultVaultPath() });
  });

  it("lists all 3 channels (obsidian, notion, gmail)", async () => {
    const channels = await manager.getChannels();
    assert.equal(channels.length, 3);
    const ids = channels.map((c) => c.id);
    assert.ok(ids.includes("obsidian"));
    assert.ok(ids.includes("notion"));
    assert.ok(ids.includes("gmail"));
  });

  it("guarantees obsidian is always airGapped: true", async () => {
    const obsidian = await manager.getChannel("obsidian");
    assert.equal(obsidian?.airGapped, true);
  });

  it("enforces air-gap policy and throws AirGapViolationError when active", () => {
    AirGapPolicy.setAirGapActive(true);
    assert.throws(
      () => {
        AirGapPolicy.assertOutboundAllowed("api.notion.com");
      },
      AirGapViolationError
    );

    assert.throws(
      () => {
        AirGapPolicy.assertOutboundAllowed("googleapis.com");
      },
      AirGapViolationError
    );
  });

  it("allows outbound network requests when air-gap is disabled", () => {
    AirGapPolicy.setAirGapActive(false);
    assert.doesNotThrow(() => {
      AirGapPolicy.assertOutboundAllowed("api.notion.com");
    });
  });

  it("toggles air-gap mode across all channels in manager", async () => {
    manager.setAirGapMode(true);
    assert.equal(manager.isAirGapActive(), true);
    const channels = await manager.getChannels();
    for (const c of channels) {
      assert.equal(c.airGapped, true);
    }
  });

  it("purgeChannel removes entities with each adapter's real id prefix", () => {
    const host = WorldModelHost.createIsolatedForTest();
    manager.attachToWorldModel(host);
    const ids: Record<string, string> = {
      gmail: "gmail:thread:t1",
      notion: "notion:page1",
      obsidian: "doc:obsidian:a.md",
    };
    for (const [channel, id] of Object.entries(ids)) {
      host.lifeGraph.addEntity({ id, type: "DOC", name: id, properties: { channelId: channel } });
    }
    for (const channel of ["gmail", "notion", "obsidian"] as const) {
      assert.equal(manager.purgeChannel(channel), 1, channel);
      assert.equal(host.lifeGraph.getEntity(ids[channel]), undefined, channel);
    }
  });

  it("disconnectChannel('gmail') leaves 0 Gmail-created entities including tagged person nodes", async () => {
    const host = WorldModelHost.createIsolatedForTest();
    manager.attachToWorldModel(host);

    // Operator and non-Gmail contacts must survive
    host.lifeGraph.addEntity({
      id: "person_operator",
      type: "PERSON",
      name: "Operator",
      activation: 1.0,
      lastActive: Date.now(),
    });
    host.lifeGraph.addEntity({
      id: "person:other@example.com",
      type: "PERSON",
      name: "Other Contact",
      properties: { sourceChannel: "manual" },
      activation: 1.0,
      lastActive: Date.now(),
    });

    // Ingest Gmail entities: a tagged person entity and a thread document
    host.lifeGraph.addEntity({
      id: "person:sender@example.com",
      type: "PERSON",
      name: "Sender",
      properties: {
        email: "sender@example.com",
        sourceChannel: "gmail",
      },
      activation: 1.0,
      lastActive: Date.now(),
    });
    host.lifeGraph.addEntity({
      id: "gmail:thread:th123",
      type: "DOC",
      name: "Quarterly Review",
      properties: { from: "sender@example.com", sourceChannel: "gmail" },
      activation: 1.0,
      lastActive: Date.now(),
    });

    assert.ok(host.lifeGraph.getEntity("person:sender@example.com"));
    assert.ok(host.lifeGraph.getEntity("gmail:thread:th123"));
    assert.ok(host.lifeGraph.getEntity("person_operator"));
    assert.ok(host.lifeGraph.getEntity("person:other@example.com"));

    // Disconnect Gmail channel
    await manager.disconnectChannel("gmail");

    // All Gmail-created entities must be purged
    assert.equal(host.lifeGraph.getEntity("person:sender@example.com"), undefined);
    assert.equal(host.lifeGraph.getEntity("gmail:thread:th123"), undefined);

    const gmailCreated = host.lifeGraph.snapshot().entities.filter((e) => {
      const p = e.properties || {};
      return e.id.startsWith("gmail:") || p.sourceChannel === "gmail" || p.channelId === "gmail";
    });
    assert.equal(gmailCreated.length, 0);

    // Unrelated persons are preserved
    assert.ok(host.lifeGraph.getEntity("person_operator"));
    assert.ok(host.lifeGraph.getEntity("person:other@example.com"));
  });
});
