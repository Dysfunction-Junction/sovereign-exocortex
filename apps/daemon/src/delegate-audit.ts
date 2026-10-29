/**
 * @file delegate-audit.ts
 * One metadata-only event per denied /network/delegate call, in the hash-chained event log.
 * Never the payload. Uses the existing free-text `kind` column (no schema change), like channel_ingest.
 * Payload keys avoid the graph linker keys (doc_id, hash, tags, persons) so replay stays inert.
 *
 * The log is append-only and cannot be purged, so nothing a client controls is stored verbatim: `to` and `action` are
 * logged only when they are names the delegate map knows; anything else (including a well-formed but unknown string,
 * such as a token pasted by mistake) is logged as null with `unrecognized: true`.
 */

import { randomUUID } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID, ShadowRecorder } from "./shadow-recorder.js";
import { TokenBucket } from "./token-bucket.js";
import { DELEGATE_MAP } from "./delegate-capabilities.js";

export const DELEGATE_DENIED_KIND = "delegate_denied";

export type DelegateDenialReason = "unmapped" | "scope" | "shadow" | "approval_action";

/** Per-device limiter: a small burst and a slow refill. Dropped denials are counted and reported in the next record. */
export class DenialLimiter {
  private readonly suppressed = new Map<string, number>();
  constructor(private readonly bucket: TokenBucket) {}

  /** Returns null when over the limit (and counts it), else how many denials were suppressed since the last record. */
  admit(deviceId: string): number | null {
    if (!this.bucket.take(deviceId)) {
      this.suppressed.set(deviceId, (this.suppressed.get(deviceId) ?? 0) + 1);
      return null;
    }
    const n = this.suppressed.get(deviceId) ?? 0;
    this.suppressed.delete(deviceId);
    return n;
  }
}

// Burst of 10, then one record per minute per device (at most 1,440 a day).
const defaultLimiter = new DenialLimiter(new TokenBucket(10, 1 / 60_000));

const knownNode = (v: unknown): string | null =>
  typeof v === "string" && (v === "hermes-api" || Object.prototype.hasOwnProperty.call(DELEGATE_MAP, v)) ? v : null;
// Two kinds of action are resolved outside the static table: every hermes-api action (names are client-chosen, so never
// stored, but not "unrecognized" either) and pieces-for-all `memory` (payload-dependent).
const knownAction = (node: string | null, v: unknown): string | null => {
  if (node === null || typeof v !== "string") return null;
  if (node === "pieces-for-all" && v === "memory") return v;
  return Object.prototype.hasOwnProperty.call(DELEGATE_MAP[node] ?? {}, v) ? v : null;
};

/** Never throws into the request path. Returns true when an event was appended. */
export function recordDelegateDenial(
  db: ExocortexDatabase,
  info: { deviceId: string; to?: unknown; action?: unknown; reason: DelegateDenialReason },
  now: () => number = Date.now,
  limiter: DenialLimiter = defaultLimiter,
): boolean {
  try {
    const suppressed = limiter.admit(info.deviceId);
    if (suppressed === null) return false;
    new ShadowRecorder(db, { shadow: true }).ensureHostDevice();
    const ts = now();
    const to = knownNode(info.to);
    const action = knownAction(to, info.action);
    const unrecognized = (info.to !== undefined && to === null) || (info.action !== undefined && action === null && to !== "hermes-api");
    const { status } = db.ingestEvent(HOST_DEVICE_ID, {
      event_id: `delegate-denied:${ts}:${randomUUID()}`,
      kind: DELEGATE_DENIED_KIND,
      ts_device: ts,
      schema_ver: 1,
      payload: {
        denied_device: info.deviceId,
        delegate_to: to,
        delegate_action: action,
        reason: info.reason,
        ts,
        ...(unrecognized ? { unrecognized: true } : {}),
        ...(suppressed > 0 ? { suppressed_before: suppressed } : {}),
      },
    });
    return status === "inserted";
  } catch (err) {
    console.error("[delegate] failed to record denial audit event:", err instanceof Error ? err.message : err);
    return false;
  }
}
