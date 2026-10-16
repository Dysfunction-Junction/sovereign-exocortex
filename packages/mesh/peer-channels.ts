import { execFileSync } from "node:child_process";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SDKCustomTool,
  SDKJsonValue,
} from "@cursor/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { agentMeshHmac } from "./coordination-auth.js";
import {
  getGitBinary,
  redactSecrets,
  stateDirectory,
} from "./security.js";
import type {
  TrafficAgentRecord,
} from "./traffic-control.js";
import { PROVIDERS } from "./types.js";
import type { Origin, Provider } from "./types.js";

export const PEER_MESSAGE_KINDS = [
  "notice",
  "request",
  "response",
  "status_delta",
  "checkpoint",
  "dependency_ready",
  "handoff",
  "blocker",
  "blocker_resolved",
  "finding",
  "decision",
  "lease_request",
  "lease_grant",
  "lease_release",
] as const;
export type PeerMessageKind = (typeof PEER_MESSAGE_KINDS)[number];

export const PEER_RECEIPT_KINDS = [
  "status_delta",
  "checkpoint",
  "dependency_ready",
  "handoff",
  "blocker",
  "finding",
  "decision",
] as const;
export type PeerReceiptKind = (typeof PEER_RECEIPT_KINDS)[number];

export const PEER_FRICTION_KINDS = [
  "direction_conflict",
  "direction_ack_slow",
  "stale_write_mismatch",
  "gate_failure",
  "finding_reopened",
  "model_fallback",
  "fallback_exhausted",
  "blocking_question",
  "idle_wait",
  "lease_contention",
  "writer_collision",
  "retry",
  "cancellation",
] as const;
export type PeerFrictionKind = (typeof PEER_FRICTION_KINDS)[number];

export const PEER_FRICTION_SEVERITIES = ["low", "medium", "high"] as const;
export type PeerFrictionSeverity = (typeof PEER_FRICTION_SEVERITIES)[number];

export type PeerWakePolicy = "off" | "coordination";
export type PeerChannelKind = "repository" | "bridge";

