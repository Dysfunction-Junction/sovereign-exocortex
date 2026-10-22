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
});
