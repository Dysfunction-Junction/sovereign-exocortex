import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelManager } from "./channel-manager.js";
import { AirGapPolicy, AirGapViolationError } from "./air-gap.js";

describe("channel-manager and air-gap", () => {
  let manager: ChannelManager;

  beforeEach(() => {
    AirGapPolicy.setAirGapActive(false);
    manager = new ChannelManager({ obsidianVaultPath: "C:\\Users\\micha\\Vault" });
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
});
