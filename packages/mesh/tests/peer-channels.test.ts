import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadBridgeAllowlistFile,
  PEER_FRICTION_KINDS,
  PeerChannelRegistry,
  PeerWakePump,
  type ManagedPeerBinding,
  type PeerWakeJob,
} from "../peer-channels.js";
import {
  TrafficControlRegistry,
  resolveTrafficLocation,
  type TrafficAgentRecord,
} from "../traffic-control.js";
import {
  parseIntakeRequest,
  runDirectionIntake,
  intakeOrigin,
} from "../direction-cli.js";
import { agentMeshHmac } from "../coordination-auth.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const registries: PeerChannelRegistry[] = [];
const trafficRegistries: TrafficControlRegistry[] = [];
const originalStateDir = process.env.AGENT_MESH_STATE_DIR;
const originalAllowedRoots = process.env.AGENT_MESH_ALLOWED_ROOTS;
const originalChild = process.env.AGENT_MESH_CHILD;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

afterEach(async () => {
  for (const registry of registries.splice(0)) {
    try {
      registry.close();
    } catch {
      // A durability test can close before reopening.
    }
  }
  for (const registry of trafficRegistries.splice(0)) {
    try {
      registry.close();
    } catch {
      // An intake test closes its registries before running the CLI.
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (originalStateDir === undefined) delete process.env.AGENT_MESH_STATE_DIR;
  else process.env.AGENT_MESH_STATE_DIR = originalStateDir;
  if (originalAllowedRoots === undefined) delete process.env.AGENT_MESH_ALLOWED_ROOTS;
  else process.env.AGENT_MESH_ALLOWED_ROOTS = originalAllowedRoots;
  if (originalChild === undefined) delete process.env.AGENT_MESH_CHILD;
  else process.env.AGENT_MESH_CHILD = originalChild;
});

function trafficAgent(input: {
  id?: string;
  lane?: "mesh-cli" | "sdk-local" | "sdk-cloud";
  repoKey?: string;
  repoLabel?: string;
  status?: TrafficAgentRecord["status"];
  verified?: boolean;
  readOnly?: boolean;
  origin?: TrafficAgentRecord["origin"];
} = {}): TrafficAgentRecord {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  return {
    id,
    origin: input.origin ?? "cursor",
    lane: input.lane ?? "sdk-local",
    externalId: `agent-${id}`,
    provider: null,
    sessionId: null,
    meshTaskId: null,
    name: `Agent ${id.slice(0, 8)}`,
    status: input.status ?? "finished",
    model: "fake-model",
    modelSelection: { id: "fake-model" },
    cwd: `/private/worktrees/${id}`,
    repoRoot: `/private/worktrees/${id}`,
    worktreePath: `/private/worktrees/${id}`,
    repoKey: input.repoKey ?? "a".repeat(64),
    worktreeKey: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    repoLabel: input.repoLabel ?? "repo-a",
    worktreeLabel: id.slice(0, 8),
    meshOwned: true,
    locationVerified: input.verified ?? true,
    adopted: false,
    peerReadOnly: input.readOnly ?? true,
    forceLocalNextSend: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

async function harness(input: {
  agents?: TrafficAgentRecord[];
  allowlist?: Array<{ sourceRepoKey: string; destinationRepoKey: string }>;
  now?: () => Date;
  path?: string;
} = {}): Promise<{
  root: string;
  path: string;
  agents: Map<string, TrafficAgentRecord>;
  registry: PeerChannelRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "mesh-peer-"));
  roots.push(root);
  const path = input.path ?? join(root, "peer.db");
  const agents = new Map(
    (input.agents ?? []).map((agent) => [agent.id, agent]),
  );
  const registry = new PeerChannelRegistry({
    origin: "cursor",
    path,
    now: input.now,
    bridgeAllowlist: input.allowlist,
    agentResolver: (id) => agents.get(id),
  });
  registries.push(registry);
  return { root, path, agents, registry };
}

function enroll(
  registry: PeerChannelRegistry,
  agent: TrafficAgentRecord,
  metadata: {
    taskId?: string;
    runId?: string;
    role?: string;
  } = {},
) {
  const member = registry.ensureAgentEnrollment({
    agentId: agent.id,
    ...metadata,
  });
  const binding: ManagedPeerBinding = {
    origin: "cursor",
    agentId: agent.id,
    memberId: member.id,
    membershipGeneration: member.generation,
    ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
    ...(metadata.runId ? { runId: metadata.runId } : {}),
  };
  return { member, binding };
}

type PublishDirectionInput = Parameters<
  PeerChannelRegistry["publishDirection"]
>[0];

function publishDirection(
  registry: PeerChannelRegistry,
  repoKey: string,
  input: Partial<PublishDirectionInput> = {},
) {
  return registry.publishDirection({
    expectedRevision: 0,
    repoKey,
    title: "Keep the implementation aligned",
    body: "Apply the latest human direction before continuing work.",
    summary: "Honor the current implementation direction.",
    affectedPaths: ["src/**"],
    provenance: "hook_prompt",
    disposition: "active",
    idempotencyKey: randomUUID(),
    ...input,
  });
}

describe("managed peer channels", () => {
  it("shares one repository channel across worktrees with durable directed delivery", async () => {
    const repoKey = "a".repeat(64);
    const first = trafficAgent({ repoKey });
    const second = trafficAgent({ repoKey });
    const { registry } = await harness({ agents: [first, second] });
    const a = enroll(registry, first, { role: "writer" });
    const b = enroll(registry, second, { role: "reviewer" });

    const channels = registry.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      kind: "repository",
      sourceRepoKey: repoKey,
    });
    const sent = registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "request",
      body: "Review the current checkpoint.",
      payload: { scope: ["src/runtime.ts"] },
      clientMessageId: "message-1",
    });
    expect(sent.message).toMatchObject({
      senderMemberId: a.member.id,
      recipientMemberId: b.member.id,
      sequence: 1,
    });
    expect(sent.delivery.cursor).toBe(1);
    expect(registry.inbox(b.binding, 0)).toHaveLength(1);
    expect(
      registry.acknowledge(b.binding, sent.delivery.id),
    ).toMatchObject({ state: "acknowledged" });
    expect(registry.inbox(b.binding, sent.delivery.cursor)).toEqual([]);
    expect(registry.auditEvents().length).toBeGreaterThan(3);
  });

  it("atomically fans out directions and replays standing revisions to new agents", async () => {
    const repoKey = "d".repeat(64);
    const first = trafficAgent({ repoKey, status: "running" });
    const second = trafficAgent({ repoKey, status: "running" });
    const later = trafficAgent({ repoKey, status: "running" });
    const resumed = trafficAgent({ repoKey, status: "running" });
    const { registry } = await harness({
      agents: [first, second, later, resumed],
    });
    const a = enroll(registry, first, { taskId: randomUUID() });
    enroll(registry, second, { runId: randomUUID() });
    registry.ensureAgentEnrollment({ agentId: resumed.id });

    const published = publishDirection(registry, repoKey);
    expect(published.revision).toMatchObject({
      revision: 1,
      sequence: 1,
      affectedPaths: ["src/**"],
    });
    expect(
      published.targets.map((target) => target.agentId).sort(),
    ).toEqual([first.id, second.id].sort());
    expect(published.targets.every((target) => target.state === "pending")).toBe(
      true,
    );
    expect(registry.context(a.binding).directions).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          agentId: first.id,
          state: "pending",
        }),
      }),
    ]);

    enroll(registry, later, { taskId: randomUUID() });
    registry.bindMemberSession({
      agentId: resumed.id,
      runId: randomUUID(),
    });
    const replayed = registry.directionOutbox({
      directionId: published.direction.id,
      afterSequence: 0,
      limit: 100,
      includeHistory: false,
    });
    expect(
      replayed[0]!.targets.map((target) => target.agentId).sort(),
    ).toEqual([first.id, second.id, later.id, resumed.id].sort());
  });

  it("enforces revisions, supersedes pending targets, and preserves every impact", async () => {
    const repoKey = "e".repeat(64);
    const agents = Array.from({ length: 4 }, () =>
      trafficAgent({ repoKey, status: "running" }),
    );
    const { registry } = await harness({ agents });
    const enrolled = agents.map((agent) =>
      enroll(registry, agent, { taskId: randomUUID() }),
    );
    const initial = publishDirection(registry, repoKey);

    const applies = registry.acknowledgeDirection({
      binding: enrolled[0]!.binding,
      directionId: initial.direction.id,
      revision: 1,
      impact: "applies",
      note: "This changes my implementation.",
    });
    registry.acknowledgeDirection({
      binding: enrolled[1]!.binding,
      directionId: initial.direction.id,
      revision: 1,
      impact: "no-impact",
    });
    registry.acknowledgeDirection({
      binding: enrolled[2]!.binding,
      directionId: initial.direction.id,
      revision: 1,
      impact: "conflict-needs-clarity",
      note: "The requested behavior conflicts with acceptance criteria.",
    });
    expect(
      registry.acknowledgeDirection({
        binding: enrolled[0]!.binding,
        directionId: initial.direction.id,
        revision: 1,
        impact: "applies",
        note: "This changes my implementation.",
      }),
    ).toEqual(applies);
    expect(() =>
      registry.acknowledgeDirection({
        binding: enrolled[0]!.binding,
        directionId: initial.direction.id,
        revision: 1,
        impact: "applies",
        note: "Changed after delivery.",
      }),
    ).toThrow(/cannot be changed/i);
    expect(registry.pendingDirections(agents[0]!.id)).toEqual([]);
    expect(registry.pendingDirections(agents[2]!.id)).toHaveLength(1);

    const revised = publishDirection(registry, repoKey, {
      directionId: initial.direction.id,
      expectedRevision: 1,
      title: "Clarified implementation direction",
      idempotencyKey: randomUUID(),
    });
    expect(revised.revision.revision).toBe(2);
    expect(() =>
      publishDirection(registry, repoKey, {
        directionId: initial.direction.id,
        expectedRevision: 1,
        title: "Stale update",
        idempotencyKey: randomUUID(),
      }),
    ).toThrow(/revision conflict/i);

    const history = registry.directionOutbox({
      directionId: initial.direction.id,
      afterSequence: 0,
      limit: 100,
      includeHistory: true,
    });
    expect(history).toHaveLength(2);
    const oldTargets = history[0]!.targets;
    expect(oldTargets.map((target) => target.impact).filter(Boolean).sort()).toEqual([
      "applies",
      "conflict-needs-clarity",
      "no-impact",
    ]);
    expect(
      oldTargets.find((target) => target.agentId === agents[3]!.id)?.state,
    ).toBe("superseded");
    expect(
      oldTargets.filter((target) => target.state === "acknowledged"),
    ).toHaveLength(3);
  });

  it("publishes withdrawals, honors idempotency, and does not replay withdrawn directions", async () => {
    const repoKey = "f".repeat(64);
    const first = trafficAgent({ repoKey, status: "running" });
    const later = trafficAgent({ repoKey, status: "running" });
    const { registry } = await harness({ agents: [first, later] });
    const enrolled = enroll(registry, first, { runId: randomUUID() });
    const request: PublishDirectionInput = {
      expectedRevision: 0,
      repoKey,
      title: "Standing direction",
      body: "Keep this behavior active.",
      summary: "Standing behavior.",
      provenance: "controller",
      disposition: "active",
      idempotencyKey: randomUUID(),
    };
    const published = registry.publishDirection(request);
    expect(registry.publishDirection(request)).toEqual(published);
    expect(
      registry.directionOutbox({
        afterSequence: 0,
        limit: 100,
        includeHistory: true,
      }),
    ).toHaveLength(1);

    const withdrawn = publishDirection(registry, repoKey, {
      directionId: published.direction.id,
      expectedRevision: 1,
      title: "Withdraw standing direction",
      body: "Stop applying the prior direction.",
      summary: "The prior direction is withdrawn.",
      disposition: "withdrawn",
      idempotencyKey: randomUUID(),
    });
    expect(withdrawn.direction.disposition).toBe("withdrawn");
    expect(withdrawn.targets).toHaveLength(1);
    expect(registry.context(enrolled.binding).directions[0]).toMatchObject({
      direction: { disposition: "withdrawn" },
      revision: { revision: 2 },
      target: { state: "pending" },
    });

    enroll(registry, later, { taskId: randomUUID() });
    const current = registry.directionOutbox({
      directionId: published.direction.id,
      afterSequence: 0,
      limit: 100,
      includeHistory: false,
    });
    expect(current[0]!.targets.map((target) => target.agentId)).toEqual([
      first.id,
    ]);
  });

  it("detects direction acknowledgment tampering", async () => {
    const repoKey = "1".repeat(64);
    const agent = trafficAgent({ repoKey, status: "running" });
    const { registry, path } = await harness({ agents: [agent] });
    const member = enroll(registry, agent, { taskId: randomUUID() });
    const direction = publishDirection(registry, repoKey);
    registry.acknowledgeDirection({
      binding: member.binding,
      directionId: direction.direction.id,
      revision: 1,
      impact: "applies",
      note: "Acknowledged.",
    });
    const database = new DatabaseSync(path);
    database
      .prepare(
        `UPDATE peer_direction_targets
         SET impact = 'no-impact'
         WHERE direction_id = ? AND revision = 1 AND agent_id = ?`,
      )
      .run(direction.direction.id, agent.id);
    database.close();
    expect(() =>
      registry.directionOutbox({
        directionId: direction.direction.id,
        afterSequence: 0,
        limit: 100,
        includeHistory: true,
      }),
    ).toThrow(/failed verification/i);
  });

  it("isolates direction publication and acknowledgment by origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-peer-direction-origin-"));
    roots.push(root);
    const path = join(root, "peer.db");
    const repoKey = "2".repeat(64);
    const cursorAgent = trafficAgent({
      origin: "cursor",
      repoKey,
      status: "running",
    });
    const codexAgent = trafficAgent({
      origin: "codex",
      repoKey,
      status: "running",
    });
    const cursor = new PeerChannelRegistry({
      origin: "cursor",
      path,
      agentResolver: (id) => id === cursorAgent.id ? cursorAgent : undefined,
    });
    const codex = new PeerChannelRegistry({
      origin: "codex",
      path,
      agentResolver: (id) => id === codexAgent.id ? codexAgent : undefined,
    });
    registries.push(cursor, codex);
    enroll(cursor, cursorAgent, { taskId: randomUUID() });
    const codexMember = codex.ensureAgentEnrollment({
      agentId: codexAgent.id,
      taskId: randomUUID(),
    });
    const direction = publishDirection(cursor, repoKey);

    expect(
      codex.directionOutbox({
        afterSequence: 0,
        limit: 100,
        includeHistory: true,
      }),
    ).toEqual([]);
    expect(() =>
      codex.acknowledgeDirection({
        binding: {
          origin: "codex",
          agentId: codexAgent.id,
          memberId: codexMember.id,
          membershipGeneration: codexMember.generation,
          taskId: codexMember.taskId!,
        },
        directionId: direction.direction.id,
        revision: 1,
        impact: "no-impact",
      }),
    ).toThrow(/unknown peer direction/i);
    expect(() =>
      publishDirection(codex, repoKey, {
        directionId: direction.direction.id,
      }),
    ).toThrow(/another origin/i);
  });

  it("binds sender identity and revokes stale membership generations", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const { registry } = await harness({ agents: [first, second] });
    const a = enroll(registry, first, { taskId: randomUUID() });
    const b = enroll(registry, second);

    const rebound = registry.bindMemberSession({
      agentId: first.id,
      runId: randomUUID(),
    })[0]!;
    expect(rebound.generation).toBe(a.member.generation + 1);
    expect(() =>
      registry.send({
        binding: a.binding,
        recipientMemberId: b.member.id,
        kind: "notice",
        body: "stale",
        clientMessageId: "stale-send",
      }),
    ).toThrow(/stale/i);
    const current = registry.bindingForAgent({ agentId: first.id });
    registry.revokeMember(current.memberId);
    expect(() => registry.context(current)).toThrow(/stale/i);
  });

  it("records compact receipts, assignments, and named resource leases", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const { registry } = await harness({ agents: [first, second] });
    const a = enroll(registry, first);
    const b = enroll(registry, second);
    registry.configureMember({
      memberId: a.member.id,
      role: "checkout",
      assignment: { goal: "implement checkout" },
      ownership: ["src/checkout/**"],
      acceptanceCriteria: ["focused tests pass"],
      observedGitHead: "a".repeat(40),
    });
    const firstReceipt = registry.recordReceipt({
      binding: a.binding,
      kind: "checkpoint",
      key: "branch",
      payload: { sha: "a".repeat(40) },
      observed: { head: "a".repeat(40) },
    });
    const secondReceipt = registry.recordReceipt({
      binding: a.binding,
      kind: "checkpoint",
      key: "branch",
      payload: { sha: "b".repeat(40) },
      observed: { head: "b".repeat(40) },
    });
    expect(secondReceipt.version).toBe(firstReceipt.version + 1);
    expect(registry.context(b.binding).receipts).toContainEqual(
      expect.objectContaining({
        id: secondReceipt.id,
        status: "active",
      }),
    );

    const channel = registry.listChannels()[0]!;
    registry.defineResource({
      channelId: channel.id,
      name: "shared-deployment",
      maximumTtlMs: 60_000,
      description: "Serialize preview deployment.",
    });
    const lease = registry.acquireResource({
      binding: a.binding,
      name: "shared-deployment",
      ttlMs: 30_000,
    });
    expect(() =>
      registry.acquireResource({
        binding: b.binding,
        name: "shared-deployment",
        ttlMs: 30_000,
      }),
    ).toThrow(/another member/i);
    expect(registry.releaseResource(a.binding, lease.id)).toMatchObject({
      status: "released",
    });
    expect(
      registry.acquireResource({
        binding: b.binding,
        name: "shared-deployment",
        ttlMs: 30_000,
      }),
    ).toMatchObject({ holderMemberId: b.member.id });
  });

  it("records every friction kind once per dedupe key with redacted bounded detail", async () => {
    const repoKey = "3".repeat(64);
    const { registry } = await harness();
    for (const kind of PEER_FRICTION_KINDS) {
      registry.recordFriction({
        repoKey,
        kind,
        detail: `Observed ${kind} while coordinating.`,
        dedupeKey: `${kind}:wave-1`,
      });
    }
    expect(
      registry.frictionEvents({ repoKey }).map((event) => event.kind).sort(),
    ).toEqual([...PEER_FRICTION_KINDS].sort());

    const first = registry.recordFriction({
      repoKey,
      kind: "retry",
      detail: "The verification gate retried once.",
      dedupeKey: "retry:wave-2",
    });
    expect(
      registry.recordFriction({
        repoKey,
        kind: "retry",
        detail: "A later observation of the same retry.",
        dedupeKey: "retry:wave-2",
      }),
    ).toEqual(first);
    expect(registry.frictionEvents({ kind: "retry" })).toHaveLength(2);

    const redacted = registry.recordFriction({
      repoKey,
      kind: "gate_failure",
      severity: "high",
      detail: `Deploy gate failed with api_key=sk-abcdefghijklmnop ${"and stalled ".repeat(400)}`,
      dedupeKey: "gate_failure:deploy",
      provider: "claude",
      model: "claude-opus-5",
      agentId: randomUUID(),
      reference: "step-4",
      skillTier: 3,
    });
    expect(redacted.detail).toContain("[REDACTED]");
    expect(redacted.detail).not.toContain("sk-abcdefghijklmnop");
    expect(redacted.detail.length).toBeGreaterThan(1_900);
    expect(redacted.detail.length).toBeLessThanOrEqual(2_000);
    expect(redacted).toMatchObject({
      severity: "high",
      provider: "claude",
      model: "claude-opus-5",
      reference: "step-4",
      skillTier: 3,
    });
  });

  it("filters and summarizes friction by repository, kind, provider, severity, and window", async () => {
    const repoKey = "4".repeat(64);
    const otherRepoKey = "5".repeat(64);
    const { registry } = await harness();
    registry.recordFriction({
      repoKey,
      kind: "model_fallback",
      severity: "medium",
      provider: "claude",
      model: "claude-opus-5",
      detail: "The primary model was unavailable.",
      dedupeKey: "model_fallback:1",
      occurredAt: "2026-07-20T00:00:00.000Z",
    });
    registry.recordFriction({
      repoKey,
      kind: "model_fallback",
      severity: "low",
      provider: "grok",
      detail: "The primary model was unavailable.",
      dedupeKey: "model_fallback:2",
      occurredAt: "2026-07-22T00:00:00.000Z",
    });
    registry.recordFriction({
      repoKey,
      kind: "fallback_exhausted",
      severity: "high",
      provider: "claude",
      detail: "Every configured model was exhausted.",
      dedupeKey: "fallback_exhausted:1",
      occurredAt: "2026-07-24T00:00:00.000Z",
    });
    registry.recordFriction({
      repoKey: otherRepoKey,
      kind: "idle_wait",
      detail: "Waited on a dependency owned by another agent.",
      dedupeKey: "idle_wait:1",
      occurredAt: "2026-07-24T00:00:00.000Z",
    });

    expect(
      registry.frictionEvents({ repoKey }).map((event) => event.dedupeKey),
    ).toEqual([
      "fallback_exhausted:1",
      "model_fallback:2",
      "model_fallback:1",
    ]);
    expect(
      registry
        .frictionEvents({ kind: "model_fallback", provider: "claude" })
        .map((event) => event.dedupeKey),
    ).toEqual(["model_fallback:1"]);
    expect(
      registry
        .frictionEvents({ severity: "high" })
        .map((event) => event.dedupeKey),
    ).toEqual(["fallback_exhausted:1"]);
    expect(
      registry
        .frictionEvents({
          since: "2026-07-21T00:00:00.000Z",
          until: "2026-07-23T00:00:00.000Z",
        })
        .map((event) => event.dedupeKey),
    ).toEqual(["model_fallback:2"]);
    expect(registry.frictionEvents({ limit: 1 })).toHaveLength(1);
    expect(() =>
      registry.frictionEvents({ since: "not-an-instant" }),
    ).toThrow(/instant/i);

    expect(registry.frictionSummary({ repoKey })).toEqual({
      total: 3,
      byKind: [
        { kind: "model_fallback", count: 2 },
        { kind: "fallback_exhausted", count: 1 },
      ],
      byProvider: [
        { provider: "claude", count: 2 },
        { provider: "grok", count: 1 },
      ],
    });
    expect(registry.frictionSummary()).toMatchObject({ total: 4 });
  });

  it("records direction conflict friction when an agent reports a conflict", async () => {
    const repoKey = "6".repeat(64);
    const agent = {
      ...trafficAgent({ repoKey, status: "running" }),
      provider: "claude" as const,
    };
    const second = trafficAgent({ repoKey, status: "running" });
    const { registry } = await harness({ agents: [agent, second] });
    const conflicting = enroll(registry, agent, { taskId: randomUUID() });
    const applying = enroll(registry, second, { taskId: randomUUID() });
    const direction = publishDirection(registry, repoKey);
    const acknowledgment = {
      binding: conflicting.binding,
      directionId: direction.direction.id,
      revision: 1,
      impact: "conflict-needs-clarity" as const,
      note: "The direction conflicts with my acceptance criteria.",
    };
    registry.acknowledgeDirection(acknowledgment);
    registry.acknowledgeDirection({
      binding: applying.binding,
      directionId: direction.direction.id,
      revision: 1,
      impact: "applies",
    });

    const events = registry.frictionEvents({ kind: "direction_conflict" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repoKey,
      severity: "high",
      agentId: agent.id,
      provider: "claude",
      model: "fake-model",
      reference: `${direction.direction.id}@1`,
      detail: "The direction conflicts with my acceptance criteria.",
    });
    registry.acknowledgeDirection(acknowledgment);
    expect(registry.frictionEvents({ kind: "direction_conflict" })).toHaveLength(
      1,
    );
  });

  it("records lease contention friction when another member holds the resource", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const { registry } = await harness({ agents: [first, second] });
    const holder = enroll(registry, first, { taskId: randomUUID() });
    const blocked = enroll(registry, second, { taskId: randomUUID() });
    const channel = registry.listChannels()[0]!;
    registry.defineResource({
      channelId: channel.id,
      name: "shared-deployment",
      maximumTtlMs: 60_000,
      description: "Serialize preview deployment.",
    });
    registry.acquireResource({
      binding: holder.binding,
      name: "shared-deployment",
      ttlMs: 30_000,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() =>
        registry.acquireResource({
          binding: blocked.binding,
          name: "shared-deployment",
          ttlMs: 30_000,
        }),
      ).toThrow(/another member/i);
    }

    const events = registry.frictionEvents({ kind: "lease_contention" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      repoKey: second.repoKey,
      severity: "medium",
      agentId: second.id,
      reference: blocked.member.taskId,
    });
    expect(events[0]!.detail).toContain("shared-deployment");
  });

  it("isolates the friction ledger by origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-peer-friction-origin-"));
    roots.push(root);
    const path = join(root, "peer.db");
    const repoKey = "7".repeat(64);
    const cursor = new PeerChannelRegistry({
      origin: "cursor",
      path,
      agentResolver: () => undefined,
    });
    const codex = new PeerChannelRegistry({
      origin: "codex",
      path,
      agentResolver: () => undefined,
    });
    registries.push(cursor, codex);
    const collision = {
      repoKey,
      kind: "writer_collision" as const,
      detail: "Two writers claimed one worktree.",
      dedupeKey: "writer_collision:worktree-1",
    };
    const owned = cursor.recordFriction(collision);
    const foreign = codex.recordFriction(collision);

    expect(owned.id).not.toBe(foreign.id);
    expect(cursor.frictionEvents()).toEqual([
      expect.objectContaining({ id: owned.id, origin: "cursor" }),
    ]);
    expect(codex.frictionEvents()).toEqual([
      expect.objectContaining({ id: foreign.id, origin: "codex" }),
    ]);
    expect(cursor.frictionSummary().total).toBe(1);
  });

  it("rejects secrets and enforces idempotent client message IDs", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const { registry } = await harness({ agents: [first, second] });
    const a = enroll(registry, first);
    const b = enroll(registry, second);
    expect(() =>
      registry.send({
        binding: a.binding,
        recipientMemberId: b.member.id,
        kind: "notice",
        body: "api_key=sk-abcdefghijklmnop",
        clientMessageId: "secret",
      }),
    ).toThrow(/secret/i);
    const firstSend = registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "notice",
      body: "safe",
      clientMessageId: "same-id",
    });
    const replay = registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "notice",
      body: "safe",
      clientMessageId: "same-id",
    });
    expect(replay.message.id).toBe(firstSend.message.id);
    expect(() =>
      registry.send({
        binding: a.binding,
        recipientMemberId: b.member.id,
        kind: "notice",
        body: "changed",
        clientMessageId: "same-id",
      }),
    ).toThrow(/reused/i);
  });

  it("permits only allowlisted bridge direction and dead-letters on close", async () => {
    const first = trafficAgent({
      repoKey: "a".repeat(64),
      repoLabel: "repo-a",
    });
    const second = trafficAgent({
      repoKey: "b".repeat(64),
      repoLabel: "repo-b",
    });
    const { registry } = await harness({
      agents: [first, second],
      allowlist: [
        {
          sourceRepoKey: first.repoKey!,
          destinationRepoKey: second.repoKey!,
        },
      ],
    });
    enroll(registry, first);
    enroll(registry, second);
    expect(() =>
      registry.send({
        binding: registry.bindingForAgent({ agentId: first.id }),
        recipientMemberId: registry.bindingForAgent({ agentId: second.id }).memberId,
        kind: "notice",
        body: "not bridged",
        clientMessageId: "cross-default",
      }),
    ).toThrow(/recipient channel|member/i);
    const bridge = registry.createBridge({
      sourceAgentId: first.id,
      destinationAgentId: second.id,
      label: "A to B",
      bidirectional: false,
    });
    const bridgeMembers = registry.listMembers(bridge.id);
    const source = bridgeMembers.find((member) => member.agentId === first.id)!;
    const destination = bridgeMembers.find((member) => member.agentId === second.id)!;
    const sent = registry.send({
      binding: registry.bindingForAgent({ agentId: first.id }),
      recipientMemberId: destination.id,
      kind: "handoff",
      body: "Cross-repository handoff.",
      clientMessageId: "bridge-forward",
    });
    expect(sent.message.senderMemberId).toBe(source.id);
    expect(() =>
      registry.send({
        binding: registry.bindingForAgent({ agentId: second.id }),
        recipientMemberId: source.id,
        kind: "response",
        body: "reverse",
        clientMessageId: "bridge-reverse",
      }),
    ).toThrow(/direction/i);
    registry.closeBridge(bridge.id);
    expect(
      registry.inbox(
        registry.bindingForAgent({ agentId: second.id }),
        0,
      ),
    ).toEqual([]);
  });

  it("fences bridge administration inside the peer transaction", async () => {
    const first = trafficAgent({ repoKey: "a".repeat(64) });
    const second = trafficAgent({ repoKey: "b".repeat(64) });
    const { registry } = await harness({
      agents: [first, second],
      allowlist: [
        {
          sourceRepoKey: first.repoKey!,
          destinationRepoKey: second.repoKey!,
        },
      ],
    });
    enroll(registry, first);
    enroll(registry, second);
    expect(() =>
      registry.createBridge(
        {
          sourceAgentId: first.id,
          destinationAgentId: second.id,
          label: "fenced",
        },
        () => {
          throw new Error("controller generation changed");
        },
      ),
    ).toThrow(/generation changed/i);
    expect(
      registry.listChannels().filter((channel) => channel.kind === "bridge"),
    ).toEqual([]);
  });

  it("rejects unallowlisted, cloud, and unverified peer enrollment", async () => {
    const local = trafficAgent({ repoKey: "a".repeat(64) });
    const other = trafficAgent({ repoKey: "b".repeat(64) });
    const cloud = trafficAgent({ lane: "sdk-cloud" });
    const unverified = trafficAgent({ verified: false });
    const { registry } = await harness({
      agents: [local, other, cloud, unverified],
    });
    enroll(registry, local);
    enroll(registry, other);
    expect(() =>
      registry.createBridge({
        sourceAgentId: local.id,
        destinationAgentId: other.id,
        label: "not allowed",
      }),
    ).toThrow(/allowlist/i);
    expect(() => enroll(registry, cloud)).toThrow(/not eligible/i);
    expect(() => enroll(registry, unverified)).toThrow(/not eligible/i);
  });

  it("revokes stale memberships when a managed agent changes repositories", async () => {
    const agent = trafficAgent({ repoKey: "a".repeat(64) });
    const sender = trafficAgent({ repoKey: "a".repeat(64) });
    const { registry, agents } = await harness({ agents: [agent, sender] });
    const original = enroll(registry, agent);
    const other = enroll(registry, sender);
    registry.send({
      binding: other.binding,
      recipientMemberId: original.member.id,
      kind: "notice",
      body: "old repository message",
      clientMessageId: "old-repo",
    });
    agents.set(agent.id, {
      ...agent,
      repoKey: "b".repeat(64),
      repoLabel: "repo-b",
    });
    const moved = registry.ensureAgentEnrollment({ agentId: agent.id });
    expect(moved.repoKey).toBe("b".repeat(64));
    expect(() => registry.context(original.binding)).toThrow(/stale|repository/i);
    expect(
      registry.inbox(
        {
          origin: "cursor",
          agentId: agent.id,
          memberId: moved.id,
          membershipGeneration: moved.generation,
        },
        0,
      ),
    ).toEqual([]);
  });

  it("expires bridges with full membership, delivery, and lease revocation", async () => {
    let now = new Date("2026-07-23T20:00:00.000Z");
    const first = trafficAgent({ repoKey: "a".repeat(64) });
    const second = trafficAgent({ repoKey: "b".repeat(64) });
    const initial = await harness({
      agents: [first, second],
      now: () => new Date(now),
      allowlist: [
        {
          sourceRepoKey: first.repoKey!,
          destinationRepoKey: second.repoKey!,
        },
      ],
    });
    enroll(initial.registry, first);
    enroll(initial.registry, second);
    const bridge = initial.registry.createBridge({
      sourceAgentId: first.id,
      destinationAgentId: second.id,
      label: "expiring",
      expiresInMs: 60_000,
    });
    const members = initial.registry.listMembers(bridge.id);
    const source = members.find((member) => member.agentId === first.id)!;
    const destination = members.find((member) => member.agentId === second.id)!;
    initial.registry.send({
      binding: initial.registry.bindingForAgent({ agentId: first.id }),
      recipientMemberId: destination.id,
      kind: "notice",
      body: "expires",
      clientMessageId: "expiring-message",
    });
    initial.registry.defineResource({
      channelId: bridge.id,
      name: "preview-project",
      maximumTtlMs: 120_000,
      description: "bridge lease",
    });
    initial.registry.acquireResource({
      binding: {
        origin: "cursor",
        agentId: first.id,
        memberId: source.id,
        membershipGeneration: source.generation,
      },
      name: "preview-project",
      ttlMs: 120_000,
    });
    initial.registry.close();
    now = new Date(now.getTime() + 61_000);
    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: initial.path,
      now: () => new Date(now),
      agentResolver: (id) => initial.agents.get(id),
      bridgeAllowlist: [
        {
          sourceRepoKey: first.repoKey!,
          destinationRepoKey: second.repoKey!,
        },
      ],
    });
    registries.push(reopened);
    expect(reopened.getChannel(bridge.id).status).toBe("closed");
    expect(
      reopened.listMembers(bridge.id).every((member) => member.status === "revoked"),
    ).toBe(true);
    expect(
      reopened.inbox(reopened.bindingForAgent({ agentId: second.id }), 0),
    ).toEqual([]);
  });

  it("derives causal replies and atomically acknowledges their source", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const { registry } = await harness({ agents: [first, second] });
    const a = enroll(registry, first);
    const b = enroll(registry, second);
    const request = registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "request",
      body: "question",
      clientMessageId: "question",
    });
    const reply = registry.replyAndAcknowledge({
      binding: b.binding,
      deliveryId: request.delivery.id,
      kind: "response",
      body: "answer",
      clientMessageId: "answer",
    });
    expect(reply.message).toMatchObject({
      causalRoot: request.message.causalRoot,
      causalParent: request.message.id,
      recipientMemberId: a.member.id,
    });
    expect(reply.acknowledged.state).toBe("acknowledged");
  });

  it("detects message and receipt tampering before returning content", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const initial = await harness({ agents: [first, second] });
    const a = enroll(initial.registry, first);
    const b = enroll(initial.registry, second);
    const sent = initial.registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "notice",
      body: "original",
      clientMessageId: "tamper",
    });
    const receipt = initial.registry.recordReceipt({
      binding: a.binding,
      kind: "checkpoint",
      key: "tamper",
      payload: { sha: "a".repeat(40) },
    });
    initial.registry.close();
    const database = new DatabaseSync(initial.path);
    database
      .prepare("UPDATE peer_messages SET body = 'altered' WHERE id = ?")
      .run(sent.message.id);
    database
      .prepare(
        "UPDATE peer_receipts SET payload_json = '{\"sha\":\"bad\"}' WHERE id = ?",
      )
      .run(receipt.id);
    database.close();
    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: initial.path,
      agentResolver: (id) => initial.agents.get(id),
    });
    registries.push(reopened);
    expect(() => reopened.inbox(b.binding, 0)).toThrow(/verification/i);
    expect(() => reopened.context(a.binding)).toThrow(/verification/i);
  });

  it("continues receipt versions after resolved state", async () => {
    const agent = trafficAgent();
    const { registry } = await harness({ agents: [agent] });
    const member = enroll(registry, agent);
    const resolved = registry.recordReceipt({
      binding: member.binding,
      kind: "blocker",
      key: "database",
      payload: { resolved: true },
      status: "resolved",
    });
    const reopened = registry.recordReceipt({
      binding: member.binding,
      kind: "blocker",
      key: "database",
      payload: { resolved: false },
      status: "active",
    });
    expect(reopened.version).toBe(resolved.version + 1);
  });

  it("never reuses delivery cursors or channel sequences after retention purge", async () => {
    let now = new Date("2026-07-01T00:00:00.000Z");
    const first = trafficAgent();
    const second = trafficAgent();
    const { registry } = await harness({
      agents: [first, second],
      now: () => new Date(now),
    });
    const a = enroll(registry, first);
    const b = enroll(registry, second);
    const initial = registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "notice",
      body: "old",
      clientMessageId: "old-retained",
    });
    registry.acknowledge(b.binding, initial.delivery.id);
    now = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
    const next = registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "notice",
      body: "new",
      clientMessageId: "new-retained",
    });
    expect(next.delivery.cursor).toBeGreaterThan(initial.delivery.cursor);
    expect(next.message.sequence).toBeGreaterThan(initial.message.sequence);
  });

  it("detects delivery-routing tampering independently of message integrity", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const initial = await harness({ agents: [first, second] });
    const a = enroll(initial.registry, first);
    const b = enroll(initial.registry, second);
    const sent = initial.registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "notice",
      body: "route",
      clientMessageId: "route-tamper",
    });
    initial.registry.close();
    const database = new DatabaseSync(initial.path);
    database
      .prepare(
        "UPDATE peer_deliveries SET recipient_member_id = ? WHERE id = ?",
      )
      .run(a.member.id, sent.delivery.id);
    database.close();
    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: initial.path,
      agentResolver: (id) => initial.agents.get(id),
    });
    registries.push(reopened);
    expect(() => reopened.inbox(a.binding, 0)).toThrow(/verification/i);
  });

  it("versions wake policy without coalescing new messages into stale jobs", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const { registry } = await harness({ agents: [first, second] });
    const a = enroll(registry, first);
    const b = enroll(registry, second);
    const channel = registry.listChannels()[0]!;
    const enabled = registry.setWakePolicy({
      channelId: channel.id,
      policy: "coordination",
      policyDigest: "a".repeat(64),
    });
    const unchanged = registry.setWakePolicy({
      channelId: channel.id,
      policy: "coordination",
      policyDigest: "a".repeat(64),
    });
    expect(unchanged.policyVersion).toBe(enabled.policyVersion);
    registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "request",
      body: "old policy",
      clientMessageId: "old-policy-message",
    });
    const replaced = registry.setWakePolicy({
      channelId: channel.id,
      policy: "coordination",
      policyDigest: "b".repeat(64),
    });
    registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "request",
      body: "new policy",
      clientMessageId: "new-policy-message",
    });
    expect(registry.listWakeJobs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "suppressed",
          policyVersion: enabled.policyVersion,
        }),
        expect.objectContaining({
          state: "pending",
          policyVersion: replaced.policyVersion,
        }),
      ]),
    );
  });

  it("coalesces and executes bounded same-repo wake jobs", async () => {
    let now = new Date("2026-07-23T20:00:00.000Z");
    const first = trafficAgent();
    const second = trafficAgent({ status: "finished", readOnly: true });
    const { registry } = await harness({
      agents: [first, second],
      now: () => new Date(now),
    });
    const a = enroll(registry, first);
    const b = enroll(registry, second);
    const channel = registry.listChannels()[0]!;
    registry.setWakePolicy({
      channelId: channel.id,
      policy: "coordination",
      policyDigest: "a".repeat(64),
    });
    registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "request",
      body: "First request.",
      clientMessageId: "wake-1",
    });
    registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "dependency_ready",
      body: "Dependency ready.",
      clientMessageId: "wake-2",
    });
    expect(registry.listWakeJobs()).toHaveLength(2);
    expect(
      registry.listWakeJobs().every(
        (job) => job.state === "pending" && job.messageCount === 1,
      ),
    ).toBe(true);
    now = new Date(now.getTime() + 31_000);
    const woken: PeerWakeJob[] = [];
    const pump = new PeerWakePump(
      registry,
      {
        controllerLease: () => ({
          active: true,
          ownerInstanceId: "controller-1",
          generation: 1,
        }),
        wake: async (job) => {
          woken.push(job);
          return { externalRef: randomUUID() };
        },
      },
      10,
    );
    pump.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pump.stop();
    expect(woken).toHaveLength(1);
    expect(registry.listWakeJobs().map((job) => job.state).sort()).toEqual([
      "completed",
      "suppressed",
    ]);
  });

  it("keeps wake leases scoped by origin and intact across registry opens", async () => {
    let now = new Date("2026-07-23T20:00:00.000Z");
    const root = await mkdtemp(join(tmpdir(), "mesh-peer-origin-"));
    roots.push(root);
    const path = join(root, "peer.db");
    const first = trafficAgent({ origin: "codex" });
    const second = trafficAgent({ origin: "codex" });
    const agents = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const codex = new PeerChannelRegistry({
      origin: "codex",
      path,
      now: () => new Date(now),
      agentResolver: (id) => agents.get(id),
    });
    registries.push(codex);
    const a = codex.ensureAgentEnrollment({ agentId: first.id });
    const b = codex.ensureAgentEnrollment({ agentId: second.id });
    codex.setWakePolicy({
      channelId: codex.listChannels()[0]!.id,
      policy: "coordination",
    });
    codex.send({
      binding: {
        origin: "codex",
        agentId: first.id,
        memberId: a.id,
        membershipGeneration: a.generation,
      },
      recipientMemberId: b.id,
      kind: "request",
      body: "wake",
      clientMessageId: "origin-wake",
    });
    now = new Date(now.getTime() + 31_000);
    const claimed = codex.claimWake({
      controllerId: "codex-controller",
      controllerGeneration: 1,
    });
    expect(claimed?.state).toBe("leased");
    codex.send({
      binding: {
        origin: "codex",
        agentId: first.id,
        memberId: a.id,
        membershipGeneration: a.generation,
      },
      recipientMemberId: b.id,
      kind: "request",
      body: "follow-on",
      clientMessageId: "origin-wake-follow-on",
    });
    expect(codex.listWakeJobs().map((job) => job.state).sort()).toEqual([
      "leased",
      "pending",
    ]);
    const cursor = new PeerChannelRegistry({
      origin: "cursor",
      path,
      now: () => new Date(now),
      agentResolver: () => undefined,
    });
    registries.push(cursor);
    expect(cursor.claimWake({
      controllerId: "cursor-controller",
      controllerGeneration: 1,
    })).toBeUndefined();
    expect(
      codex.listWakeJobs().find((job) => job.id === claimed?.id)?.state,
    ).toBe("leased");
  });

  it("persists deliveries and verifies audit after registry reopen", async () => {
    const first = trafficAgent();
    const second = trafficAgent();
    const initial = await harness({ agents: [first, second] });
    const a = enroll(initial.registry, first);
    const b = enroll(initial.registry, second);
    const sent = initial.registry.send({
      binding: a.binding,
      recipientMemberId: b.member.id,
      kind: "checkpoint",
      payload: { sha: "a".repeat(40) },
      clientMessageId: "durable",
    });
    initial.registry.close();
    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: initial.path,
      agentResolver: (id) => initial.agents.get(id),
    });
    registries.push(reopened);
    expect(reopened.inbox(b.binding, 0)[0]?.message.id).toBe(sent.message.id);
    expect(reopened.auditEvents().length).toBeGreaterThan(0);
  });

  it("transactionally upgrades the preceding peer database schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-peer-migration-"));
    roots.push(root);
    const path = join(root, "peer.db");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE peer_channels (
        id TEXT PRIMARY KEY, origin TEXT NOT NULL, kind TEXT NOT NULL,
        label TEXT NOT NULL, status TEXT NOT NULL, source_repo_key TEXT NOT NULL,
        destination_repo_key TEXT, bidirectional INTEGER NOT NULL,
        wake_policy TEXT NOT NULL, policy_version INTEGER NOT NULL,
        policy_digest TEXT, message_limit INTEGER NOT NULL, byte_limit INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0, byte_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
      );
      CREATE TABLE peer_deliveries (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
        recipient_member_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        cursor INTEGER NOT NULL UNIQUE, state TEXT NOT NULL, lease_owner TEXT,
        lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        acknowledged_at TEXT, reason TEXT
      );
      CREATE TABLE peer_receipts (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, member_id TEXT NOT NULL,
        kind TEXT NOT NULL, receipt_key TEXT NOT NULL, version INTEGER NOT NULL,
        payload_json TEXT NOT NULL, observed_json TEXT NOT NULL, status TEXT NOT NULL,
        message_id TEXT, receipt_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, member_id, kind, receipt_key, version)
      );
      CREATE TABLE peer_resource_policies (
        channel_id TEXT NOT NULL, resource_name TEXT NOT NULL,
        maximum_ttl_ms INTEGER NOT NULL, description TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(channel_id, resource_name)
      );
      CREATE TABLE peer_wake_jobs (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, recipient_member_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL, first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL, message_count INTEGER NOT NULL,
        causal_root TEXT NOT NULL, state TEXT NOT NULL, policy_version INTEGER NOT NULL,
        available_at TEXT NOT NULL, lease_owner TEXT, controller_generation INTEGER,
        lease_expires_at TEXT, external_ref TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
    `);
    database.close();
    const registry = new PeerChannelRegistry({
      origin: "cursor",
      path,
      agentResolver: () => undefined,
    });
    registries.push(registry);
    expect(registry.listChannels()).toEqual([]);
    expect(registry.listWakeJobs()).toEqual([]);
    const migrated = new DatabaseSync(path);
    const indexes = migrated
      .prepare("PRAGMA index_list(peer_deliveries)")
      .all() as Array<Record<string, unknown>>;
    const cursorOnlyUnique = indexes.some((index) => {
      if (Number(index.unique) !== 1) return false;
      const columns = migrated
        .prepare(`PRAGMA index_info(${String(index.name)})`)
        .all() as Array<Record<string, unknown>>;
      return (
        columns.length === 1 &&
        String(columns[0]?.name) === "cursor"
      );
    });
    migrated.close();
    expect(cursorOnlyUnique).toBe(false);
  });

  it("transactionally migrates the v5 schema to direction schema v6", async () => {
    const initial = await harness();
    initial.registry.close();
    const versionFive = new DatabaseSync(initial.path);
    versionFive.exec(`
      DROP TABLE peer_direction_targets;
      DROP TABLE peer_direction_revisions;
      DROP TABLE peer_directions;
      UPDATE peer_schema_meta
      SET version = 5
      WHERE singleton = 1;
    `);
    versionFive.close();

    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: initial.path,
      agentResolver: () => undefined,
    });
    registries.push(reopened);
    expect(
      reopened.directionOutbox({
        afterSequence: 0,
        limit: 100,
        includeHistory: true,
      }),
    ).toEqual([]);
    const migrated = new DatabaseSync(initial.path);
    const version = migrated
      .prepare(
        "SELECT version FROM peer_schema_meta WHERE singleton = 1",
      )
      .get() as { version: number };
    const tables = migrated
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'peer_direction%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    migrated.close();
    expect(Number(version.version)).toBe(7);
    expect(tables.map((table) => table.name)).toEqual([
      "peer_direction_revisions",
      "peer_direction_targets",
      "peer_directions",
    ]);
  });

  it("transactionally migrates the v6 schema to friction schema v7", async () => {
    const initial = await harness();
    initial.registry.close();
    const versionSix = new DatabaseSync(initial.path);
    versionSix.exec(`
      DROP TABLE peer_friction_events;
      UPDATE peer_schema_meta
      SET version = 6
      WHERE singleton = 1;
    `);
    versionSix.close();

    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: initial.path,
      agentResolver: () => undefined,
    });
    registries.push(reopened);
    expect(reopened.frictionEvents()).toEqual([]);
    const recorded = reopened.recordFriction({
      repoKey: "8".repeat(64),
      kind: "blocking_question",
      detail: "A blocking question stalled the wave.",
      dedupeKey: "blocking_question:wave-1",
    });
    expect(reopened.frictionEvents()).toEqual([recorded]);
    const migrated = new DatabaseSync(initial.path);
    const version = migrated
      .prepare(
        "SELECT version FROM peer_schema_meta WHERE singleton = 1",
      )
      .get() as { version: number };
    const indexes = migrated
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'peer_friction_events'
           AND name LIKE 'idx_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    migrated.close();
    expect(Number(version.version)).toBe(7);
    expect(indexes.map((index) => index.name)).toEqual([
      "idx_peer_friction_repo",
      "idx_peer_friction_window",
    ]);
  });

  it("verifies populated legacy receipt signatures after migration", async () => {
    const agent = trafficAgent();
    const initial = await harness({ agents: [agent] });
    const member = enroll(initial.registry, agent);
    initial.registry.recordReceipt({
      binding: member.binding,
      kind: "checkpoint",
      key: "legacy",
      payload: { sha: "a".repeat(40) },
      observed: { head: "a".repeat(40) },
    });
    const receipt = initial.registry.recordReceipt({
      binding: member.binding,
      kind: "checkpoint",
      key: "legacy",
      payload: { sha: "b".repeat(40) },
      observed: { head: "b".repeat(40) },
    });
    initial.registry.close();
    const database = new DatabaseSync(initial.path);
    const rows = database
      .prepare("SELECT * FROM peer_receipts ORDER BY version")
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const legacyHash = agentMeshHmac(
        "peer-receipt-envelope",
        canonicalJson({
          id: String(row.id),
          channelId: String(row.channel_id),
          memberId: String(row.member_id),
          kind: String(row.kind),
          key: String(row.receipt_key),
          version: Number(row.version),
          payloadDigest: agentMeshHmac(
            "peer-receipt",
            String(row.payload_json),
          ),
          observedDigest: agentMeshHmac(
            "peer-observed",
            String(row.observed_json),
          ),
          status: String(row.status),
          createdAt: String(row.created_at),
        }),
      );
      database
        .prepare(
          `UPDATE peer_receipts
           SET previous_receipt_hash = NULL, receipt_hash = ?
           WHERE id = ?`,
        )
        .run(legacyHash, String(row.id));
    }
    database.prepare("DELETE FROM peer_receipt_heads").run();
    database
      .prepare("DELETE FROM peer_audit_events WHERE entity_type = 'receipt_head'")
      .run();
    database
      .prepare("UPDATE peer_schema_meta SET version = 2 WHERE singleton = 1")
      .run();
    database.close();
    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: initial.path,
      agentResolver: (id) => initial.agents.get(id),
    });
    registries.push(reopened);
    expect(reopened.context(member.binding).receipts).toEqual([
      expect.objectContaining({ id: receipt.id }),
    ]);
  });

  it("loads only private canonical bridge allowlists", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-peer-allowlist-"));
    roots.push(root);
    const file = join(root, "bridges.json");
    await writeFile(
      file,
      JSON.stringify([{ source: "/repo/a", destination: "/repo/b" }]),
      { mode: 0o600 },
    );
    expect(
      await loadBridgeAllowlistFile({
        path: file,
        resolveRepoKey: async (path) =>
          path.endsWith("/a") ? "a".repeat(64) : "b".repeat(64),
      }),
    ).toEqual([
      {
        sourceRepoKey: "a".repeat(64),
        destinationRepoKey: "b".repeat(64),
      },
    ]);
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      expect(() =>
        loadBridgeAllowlistFile({
          path: file,
          resolveRepoKey: async () => "a".repeat(64),
        }),
      ).toThrow(/private owner file/i);
    }
  });
});

async function intakeWorkspace(): Promise<{
  repo: string;
  repoKey: string;
  peerPath: string;
  trafficPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mesh-peer-intake-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const repo = join(root, "workspace");
  await mkdir(repo, { recursive: true });
  process.env.AGENT_MESH_STATE_DIR = stateRoot;
  process.env.AGENT_MESH_ALLOWED_ROOTS = [root, stateRoot].join(delimiter);
  await execFileAsync(process.platform === "win32" ? "git" : "/usr/bin/git", ["init"], { cwd: repo });
  const location = await resolveTrafficLocation(repo);
  return {
    repo,
    repoKey: location.repoKey,
    peerPath: join(root, "peer.db"),
    trafficPath: join(root, "traffic.db"),
  };
}

describe("human direction intake", () => {
  it("parses bounded hook payloads and defaults the intake origin", () => {
    expect(parseIntakeRequest("not json at all")).toBeNull();
    expect(parseIntakeRequest(JSON.stringify(["prompt"]))).toBeNull();
    expect(
      parseIntakeRequest(JSON.stringify({ conversation_id: "conversation-1" })),
    ).toBeNull();
    expect(
      parseIntakeRequest(
        JSON.stringify({
          prompt: "Land the checkout fix before the router refactor.",
          conversation_id: "conversation-1",
          generation_id: "generation-1",
          workspace_roots: ["relative/workspace", "/absolute/workspace"],
        }),
      ),
    ).toEqual({
      prompt: "Land the checkout fix before the router refactor.",
      conversationId: "conversation-1",
      generationId: "generation-1",
      workspaceRoots: ["/absolute/workspace"],
    });
    expect(intakeOrigin(["--origin=codex"])).toBe("codex");
    expect(intakeOrigin(["--origin=not-a-provider"])).toBe("cursor");
    expect(intakeOrigin([])).toBe("cursor");
  });

  it("refuses to publish direction from a delegated child process", async () => {
    const workspace = await intakeWorkspace();
    process.env.AGENT_MESH_CHILD = "1";
    expect(
      await runDirectionIntake(
        {
          prompt: "Publish forged direction for every peer in this repository.",
          conversationId: "conversation-1",
          generationId: "generation-1",
          workspaceRoots: [workspace.repo],
        },
        {
          origin: "cursor",
          peerPath: workspace.peerPath,
          trafficPath: workspace.trafficPath,
        },
      ),
    ).toEqual({ outcome: "refused-delegated-child" });
  });

  it("exits quietly for trivial prompts, foreign workspaces, and idle repositories", async () => {
    const workspace = await intakeWorkspace();
    delete process.env.AGENT_MESH_CHILD;
    const options = {
      origin: "cursor" as const,
      peerPath: workspace.peerPath,
      trafficPath: workspace.trafficPath,
    };
    expect(
      await runDirectionIntake(
        {
          prompt: "ok thanks",
          conversationId: "conversation-1",
          generationId: "generation-1",
          workspaceRoots: [workspace.repo],
        },
        options,
      ),
    ).toEqual({ outcome: "prompt-too-short" });

    const request = {
      prompt: "Keep the current implementation direction and finish the fix.",
      conversationId: "conversation-1",
      generationId: "generation-1",
      workspaceRoots: [tmpdir()],
    };
    expect(await runDirectionIntake(request, options)).toEqual({
      outcome: "no-git-workspace",
    });
    expect(
      await runDirectionIntake(
        { ...request, workspaceRoots: [workspace.repo] },
        options,
      ),
    ).toEqual({ outcome: "no-mesh-activity" });

    const traffic = new TrafficControlRegistry({
      origin: "cursor",
      path: workspace.trafficPath,
    });
    trafficRegistries.push(traffic);
    const peers = new PeerChannelRegistry({
      origin: "cursor",
      path: workspace.peerPath,
      agentResolver: () => undefined,
    });
    registries.push(peers);
    peers.close();
    traffic.close();
    expect(
      await runDirectionIntake(
        { ...request, workspaceRoots: [workspace.repo] },
        options,
      ),
    ).toEqual({ outcome: "no-mesh-activity" });
  });

  it("publishes redacted hook direction to the resolved repository channel", async () => {
    const workspace = await intakeWorkspace();
    delete process.env.AGENT_MESH_CHILD;
    const location = await resolveTrafficLocation(workspace.repo);
    const traffic = new TrafficControlRegistry({
      origin: "cursor",
      path: workspace.trafficPath,
    });
    trafficRegistries.push(traffic);
    const agent = traffic.upsertAgent({
      lane: "sdk-local",
      externalId: `agent-intake-${randomUUID()}`,
      name: "Intake target",
      status: "running",
      model: "fake-model",
      modelSelection: { id: "fake-model" },
      location,
      adopted: false,
    });
    const peers = new PeerChannelRegistry({
      origin: "cursor",
      path: workspace.peerPath,
      agentResolver: (id) => traffic.getAgent(id),
    });
    registries.push(peers);
    peers.ensureAgentEnrollment({ agentId: agent.id, runId: randomUUID() });
    peers.close();
    traffic.close();

    const request = {
      prompt:
        "Stop the router refactor and land the checkout fix first.\nUse api_key=sk-abcdefghijklmnop only in the local shell.",
      conversationId: "conversation-7",
      generationId: "generation-3",
      workspaceRoots: [workspace.repo],
    };
    const options = {
      origin: "cursor" as const,
      peerPath: workspace.peerPath,
      trafficPath: workspace.trafficPath,
    };
    const published = await runDirectionIntake(request, options);
    expect(published).toMatchObject({
      outcome: "published",
      revision: 1,
      targets: 1,
    });
    expect(await runDirectionIntake(request, options)).toEqual(published);

    const reopened = new PeerChannelRegistry({
      origin: "cursor",
      path: workspace.peerPath,
      agentResolver: () => undefined,
    });
    registries.push(reopened);
    const outbox = reopened.directionOutbox({
      afterSequence: 0,
      limit: 100,
      includeHistory: true,
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.direction).toMatchObject({
      repoKey: workspace.repoKey,
      currentRevision: 1,
    });
    expect(outbox[0]!.revision).toMatchObject({
      provenance: "hook_prompt",
      conversationId: "conversation-7",
      idempotencyKey: "conversation-7:generation-3",
      title: "Stop the router refactor and land the checkout fix first.",
    });
    expect(outbox[0]!.revision.body).toContain("[REDACTED]");
    expect(outbox[0]!.revision.body).not.toContain("sk-abcdefghijklmnop");
    expect(outbox[0]!.targets.map((target) => target.agentId)).toEqual([
      agent.id,
    ]);
  });
});
