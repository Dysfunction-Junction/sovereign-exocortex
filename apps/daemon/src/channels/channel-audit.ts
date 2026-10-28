/**
 * @file channel-audit.ts
 * Metadata-only audit trail for channel ingestion in the hash-chained event log.
 * Bodies and contact addresses are never logged: the log is append-only, so purge/disconnect
 * could not erase them. Graph nodes are rebuilt by re-syncing, not by replaying these events.
 */

import { createHash } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID, ShadowRecorder } from "../shadow-recorder.js";
import type { IngestedDocument, IngestedEntity } from "./types.js";

export const CHANNEL_INGEST_KIND = "channel_ingest";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Payload keys avoid the graph linker's (doc_id, hash, tags, persons) so replay stays inert. */
function auditFor(item: IngestedDocument | IngestedEntity): { eventId: string; payload: Record<string, unknown> } {
  if ("body" in item) {
    const contentHash = sha256(item.body);
    return {
      eventId: `channel:${item.channelId}:${sha256(item.id).slice(0, 16)}:${contentHash.slice(0, 16)}`,
      payload: {
        channel: item.channelId,
        item_kind: "document",
        source_id_sha256: sha256(item.id),
        content_sha256: contentHash,
        untrusted: item.untrusted,
      },
    };
  }
  // Entities (e.g. Gmail senders) carry PII in their ids: log only digests.
  const idDigest = sha256(item.id);
  const attrDigest = sha256(JSON.stringify([item.type, item.name, item.properties ?? {}]));
  return {
    eventId: `channel:${item.channelId}:${idDigest.slice(0, 16)}:${attrDigest.slice(0, 16)}`,
    payload: {
      channel: item.channelId,
      item_kind: "entity",
      entity_type: item.type,
      source_id_sha256: idDigest,
      content_sha256: attrDigest,
      untrusted: item.untrusted,
    },
  };
}

/** Append an ingestion record. Idempotent per (item, content); never throws into the ingest path. */
export function recordChannelIngest(db: ExocortexDatabase, item: IngestedDocument | IngestedEntity): boolean {
  try {
    new ShadowRecorder(db, { shadow: true }).ensureHostDevice();
    const { eventId, payload } = auditFor(item);
    const { status } = db.ingestEvent(HOST_DEVICE_ID, {
      event_id: eventId,
      kind: CHANNEL_INGEST_KIND,
      ts_device: Date.now(),
      schema_ver: 1,
      payload,
    });
    return status === "inserted";
  } catch (err) {
    console.error("[channels] failed to record ingest audit event:", err instanceof Error ? err.message : err);
    return false;
  }
}
