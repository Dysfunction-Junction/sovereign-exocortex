import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { ExocortexDatabase } from "@exocortex/core/db";
import {
  appendChannelEvent,
  buildChannelDisconnected,
  buildDocumentUpserted,
  buildEntityUpserted,
  buildLinkUpserted,
  validateChannelEventPayload,
} from "./channel-events.js";

test("channel events expose only hashes, keys, refs and fixed metadata, and append to the event chain", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const key = randomBytes(32);
    const document = buildDocumentUpserted({ channel: "gmail", channelKey: key, naturalId: "message-123", content: "PRIVATE BODY" });
    const entity = buildEntityUpserted({ channel: "gmail", channelKey: key, entityType: "person", naturalId: "Alice@Example.test" });
    const link = buildLinkUpserted({ channel: "gmail", fromKey: String(document.payload.doc_key), toKey: String(entity.payload.entity_key), rel: "mentions" });
    const disconnected = buildChannelDisconnected("gmail");
    assert.equal(document.payload.doc_key, createHmac("sha256", key).update("message-123").digest("hex"));
    assert.equal(document.payload.content_sha256, createHash("sha256").update("PRIVATE BODY").digest("hex"));
    assert.equal(entity.payload.entity_key, createHmac("sha256", key).update("alice@example.test").digest("hex"));
    for (const e of [document, entity, link, disconnected]) appendChannelEvent(db, e);

    const events = db.listEvents({});
    assert.deepEqual(events.map((e) => e.kind), [
      "channel.document.upserted", "channel.entity.upserted", "channel.link.upserted", "channel.disconnected",
    ]);
    const serialized = events.map((e) => String(e.payload)).join("\n");
    for (const secret of ["PRIVATE BODY", "message-123", "alice@example.test"]) assert.ok(!serialized.includes(secret));
    assert.equal(db.verifyEventChain().valid, true);
  } finally {
    db.close();
  }
});

test("channel event payload validation rejects extra personal fields, nested objects and oversized strings", () => {
  const valid = buildDocumentUpserted({ channel: "notion", channelKey: randomBytes(32), naturalId: "page-1", content: "body" }).payload;
  for (const field of ["title", "body", "email", "name"]) {
    assert.throws(() => validateChannelEventPayload("channel.document.upserted", { ...valid, [field]: "private" }));
  }
  assert.throws(() => validateChannelEventPayload("channel.document.upserted", { ...valid, nested: { body: "private" } }));
  assert.throws(() => validateChannelEventPayload("channel.document.upserted", { ...valid, doc_key: { value: "private" } }));
  assert.throws(() => validateChannelEventPayload("channel.document.upserted", { ...valid, channel: "x".repeat(129) }));
});
