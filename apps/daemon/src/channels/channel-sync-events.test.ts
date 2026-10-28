import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExocortexDatabase } from "@exocortex/core/db";
import { ChannelVault } from "./channel-vault.js";
import { ChannelManager } from "./channel-manager.js";
import type { IngestedDocument, IngestedEntity } from "./types.js";

test("adapter sync emits channel events with zero plaintext in event payloads (spec R6 / row 1.2)", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const keyDir = mkdtempSync(join(tmpdir(), "exocortex-channel-keys-"));
  const vault = new ChannelVault(db, { keyDir });
  const manager = new ChannelManager({ db, vault });

  try {
    const secretDocTitle = "Confidential Strategic Blueprint 2027";
    const secretDocBody = "Top secret quarterly plan for project Apollo with unreleased financials.";
    const secretDocPath = "vault/confidential/blueprint.md";
    const secretWikilink = "Project Apollo Roadmap";

    const secretPersonName = "Dr. Jane Doe";
    const secretEmail = "jane.doe.confidential@dysfunctionjunction.com";

    const docFixture: IngestedDocument = {
      id: "doc:obsidian:blueprint.md",
      channelId: "obsidian",
      title: secretDocTitle,
      body: secretDocBody,
      sourcePath: secretDocPath,
      tags: ["strategy", "confidential"],
      wikilinks: [secretWikilink],
      metadata: {},
      createdAt: 1728000000,
      updatedAt: 1728000500,
      untrusted: false,
    };

    const entityFixture: IngestedEntity = {
      id: "person:jane.doe.confidential@dysfunctionjunction.com",
      channelId: "gmail",
      name: secretPersonName,
      type: "PERSON",
      properties: {
        email: secretEmail,
        department: "R&D",
      },
      untrusted: true,
    };

    // Simulate adapter ingestion dispatch
    (manager as any).handleDocumentIngested(docFixture);
    (manager as any).handleEntityIngested(entityFixture);

    const events = db.listEvents();
    assert.ok(events.length >= 3, `must have at least 3 events, got ${events.length}`);

    const docUpserted = events.find((e) => e.kind === "channel.document.upserted");
    const linkUpserted = events.find((e) => e.kind === "channel.link.upserted");
    const entityUpserted = events.find((e) => e.kind === "channel.entity.upserted");

    assert.ok(docUpserted, "must emit channel.document.upserted event");
    assert.ok(linkUpserted, "must emit channel.link.upserted event");
    assert.ok(entityUpserted, "must emit channel.entity.upserted event");

    // CRITICAL SECURITY ASSERTION:
    // Assert zero plaintext appears in ANY event's payload JSON
    const secrets = [
      secretDocTitle,
      secretDocBody,
      secretDocPath,
      secretWikilink,
      secretPersonName,
      secretEmail,
    ];

    for (const event of events) {
      const rawPayload = JSON.stringify(event.payload);
      for (const secret of secrets) {
        assert.ok(
          !rawPayload.includes(secret),
          `event ${event.seq} (${event.kind}) payload must not contain plaintext '${secret}': ${rawPayload}`
        );
      }
    }

    // Assert human-readable content was safely vaulted and accessible by ref
    const docPayload = JSON.parse(docUpserted.payload as string);
    const entityPayload = JSON.parse(entityUpserted.payload as string);

    const vaultedDoc = vault.get(docPayload.ref);
    assert.ok(vaultedDoc, "vault must retrieve document by ref");
    assert.equal(vaultedDoc.title, secretDocTitle);
    assert.equal(vaultedDoc.body, secretDocBody);
    assert.equal(vaultedDoc.url, secretDocPath);

    const vaultedEntity = vault.get(entityPayload.ref);
    assert.ok(vaultedEntity, "vault must retrieve entity by ref");
    assert.equal(vaultedEntity.display_name, secretPersonName);
    assert.equal(vaultedEntity.email, secretEmail);

    // Verify hash chain of event log is unbroken
    assert.equal(db.verifyEventChain().valid, true);

    // Disconnect: vault.purgeChannel(channel) and then append channel.disconnected
    await manager.disconnectChannel("gmail");

    // Assert vault content for disconnected channel is purged
    assert.equal(vault.get(entityPayload.ref), null, "vault must return null after channel disconnect/purge");

    // Assert channel.disconnected event was appended
    const updatedEvents = db.listEvents();
    const disconnectEvent = updatedEvents.find((e) => e.kind === "channel.disconnected");
    assert.ok(disconnectEvent, "must emit channel.disconnected event on disconnect");
    const disconnectPayload = JSON.parse(disconnectEvent.payload as string);
    assert.equal(disconnectPayload.channel, "gmail");

    // Assert hash chain remains valid after disconnect event
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    manager.dispose();
    db.close();
    try {
      rmSync(keyDir, { recursive: true, force: true });
    } catch {
      // Cleanup
    }
  }
});
