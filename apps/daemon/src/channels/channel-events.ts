import { createHash, createHmac, randomUUID } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { ShadowRecorder } from "../shadow-recorder.js";
import { HOST_DEVICE_ID } from "../shadow-recorder.js";
import type { ChannelId } from "./types.js";

export type ChannelEventKind =
  | "channel.document.upserted"
  | "channel.entity.upserted"
  | "channel.link.upserted"
  | "channel.disconnected";

export type ChannelLinkRelation = "mentions" | "authored" | "member_of" | "links_to";
export type ChannelEventPayload = Record<string, string | number>;

export interface ChannelEvent {
  kind: ChannelEventKind;
  payload: ChannelEventPayload;
}

const FIELDS: Record<ChannelEventKind, readonly string[]> = {
  "channel.document.upserted": ["channel", "doc_key", "content_sha256", "ref", "observed_at"],
  "channel.entity.upserted": ["channel", "entity_type", "entity_key", "ref", "observed_at"],
  "channel.link.upserted": ["channel", "from_key", "to_key", "rel", "observed_at"],
  "channel.disconnected": ["channel", "observed_at"],
};

const CHANNELS: readonly ChannelId[] = ["gmail", "notion", "obsidian"];
const ENTITY_TYPES = ["person", "project"] as const;
const RELATIONS: readonly ChannelLinkRelation[] = ["mentions", "authored", "member_of", "links_to"];

export function validateChannelEventPayload(kind: ChannelEventKind, value: unknown): asserts value is ChannelEventPayload {
  if (!Object.hasOwn(FIELDS, kind) || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid channel event payload");
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.length !== FIELDS[kind].length || keys.some((key) => !FIELDS[kind].includes(key))) {
    throw new TypeError("invalid channel event payload fields");
  }
  for (const [key, item] of Object.entries(payload)) {
    if (typeof item === "string" && item.length > 128) throw new TypeError(`channel event ${key} exceeds 128 characters`);
    if (item !== null && typeof item === "object") throw new TypeError(`channel event ${key} must be scalar`);
  }
  if (typeof payload.channel !== "string" || !CHANNELS.includes(payload.channel as ChannelId)) throw new TypeError("invalid channel id");
  if (typeof payload.observed_at !== "number" || !Number.isFinite(payload.observed_at)) throw new TypeError("invalid observed_at");
  if (kind === "channel.document.upserted") {
    if (typeof payload.doc_key !== "string" || !/^[0-9a-f]{64}$/.test(payload.doc_key)) throw new TypeError("invalid doc_key");
    if (typeof payload.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(payload.content_sha256)) throw new TypeError("invalid content_sha256");
    if (typeof payload.ref !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.ref)) throw new TypeError("invalid vault ref");
  } else if (kind === "channel.entity.upserted") {
    if (typeof payload.entity_type !== "string" || !(ENTITY_TYPES as readonly string[]).includes(payload.entity_type)) throw new TypeError("invalid entity_type");
    if (typeof payload.entity_key !== "string" || !/^[0-9a-f]{64}$/.test(payload.entity_key)) throw new TypeError("invalid entity_key");
    if (typeof payload.ref !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.ref)) throw new TypeError("invalid vault ref");
  } else if (kind === "channel.link.upserted") {
    if (typeof payload.from_key !== "string" || !/^[0-9a-f]{64}$/.test(payload.from_key)) throw new TypeError("invalid from_key");
    if (typeof payload.to_key !== "string" || !/^[0-9a-f]{64}$/.test(payload.to_key)) throw new TypeError("invalid to_key");
    if (typeof payload.rel !== "string" || !RELATIONS.includes(payload.rel as ChannelLinkRelation)) throw new TypeError("invalid rel");
  }
}

function hmacKey(channelKey: Uint8Array, naturalId: string): string {
  if (channelKey.length !== 32) throw new TypeError("channel key must be 32 bytes");
  if (!naturalId || naturalId.length > 4096) throw new TypeError("invalid natural id");
  return createHmac("sha256", channelKey).update(naturalId, "utf8").digest("hex");
}

function event<K extends ChannelEventKind>(kind: K, payload: ChannelEventPayload): ChannelEvent {
  validateChannelEventPayload(kind, payload);
  return { kind, payload };
}

export function buildDocumentUpserted(input: {
  channel: ChannelId;
  channelKey: Uint8Array;
  naturalId: string;
  content: string | Uint8Array;
  ref?: string;
  observedAt?: number;
}): ChannelEvent {
  return event("channel.document.upserted", {
    channel: input.channel,
    doc_key: hmacKey(input.channelKey, input.naturalId),
    content_sha256: createHash("sha256").update(input.content).digest("hex"),
    ref: input.ref ?? randomUUID(),
    observed_at: input.observedAt ?? Date.now(),
  });
}

export function buildEntityUpserted(input: {
  channel: ChannelId;
  channelKey: Uint8Array;
  entityType: "person" | "project";
  naturalId: string;
  ref?: string;
  observedAt?: number;
}): ChannelEvent {
  const naturalId = input.entityType === "person" ? input.naturalId.toLowerCase() : input.naturalId;
  return event("channel.entity.upserted", {
    channel: input.channel,
    entity_type: input.entityType,
    entity_key: hmacKey(input.channelKey, naturalId),
    ref: input.ref ?? randomUUID(),
    observed_at: input.observedAt ?? Date.now(),
  });
}

export function buildLinkUpserted(input: {
  channel: ChannelId;
  fromKey: string;
  toKey: string;
  rel: ChannelLinkRelation;
  observedAt?: number;
}): ChannelEvent {
  return event("channel.link.upserted", {
    channel: input.channel,
    from_key: input.fromKey,
    to_key: input.toKey,
    rel: input.rel,
    observed_at: input.observedAt ?? Date.now(),
  });
}

export function buildChannelDisconnected(channel: ChannelId, observedAt = Date.now()): ChannelEvent {
  return event("channel.disconnected", { channel, observed_at: observedAt });
}

export function appendChannelEvent(db: ExocortexDatabase, channelEvent: ChannelEvent): boolean {
  validateChannelEventPayload(channelEvent.kind, channelEvent.payload);
  new ShadowRecorder(db, { shadow: true }).ensureHostDevice();
  const { status } = db.ingestEvent(HOST_DEVICE_ID, {
    event_id: `channel-event:${randomUUID()}`,
    kind: channelEvent.kind,
    ts_device: channelEvent.payload.observed_at as number,
    schema_ver: 1,
    payload: channelEvent.payload,
  });
  return status === "inserted";
}
