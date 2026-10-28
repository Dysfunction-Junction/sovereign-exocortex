process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { WorldModelHost } from "./world-model-host.js";
import { ChannelVault } from "./channels/channel-vault.js";
import {
  buildDocumentUpserted,
  buildEntityUpserted,
  buildLinkUpserted,
  buildChannelDisconnected,
} from "./channels/channel-events.js";

test("replay from seq 0 yields identical graph and belief projections to live ingest", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    db.registerDevice({
      device_id: "dev_replay_node",
      name: "dev_replay_node",
      platform: "linux",
      pubkey_spki: new Uint8Array([1, 2, 3]),
      key_attested: 0,
      scopes: ["telemetry:write", "admin:write"],
      enrolled_at: Date.now(),
      revoked_at: null,
    });

    const keyDir = join(tmpdir(), `replay-keys-${Date.now()}`);
    const vault = new ChannelVault(db, { keyDir });
    const host = WorldModelHost.createIsolatedForTest();
    host.setVault(vault);

    const now = Date.now();
    const gmailKey = Buffer.alloc(32, 1);
    const notionKey = Buffer.alloc(32, 2);
    const obsidianKey = Buffer.alloc(32, 3);

    // 1. Vault human-readable channel contents
    const gmailDocRef = vault.put("gmail", {
      title: "Quarterly Strategy Review",
      body: "Discussion notes on roadmap and deliverables",
      email: "lead@dysfunctionjunction.com",
    });
    const gmailPersonRef = vault.put("gmail", {
      display_name: "Strategic Leader",
      email: "lead@dysfunctionjunction.com",
    });
    const notionDocRef = vault.put("notion", {
      title: "Architecture Specification",
      body: "System diagrams and edge routing",
      url: "https://notion.so/spec",
    });
    const notionProjectRef = vault.put("notion", {
      display_name: "Exocortex Alpha",
    });
    const obsidianDocRef = vault.put("obsidian", {
      title: "Ephemeral Notes",
      body: "Draft content before disconnect",
    });

    // 2. Build channel events matching spec R5/R6
    const gmailDocEvent = buildDocumentUpserted({
      channel: "gmail",
      channelKey: gmailKey,
      naturalId: "msg_101",
      content: "Discussion notes on roadmap and deliverables",
      ref: gmailDocRef,
      observedAt: now,
    });

    const gmailEntityEvent = buildEntityUpserted({
      channel: "gmail",
      channelKey: gmailKey,
      entityType: "person",
      naturalId: "lead@dysfunctionjunction.com",
      ref: gmailPersonRef,
      observedAt: now + 1,
    });

    const notionDocEvent = buildDocumentUpserted({
      channel: "notion",
      channelKey: notionKey,
      naturalId: "page_202",
      content: "System diagrams and edge routing",
      ref: notionDocRef,
      observedAt: now + 2,
    });

    const notionEntityEvent = buildEntityUpserted({
      channel: "notion",
      channelKey: notionKey,
      entityType: "project",
      naturalId: "project_alpha",
      ref: notionProjectRef,
      observedAt: now + 3,
    });

    const authoredLinkEvent = buildLinkUpserted({
      channel: "gmail",
      fromKey: gmailEntityEvent.payload.entity_key as string,
      toKey: gmailDocEvent.payload.doc_key as string,
      rel: "authored",
      observedAt: now + 4,
    });

    const memberOfLinkEvent = buildLinkUpserted({
      channel: "notion",
      fromKey: gmailEntityEvent.payload.entity_key as string,
      toKey: notionEntityEvent.payload.entity_key as string,
      rel: "member_of",
      observedAt: now + 5,
    });

    const referencesLinkEvent = buildLinkUpserted({
      channel: "notion",
      fromKey: notionDocEvent.payload.doc_key as string,
      toKey: gmailDocEvent.payload.doc_key as string,
      rel: "links_to",
      observedAt: now + 6,
    });

    const obsidianDocEvent = buildDocumentUpserted({
      channel: "obsidian",
      channelKey: obsidianKey,
      naturalId: "notes/ephemeral.md",
      content: "Draft content before disconnect",
      ref: obsidianDocRef,
      observedAt: now + 7,
    });

    const obsidianDisconnectEvent = buildChannelDisconnected("obsidian");

    // 3. Assemble mixed fixture: telemetry + observation + vibration + all channel event kinds
    const mixedBatch = db.ingestBatch({
      device_id: "dev_replay_node",
      events: [
        {
          event_id: "ev_tel_1",
          kind: "telemetry",
          schema_ver: 1,
          ts_device: now,
          payload: { app: "com.android.chrome", foreground: "Chrome" },
        },
        {
          event_id: "ev_obs_1",
          kind: "observation",
          schema_ver: 1,
          ts_device: now + 1,
          payload: { factor: "repo_health", observation: "tests_pass" },
        },
        {
          event_id: "ev_vibe_1",
          kind: "vibration",
          schema_ver: 1,
          ts_device: now + 2,
          payload: { event: "VIBRATION" },
        },
        {
          event_id: "ev_wake_1",
          kind: "wake",
          schema_ver: 1,
          ts_device: now + 3,
          payload: { latency_ms: 650 },
        },
        {
          event_id: "ev_chan_doc_gmail",
          kind: "channel.document.upserted",
          schema_ver: 1,
          ts_device: now + 4,
          payload: gmailDocEvent.payload,
        },
        {
          event_id: "ev_chan_ent_gmail",
          kind: "channel.entity.upserted",
          schema_ver: 1,
          ts_device: now + 5,
          payload: gmailEntityEvent.payload,
        },
        {
          event_id: "ev_chan_doc_notion",
          kind: "channel.document.upserted",
          schema_ver: 1,
          ts_device: now + 6,
          payload: notionDocEvent.payload,
        },
        {
          event_id: "ev_chan_ent_notion",
          kind: "channel.entity.upserted",
          schema_ver: 1,
          ts_device: now + 7,
          payload: notionEntityEvent.payload,
        },
        {
          event_id: "ev_chan_link_authored",
          kind: "channel.link.upserted",
          schema_ver: 1,
          ts_device: now + 8,
          payload: authoredLinkEvent.payload,
        },
        {
          event_id: "ev_chan_link_member",
          kind: "channel.link.upserted",
          schema_ver: 1,
          ts_device: now + 9,
          payload: memberOfLinkEvent.payload,
        },
        {
          event_id: "ev_chan_link_ref",
          kind: "channel.link.upserted",
          schema_ver: 1,
          ts_device: now + 10,
          payload: referencesLinkEvent.payload,
        },
        {
          event_id: "ev_chan_doc_obsidian",
          kind: "channel.document.upserted",
          schema_ver: 1,
          ts_device: now + 11,
          payload: obsidianDocEvent.payload,
        },
        {
          event_id: "ev_chan_disc_obsidian",
          kind: "channel.disconnected",
          schema_ver: 1,
          ts_device: now + 12,
          payload: obsidianDisconnectEvent.payload,
        },
      ],
    });

    // 4. Live ingest pass into live host
    host.onEventsAppended(mixedBatch.events, db);

    // Snapshot graph and beliefs from live run
    const liveSnapshot = host.lifeGraph.snapshot();
    const liveEntities = liveSnapshot.entities
      .map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const liveEdges = liveSnapshot.edges
      .map((e) => ({
        from: e.sourceId,
        to: e.targetId,
        relation: e.relation,
      }))
      .sort((a, b) => `${a.from}->${a.to}:${a.relation}`.localeCompare(`${b.from}->${b.to}:${b.relation}`));

    const liveBelief = db.getLatestBeliefSnapshot();

    assert.ok(liveEntities.length > 0, "live run must produce graph entities");
    assert.ok(liveEdges.length > 0, "live run must produce graph edges");

    // Verify disconnected channel was purged
    const obsidianEntitiesLive = liveEntities.filter((e) => e.id.includes("obsidian"));
    assert.equal(obsidianEntitiesLive.length, 0, "live graph must not retain disconnected channel entities");

    // 5. Wipe projections by creating a fresh isolated host
    const replayHost = WorldModelHost.createIsolatedForTest();
    replayHost.setVault(vault);
    // Verified baseline ecosystem entities exist
    assert.equal(replayHost.lifeGraph.entityCount, 15, "wiped replay host starts with 15 baseline ecosystem entities");

    // 6. Replay from seq 0
    const allReplayEvents = db.listEvents({});
    assert.equal(allReplayEvents.length, mixedBatch.events.length);
    replayHost.onEventsAppended(allReplayEvents, db);

    // 7. Assert snapshots are strictly equal
    const replayedSnapshot = replayHost.lifeGraph.snapshot();
    const replayedEntities = replayedSnapshot.entities
      .map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const replayedEdges = replayedSnapshot.edges
      .map((e) => ({
        from: e.sourceId,
        to: e.targetId,
        relation: e.relation,
      }))
      .sort((a, b) => `${a.from}->${a.to}:${a.relation}`.localeCompare(`${b.from}->${b.to}:${b.relation}`));

    const replayedBelief = db.getLatestBeliefSnapshot();

    assert.deepEqual(replayedEntities, liveEntities, "replayed entities must match live entities");
    assert.deepEqual(replayedEdges, liveEdges, "replayed edges must match live edges");

    if (liveBelief) {
      assert.ok(replayedBelief, "replayed belief snapshot must exist");
      assert.equal(replayedBelief.mode, liveBelief.mode);
      assert.equal(replayedBelief.as_of_seq, liveBelief.as_of_seq);
    }
  } finally {
    db.close();
  }
});
