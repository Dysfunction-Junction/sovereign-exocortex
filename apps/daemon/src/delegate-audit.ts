/**
 * @file delegate-audit.ts
 * One metadata-only event per denied /network/delegate call, in the hash-chained event log.
 * Never the payload. Uses the existing free-text `kind` column (no schema change), like channel_ingest.
 * Payload keys avoid the graph linker keys (doc_id, hash, tags, persons) so replay stays inert.
 */

import { randomUUID } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";
import { TokenBucket } from "./token-bucket.js";

export const DELEGATE_DENIED_KIND = "delegate_denied";

export type DelegateDenialReason = "unmapped" | "scope" | "shadow" | "approval_action";

// The log is append-only, so a hostile or buggy client must not be able to fill it: 60 denial records per device per minute.
const auditBucket = new TokenBucket(60, 60 / 60_000);

const clip = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 80) : null);

/** Never throws into the request path. Returns true when an event was appended. */
export function recordDelegateDenial(
  db: ExocortexDatabase,
  info: { deviceId: string; to?: unknown; action?: unknown; reason: DelegateDenialReason },
  now: () => number = Date.now,
): boolean {
  try {
    if (!auditBucket.take(info.deviceId)) return false;
    new ShadowRecorder(db, { shadow: true }).ensureHostDevice();
    const ts = now();
    const { status } = db.ingestEvent(HOST_DEVICE_ID, {
      event_id: `delegate-denied:${ts}:${randomUUID()}`,
      kind: DELEGATE_DENIED_KIND,
      ts_device: ts,
      schema_ver: 1,
      payload: {
        denied_device: info.deviceId,
        delegate_to: clip(info.to),
        delegate_action: clip(info.action),
        reason: info.reason,
        ts,
      },
    });
    return status === "inserted";
  } catch (err) {
    console.error("[delegate] failed to record denial audit event:", err instanceof Error ? err.message : err);
    return false;
  }
}
