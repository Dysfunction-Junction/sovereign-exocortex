import { createHash } from "node:crypto";

import type {
  PeerAuditEvent,
  PeerChannelRegistry,
  PeerDirectionOutboxEntry,
  PeerFrictionEvent,
  PeerMemberRecord,
  PeerResourceLease,
} from "./peer-channels.js";
import type { TaskRegistry } from "./registry.js";
import { redactSecrets } from "./security.js";
import type {
  TrafficAgentRecord,
  TrafficAuditEvent,
  TrafficControlRegistry,
} from "./traffic-control.js";
import type {
  Origin,
  QuestionRecord,
  TaskRecord,
  TaskStatus,
} from "./types.js";

// MESH[2026-07-25T19:32Z][agent:codex][direction:user/1]
// What: added an origin-scoped, resumable supervision aggregator and bounded long-poll.
// Why: parent orchestrators need one metadata-only view of coordination changes and risks.
// Aligns-with: direction user revision 1 (supervision aggregation and observation-only remedies).
// Status: complete

export const SUPERVISION_STREAMS = [
  "directions",
  "agents",
  "friction",
  "progress",
  "questions",
  "leases",
] as const;
export type SupervisionStream = (typeof SUPERVISION_STREAMS)[number];

export type SupervisionSeverity = "low" | "medium" | "high";

export interface SupervisionThresholds {
  unacknowledgedDirectionMs: number;
  thrashingWindowMs: number;
  thrashingOccurrences: number;
  stalledAgentMs: number;
  fallbackWindowMs: number;
  fallbackOccurrences: number;
  leaseExpiryRiskMs: number;
}

// Ten minutes is long enough to avoid flagging normal direction handoff latency.
export const DEFAULT_UNACKNOWLEDGED_DIRECTION_MS = 10 * 60_000;
// A fifteen-minute window catches tight retry loops without retaining old incidents.
export const DEFAULT_THRASHING_WINDOW_MS = 15 * 60_000;
// Two matching incidents establish recurrence; a single collision is not thrashing.
export const DEFAULT_THRASHING_OCCURRENCES = 2;
// Five quiet minutes is material for an agent that still claims to be running.
export const DEFAULT_STALLED_AGENT_MS = 5 * 60_000;
// Capacity fallbacks are grouped over fifteen minutes to separate bursts from history.
export const DEFAULT_FALLBACK_WINDOW_MS = 15 * 60_000;
// Two fallbacks indicate provider pressure; exhaustion is material immediately.
export const DEFAULT_FALLBACK_OCCURRENCES = 2;
// Thirty seconds leaves time for a cooperative holder to renew or release its lease.
export const DEFAULT_LEASE_EXPIRY_RISK_MS = 30_000;

export const DEFAULT_SUPERVISION_THRESHOLDS: Readonly<SupervisionThresholds> =
  Object.freeze({
    unacknowledgedDirectionMs: DEFAULT_UNACKNOWLEDGED_DIRECTION_MS,
    thrashingWindowMs: DEFAULT_THRASHING_WINDOW_MS,
    thrashingOccurrences: DEFAULT_THRASHING_OCCURRENCES,
    stalledAgentMs: DEFAULT_STALLED_AGENT_MS,
    fallbackWindowMs: DEFAULT_FALLBACK_WINDOW_MS,
    fallbackOccurrences: DEFAULT_FALLBACK_OCCURRENCES,
    leaseExpiryRiskMs: DEFAULT_LEASE_EXPIRY_RISK_MS,
  });

export interface SupervisionRemedy {
  action: string;
  description: string;
  reversible: boolean;
  safeToAutoApply: boolean;
  requiresHumanJudgment: boolean;
}

export interface SupervisionCondition {
  id: string;
  kind:
    | "unacknowledged_direction"
    | "open_direction_conflict"
    | "writer_contention"
    | "thrashing"
    | "stalled_agent"
    | "fallback_pressure"
    | "lease_expiry_risk";
  severity: SupervisionSeverity;
  evidence: Record<string, unknown>;
  remedy: SupervisionRemedy;
}

export interface SupervisionDirectionEvent {
  eventId: string;
  kind: "revision_published" | "acknowledged";
  directionId: string;
  revision: number;
  sequence: number | null;
  repo: string;
  disposition: "active" | "withdrawn";
  provenance: "hook_prompt" | "controller";
  publishedBy: string;
  agentId: string | null;
  impact: "applies" | "no-impact" | "conflict-needs-clarity" | null;
  occurredAt: string;
  pendingTargetIds: string[];
}

export interface SupervisionAgentEvent {
  eventId: string;
  kind: "enrolled" | "withdrawn" | "status_transition" | "updated";
  agentId: string;
  fromStatus: string | null;
  toStatus: string | null;
  status: string | null;
  lane: string | null;
  provider: string | null;
  model: string | null;
  repo: string | null;
  occurredAt: string;
}

export interface SupervisionFrictionEvent {
  eventId: string;
  id: string;
  repo: string;
  occurredAt: string;
  kind: PeerFrictionEvent["kind"];
  severity: PeerFrictionEvent["severity"];
  provider: PeerFrictionEvent["provider"];
  model: string | null;
  agentId: string | null;
  reference: string | null;
  detail: string;
}

export interface SupervisionProgressEvent {
  eventId: string;
  kind: "task_transition" | "wave_transition" | "gate_transition";
  taskId: string | null;
  runId: string | null;
  waveId: string | null;
  gateId: string | null;
  provider: string | null;
  fromStatus: string | null;
  toStatus: string;
  requestedModel: string | null;
  actualModel: string | null;
  fallbackCount: number;
  repo: string | null;
  occurredAt: string;
}

export interface SupervisionQuestionEvent {
  eventId: string;
  kind: "pending" | "answered";
  questionId: string;
  taskId: string;
  provider: string;
  delivery: string;
  occurredAt: string;
  repo: string | null;
}

export interface SupervisionLeaseEvent {
  eventId: string;
  kind: "acquired" | "renewed" | "contention" | "released" | "expired";
  leaseId: string | null;
  channelId: string | null;
  resource: string | null;
  holderMemberId: string | null;
  holderAgentId: string | null;
  generation: number | null;
  expiresAt: string | null;
  repo: string | null;
  occurredAt: string;
}

export interface SupervisionDelta {
  directions: SupervisionDirectionEvent[];
  agents: SupervisionAgentEvent[];
  friction: SupervisionFrictionEvent[];
  progress: SupervisionProgressEvent[];
  questions: SupervisionQuestionEvent[];
  leases: SupervisionLeaseEvent[];
}