export interface PeerChannelRecord {
  id: string;
  origin: Origin;
  kind: PeerChannelKind;
  label: string;
  status: "open" | "closed";
  sourceRepoKey: string;
  destinationRepoKey: string | null;
  bidirectional: boolean;
  wakePolicy: PeerWakePolicy;
  policyVersion: number;
  policyDigest: string | null;
  messageLimit: number;
  byteLimit: number;
  messageCount: number;
  byteCount: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PeerMemberRecord {
  id: string;
  origin: Origin;
  channelId: string;
  agentId: string;
  repoKey: string;
  generation: number;
  status: "active" | "revoked";
  role: string | null;
  assignment: unknown;
  ownership: string[];
  acceptanceCriteria: string[];
  taskId: string | null;
  runId: string | null;
  sessionId: string | null;
  observedGitHead: string | null;
  joinedAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface ManagedPeerBinding {
  origin: Origin;
  agentId: string;
  memberId: string;
  membershipGeneration: number;
  taskId?: string;
  runId?: string;
  causalRoot?: string;
  causalPath?: string[];
}

export interface PeerMessageRecord {
  id: string;
  channelId: string;
  sequence: number;
  senderMemberId: string;
  senderGeneration: number;
  recipientMemberId: string;
  kind: PeerMessageKind;
  body: string | null;
  payload: unknown;
  bodyDigest: string;
  bodyBytes: number;
  replyTo: string | null;
  causalRoot: string;
  causalParent: string | null;
  causalPath: string[];
  hopCount: number;
  clientMessageId: string;
  requestDigest: string;
  sourceMessageId: string | null;
  envelopeHash: string;
  createdAt: string;
}

export interface PeerDeliveryRecord {
  id: string;
  origin: Origin;
  messageId: string;
  channelId: string;
  recipientMemberId: string;
  sequence: number;
  cursor: number;
  state:
    | "pending"
    | "leased"
    | "handed_off"
    | "acknowledged"
    | "rejected"
    | "dead_letter";
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  reason: string | null;
}

export interface PeerReceiptRecord {
  id: string;
  channelId: string;
  memberId: string;
  kind: PeerReceiptKind;
  key: string;
  version: number;
  payload: unknown;
  observed: unknown;
  status: "active" | "resolved" | "superseded";
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PeerResourcePolicy {
  channelId: string;
  name: string;
  maximumTtlMs: number;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface PeerResourceLease {
  id: string;
  channelId: string;
  resourceName: string;
  holderMemberId: string;
  generation: number;
  status: "active" | "released" | "expired";
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export interface PeerWakeJob {
  id: string;
  origin: Origin;
  channelId: string;
  recipientMemberId: string;
  recipientAgentId: string;
  firstSequence: number;
  lastSequence: number;
  messageCount: number;
  causalRoot: string;
  causalPath: string[];
  state:
    | "pending"
    | "leased"
    | "started"
    | "completed"
    | "failed"
    | "ambiguous"
    | "suppressed";
  policyVersion: number;
  availableAt: string;
  leaseOwner: string | null;
  controllerGeneration: number | null;
  leaseExpiresAt: string | null;
  externalRef: string | null;
  attempts: number;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PeerAuditEvent {
  sequence: number;
  origin: Origin;
  entityType: string;
  entityId: string;
  event: string;
  data: unknown;
  previousHash: string | null;
  hash: string;
  createdAt: string;
}

export interface PeerFrictionEvent {
  id: string;
  origin: Origin;
  repoKey: string;
  occurredAt: string;
  kind: PeerFrictionKind;
  provider: Provider | null;
  model: string | null;
  agentId: string | null;
  reference: string | null;
  skillTier: number | null;
  severity: PeerFrictionSeverity;
  detail: string;
  dedupeKey: string;
  createdAt: string;
}

export interface PeerFrictionInput {
  repoKey: string;
  kind: PeerFrictionKind;
  detail: string;
  dedupeKey: string;
  severity?: PeerFrictionSeverity;
  provider?: Provider;
  model?: string;
  agentId?: string;
  reference?: string;
  skillTier?: number;
  occurredAt?: string;
}

export interface PeerFrictionFilter {
  repoKey?: string;
  kind?: PeerFrictionKind;
  provider?: Provider;
  severity?: PeerFrictionSeverity;
  since?: string;
  until?: string;
}

export interface PeerFrictionSummary {
  total: number;
  byKind: Array<{ kind: PeerFrictionKind; count: number }>;
  byProvider: Array<{ provider: Provider | null; count: number }>;
}

export type PeerDirectionDisposition = "active" | "withdrawn";
export type PeerDirectionProvenance = "hook_prompt" | "controller";
export type PeerDirectionTargetState =
  | "pending"
  | "acknowledged"
  | "superseded";
export type PeerDirectionImpact =
  | "applies"
  | "no-impact"
  | "conflict-needs-clarity";

export interface PeerDirectionRecord {
  id: string;
  origin: Origin;
  repoKey: string;
  currentRevision: number;
  disposition: PeerDirectionDisposition;
  directionHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface PeerDirectionRevisionRecord {
  id: string;
  directionId: string;
  revision: number;
  sequence: number;
  title: string;
  body: string;
  summary: string;
  affectedPaths: string[];
  provenance: PeerDirectionProvenance;
  conversationId: string | null;
  previousHash: string | null;
  revisionHash: string;
  idempotencyKey: string;
  controllerInstanceId: string | null;
  controllerGeneration: number | null;
  createdAt: string;
}

export interface PeerDirectionTargetRecord {
  id: string;
  directionId: string;
  revision: number;
  agentId: string;
  memberId: string | null;
  memberGeneration: number | null;
  state: PeerDirectionTargetState;
  impact: PeerDirectionImpact | null;
  note: string | null;
  observedGitHead: string | null;
  ackHash: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  updatedAt: string;
}

export interface PeerDirectionOutboxEntry {
  direction: PeerDirectionRecord;
  revision: PeerDirectionRevisionRecord;
  targets: PeerDirectionTargetRecord[];
}

export type PeerDirectionPublication = PeerDirectionOutboxEntry;

export interface PeerApplicableDirection {
  direction: PeerDirectionRecord;
  revision: PeerDirectionRevisionRecord;
  target: PeerDirectionTargetRecord;
}

export interface PeerContextSnapshot {
  member: PeerMemberRecord;
  channels: PeerChannelRecord[];
  deliveries: Array<{
    delivery: PeerDeliveryRecord;
    message: PeerMessageRecord;
  }>;
  receipts: PeerReceiptRecord[];
  leases: PeerResourceLease[];
  directions: PeerApplicableDirection[];
  nextSequence: number;
}

export interface BridgeAllowlistEntry {
  sourceRepoKey: string;
  destinationRepoKey: string;
}

export interface PeerAdminFence {
  ownerInstanceId: string;
  generation: number;
}

interface PeerRegistryOptions {
  origin: Origin;
  path?: string;
  now?: () => Date;
  agentResolver: (agentId: string) => TrafficAgentRecord | undefined;
  bridgeAllowlist?: readonly BridgeAllowlistEntry[];
  bindingValidator?: (member: PeerMemberRecord) => boolean;
  trafficPath?: string;
}

type PeerFenceInput = PeerAdminFence | (() => void);

interface Row {
  [key: string]: unknown;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const RESOURCE_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;
const MAX_SAME_REPO_BODY_BYTES = 16 * 1024;
const MAX_BRIDGE_BODY_BYTES = 8 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_MEMBERS_PER_CHANNEL = 32;
const MAX_PENDING_PER_MEMBER = 256;
const DEFAULT_REPO_MESSAGE_LIMIT = 1_000;
const DEFAULT_REPO_BYTE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_BRIDGE_MESSAGE_LIMIT = 100;
const DEFAULT_BRIDGE_BYTE_LIMIT = 1024 * 1024;
const SENDS_PER_MEMBER_PER_MINUTE = 10;
const SENDS_PER_CHANNEL_PER_MINUTE = 60;
const DEFAULT_WAKE_DEBOUNCE_MS = 30_000;
const MAX_CAUSAL_HOPS = 4;
const WAKE_TARGET_HOURLY = 3;
const WAKE_TARGET_DAILY = 12;
const WAKE_CHANNEL_HOURLY = 6;
const WAKE_CHANNEL_DAILY = 24;
const WAKE_LEASE_MS = 60_000;
const MAX_DIRECTION_BODY_BYTES = 1024 * 1024;
const MAX_DIRECTION_SUMMARY_BYTES = 16 * 1024;
const MAX_DIRECTION_PATHS = 256;
const MAX_DIRECTION_PATH_BYTES = 2_000;
const MAX_DIRECTION_NOTE_BYTES = 4_000;
const MAX_FRICTION_DETAIL_CHARS = 2_000;
const MAX_FRICTION_DETAIL_BYTES = 8 * 1024;
const MAX_FRICTION_SKILL_TIER = 4;

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function safeJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(text(value)) as T;
  } catch {
    return fallback;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported JSON value: ${typeof value}`);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function boundedText(
  value: string,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new RangeError(`${name} must contain 1-${maximumBytes} UTF-8 bytes.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} contains control characters.`);
  }
  return normalized;
}

function safeId(value: string, name: string): string {
  const normalized = boundedText(value, name, 512);
  if (!ID_PATTERN.test(normalized)) throw new Error(`Invalid ${name}.`);
  return normalized;
}

function safeResource(value: string): string {
  const normalized = boundedText(value, "resource name", 128);
  if (!RESOURCE_PATTERN.test(normalized)) {
    throw new Error("Resource name must be a lowercase stable identifier.");
  }
  return normalized;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function bridgePairKey(left: string, right: string): string {
  return [left, right].sort().join("\0");
}

function frictionInstant(value: string, name: string): string {
  const parsed = Date.parse(boundedText(value, name, 64));
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an instant.`);
  return new Date(parsed).toISOString();
}

function frictionFilterClause(filter: PeerFrictionFilter): {
  clause: string;
  parameters: string[];
} {
  const parameters: string[] = [];
  let clause = "";
  if (filter.repoKey) {
    clause += " AND repo_key = ?";
    parameters.push(safeId(filter.repoKey, "repoKey"));
  }
  if (filter.kind) {
    if (!PEER_FRICTION_KINDS.includes(filter.kind)) {
      throw new Error("Unsupported friction kind.");
    }
    clause += " AND kind = ?";
    parameters.push(filter.kind);
  }
  if (filter.provider) {
    if (!PROVIDERS.includes(filter.provider)) {
      throw new Error("Unsupported friction provider.");
    }
    clause += " AND provider = ?";
    parameters.push(filter.provider);
  }
  if (filter.severity) {
    if (!PEER_FRICTION_SEVERITIES.includes(filter.severity)) {
      throw new Error("Unsupported friction severity.");
    }
    clause += " AND severity = ?";
    parameters.push(filter.severity);
  }
  if (filter.since) {
    clause += " AND occurred_at >= ?";
    parameters.push(frictionInstant(filter.since, "since"));
  }
  if (filter.until) {
    clause += " AND occurred_at <= ?";
    parameters.push(frictionInstant(filter.until, "until"));
  }
  return { clause, parameters };
}

function parseChannel(row: Row): PeerChannelRecord {
  return {
    id: text(row.id),
    origin: text(row.origin) as Origin,
    kind: text(row.kind) as PeerChannelKind,
    label: text(row.label),
    status: text(row.status) as PeerChannelRecord["status"],
    sourceRepoKey: text(row.source_repo_key),
    destinationRepoKey: nullableText(row.destination_repo_key),
    bidirectional: bool(row.bidirectional),
    wakePolicy: text(row.wake_policy) as PeerWakePolicy,
    policyVersion: Number(row.policy_version),
    policyDigest: nullableText(row.policy_digest),
    messageLimit: Number(row.message_limit),
    byteLimit: Number(row.byte_limit),
    messageCount: Number(row.message_count),
    byteCount: Number(row.byte_count),
    expiresAt: nullableText(row.expires_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    closedAt: nullableText(row.closed_at),
  };
}

function parseMember(row: Row): PeerMemberRecord {
  return {
    id: text(row.id),
    origin: text(row.origin) as Origin,
    channelId: text(row.channel_id),
    agentId: text(row.agent_id),
    repoKey: text(row.repo_key),
    generation: Number(row.generation),
    status: text(row.status) as PeerMemberRecord["status"],
    role: nullableText(row.role),
    assignment: safeJson(row.assignment_json, null),
    ownership: safeJson<string[]>(row.ownership_json, []),
    acceptanceCriteria: safeJson<string[]>(row.acceptance_json, []),
    taskId: nullableText(row.task_id),
    runId: nullableText(row.run_id),
    sessionId: nullableText(row.session_id),
    observedGitHead: nullableText(row.observed_git_head),
    joinedAt: text(row.joined_at),
    updatedAt: text(row.updated_at),
    revokedAt: nullableText(row.revoked_at),
  };
}

function parseMessage(row: Row): PeerMessageRecord {
  return {
    id: text(row.id),
    channelId: text(row.channel_id),
    sequence: Number(row.sequence),
    senderMemberId: text(row.sender_member_id),
    senderGeneration: Number(row.sender_generation),
    recipientMemberId: text(row.recipient_member_id),
    kind: text(row.kind) as PeerMessageKind,
    body: nullableText(row.body),
    payload: safeJson(row.payload_json, null),
    bodyDigest: text(row.body_digest),
    bodyBytes: Number(row.body_bytes),
    replyTo: nullableText(row.reply_to),
    causalRoot: text(row.causal_root),
    causalParent: nullableText(row.causal_parent),
    causalPath: safeJson<string[]>(row.causal_path_json, []),
    hopCount: Number(row.hop_count),
    clientMessageId: text(row.client_message_id),
    requestDigest: text(row.request_digest),
    sourceMessageId: nullableText(row.source_message_id),
    envelopeHash: text(row.envelope_hash),
    createdAt: text(row.created_at),
  };
}

function parseDelivery(row: Row): PeerDeliveryRecord {
  return {
    id: text(row.id),
    origin: text(row.origin) as Origin,
    messageId: text(row.message_id),
    channelId: text(row.channel_id),
    recipientMemberId: text(row.recipient_member_id),
    sequence: Number(row.sequence),
    cursor: Number(row.cursor),
    state: text(row.state) as PeerDeliveryRecord["state"],
    leaseOwner: nullableText(row.lease_owner),
    leaseExpiresAt: nullableText(row.lease_expires_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    acknowledgedAt: nullableText(row.acknowledged_at),
    reason: nullableText(row.reason),
  };
}

function parseReceipt(row: Row): PeerReceiptRecord {
  return {
    id: text(row.id),
    channelId: text(row.channel_id),
    memberId: text(row.member_id),
    kind: text(row.kind) as PeerReceiptKind,
    key: text(row.receipt_key),
    version: Number(row.version),
    payload: safeJson(row.payload_json, null),
    observed: safeJson(row.observed_json, null),
    status: text(row.status) as PeerReceiptRecord["status"],
    messageId: nullableText(row.message_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function parseResourcePolicy(row: Row): PeerResourcePolicy {
  return {
    channelId: text(row.channel_id),
    name: text(row.resource_name),
    maximumTtlMs: Number(row.maximum_ttl_ms),
    description: text(row.description),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function parseResourceLease(row: Row): PeerResourceLease {
  return {
    id: text(row.id),
    channelId: text(row.channel_id),
    resourceName: text(row.resource_name),
    holderMemberId: text(row.holder_member_id),
    generation: Number(row.generation),
    status: text(row.status) as PeerResourceLease["status"],
    acquiredAt: text(row.acquired_at),
    updatedAt: text(row.updated_at),
    expiresAt: text(row.expires_at),
    releasedAt: nullableText(row.released_at),
  };
}

function parseWake(row: Row): PeerWakeJob {
  return {
    id: text(row.id),
    origin: text(row.origin) as Origin,
    channelId: text(row.channel_id),
    recipientMemberId: text(row.recipient_member_id),
    recipientAgentId: text(row.recipient_agent_id),
    firstSequence: Number(row.first_sequence),
    lastSequence: Number(row.last_sequence),
    messageCount: Number(row.message_count),
    causalRoot: text(row.causal_root),
    causalPath: safeJson<string[]>(row.causal_path_json, []),
    state: text(row.state) as PeerWakeJob["state"],
    policyVersion: Number(row.policy_version),
    availableAt: text(row.available_at),
    leaseOwner: nullableText(row.lease_owner),
    controllerGeneration:
      row.controller_generation === null || row.controller_generation === undefined
        ? null
        : Number(row.controller_generation),
    leaseExpiresAt: nullableText(row.lease_expires_at),
    externalRef: nullableText(row.external_ref),
    attempts: Number(row.attempts),
    reason: nullableText(row.reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    completedAt: nullableText(row.completed_at),
  };
}

function parseFrictionEvent(row: Row): PeerFrictionEvent {
  return {
    id: text(row.id),
    origin: text(row.origin) as Origin,
    repoKey: text(row.repo_key),
    occurredAt: text(row.occurred_at),
    kind: text(row.kind) as PeerFrictionKind,
    provider: nullableText(row.provider) as Provider | null,
    model: nullableText(row.model),
    agentId: nullableText(row.agent_id),
    reference: nullableText(row.reference),
    skillTier:
      row.skill_tier === null || row.skill_tier === undefined
        ? null
        : Number(row.skill_tier),
    severity: text(row.severity) as PeerFrictionSeverity,
    detail: text(row.detail),
    dedupeKey: text(row.dedupe_key),
    createdAt: text(row.created_at),
  };
}

function parseDirection(row: Row): PeerDirectionRecord {
  return {
    id: text(row.id),
    origin: text(row.origin) as Origin,
    repoKey: text(row.repo_key),
    currentRevision: Number(row.current_revision),
    disposition: text(row.disposition) as PeerDirectionDisposition,
    directionHash: text(row.direction_hash),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function parseDirectionRevision(row: Row): PeerDirectionRevisionRecord {
  return {
    id: text(row.id),
    directionId: text(row.direction_id),
    revision: Number(row.revision),
    sequence: Number(row.sequence),
    title: text(row.title),
    body: text(row.body),
    summary: text(row.summary),
    affectedPaths: safeJson<string[]>(row.affected_paths_json, []),
    provenance: text(row.provenance) as PeerDirectionProvenance,
    conversationId: nullableText(row.conversation_id),
    previousHash: nullableText(row.previous_hash),
    revisionHash: text(row.revision_hash),
    idempotencyKey: text(row.idempotency_key),
    controllerInstanceId: nullableText(row.controller_instance_id),
    controllerGeneration:
      row.controller_generation === null || row.controller_generation === undefined
        ? null
        : Number(row.controller_generation),
    createdAt: text(row.created_at),
  };
}

function parseDirectionTarget(row: Row): PeerDirectionTargetRecord {
  return {
    id: text(row.id),
    directionId: text(row.direction_id),
    revision: Number(row.revision),
    agentId: text(row.agent_id),
    memberId: nullableText(row.member_id),
    memberGeneration:
      row.member_generation === null || row.member_generation === undefined
        ? null
        : Number(row.member_generation),
    state: text(row.state) as PeerDirectionTargetState,
    impact: nullableText(row.impact) as PeerDirectionImpact | null,
    note: nullableText(row.note),
    observedGitHead: nullableText(row.observed_git_head),
    ackHash: nullableText(row.ack_hash),
    createdAt: text(row.created_at),
    acknowledgedAt: nullableText(row.acknowledged_at),
    updatedAt: text(row.updated_at),
  };
}

export class PeerChannelRegistry {
  readonly origin: Origin;
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly agentResolver: PeerRegistryOptions["agentResolver"];
  private readonly bridgeAllowlist: ReadonlySet<string>;
  private readonly bindingValidator?: PeerRegistryOptions["bindingValidator"];
  private readonly hasTrafficAttachment: boolean;
  private closed = false;

  constructor(options: PeerRegistryOptions) {
    this.origin = options.origin;
    this.path = options.path ?? resolve(stateDirectory(), "peer.db");
    this.now = options.now ?? (() => new Date());
    this.agentResolver = options.agentResolver;
    this.bridgeAllowlist = new Set(
      (options.bridgeAllowlist ?? []).map((entry) =>
        bridgePairKey(entry.sourceRepoKey, entry.destinationRepoKey),
      ),
    );
    this.bindingValidator = options.bindingValidator;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;",
    );
    this.hasTrafficAttachment = Boolean(options.trafficPath);
    if (options.trafficPath) {
      this.db
        .prepare("ATTACH DATABASE ? AS traffic_control")
        .run(resolve(options.trafficPath));
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peer_channels (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('repository', 'bridge')),
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        source_repo_key TEXT NOT NULL,
        destination_repo_key TEXT,
        bidirectional INTEGER NOT NULL CHECK (bidirectional IN (0, 1)),
        wake_policy TEXT NOT NULL CHECK (wake_policy IN ('off', 'coordination')),
        policy_version INTEGER NOT NULL,
        policy_digest TEXT,
        message_limit INTEGER NOT NULL,
        byte_limit INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        byte_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        channel_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_repo_channel
        ON peer_channels(origin, source_repo_key)
        WHERE kind = 'repository' AND status = 'open';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_open_bridge
        ON peer_channels(origin, source_repo_key, destination_repo_key)
        WHERE kind = 'bridge' AND status = 'open';
      CREATE TABLE IF NOT EXISTS peer_channel_counters (
        channel_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS peer_origin_counters (
        origin TEXT PRIMARY KEY,
        next_cursor INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS peer_schema_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS peer_members (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        repo_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        role TEXT,
        assignment_json TEXT NOT NULL DEFAULT 'null',
        ownership_json TEXT NOT NULL DEFAULT '[]',
        acceptance_json TEXT NOT NULL DEFAULT '[]',
        task_id TEXT,
        run_id TEXT,
        session_id TEXT,
        observed_git_head TEXT,
        membership_hash TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY(channel_id) REFERENCES peer_channels(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_active_member
        ON peer_members(channel_id, agent_id)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_peer_members_agent
        ON peer_members(origin, agent_id, status);

      CREATE TABLE IF NOT EXISTS peer_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        sender_member_id TEXT NOT NULL,
        sender_generation INTEGER NOT NULL,
        recipient_member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT,
        payload_json TEXT NOT NULL,
        body_digest TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        reply_to TEXT,
        causal_root TEXT NOT NULL,
        causal_parent TEXT,
        causal_path_json TEXT NOT NULL,
        hop_count INTEGER NOT NULL,
        client_message_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        source_message_id TEXT,
        envelope_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(channel_id, sequence),
        UNIQUE(sender_member_id, sender_generation, client_message_id),
        FOREIGN KEY(channel_id) REFERENCES peer_channels(id),
        FOREIGN KEY(sender_member_id) REFERENCES peer_members(id),
        FOREIGN KEY(recipient_member_id) REFERENCES peer_members(id)
      );
      CREATE INDEX IF NOT EXISTS idx_peer_messages_recipient
        ON peer_messages(channel_id, recipient_member_id, sequence);

      CREATE TABLE IF NOT EXISTS peer_deliveries (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        recipient_member_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        cursor INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'leased', 'handed_off', 'acknowledged', 'rejected', 'dead_letter')
        ),
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        reason TEXT,
        delivery_hash TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES peer_messages(id),
        FOREIGN KEY(recipient_member_id) REFERENCES peer_members(id)
      );
      CREATE TABLE IF NOT EXISTS peer_receipts (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        receipt_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        observed_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'resolved', 'superseded')),
        message_id TEXT,
        previous_receipt_hash TEXT,
        receipt_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, member_id, kind, receipt_key, version)
      );
      CREATE TABLE IF NOT EXISTS peer_receipt_heads (
        channel_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        receipt_key TEXT NOT NULL,
        current_receipt_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        head_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, member_id, kind, receipt_key)
      );

      CREATE TABLE IF NOT EXISTS peer_resource_policies (
        channel_id TEXT NOT NULL,
        resource_name TEXT NOT NULL,
        maximum_ttl_ms INTEGER NOT NULL,
        next_generation INTEGER NOT NULL DEFAULT 1,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, resource_name)
      );
      CREATE TABLE IF NOT EXISTS peer_resource_leases (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        resource_name TEXT NOT NULL,
        holder_member_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
        acquired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_resource_active
        ON peer_resource_leases(channel_id, resource_name)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS peer_wake_jobs (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        recipient_member_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        causal_root TEXT NOT NULL,
        causal_path_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'leased', 'started', 'completed', 'failed', 'ambiguous', 'suppressed')
        ),
        policy_version INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        controller_generation INTEGER,
        lease_expires_at TEXT,
        external_ref TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS peer_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        origin TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event TEXT NOT NULL,
        data_json TEXT NOT NULL,
        previous_hash TEXT,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_peer_audit_origin
        ON peer_audit_events(origin, sequence);
      CREATE TABLE IF NOT EXISTS peer_audit_state (
        origin TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL,
        last_hash TEXT,
        state_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateSchema();
    this.recoverExpired();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrateSchema(): void {
    const current = this.db
      .prepare(
        "SELECT version FROM peer_schema_meta WHERE singleton = 1",
      )
      .get() as Row | undefined;
    const currentVersion = current ? Number(current.version) : 0;
    if (currentVersion >= 7) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const wakeColumnsBefore = this.db
        .prepare("PRAGMA table_info(peer_wake_jobs)")
        .all() as Row[];
      const wakeHadCausalPath = wakeColumnsBefore.some(
        (column) => text(column.name) === "causal_path_json",
      );
      const addColumn = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const columns = this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all() as Row[];
        if (!columns.some((candidate) => text(candidate.name) === column)) {
          this.db.exec(
            `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
          );
        }
      };
      addColumn("peer_wake_jobs", "origin", "TEXT NOT NULL DEFAULT ''");
      addColumn(
        "peer_wake_jobs",
        "causal_path_json",
        "TEXT NOT NULL DEFAULT '[]'",
      );
      addColumn("peer_receipts", "previous_receipt_hash", "TEXT");
      addColumn(
        "peer_receipts",
        "receipt_hash",
        "TEXT NOT NULL DEFAULT ''",
      );
      addColumn(
        "peer_deliveries",
        "origin",
        "TEXT NOT NULL DEFAULT ''",
      );
      addColumn(
        "peer_deliveries",
        "cursor",
        "INTEGER NOT NULL DEFAULT 0",
      );
      addColumn(
        "peer_deliveries",
        "delivery_hash",
        "TEXT NOT NULL DEFAULT ''",
      );
      addColumn(
        "peer_resource_policies",
        "next_generation",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumn(
        "peer_members",
        "membership_hash",
        "TEXT NOT NULL DEFAULT ''",
      );
      addColumn(
        "peer_channels",
        "channel_hash",
        "TEXT NOT NULL DEFAULT ''",
      );
      this.db.exec("DROP INDEX IF EXISTS idx_peer_wake_pending");
      this.db.exec("DROP INDEX IF EXISTS idx_peer_delivery_inbox");
      this.db.exec("DROP INDEX IF EXISTS idx_peer_delivery_cursor");
      this.db.exec("DROP INDEX IF EXISTS idx_peer_receipt_active");
      this.db
        .prepare(
          `UPDATE peer_wake_jobs
           SET origin = COALESCE((
             SELECT origin FROM peer_channels
             WHERE peer_channels.id = peer_wake_jobs.channel_id
           ), origin)
           WHERE origin = ''`,
        )
        .run();
      if (!wakeHadCausalPath) {
        const now = this.now().toISOString();
        this.db
          .prepare(
            `UPDATE peer_wake_jobs
             SET state = 'suppressed',
                 reason = 'legacy_causal_context_missing',
                 completed_at = ?, updated_at = ?
             WHERE state IN ('pending', 'leased', 'started')`,
          )
          .run(now, now);
      }
      this.db
        .prepare(
          `UPDATE peer_deliveries
           SET origin = COALESCE((
             SELECT origin FROM peer_channels
             WHERE peer_channels.id = peer_deliveries.channel_id
           ), origin)
           WHERE origin = ''`,
        )
        .run();
      const deliveryRows = this.db
        .prepare(
          `SELECT * FROM peer_deliveries
           ORDER BY origin ASC, created_at ASC, rowid ASC`,
        )
        .all() as Row[];
      const cursors = new Map<string, number>();
      for (const row of deliveryRows) {
        const origin = text(row.origin);
        const storedCursor = Number(row.cursor);
        const cursor =
          storedCursor > 0
            ? storedCursor
            : (cursors.get(origin) ?? 0) + 1;
        cursors.set(
          origin,
          Math.max(cursors.get(origin) ?? 0, cursor),
        );
        if (text(row.delivery_hash) && storedCursor > 0 && origin) {
          continue;
        }
        const createdAt = text(row.created_at);
        const deliveryHash = agentMeshHmac(
          "peer-delivery-envelope",
          canonicalJson({
            id: text(row.id),
            origin,
            messageId: text(row.message_id),
            channelId: text(row.channel_id),
            recipientMemberId: text(row.recipient_member_id),
            sequence: Number(row.sequence),
            cursor,
            createdAt,
          }),
        );
        this.db
          .prepare(
            `UPDATE peer_deliveries
             SET cursor = ?, delivery_hash = ?
             WHERE id = ?`,
          )
          .run(cursor, deliveryHash, text(row.id));
      }
      for (const [origin, cursor] of cursors) {
        this.db
          .prepare(
            `INSERT INTO peer_origin_counters(origin, next_cursor)
             VALUES (?, ?)
             ON CONFLICT(origin) DO UPDATE SET
               next_cursor = MAX(next_cursor, excluded.next_cursor)`,
          )
          .run(origin, cursor + 1);
      }
      const deliveryIndexes = this.db
        .prepare("PRAGMA index_list(peer_deliveries)")
        .all() as Row[];
      const legacyCursorUnique = deliveryIndexes.some((index) => {
        if (Number(index.unique) !== 1) return false;
        const columns = this.db
          .prepare(`PRAGMA index_info(${text(index.name)})`)
          .all() as Row[];
        return (
          columns.length === 1 &&
          text(columns[0]?.name) === "cursor"
        );
      });
      if (legacyCursorUnique) {
        this.db.exec(`
          ALTER TABLE peer_deliveries RENAME TO peer_deliveries_legacy;
          CREATE TABLE peer_deliveries (
            id TEXT PRIMARY KEY,
            origin TEXT NOT NULL,
            message_id TEXT NOT NULL UNIQUE,
            channel_id TEXT NOT NULL,
            recipient_member_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            cursor INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (
              state IN ('pending', 'leased', 'handed_off', 'acknowledged', 'rejected', 'dead_letter')
            ),
            lease_owner TEXT,
            lease_expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            acknowledged_at TEXT,
            reason TEXT,
            delivery_hash TEXT NOT NULL,
            FOREIGN KEY(message_id) REFERENCES peer_messages(id),
            FOREIGN KEY(recipient_member_id) REFERENCES peer_members(id)
          );
          INSERT INTO peer_deliveries (
            id, origin, message_id, channel_id, recipient_member_id,
            sequence, cursor, state, lease_owner, lease_expires_at,
            created_at, updated_at, acknowledged_at, reason, delivery_hash
          )
          SELECT
            id, origin, message_id, channel_id, recipient_member_id,
            sequence, cursor, state, lease_owner, lease_expires_at,
            created_at, updated_at, acknowledged_at, reason, delivery_hash
          FROM peer_deliveries_legacy;
          DROP TABLE peer_deliveries_legacy;
        `);
      }
      const memberRows = this.db
        .prepare(
          "SELECT * FROM peer_members WHERE membership_hash = ''",
        )
        .all() as Row[];
      for (const row of memberRows) {
        const membershipHash = agentMeshHmac(
          "peer-membership",
          canonicalJson({
            id: text(row.id),
            origin: text(row.origin),
            channelId: text(row.channel_id),
            agentId: text(row.agent_id),
            repoKey: text(row.repo_key),
            joinedAt: text(row.joined_at),
          }),
        );
        this.db
          .prepare(
            "UPDATE peer_members SET membership_hash = ? WHERE id = ? AND membership_hash = ''",
          )
          .run(membershipHash, text(row.id));
      }
      const unsignedChannels = this.db
        .prepare(
          currentVersion < 5
            ? "SELECT * FROM peer_channels"
            : "SELECT * FROM peer_channels WHERE channel_hash = ''",
        )
        .all() as Row[];
      for (const row of unsignedChannels) {
        const channelHash = agentMeshHmac(
          "peer-channel",
          canonicalJson({
            id: text(row.id),
            origin: text(row.origin),
            kind: text(row.kind),
            label: text(row.label),
            sourceRepoKey: text(row.source_repo_key),
            destinationRepoKey: nullableText(row.destination_repo_key),
            bidirectional: bool(row.bidirectional),
            messageLimit: Number(row.message_limit),
            byteLimit: Number(row.byte_limit),
            createdAt: text(row.created_at),
          }),
        );
        this.db
          .prepare(
            `UPDATE peer_channels SET channel_hash = ? WHERE id = ?`,
          )
          .run(channelHash, text(row.id));
      }
      const channels = this.db
        .prepare("SELECT id FROM peer_channels")
        .all() as Row[];
      for (const channel of channels) {
        const channelId = text(channel.id);
        const maximum = this.db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
             FROM peer_messages WHERE channel_id = ?`,
          )
          .get(channelId) as Row;
        this.db
          .prepare(
            `INSERT INTO peer_channel_counters(channel_id, next_sequence)
             VALUES (?, ?)
             ON CONFLICT(channel_id) DO UPDATE SET
               next_sequence = MAX(next_sequence, excluded.next_sequence)`,
          )
          .run(channelId, Number(maximum.next));
      }
      const policies = this.db
        .prepare(
          "SELECT channel_id, resource_name FROM peer_resource_policies",
        )
        .all() as Row[];
      for (const policy of policies) {
        const maximum = this.db
          .prepare(
            `SELECT COALESCE(MAX(generation), 0) + 1 AS next
             FROM peer_resource_leases
             WHERE channel_id = ? AND resource_name = ?`,
          )
          .get(
            text(policy.channel_id),
            text(policy.resource_name),
          ) as Row;
        this.db
          .prepare(
            `UPDATE peer_resource_policies
             SET next_generation = MAX(next_generation, ?)
             WHERE channel_id = ? AND resource_name = ?`,
          )
          .run(
            Number(maximum.next),
            text(policy.channel_id),
            text(policy.resource_name),
          );
      }
      const receiptRows = this.db
        .prepare(
          `SELECT * FROM peer_receipts
           ORDER BY channel_id, member_id, kind, receipt_key, version`,
        )
        .all() as Row[];
      const receiptHeads = new Map<string, {
        id: string;
        version: number;
        hash: string;
        updatedAt: string;
        channelId: string;
        memberId: string;
        kind: string;
        key: string;
      }>();
      for (const row of receiptRows) {
        const key = [
          text(row.channel_id),
          text(row.member_id),
          text(row.kind),
          text(row.receipt_key),
        ].join("\0");
        const previous = receiptHeads.get(key)?.hash ?? null;
        const storedReceiptHash = text(row.receipt_hash);
        const storedPrevious = nullableText(row.previous_receipt_hash);
        const previousForHash =
          storedReceiptHash && storedPrevious !== null
            ? storedPrevious
            : previous;
        const receiptHash =
          storedReceiptHash ||
          agentMeshHmac(
            "peer-receipt-envelope",
            canonicalJson({
              id: text(row.id),
              channelId: text(row.channel_id),
              memberId: text(row.member_id),
              kind: text(row.kind),
              key: text(row.receipt_key),
              version: Number(row.version),
              previousReceiptHash: previousForHash,
              payloadDigest: agentMeshHmac(
                "peer-receipt",
                text(row.payload_json),
              ),
              observedDigest: agentMeshHmac(
                "peer-observed",
                text(row.observed_json),
              ),
              status: text(row.status),
              createdAt: text(row.created_at),
            }),
          );
        const headHash = agentMeshHmac(
          "peer-receipt-head",
          `${previousForHash ?? ""}\0${receiptHash}`,
        );
        if (!storedReceiptHash) {
          this.db
            .prepare(
              `UPDATE peer_receipts
               SET previous_receipt_hash = ?, receipt_hash = ?
               WHERE id = ? AND receipt_hash = ''`,
            )
            .run(previousForHash, receiptHash, text(row.id));
        } else if (storedPrevious === null && previous !== null) {
          this.db
            .prepare(
              `UPDATE peer_receipts
               SET previous_receipt_hash = ?
               WHERE id = ? AND previous_receipt_hash IS NULL`,
            )
            .run(previous, text(row.id));
        }
        receiptHeads.set(key, {
          id: text(row.id),
          version: Number(row.version),
          hash: headHash,
          updatedAt: text(row.updated_at),
          channelId: text(row.channel_id),
          memberId: text(row.member_id),
          kind: text(row.kind),
          key: text(row.receipt_key),
        });
      }
      for (const head of receiptHeads.values()) {
        this.db
          .prepare(
            `INSERT INTO peer_receipt_heads
             (channel_id, member_id, kind, receipt_key, current_receipt_id,
              version, head_hash, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(channel_id, member_id, kind, receipt_key) DO NOTHING`,
          )
          .run(
            head.channelId,
            head.memberId,
            head.kind,
            head.key,
            head.id,
            head.version,
            head.hash,
            head.updatedAt,
          );
      }
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_peer_delivery_inbox
         ON peer_deliveries(origin, recipient_member_id, cursor, state)`,
      );
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_delivery_cursor
         ON peer_deliveries(origin, cursor)`,
      );
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_wake_pending
         ON peer_wake_jobs(origin, channel_id, recipient_member_id, causal_root)
         WHERE state = 'pending'`,
      );
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS peer_directions (
          id TEXT PRIMARY KEY,
          origin TEXT NOT NULL,
          repo_key TEXT NOT NULL,
          current_revision INTEGER NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('active', 'withdrawn')),
          direction_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_peer_directions_repo
          ON peer_directions(origin, repo_key, disposition, updated_at);
        CREATE TABLE IF NOT EXISTS peer_direction_revisions (
          id TEXT PRIMARY KEY,
          direction_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          summary TEXT NOT NULL,
          affected_paths_json TEXT NOT NULL,
          provenance TEXT NOT NULL CHECK (provenance IN ('hook_prompt', 'controller')),
          conversation_id TEXT,
          previous_hash TEXT,
          revision_hash TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          controller_instance_id TEXT,
          controller_generation INTEGER,
          created_at TEXT NOT NULL,
          UNIQUE(direction_id, revision),
          UNIQUE(direction_id, idempotency_key),
          FOREIGN KEY(direction_id) REFERENCES peer_directions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_peer_direction_revisions_sequence
          ON peer_direction_revisions(sequence, direction_id, revision);
        CREATE TABLE IF NOT EXISTS peer_direction_targets (
          id TEXT PRIMARY KEY,
          direction_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          member_id TEXT,
          member_generation INTEGER,
          state TEXT NOT NULL CHECK (
            state IN ('pending', 'acknowledged', 'superseded')
          ),
          impact TEXT CHECK (
            impact IS NULL OR impact IN (
              'applies', 'no-impact', 'conflict-needs-clarity'
            )
          ),
          note TEXT,
          observed_git_head TEXT,
          ack_hash TEXT,
          created_at TEXT NOT NULL,
          acknowledged_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(direction_id, revision, agent_id),
          FOREIGN KEY(direction_id, revision)
            REFERENCES peer_direction_revisions(direction_id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_peer_direction_targets_agent
          ON peer_direction_targets(agent_id, state, direction_id, revision);
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS peer_friction_events (
          id TEXT PRIMARY KEY,
          origin TEXT NOT NULL,
          repo_key TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (
            kind IN (${PEER_FRICTION_KINDS.map((kind) => `'${kind}'`).join(", ")})
          ),
          provider TEXT,
          model TEXT,
          agent_id TEXT,
          reference TEXT,
          skill_tier INTEGER CHECK (
            skill_tier IS NULL OR skill_tier BETWEEN 1 AND ${MAX_FRICTION_SKILL_TIER}
          ),
          severity TEXT NOT NULL CHECK (
            severity IN (${PEER_FRICTION_SEVERITIES.map((severity) => `'${severity}'`).join(", ")})
          ),
          detail TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(origin, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS idx_peer_friction_window
          ON peer_friction_events(origin, occurred_at, kind);
        CREATE INDEX IF NOT EXISTS idx_peer_friction_repo
          ON peer_friction_events(origin, repo_key, kind, provider, severity);
      `);
      const auditOrigins = this.db
        .prepare(
          "SELECT DISTINCT origin FROM peer_audit_events",
        )
        .all() as Row[];
      for (const auditOrigin of auditOrigins) {
        const auditOriginValue = text(auditOrigin.origin);
        const latest = this.db
          .prepare(
            `SELECT sequence, hash, created_at FROM peer_audit_events
             WHERE origin = ? ORDER BY sequence DESC LIMIT 1`,
          )
          .get(auditOriginValue) as Row | undefined;
        const sequence = latest ? Number(latest.sequence) : 0;
        const hash = latest ? text(latest.hash) : null;
        const updatedAt = latest
          ? text(latest.created_at)
          : this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO peer_audit_state
             (origin, last_sequence, last_hash, state_hash, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(origin) DO NOTHING`,
          )
          .run(
            auditOriginValue,
            sequence,
            hash,
            agentMeshHmac(
              "peer-audit-state",
              canonicalJson({
                origin: auditOriginValue,
                lastSequence: sequence,
                lastHash: hash,
                updatedAt,
              }),
            ),
            updatedAt,
          );
      }
      this.db
        .prepare(
          `INSERT INTO peer_schema_meta(singleton, version, updated_at)
           VALUES (1, 7, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             version = excluded.version, updated_at = excluded.updated_at`,
        )
        .run(this.now().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureAgentEnrollment(input: {
    agentId: string;
    taskId?: string;
    runId?: string;
    sessionId?: string;
    role?: string;
    assignment?: unknown;
    ownership?: string[];
    acceptanceCriteria?: string[];
    observedGitHead?: string;
  }): PeerMemberRecord {
    const agent = this.requireEligibleAgent(input.agentId);
    this.revokeMismatchedMemberships(agent);
    const channel = this.ensureRepositoryChannel(agent.repoKey!, agent.repoLabel ?? "repository");
    return this.ensureMembership(channel.id, agent, input);
  }

  bindMemberSession(input: {
    agentId: string;
    taskId?: string;
    runId?: string;
    sessionId?: string;
    rotateGeneration?: boolean;
  }): PeerMemberRecord[] {
    const agentId = safeId(input.agentId, "agentId");
    const rows = this.db
      .prepare(
        `SELECT * FROM peer_members
         WHERE origin = ? AND agent_id = ? AND status = 'active'`,
      )
      .all(this.origin, agentId) as Row[];
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const member = parseMember(row);
        const taskId = input.taskId ?? member.taskId;
        const runId = input.runId ?? member.runId;
        const sessionId = input.sessionId ?? member.sessionId;
        if (
          taskId === member.taskId &&
          runId === member.runId &&
          sessionId === member.sessionId
        ) {
          this.backfillDirectionTargetsInternal(member, now);
          continue;
        }
        const changed = this.db
          .prepare(
            `UPDATE peer_members
             SET task_id = ?, run_id = ?, session_id = ?,
                 generation = generation + ?, updated_at = ?
             WHERE id = ? AND status = 'active' AND generation = ?`,
          )
          .run(
            taskId,
            runId,
            sessionId,
            input.rotateGeneration === false ? 0 : 1,
            now,
            member.id,
            member.generation,
          );
        if (changed.changes !== 1) {
          throw new Error("Peer execution binding changed concurrently.");
        }
        this.backfillDirectionTargetsInternal(
          this.requireMember(member.id),
          now,
        );
        this.appendAuditInternal({
          entityType: "member",
          entityId: member.id,
          event: "execution_binding_changed",
          data: {
            priorGeneration: member.generation,
            rotated: input.rotateGeneration !== false,
            taskId,
            runId,
            sessionId,
          },
          createdAt: now,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.map((row) => this.requireMember(text(row.id)));
  }

  settleTaskBinding(taskId: string): void {
    this.settleBinding("task_id", safeId(taskId, "taskId"));
  }

  settleRunBinding(runId: string): void {
    this.settleBinding("run_id", safeId(runId, "runId"));
  }

  bindingForAgent(input: {
    agentId: string;
    taskId?: string;
    runId?: string;
  }): ManagedPeerBinding {
    const memberships = this.memberBindings(input.agentId);
    const binding = memberships.find((candidate) => {
      if (input.taskId && candidate.taskId !== input.taskId) return false;
      if (input.runId && candidate.runId !== input.runId) return false;
      const member = this.requireMember(candidate.memberId);
      return this.getChannel(member.channelId).kind === "repository";
    });
    if (!binding) throw new Error("Managed agent has no active repository peer binding.");
    return binding;
  }

  configureMember(input: {
    memberId: string;
    role?: string;
    assignment?: unknown;
    ownership?: string[];
    acceptanceCriteria?: string[];
    observedGitHead?: string;
  }, fence?: PeerFenceInput): PeerMemberRecord {
    const member = this.requireMember(input.memberId);
    const role = input.role
      ? boundedText(input.role, "role", 160)
      : member.role;
    const ownership = input.ownership ?? member.ownership;
    const acceptance = input.acceptanceCriteria ?? member.acceptanceCriteria;
    if (ownership.length > 256 || acceptance.length > 256) {
      throw new RangeError("Ownership and acceptance lists are bounded to 256 entries.");
    }
    const assignmentJson = canonicalJson(input.assignment ?? member.assignment);
    const ownershipJson = canonicalJson(
      ownership.map((item) => boundedText(item, "ownership path", 2_000)),
    );
    const acceptanceJson = canonicalJson(
      acceptance.map((item) => boundedText(item, "acceptance criterion", 4_000)),
    );
    for (const value of [assignmentJson, ownershipJson, acceptanceJson]) {
      if (Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new RangeError("Member coordination metadata exceeds the size bound.");
      }
      if (redactSecrets(value) !== value) {
        throw new Error(
          "Member coordination metadata may contain a secret and was not accepted.",
        );
      }
    }
    if (
      input.observedGitHead &&
      !/^[0-9a-f]{40,64}$/i.test(input.observedGitHead)
    ) {
      throw new Error("observedGitHead must be a commit hash.");
    }
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAdminFence(fence);
      this.db
        .prepare(
          `UPDATE peer_members
           SET role = ?, assignment_json = ?, ownership_json = ?,
               acceptance_json = ?, observed_git_head = COALESCE(?, observed_git_head),
               updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'active'`,
        )
        .run(
          role,
          assignmentJson,
          ownershipJson,
          acceptanceJson,
          input.observedGitHead ?? null,
          now,
          member.id,
          this.origin,
        );
      this.appendAuditInternal({
        entityType: "member",
        entityId: member.id,
        event: "configured",
        data: {
          role,
          assignmentDigest: digest(safeJson(assignmentJson, null)),
          ownershipCount: ownership.length,
          acceptanceCount: acceptance.length,
        },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.requireMember(member.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeMember(memberId: string, fence?: PeerFenceInput): PeerMemberRecord {
    const member = this.requireMember(memberId);
    if (member.status === "revoked") return member;
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAdminFence(fence);
      const changed = this.db
        .prepare(
          `UPDATE peer_members
           SET status = 'revoked', generation = generation + 1,
               revoked_at = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'active'`,
        )
        .run(now, now, member.id, this.origin);
      if (changed.changes !== 1) throw new Error("Peer membership changed before revocation.");
      this.db
        .prepare(
          `UPDATE peer_deliveries SET state = 'dead_letter', reason = ?,
             updated_at = ?
           WHERE recipient_member_id = ?
             AND state IN ('pending', 'leased', 'handed_off')`,
        )
        .run("membership_revoked", now, member.id);
      this.db
        .prepare(
          `UPDATE peer_resource_leases
           SET status = 'expired', released_at = ?, updated_at = ?
           WHERE holder_member_id = ? AND status = 'active'`,
        )
        .run(now, now, member.id);
      this.appendAuditInternal({
        entityType: "member",
        entityId: member.id,
        event: "revoked",
        data: { priorGeneration: member.generation },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.requireMember(member.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listChannels(agentId?: string): PeerChannelRecord[] {
    this.recoverExpired();
    if (!agentId) {
      return (
        this.db
          .prepare(
            "SELECT * FROM peer_channels WHERE origin = ? ORDER BY updated_at DESC",
          )
          .all(this.origin) as Row[]
      ).map((row) => this.getChannel(text(row.id)));
    }
    return (
      this.db
        .prepare(
          `SELECT channels.*
           FROM peer_channels channels
           JOIN peer_members members ON members.channel_id = channels.id
           WHERE channels.origin = ? AND members.agent_id = ?
             AND members.status = 'active'
           ORDER BY channels.updated_at DESC`,
        )
        .all(this.origin, safeId(agentId, "agentId")) as Row[]
    ).map((row) => this.getChannel(text(row.id)));
  }

  getChannel(channelId: string): PeerChannelRecord {
    const row = this.db
      .prepare("SELECT * FROM peer_channels WHERE id = ? AND origin = ?")
      .get(safeId(channelId, "channelId"), this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown peer channel: ${channelId}`);
    const channel = parseChannel(row);
    const expected = agentMeshHmac(
      "peer-channel",
      canonicalJson({
        id: channel.id,
        origin: channel.origin,
        kind: channel.kind,
        label: channel.label,
        sourceRepoKey: channel.sourceRepoKey,
        destinationRepoKey: channel.destinationRepoKey,
        bidirectional: channel.bidirectional,
        messageLimit: channel.messageLimit,
        byteLimit: channel.byteLimit,
        createdAt: channel.createdAt,
      }),
    );
    if (expected !== text(row.channel_hash)) {
      throw new Error(`Peer channel ${channel.id} failed verification.`);
    }
    return channel;
  }

  listMembers(channelId: string): PeerMemberRecord[] {
    this.getChannel(channelId);
    return (
      this.db
        .prepare(
          `SELECT * FROM peer_members
           WHERE channel_id = ? AND origin = ? ORDER BY joined_at ASC`,
        )
        .all(channelId, this.origin) as Row[]
    ).map((row) => this.requireMember(text(row.id)));
  }

  memberBindings(agentId: string): ManagedPeerBinding[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM peer_members
           WHERE origin = ? AND agent_id = ? AND status = 'active'`,
        )
        .all(this.origin, safeId(agentId, "agentId")) as Row[]
    ).map((row) => {
      const member = this.requireMember(text(row.id));
      return {
        origin: this.origin,
        agentId: member.agentId,
        memberId: member.id,
        membershipGeneration: member.generation,
        ...(member.taskId ? { taskId: member.taskId } : {}),
        ...(member.runId ? { runId: member.runId } : {}),
      };
    });
  }

  assertBinding(binding: ManagedPeerBinding): PeerMemberRecord {
    if (binding.origin !== this.origin) throw new Error("Peer binding belongs to another origin.");
    const member = this.requireMember(binding.memberId);
    if (
      member.status !== "active" ||
      member.agentId !== binding.agentId ||
      member.generation !== binding.membershipGeneration ||
      (binding.taskId !== undefined && member.taskId !== binding.taskId) ||
      (binding.runId !== undefined && member.runId !== binding.runId)
    ) {
      throw new Error("Peer binding is stale or belongs to another managed agent.");
    }
    const agent = this.requireEligibleAgent(member.agentId);
    if (agent.repoKey !== member.repoKey) {
      throw new Error("Managed agent repository binding changed.");
    }
    this.requireOpenChannel(member.channelId);
    if (this.bindingValidator && !this.bindingValidator(member)) {
      throw new Error("Peer execution binding is no longer active.");
    }
    return member;
  }

  send(input: {
    binding: ManagedPeerBinding;
    recipientMemberId: string;
    kind: PeerMessageKind;
    body?: string;
    payload?: unknown;
    replyTo?: string;
    clientMessageId: string;
    ackDeliveryId?: string;
  }): { message: PeerMessageRecord; delivery: PeerDeliveryRecord } {
    this.recoverExpired();
    if (!PEER_MESSAGE_KINDS.includes(input.kind)) throw new Error("Unsupported peer message kind.");
    const boundMember = this.assertBinding(input.binding);
    let recipient = this.requireMember(input.recipientMemberId);
    if (recipient.status !== "active") {
      throw new Error("Recipient is not an active peer member.");
    }
    let sender =
      recipient.channelId === boundMember.channelId
        ? boundMember
        : this.memberForAgentChannel(
            boundMember.agentId,
            recipient.channelId,
          );
    if (recipient.id === sender.id) throw new Error("Peer messages require another recipient.");
    let channel = this.requireOpenChannel(sender.channelId);
    this.assertDirection(channel, sender, recipient);
    const body = input.body ? boundedText(
      input.body,
      "message body",
      channel.kind === "bridge" ? MAX_BRIDGE_BODY_BYTES : MAX_SAME_REPO_BODY_BYTES,
    ) : null;
    if (body && redactSecrets(body) !== body) {
      throw new Error("Peer message may contain a secret and was not accepted.");
    }
    const payloadJson = canonicalJson(input.payload ?? null);
    if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new RangeError("Peer message payload exceeds the size bound.");
    }
    if (redactSecrets(payloadJson) !== payloadJson) {
      throw new Error("Peer message payload may contain a secret and was not accepted.");
    }
    const clientMessageId = safeId(input.clientMessageId, "clientMessageId");
    if (redactSecrets(clientMessageId) !== clientMessageId) {
      throw new Error("clientMessageId may contain a secret.");
    }
    const replyTo = input.replyTo ? safeId(input.replyTo, "replyTo") : null;
    const messageId = randomUUID();
    let parent = replyTo ? this.requireMessage(replyTo) : undefined;
    if (
      parent &&
      (parent.channelId !== channel.id ||
        parent.recipientMemberId !== sender.id ||
        parent.senderMemberId !== recipient.id)
    ) {
      throw new Error("Peer reply does not match the directed parent message.");
    }
    const causalRoot = parent
      ? parent.causalRoot
      : input.binding.causalRoot
        ? safeId(input.binding.causalRoot, "causalRoot")
        : agentMeshHmac(
            "peer-causal-root",
            `${sender.id}\0${sender.generation}\0${clientMessageId}`,
          );
    const causalParent = parent?.id ?? null;
    const causalPath = (
      parent?.causalPath ??
      input.binding.causalPath ??
      []
    ).map((id) => safeId(id, "causal path member"));
    const directReply = Boolean(parent);
    if (
      causalPath.length >= MAX_CAUSAL_HOPS ||
      (!directReply && causalPath.includes(recipient.id))
    ) {
      throw new Error("Peer message causal path would exceed the loop bound.");
    }
    const request = {
      recipientMemberId: recipient.id,
      kind: input.kind,
      body,
      payload: safeJson(payloadJson, null),
      replyTo,
      causalRoot,
      causalParent,
      causalPath,
    };
    const requestDigest = digest(request);
    const now = this.now();
    const nowIso = now.toISOString();
    const nextPath = [...causalPath, sender.id];
    const bodyBytes =
      (body ? Buffer.byteLength(body, "utf8") : 0) +
      Buffer.byteLength(payloadJson, "utf8");
    const maximumMessageBytes =
      channel.kind === "bridge"
        ? MAX_BRIDGE_BODY_BYTES
        : MAX_SAME_REPO_BODY_BYTES;
    if (bodyBytes > maximumMessageBytes) {
      throw new RangeError("Combined peer body and payload exceed the channel bound.");
    }
    const keyedBodyDigest = agentMeshHmac(
      "peer-message-body",
      `${channel.id}\0${body ?? ""}\0${payloadJson}`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lockedBinding = this.assertBinding(input.binding);
      recipient = this.requireMember(input.recipientMemberId);
      if (recipient.status !== "active") {
        throw new Error("Recipient is not an active peer member.");
      }
      sender =
        recipient.channelId === lockedBinding.channelId
          ? lockedBinding
          : this.memberForAgentChannel(
              lockedBinding.agentId,
              recipient.channelId,
            );
      channel = this.requireOpenChannel(sender.channelId);
      this.assertDirection(channel, sender, recipient);
      parent = replyTo ? this.requireMessage(replyTo) : undefined;
      if (
        parent &&
        (parent.channelId !== channel.id ||
          parent.recipientMemberId !== sender.id ||
          parent.senderMemberId !== recipient.id)
      ) {
        throw new Error("Peer reply parent changed before commit.");
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM peer_messages
           WHERE sender_member_id = ? AND sender_generation = ?
             AND client_message_id = ?`,
        )
        .get(
          sender.id,
          sender.generation,
          clientMessageId,
        ) as Row | undefined;
      if (existing) {
        const message = this.verifyMessageRow(existing);
        if (message.requestDigest !== requestDigest) {
          throw new Error(
            "Peer client_message_id was reused with different content.",
          );
        }
        const delivery = this.deliveryForMessage(message.id);
        if (input.ackDeliveryId) {
          this.ackDeliveryInternal(
            input.ackDeliveryId,
            boundMember.agentId,
            nowIso,
          );
        }
        this.db.exec("COMMIT");
        return { message, delivery };
      }
      this.purgeChannelInternal(channel.id, now);
      this.enforceSendLimits(channel, sender, recipient);
      const channelUpdate = this.db
        .prepare(
          `UPDATE peer_channels
           SET message_count = message_count + 1,
               byte_count = byte_count + ?, updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'open'
             AND message_count < message_limit
             AND byte_count + ? <= byte_limit
             AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .run(bodyBytes, nowIso, channel.id, this.origin, bodyBytes, nowIso);
      if (channelUpdate.changes !== 1) throw new Error("Peer channel quota or expiry changed.");
      this.db
        .prepare(
          `INSERT INTO peer_channel_counters (channel_id, next_sequence)
           VALUES (?, COALESCE((
             SELECT MAX(sequence) + 1 FROM peer_messages WHERE channel_id = ?
           ), 1))
           ON CONFLICT(channel_id) DO NOTHING`,
        )
        .run(channel.id, channel.id);
      const sequenceRow = this.db
        .prepare(
          "SELECT next_sequence AS sequence FROM peer_channel_counters WHERE channel_id = ?",
        )
        .get(channel.id) as Row;
      const sequence = Number(sequenceRow.sequence);
      this.db
        .prepare(
          "UPDATE peer_channel_counters SET next_sequence = next_sequence + 1 WHERE channel_id = ?",
        )
        .run(channel.id);
      const envelope = {
        id: messageId,
        channelId: channel.id,
        sequence,
        senderMemberId: sender.id,
        senderGeneration: sender.generation,
        recipientMemberId: recipient.id,
        kind: input.kind,
        bodyDigest: keyedBodyDigest,
        bodyBytes,
        replyTo,
        causalRoot,
        causalParent,
        causalPath: nextPath,
        hopCount: nextPath.length - 1,
        clientMessageId,
        requestDigest,
        sourceMessageId: channel.kind === "bridge" ? replyTo : null,
        createdAt: nowIso,
      };
      const envelopeHash = agentMeshHmac(
        "peer-message-envelope",
        canonicalJson(envelope),
      );
      this.db
        .prepare(
          `INSERT INTO peer_messages
           (id, channel_id, sequence, sender_member_id, sender_generation,
            recipient_member_id, kind, body, payload_json, body_digest, body_bytes,
            reply_to, causal_root, causal_parent, causal_path_json, hop_count,
            client_message_id, request_digest, source_message_id, envelope_hash,
            created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          messageId,
          channel.id,
          sequence,
          sender.id,
          sender.generation,
          recipient.id,
          input.kind,
          body,
          payloadJson,
          keyedBodyDigest,
          bodyBytes,
          replyTo,
          causalRoot,
          causalParent,
          canonicalJson(nextPath),
          nextPath.length - 1,
          clientMessageId,
          requestDigest,
          channel.kind === "bridge" ? replyTo : null,
          envelopeHash,
          nowIso,
        );
      const deliveryId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO peer_origin_counters (origin, next_cursor)
           VALUES (?, COALESCE((
             SELECT MAX(deliveries.cursor) + 1
             FROM peer_deliveries deliveries
             JOIN peer_channels channels ON channels.id = deliveries.channel_id
             WHERE channels.origin = ?
           ), 1))
           ON CONFLICT(origin) DO NOTHING`,
        )
        .run(this.origin, this.origin);
      const cursorRow = this.db
        .prepare(
          "SELECT next_cursor AS cursor FROM peer_origin_counters WHERE origin = ?",
        )
        .get(this.origin) as Row;
      const deliveryCursor = Number(cursorRow.cursor);
      this.db
        .prepare(
          "UPDATE peer_origin_counters SET next_cursor = next_cursor + 1 WHERE origin = ?",
        )
        .run(this.origin);
      const deliveryHash = agentMeshHmac(
        "peer-delivery-envelope",
        canonicalJson({
          id: deliveryId,
          origin: this.origin,
          messageId,
          channelId: channel.id,
          recipientMemberId: recipient.id,
          sequence,
          cursor: deliveryCursor,
          createdAt: nowIso,
        }),
      );
      this.db
        .prepare(
          `INSERT INTO peer_deliveries
           (id, origin, message_id, channel_id, recipient_member_id, sequence, cursor, state,
            lease_owner, lease_expires_at, created_at, updated_at,
            acknowledged_at, reason, delivery_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          deliveryId,
          this.origin,
          messageId,
          channel.id,
          recipient.id,
          sequence,
          deliveryCursor,
          nowIso,
          nowIso,
          deliveryHash,
        );
      this.maybeEnqueueWakeInternal(
        channel,
        recipient,
        input.kind,
        sequence,
        causalRoot,
        nextPath,
        now,
      );
      if (input.ackDeliveryId) {
        this.ackDeliveryInternal(
          input.ackDeliveryId,
          boundMember.agentId,
          nowIso,
        );
      }
      this.appendAuditInternal({
        entityType: "message",
        entityId: messageId,
        event: "accepted",
        data: {
          channelId: channel.id,
          senderMemberId: sender.id,
          recipientMemberId: recipient.id,
          kind: input.kind,
          bodyDigest: keyedBodyDigest,
          bodyBytes,
          sequence,
          bridge: channel.kind === "bridge",
        },
        createdAt: nowIso,
      });
      this.db.exec("COMMIT");
      return {
        message: this.requireMessage(messageId),
        delivery: this.requireDelivery(deliveryId),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  inbox(
    binding: ManagedPeerBinding,
    afterSequence = 0,
    limit = 100,
  ): Array<{ delivery: PeerDeliveryRecord; message: PeerMessageRecord }> {
    this.recoverExpired();
    const member = this.assertBinding(binding);
    const cursor = boundedInteger(afterSequence, "afterSequence", 0, Number.MAX_SAFE_INTEGER);
    const boundedLimit = boundedInteger(limit, "limit", 1, 500);
    const rows = this.db
      .prepare(
        `SELECT deliveries.*, messages.id AS message_record_id
         FROM peer_deliveries deliveries
         JOIN peer_messages messages ON messages.id = deliveries.message_id
         JOIN peer_members recipients ON recipients.id = deliveries.recipient_member_id
         JOIN peer_channels channels ON channels.id = deliveries.channel_id
         WHERE recipients.origin = ? AND recipients.agent_id = ?
           AND recipients.status = 'active' AND deliveries.cursor > ?
           AND channels.origin = ? AND channels.status = 'open'
           AND (channels.expires_at IS NULL OR channels.expires_at > ?)
           AND deliveries.state <> 'dead_letter'
         ORDER BY deliveries.cursor ASC LIMIT ?`,
      )
      .all(
        this.origin,
        member.agentId,
        cursor,
        this.origin,
        this.now().toISOString(),
        boundedLimit,
      ) as Row[];
    return rows.map((row) => {
      const delivery = this.requireDelivery(text(row.id));
      return {
        delivery,
        message: this.requireMessage(text(row.message_record_id)),
      };
    });
  }

  async wait(
    binding: ManagedPeerBinding,
    afterSequence: number,
    timeoutMs: number,
    limit = 100,
  ): Promise<Array<{ delivery: PeerDeliveryRecord; message: PeerMessageRecord }>> {
    const boundedTimeout = boundedInteger(timeoutMs, "timeoutMs", 0, 120_000);
    const deadline = Date.now() + boundedTimeout;
    for (;;) {
      const messages = this.inbox(binding, afterSequence, limit);
      if (messages.length || Date.now() >= deadline) return messages;
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.min(250, Math.max(1, deadline - Date.now()))),
      );
    }
  }

  acknowledge(
    binding: ManagedPeerBinding,
    deliveryId: string,
  ): PeerDeliveryRecord {
    const member = this.assertBinding(binding);
    const delivery = this.requireDelivery(deliveryId);
    const recipientMember = this.requireMember(delivery.recipientMemberId);
    if (recipientMember.agentId !== member.agentId) {
      throw new Error("Peer delivery belongs to another member.");
    }
    if (delivery.state === "acknowledged") return delivery;
    if (delivery.state === "dead_letter") throw new Error("Dead-letter delivery cannot be acknowledged.");
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `UPDATE peer_deliveries
           SET state = 'acknowledged', acknowledged_at = ?, updated_at = ?,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND recipient_member_id = ?
             AND state IN ('pending', 'leased', 'handed_off')`,
        )
        .run(now, now, delivery.id, recipientMember.id);
      if (changed.changes !== 1) throw new Error("Peer delivery changed before acknowledgement.");
      this.appendAuditInternal({
        entityType: "delivery",
        entityId: delivery.id,
        event: "acknowledged",
        data: {
          memberId: recipientMember.id,
          sequence: delivery.sequence,
          cursor: delivery.cursor,
        },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.requireDelivery(delivery.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ackDeliveryInternal(
    deliveryId: string,
    recipientAgentId: string,
    now: string,
  ): void {
    const delivery = this.requireDelivery(deliveryId);
    const recipient = this.requireMember(delivery.recipientMemberId);
    if (recipient.agentId !== recipientAgentId) {
      throw new Error("Reply acknowledgement belongs to another managed agent.");
    }
    if (delivery.state === "acknowledged") return;
    const changed = this.db
      .prepare(
        `UPDATE peer_deliveries
         SET state = 'acknowledged', acknowledged_at = ?, updated_at = ?,
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ? AND recipient_member_id = ?
           AND state IN ('pending', 'leased', 'handed_off')`,
      )
      .run(now, now, delivery.id, recipient.id);
    if (changed.changes !== 1) {
      throw new Error("Peer source delivery changed before reply acknowledgement.");
    }
    this.appendAuditInternal({
      entityType: "delivery",
      entityId: delivery.id,
      event: "acknowledged",
      data: {
        memberId: recipient.id,
        sequence: delivery.sequence,
        cursor: delivery.cursor,
        source: "reply_and_ack",
      },
      createdAt: now,
    });
  }

  replyAndAcknowledge(input: {
    binding: ManagedPeerBinding;
    deliveryId: string;
    kind: PeerMessageKind;
    body?: string;
    payload?: unknown;
    clientMessageId: string;
  }): { message: PeerMessageRecord; delivery: PeerDeliveryRecord; acknowledged: PeerDeliveryRecord } {
    const sourceDelivery = this.requireDelivery(input.deliveryId);
    const source = this.requireMessage(sourceDelivery.messageId);
    const member = this.assertBinding(input.binding);
    const recipient = this.requireMember(sourceDelivery.recipientMemberId);
    if (recipient.agentId !== member.agentId) {
      throw new Error("Cannot reply to another member's delivery.");
    }
    const sent = this.send({
      binding: input.binding,
      recipientMemberId: source.senderMemberId,
      kind: input.kind,
      body: input.body,
      payload: input.payload,
      replyTo: source.id,
      clientMessageId: input.clientMessageId,
      ackDeliveryId: sourceDelivery.id,
    });
    const acknowledged = this.requireDelivery(sourceDelivery.id);
    return { ...sent, acknowledged };
  }

  recordReceipt(input: {
    binding: ManagedPeerBinding;
    kind: PeerReceiptKind;
    key: string;
    payload: unknown;
    observed?: unknown;
    status?: "active" | "resolved";
  }): PeerReceiptRecord {
    if (!PEER_RECEIPT_KINDS.includes(input.kind)) throw new Error("Unsupported peer receipt kind.");
    const member = this.assertBinding(input.binding);
    const key = safeResource(input.key);
    const payloadJson = canonicalJson(input.payload);
    const observedJson = canonicalJson(input.observed ?? {});
    if (
      Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES ||
      Buffer.byteLength(observedJson, "utf8") > MAX_PAYLOAD_BYTES
    ) {
      throw new RangeError("Peer receipt exceeds the size bound.");
    }
    if (
      redactSecrets(payloadJson) !== payloadJson ||
      redactSecrets(observedJson) !== observedJson
    ) {
      throw new Error("Peer receipt may contain a secret and was not accepted.");
    }
    const now = this.now().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertBinding(input.binding);
      const minuteAgo = new Date(this.now().getTime() - 60_000).toISOString();
      const historyBefore = new Date(
        this.now().getTime() - 7 * 24 * 60 * 60_000,
      ).toISOString();
      this.db
        .prepare(
          `DELETE FROM peer_receipts
           WHERE member_id = ? AND updated_at <= ?
             AND id NOT IN (
               SELECT current_receipt_id FROM peer_receipt_heads
               WHERE member_id = ?
             )`,
        )
        .run(member.id, historyBefore, member.id);
      const history = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM peer_receipts WHERE member_id = ?",
        )
        .get(member.id) as Row;
      if (Number(history.count) >= 5_000) {
        throw new Error("Peer receipt history limit reached.");
      }
      const recent = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM peer_receipts
           WHERE member_id = ? AND created_at >= ?`,
        )
        .get(member.id, minuteAgo) as Row;
      if (Number(recent.count) >= 60) {
        throw new Error("Peer receipt update rate exceeded.");
      }
      const keys = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM peer_receipt_heads
           WHERE member_id = ?`,
        )
        .get(member.id) as Row;
      const head = this.db
        .prepare(
          `SELECT * FROM peer_receipt_heads
           WHERE channel_id = ? AND member_id = ? AND kind = ?
             AND receipt_key = ?`,
        )
        .get(member.channelId, member.id, input.kind, key) as Row | undefined;
      if (!head && Number(keys.count) >= 500) {
        throw new Error("Peer receipt key limit reached.");
      }
      const version = head ? Number(head.version) + 1 : 1;
      const previousReceiptHash = head ? text(head.head_hash) : null;
      const receiptHash = agentMeshHmac(
        "peer-receipt-envelope",
        canonicalJson({
          id,
          channelId: member.channelId,
          memberId: member.id,
          kind: input.kind,
          key,
          version,
          previousReceiptHash,
          payloadDigest: agentMeshHmac("peer-receipt", payloadJson),
          observedDigest: agentMeshHmac("peer-observed", observedJson),
          status: input.status ?? "active",
          createdAt: now,
        }),
      );
      const headHash = agentMeshHmac(
        "peer-receipt-head",
        `${previousReceiptHash ?? ""}\0${receiptHash}`,
      );
      this.db
        .prepare(
          `INSERT INTO peer_receipts
           (id, channel_id, member_id, kind, receipt_key, version,
            payload_json, observed_json, status, message_id,
            previous_receipt_hash, receipt_hash,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          member.channelId,
          member.id,
          input.kind,
          key,
          version,
          payloadJson,
          observedJson,
          input.status ?? "active",
          previousReceiptHash,
          receiptHash,
          now,
          now,
        );
      const headUpdate = this.db
        .prepare(
          `INSERT INTO peer_receipt_heads
           (channel_id, member_id, kind, receipt_key, current_receipt_id,
            version, head_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, member_id, kind, receipt_key) DO UPDATE SET
             current_receipt_id = excluded.current_receipt_id,
             version = excluded.version,
             head_hash = excluded.head_hash,
             updated_at = excluded.updated_at
           WHERE peer_receipt_heads.version = ?`,
        )
        .run(
          member.channelId,
          member.id,
          input.kind,
          key,
          id,
          version,
          headHash,
          now,
          version - 1,
        );
      if (headUpdate.changes !== 1) {
        throw new Error("Peer receipt head changed concurrently.");
      }
      this.appendAuditInternal({
        entityType: "receipt_head",
        entityId: agentMeshHmac(
          "peer-receipt-key",
          `${member.channelId}\0${member.id}\0${input.kind}\0${key}`,
        ),
        event: "recorded",
        data: {
          currentReceiptId: id,
          headHash,
          channelId: member.channelId,
          memberId: member.id,
          kind: input.kind,
          key,
          version,
          payloadDigest: agentMeshHmac("peer-receipt", payloadJson),
          observedDigest: agentMeshHmac("peer-observed", observedJson),
        },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.requireReceipt(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  publishDirection(input: {
    directionId?: string;
    expectedRevision: number;
    repoKey: string;
    title: string;
    body: string;
    summary: string;
    affectedPaths?: string[];
    provenance: PeerDirectionProvenance;
    conversationId?: string;
    disposition: PeerDirectionDisposition;
    idempotencyKey: string;
  }, fence?: PeerFenceInput): PeerDirectionPublication {
    const directionId = input.directionId
      ? safeId(input.directionId, "directionId")
      : undefined;
    const expectedRevision = boundedInteger(
      input.expectedRevision,
      "expectedRevision",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const repoKey = safeId(input.repoKey, "repoKey");
    const title = boundedText(
      redactSecrets(input.title),
      "direction title",
      200,
    );
    const body = boundedText(
      redactSecrets(input.body),
      "direction body",
      MAX_DIRECTION_BODY_BYTES,
    );
    const summary = boundedText(
      redactSecrets(input.summary),
      "direction summary",
      MAX_DIRECTION_SUMMARY_BYTES,
    );
    if ((input.affectedPaths?.length ?? 0) > MAX_DIRECTION_PATHS) {
      throw new RangeError(
        `affectedPaths is bounded to ${MAX_DIRECTION_PATHS} entries.`,
      );
    }
    const affectedPaths = (input.affectedPaths ?? []).map((path) =>
      boundedText(
        redactSecrets(path),
        "affected path",
        MAX_DIRECTION_PATH_BYTES,
      ),
    );
    const affectedPathsJson = canonicalJson(affectedPaths);
    if (Buffer.byteLength(affectedPathsJson, "utf8") > 512 * 1024) {
      throw new RangeError("Direction affected paths exceed the size bound.");
    }
    if (!["hook_prompt", "controller"].includes(input.provenance)) {
      throw new Error("Unsupported direction provenance.");
    }
    if (!["active", "withdrawn"].includes(input.disposition)) {
      throw new Error("Unsupported direction disposition.");
    }
    const conversationId = input.conversationId
      ? safeId(input.conversationId, "conversationId")
      : null;
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      "idempotencyKey",
      200,
    );
    if (!ID_PATTERN.test(idempotencyKey)) {
      throw new Error("Invalid idempotencyKey.");
    }
    for (const [name, value] of [
      ["directionId", directionId],
      ["repoKey", repoKey],
      ["conversationId", conversationId],
      ["idempotencyKey", idempotencyKey],
    ] as const) {
      if (value && redactSecrets(value) !== value) {
        throw new Error(`${name} may contain a secret.`);
      }
    }
    const requestDigest = agentMeshHmac(
      "peer-direction-request",
      canonicalJson({
        directionId: directionId ?? null,
        expectedRevision,
        repoKey,
        title,
        body,
        summary,
        affectedPaths,
        provenance: input.provenance,
        conversationId,
        disposition: input.disposition,
        idempotencyKey,
      }),
    );
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAdminFence(fence);
      const idempotent = this.db
        .prepare(
          `SELECT revisions.*, directions.id AS owner_direction_id
           FROM peer_direction_revisions revisions
           JOIN peer_directions directions ON directions.id = revisions.direction_id
           WHERE directions.origin = ? AND revisions.idempotency_key = ?
           ORDER BY revisions.sequence ASC LIMIT 2`,
        )
        .all(this.origin, idempotencyKey) as Row[];
      if (idempotent.length > 0) {
        if (idempotent.length !== 1) {
          throw new Error("Direction idempotency state is ambiguous.");
        }
        const revision = this.requireDirectionRevision(
          text(idempotent[0]!.owner_direction_id),
          Number(idempotent[0]!.revision),
        );
        const audit = this.db
          .prepare(
            `SELECT * FROM peer_audit_events
             WHERE origin = ? AND entity_type = 'direction'
               AND entity_id = ? AND event = 'published'
             ORDER BY sequence DESC`,
          )
          .all(this.origin, revision.directionId) as Row[];
        const publicationAudit = audit.find((row) => {
          const data = safeJson<Record<string, unknown>>(row.data_json, {});
          return Number(data.revision) === revision.revision;
        });
        if (!publicationAudit) {
          throw new Error("Direction publication is missing its audit event.");
        }
        this.verifyAuditRow(publicationAudit);
        const data = safeJson<Record<string, unknown>>(
          publicationAudit.data_json,
          {},
        );
        if (text(data.requestDigest) !== requestDigest) {
          throw new Error(
            "Direction idempotency_key was reused with different content.",
          );
        }
        const result = this.directionPublicationInternal(
          revision.directionId,
          revision.revision,
        );
        this.db.exec("COMMIT");
        return result;
      }

      const unscoped = directionId
        ? this.db
            .prepare("SELECT origin FROM peer_directions WHERE id = ?")
            .get(directionId) as Row | undefined
        : undefined;
      if (unscoped && text(unscoped.origin) !== this.origin) {
        throw new Error("Direction belongs to another origin.");
      }
      const existing = directionId
        ? this.db
            .prepare(
              "SELECT * FROM peer_directions WHERE id = ? AND origin = ?",
            )
            .get(directionId, this.origin) as Row | undefined
        : undefined;
      const current = existing
        ? this.verifyDirectionRow(existing)
        : undefined;
      if (!current && expectedRevision !== 0) {
        throw new Error(
          `Direction revision conflict: expected ${expectedRevision} but the direction does not exist.`,
        );
      }
      if (current && current.currentRevision !== expectedRevision) {
        throw new Error(
          `Direction revision conflict: expected ${expectedRevision} but found ${current.currentRevision}.`,
        );
      }
      if (current && current.repoKey !== repoKey) {
        throw new Error("A direction cannot change repository scope.");
      }

      const id = current?.id ?? directionId ?? randomUUID();
      const revisionNumber = expectedRevision + 1;
      const revisionId = randomUUID();
      const previousRevision = current
        ? this.requireDirectionRevision(id, current.currentRevision)
        : undefined;
      const sequence = this.nextOriginCursorInternal();
      const controllerInstanceId =
        fence && typeof fence !== "function" ? fence.ownerInstanceId : null;
      const controllerGeneration =
        fence && typeof fence !== "function" ? fence.generation : null;
      const revisionPayload = {
        id: revisionId,
        directionId: id,
        revision: revisionNumber,
        sequence,
        title,
        body,
        summary,
        affectedPaths,
        provenance: input.provenance,
        conversationId,
        previousHash: previousRevision?.revisionHash ?? null,
        idempotencyKey,
        controllerInstanceId,
        controllerGeneration,
        createdAt: now,
      };
      const revisionHash = agentMeshHmac(
        "peer-direction-revision",
        `${previousRevision?.revisionHash ?? ""}\0${canonicalJson(revisionPayload)}`,
      );
      const directionPayload = {
        id,
        origin: this.origin,
        repoKey,
        currentRevision: revisionNumber,
        disposition: input.disposition,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      const directionHash = agentMeshHmac(
        "peer-direction",
        canonicalJson(directionPayload),
      );
      if (current) {
        const changed = this.db
          .prepare(
            `UPDATE peer_directions
             SET current_revision = ?, disposition = ?, direction_hash = ?,
                 updated_at = ?
             WHERE id = ? AND origin = ? AND current_revision = ?`,
          )
          .run(
            revisionNumber,
            input.disposition,
            directionHash,
            now,
            id,
            this.origin,
            expectedRevision,
          );
        if (changed.changes !== 1) {
          throw new Error("Direction revision changed before publication.");
        }
      } else {
        this.db
          .prepare(
            `INSERT INTO peer_directions
             (id, origin, repo_key, current_revision, disposition,
              direction_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            this.origin,
            repoKey,
            revisionNumber,
            input.disposition,
            directionHash,
            now,
            now,
          );
      }
      this.db
        .prepare(
          `INSERT INTO peer_direction_revisions
           (id, direction_id, revision, sequence, title, body, summary,
            affected_paths_json, provenance, conversation_id, previous_hash,
            revision_hash, idempotency_key, controller_instance_id,
            controller_generation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revisionId,
          id,
          revisionNumber,
          sequence,
          title,
          body,
          summary,
          affectedPathsJson,
          input.provenance,
          conversationId,
          previousRevision?.revisionHash ?? null,
          revisionHash,
          idempotencyKey,
          controllerInstanceId,
          controllerGeneration,
          now,
        );
      this.db
        .prepare(
          `UPDATE peer_direction_targets
           SET state = 'superseded', updated_at = ?
           WHERE direction_id = ? AND revision < ? AND state = 'pending'`,
        )
        .run(now, id, revisionNumber);
      const targets = this.liveDirectionMembers(repoKey);
      for (const target of targets) {
        this.insertDirectionTargetInternal(
          id,
          revisionNumber,
          target,
          now,
        );
      }
      this.appendAuditInternal({
        entityType: "direction",
        entityId: id,
        event: "published",
        data: {
          revision: revisionNumber,
          sequence,
          disposition: input.disposition,
          provenance: input.provenance,
          requestDigest,
          revisionHash,
          targetCount: targets.length,
        },
        createdAt: now,
      });
      const result = this.directionPublicationInternal(id, revisionNumber);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  directionOutbox(input: {
    directionId?: string;
    repoKey?: string;
    afterSequence: number;
    limit: number;
    includeHistory: boolean;
  }): PeerDirectionOutboxEntry[] {
    const directionId = input.directionId
      ? safeId(input.directionId, "directionId")
      : undefined;
    const repoKey = input.repoKey
      ? safeId(input.repoKey, "repoKey")
      : undefined;
    const afterSequence = boundedInteger(
      input.afterSequence,
      "afterSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = boundedInteger(input.limit, "limit", 1, 500);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.directionOutboxInternal({
        directionId,
        repoKey,
        afterSequence,
        limit,
        includeHistory: input.includeHistory,
      });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  acknowledgeDirection(input: {
    binding: ManagedPeerBinding;
    directionId: string;
    revision: number;
    impact: PeerDirectionImpact;
    note?: string;
  }): PeerDirectionTargetRecord {
    const directionId = safeId(input.directionId, "directionId");
    const revision = boundedInteger(
      input.revision,
      "revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      !["applies", "no-impact", "conflict-needs-clarity"].includes(
        input.impact,
      )
    ) {
      throw new Error("Unsupported direction impact.");
    }
    const note = input.note
      ? boundedText(
          redactSecrets(input.note),
          "direction acknowledgment note",
          MAX_DIRECTION_NOTE_BYTES,
        )
      : null;
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const member = this.assertBinding(input.binding);
      this.requireDirectionRevision(directionId, revision);
      const row = this.db
        .prepare(
          `SELECT targets.*
           FROM peer_direction_targets targets
           JOIN peer_directions directions ON directions.id = targets.direction_id
           WHERE targets.direction_id = ? AND targets.revision = ?
             AND targets.agent_id = ? AND directions.origin = ?`,
        )
        .get(
          directionId,
          revision,
          member.agentId,
          this.origin,
        ) as Row | undefined;
      if (!row) {
        throw new Error(
          "Direction revision is not targeted to this managed agent.",
        );
      }
      const target = this.verifyDirectionTargetRow(row);
      if (target.state === "acknowledged") {
        if (target.impact !== input.impact || target.note !== note) {
          throw new Error(
            "Direction acknowledgment cannot be changed after delivery.",
          );
        }
        this.db.exec("COMMIT");
        return target;
      }
      if (target.state !== "pending") {
        throw new Error("Superseded direction revisions cannot be acknowledged.");
      }
      const observedGitHead = this.captureAgentGitHead(member.agentId);
      const ackPayload = {
        id: target.id,
        directionId,
        revision,
        agentId: member.agentId,
        memberId: member.id,
        memberGeneration: member.generation,
        state: "acknowledged",
        impact: input.impact,
        note,
        observedGitHead,
        createdAt: target.createdAt,
        acknowledgedAt: now,
        updatedAt: now,
      };
      const ackHash = agentMeshHmac(
        "peer-direction-ack",
        canonicalJson(ackPayload),
      );
      const changed = this.db
        .prepare(
          `UPDATE peer_direction_targets
           SET member_id = ?, member_generation = ?, state = 'acknowledged',
               impact = ?, note = ?, observed_git_head = ?, ack_hash = ?,
               acknowledged_at = ?, updated_at = ?
           WHERE id = ? AND direction_id = ? AND revision = ?
             AND agent_id = ? AND state = 'pending'`,
        )
        .run(
          member.id,
          member.generation,
          input.impact,
          note,
          observedGitHead,
          ackHash,
          now,
          now,
          target.id,
          directionId,
          revision,
          member.agentId,
        );
      if (changed.changes !== 1) {
        throw new Error("Direction target changed before acknowledgment.");
      }
      this.appendAuditInternal({
        entityType: "direction_target",
        entityId: target.id,
        event: "acknowledged",
        data: {
          directionId,
          revision,
          agentId: member.agentId,
          impact: input.impact,
          observedGitHead,
          ackHash,
        },
        createdAt: now,
      });
      if (input.impact === "conflict-needs-clarity") {
        this.recordFrictionInternal({
          repoKey: member.repoKey,
          kind: "direction_conflict",
          severity: "high",
          detail:
            note ??
            "Direction was acknowledged as conflicting without a note.",
          dedupeKey: `direction_conflict:${directionId}:${revision}:${member.agentId}`,
          agentId: member.agentId,
          reference: `${directionId}@${revision}`,
          occurredAt: now,
          ...this.frictionAgentContext(member.agentId),
        });
      }
      const acknowledged = this.requireDirectionTarget(target.id);
      this.db.exec("COMMIT");
      return acknowledged;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pendingDirections(agentId: string): PeerApplicableDirection[] {
    const safeAgentId = safeId(agentId, "agentId");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT targets.direction_id, targets.revision
           FROM peer_direction_targets targets
           JOIN peer_directions directions ON directions.id = targets.direction_id
           WHERE directions.origin = ? AND targets.agent_id = ?
             AND targets.revision = directions.current_revision
             AND (
               targets.state = 'pending' OR
               (targets.state = 'acknowledged'
                 AND targets.impact = 'conflict-needs-clarity')
             )
           ORDER BY directions.updated_at ASC`,
        )
        .all(this.origin, safeAgentId) as Row[];
      const result = rows.map((row) =>
        this.applicableDirectionInternal(
          text(row.direction_id),
          Number(row.revision),
          safeAgentId,
        ),
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  context(
    binding: ManagedPeerBinding,
    afterSequence = 0,
    limit = 100,
  ): PeerContextSnapshot {
    this.recoverExpired();
    const member = this.assertBinding(binding);
    const channels = this.listChannels(member.agentId);
    const deliveries = this.inbox(binding, afterSequence, limit);
    const receipts = (
      this.db
        .prepare(
          `SELECT receipts.*, heads.current_receipt_id AS head_receipt_id
           FROM peer_receipt_heads heads
           LEFT JOIN peer_receipts receipts ON receipts.id = heads.current_receipt_id
           JOIN peer_members members ON members.id = heads.member_id
           WHERE heads.channel_id = ?
             AND members.status = 'active'
           ORDER BY heads.updated_at DESC LIMIT 500`,
        )
        .all(member.channelId) as Row[]
    ).map((row) => {
      if (!row.id || text(row.id) !== text(row.head_receipt_id)) {
        throw new Error("Peer receipt head references missing content.");
      }
      return this.requireReceipt(text(row.id));
    });
    const leases = this.listActiveLeases(member.channelId);
    const directions = this.directionContextInternal(member.agentId);
    return {
      member,
      channels,
      deliveries,
      receipts,
      leases,
      directions,
      nextSequence:
        deliveries.length > 0
          ? deliveries[deliveries.length - 1]!.delivery.cursor
          : afterSequence,
    };
  }

  defineResource(input: {
    channelId: string;
    name: string;
    maximumTtlMs: number;
    description: string;
  }, fence?: PeerFenceInput): PeerResourcePolicy {
    const channel = this.requireOpenChannel(input.channelId);
    const name = safeResource(input.name);
    const maximumTtlMs = boundedInteger(
      input.maximumTtlMs,
      "maximumTtlMs",
      1_000,
      24 * 60 * 60_000,
    );
    const description = boundedText(input.description, "description", 2_000);
    if (redactSecrets(description) !== description) {
      throw new Error("Resource description may contain a secret.");
    }
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAdminFence(fence);
      this.db
        .prepare(
          `INSERT INTO peer_resource_policies
           (channel_id, resource_name, maximum_ttl_ms, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, resource_name) DO UPDATE SET
             maximum_ttl_ms = excluded.maximum_ttl_ms,
             description = excluded.description,
             updated_at = excluded.updated_at`,
        )
        .run(channel.id, name, maximumTtlMs, description, now, now);
      this.appendAuditInternal({
        entityType: "resource_policy",
        entityId: `${channel.id}:${name}`,
        event: "defined",
        data: { maximumTtlMs, descriptionDigest: digest(description) },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.requireResourcePolicy(channel.id, name);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  acquireResource(input: {
    binding: ManagedPeerBinding;
    name: string;
    ttlMs: number;
  }): PeerResourceLease {
    const member = this.assertBinding(input.binding);
    const policy = this.requireResourcePolicy(member.channelId, input.name);
    const ttlMs = boundedInteger(input.ttlMs, "ttlMs", 1_000, policy.maximumTtlMs);
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    let contention: PeerResourceLease | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertBinding(input.binding);
      this.db
        .prepare(
          `UPDATE peer_resource_leases
           SET status = 'expired', released_at = ?, updated_at = ?
           WHERE channel_id = ? AND resource_name = ? AND status = 'active'
             AND expires_at <= ?`,
        )
        .run(nowIso, nowIso, member.channelId, policy.name, nowIso);
      const current = this.db
        .prepare(
          `SELECT * FROM peer_resource_leases
           WHERE channel_id = ? AND resource_name = ? AND status = 'active'`,
        )
        .get(member.channelId, policy.name) as Row | undefined;
      if (current) {
        const lease = parseResourceLease(current);
        if (lease.holderMemberId !== member.id) {
          contention = lease;
          throw new Error("Named peer resource is leased by another member.");
        }
        this.db
          .prepare(
            `UPDATE peer_resource_leases SET expires_at = ?, updated_at = ?
             WHERE id = ? AND holder_member_id = ? AND status = 'active'`,
          )
          .run(expiresAt, nowIso, lease.id, member.id);
        this.db.exec("COMMIT");
        return this.requireResourceLease(lease.id);
      }
      const historyBefore = new Date(
        now.getTime() - 30 * 24 * 60 * 60_000,
      ).toISOString();
      this.db
        .prepare(
          `DELETE FROM peer_resource_leases
           WHERE channel_id = ? AND status IN ('released', 'expired')
             AND updated_at <= ?`,
        )
        .run(member.channelId, historyBefore);
      const recent = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM peer_resource_leases
           WHERE holder_member_id = ? AND acquired_at >= ?`,
        )
        .get(
          member.id,
          new Date(now.getTime() - 60_000).toISOString(),
        ) as Row;
      if (Number(recent.count) >= 60) {
        throw new Error("Named resource lease rate exceeded.");
      }
      const history = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM peer_resource_leases
           WHERE channel_id = ?`,
        )
        .get(member.channelId) as Row;
      if (Number(history.count) >= 1_000) {
        this.db
          .prepare(
            `DELETE FROM peer_resource_leases
             WHERE id IN (
               SELECT id FROM peer_resource_leases
               WHERE channel_id = ?
                 AND status IN ('released', 'expired')
               ORDER BY updated_at ASC
               LIMIT ?
             )`,
          )
          .run(
            member.channelId,
            Math.max(1, Number(history.count) - 899),
          );
        const remaining = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM peer_resource_leases
             WHERE channel_id = ?`,
          )
          .get(member.channelId) as Row;
        if (Number(remaining.count) >= 1_000) {
          throw new Error("Named resource active lease limit reached.");
        }
      }
      const generationRow = this.db
        .prepare(
          `SELECT next_generation AS generation
           FROM peer_resource_policies
           WHERE channel_id = ? AND resource_name = ?`,
        )
        .get(member.channelId, policy.name) as Row;
      const id = randomUUID();
      const generation = Number(generationRow.generation);
      const generationClaim = this.db
        .prepare(
          `UPDATE peer_resource_policies
           SET next_generation = next_generation + 1, updated_at = ?
           WHERE channel_id = ? AND resource_name = ?
             AND next_generation = ?`,
        )
        .run(
          nowIso,
          member.channelId,
          policy.name,
          generation,
        );
      if (generationClaim.changes !== 1) {
        throw new Error("Named resource generation changed concurrently.");
      }
      this.db
        .prepare(
          `INSERT INTO peer_resource_leases
           (id, channel_id, resource_name, holder_member_id, generation, status,
            acquired_at, updated_at, expires_at, released_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
        )
        .run(
          id,
          member.channelId,
          policy.name,
          member.id,
          generation,
          nowIso,
          nowIso,
          expiresAt,
        );
      this.appendAuditInternal({
        entityType: "resource_lease",
        entityId: id,
        event: "acquired",
        data: {
          channelId: member.channelId,
          resource: policy.name,
          holderMemberId: member.id,
          generation,
          ttlMs,
        },
        createdAt: nowIso,
      });
      this.db.exec("COMMIT");
      return this.requireResourceLease(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (contention) {
        try {
          this.recordFriction({
            repoKey: member.repoKey,
            kind: "lease_contention",
            detail: `Named resource ${policy.name} is held by another member until ${contention.expiresAt}.`,
            dedupeKey: `lease_contention:${member.channelId}:${policy.name}:${member.id}:${contention.generation}`,
            agentId: member.agentId,
            ...(member.taskId ?? member.runId
              ? { reference: member.taskId ?? member.runId! }
              : {}),
            occurredAt: nowIso,
            ...this.frictionAgentContext(member.agentId),
          });
        } catch {
          // Friction telemetry never masks the contention it observed.
        }
      }
      throw error;
    }
  }

  releaseResource(
    binding: ManagedPeerBinding,
    leaseId: string,
  ): PeerResourceLease {
    const member = this.assertBinding(binding);
    const lease = this.requireResourceLease(leaseId);
    if (lease.holderMemberId !== member.id) {
      throw new Error("Named resource lease belongs to another member.");
    }
    if (lease.status !== "active") return lease;
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertBinding(binding);
      const changed = this.db
        .prepare(
          `UPDATE peer_resource_leases
           SET status = 'released', released_at = ?, updated_at = ?
           WHERE id = ? AND holder_member_id = ? AND status = 'active'`,
        )
        .run(now, now, lease.id, member.id);
      if (changed.changes !== 1) throw new Error("Named lease changed before release.");
      this.appendAuditInternal({
        entityType: "resource_lease",
        entityId: lease.id,
        event: "released",
        data: { holderMemberId: member.id, generation: lease.generation },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.requireResourceLease(lease.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createBridge(input: {
    sourceAgentId: string;
    destinationAgentId: string;
    label: string;
    bidirectional?: boolean;
    expiresInMs?: number;
  }, fence?: PeerFenceInput): PeerChannelRecord {
    this.recoverExpired();
    const source = this.requireEligibleAgent(input.sourceAgentId);
    const destination = this.requireEligibleAgent(input.destinationAgentId);
    if (source.repoKey === destination.repoKey) {
      throw new Error("Same-repository agents already share a repository channel.");
    }
    if (
      !this.bridgeAllowlist.has(
        bridgePairKey(source.repoKey!, destination.repoKey!),
      )
    ) {
      throw new Error("Cross-repository pair is not in the bridge allowlist.");
    }
    const expiresInMs = boundedInteger(
      input.expiresInMs ?? 60 * 60_000,
      "expiresInMs",
      60_000,
      24 * 60 * 60_000,
    );
    const label = boundedText(input.label, "bridge label", 200);
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + expiresInMs).toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM peer_channels
         WHERE origin = ? AND kind = 'bridge' AND source_repo_key = ?
           AND destination_repo_key = ? AND status = 'open'`,
      )
      .get(this.origin, source.repoKey, destination.repoKey) as Row | undefined;
    if (existing) {
      const channel = this.getChannel(text(existing.id));
      const members = this.listMembers(channel.id);
      const sameAgents =
        members.some(
          (member) =>
            member.status === "active" && member.agentId === source.id,
        ) &&
        members.some(
          (member) =>
            member.status === "active" && member.agentId === destination.id,
        );
      if (
        !sameAgents ||
        channel.bidirectional !== Boolean(input.bidirectional) ||
        channel.label !== label
      ) {
        throw new Error(
          "An open bridge for this repository pair has different configuration.",
        );
      }
      if (
        channel.expiresAt &&
        Date.parse(expiresAt) < Date.parse(channel.expiresAt)
      ) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.assertAdminFence(fence);
          this.db
            .prepare(
              `UPDATE peer_channels SET expires_at = ?, updated_at = ?
               WHERE id = ? AND origin = ? AND status = 'open'
                 AND expires_at > ?`,
            )
            .run(expiresAt, nowIso, channel.id, this.origin, expiresAt);
          this.appendAuditInternal({
            entityType: "bridge",
            entityId: channel.id,
            event: "expiry_shortened",
            data: { expiresAt },
            createdAt: nowIso,
          });
          this.db.exec("COMMIT");
          return this.getChannel(channel.id);
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      return channel;
    }
    const id = randomUUID();
    const channelHash = agentMeshHmac(
      "peer-channel",
      canonicalJson({
        id,
        origin: this.origin,
        kind: "bridge",
        label,
        sourceRepoKey: source.repoKey,
        destinationRepoKey: destination.repoKey,
        bidirectional: Boolean(input.bidirectional),
        messageLimit: DEFAULT_BRIDGE_MESSAGE_LIMIT,
        byteLimit: DEFAULT_BRIDGE_BYTE_LIMIT,
        createdAt: nowIso,
      }),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAdminFence(fence);
      this.db
        .prepare(
          `INSERT INTO peer_channels
           (id, origin, kind, label, status, source_repo_key,
            destination_repo_key, bidirectional, wake_policy, policy_version,
            policy_digest, message_limit, byte_limit, message_count, byte_count,
            expires_at, channel_hash, created_at, updated_at, closed_at)
           VALUES (?, ?, 'bridge', ?, 'open', ?, ?, ?, 'off', 1, NULL,
             ?, ?, 0, 0, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          this.origin,
          label,
          source.repoKey,
          destination.repoKey,
          input.bidirectional ? 1 : 0,
          DEFAULT_BRIDGE_MESSAGE_LIMIT,
          DEFAULT_BRIDGE_BYTE_LIMIT,
          expiresAt,
          channelHash,
          nowIso,
          nowIso,
        );
      const sourceMember = this.insertMembership(id, source, {});
      const destinationMember = this.insertMembership(id, destination, {});
      this.appendAuditInternal({
        entityType: "bridge",
        entityId: id,
        event: "created",
        data: {
          sourceMemberId: sourceMember.id,
          destinationMemberId: destinationMember.id,
          sourceRepoKey: source.repoKey,
          destinationRepoKey: destination.repoKey,
          bidirectional: Boolean(input.bidirectional),
          expiresAt,
        },
        createdAt: nowIso,
      });
      this.db.exec("COMMIT");
      return this.getChannel(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  closeBridge(channelId: string, fence?: PeerFenceInput): PeerChannelRecord {
    const channel = this.getChannel(channelId);
    if (channel.kind !== "bridge") throw new Error("Only bridge channels can be closed.");
    if (channel.status === "closed") return channel;
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAdminFence(fence);
      const changed = this.db
        .prepare(
          `UPDATE peer_channels SET status = 'closed', closed_at = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND kind = 'bridge' AND status = 'open'`,
        )
        .run(now, now, channel.id, this.origin);
      if (changed.changes !== 1) throw new Error("Bridge changed before close.");
      this.db
        .prepare(
          `UPDATE peer_members SET status = 'revoked', generation = generation + 1,
             revoked_at = ?, updated_at = ?
           WHERE channel_id = ? AND status = 'active'`,
        )
        .run(now, now, channel.id);
      this.db
        .prepare(
          `UPDATE peer_deliveries SET state = 'dead_letter',
             reason = 'bridge_closed', updated_at = ?
           WHERE channel_id = ? AND state IN ('pending', 'leased', 'handed_off')`,
        )
        .run(now, channel.id);
      this.db
        .prepare(
          `UPDATE peer_resource_leases
           SET status = 'expired', released_at = ?, updated_at = ?
           WHERE channel_id = ? AND status = 'active'`,
        )
        .run(now, now, channel.id);
      this.appendAuditInternal({
        entityType: "bridge",
        entityId: channel.id,
        event: "closed",
        data: {},
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.getChannel(channel.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setWakePolicy(input: {
    channelId: string;
    policy: PeerWakePolicy;
    policyDigest?: string;
  }, fence?: PeerFenceInput): PeerChannelRecord {
    const channel = this.requireOpenChannel(input.channelId);
    if (channel.kind === "bridge" && input.policy !== "off") {
      throw new Error("Bridge channels cannot auto-wake recipients.");
    }
    const digestValue = input.policyDigest
      ? safeId(input.policyDigest, "policyDigest")
      : null;
    if (
      channel.wakePolicy === input.policy &&
      channel.policyDigest === digestValue
    ) {
      return channel;
    }
    const nextPolicyVersion = channel.policyVersion + 1;
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertAdminFence(fence);
      this.db
        .prepare(
          `UPDATE peer_channels
           SET wake_policy = ?, policy_version = policy_version + 1,
               policy_digest = ?, updated_at = ?
           WHERE id = ? AND origin = ? AND status = 'open'`,
        )
        .run(input.policy, digestValue, now, channel.id, this.origin);
      this.db
        .prepare(
          `UPDATE peer_wake_jobs SET state = 'suppressed',
             reason = ?, completed_at = ?, updated_at = ?
           WHERE origin = ? AND channel_id = ? AND state = 'pending'
             AND policy_version <> ?`,
        )
        .run(
          input.policy === "off"
            ? "wake_policy_disabled"
            : "wake_policy_replaced",
          now,
          now,
          this.origin,
          channel.id,
          nextPolicyVersion,
        );
      this.appendAuditInternal({
        entityType: "channel",
        entityId: channel.id,
        event: "wake_policy_changed",
        data: {
          from: channel.wakePolicy,
          to: input.policy,
          priorVersion: channel.policyVersion,
          policyDigest: digestValue,
        },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.getChannel(channel.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimWake(input: {
    controllerId: string;
    controllerGeneration: number;
  }): PeerWakeJob | undefined {
    const controllerId = safeId(input.controllerId, "controllerId");
    const generation = boundedInteger(
      input.controllerGeneration,
      "controllerGeneration",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const now = this.now();
    const nowIso = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `UPDATE peer_wake_jobs
           SET state = CASE WHEN external_ref IS NULL THEN 'pending' ELSE 'ambiguous' END,
               lease_owner = NULL, controller_generation = NULL,
               lease_expires_at = NULL, reason = 'wake_lease_expired',
               updated_at = ?
           WHERE origin = ? AND state IN ('leased', 'started')
             AND lease_expires_at <= ?`,
        )
        .run(nowIso, this.origin, nowIso);
      this.db
        .prepare(
          `UPDATE peer_wake_jobs
           SET state = 'suppressed', reason = 'wake_attempt_limit',
               completed_at = ?, updated_at = ?
           WHERE origin = ? AND state = 'pending' AND attempts >= 3`,
        )
        .run(nowIso, nowIso, this.origin);
      const active = this.db
        .prepare(
          `SELECT 1 AS found FROM peer_wake_jobs
           WHERE origin = ? AND state IN ('leased', 'started') LIMIT 1`,
        )
        .get(this.origin) as Row | undefined;
      if (active) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const candidate = this.db
        .prepare(
          `SELECT * FROM peer_wake_jobs
           WHERE origin = ? AND state = 'pending' AND available_at <= ?
             AND attempts < 3
           ORDER BY available_at ASC, created_at ASC LIMIT 1`,
        )
        .get(this.origin, nowIso) as Row | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const job = parseWake(candidate);
      const deferral = this.wakeDeferralReason(job);
      if (deferral) {
        this.db
          .prepare(
            `UPDATE peer_wake_jobs
             SET available_at = ?, reason = ?, updated_at = ?
             WHERE id = ? AND origin = ? AND state = 'pending'`,
          )
          .run(
            new Date(now.getTime() + 60_000).toISOString(),
            deferral,
            nowIso,
            job.id,
            this.origin,
          );
        this.db.exec("COMMIT");
        return undefined;
      }
      const suppression = this.wakeSuppressionReason(job, now);
      if (suppression) {
        this.db
          .prepare(
            `UPDATE peer_wake_jobs SET state = 'suppressed', reason = ?,
               completed_at = ?, updated_at = ?
             WHERE id = ? AND origin = ? AND state = 'pending'`,
          )
          .run(suppression, nowIso, nowIso, job.id, this.origin);
        this.appendAuditInternal({
          entityType: "wake",
          entityId: job.id,
          event: "suppressed",
          data: { reason: suppression },
          createdAt: nowIso,
        });
        this.db.exec("COMMIT");
        return undefined;
      }
      const changed = this.db
        .prepare(
          `UPDATE peer_wake_jobs
           SET state = 'leased', lease_owner = ?, controller_generation = ?,
               lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND origin = ? AND state = 'pending'`,
        )
        .run(
          controllerId,
          generation,
          new Date(now.getTime() + WAKE_LEASE_MS).toISOString(),
          nowIso,
          job.id,
          this.origin,
        );
      if (changed.changes !== 1) throw new Error("Wake job changed before claim.");
      this.appendAuditInternal({
        entityType: "wake",
        entityId: job.id,
        event: "leased",
        data: { controllerId, controllerGeneration: generation },
        createdAt: nowIso,
      });
      this.db.exec("COMMIT");
      return this.requireWake(job.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markWakeStarted(input: {
    jobId: string;
    controllerId: string;
    controllerGeneration: number;
    externalRef: string;
  }): PeerWakeJob {
    const now = this.now().toISOString();
    const changed = this.db
      .prepare(
        `UPDATE peer_wake_jobs
         SET state = 'started', external_ref = ?, updated_at = ?
         WHERE id = ? AND origin = ? AND state = 'leased' AND lease_owner = ?
           AND controller_generation = ?`,
      )
      .run(
        safeId(input.externalRef, "externalRef"),
        now,
        safeId(input.jobId, "jobId"),
        this.origin,
        safeId(input.controllerId, "controllerId"),
        input.controllerGeneration,
      );
    if (changed.changes !== 1) throw new Error("Wake lease changed before start.");
    return this.requireWake(input.jobId);
  }

  settleWake(input: {
    jobId: string;
    controllerId: string;
    controllerGeneration: number;
    status: "completed" | "failed" | "ambiguous";
    reason?: string;
  }): PeerWakeJob {
    const now = this.now().toISOString();
    const reason = input.reason
      ? redactSecrets(input.reason).slice(0, 2_000)
      : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          `UPDATE peer_wake_jobs
           SET state = ?, reason = ?, completed_at = ?, updated_at = ?,
               lease_owner = NULL, controller_generation = NULL,
               lease_expires_at = NULL
           WHERE id = ? AND origin = ? AND state IN ('leased', 'started')
             AND lease_owner = ? AND controller_generation = ?`,
        )
        .run(
          input.status,
          reason,
          now,
          now,
          safeId(input.jobId, "jobId"),
          this.origin,
          safeId(input.controllerId, "controllerId"),
          input.controllerGeneration,
        );
      if (changed.changes !== 1) throw new Error("Wake job changed before settlement.");
      this.appendAuditInternal({
        entityType: "wake",
        entityId: input.jobId,
        event: input.status,
        data: { reason },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.requireWake(input.jobId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  deferWake(input: {
    jobId: string;
    controllerId: string;
    controllerGeneration: number;
    reason: string;
  }): PeerWakeJob {
    const now = this.now();
    const changed = this.db
      .prepare(
        `UPDATE peer_wake_jobs
         SET state = 'pending', available_at = ?, reason = ?,
             lease_owner = NULL, controller_generation = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND origin = ? AND state = 'leased'
           AND lease_owner = ? AND controller_generation = ?`,
      )
      .run(
        new Date(now.getTime() + 60_000).toISOString(),
        redactSecrets(input.reason).slice(0, 2_000),
        now.toISOString(),
        safeId(input.jobId, "jobId"),
        this.origin,
        safeId(input.controllerId, "controllerId"),
        input.controllerGeneration,
      );
    if (changed.changes !== 1) throw new Error("Wake lease changed before deferral.");
    return this.requireWake(input.jobId);
  }

  listWakeJobs(limit = 500): PeerWakeJob[] {
    const boundedLimit = boundedInteger(limit, "limit", 1, 5_000);
    return (
      this.db
        .prepare(
          `SELECT * FROM peer_wake_jobs
           WHERE origin = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(this.origin, boundedLimit) as Row[]
    ).map(parseWake);
  }

  dashboardSnapshot(): Record<string, unknown> {
    this.recoverExpired();
    const channels = this.listChannels();
    return {
      protocol: "agent-mesh-peer-dashboard/v1",
      channels: channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        label: channel.label,
        status: channel.status,
        wakePolicy: channel.wakePolicy,
        policyVersion: channel.policyVersion,
        messageCount: channel.messageCount,
        byteCount: channel.byteCount,
        expiresAt: channel.expiresAt,
        updatedAt: channel.updatedAt,
      })),
      members: channels.flatMap((channel) =>
        this.listMembers(channel.id).map((member) => ({
          id: member.id,
          channelId: channel.id,
          agentId: member.agentId,
          generation: member.generation,
          status: member.status,
          role: member.role,
          taskId: member.taskId,
          updatedAt: member.updatedAt,
        })),
      ),
      deliveries: Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM peer_deliveries deliveries
               JOIN peer_channels channels ON channels.id = deliveries.channel_id
               WHERE channels.origin = ?
                 AND deliveries.state IN ('pending', 'leased', 'handed_off')`,
            )
            .get(this.origin) as Row
        ).count,
      ),
      wakes: this.listWakeJobs(500).map((job) => ({
        id: job.id,
        channelId: job.channelId,
        recipientMemberId: job.recipientMemberId,
        state: job.state,
        messageCount: job.messageCount,
        policyVersion: job.policyVersion,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    };
  }

  auditEvents(afterSequence = 0, limit = 500): PeerAuditEvent[] {
    this.verifyAuditState();
    const cursor = boundedInteger(afterSequence, "afterSequence", 0, Number.MAX_SAFE_INTEGER);
    const boundedLimit = boundedInteger(limit, "limit", 1, 5_000);
    const predecessor = this.db
      .prepare(
        `SELECT hash FROM peer_audit_events
         WHERE origin = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.origin, cursor) as Row | undefined;
    let previousHash = predecessor ? text(predecessor.hash) : null;
    return (
      this.db
        .prepare(
          `SELECT * FROM peer_audit_events
           WHERE origin = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
        )
        .all(this.origin, cursor, boundedLimit) as Row[]
    ).map((row) => {
      const event: PeerAuditEvent = {
        sequence: Number(row.sequence),
        origin: text(row.origin) as Origin,
        entityType: text(row.entity_type),
        entityId: text(row.entity_id),
        event: text(row.event),
        data: safeJson(row.data_json, {}),
        previousHash: nullableText(row.previous_hash),
        hash: text(row.hash),
        createdAt: text(row.created_at),
      };
      if (event.previousHash !== previousHash) {
        throw new Error(`Peer audit event ${event.sequence} has a broken predecessor.`);
      }
      const expected = agentMeshHmac(
        "peer-audit",
        `${previousHash ?? ""}\0${canonicalJson({
          sequence: event.sequence,
          origin: event.origin,
          entityType: event.entityType,
          entityId: event.entityId,
          event: event.event,
          data: event.data,
          previousHash: event.previousHash,
          createdAt: event.createdAt,
        })}`,
      );
      if (expected !== event.hash) {
        throw new Error(`Peer audit event ${event.sequence} failed verification.`);
      }
      previousHash = event.hash;
      return event;
    });
  }

  recordFriction(input: PeerFrictionInput): PeerFrictionEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const event = this.recordFrictionInternal(input);
      this.db.exec("COMMIT");
      return event;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  frictionEvents(
    input: PeerFrictionFilter & { limit?: number } = {},
  ): PeerFrictionEvent[] {
    const filter = frictionFilterClause(input);
    const limit = boundedInteger(input.limit ?? 500, "limit", 1, 5_000);
    return (
      this.db
        .prepare(
          `SELECT * FROM peer_friction_events
           WHERE origin = ?${filter.clause}
           ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
        )
        .all(this.origin, ...filter.parameters, limit) as Row[]
    ).map(parseFrictionEvent);
  }

  frictionSummary(input: PeerFrictionFilter = {}): PeerFrictionSummary {
    const filter = frictionFilterClause(input);
    const byKind = (
      this.db
        .prepare(
          `SELECT kind, COUNT(*) AS count FROM peer_friction_events
           WHERE origin = ?${filter.clause}
           GROUP BY kind ORDER BY count DESC, kind ASC`,
        )
        .all(this.origin, ...filter.parameters) as Row[]
    ).map((row) => ({
      kind: text(row.kind) as PeerFrictionKind,
      count: Number(row.count),
    }));
    const byProvider = (
      this.db
        .prepare(
          `SELECT provider, COUNT(*) AS count FROM peer_friction_events
           WHERE origin = ?${filter.clause}
           GROUP BY provider ORDER BY count DESC, provider ASC`,
        )
        .all(this.origin, ...filter.parameters) as Row[]
    ).map((row) => ({
      provider: nullableText(row.provider) as Provider | null,
      count: Number(row.count),
    }));
    return {
      total: byKind.reduce((sum, entry) => sum + entry.count, 0),
      byKind,
      byProvider,
    };
  }

  private recordFrictionInternal(input: PeerFrictionInput): PeerFrictionEvent {
    const repoKey = safeId(input.repoKey, "repoKey");
    if (!PEER_FRICTION_KINDS.includes(input.kind)) {
      throw new Error("Unsupported friction kind.");
    }
    const severity = input.severity ?? "medium";
    if (!PEER_FRICTION_SEVERITIES.includes(severity)) {
      throw new Error("Unsupported friction severity.");
    }
    if (input.provider && !PROVIDERS.includes(input.provider)) {
      throw new Error("Unsupported friction provider.");
    }
    const model = input.model
      ? boundedText(redactSecrets(input.model), "friction model", 256)
      : null;
    const agentId = input.agentId ? safeId(input.agentId, "agentId") : null;
    const reference = input.reference
      ? safeId(input.reference, "friction reference")
      : null;
    const skillTier =
      input.skillTier === undefined
        ? null
        : boundedInteger(input.skillTier, "skillTier", 1, MAX_FRICTION_SKILL_TIER);
    // Friction detail is read wholesale by learning surfaces, so it is redacted
    // and bounded here instead of trusting the caller that observed the failure.
    const detail = boundedText(
      redactSecrets(input.detail).slice(0, MAX_FRICTION_DETAIL_CHARS),
      "friction detail",
      MAX_FRICTION_DETAIL_BYTES,
    );
    const dedupeKey = safeId(input.dedupeKey, "friction dedupeKey");
    const occurredAt = input.occurredAt
      ? frictionInstant(input.occurredAt, "occurredAt")
      : this.now().toISOString();
    const now = this.now().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO peer_friction_events
         (id, origin, repo_key, occurred_at, kind, provider, model, agent_id,
          reference, skill_tier, severity, detail, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin, dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        this.origin,
        repoKey,
        occurredAt,
        input.kind,
        input.provider ?? null,
        model,
        agentId,
        reference,
        skillTier,
        severity,
        detail,
        dedupeKey,
        now,
      );
    const row = this.db
      .prepare(
        "SELECT * FROM peer_friction_events WHERE origin = ? AND dedupe_key = ?",
      )
      .get(this.origin, dedupeKey) as Row;
    const event = parseFrictionEvent(row);
    if (event.id === id) {
      this.appendAuditInternal({
        entityType: "friction_event",
        entityId: id,
        event: "recorded",
        data: {
          repoKey,
          kind: input.kind,
          severity,
          provider: input.provider ?? null,
          model,
          agentId,
          reference,
          skillTier,
          dedupeKey,
          occurredAt,
          detailDigest: digest(detail),
        },
        createdAt: now,
      });
    }
    return event;
  }

  private frictionAgentContext(
    agentId: string,
  ): { provider?: Provider; model?: string } {
    try {
      const agent = this.agentResolver(agentId);
      return {
        ...(agent?.provider ? { provider: agent.provider } : {}),
        ...(agent?.model ? { model: agent.model } : {}),
      };
    } catch {
      // Traffic metadata is optional context, never a recording precondition.
      return {};
    }
  }

  private nextOriginCursorInternal(): number {
    this.db
      .prepare(
        `INSERT INTO peer_origin_counters(origin, next_cursor)
         VALUES (?, MAX(
           COALESCE((
             SELECT MAX(cursor) + 1 FROM peer_deliveries WHERE origin = ?
           ), 1),
           COALESCE((
             SELECT MAX(revisions.sequence) + 1
             FROM peer_direction_revisions revisions
             JOIN peer_directions directions
               ON directions.id = revisions.direction_id
             WHERE directions.origin = ?
           ), 1)
         ))
         ON CONFLICT(origin) DO NOTHING`,
      )
      .run(this.origin, this.origin, this.origin);
    const row = this.db
      .prepare(
        "SELECT next_cursor AS cursor FROM peer_origin_counters WHERE origin = ?",
      )
      .get(this.origin) as Row;
    const cursor = Number(row.cursor);
    this.db
      .prepare(
        "UPDATE peer_origin_counters SET next_cursor = next_cursor + 1 WHERE origin = ?",
      )
      .run(this.origin);
    return cursor;
  }

  private liveDirectionMembers(repoKey: string): PeerMemberRecord[] {
    const rows = this.db
      .prepare(
        `SELECT members.*
         FROM peer_members members
         JOIN peer_channels channels ON channels.id = members.channel_id
         WHERE members.origin = ? AND members.repo_key = ?
           AND members.status = 'active' AND channels.kind = 'repository'
           AND channels.status = 'open'
         ORDER BY members.joined_at ASC`,
      )
      .all(this.origin, repoKey) as Row[];
    return rows
      .map((row) => this.requireMember(text(row.id)))
      .filter((member) => this.isDirectionEligibleMember(member));
  }

  private isDirectionEligibleMember(member: PeerMemberRecord): boolean {
    if (
      member.status !== "active" ||
      (!member.taskId && !member.runId)
    ) {
      return false;
    }
    try {
      const agent = this.requireEligibleAgent(member.agentId);
      return (
        agent.repoKey === member.repoKey &&
        ["launching", "running"].includes(agent.status)
      );
    } catch {
      return false;
    }
  }

  private insertDirectionTargetInternal(
    directionId: string,
    revision: number,
    member: PeerMemberRecord,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO peer_direction_targets
         (id, direction_id, revision, agent_id, member_id, member_generation,
          state, impact, note, observed_git_head, ack_hash, created_at,
          acknowledged_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, NULL, ?)
         ON CONFLICT(direction_id, revision, agent_id) DO UPDATE SET
           member_id = excluded.member_id,
           member_generation = excluded.member_generation,
           updated_at = excluded.updated_at
         WHERE peer_direction_targets.state = 'pending'`,
      )
      .run(
        randomUUID(),
        directionId,
        revision,
        member.agentId,
        member.id,
        member.generation,
        now,
        now,
      );
  }

  private backfillDirectionTargetsInternal(
    member: PeerMemberRecord,
    now: string,
  ): void {
    if (!this.isDirectionEligibleMember(member)) return;
    const directions = this.db
      .prepare(
        `SELECT id, current_revision FROM peer_directions
         WHERE origin = ? AND repo_key = ? AND disposition = 'active'
         ORDER BY updated_at ASC`,
      )
      .all(this.origin, member.repoKey) as Row[];
    for (const direction of directions) {
      this.insertDirectionTargetInternal(
        text(direction.id),
        Number(direction.current_revision),
        member,
        now,
      );
    }
  }

  private verifyDirectionRow(row: Row): PeerDirectionRecord {
    const direction = parseDirection(row);
    const expected = agentMeshHmac(
      "peer-direction",
      canonicalJson({
        id: direction.id,
        origin: direction.origin,
        repoKey: direction.repoKey,
        currentRevision: direction.currentRevision,
        disposition: direction.disposition,
        createdAt: direction.createdAt,
        updatedAt: direction.updatedAt,
      }),
    );
    if (expected !== direction.directionHash) {
      throw new Error(`Peer direction ${direction.id} failed verification.`);
    }
    return direction;
  }

  private requireDirection(directionId: string): PeerDirectionRecord {
    const row = this.db
      .prepare(
        "SELECT * FROM peer_directions WHERE id = ? AND origin = ?",
      )
      .get(
        safeId(directionId, "directionId"),
        this.origin,
      ) as Row | undefined;
    if (!row) throw new Error(`Unknown peer direction: ${directionId}`);
    return this.verifyDirectionRow(row);
  }

  private requireDirectionRevision(
    directionId: string,
    revision: number,
  ): PeerDirectionRevisionRecord {
    this.requireDirection(directionId);
    const row = this.db
      .prepare(
        `SELECT revisions.*
         FROM peer_direction_revisions revisions
         JOIN peer_directions directions ON directions.id = revisions.direction_id
         WHERE revisions.direction_id = ? AND revisions.revision = ?
           AND directions.origin = ?`,
      )
      .get(directionId, revision, this.origin) as Row | undefined;
    if (!row) {
      throw new Error(
        `Unknown peer direction revision: ${directionId}@${revision}`,
      );
    }
    const record = parseDirectionRevision(row);
    const previous = revision > 1
      ? this.requireDirectionRevision(directionId, revision - 1)
      : undefined;
    if (
      record.previousHash !== (previous?.revisionHash ?? null)
    ) {
      throw new Error(
        `Peer direction revision ${directionId}@${revision} has a broken predecessor.`,
      );
    }
    const payload = {
      id: record.id,
      directionId: record.directionId,
      revision: record.revision,
      sequence: record.sequence,
      title: record.title,
      body: record.body,
      summary: record.summary,
      affectedPaths: record.affectedPaths,
      provenance: record.provenance,
      conversationId: record.conversationId,
      previousHash: record.previousHash,
      idempotencyKey: record.idempotencyKey,
      controllerInstanceId: record.controllerInstanceId,
      controllerGeneration: record.controllerGeneration,
      createdAt: record.createdAt,
    };
    const expected = agentMeshHmac(
      "peer-direction-revision",
      `${record.previousHash ?? ""}\0${canonicalJson(payload)}`,
    );
    if (expected !== record.revisionHash) {
      throw new Error(
        `Peer direction revision ${directionId}@${revision} failed verification.`,
      );
    }
    return record;
  }

  private verifyDirectionTargetRow(row: Row): PeerDirectionTargetRecord {
    const target = parseDirectionTarget(row);
    if (target.state !== "acknowledged") {
      if (
        target.impact !== null ||
        target.note !== null ||
        target.observedGitHead !== null ||
        target.ackHash !== null ||
        target.acknowledgedAt !== null
      ) {
        throw new Error(
          `Peer direction target ${target.id} failed verification.`,
        );
      }
      return target;
    }
    if (
      !target.impact ||
      !target.memberId ||
      target.memberGeneration === null ||
      !target.acknowledgedAt ||
      !target.ackHash
    ) {
      throw new Error(
        `Peer direction target ${target.id} failed verification.`,
      );
    }
    const expected = agentMeshHmac(
      "peer-direction-ack",
      canonicalJson({
        id: target.id,
        directionId: target.directionId,
        revision: target.revision,
        agentId: target.agentId,
        memberId: target.memberId,
        memberGeneration: target.memberGeneration,
        state: target.state,
        impact: target.impact,
        note: target.note,
        observedGitHead: target.observedGitHead,
        createdAt: target.createdAt,
        acknowledgedAt: target.acknowledgedAt,
        updatedAt: target.updatedAt,
      }),
    );
    if (expected !== target.ackHash) {
      throw new Error(
        `Peer direction target ${target.id} failed verification.`,
      );
    }
    return target;
  }

  private requireDirectionTarget(
    targetId: string,
  ): PeerDirectionTargetRecord {
    const row = this.db
      .prepare(
        `SELECT targets.*
         FROM peer_direction_targets targets
         JOIN peer_directions directions ON directions.id = targets.direction_id
         WHERE targets.id = ? AND directions.origin = ?`,
      )
      .get(
        safeId(targetId, "directionTargetId"),
        this.origin,
      ) as Row | undefined;
    if (!row) throw new Error(`Unknown peer direction target: ${targetId}`);
    return this.verifyDirectionTargetRow(row);
  }

  private directionPublicationInternal(
    directionId: string,
    revision: number,
  ): PeerDirectionPublication {
    const direction = this.requireDirection(directionId);
    const revisionRecord = this.requireDirectionRevision(
      directionId,
      revision,
    );
    const targets = (
      this.db
        .prepare(
          `SELECT targets.*
           FROM peer_direction_targets targets
           JOIN peer_directions directions ON directions.id = targets.direction_id
           WHERE targets.direction_id = ? AND targets.revision = ?
             AND directions.origin = ?
           ORDER BY targets.created_at ASC, targets.agent_id ASC`,
        )
        .all(directionId, revision, this.origin) as Row[]
    ).map((row) => this.verifyDirectionTargetRow(row));
    return { direction, revision: revisionRecord, targets };
  }

  private directionOutboxInternal(input: {
    directionId?: string;
    repoKey?: string;
    afterSequence: number;
    limit: number;
    includeHistory: boolean;
  }): PeerDirectionOutboxEntry[] {
    const where = [
      "directions.origin = ?",
      "revisions.sequence > ?",
    ];
    const parameters: Array<string | number> = [
      this.origin,
      input.afterSequence,
    ];
    if (input.directionId) {
      where.push("directions.id = ?");
      parameters.push(input.directionId);
    }
    if (input.repoKey) {
      where.push("directions.repo_key = ?");
      parameters.push(input.repoKey);
    }
    if (!input.includeHistory) {
      where.push("revisions.revision = directions.current_revision");
    }
    parameters.push(input.limit);
    const rows = this.db
      .prepare(
        `SELECT revisions.direction_id, revisions.revision
         FROM peer_direction_revisions revisions
         JOIN peer_directions directions ON directions.id = revisions.direction_id
         WHERE ${where.join(" AND ")}
         ORDER BY revisions.sequence ASC LIMIT ?`,
      )
      .all(...parameters) as Row[];
    return rows.map((row) =>
      this.directionPublicationInternal(
        text(row.direction_id),
        Number(row.revision),
      ),
    );
  }

  private applicableDirectionInternal(
    directionId: string,
    revision: number,
    agentId: string,
  ): PeerApplicableDirection {
    const publication = this.directionPublicationInternal(
      directionId,
      revision,
    );
    const target = publication.targets.find(
      (candidate) => candidate.agentId === agentId,
    );
    if (!target) {
      throw new Error("Applicable direction target is missing.");
    }
    return {
      direction: publication.direction,
      revision: publication.revision,
      target,
    };
  }

  private directionContextInternal(
    agentId: string,
  ): PeerApplicableDirection[] {
    const rows = this.db
      .prepare(
        `SELECT targets.direction_id, targets.revision
         FROM peer_direction_targets targets
         JOIN peer_directions directions ON directions.id = targets.direction_id
         JOIN peer_direction_revisions revisions
           ON revisions.direction_id = targets.direction_id
          AND revisions.revision = targets.revision
         WHERE directions.origin = ? AND targets.agent_id = ?
           AND targets.revision = directions.current_revision
         ORDER BY revisions.sequence ASC`,
      )
      .all(this.origin, agentId) as Row[];
    return rows.map((row) =>
      this.applicableDirectionInternal(
        text(row.direction_id),
        Number(row.revision),
        agentId,
      ),
    );
  }

  private captureAgentGitHead(agentId: string): string | null {
    const agent = this.agentResolver(agentId);
    if (!agent?.worktreePath || !agent.locationVerified) return null;
    try {
      const head = execFileSync(
        getGitBinary(),
        ["-C", agent.worktreePath, "rev-parse", "--verify", "HEAD"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
          maxBuffer: 4_096,
        },
      ).trim();
      return /^[0-9a-f]{40,64}$/i.test(head) ? head : null;
    } catch {
      return null;
    }
  }

  private ensureRepositoryChannel(repoKey: string, label: string): PeerChannelRecord {
    const safeRepoKey = safeId(repoKey, "repoKey");
    const existing = this.db
      .prepare(
        `SELECT * FROM peer_channels
         WHERE origin = ? AND kind = 'repository' AND source_repo_key = ?
           AND status = 'open'`,
      )
      .get(this.origin, safeRepoKey) as Row | undefined;
    if (existing) return this.getChannel(text(existing.id));
    const now = this.now().toISOString();
    const id = randomUUID();
    const channelHash = agentMeshHmac(
      "peer-channel",
      canonicalJson({
        id,
        origin: this.origin,
        kind: "repository",
        label: boundedText(label, "channel label", 200),
        sourceRepoKey: safeRepoKey,
        destinationRepoKey: null,
        bidirectional: true,
        messageLimit: DEFAULT_REPO_MESSAGE_LIMIT,
        byteLimit: DEFAULT_REPO_BYTE_LIMIT,
        createdAt: now,
      }),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO peer_channels
           (id, origin, kind, label, status, source_repo_key,
            destination_repo_key, bidirectional, wake_policy, policy_version,
            policy_digest, message_limit, byte_limit, message_count, byte_count,
            expires_at, channel_hash, created_at, updated_at, closed_at)
           VALUES (?, ?, 'repository', ?, 'open', ?, NULL, 1, 'off', 1, NULL,
             ?, ?, 0, 0, NULL, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          this.origin,
          boundedText(label, "channel label", 200),
          safeRepoKey,
          DEFAULT_REPO_MESSAGE_LIMIT,
          DEFAULT_REPO_BYTE_LIMIT,
          channelHash,
          now,
          now,
        );
      this.appendAuditInternal({
        entityType: "channel",
        entityId: id,
        event: "created",
        data: { kind: "repository", repoKey: safeRepoKey },
        createdAt: now,
      });
      this.db.exec("COMMIT");
      return this.getChannel(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      const raced = this.db
        .prepare(
          `SELECT * FROM peer_channels
           WHERE origin = ? AND kind = 'repository' AND source_repo_key = ?
             AND status = 'open'`,
        )
        .get(this.origin, safeRepoKey) as Row | undefined;
      if (raced) return this.getChannel(text(raced.id));
      throw error;
    }
  }

  private revokeMismatchedMemberships(agent: TrafficAgentRecord): void {
    const rows = this.db
      .prepare(
        `SELECT * FROM peer_members
         WHERE origin = ? AND agent_id = ? AND status = 'active'
           AND repo_key <> ?`,
      )
      .all(this.origin, agent.id, agent.repoKey) as Row[];
    if (!rows.length) return;
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const memberId = text(row.id);
        this.db
          .prepare(
            `UPDATE peer_members
             SET status = 'revoked', generation = generation + 1,
                 revoked_at = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(now, now, memberId);
        this.db
          .prepare(
            `UPDATE peer_deliveries
             SET state = 'dead_letter', reason = 'repository_binding_changed',
                 updated_at = ?
             WHERE recipient_member_id = ?
               AND state IN ('pending', 'leased', 'handed_off')`,
          )
          .run(now, memberId);
        this.db
          .prepare(
            `UPDATE peer_resource_leases
             SET status = 'expired', released_at = ?, updated_at = ?
             WHERE holder_member_id = ? AND status = 'active'`,
          )
          .run(now, now, memberId);
        this.appendAuditInternal({
          entityType: "member",
          entityId: memberId,
          event: "repository_binding_revoked",
          data: {
            priorRepoKey: text(row.repo_key),
            currentRepoKey: agent.repoKey,
          },
          createdAt: now,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureMembership(
    channelId: string,
    agent: TrafficAgentRecord,
    metadata: {
      taskId?: string;
      runId?: string;
      sessionId?: string;
      role?: string;
      assignment?: unknown;
      ownership?: string[];
      acceptanceCriteria?: string[];
      observedGitHead?: string;
    },
  ): PeerMemberRecord {
    const existing = this.db
      .prepare(
        `SELECT * FROM peer_members
         WHERE channel_id = ? AND agent_id = ? AND status = 'active'`,
      )
      .get(channelId, agent.id) as Row | undefined;
    if (existing) {
      const member = parseMember(existing);
      this.bindMemberSession({
        agentId: agent.id,
        taskId: metadata.taskId,
        runId: metadata.runId,
        sessionId: metadata.sessionId,
      });
      return metadata.role || metadata.assignment || metadata.ownership || metadata.acceptanceCriteria
        ? this.configureMember({ memberId: member.id, ...metadata })
        : this.requireMember(member.id);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const member = this.insertMembership(channelId, agent, metadata);
      this.db.exec("COMMIT");
      return member;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMembership(
    channelId: string,
    agent: TrafficAgentRecord,
    metadata: {
      taskId?: string;
      runId?: string;
      sessionId?: string;
      role?: string;
      assignment?: unknown;
      ownership?: string[];
      acceptanceCriteria?: string[];
      observedGitHead?: string;
    },
  ): PeerMemberRecord {
    const channel = this.requireOpenChannel(channelId);
    const memberCount = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM peer_members WHERE channel_id = ? AND status = 'active'",
      )
      .get(channel.id) as Row;
    if (Number(memberCount.count) >= MAX_MEMBERS_PER_CHANNEL) {
      throw new Error("Peer channel membership limit reached.");
    }
    const role = metadata.role
      ? boundedText(metadata.role, "role", 160)
      : null;
    const assignmentJson = canonicalJson(metadata.assignment ?? null);
    const ownershipJson = canonicalJson(
      (metadata.ownership ?? []).map((item) =>
        boundedText(item, "ownership path", 2_000),
      ),
    );
    const acceptanceJson = canonicalJson(
      (metadata.acceptanceCriteria ?? []).map((item) =>
        boundedText(item, "acceptance criterion", 4_000),
      ),
    );
    for (const value of [assignmentJson, ownershipJson, acceptanceJson]) {
      if (Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new RangeError("Member coordination metadata exceeds the size bound.");
      }
      if (redactSecrets(value) !== value) {
        throw new Error(
          "Member coordination metadata may contain a secret and was not accepted.",
        );
      }
    }
    if (
      metadata.observedGitHead &&
      !/^[0-9a-f]{40,64}$/i.test(metadata.observedGitHead)
    ) {
      throw new Error("observedGitHead must be a commit hash.");
    }
    const id = randomUUID();
    const now = this.now().toISOString();
    const membershipHash = agentMeshHmac(
      "peer-membership",
      canonicalJson({
        id,
        origin: this.origin,
        channelId: channel.id,
        agentId: agent.id,
        repoKey: agent.repoKey,
        joinedAt: now,
      }),
    );
    this.db
      .prepare(
        `INSERT INTO peer_members
         (id, origin, channel_id, agent_id, repo_key, generation, status,
          role, assignment_json, ownership_json, acceptance_json, task_id,
          run_id, session_id, observed_git_head, membership_hash,
          joined_at, updated_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        this.origin,
        channel.id,
        agent.id,
        agent.repoKey,
        role,
        assignmentJson,
        ownershipJson,
        acceptanceJson,
        metadata.taskId ?? null,
        metadata.runId ?? null,
        metadata.sessionId ?? agent.sessionId,
        metadata.observedGitHead ?? null,
        membershipHash,
        now,
        now,
      );
    this.appendAuditInternal({
      entityType: "member",
      entityId: id,
      event: "enrolled",
      data: {
        channelId: channel.id,
        agentId: agent.id,
        repoKey: agent.repoKey,
        generation: 1,
      },
      createdAt: now,
    });
    this.backfillDirectionTargetsInternal(this.requireMember(id), now);
    return this.requireMember(id);
  }

  private requireMember(memberId: string): PeerMemberRecord {
    const row = this.db
      .prepare("SELECT * FROM peer_members WHERE id = ? AND origin = ?")
      .get(safeId(memberId, "memberId"), this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown peer member: ${memberId}`);
    const member = parseMember(row);
    const expected = agentMeshHmac(
      "peer-membership",
      canonicalJson({
        id: member.id,
        origin: member.origin,
        channelId: member.channelId,
        agentId: member.agentId,
        repoKey: member.repoKey,
        joinedAt: member.joinedAt,
      }),
    );
    if (expected !== text(row.membership_hash)) {
      throw new Error(`Peer membership ${member.id} failed verification.`);
    }
    return member;
  }

  private memberForAgentChannel(
    agentId: string,
    channelId: string,
  ): PeerMemberRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM peer_members
         WHERE origin = ? AND agent_id = ? AND channel_id = ?
           AND status = 'active'`,
      )
      .get(
        this.origin,
        safeId(agentId, "agentId"),
        safeId(channelId, "channelId"),
      ) as Row | undefined;
    if (!row) {
      throw new Error("Managed agent is not a member of the recipient channel.");
    }
    return this.requireMember(text(row.id));
  }

  private settleBinding(column: "task_id" | "run_id", value: string): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM peer_members
         WHERE origin = ? AND ${column} = ? AND status = 'active'`,
      )
      .all(this.origin, value) as Row[];
    if (!rows.length) return;
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE peer_members
             SET ${column} = NULL, generation = generation + 1, updated_at = ?
             WHERE id = ? AND origin = ? AND ${column} = ? AND status = 'active'`,
          )
          .run(now, text(row.id), this.origin, value);
        this.appendAuditInternal({
          entityType: "member",
          entityId: text(row.id),
          event: "execution_binding_settled",
          data: { binding: column, valueDigest: digest(value) },
          createdAt: now,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireMessage(messageId: string): PeerMessageRecord {
    const row = this.db
      .prepare("SELECT * FROM peer_messages WHERE id = ?")
      .get(safeId(messageId, "messageId")) as Row | undefined;
    if (!row) throw new Error(`Unknown peer message: ${messageId}`);
    return this.verifyMessageRow(row);
  }

  private verifyMessageRow(row: Row): PeerMessageRecord {
    const message = parseMessage(row);
    const payloadJson = text(row.payload_json);
    const bodyDigest = agentMeshHmac(
      "peer-message-body",
      `${message.channelId}\0${message.body ?? ""}\0${payloadJson}`,
    );
    if (bodyDigest !== message.bodyDigest) {
      throw new Error(`Peer message ${message.id} failed body verification.`);
    }
    const envelope = {
      id: message.id,
      channelId: message.channelId,
      sequence: message.sequence,
      senderMemberId: message.senderMemberId,
      senderGeneration: message.senderGeneration,
      recipientMemberId: message.recipientMemberId,
      kind: message.kind,
      bodyDigest: message.bodyDigest,
      bodyBytes: message.bodyBytes,
      replyTo: message.replyTo,
      causalRoot: message.causalRoot,
      causalParent: message.causalParent,
      causalPath: message.causalPath,
      hopCount: message.hopCount,
      clientMessageId: message.clientMessageId,
      requestDigest: message.requestDigest,
      sourceMessageId: message.sourceMessageId,
      createdAt: message.createdAt,
    };
    const expected = agentMeshHmac(
      "peer-message-envelope",
      canonicalJson(envelope),
    );
    if (expected !== message.envelopeHash) {
      throw new Error(`Peer message ${message.id} failed envelope verification.`);
    }
    return message;
  }

  private requireDelivery(deliveryId: string): PeerDeliveryRecord {
    const row = this.db
      .prepare("SELECT * FROM peer_deliveries WHERE id = ? AND origin = ?")
      .get(safeId(deliveryId, "deliveryId"), this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown peer delivery: ${deliveryId}`);
    const delivery = parseDelivery(row);
    const message = this.requireMessage(delivery.messageId);
    if (
      delivery.channelId !== message.channelId ||
      delivery.recipientMemberId !== message.recipientMemberId ||
      delivery.sequence !== message.sequence
    ) {
      throw new Error(`Peer delivery ${delivery.id} routing verification failed.`);
    }
    const expected = agentMeshHmac(
      "peer-delivery-envelope",
      canonicalJson({
        id: delivery.id,
        origin: delivery.origin,
        messageId: delivery.messageId,
        channelId: delivery.channelId,
        recipientMemberId: delivery.recipientMemberId,
        sequence: delivery.sequence,
        cursor: delivery.cursor,
        createdAt: delivery.createdAt,
      }),
    );
    if (expected !== text(row.delivery_hash)) {
      throw new Error(`Peer delivery ${delivery.id} failed verification.`);
    }
    this.requireMember(delivery.recipientMemberId);
    return delivery;
  }

  private deliveryForMessage(messageId: string): PeerDeliveryRecord {
    const row = this.db
      .prepare("SELECT * FROM peer_deliveries WHERE message_id = ?")
      .get(safeId(messageId, "messageId")) as Row | undefined;
    if (!row) throw new Error(`Message has no peer delivery: ${messageId}`);
    return this.requireDelivery(text(row.id));
  }

  private requireReceipt(receiptId: string): PeerReceiptRecord {
    const row = this.db
      .prepare("SELECT * FROM peer_receipts WHERE id = ?")
      .get(safeId(receiptId, "receiptId")) as Row | undefined;
    if (!row) throw new Error(`Unknown peer receipt: ${receiptId}`);
    const receipt = parseReceipt(row);
    const expected = agentMeshHmac(
      "peer-receipt-envelope",
      canonicalJson({
        id: receipt.id,
        channelId: receipt.channelId,
        memberId: receipt.memberId,
        kind: receipt.kind,
        key: receipt.key,
        version: receipt.version,
        previousReceiptHash: nullableText(row.previous_receipt_hash),
        payloadDigest: agentMeshHmac(
          "peer-receipt",
          text(row.payload_json),
        ),
        observedDigest: agentMeshHmac(
          "peer-observed",
          text(row.observed_json),
        ),
        status: receipt.status,
        createdAt: receipt.createdAt,
      }),
    );
    const storedReceiptHash = text(row.receipt_hash);
    let legacySignature = false;
    if (expected !== storedReceiptHash) {
      const legacyExpected = agentMeshHmac(
        "peer-receipt-envelope",
        canonicalJson({
          id: receipt.id,
          channelId: receipt.channelId,
          memberId: receipt.memberId,
          kind: receipt.kind,
          key: receipt.key,
          version: receipt.version,
          payloadDigest: agentMeshHmac(
            "peer-receipt",
            text(row.payload_json),
          ),
          observedDigest: agentMeshHmac(
            "peer-observed",
            text(row.observed_json),
          ),
          status: receipt.status,
          createdAt: receipt.createdAt,
        }),
      );
      if (legacyExpected !== storedReceiptHash) {
        throw new Error(`Peer receipt ${receipt.id} failed verification.`);
      }
      legacySignature = true;
    }
    const head = this.db
      .prepare(
        `SELECT * FROM peer_receipt_heads
         WHERE channel_id = ? AND member_id = ? AND kind = ?
           AND receipt_key = ? AND current_receipt_id = ?`,
      )
      .get(
        receipt.channelId,
        receipt.memberId,
        receipt.kind,
        receipt.key,
        receipt.id,
      ) as Row | undefined;
    if (head) {
      const expectedHead = agentMeshHmac(
        "peer-receipt-head",
        `${nullableText(row.previous_receipt_hash) ?? ""}\0${storedReceiptHash}`,
      );
      if (
        Number(head.version) !== receipt.version ||
        text(head.head_hash) !== expectedHead
      ) {
        throw new Error(`Peer receipt ${receipt.id} head verification failed.`);
      }
      const auditEntityId = agentMeshHmac(
        "peer-receipt-key",
        `${receipt.channelId}\0${receipt.memberId}\0${receipt.kind}\0${receipt.key}`,
      );
      const audit = this.db
        .prepare(
          `SELECT * FROM peer_audit_events
           WHERE origin = ? AND entity_type = 'receipt_head'
             AND entity_id = ?
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get(this.origin, auditEntityId) as Row | undefined;
      if (!legacySignature) {
        this.verifyAuditState();
        if (!audit) {
          throw new Error(
            `Peer receipt ${receipt.id} is missing its audited head.`,
          );
        }
      }
      if (audit) {
        this.verifyAuditRow(audit);
        const data = safeJson<Record<string, unknown>>(
          audit.data_json,
          {},
        );
        if (
          data.currentReceiptId !== receipt.id ||
          data.headHash !== expectedHead ||
          Number(data.version) !== receipt.version
        ) {
          throw new Error(
            `Peer receipt ${receipt.id} does not match its audited head.`,
          );
        }
      }
    }
    return receipt;
  }

  private requireResourcePolicy(
    channelId: string,
    resourceName: string,
  ): PeerResourcePolicy {
    const row = this.db
      .prepare(
        `SELECT * FROM peer_resource_policies
         WHERE channel_id = ? AND resource_name = ?`,
      )
      .get(
        safeId(channelId, "channelId"),
        safeResource(resourceName),
      ) as Row | undefined;
    if (!row) throw new Error("Unknown named peer resource.");
    return parseResourcePolicy(row);
  }

  private requireResourceLease(leaseId: string): PeerResourceLease {
    const row = this.db
      .prepare("SELECT * FROM peer_resource_leases WHERE id = ?")
      .get(safeId(leaseId, "leaseId")) as Row | undefined;
    if (!row) throw new Error(`Unknown peer resource lease: ${leaseId}`);
    return parseResourceLease(row);
  }

  private listActiveLeases(channelId: string): PeerResourceLease[] {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE peer_resource_leases SET status = 'expired', released_at = ?,
           updated_at = ?
         WHERE channel_id = ? AND status = 'active' AND expires_at <= ?`,
      )
      .run(now, now, channelId, now);
    return (
      this.db
        .prepare(
          `SELECT * FROM peer_resource_leases
           WHERE channel_id = ? AND status = 'active'
           ORDER BY resource_name ASC`,
        )
        .all(channelId) as Row[]
    ).map(parseResourceLease);
  }

  private requireWake(jobId: string): PeerWakeJob {
    const row = this.db
      .prepare("SELECT * FROM peer_wake_jobs WHERE id = ? AND origin = ?")
      .get(safeId(jobId, "jobId"), this.origin) as Row | undefined;
    if (!row) throw new Error(`Unknown peer wake job: ${jobId}`);
    return parseWake(row);
  }

  private requireOpenChannel(channelId: string): PeerChannelRecord {
    const channel = this.getChannel(channelId);
    if (
      channel.status !== "open" ||
      (channel.expiresAt && Date.parse(channel.expiresAt) <= this.now().getTime())
    ) {
      throw new Error("Peer channel is closed or expired.");
    }
    return channel;
  }

  private assertAdminFence(fence?: PeerFenceInput): void {
    if (!fence) return;
    if (typeof fence === "function") {
      fence();
      return;
    }
    if (!this.hasTrafficAttachment) {
      throw new Error("Peer administration requires attached traffic authority.");
    }
    const row = this.db
      .prepare(
        `SELECT owner_instance_id, generation, expires_at
         FROM traffic_control.traffic_controller_leases
         WHERE lease_key = 'local-controller'`,
      )
      .get() as Row | undefined;
    if (
      !row ||
      text(row.owner_instance_id) !== fence.ownerInstanceId ||
      Number(row.generation) !== fence.generation ||
      Date.parse(text(row.expires_at)) <= this.now().getTime()
    ) {
      throw new Error(
        "Peer administration controller generation changed before commit.",
      );
    }
  }

  private requireEligibleAgent(agentId: string): TrafficAgentRecord {
    const agent = this.agentResolver(safeId(agentId, "agentId"));
    if (
      !agent ||
      agent.origin !== this.origin ||
      !["mesh-cli", "sdk-local"].includes(agent.lane) ||
      (agent.lane === "mesh-cli" && agent.provider === "cursor") ||
      !agent.repoKey ||
      !agent.locationVerified
    ) {
      throw new Error("Managed agent is not eligible for authenticated peer channels.");
    }
    return agent;
  }

  private assertDirection(
    channel: PeerChannelRecord,
    sender: PeerMemberRecord,
    recipient: PeerMemberRecord,
  ): void {
    if (channel.kind !== "bridge") {
      if (
        sender.repoKey !== channel.sourceRepoKey ||
        recipient.repoKey !== channel.sourceRepoKey
      ) {
        throw new Error("Repository channel membership does not match its repository.");
      }
      return;
    }
    const forward =
      sender.repoKey === channel.sourceRepoKey &&
      recipient.repoKey === channel.destinationRepoKey;
    const reverse =
      channel.bidirectional &&
      sender.repoKey === channel.destinationRepoKey &&
      recipient.repoKey === channel.sourceRepoKey;
    if (!forward && !reverse) throw new Error("Bridge direction does not permit this message.");
  }

  private enforceSendLimits(
    channel: PeerChannelRecord,
    sender: PeerMemberRecord,
    recipient: PeerMemberRecord,
  ): void {
    const minuteAgo = new Date(this.now().getTime() - 60_000).toISOString();
    const memberRate = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM peer_messages WHERE sender_member_id = ? AND created_at >= ?",
      )
      .get(sender.id, minuteAgo) as Row;
    if (Number(memberRate.count) >= SENDS_PER_MEMBER_PER_MINUTE) {
      throw new Error("Peer member send rate exceeded.");
    }
    const channelRate = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM peer_messages WHERE channel_id = ? AND created_at >= ?",
      )
      .get(channel.id, minuteAgo) as Row;
    if (Number(channelRate.count) >= SENDS_PER_CHANNEL_PER_MINUTE) {
      throw new Error("Peer channel send rate exceeded.");
    }
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM peer_deliveries
         WHERE recipient_member_id = ?
           AND state IN ('pending', 'leased', 'handed_off')`,
      )
      .get(recipient.id) as Row;
    if (Number(pending.count) >= MAX_PENDING_PER_MEMBER) {
      throw new Error("Peer recipient pending-delivery quota reached.");
    }
  }

  private purgeChannelInternal(channelId: string, now: Date): void {
    const acknowledgedBefore = new Date(
      now.getTime() - 7 * 24 * 60 * 60_000,
    ).toISOString();
    const deadBefore = new Date(
      now.getTime() - 30 * 24 * 60 * 60_000,
    ).toISOString();
    const removable = this.db
      .prepare(
        `SELECT messages.id
         FROM peer_messages messages
         JOIN peer_deliveries deliveries ON deliveries.message_id = messages.id
         WHERE messages.channel_id = ?
           AND (
             (deliveries.state = 'acknowledged' AND deliveries.acknowledged_at <= ?)
             OR
             (deliveries.state = 'dead_letter' AND deliveries.updated_at <= ?)
           )`,
      )
      .all(channelId, acknowledgedBefore, deadBefore) as Row[];
    for (const row of removable) {
      const messageId = text(row.id);
      this.db
        .prepare("DELETE FROM peer_deliveries WHERE message_id = ?")
        .run(messageId);
      this.db
        .prepare("DELETE FROM peer_messages WHERE id = ?")
        .run(messageId);
    }
    this.db
      .prepare(
        `UPDATE peer_channels
         SET message_count = (
               SELECT COUNT(*) FROM peer_messages WHERE channel_id = ?
             ),
             byte_count = COALESCE((
               SELECT SUM(body_bytes) FROM peer_messages WHERE channel_id = ?
             ), 0),
             updated_at = ?
         WHERE id = ? AND origin = ?`,
      )
      .run(
        channelId,
        channelId,
        now.toISOString(),
        channelId,
        this.origin,
      );
    this.db
      .prepare(
        `DELETE FROM peer_receipts
         WHERE channel_id = ? AND updated_at <= ?
           AND id NOT IN (
             SELECT current_receipt_id FROM peer_receipt_heads
             WHERE channel_id = ?
           )`,
      )
      .run(channelId, acknowledgedBefore, channelId);
    this.db
      .prepare(
        `DELETE FROM peer_resource_leases
         WHERE channel_id = ? AND status IN ('released', 'expired')
           AND updated_at <= ?`,
      )
      .run(channelId, deadBefore);
  }

  private maybeEnqueueWakeInternal(
    channel: PeerChannelRecord,
    recipient: PeerMemberRecord,
    kind: PeerMessageKind,
    sequence: number,
    causalRoot: string,
    causalPath: string[],
    now: Date,
  ): void {
    if (
      channel.kind !== "repository" ||
      channel.wakePolicy !== "coordination" ||
      !["request", "dependency_ready", "blocker_resolved", "lease_grant"].includes(kind)
    ) {
      return;
    }
    const existing = this.db
      .prepare(
        `SELECT * FROM peer_wake_jobs
         WHERE origin = ? AND channel_id = ? AND recipient_member_id = ?
           AND causal_root = ? AND policy_version = ?
           AND state = 'pending'`,
      )
      .get(
        this.origin,
        channel.id,
        recipient.id,
        causalRoot,
        channel.policyVersion,
      ) as Row | undefined;
    const nowIso = now.toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE peer_wake_jobs
           SET last_sequence = MAX(last_sequence, ?),
               message_count = message_count + 1, updated_at = ?
           WHERE id = ? AND origin = ? AND state = 'pending'`,
        )
        .run(sequence, nowIso, text(existing.id), this.origin);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO peer_wake_jobs
         (id, origin, channel_id, recipient_member_id, recipient_agent_id,
          first_sequence, last_sequence, message_count, causal_root,
          causal_path_json, state,
          policy_version, available_at, lease_owner, controller_generation,
          lease_expires_at, external_ref, attempts, reason, created_at,
          updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending', ?, ?, NULL, NULL,
           NULL, NULL, 0, NULL, ?, ?, NULL)`,
      )
      .run(
        randomUUID(),
        this.origin,
        channel.id,
        recipient.id,
        recipient.agentId,
        sequence,
        sequence,
        causalRoot,
        canonicalJson(causalPath),
        channel.policyVersion,
        new Date(now.getTime() + DEFAULT_WAKE_DEBOUNCE_MS).toISOString(),
        nowIso,
        nowIso,
      );
  }

  private wakeSuppressionReason(job: PeerWakeJob, now: Date): string | null {
    const channel = this.getChannel(job.channelId);
    if (
      channel.status !== "open" ||
      channel.kind !== "repository" ||
      channel.wakePolicy !== "coordination" ||
      channel.policyVersion !== job.policyVersion
    ) {
      return "wake_policy_stale";
    }
    const member = this.requireMember(job.recipientMemberId);
    if (member.status !== "active") return "recipient_revoked";
    const agent = this.agentResolver(member.agentId);
    if (
      !agent ||
      agent.lane === "sdk-cloud" ||
      !agent.locationVerified ||
      !agent.peerReadOnly
    ) {
      return "recipient_not_wakeable";
    }
    const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const cooldown = new Date(now.getTime() - 5 * 60_000).toISOString();
    const count = (where: string, ...args: Array<string | number>): number =>
      Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM peer_wake_jobs
               WHERE origin = ?
                 AND state IN ('leased', 'started', 'completed', 'failed', 'ambiguous')
                 AND ${where}`,
            )
            .get(this.origin, ...args) as Row
        ).count,
      );
    if (
      count(
        "recipient_member_id = ? AND id <> ? AND updated_at >= ?",
        member.id,
        job.id,
        cooldown,
      ) > 0 ||
      count("recipient_member_id = ? AND updated_at >= ?", member.id, hourAgo) >=
        WAKE_TARGET_HOURLY ||
      count("recipient_member_id = ? AND updated_at >= ?", member.id, dayAgo) >=
        WAKE_TARGET_DAILY ||
      count("channel_id = ? AND updated_at >= ?", channel.id, hourAgo) >=
        WAKE_CHANNEL_HOURLY ||
      count("channel_id = ? AND updated_at >= ?", channel.id, dayAgo) >=
        WAKE_CHANNEL_DAILY ||
      count("causal_root = ?", job.causalRoot) >= MAX_CAUSAL_HOPS
    ) {
      return "wake_budget_exhausted";
    }
    return null;
  }

  private wakeDeferralReason(job: PeerWakeJob): string | null {
    const member = this.requireMember(job.recipientMemberId);
    const agent = this.agentResolver(member.agentId);
    if (!agent) return null;
    if (
      ["running", "launching", "stale"].includes(agent.status) ||
      agent.forceLocalNextSend
    ) {
      return "recipient_temporarily_unavailable";
    }
    return null;
  }

  private recoverExpired(): void {
    const now = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expiredChannels = this.db
        .prepare(
          `SELECT id FROM peer_channels
           WHERE origin = ? AND status = 'open'
             AND expires_at IS NOT NULL AND expires_at <= ?`,
        )
        .all(this.origin, now) as Row[];
      for (const row of expiredChannels) {
        const channelId = text(row.id);
        this.db
          .prepare(
            `UPDATE peer_channels
             SET status = 'closed', closed_at = ?, updated_at = ?
             WHERE id = ? AND origin = ? AND status = 'open'`,
          )
          .run(now, now, channelId, this.origin);
        this.db
          .prepare(
            `UPDATE peer_members
             SET status = 'revoked', generation = generation + 1,
                 revoked_at = ?, updated_at = ?
             WHERE channel_id = ? AND status = 'active'`,
          )
          .run(now, now, channelId);
        this.db
          .prepare(
            `UPDATE peer_deliveries
             SET state = 'dead_letter', reason = 'channel_expired',
                 updated_at = ?
             WHERE channel_id = ?
               AND state IN ('pending', 'leased', 'handed_off')`,
          )
          .run(now, channelId);
        this.db
          .prepare(
            `UPDATE peer_resource_leases
             SET status = 'expired', released_at = ?, updated_at = ?
             WHERE channel_id = ? AND status = 'active'`,
          )
          .run(now, now, channelId);
        this.appendAuditInternal({
          entityType: "channel",
          entityId: channelId,
          event: "expired",
          data: {},
          createdAt: now,
        });
      }
      this.db
        .prepare(
          `UPDATE peer_resource_leases SET status = 'expired',
             released_at = ?, updated_at = ?
           WHERE status = 'active' AND expires_at <= ?`,
        )
        .run(now, now, now);
      this.db
        .prepare(
          `UPDATE peer_wake_jobs
           SET state = CASE WHEN external_ref IS NULL THEN 'pending' ELSE 'ambiguous' END,
             lease_owner = NULL, controller_generation = NULL,
             lease_expires_at = NULL, reason = 'registry_restart', updated_at = ?
           WHERE origin = ? AND state IN ('leased', 'started')
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .run(now, this.origin, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendAuditInternal(input: {
    entityType: string;
    entityId: string;
    event: string;
    data: unknown;
    createdAt: string;
  }): void {
    const dataJson = canonicalJson(input.data);
    if (Buffer.byteLength(dataJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new RangeError("Peer audit data exceeds the size bound.");
    }
    const predecessor = this.db
      .prepare(
        `SELECT hash FROM peer_audit_events
         WHERE origin = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.origin) as Row | undefined;
    const sequenceRow = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM peer_audit_events")
      .get() as Row;
    const sequence = Number(sequenceRow.sequence);
    const previousHash = predecessor ? text(predecessor.hash) : null;
    const payload = {
      sequence,
      origin: this.origin,
      entityType: input.entityType,
      entityId: input.entityId,
      event: input.event,
      data: input.data,
      previousHash,
      createdAt: input.createdAt,
    };
    const hash = agentMeshHmac(
      "peer-audit",
      `${previousHash ?? ""}\0${canonicalJson(payload)}`,
    );
    this.db
      .prepare(
        `INSERT INTO peer_audit_events
         (sequence, origin, entity_type, entity_id, event, data_json,
          previous_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequence,
        this.origin,
        input.entityType,
        input.entityId,
        input.event,
        dataJson,
        previousHash,
        hash,
        input.createdAt,
      );
    const stateHash = agentMeshHmac(
      "peer-audit-state",
      canonicalJson({
        origin: this.origin,
        lastSequence: sequence,
        lastHash: hash,
        updatedAt: input.createdAt,
      }),
    );
    this.db
      .prepare(
        `INSERT INTO peer_audit_state
         (origin, last_sequence, last_hash, state_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(origin) DO UPDATE SET
           last_sequence = excluded.last_sequence,
           last_hash = excluded.last_hash,
           state_hash = excluded.state_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.origin,
        sequence,
        hash,
        stateHash,
        input.createdAt,
      );
  }

  private verifyAuditRow(row: Row): void {
    const sequence = Number(row.sequence);
    const predecessor = this.db
      .prepare(
        `SELECT hash FROM peer_audit_events
         WHERE origin = ? AND sequence < ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(text(row.origin), sequence) as Row | undefined;
    const previousHash = predecessor ? text(predecessor.hash) : null;
    if (nullableText(row.previous_hash) !== previousHash) {
      throw new Error(`Peer audit event ${sequence} has a broken predecessor.`);
    }
    const data = safeJson(row.data_json, {});
    const expected = agentMeshHmac(
      "peer-audit",
      `${previousHash ?? ""}\0${canonicalJson({
        sequence,
        origin: text(row.origin),
        entityType: text(row.entity_type),
        entityId: text(row.entity_id),
        event: text(row.event),
        data,
        previousHash,
        createdAt: text(row.created_at),
      })}`,
    );
    if (expected !== text(row.hash)) {
      throw new Error(`Peer audit event ${sequence} failed verification.`);
    }
  }

  private verifyAuditState(): void {
    const state = this.db
      .prepare(
        "SELECT * FROM peer_audit_state WHERE origin = ?",
      )
      .get(this.origin) as Row | undefined;
    const latest = this.db
      .prepare(
        `SELECT sequence, hash, created_at FROM peer_audit_events
         WHERE origin = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(this.origin) as Row | undefined;
    if (!state && !latest) return;
    if (!state || !latest) {
      throw new Error("Peer audit state does not match its event chain.");
    }
    const sequence = Number(latest.sequence);
    const hash = text(latest.hash);
    const updatedAt = text(state.updated_at);
    const expected = agentMeshHmac(
      "peer-audit-state",
      canonicalJson({
        origin: this.origin,
        lastSequence: sequence,
        lastHash: hash,
        updatedAt,
      }),
    );
    if (
      Number(state.last_sequence) !== sequence ||
      nullableText(state.last_hash) !== hash ||
      text(state.state_hash) !== expected
    ) {
      throw new Error("Peer audit state failed monotonic verification.");
    }
  }
}

export interface PeerWakeExecutor {
  controllerLease(): {
    active: boolean;
    ownerInstanceId: string | null;
    generation: number;
  };
  wake(job: PeerWakeJob): Promise<{ externalRef: string }>;
}

export class PeerWakePump {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly registry: PeerChannelRegistry,
    private readonly executor: PeerWakeExecutor,
    private readonly intervalMs = 2_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) {
      await Promise.race([
        this.active.catch(() => undefined),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
      ]);
    }
  }

  kick(): void {
    if (this.stopped || this.active) return;
    const run = this.tick()
      .catch(() => undefined)
      .finally(() => {
        if (this.active === run) this.active = undefined;
      });
    this.active = run;
  }

  private async tick(): Promise<void> {
    const lease = this.executor.controllerLease();
    if (!lease.active || !lease.ownerInstanceId || lease.generation < 1) return;
    const job = this.registry.claimWake({
      controllerId: lease.ownerInstanceId,
      controllerGeneration: lease.generation,
    });
    if (!job) return;
    try {
      const result = await this.executor.wake(job);
      this.registry.markWakeStarted({
        jobId: job.id,
        controllerId: lease.ownerInstanceId,
        controllerGeneration: lease.generation,
        externalRef: result.externalRef,
      });
      this.registry.settleWake({
        jobId: job.id,
        controllerId: lease.ownerInstanceId,
        controllerGeneration: lease.generation,
        status: "completed",
      });
    } catch (error) {
      const reason = redactSecrets(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 2_000);
      const ambiguous = /ambiguous|idempotency|side effect/iu.test(reason);
      try {
        if (/not eligible|running|launching|stale|temporarily/iu.test(reason)) {
          this.registry.deferWake({
            jobId: job.id,
            controllerId: lease.ownerInstanceId,
            controllerGeneration: lease.generation,
            reason,
          });
          return;
        }
        this.registry.settleWake({
          jobId: job.id,
          controllerId: lease.ownerInstanceId,
          controllerGeneration: lease.generation,
          status: ambiguous ? "ambiguous" : "failed",
          reason,
        });
      } catch {
        // Controller generation takeover or lease expiry owns reconciliation.
      }
    }
  }
}

export function loadBridgeAllowlistFile(input: {
  path: string;
  resolveRepoKey: (path: string) => Promise<string>;
}): Promise<BridgeAllowlistEntry[]> {
  const path = resolve(input.path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let source: string;
  try {
    const info = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      !info.isFile() ||
      info.size > 64 * 1024 ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      (uid !== undefined && info.uid !== uid)
    ) {
      throw new Error(
        "Peer bridge allowlist must be a bounded private owner file.",
      );
    }
    source = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const parsed = JSON.parse(source) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 256) {
    throw new Error("Peer bridge allowlist must be a bounded JSON array.");
  }
  return Promise.all(
    parsed.map(async (entry, index) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).source !== "string" ||
        typeof (entry as Record<string, unknown>).destination !== "string" ||
        Object.keys(entry as Record<string, unknown>).some(
          (key) => !["source", "destination"].includes(key),
        )
      ) {
        throw new Error(`Invalid bridge allowlist entry at index ${index}.`);
      }
      const sourceRepoKey = await input.resolveRepoKey(
        (entry as { source: string }).source,
      );
      const destinationRepoKey = await input.resolveRepoKey(
        (entry as { destination: string }).destination,
      );
      if (sourceRepoKey === destinationRepoKey) {
        throw new Error(`Bridge allowlist entry ${index} resolves to one repository.`);
      }
      return { sourceRepoKey, destinationRepoKey };
    }),
  );
}

function toolObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Peer tool input must be an object.");
  }
  return value as Record<string, unknown>;
}

function toolString(
  value: unknown,
  name: string,
  maximum = 16_384,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  return boundedText(value, name, maximum);
}

function toolNumber(
  value: unknown,
  name: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number") throw new TypeError(`${name} must be a number.`);
  return boundedInteger(value, name, 0, maximum);
}

function sdkResult(value: unknown): SDKJsonValue {
  return JSON.parse(JSON.stringify(value)) as SDKJsonValue;
}

export function createSdkPeerTools(input: {
  registry: PeerChannelRegistry;
  binding: () => ManagedPeerBinding;
}): Record<string, SDKCustomTool> {
  const { registry, binding } = input;
  return {
    peer_channels_list: {
      description:
        "List authenticated peer channels and memberships for this managed agent.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        const current = binding();
        registry.assertBinding(current);
        return sdkResult(
          registry.listChannels(current.agentId).map((channel) => ({
            channel,
            members: registry.listMembers(channel.id),
          })),
        );
      },
    },
    peer_context_get: {
      description:
        "Fetch compact assignment, applicable human directions, changed peer deliveries, receipts, blockers, and leases.",
      inputSchema: {
        type: "object",
        properties: {
          after_sequence: { type: "number" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        return sdkResult(
          registry.context(
            binding(),
            toolNumber(value.after_sequence, "after_sequence", 0, Number.MAX_SAFE_INTEGER),
            toolNumber(value.limit, "limit", 100, 500),
          ),
        );
      },
    },
    peer_direction_ack: {
      description:
        "Acknowledge one applicable human direction and report its impact.",
      inputSchema: {
        type: "object",
        properties: {
          direction_id: { type: "string" },
          revision: { type: "number" },
          impact: {
            type: "string",
            enum: [
              "applies",
              "no-impact",
              "conflict-needs-clarity",
            ],
          },
          note: { type: "string" },
        },
        required: ["direction_id", "revision", "impact"],
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        const impact = toolString(
          value.impact,
          "impact",
          64,
        ) as PeerDirectionImpact;
        if (
          !["applies", "no-impact", "conflict-needs-clarity"].includes(
            impact,
          )
        ) {
          throw new Error("Unsupported direction impact.");
        }
        return sdkResult(
          registry.acknowledgeDirection({
            binding: binding(),
            directionId: toolString(
              value.direction_id,
              "direction_id",
              512,
            )!,
            revision: toolNumber(
              value.revision,
              "revision",
              1,
              Number.MAX_SAFE_INTEGER,
            ),
            impact,
            note: toolString(
              value.note,
              "note",
              MAX_DIRECTION_NOTE_BYTES,
              true,
            ),
          }),
        );
      },
    },
    peer_status_update: {
      description:
        "Publish a typed coordination delta instead of repeating a full global status report.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...PEER_RECEIPT_KINDS] },
          key: { type: "string" },
          payload: {},
          observed: {},
          status: { type: "string", enum: ["active", "resolved"] },
        },
        required: ["kind", "key", "payload"],
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        const kind = toolString(value.kind, "kind", 64) as PeerReceiptKind;
        if (!PEER_RECEIPT_KINDS.includes(kind)) throw new Error("Unsupported receipt kind.");
        return sdkResult(
          registry.recordReceipt({
            binding: binding(),
            kind,
            key: toolString(value.key, "key", 128)!,
            payload: value.payload,
            observed: value.observed,
            status:
              value.status === undefined
                ? undefined
                : value.status === "active" || value.status === "resolved"
                  ? value.status
                  : (() => {
                      throw new Error("Invalid receipt status.");
                    })(),
          }),
        );
      },
    },
    peer_send: {
      description:
        "Send a directed, durable peer message as this authenticated managed agent.",
      inputSchema: {
        type: "object",
        properties: {
          recipient_member_id: { type: "string" },
          kind: { type: "string", enum: [...PEER_MESSAGE_KINDS] },
          body: { type: "string" },
          payload: {},
          reply_to: { type: "string" },
          client_message_id: { type: "string" },
        },
        required: ["recipient_member_id", "kind", "client_message_id"],
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        const kind = toolString(value.kind, "kind", 64) as PeerMessageKind;
        if (!PEER_MESSAGE_KINDS.includes(kind)) throw new Error("Unsupported message kind.");
        return sdkResult(
          registry.send({
            binding: binding(),
            recipientMemberId: toolString(
              value.recipient_member_id,
              "recipient_member_id",
              512,
            )!,
            kind,
            body: toolString(value.body, "body", MAX_SAME_REPO_BODY_BYTES, true),
            payload: value.payload,
            replyTo: toolString(value.reply_to, "reply_to", 512, true),
            clientMessageId: toolString(
              value.client_message_id,
              "client_message_id",
              512,
            )!,
          }),
        );
      },
    },
    peer_inbox: {
      description: "Read directed peer deliveries after a monotonic sequence cursor.",
      inputSchema: {
        type: "object",
        properties: {
          after_sequence: { type: "number" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        return sdkResult(
          registry.inbox(
            binding(),
            toolNumber(value.after_sequence, "after_sequence", 0, Number.MAX_SAFE_INTEGER),
            toolNumber(value.limit, "limit", 100, 500),
          ),
        );
      },
    },
    peer_ack: {
      description: "Acknowledge one peer delivery owned by this authenticated recipient.",
      inputSchema: {
        type: "object",
        properties: { delivery_id: { type: "string" } },
        required: ["delivery_id"],
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        return sdkResult(
          registry.acknowledge(
            binding(),
            toolString(value.delivery_id, "delivery_id", 512)!,
          ),
        );
      },
    },
    peer_reply_and_ack: {
      description: "Atomically create a causal reply and acknowledge its source delivery.",
      inputSchema: {
        type: "object",
        properties: {
          delivery_id: { type: "string" },
          kind: { type: "string", enum: [...PEER_MESSAGE_KINDS] },
          body: { type: "string" },
          payload: {},
          client_message_id: { type: "string" },
        },
        required: ["delivery_id", "kind", "client_message_id"],
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        const kind = toolString(value.kind, "kind", 64) as PeerMessageKind;
        if (!PEER_MESSAGE_KINDS.includes(kind)) throw new Error("Unsupported message kind.");
        return sdkResult(
          registry.replyAndAcknowledge({
            binding: binding(),
            deliveryId: toolString(value.delivery_id, "delivery_id", 512)!,
            kind,
            body: toolString(value.body, "body", MAX_SAME_REPO_BODY_BYTES, true),
            payload: value.payload,
            clientMessageId: toolString(
              value.client_message_id,
              "client_message_id",
              512,
            )!,
          }),
        );
      },
    },
    peer_lease_acquire: {
      description: "Acquire or renew a controller-defined named shared-resource lease.",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string" },
          ttl_ms: { type: "number" },
        },
        required: ["resource", "ttl_ms"],
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        return sdkResult(
          registry.acquireResource({
            binding: binding(),
            name: toolString(value.resource, "resource", 128)!,
            ttlMs: toolNumber(value.ttl_ms, "ttl_ms", 60_000, 24 * 60 * 60_000),
          }),
        );
      },
    },
    peer_lease_release: {
      description: "Release a named shared-resource lease held by this member.",
      inputSchema: {
        type: "object",
        properties: { lease_id: { type: "string" } },
        required: ["lease_id"],
        additionalProperties: false,
      },
      execute: (args) => {
        const value = toolObject(args);
        return sdkResult(
          registry.releaseResource(
            binding(),
            toolString(value.lease_id, "lease_id", 512)!,
          ),
        );
      },
    },
  };
}

function mcpResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent:
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { value: data },
  };
}

function mcpFailure(error: unknown) {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 4_000);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ message }, null, 2) }],
    structuredContent: { message },
    isError: true,
  };
}

export function registerBoundPeerTools(input: {
  server: McpServer;
  registry: PeerChannelRegistry;
  binding: ManagedPeerBinding;
}): void {
  const { server, registry, binding } = input;
  server.registerTool(
    "peer_channels_list",
    {
      title: "List managed peer channels",
      description: "List authenticated channels for this bound managed agent.",
      inputSchema: {},
    },
    async () => {
      try {
        registry.assertBinding(binding);
        return mcpResponse(
          registry.listChannels(binding.agentId).map((channel) => ({
            channel,
            members: registry.listMembers(channel.id),
          })),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_context_get",
    {
      title: "Read compact peer context",
      description:
        "Read assignment, applicable human directions, changed deliveries, structured receipts, blockers, and leases without rebuilding global state.",
      inputSchema: {
        after_sequence: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ after_sequence, limit }) => {
      try {
        return mcpResponse(
          registry.context(binding, after_sequence, limit),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_direction_ack",
    {
      title: "Acknowledge human direction",
      description:
        "Acknowledge one applicable direction and report whether it applies, has no impact, or conflicts.",
      inputSchema: {
        direction_id: z.string().uuid(),
        revision: z.number().int().min(1),
        impact: z.enum([
          "applies",
          "no-impact",
          "conflict-needs-clarity",
        ]),
        note: z.string().min(1).max(MAX_DIRECTION_NOTE_BYTES).optional(),
      },
    },
    async ({ direction_id, revision, impact, note }) => {
      try {
        return mcpResponse(
          registry.acknowledgeDirection({
            binding,
            directionId: direction_id,
            revision,
            impact,
            note,
          }),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_status_update",
    {
      title: "Publish peer status delta",
      description:
        "Publish one typed status/checkpoint/dependency/handoff/blocker/finding/decision delta.",
      inputSchema: {
        kind: z.enum(PEER_RECEIPT_KINDS),
        key: z.string().regex(RESOURCE_PATTERN),
        payload: z.unknown(),
        observed: z.unknown().optional(),
        status: z.enum(["active", "resolved"]).default("active"),
      },
    },
    async ({ kind, key, payload, observed, status }) => {
      try {
        return mcpResponse(
          registry.recordReceipt({
            binding,
            kind,
            key,
            payload,
            observed,
            status,
          }),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_send",
    {
      title: "Send managed peer message",
      description:
        "Send a directed durable message. Sender and channel identity are fixed by this server.",
      inputSchema: {
        recipient_member_id: z.string().uuid(),
        kind: z.enum(PEER_MESSAGE_KINDS),
        body: z.string().min(1).max(MAX_SAME_REPO_BODY_BYTES).optional(),
        payload: z.unknown().optional(),
        reply_to: z.string().uuid().optional(),
        client_message_id: z.string().min(1).max(512),
      },
    },
    async ({
      recipient_member_id,
      kind,
      body,
      payload,
      reply_to,
      client_message_id,
    }) => {
      try {
        return mcpResponse(
          registry.send({
            binding,
            recipientMemberId: recipient_member_id,
            kind,
            body,
            payload,
            replyTo: reply_to,
            clientMessageId: client_message_id,
          }),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_inbox",
    {
      title: "Read peer inbox",
      description: "Read directed peer deliveries after a monotonic cursor.",
      inputSchema: {
        after_sequence: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ after_sequence, limit }) => {
      try {
        return mcpResponse(registry.inbox(binding, after_sequence, limit));
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_wait",
    {
      title: "Wait for peer delivery",
      description: "Bounded long-poll for a relevant directed delivery.",
      inputSchema: {
        after_sequence: z.number().int().min(0).default(0),
        timeout_ms: z.number().int().min(0).max(120_000).default(30_000),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ after_sequence, timeout_ms, limit }) => {
      try {
        return mcpResponse(
          await registry.wait(binding, after_sequence, timeout_ms, limit),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_ack",
    {
      title: "Acknowledge peer delivery",
      description: "Acknowledge one delivery owned by this recipient.",
      inputSchema: { delivery_id: z.string().uuid() },
    },
    async ({ delivery_id }) => {
      try {
        return mcpResponse(registry.acknowledge(binding, delivery_id));
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_reply_and_ack",
    {
      title: "Reply and acknowledge peer delivery",
      description: "Create a causal reply and acknowledge the source delivery.",
      inputSchema: {
        delivery_id: z.string().uuid(),
        kind: z.enum(PEER_MESSAGE_KINDS),
        body: z.string().min(1).max(MAX_SAME_REPO_BODY_BYTES).optional(),
        payload: z.unknown().optional(),
        client_message_id: z.string().min(1).max(512),
      },
    },
    async ({ delivery_id, kind, body, payload, client_message_id }) => {
      try {
        return mcpResponse(
          registry.replyAndAcknowledge({
            binding,
            deliveryId: delivery_id,
            kind,
            body,
            payload,
            clientMessageId: client_message_id,
          }),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_lease_acquire",
    {
      title: "Acquire named coordination lease",
      description:
        "Acquire or renew a controller-defined shared-resource lease as this member.",
      inputSchema: {
        resource: z.string().regex(RESOURCE_PATTERN),
        ttl_ms: z.number().int().min(1_000).max(24 * 60 * 60_000),
      },
    },
    async ({ resource, ttl_ms }) => {
      try {
        return mcpResponse(
          registry.acquireResource({ binding, name: resource, ttlMs: ttl_ms }),
        );
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
  server.registerTool(
    "peer_lease_release",
    {
      title: "Release named coordination lease",
      description: "Release a named shared-resource lease held by this member.",
      inputSchema: { lease_id: z.string().uuid() },
    },
    async ({ lease_id }) => {
      try {
        return mcpResponse(registry.releaseResource(binding, lease_id));
      } catch (error) {
        return mcpFailure(error);
      }
    },
  );
}