export interface SupervisionSummary {
  materialEventCount: number;
  conditionsChanged: boolean;
  byStream: Record<SupervisionStream, number>;
  conditionCount: number;
  highestSeverity: SupervisionSeverity | null;
  text: string;
}

export interface SupervisionResult {
  protocol: "agent-mesh-supervision/v1";
  delta: SupervisionDelta;
  conditions: SupervisionCondition[];
  summary: SupervisionSummary;
  nextCursor: string;
  timedOut?: boolean;
}

export interface SupervisionPollInput {
  afterCursor?: string;
  repo?: string;
  include?: readonly SupervisionStream[];
  limit?: number;
}

export interface SupervisionWatchInput extends SupervisionPollInput {
  timeoutMs?: number;
}

export interface SupervisionTaskSource {
  search(options: {
    origin: TaskRecord["origin"];
    limit: number;
  }): TaskRecord[];
  transitions(taskId: string): Array<{
    sequence: number;
    taskId: string;
    fromStatus: TaskStatus | null;
    toStatus: TaskStatus;
    occurredAt: string;
  }>;
  listQuestions(options: {
    origin: Origin;
    limit: number;
  }): QuestionRecord[];
}

export interface SupervisionOrchestrationEvent {
  sequence: number;
  runId: string | null;
  entityType: string;
  entityId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: string;
}

export interface SupervisionOrchestrationSource {
  auditEvents(runId?: string, limit?: number): SupervisionOrchestrationEvent[];
}

interface LeaseCursorEntry {
  i: string;
  u: string;
  x: string;
  g: number;
}

interface SupervisionCursorV1 {
  v: 1;
  o: Origin;
  d: number;
  at: number;
  ap: number;
  f: number;
  pt: number;
  po: number;
  q: string;
  l: number;
  la: LeaseCursorEntry[];
  c: string;
}

export interface SupervisionAgentEvidence {
  id: string;
  status: string;
  isWriter?: boolean;
  repoKey: string | null;
  repoLabel: string | null;
  lastSeenAt: string;
  lastEventAt: string | null;
}

export interface SupervisionMemberEvidence {
  id: string;
  agentId: string;
  repoKey: string;
  status: "active" | "revoked";
  ownership: string[];
}

export interface SupervisionLeaseEvidence {
  id: string;
  channelId: string;
  resourceName: string;
  holderMemberId: string;
  generation: number;
  status: "active" | "released" | "expired";
  acquiredAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface SupervisionConditionEvidence {
  directions: PeerDirectionOutboxEntry[];
  agents: SupervisionAgentEvidence[];
  members: SupervisionMemberEvidence[];
  friction: PeerFrictionEvent[];
  leases: SupervisionLeaseEvidence[];
}

export interface MeshSupervisorOptions {
  origin: Origin;
  peerRegistry: PeerChannelRegistry;
  trafficRegistry: TrafficControlRegistry;
  taskRegistry?: TaskRegistry | SupervisionTaskSource;
  orchestration?: SupervisionOrchestrationSource;
  now?: () => Date;
  thresholds?: Partial<SupervisionThresholds>;
}

const EMPTY_DELTA = (): SupervisionDelta => ({
  directions: [],
  agents: [],
  friction: [],
  progress: [],
  questions: [],
  leases: [],
});

const REMEDIES = {
  nudgeDirection: {
    action: "nudge_agent",
    description:
      "Nudge the target to refresh peer context and acknowledge the current direction before continuing.",
    reversible: true,
    safeToAutoApply: true,
    requiresHumanJudgment: false,
  },
  resolveConflict: {
    action: "resolve_human_conflict",
    description:
      "A human must decide the conflicting intent and publish a resolving direction revision.",
    reversible: false,
    safeToAutoApply: false,
    requiresHumanJudgment: true,
  },
  redeclareOwnership: {
    action: "redeclare_ownership",
    description:
      "Pause the colliding write attempt and re-declare disjoint ownership before retrying.",
    reversible: true,
    safeToAutoApply: true,
    requiresHumanJudgment: false,
  },
  stopThrashing: {
    action: "nudge_and_redeclare_ownership",
    description:
      "Nudge the affected agent, refresh its context, and narrow ownership before another retry.",
    reversible: true,
    safeToAutoApply: true,
    requiresHumanJudgment: false,
  },
  nudgeStalled: {
    action: "nudge_agent",
    description:
      "Nudge the running agent for a status checkpoint; leave cancellation to the caller.",
    reversible: true,
    safeToAutoApply: true,
    requiresHumanJudgment: false,
  },
  probeFallback: {
    action: "redispatch_read_only_probe",
    description:
      "Re-dispatch a read-only provider probe or wait for capacity before retrying implementation work.",
    reversible: true,
    safeToAutoApply: true,
    requiresHumanJudgment: false,
  },
  renewLease: {
    action: "nudge_lease_holder",
    description:
      "Nudge the working holder to renew or cooperatively release the lease before expiry.",
    reversible: true,
    safeToAutoApply: true,
    requiresHumanJudgment: false,
  },
} satisfies Record<string, SupervisionRemedy>;

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function safeText(value: string | null | undefined, limit = 512): string | null {
  if (value === null || value === undefined) return null;
  return redactSecrets(value).slice(0, limit);
}

function safeDetail(value: string, limit = 1_000): string {
  return (safeText(value, limit) ?? "")
    .replace(/(^|[\s("'`])\/[^\s"'`<>(){}[\]]+/gu, "$1[PATH]")
    .replace(
      /(^|[\s("'`])[A-Za-z]:\\[^\s"'`<>(){}[\]]+/gu,
      "$1[PATH]",
    );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function conditionId(kind: SupervisionCondition["kind"], parts: string[]): string {
  const digest = createHash("sha256")
    .update([kind, ...parts].join("\0"))
    .digest("hex")
    .slice(0, 16);
  return `${kind}:${digest}`;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestInstant(...values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => instant(right) - instant(left))[0] ?? new Date(0).toISOString();
}

function pathsOverlap(left: string, right: string): boolean {
  const prefix = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
    const wildcard = normalized.search(/[*?[\]{}]/);
    return (wildcard >= 0 ? normalized.slice(0, wildcard) : normalized)
      .replace(/\/+$/, "");
  };
  const a = prefix(left);
  const b = prefix(right);
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function repoMatches(
  repo: string | undefined,
  repoKey: string | null | undefined,
  repoLabel?: string | null,
): boolean {
  return !repo || repo === repoKey || repo === repoLabel;
}

function severityRank(value: SupervisionSeverity): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function conditionsFingerprint(conditions: SupervisionCondition[]): string {
  return createHash("sha256")
    .update(
      conditions
        .map((condition) => `${condition.id}:${condition.severity}`)
        .sort()
        .join("\n"),
    )
    .digest("base64url")
    .slice(0, 16);
}

function encodeCursor(cursor: SupervisionCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  encoded: string | undefined,
  origin: Origin,
): SupervisionCursorV1 {
  if (!encoded) {
    return {
      v: 1,
      o: origin,
      d: 0,
      at: 0,
      ap: 0,
      f: 0,
      pt: 0,
      po: 0,
      q: "",
      l: 0,
      la: [],
      c: "",
    };
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<SupervisionCursorV1>;
    if (
      parsed.v !== 1 ||
      parsed.o !== origin ||
      ![parsed.d, parsed.at, parsed.ap, parsed.f, parsed.pt, parsed.po, parsed.l].every(
        (value) => Number.isSafeInteger(value) && Number(value) >= 0,
      ) ||
      typeof parsed.q !== "string" ||
      typeof parsed.c !== "string" ||
      !Array.isArray(parsed.la)
    ) {
      throw new Error("invalid");
    }
    const leases = parsed.la.map((entry) => {
      const candidate = entry as Partial<LeaseCursorEntry>;
      if (
        typeof candidate.i !== "string" ||
        typeof candidate.u !== "string" ||
        typeof candidate.x !== "string" ||
        !Number.isSafeInteger(candidate.g)
      ) {
        throw new Error("invalid");
      }
      return candidate as LeaseCursorEntry;
    });
    return {
      v: 1,
      o: origin,
      d: Number(parsed.d),
      at: Number(parsed.at),
      ap: Number(parsed.ap),
      f: Number(parsed.f),
      pt: Number(parsed.pt),
      po: Number(parsed.po),
      q: parsed.q,
      l: Number(parsed.l),
      la: leases,
      c: parsed.c,
    };
  } catch {
    throw new Error("Invalid or incompatible supervision cursor.");
  }
}

function questionEventKey(
  occurredAt: string,
  questionId: string,
  kind: SupervisionQuestionEvent["kind"],
): string {
  return `${occurredAt}\0${questionId}\0${kind === "pending" ? "0" : "1"}`;
}

function scanPeerAudit(
  registry: PeerChannelRegistry,
  afterSequence: number,
  limit: number,
  predicate: (event: PeerAuditEvent) => boolean,
): { events: PeerAuditEvent[]; cursor: number } {
  const selected: PeerAuditEvent[] = [];
  let scanned = afterSequence;
  let returned = afterSequence;
  while (selected.length < limit) {
    const page = registry.auditEvents(scanned, 500);
    if (!page.length) break;
    for (const event of page) {
      scanned = event.sequence;
      if (!predicate(event)) continue;
      selected.push(event);
      returned = event.sequence;
      if (selected.length === limit) break;
    }
    if (selected.length === limit || page.length < 500) break;
  }
  return { events: selected, cursor: returned };
}

function scanTrafficAudit(
  registry: TrafficControlRegistry,
  afterSequence: number,
  limit: number,
  predicate: (event: TrafficAuditEvent) => boolean,
): { events: TrafficAuditEvent[]; cursor: number } {
  const selected: TrafficAuditEvent[] = [];
  let scanned = afterSequence;
  let returned = afterSequence;
  while (selected.length < limit) {
    const page = registry.auditEvents(500, scanned);
    if (!page.length) break;
    for (const event of page) {
      scanned = event.sequence;
      if (!predicate(event)) continue;
      selected.push(event);
      returned = event.sequence;
      if (selected.length === limit) break;
    }
    if (selected.length === limit || page.length < 500) break;
  }
  return { events: selected, cursor: returned };
}

function allDirections(
  registry: PeerChannelRegistry,
  repo?: string,
): PeerDirectionOutboxEntry[] {
  const result: PeerDirectionOutboxEntry[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = registry.directionOutbox({
      repoKey: repo,
      afterSequence,
      limit: 500,
      includeHistory: false,
    });
    result.push(...page);
    if (page.length < 500) return result;
    afterSequence = page.at(-1)!.revision.sequence;
  }
}

function findDirectionRevision(
  registry: PeerChannelRegistry,
  directionId: string,
  revision: number,
  sequence: number | null,
): PeerDirectionOutboxEntry | undefined {
  if (sequence !== null) {
    return registry
      .directionOutbox({
        directionId,
        afterSequence: Math.max(0, sequence - 1),
        limit: 1,
        includeHistory: true,
      })
      .find((entry) => entry.revision.revision === revision);
  }
  let afterSequence = 0;
  for (;;) {
    const page = registry.directionOutbox({
      directionId,
      afterSequence,
      limit: 500,
      includeHistory: true,
    });
    const match = page.find((entry) => entry.revision.revision === revision);
    if (match || page.length < 500) return match;
    afterSequence = page.at(-1)!.revision.sequence;
  }
}

function peerInventory(registry: PeerChannelRegistry): {
  members: PeerMemberRecord[];
  leases: PeerResourceLease[];
  channelRepo: Map<string, string>;
} {
  const channels = registry.listChannels();
  const members = channels.flatMap((channel) => registry.listMembers(channel.id));
  const channelRepo = new Map(
    channels.map((channel) => [channel.id, channel.sourceRepoKey]),
  );
  const leases = new Map<string, PeerResourceLease>();
  for (const member of members) {
    if (member.status !== "active") continue;
    const binding = registry
      .memberBindings(member.agentId)
      .find((candidate) => candidate.memberId === member.id);
    if (!binding) continue;
    for (const lease of registry.context(binding, 0, 1).leases) {
      leases.set(lease.id, lease);
    }
  }
  return { members, leases: [...leases.values()], channelRepo };
}

export function deriveSupervisionConditions(
  evidence: SupervisionConditionEvidence,
  input: {
    now?: Date;
    thresholds?: Partial<SupervisionThresholds>;
  } = {},
): SupervisionCondition[] {
  const now = input.now?.getTime() ?? Date.now();
  const thresholds = {
    ...DEFAULT_SUPERVISION_THRESHOLDS,
    ...input.thresholds,
  };
  const conditions: SupervisionCondition[] = [];
  const agents = new Map(evidence.agents.map((agent) => [agent.id, agent]));
  const members = new Map(evidence.members.map((member) => [member.id, member]));

  for (const publication of evidence.directions) {
    if (publication.direction.disposition !== "active") continue;
    for (const target of publication.targets) {
      const ageMs = Math.max(0, now - instant(target.createdAt));
      if (
        target.state === "pending" &&
        ageMs >= thresholds.unacknowledgedDirectionMs
      ) {
        conditions.push({
          id: conditionId("unacknowledged_direction", [
            publication.direction.id,
            String(publication.revision.revision),
            target.agentId,
          ]),
          kind: "unacknowledged_direction",
          severity: "medium",
          evidence: {
            directionId: publication.direction.id,
            revision: publication.revision.revision,
            targetAgentId: target.agentId,
            pendingForMs: ageMs,
            thresholdMs: thresholds.unacknowledgedDirectionMs,
          },
          remedy: REMEDIES.nudgeDirection,
        });
      }
      if (
        target.state === "acknowledged" &&
        target.impact === "conflict-needs-clarity"
      ) {
        conditions.push({
          id: conditionId("open_direction_conflict", [
            publication.direction.id,
            String(publication.revision.revision),
            target.agentId,
          ]),
          kind: "open_direction_conflict",
          severity: "high",
          evidence: {
            directionId: publication.direction.id,
            revision: publication.revision.revision,
            targetAgentId: target.agentId,
            acknowledgedAt: target.acknowledgedAt,
          },
          remedy: REMEDIES.resolveConflict,
        });
      }
    }
  }

  const activeWriters = evidence.members.filter((member) => {
    const agent = agents.get(member.agentId);
    return (
      member.status === "active" &&
      Boolean(agent) &&
      ["launching", "running"].includes(agent!.status) &&
      agent!.isWriter !== false &&
      member.ownership.length > 0
    );
  });
  for (let leftIndex = 0; leftIndex < activeWriters.length; leftIndex += 1) {
    const left = activeWriters[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < activeWriters.length;
      rightIndex += 1
    ) {
      const right = activeWriters[rightIndex]!;
      if (left.agentId === right.agentId || left.repoKey !== right.repoKey) continue;
      const overlap = left.ownership.flatMap((leftPath) =>
        right.ownership
          .filter((rightPath) => pathsOverlap(leftPath, rightPath))
          .map((rightPath) => [leftPath, rightPath]),
      )[0];
      if (!overlap) continue;
      conditions.push({
        id: conditionId("writer_contention", [
          left.repoKey,
          ...[left.agentId, right.agentId].sort(),
          ...overlap,
        ]),
        kind: "writer_contention",
        severity: "high",
        evidence: {
          repo: left.repoKey,
          agentIds: [left.agentId, right.agentId].sort(),
          overlapCount: 1,
          ownershipDigests: overlap.map((path) =>
            createHash("sha256").update(path).digest("hex").slice(0, 16),
          ),
          source: "declared_ownership",
        },
        remedy: REMEDIES.redeclareOwnership,
      });
    }
  }

  const recentThrashing = evidence.friction.filter(
    (event) =>
      ["writer_collision", "finding_reopened", "stale_write_mismatch"].includes(
        event.kind,
      ) &&
      now - instant(event.occurredAt) <= thresholds.thrashingWindowMs,
  );
  const collisions = evidence.friction.filter(
    (event) =>
      event.kind === "writer_collision" &&
      now - instant(event.occurredAt) <= thresholds.thrashingWindowMs,
  );
  for (const event of collisions) {
    const target = event.agentId ?? event.reference ?? event.repoKey;
    conditions.push({
      id: conditionId("writer_contention", [
        event.repoKey,
        target,
        event.reference ?? event.id,
      ]),
      kind: "writer_contention",
      severity: event.severity === "low" ? "medium" : "high",
      evidence: {
        repo: event.repoKey,
        target,
        frictionEventId: event.id,
        source: "writer_collision",
      },
      remedy: REMEDIES.redeclareOwnership,
    });
  }
  const thrashingByTarget = new Map<string, PeerFrictionEvent[]>();
  for (const event of recentThrashing) {
    const target = event.agentId ?? event.reference ?? event.repoKey;
    const key = `${event.repoKey}\0${target}`;
    const events = thrashingByTarget.get(key) ?? [];
    events.push(event);
    thrashingByTarget.set(key, events);
  }
  for (const [key, events] of thrashingByTarget) {
    if (events.length < thresholds.thrashingOccurrences) continue;
    const [repo, target] = key.split("\0");
    conditions.push({
      id: conditionId("thrashing", [repo!, target!]),
      kind: "thrashing",
      severity: "high",
      evidence: {
        repo,
        target,
        occurrences: events.length,
        threshold: thresholds.thrashingOccurrences,
        windowMs: thresholds.thrashingWindowMs,
        kinds: [...new Set(events.map((event) => event.kind))].sort(),
        frictionEventIds: events.map((event) => event.id).sort(),
      },
      remedy: REMEDIES.stopThrashing,
    });
  }

  for (const agent of evidence.agents) {
    if (!["launching", "running"].includes(agent.status)) continue;
    const lastActivityAt = latestInstant(agent.lastSeenAt, agent.lastEventAt);
    const quietForMs = Math.max(0, now - instant(lastActivityAt));
    if (quietForMs < thresholds.stalledAgentMs) continue;
    conditions.push({
      id: conditionId("stalled_agent", [agent.id]),
      kind: "stalled_agent",
      severity: "medium",
      evidence: {
        agentId: agent.id,
        status: agent.status,
        lastActivityAt,
        quietForMs,
        thresholdMs: thresholds.stalledAgentMs,
      },
      remedy: REMEDIES.nudgeStalled,
    });
  }

  const fallbackByProvider = new Map<string, PeerFrictionEvent[]>();
  for (const event of evidence.friction) {
    if (
      !["model_fallback", "fallback_exhausted"].includes(event.kind) ||
      now - instant(event.occurredAt) > thresholds.fallbackWindowMs
    ) {
      continue;
    }
    const provider = event.provider ?? "unknown";
    const events = fallbackByProvider.get(provider) ?? [];
    events.push(event);
    fallbackByProvider.set(provider, events);
  }
  for (const [provider, events] of fallbackByProvider) {
    const exhausted = events.some((event) => event.kind === "fallback_exhausted");
    if (!exhausted && events.length < thresholds.fallbackOccurrences) continue;
    conditions.push({
      id: conditionId("fallback_pressure", [provider]),
      kind: "fallback_pressure",
      severity: exhausted ? "high" : "medium",
      evidence: {
        provider,
        occurrences: events.length,
        threshold: thresholds.fallbackOccurrences,
        windowMs: thresholds.fallbackWindowMs,
        exhausted,
        frictionEventIds: events.map((event) => event.id).sort(),
      },
      remedy: REMEDIES.probeFallback,
    });
  }

  for (const lease of evidence.leases) {
    if (lease.status !== "active") continue;
    const member = members.get(lease.holderMemberId);
    const agent = member ? agents.get(member.agentId) : undefined;
    if (!agent || !["launching", "running"].includes(agent.status)) continue;
    const remainingMs = instant(lease.expiresAt) - now;
    if (remainingMs < 0 || remainingMs > thresholds.leaseExpiryRiskMs) continue;
    conditions.push({
      id: conditionId("lease_expiry_risk", [lease.id]),
      kind: "lease_expiry_risk",
      severity: "medium",
      evidence: {
        leaseId: lease.id,
        resource: lease.resourceName,
        holderAgentId: agent.id,
        expiresAt: lease.expiresAt,
        remainingMs,
        thresholdMs: thresholds.leaseExpiryRiskMs,
      },
      remedy: REMEDIES.renewLease,
    });
  }

  const unique = new Map(conditions.map((condition) => [condition.id, condition]));
  return [...unique.values()].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
}

export class MeshSupervisor {
  readonly origin: Origin;
  private readonly peerRegistry: PeerChannelRegistry;
  private readonly trafficRegistry: TrafficControlRegistry;
  private readonly taskRegistry?: SupervisionTaskSource;
  private readonly orchestration?: SupervisionOrchestrationSource;
  private readonly now: () => Date;
  private readonly thresholds: SupervisionThresholds;

  constructor(options: MeshSupervisorOptions) {
    this.origin = options.origin;
    this.peerRegistry = options.peerRegistry;
    this.trafficRegistry = options.trafficRegistry;
    this.taskRegistry = options.taskRegistry;
    this.orchestration = options.orchestration;
    this.now = options.now ?? (() => new Date());
    this.thresholds = {
      ...DEFAULT_SUPERVISION_THRESHOLDS,
      ...options.thresholds,
    };
  }

  poll(input: SupervisionPollInput = {}): SupervisionResult {
    const limit = boundedInteger(input.limit ?? 100, "limit", 1, 500);
    const include = new Set(input.include ?? SUPERVISION_STREAMS);
    for (const stream of include) {
      if (!SUPERVISION_STREAMS.includes(stream)) {
        throw new Error("Unsupported supervision stream.");
      }
    }
    const cursor = decodeCursor(input.afterCursor, this.origin);
    const next = { ...cursor, la: [...cursor.la] };
    const delta = EMPTY_DELTA();
    const trafficAgents = this.trafficRegistry.listAgents();
    const trafficById = new Map(trafficAgents.map((agent) => [agent.id, agent]));
    const peerRepo =
      input.repo === undefined
        ? undefined
        : trafficAgents.find((agent) => agent.repoLabel === input.repo)
            ?.repoKey ?? input.repo;
    const inventory = peerInventory(this.peerRegistry);
    const memberById = new Map(inventory.members.map((member) => [member.id, member]));

    if (include.has("directions")) {
      const selected = scanPeerAudit(
        this.peerRegistry,
        cursor.d,
        limit,
        (event) => {
          if (
            !(
              (event.entityType === "direction" && event.event === "published") ||
              (event.entityType === "direction_target" &&
                event.event === "acknowledged")
            )
          ) {
            return false;
          }
          const data = record(event.data);
          const directionId =
            event.entityType === "direction"
              ? event.entityId
              : stringValue(data.directionId);
          const revision = numberValue(data.revision);
          if (!directionId || revision === null) return false;
          const publication = findDirectionRevision(
            this.peerRegistry,
            directionId,
            revision,
            numberValue(data.sequence),
          );
          return Boolean(
            publication &&
              repoMatches(
                input.repo,
                publication!.direction.repoKey,
                trafficAgents.find(
                  (agent) =>
                    agent.repoKey === publication!.direction.repoKey,
                )?.repoLabel,
              ),
          );
        },
      );
      next.d = selected.cursor;
      for (const event of selected.events) {
        const data = record(event.data);
        const directionId =
          event.entityType === "direction"
            ? event.entityId
            : stringValue(data.directionId)!;
        const revision = numberValue(data.revision)!;
        const sequence = numberValue(data.sequence);
        const publication = findDirectionRevision(
          this.peerRegistry,
          directionId,
          revision,
          sequence,
        );
        if (!publication) continue;
        delta.directions.push({
          eventId: `peer:${event.sequence}`,
          kind:
            event.entityType === "direction"
              ? "revision_published"
              : "acknowledged",
          directionId,
          revision,
          sequence: publication.revision.sequence,
          repo: publication.direction.repoKey,
          disposition: publication.direction.disposition,
          provenance: publication.revision.provenance,
          publishedBy:
            publication.revision.controllerInstanceId ??
            publication.revision.provenance,
          agentId:
            event.entityType === "direction_target"
              ? stringValue(data.agentId)
              : null,
          impact:
            event.entityType === "direction_target"
              ? (stringValue(data.impact) as SupervisionDirectionEvent["impact"])
              : null,
          occurredAt: event.createdAt,
          pendingTargetIds: publication.targets
            .filter((target) => target.state === "pending")
            .map((target) => target.agentId)
            .sort(),
        });
      }
    }

    if (include.has("agents")) {
      const traffic = scanTrafficAudit(
        this.trafficRegistry,
        cursor.at,
        limit,
        (event) => {
          if (event.entityType !== "agent") return false;
          const agent = trafficById.get(event.entityId);
          const data = record(event.data);
          return repoMatches(
            input.repo,
            agent?.repoKey ?? stringValue(data.repoKey),
            agent?.repoLabel,
          );
        },
      );
      next.at = traffic.cursor;
      for (const event of traffic.events) {
        const data = record(event.data);
        const agent = trafficById.get(event.entityId);
        delta.agents.push(
          this.agentEvent({
            eventId: `traffic:${event.sequence}`,
            event: event.event,
            eventData: data,
            agentId: event.entityId,
            agent,
            occurredAt: event.createdAt,
          }),
        );
      }
      const peer = scanPeerAudit(
        this.peerRegistry,
        cursor.ap,
        limit,
        (event) => {
          if (
            event.entityType !== "member" ||
            !["enrolled", "revoked", "repository_binding_revoked"].includes(
              event.event,
            )
          ) {
            return false;
          }
          const member = memberById.get(event.entityId);
          const data = record(event.data);
          return repoMatches(
            input.repo,
            member?.repoKey ??
              stringValue(data.repoKey) ??
              stringValue(data.priorRepoKey),
            member ? trafficById.get(member.agentId)?.repoLabel : null,
          );
        },
      );
      next.ap = peer.cursor;
      for (const event of peer.events) {
        const member = memberById.get(event.entityId);
        const data = record(event.data);
        const agentId = member?.agentId ?? stringValue(data.agentId);
        if (!agentId) continue;
        delta.agents.push(
          this.agentEvent({
            eventId: `peer:${event.sequence}`,
            event: event.event,
            eventData: data,
            agentId,
            agent: trafficById.get(agentId),
            occurredAt: event.createdAt,
          }),
        );
      }
      delta.agents.sort(
        (left, right) =>
          instant(left.occurredAt) - instant(right.occurredAt) ||
          left.eventId.localeCompare(right.eventId),
      );
    }

    if (include.has("friction")) {
      const frictionById = new Map(
        this.peerRegistry
          .frictionEvents({
            repoKey: peerRepo,
            limit: 5_000,
          })
          .map((event) => [event.id, event]),
      );
      const selected = scanPeerAudit(
        this.peerRegistry,
        cursor.f,
        limit,
        (event) =>
          event.entityType === "friction_event" &&
          event.event === "recorded" &&
          frictionById.has(event.entityId),
      );
      next.f = selected.cursor;
      delta.friction = selected.events.map((event) => {
        const friction = frictionById.get(event.entityId)!;
        return {
          eventId: `peer:${event.sequence}`,
          id: friction.id,
          repo: friction.repoKey,
          occurredAt: friction.occurredAt,
          kind: friction.kind,
          severity: friction.severity,
          provider: friction.provider,
          model: safeText(friction.model, 256),
          agentId: friction.agentId,
          reference: friction.reference,
          detail: safeDetail(friction.detail),
        };
      });
    }

    const tasks = this.taskRegistry?.search({
      origin: this.origin,
      limit: 5_000,
    }) ?? [];
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const taskRepo = new Map<string, { key: string | null; label: string | null }>();
    for (const task of tasks) {
      const agent = trafficAgents.find(
        (candidate) =>
          candidate.meshTaskId === task.id ||
          (candidate.lane === "mesh-cli" &&
            candidate.provider === task.provider &&
            candidate.sessionId &&
            candidate.sessionId === task.sessionId),
      );
      taskRepo.set(task.id, {
        key: agent?.repoKey ?? null,
        label: agent?.repoLabel ?? null,
      });
    }

    if (include.has("progress") && this.taskRegistry) {
      const transitions = tasks
        .flatMap((task) =>
          this.taskRegistry!.transitions(task.id).map((transition) => ({
            task,
            transition,
          })),
        )
        .filter(
          ({ task, transition }) =>
            transition.sequence > cursor.pt &&
            repoMatches(
              input.repo,
              taskRepo.get(task.id)?.key,
              taskRepo.get(task.id)?.label,
            ),
        )
        .sort(
          (left, right) =>
            left.transition.sequence - right.transition.sequence,
        )
        .slice(0, limit);
      next.pt = transitions.at(-1)?.transition.sequence ?? cursor.pt;
      delta.progress.push(
        ...transitions.map(({ task, transition }) => ({
          eventId: `task:${transition.sequence}`,
          kind: "task_transition" as const,
          taskId: task.id,
          runId: null,
          waveId: null,
          gateId: null,
          provider: task.provider,
          fromStatus: transition.fromStatus,
          toStatus: transition.toStatus,
          requestedModel: safeText(task.model, 256),
          actualModel: safeText(task.actualModel, 256),
          fallbackCount: task.fallbackCount ?? 0,
          repo:
            taskRepo.get(task.id)?.label ??
            taskRepo.get(task.id)?.key ??
            null,
          occurredAt: transition.occurredAt,
        })),
      );
      if (this.orchestration && delta.progress.length < limit) {
        const events = this.orchestration
          .auditEvents(undefined, 10_000)
          .filter(
            (event) =>
              event.sequence > cursor.po &&
              ((event.entityType === "wave" &&
                event.event.includes("transition")) ||
                (event.entityType === "gate" &&
                  event.event.includes("transition"))),
          )
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, limit - delta.progress.length);
        next.po = events.at(-1)?.sequence ?? cursor.po;
        delta.progress.push(
          ...events.map((event) => ({
            eventId: `orchestration:${event.sequence}`,
            kind:
              event.entityType === "wave"
                ? ("wave_transition" as const)
                : ("gate_transition" as const),
            taskId: null,
            runId: event.runId,
            waveId: event.entityType === "wave" ? event.entityId : null,
            gateId: event.entityType === "gate" ? event.entityId : null,
            provider: null,
            fromStatus: event.fromStatus,
            toStatus: event.toStatus ?? "unknown",
            requestedModel: null,
            actualModel: null,
            fallbackCount: 0,
            repo: null,
            occurredAt: event.createdAt,
          })),
        );
      }
      delta.progress.sort(
        (left, right) =>
          instant(left.occurredAt) - instant(right.occurredAt) ||
          left.eventId.localeCompare(right.eventId),
      );
    }

    if (include.has("questions") && this.taskRegistry) {
      const questionEvents = this.taskRegistry
        .listQuestions({ origin: this.origin, limit: 5_000 })
        .flatMap((question): SupervisionQuestionEvent[] => {
          const repo = taskRepo.get(question.taskId);
          if (!repoMatches(input.repo, repo?.key, repo?.label)) return [];
          const pending: SupervisionQuestionEvent = {
            eventId: `question:${question.id}:pending`,
            kind: "pending",
            questionId: question.id,
            taskId: question.taskId,
            provider: question.provider,
            delivery: question.delivery,
            occurredAt: question.createdAt,
            repo: repo?.label ?? repo?.key ?? null,
          };
          return question.status === "answered" && question.answeredAt
            ? [
                pending,
                {
                  ...pending,
                  eventId: `question:${question.id}:answered`,
                  kind: "answered",
                  occurredAt: question.answeredAt,
                },
              ]
            : question.status === "pending"
              ? [pending]
              : [];
        })
        .filter(
          (event) =>
            questionEventKey(event.occurredAt, event.questionId, event.kind) >
            cursor.q,
        )
        .sort((left, right) =>
          questionEventKey(left.occurredAt, left.questionId, left.kind).localeCompare(
            questionEventKey(right.occurredAt, right.questionId, right.kind),
          ),
        )
        .slice(0, limit);
      next.q = questionEvents.length
        ? questionEventKey(
            questionEvents.at(-1)!.occurredAt,
            questionEvents.at(-1)!.questionId,
            questionEvents.at(-1)!.kind,
          )
        : cursor.q;
      delta.questions = questionEvents;
    }

    if (include.has("leases")) {
      const frictionById = new Map(
        this.peerRegistry
          .frictionEvents({
            repoKey: peerRepo,
            kind: "lease_contention",
            limit: 5_000,
          })
          .map((event) => [event.id, event]),
      );
      const leaseAudit = scanPeerAudit(
        this.peerRegistry,
        cursor.l,
        limit,
        (event) => {
          if (
            event.entityType === "friction_event" &&
            event.event === "recorded"
          ) {
            return frictionById.has(event.entityId);
          }
          if (
            event.entityType !== "resource_lease" ||
            !["acquired", "released"].includes(event.event)
          ) {
            return false;
          }
          const data = record(event.data);
          const repoKey =
            inventory.channelRepo.get(stringValue(data.channelId) ?? "") ??
            memberById.get(stringValue(data.holderMemberId) ?? "")?.repoKey;
          return repoMatches(
            input.repo,
            repoKey,
            trafficAgents.find((agent) => agent.repoKey === repoKey)
              ?.repoLabel,
          );
        },
      );
      const currentLeaseById = new Map(
        inventory.leases.map((lease) => [lease.id, lease]),
      );
      next.l = leaseAudit.cursor;
      for (const event of leaseAudit.events) {
        if (event.entityType === "friction_event") {
          const friction = frictionById.get(event.entityId)!;
          delta.leases.push({
            eventId: `peer:${event.sequence}`,
            kind: "contention",
            leaseId: null,
            channelId: null,
            resource: null,
            holderMemberId: null,
            holderAgentId: friction.agentId,
            generation: null,
            expiresAt: null,
            repo: friction.repoKey,
            occurredAt: friction.occurredAt,
          });
          continue;
        }
        const data = record(event.data);
        const lease = currentLeaseById.get(event.entityId);
        const holderMemberId =
          lease?.holderMemberId ?? stringValue(data.holderMemberId);
        const member = holderMemberId
          ? memberById.get(holderMemberId)
          : undefined;
        delta.leases.push({
          eventId: `peer:${event.sequence}`,
          kind: event.event === "acquired" ? "acquired" : "released",
          leaseId: event.entityId,
          channelId: lease?.channelId ?? stringValue(data.channelId),
          resource: lease?.resourceName ?? stringValue(data.resource),
          holderMemberId: holderMemberId ?? null,
          holderAgentId: member?.agentId ?? null,
          generation: lease?.generation ?? numberValue(data.generation),
          expiresAt: lease?.expiresAt ?? null,
          repo:
            member?.repoKey ??
            inventory.channelRepo.get(lease?.channelId ?? "") ??
            null,
          occurredAt: event.createdAt,
        });
      }
      const prior = new Map(cursor.la.map((entry) => [entry.i, entry]));
      const auditedLeaseIds = new Set(
        delta.leases
          .filter((event) => event.leaseId)
          .map((event) => event.leaseId!),
      );
      for (const lease of inventory.leases) {
        const member = memberById.get(lease.holderMemberId);
        if (
          !repoMatches(
            input.repo,
            member?.repoKey,
            member ? trafficById.get(member.agentId)?.repoLabel : null,
          )
        ) {
          continue;
        }
        const previous = prior.get(lease.id);
        if (
          previous &&
          previous.u !== lease.updatedAt &&
          !auditedLeaseIds.has(lease.id) &&
          delta.leases.length < limit
        ) {
          delta.leases.push({
            eventId: `lease:${lease.id}:${lease.updatedAt}`,
            kind: "renewed",
            leaseId: lease.id,
            channelId: lease.channelId,
            resource: lease.resourceName,
            holderMemberId: lease.holderMemberId,
            holderAgentId: member?.agentId ?? null,
            generation: lease.generation,
            expiresAt: lease.expiresAt,
            repo: member?.repoKey ?? null,
            occurredAt: lease.updatedAt,
          });
        }
      }
      for (const previous of cursor.la) {
        if (
          currentLeaseById.has(previous.i) ||
          auditedLeaseIds.has(previous.i) ||
          instant(previous.x) > this.now().getTime() ||
          delta.leases.length >= limit
        ) {
          continue;
        }
        delta.leases.push({
          eventId: `lease:${previous.i}:expired`,
          kind: "expired",
          leaseId: previous.i,
          channelId: null,
          resource: null,
          holderMemberId: null,
          holderAgentId: null,
          generation: previous.g,
          expiresAt: previous.x,
          repo: input.repo ?? null,
          occurredAt: previous.x,
        });
      }
      next.la = inventory.leases
        .filter((lease) => {
          const member = memberById.get(lease.holderMemberId);
          return repoMatches(
            input.repo,
            member?.repoKey,
            member ? trafficById.get(member.agentId)?.repoLabel : null,
          );
        })
        .map((lease) => ({
          i: lease.id,
          u: lease.updatedAt,
          x: lease.expiresAt,
          g: lease.generation,
        }))
        .sort((left, right) => left.i.localeCompare(right.i));
      delta.leases.sort(
        (left, right) =>
          instant(left.occurredAt) - instant(right.occurredAt) ||
          left.eventId.localeCompare(right.eventId),
      );
    }

    const allCurrentDirections = allDirections(this.peerRegistry, peerRepo);
    const conditionSince = new Date(
      this.now().getTime() -
        Math.max(
          this.thresholds.thrashingWindowMs,
          this.thresholds.fallbackWindowMs,
        ),
    ).toISOString();
    const conditionFriction = this.peerRegistry.frictionEvents({
      repoKey: peerRepo,
      since: conditionSince,
      limit: 5_000,
    });
    const lastTrafficEvent = new Map<string, string>();
    let trafficAuditCursor = 0;
    for (;;) {
      const page = this.trafficRegistry.auditEvents(5_000, trafficAuditCursor);
      for (const event of page) {
        if (event.entityType !== "agent" && event.entityType !== "run") continue;
        const agentId =
          event.entityType === "agent"
            ? event.entityId
            : this.trafficRegistry.getRun(event.entityId)?.agentId ??
              stringValue(record(event.data).agentId);
        if (!agentId) continue;
        lastTrafficEvent.set(
          agentId,
          latestInstant(lastTrafficEvent.get(agentId), event.createdAt),
        );
      }
      if (page.length < 5_000) break;
      trafficAuditCursor = page.at(-1)!.sequence;
    }
    const conditions = deriveSupervisionConditions(
      {
        directions: allCurrentDirections,
        agents: trafficAgents
          .filter((agent) =>
            repoMatches(input.repo, agent.repoKey, agent.repoLabel),
          )
          .map((agent) => ({
            id: agent.id,
            status: agent.status,
            isWriter: !agent.peerReadOnly,
            repoKey: agent.repoKey,
            repoLabel: agent.repoLabel,
            lastSeenAt: agent.lastSeenAt,
            lastEventAt: lastTrafficEvent.get(agent.id) ?? null,
          })),
        members: inventory.members
          .filter((member) =>
            repoMatches(
              input.repo,
              member.repoKey,
              trafficById.get(member.agentId)?.repoLabel,
            ),
          )
          .map((member) => ({
            id: member.id,
            agentId: member.agentId,
            repoKey: member.repoKey,
            status: member.status,
            ownership: member.ownership,
          })),
        friction: conditionFriction,
        leases: inventory.leases.map((lease) => ({ ...lease })),
      },
      { now: this.now(), thresholds: this.thresholds },
    );
    const fingerprint = conditionsFingerprint(conditions);
    const conditionsChanged = Boolean(input.afterCursor) && fingerprint !== cursor.c;
    next.c = fingerprint;
    const byStream = Object.fromEntries(
      SUPERVISION_STREAMS.map((stream) => [stream, delta[stream].length]),
    ) as Record<SupervisionStream, number>;
    const materialEventCount = Object.values(byStream).reduce(
      (sum, count) => sum + count,
      0,
    );
    const highestSeverity =
      conditions
        .map((condition) => condition.severity)
        .sort((left, right) => severityRank(right) - severityRank(left))[0] ??
      null;
    const activeStreams = SUPERVISION_STREAMS.filter(
      (stream) => byStream[stream] > 0,
    )
      .map((stream) => `${stream}=${byStream[stream]}`)
      .join(", ");
    const summary: SupervisionSummary = {
      materialEventCount,
      conditionsChanged,
      byStream,
      conditionCount: conditions.length,
      highestSeverity,
      text:
        materialEventCount > 0
          ? `${materialEventCount} material event(s): ${activeStreams}; ${conditions.length} active condition(s).`
          : `No material events; ${conditions.length} active condition(s).`,
    };
    return {
      protocol: "agent-mesh-supervision/v1",
      delta,
      conditions,
      summary,
      nextCursor: encodeCursor(next),
    };
  }

  async watch(input: SupervisionWatchInput = {}): Promise<SupervisionResult> {
    const timeoutMs = boundedInteger(
      input.timeoutMs ?? 30_000,
      "timeoutMs",
      0,
      120_000,
    );
    let cursor = input.afterCursor;
    if (!cursor) {
      const baseline = this.poll(input);
      if (
        baseline.summary.materialEventCount > 0 ||
        baseline.summary.conditionsChanged
      ) {
        return baseline;
      }
      cursor = baseline.nextCursor;
    }
    const unchangedCursor = cursor;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = this.poll({ ...input, afterCursor: cursor });
      if (
        result.summary.materialEventCount > 0 ||
        result.summary.conditionsChanged
      ) {
        return result;
      }
      if (Date.now() >= deadline) {
        return {
          ...result,
          nextCursor: unchangedCursor,
          timedOut: true,
        };
      }
      await new Promise((resolvePromise) =>
        setTimeout(
          resolvePromise,
          Math.min(250, Math.max(1, deadline - Date.now())),
        ),
      );
    }
  }

  private agentEvent(input: {
    eventId: string;
    event: string;
    eventData: Record<string, unknown>;
    agentId: string;
    agent: TrafficAgentRecord | undefined;
    occurredAt: string;
  }): SupervisionAgentEvent {
    const fromStatus = stringValue(input.eventData.fromStatus);
    const toStatus =
      stringValue(input.eventData.toStatus) ??
      stringValue(input.eventData.status) ??
      input.agent?.status ??
      null;
    return {
      eventId: input.eventId,
      kind:
        input.event === "registered" || input.event === "enrolled"
          ? "enrolled"
          : input.event.includes("revoked") || input.event === "withdrawn"
            ? "withdrawn"
            : fromStatus && toStatus
              ? "status_transition"
              : "updated",
      agentId: input.agentId,
      fromStatus,
      toStatus,
      status: input.agent?.status ?? toStatus,
      lane: input.agent?.lane ?? null,
      provider: input.agent?.provider ?? null,
      model: safeText(input.agent?.model, 256),
      repo:
        input.agent?.repoLabel ??
        input.agent?.repoKey ??
        stringValue(input.eventData.repoKey),
      occurredAt: input.occurredAt,
    };
  }
}

// MESH[2026-07-25T22:05Z][agent:cursor-parent][direction:user/11]
// What: corrects the scope of this surface's no-mutation claim.
// Why: it previously claimed supervision "never mutates leases". That is false.
//   Reading peer inventory goes through PeerChannelRegistry.context(), which
//   calls recoverExpired() and therefore closes expired channels, revokes
//   members, dead-letters deliveries, and expires resource leases inside a
//   transaction. The claim would have misled anyone debugging lease flaps.
// Aligns-with: direction user revision 11 (false claim found in review).
// Status: complete
//
// What this surface does guarantee: it never cancels or reassigns an agent,
// never publishes direction, and never applies one of its own recommended
// remedies. Deciding and acting stay with the caller. It does, however, trigger
// the registries' ordinary time-based expiry as a side effect of reading them,
// which is idempotent and safe to race between servers.
