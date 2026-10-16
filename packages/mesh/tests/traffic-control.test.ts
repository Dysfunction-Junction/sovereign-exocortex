import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import {
  AuthenticationError,
  CursorSdkError,
  NetworkError,
  RateLimitError,
} from "@cursor/sdk";
import type {
  AgentOptions,
  GetAgentOptions,
  GetRunOptions,
  ListAgentsOptions,
  ListResult,
  ListRunsOptions,
  ModelSelection,
  Run,
  RunOperation,
  RunResult,
  RunStatus,
  SDKAgent,
  SDKAgentInfo,
  SendOptions,
} from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskRegistry } from "../registry.js";
import { AgentMeshRouter } from "../router.js";
import { InitiativeRegistry } from "../initiatives.js";
import {
  PeerChannelRegistry,
  type PeerDirectionOutboxEntry,
  type PeerFrictionEvent,
} from "../peer-channels.js";
import {
  deriveSupervisionConditions,
  MeshSupervisor,
  type SupervisionConditionEvidence,
} from "../supervision.js";
import {
  assertImplementationDirectionsAcknowledged,
  TrafficControlRegistry,
  TrafficController,
  CURSOR_FABLE_5_MAX_MODEL,
  CURSOR_OPUS_5_MAX_MODEL,
  TrafficModelFallbackBlockedError,
  cursorClaudeFallbackModel,
  parseTrafficPresence,
  resolveTrafficLocation,
  type CursorSdkFacade,
} from "../traffic-control.js";
import type {
  ProviderAdapter,
  ProviderRunHooks,
  ProviderRunRequest,
  TaskRecord,
} from "../types.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const registries: TrafficControlRegistry[] = [];
const peerRegistries: PeerChannelRegistry[] = [];
const routers: AgentMeshRouter[] = [];
const originalStateDir = process.env.AGENT_MESH_STATE_DIR;
const originalAllowedRoots = process.env.AGENT_MESH_ALLOWED_ROOTS;
const originalPendingGrace =
  process.env.AGENT_MESH_TRAFFIC_PENDING_GRACE_MS;
const originalAllowCursorSdk = process.env.AGENT_MESH_ALLOW_CURSOR_SDK;

// These tests exercise the SDK lanes themselves, so they opt in explicitly.
// Production defaults to refusing SDK launches because they bill Cursor usage.
beforeEach(() => {
  process.env.AGENT_MESH_ALLOW_CURSOR_SDK = "1";
});

afterEach(async () => {
  if (originalAllowCursorSdk === undefined) {
    delete process.env.AGENT_MESH_ALLOW_CURSOR_SDK;
  } else {
    process.env.AGENT_MESH_ALLOW_CURSOR_SDK = originalAllowCursorSdk;
  }
  for (const router of routers.splice(0)) {
    await router.close().catch(() => undefined);
  }
  for (const registry of peerRegistries.splice(0)) {
    try {
      registry.close();
    } catch {
      // A test may intentionally close a registry first.
    }
  }
  for (const registry of registries.splice(0)) {
    try {
      registry.close();
    } catch {
      // A test may intentionally close a registry first.
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (originalStateDir === undefined) delete process.env.AGENT_MESH_STATE_DIR;
  else process.env.AGENT_MESH_STATE_DIR = originalStateDir;
  if (originalAllowedRoots === undefined) delete process.env.AGENT_MESH_ALLOWED_ROOTS;
  else process.env.AGENT_MESH_ALLOWED_ROOTS = originalAllowedRoots;
  if (originalPendingGrace === undefined) {
    delete process.env.AGENT_MESH_TRAFFIC_PENDING_GRACE_MS;
  } else {
    process.env.AGENT_MESH_TRAFFIC_PENDING_GRACE_MS =
      originalPendingGrace;
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? "git" : "/usr/bin/git",
    args,
    {
      cwd,
      encoding: "utf8",
    },
  );
  return stdout.trim();
}

async function repository(meshOwned = true): Promise<{
  root: string;
  stateRoot: string;
  repo: string;
  head: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mesh-traffic-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const repo = meshOwned
    ? join(stateRoot, "worktrees", "traffic-repo")
    : join(root, "source-repo");
  await mkdir(repo, { recursive: true });
  process.env.AGENT_MESH_STATE_DIR = stateRoot;
  process.env.AGENT_MESH_ALLOWED_ROOTS = [root, stateRoot].join(delimiter);
  await git(repo, ["init"]);
  await writeFile(join(repo, "README.md"), "traffic test\n", "utf8");
  await git(repo, ["add", "README.md"]);
  await git(repo, [
    "-c",
    "user.name=Traffic Test",
    "-c",
    "user.email=traffic@example.test",
    "commit",
    "-m",
    "initial",
  ]);
  return {
    root,
    stateRoot,
    repo,
    head: await git(repo, ["rev-parse", "HEAD"]),
  };
}

function trafficRegistry(
  root: string,
  name = "traffic.db",
): TrafficControlRegistry {
  const registry = new TrafficControlRegistry({
    origin: "cursor",
    path: join(root, name),
    controllerTtlMs: 5_000,
    participantTtlMs: 5_000,
    writerTtlMs: 30_000,
  });
  registries.push(registry);
  return registry;
}

function router(
  root: string,
  adapters: ProviderAdapter[] = [],
  gate?: TrafficControlRegistry,
): AgentMeshRouter {
  const registry = new TaskRegistry(join(root, `mesh-${randomUUID()}.db`));
  const value = new AgentMeshRouter("cursor", registry, adapters, gate);
  routers.push(value);
  return value;
}

function meshTask(
  fixture: Awaited<ReturnType<typeof repository>>,
  id = randomUUID(),
): TaskRecord {
  const now = new Date().toISOString();
  return {
    id,
    origin: "cursor",
    provider: "codex",
    description: "traffic task",
    mode: "implement",
    status: "queued",
    cwd: fixture.repo,
    effectiveCwd: fixture.repo,
    repoRoot: fixture.repo,
    worktreePath: null,
    baseCommit: fixture.head,
    model: null,
    effort: null,
    mcpProfile: "none",
    sessionId: null,
    parentTaskId: null,
    initiativeId: null,
    swarmId: null,
    swarmMemberId: null,
    peerCausalRoot: null,
    peerCausalPath: [],
    ownerPid: process.pid,
    pid: null,
    resultPath: null,
    eventsPath: null,
    transcriptPath: null,
    pendingQuestionId: null,
    patchPath: null,
    changedFiles: [],
    artifactStatus: "pending",
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

async function directionTarget() {
  const fixture = await repository(false);
  const traffic = trafficRegistry(fixture.root);
  const location = await resolveTrafficLocation(fixture.repo);
  const taskId = randomUUID();
  const agent = traffic.upsertAgent({
    lane: "mesh-cli",
    externalId: `codex:direction-${randomUUID()}`,
    provider: "codex",
    meshTaskId: taskId,
    name: "Direction target",
    status: "running",
    model: null,
    modelSelection: null,
    location,
    adopted: false,
  });
  const peers = new PeerChannelRegistry({
    origin: "cursor",
    path: join(fixture.root, `peers-${randomUUID()}.db`),
    agentResolver: (agentId) => traffic.getAgent(agentId),
  });
  const member = peers.ensureAgentEnrollment({
    agentId: agent.id,
    taskId,
  });
  const direction = peers.publishDirection({
    expectedRevision: 0,
    repoKey: location.repoKey,
    title: "Apply current human direction",
    body: "Acknowledge this direction before writing.",
    summary: "Writer synchronization gate.",
    affectedPaths: ["src/**"],
    provenance: "hook_prompt",
    disposition: "active",
    idempotencyKey: randomUUID(),
  });
  return {
    fixture,
    location,
    agent,
    peers,
    direction,
    binding: {
      origin: "cursor" as const,
      agentId: agent.id,
      memberId: member.id,
      membershipGeneration: member.generation,
      taskId,
    },
  };
}

function claimSdkWriter(
  registry: TrafficControlRegistry,
  location: Awaited<ReturnType<typeof resolveTrafficLocation>>,
): { agentId: string; runId: string } {
  const agent = registry.upsertAgent({
    lane: "sdk-local",
    externalId: `agent-blocker-${randomUUID()}`,
    name: "Lease blocker",
    status: "running",
    model: "fake-model",
    modelSelection: { id: "fake-model" },
    location,
    adopted: false,
  });
  const run = registry.createRun({
    agentId: agent.id,
    externalRunId: `run-blocker-${randomUUID()}`,
    status: "running",
  });
  registry.claimWriter({
    worktreeKey: location.worktreeKey,
    ownerKind: "sdk-agent",
    ownerId: run.id,
    ownerPid: process.pid,
  });
  return { agentId: agent.id, runId: run.id };
}

class FakeRun implements Run {
  readonly requestId = undefined;
  readonly result = undefined;
  readonly error = undefined;
  readonly model = undefined;
  readonly durationMs = undefined;
  readonly usage = undefined;
  readonly git = undefined;
  readonly createdAt = Date.now();
  status: RunStatus = "running";
  private readonly listeners = new Set<(status: RunStatus) => void>();
  private readonly promise: Promise<RunResult>;
  private settle!: (result: RunResult) => void;

  constructor(
    readonly id: string,
    readonly agentId: string,
    private readonly cancellable = true,
  ) {
    this.promise = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  supports(operation: RunOperation): boolean {
    return operation !== "cancel" || this.cancellable;
  }

  unsupportedReason(operation: RunOperation): string | undefined {
    return this.supports(operation) ? undefined : "fake detached run cannot cancel";
  }

  async *stream() {
    yield* [];
  }

  async conversation() {
    return [];
  }

  wait(): Promise<RunResult> {
    return this.promise;
  }

  async cancel(): Promise<void> {
    if (!this.cancellable) throw new Error("fake detached run cannot cancel");
    this.finish("cancelled");
  }

  onDidChangeStatus(listener: (status: RunStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  finish(status: Exclude<RunStatus, "running">): void {
    if (this.status !== "running") return;
    this.status = status;
    for (const listener of this.listeners) listener(status);
    this.settle({ id: this.id, status });
  }
}

class FakeAgent implements SDKAgent {
  readonly model: ModelSelection | undefined;
  closed = false;

  constructor(
    readonly agentId: string,
    model: ModelSelection | undefined,
    private readonly sdk: FakeSdk,
  ) {
    this.model = model;
  }

  async send(
    _message: string,
    options?: SendOptions,
  ): Promise<Run> {
    await this.sdk.sendBarrier;
    this.sdk.sendOptions.push(options);
    const queuedError = this.sdk.sendErrors.shift();
    if (queuedError || this.sdk.nextSendError) {
      await this.sdk.nextSendMutation?.();
      this.sdk.nextSendMutation = undefined;
      const error = queuedError ?? this.sdk.nextSendError!;
      this.sdk.nextSendError = undefined;
      throw error;
    }
    return this.sdk.newRun(this.agentId);
  }

  close(): void {
    this.closed = true;
  }

  async reload(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    this.closed = true;
  }

  async listArtifacts() {
    return [];
  }

  async downloadArtifact(): Promise<Buffer> {
    return Buffer.alloc(0);
  }
}

class FakeSdk implements CursorSdkFacade {
  readonly agents = new Map<string, FakeAgent>();
  readonly runs = new Map<string, FakeRun>();
  readonly createOptions: AgentOptions[] = [];
  readonly resumeOptions: Array<Partial<AgentOptions> | undefined> = [];
  readonly sendOptions: Array<SendOptions | undefined> = [];
  cancellable = true;
  sendCount = 0;
  createBarrier: Promise<void> | undefined;
  sendBarrier: Promise<void> | undefined;
  listRunsBarrier: Promise<void> | undefined;
  detachListedRuns = false;
  nextSendError: Error | undefined;
  nextCreateError: Error | undefined;
  nextSendMutation: (() => Promise<void>) | undefined;
  readonly sendErrors: Error[] = [];
  private agentSequence = 0;
  private runSequence = 0;

  async create(options: AgentOptions): Promise<SDKAgent> {
    this.createOptions.push(options);
    await this.createBarrier;
    if (this.nextCreateError) {
      const error = this.nextCreateError;
      this.nextCreateError = undefined;
      throw error;
    }
    const id =
      options.cloud !== undefined
        ? `bc-fake-${++this.agentSequence}`
        : `agent-fake-${++this.agentSequence}`;
    const agent = new FakeAgent(id, options.model, this);
    this.agents.set(id, agent);
    return agent;
  }

  async resume(
    agentId: string,
    options?: Partial<AgentOptions>,
  ): Promise<SDKAgent> {
    this.resumeOptions.push(options);
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown fake agent: ${agentId}`);
    return agent;
  }

  async list(
    options?: ListAgentsOptions,
  ): Promise<ListResult<SDKAgentInfo>> {
    const runtime = options && "runtime" in options ? options.runtime : undefined;
    return {
      items: [...this.agents.values()]
        .filter((agent) =>
          runtime === "cloud"
            ? agent.agentId.startsWith("bc-")
            : runtime === "local"
              ? !agent.agentId.startsWith("bc-")
              : true,
        )
        .map((agent) => ({
          agentId: agent.agentId,
          name: agent.agentId,
          summary: "",
          lastModified: Date.now(),
          status: this.latestRun(agent.agentId)?.status === "running"
            ? "running"
            : "finished",
          runtime: agent.agentId.startsWith("bc-") ? "cloud" : "local",
        } as SDKAgentInfo)),
    };
  }

  async get(
    agentId: string,
    _options?: GetAgentOptions,
  ): Promise<SDKAgentInfo> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown fake agent: ${agentId}`);
    return {
      agentId,
      name: agentId,
      summary: "",
      lastModified: Date.now(),
      status: "finished",
      runtime: agentId.startsWith("bc-") ? "cloud" : "local",
    } as SDKAgentInfo;
  }

  async listRuns(
    agentId: string,
    _options?: ListRunsOptions,
  ): Promise<ListResult<Run>> {
    await this.listRunsBarrier;
    return {
      items: [...this.runs.values()]
        .filter((run) => run.agentId === agentId)
        .map((run) => {
          if (!this.detachListedRuns || run.status !== "running") return run;
          const detached = new FakeRun(run.id, run.agentId, true);
          detached.supports = (operation: RunOperation) =>
            operation !== "wait" && operation !== "cancel";
          detached.unsupportedReason = (operation: RunOperation) =>
            detached.supports(operation)
              ? undefined
              : `detached ${operation} unsupported`;
          return detached;
        }),
    };
  }

  async getRun(runId: string, _options?: GetRunOptions): Promise<Run> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown fake run: ${runId}`);
    return run;
  }

  newRun(agentId: string): FakeRun {
    this.sendCount += 1;
    const run = new FakeRun(
      `run-fake-${++this.runSequence}`,
      agentId,
      this.cancellable,
    );
    this.runs.set(run.id, run);
    return run;
  }

  latestRun(agentId: string): FakeRun | undefined {
    return [...this.runs.values()].filter((run) => run.agentId === agentId).at(-1);
  }
}

class InstantCodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;

  capabilities() {
    return {
      provider: this.provider,
      dynamicModelDiscovery: false,
      resume: true,
      fork: true,
      nativeSessionSearch: false,
      nativeCancellation: false,
      notes: [],
    };
  }

  async listModels() {
    return [];
  }

  async run(
    request: ProviderRunRequest,
    hooks: ProviderRunHooks,
  ) {
    hooks.onStarted({ cancel: async () => undefined });
    const sessionId = request.sessionId ?? "codex-traffic-session";
    hooks.onSession(sessionId);
    return { output: "ok", sessionId };
  }
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe.sequential("agent traffic control", () => {
  it("plans only symmetric structured Cursor capacity fallbacks", () => {
    expect(
      cursorClaudeFallbackModel(
        CURSOR_OPUS_5_MAX_MODEL,
        new RateLimitError("Too many requests"),
      ),
    ).toEqual(CURSOR_FABLE_5_MAX_MODEL);
    expect(
      cursorClaudeFallbackModel(
        CURSOR_FABLE_5_MAX_MODEL,
        new RateLimitError("Fable credits exhausted"),
      ),
    ).toEqual(CURSOR_OPUS_5_MAX_MODEL);
    expect(
      cursorClaudeFallbackModel(
        CURSOR_OPUS_5_MAX_MODEL,
        new Error("Weekly usage limit exceeded"),
      ),
    ).toBeUndefined();
    expect(
      cursorClaudeFallbackModel(
        { id: "gpt-5.6-sol-max" },
        new RateLimitError("Weekly usage limit exceeded"),
      ),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "Opus to Fable",
      selected: CURSOR_OPUS_5_MAX_MODEL,
      fallback: CURSOR_FABLE_5_MAX_MODEL,
      error: new RateLimitError("Opus capacity overloaded"),
    },
    {
      name: "Fable to Opus",
      selected: CURSOR_FABLE_5_MAX_MODEL,
      fallback: CURSOR_OPUS_5_MAX_MODEL,
      error: new RateLimitError("Fable credits exhausted"),
    },
  ])("retries one unstarted Cursor run from $name", async ({
    selected,
    fallback,
    error,
  }) => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    sdk.nextSendError = error;
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Claude fallback",
      prompt: "Review the repository.",
      model: selected,
      mode: "plan",
      cwd: fixture.repo,
      idempotencyKey: "claude-fallback-launch",
    });
    expect(sdk.sendOptions.map((options) => options?.model?.id)).toEqual([
      selected.id,
      fallback.id,
    ]);
    expect(sdk.sendOptions[1]?.idempotencyKey).toBe(
      `claude-fallback-launch:model:${fallback.id}`,
    );
    expect(launched.agent.model).toBe(fallback.id);
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await controller.close();
  });

  it("allows no third attempt after the fallback also fails", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    sdk.sendErrors.push(
      new RateLimitError("Opus capacity overloaded"),
      new RateLimitError("Fable capacity overloaded"),
    );
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    await expect(
      controller.launch({
        lane: "sdk-local",
        name: "Bounded fallback",
        prompt: "Review the repository.",
        model: CURSOR_OPUS_5_MAX_MODEL,
        mode: "plan",
        cwd: fixture.repo,
      }),
    ).rejects.toThrow(/Fable capacity overloaded/);
    expect(sdk.sendOptions.map((options) => options?.model?.id)).toEqual([
      CURSOR_OPUS_5_MAX_MODEL.id,
      CURSOR_FABLE_5_MAX_MODEL.id,
    ]);
    await controller.close();
  });

  it("shares one fallback budget across creation and the first send", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    sdk.nextCreateError = new RateLimitError("Opus capacity overloaded");
    sdk.nextSendError = new RateLimitError("Fable capacity overloaded");
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    await expect(
      controller.launch({
        lane: "sdk-local",
        name: "Shared budget",
        prompt: "Review the repository.",
        model: CURSOR_OPUS_5_MAX_MODEL,
        mode: "plan",
        cwd: fixture.repo,
      }),
    ).rejects.toThrow(/Fable capacity overloaded/);
    expect(sdk.createOptions.map((options) => options.model?.id)).toEqual([
      CURSOR_OPUS_5_MAX_MODEL.id,
      CURSOR_FABLE_5_MAX_MODEL.id,
    ]);
    expect(sdk.sendOptions).toHaveLength(1);
    await controller.close();
  });

  it.each([
    new AuthenticationError("Authentication failed"),
    new NetworkError("Network unavailable"),
    new CursorSdkError("Request timed out", { code: "deadline_exceeded" }),
    new CursorSdkError("Request cancelled", { code: "cancelled" }),
    new Error("Weekly usage limit exceeded"),
  ])("does not fall back for non-capacity or unstructured errors", async (error) => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    sdk.nextSendError = error;
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    await expect(
      controller.launch({
        lane: "sdk-local",
        name: "No fallback",
        prompt: "Review the repository.",
        model: CURSOR_OPUS_5_MAX_MODEL,
        mode: "plan",
        cwd: fixture.repo,
      }),
    ).rejects.toThrow(error.message);
    expect(sdk.sendOptions).toHaveLength(1);
    await controller.close();
  });

  it("blocks fallback after a worktree mutation", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    sdk.nextSendError = new RateLimitError("Opus capacity overloaded");
    sdk.nextSendMutation = () =>
      writeFile(join(fixture.repo, "observable.txt"), "changed\n");
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    await expect(
      controller.launch({
        lane: "sdk-local",
        name: "Observable effect",
        prompt: "Review the repository.",
        model: CURSOR_OPUS_5_MAX_MODEL,
        mode: "plan",
        cwd: fixture.repo,
      }),
    ).rejects.toMatchObject({
      retryable: false,
      code: "traffic_model_fallback_blocked_after_effect",
      observableEffects: ["worktree_mutation"],
    } satisfies Partial<TrafficModelFallbackBlockedError>);
    expect(sdk.sendOptions).toHaveLength(1);
    await controller.close();
  });

  it("never falls back from a returned run that later fails", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Returned failure",
      prompt: "Review the repository.",
      model: CURSOR_OPUS_5_MAX_MODEL,
      mode: "plan",
      cwd: fixture.repo,
    });
    sdk.latestRun(launched.agent.externalId)!.finish("error");
    await waitFor(() =>
      expect(registry.requireRun(launched.run.id).status).toBe("error"),
    );
    expect(sdk.sendOptions).toHaveLength(1);
    await controller.close();
  });

  it("enforces one private controller lease and verifies its audit chain", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const first = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk: new FakeSdk(),
      instanceId: "controller-one",
    });
    const second = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk: new FakeSdk(),
      instanceId: "controller-two",
    });

    expect(first.startControl()).toMatchObject({
      active: true,
      ownerInstanceId: "controller-one",
      generation: 1,
    });
    expect(() => second.startControl()).toThrow(/another agent-traffic controller/i);
    expect(first.stopControl()).toMatchObject({ active: false });
    expect(second.startControl()).toMatchObject({
      active: true,
      ownerInstanceId: "controller-two",
      generation: 1,
    });
    expect(registry.auditEvents().map((event) => event.event)).toEqual([
      "started",
      "stopped",
      "started",
    ]);

    await first.close();
    await second.close();
  });

  it("keeps manual IDE chats mailbox-only and redacts secrets", async () => {
    const fixture = await repository();
    const path = join(fixture.root, "shared-traffic.db");
    const controlRegistry = new TrafficControlRegistry({
      origin: "cursor",
      path,
    });
    const participantRegistry = new TrafficControlRegistry({
      origin: "cursor",
      path,
    });
    registries.push(controlRegistry, participantRegistry);
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry: controlRegistry,
      sdk: new FakeSdk(),
      instanceId: "controller-window",
    });
    const participantWindow = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry: participantRegistry,
      sdk: new FakeSdk(),
      instanceId: "mailbox-window",
    });
    controller.startControl();
    const participant = await participantWindow.registerParticipant({
      displayName: "Manual Cursor Chat",
      cwd: fixture.repo,
    });

    expect(participant).toMatchObject({
      trust: "mailbox-unverified",
      status: "registered",
    });
    const sent = controller.sendMessage({
      toParticipantId: participant.id,
      kind: "request",
      body: "Review this; api_key=sk-abcdefghijklmnop",
    });
    expect(sent.body).not.toContain("sk-abcdefghijklmnop");
    const inbox = participantWindow.inbox(participant.id, 0, 10);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      id: sent.id,
      status: "pending",
      kind: "request",
    });
    expect(
      participantWindow.acknowledgeMessage(participant.id, sent.id),
    ).toMatchObject({ status: "acknowledged" });
    expect(() =>
      participantWindow.sendMessage({
        toParticipantId: participant.id,
        kind: "notice",
        body: "forged controller message",
      }),
    ).toThrow(/start traffic control/i);

    await controller.close();
    await participantWindow.close();
  });

  it("launches SDK-local agents only in sandboxed mesh worktrees", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      instanceId: "sdk-controller",
    });
    controller.startControl();

    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Local SDK",
      prompt: "Inspect the worktree.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    expect(launched.agent).toMatchObject({
      lane: "sdk-local",
      status: "running",
      meshOwned: true,
    });
    expect(sdk.createOptions[0]).toMatchObject({
      mcpServers: {},
      local: {
        cwd: launched.agent.cwd,
        settingSources: [],
        sandboxOptions: { enabled: true },
        autoReview: true,
        enableAgentRetries: false,
      },
    });

    const location = await resolveTrafficLocation(fixture.repo);
    expect(() => claimSdkWriter(registry, location)).toThrow(
      /another managed writer/i,
    );

    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await waitFor(() =>
      expect(registry.requireRun(launched.run.id).status).toBe("finished"),
    );
    claimSdkWriter(registry, location);

    const snapshot = JSON.stringify(controller.dashboardSnapshot());
    expect(snapshot).not.toContain(fixture.repo);
    expect(snapshot).not.toContain("prompt");
    await controller.close();
  });

  it("binds closure-authenticated peer tools to SDK-local create and resume", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const peers = new PeerChannelRegistry({
      origin: "cursor",
      path: join(fixture.root, "peer.db"),
      agentResolver: (agentId) => registry.getAgent(agentId),
    });
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      peerRegistry: peers,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Peer SDK",
      prompt: "Inspect peer channels.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    const createTools = sdk.createOptions[0]?.local?.customTools;
    expect(Object.keys(createTools ?? {})).toEqual(
      expect.arrayContaining([
        "peer_channels_list",
        "peer_context_get",
        "peer_send",
        "peer_ack",
      ]),
    );
    expect(peers.listChannels(launched.agent.id)).toHaveLength(1);
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await waitFor(() =>
      expect(registry.activeRun(launched.agent.id)).toBeUndefined(),
    );
    expect(() =>
      createTools!.peer_channels_list!.execute({}, {}),
    ).toThrow(/stale|binding/i);
    const followUp = await controller.send({
      agentId: launched.agent.id,
      prompt: "Check peers again.",
      description: "peer SDK resume",
      sdkMode: "plan",
    });
    expect(followUp.lane).toBe("sdk-local");
    expect(
      Object.keys(sdk.resumeOptions.at(-1)?.local?.customTools ?? {}),
    ).toContain("peer_context_get");
    expect(
      sdk.resumeOptions.at(-1)?.local?.enableAgentRetries,
    ).toBe(false);
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await controller.close();
    peers.close();
  });

  it("refuses SDK-local adoption from a primary checkout", async () => {
    const fixture = await repository(false);
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const existing = await sdk.create({
      model: { id: "fake-model" },
      local: { cwd: fixture.repo },
    });
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();

    await expect(
      controller.adopt({
        lane: "sdk-local",
        externalId: existing.agentId,
        model: { id: "fake-model" },
        cwd: fixture.repo,
      }),
    ).rejects.toThrow(/mesh-owned worktrees/i);
    await controller.close();
  });

  it("does not claim cancellation when a detached SDK run cannot cancel", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    sdk.cancellable = false;
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Uncancellable",
      prompt: "Wait.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });

    await expect(
      controller.cancel({ agentId: launched.agent.id }),
    ).rejects.toThrow(/fake detached run cannot cancel/i);
    expect(registry.requireRun(launched.run.id)).toMatchObject({
      status: "running",
      cancelUnsupportedReason: "fake detached run cannot cancel",
    });
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await controller.close();
  });

  it("composes the router gate with existing worktree task leases", async () => {
    const fixture = await repository();
    const traffic = trafficRegistry(fixture.root);
    const location = await resolveTrafficLocation(fixture.repo);
    const blocked = claimSdkWriter(traffic, location);
    const mesh = router(
      fixture.root,
      [new InstantCodexAdapter()],
      traffic,
    );
    const input = {
      provider: "codex" as const,
      prompt: "Implement safely.",
      description: "traffic-gated implementation",
      cwd: fixture.repo,
      mode: "implement" as const,
      mcpProfile: "none" as const,
      isolation: "none" as const,
      workspace: "worktree" as const,
      timeoutMs: 30_000,
    };
    const options = {
      background: false,
      existingWorktree: {
        repoRoot: fixture.repo,
        worktreePath: fixture.repo,
        baseCommit: fixture.head,
      },
    };

    await expect(mesh.start(input, options)).rejects.toThrow(
      /another managed writer/i,
    );
    expect(mesh.registry.search({ origin: "cursor", limit: 10 })[0]).toMatchObject({
      status: "failed",
    });

    traffic.releaseWriter("sdk-agent", blocked.runId);
    const completed = await mesh.start(input, options);
    expect(completed.task.status).toBe("completed");
    claimSdkWriter(traffic, location);
  });

  it("records concurrent live writers without weakening exclusive worktree leases", async () => {
    const fixture = await repository(false);
    const traffic = trafficRegistry(fixture.root);
    const location = await resolveTrafficLocation(fixture.repo);
    const first = meshTask(fixture);
    const second = meshTask(fixture);

    await Promise.all([
      traffic.reserve(first, { workspace: "live" }),
      traffic.reserve(second, { workspace: "live" }),
    ]);
    expect(
      traffic
        .listLiveWriters(location.worktreeKey)
        .map((writer) => writer.ownerId)
        .sort(),
    ).toEqual([first.id, second.id].sort());

    const isolated = {
      ...meshTask(fixture),
      worktreePath: fixture.repo,
    };
    await traffic.reserve(isolated, { workspace: "worktree" });
    await expect(
      traffic.reserve(
        {
          ...meshTask(fixture),
          worktreePath: fixture.repo,
        },
        { workspace: "worktree" },
      ),
    ).rejects.toThrow(/another managed writer/i);
  });

  it("refuses to launch SDK agents unless Cursor usage is opted in", async () => {
    delete process.env.AGENT_MESH_ALLOW_CURSOR_SDK;
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const controller = new TrafficController({
      origin: "cursor",
      registry,
      sdk: new FakeSdk(),
    });
    controller.startControl();
    await expect(
      controller.launch({
        lane: "sdk-local",
        name: "Local SDK",
        prompt: "inspect",
        cwd: fixture.repo,
        idempotencyKey: "cursor-usage-guard",
      }),
    ).rejects.toThrow(/bill Cursor usage|AGENT_MESH_ALLOW_CURSOR_SDK/i);
  });

  it("allows implement dispatch while a direction target is only pending", async () => {
    // A newly enrolled agent inherits every active direction as pending and cannot
    // acknowledge before it launches, so pending must never be a hard gate.
    const target = await directionTarget();
    expect(target.peers.pendingDirections(target.agent.id)).toHaveLength(1);
    expect(() =>
      assertImplementationDirectionsAcknowledged({
        operation: "Implementation dispatch",
        mode: "implement",
        repoKey: target.location.repoKey,
        agentIds: [target.agent.id],
        registry: target.peers,
      }),
    ).not.toThrow();
    target.peers.close();
  });

  it("keeps a conflict blocking after the target acknowledges it", async () => {
    const target = await directionTarget();
    target.peers.acknowledgeDirection({
      binding: target.binding,
      directionId: target.direction.direction.id,
      revision: target.direction.revision.revision,
      impact: "conflict-needs-clarity",
      note: "The direction conflicts with the accepted plan.",
    });
    expect(target.peers.pendingDirections(target.agent.id)).toHaveLength(1);
    expect(() =>
      assertImplementationDirectionsAcknowledged({
        operation: "Implementation dispatch",
        mode: "implement",
        repoKey: target.location.repoKey,
        agentIds: [target.agent.id],
        registry: target.peers,
      }),
    ).toThrow(/unresolved human direction conflicts/i);
    target.peers.close();
  });

  it("never applies the direction writer gate to read-only modes", async () => {
    const target = await directionTarget();
    for (const mode of ["ask", "plan", "review", "research"] as const) {
      expect(() =>
        assertImplementationDirectionsAcknowledged({
          operation: "Implementation dispatch",
          mode,
          repoKey: target.location.repoKey,
          agentIds: [target.agent.id],
          registry: target.peers,
        }),
      ).not.toThrow();
    }
    expect(target.peers.pendingDirections(target.agent.id)).toHaveLength(1);
    target.peers.close();
  });

  it("waits for durable mesh task settlement before writer takeover", async () => {
    const fixture = await repository();
    const traffic = trafficRegistry(fixture.root);
    const location = await resolveTrafficLocation(fixture.repo);
    let status: "running" | "interrupted" = "running";
    traffic.setTaskStatusResolver(() => status);
    const meshTaskId = randomUUID();
    traffic.claimWriter({
      worktreeKey: location.worktreeKey,
      ownerKind: "mesh-task",
      ownerId: meshTaskId,
      ownerPid: 999_999_999,
    });

    expect(() => claimSdkWriter(traffic, location)).toThrow(
      /another managed writer/i,
    );
    status = "interrupted";
    claimSdkWriter(traffic, location);
  });

  it("reserves the run before concurrent SDK sends can start", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Serialized SDK",
      prompt: "Initial turn.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await waitFor(() =>
      expect(registry.requireRun(launched.run.id).status).toBe("finished"),
    );

    const attempts = await Promise.allSettled([
      controller.send({
        agentId: launched.agent.id,
        prompt: "First concurrent follow-up.",
        description: "first concurrent send",
        sdkMode: "plan",
      }),
      controller.send({
        agentId: launched.agent.id,
        prompt: "Second concurrent follow-up.",
        description: "second concurrent send",
        sdkMode: "plan",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(sdk.sendCount).toBe(2);
    expect(registry.listRuns(launched.agent.id).filter((run) => run.status === "running"))
      .toHaveLength(1);

    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await controller.close();
  });

  it("settles a pending run when writer acquisition fails", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const first = await controller.launch({
      lane: "sdk-local",
      name: "First writer",
      prompt: "Hold the writer lease.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    const secondHandle = await sdk.create({
      model: { id: "fake-model" },
      local: { cwd: fixture.repo },
    });
    const second = await controller.adopt({
      lane: "sdk-local",
      externalId: secondHandle.agentId,
      model: { id: "fake-model" },
      cwd: fixture.repo,
    });

    await expect(
      controller.send({
        agentId: second.id,
        prompt: "Compete for the writer lease.",
        description: "conflicting writer",
        sdkMode: "plan",
      }),
    ).rejects.toThrow(/another managed writer/i);
    expect(registry.activeRun(second.id)).toBeUndefined();
    expect(registry.listRuns(second.id)).toHaveLength(1);
    expect(registry.listRuns(second.id)[0]!.status).toBe("error");

    sdk.latestRun(first.agent.externalId)!.finish("finished");
    await controller.close();
  });

  it("never replaces an owned live run with a detached list handle", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Owned run",
      prompt: "Remain active.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    const liveRun = sdk.latestRun(launched.agent.externalId)!;
    sdk.detachListedRuns = true;

    await controller.runs(launched.agent.id);
    await controller.cancel({ agentId: launched.agent.id });
    expect(liveRun.status).toBe("cancelled");
    await controller.close();
  });

  it("blocks worktree cleanup while an SDK run owns the traffic lease", async () => {
    const fixture = await repository();
    const traffic = trafficRegistry(fixture.root);
    const mesh = router(
      fixture.root,
      [new InstantCodexAdapter()],
      traffic,
    );
    const completed = await mesh.start(
      {
        provider: "codex",
        prompt: "Complete without changes.",
        description: "cleanup candidate",
        cwd: fixture.repo,
        mode: "implement",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 30_000,
      },
      {
        background: false,
        existingWorktree: {
          repoRoot: fixture.repo,
          worktreePath: fixture.repo,
          baseCommit: fixture.head,
        },
      },
    );
    expect(completed.task.artifactStatus).toBe("clean");

    const sdk = new FakeSdk();
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry: traffic,
      sdk,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-local",
      name: "Cleanup blocker",
      prompt: "Keep this worktree active.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });

    await expect(mesh.cleanup(completed.task.id)).rejects.toThrow(
      /another managed writer/i,
    );
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await controller.close();
  });

  it("inherits writable mesh-session mode instead of bypassing the writer gate", async () => {
    const fixture = await repository();
    const traffic = trafficRegistry(fixture.root);
    const mesh = router(
      fixture.root,
      [new InstantCodexAdapter()],
      traffic,
    );
    const initial = await mesh.start(
      {
        provider: "codex",
        prompt: "Initial implementation.",
        description: "initial implementation session",
        cwd: fixture.repo,
        mode: "implement",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 30_000,
      },
      {
        background: false,
        existingWorktree: {
          repoRoot: fixture.repo,
          worktreePath: fixture.repo,
          baseCommit: fixture.head,
        },
      },
    );
    const controller = new TrafficController({
      origin: "cursor",
      router: mesh,
      registry: traffic,
      sdk: new FakeSdk(),
    });
    controller.startControl();
    const inventory = await controller.listAgents({ refresh: false });
    const agent = inventory.agents.find(
      (candidate) =>
        candidate.lane === "mesh-cli" &&
        candidate.sessionId === initial.result?.sessionId,
    );
    expect(agent).toBeTruthy();

    const continued = await controller.send({
      agentId: agent!.id,
      prompt: "Continue the implementation.",
      description: "continued implementation session",
    });
    expect(continued.lane).toBe("mesh-cli");
    if (continued.lane === "mesh-cli") {
      expect(continued.meshTask.mode).toBe("implement");
    }
    await mesh.getResult(
      continued.lane === "mesh-cli" ? continued.meshTask.id : "",
      true,
      30_000,
    );
    await controller.close();
  });

  it("reuses stable mesh session identity across public continuations", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const location = await resolveTrafficLocation(fixture.repo);
    const firstTaskId = randomUUID();
    const first = registry.upsertAgent({
      lane: "mesh-cli",
      externalId: `codex:task-${firstTaskId}`,
      provider: "codex",
      meshTaskId: firstTaskId,
      name: "first turn",
      status: "running",
      model: "fake-model",
      modelSelection: { id: "fake-model" },
      location,
      adopted: false,
      peerReadOnly: true,
    });
    registry.bindMeshSession({
      agentId: first.id,
      taskId: firstTaskId,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    const stable = registry.findAgentByExternal(
      "mesh-cli",
      "codex:session-11111111-1111-4111-8111-111111111111",
    )!;
    const nextTaskId = randomUUID();
    const continued = registry.upsertAgent({
      id: stable.id,
      lane: "mesh-cli",
      externalId: stable.externalId,
      provider: "codex",
      sessionId: stable.sessionId,
      meshTaskId: nextTaskId,
      name: "continued turn",
      status: "launching",
      model: stable.model,
      modelSelection: stable.modelSelection,
      location,
      adopted: false,
      peerReadOnly: true,
    });
    expect(continued.id).toBe(stable.id);
    expect(continued.meshTaskId).toBe(nextTaskId);
    expect(
      registry
        .listAgents()
        .filter((agent) => agent.lane === "mesh-cli"),
    ).toHaveLength(1);
  });

  it("fences controller shutdown while an SDK create is in flight", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    let releaseCreate!: () => void;
    sdk.createBarrier = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launching = controller.launch({
      lane: "sdk-local",
      name: "Fenced launch",
      prompt: "Start after the barrier.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    await waitFor(() => expect(sdk.createOptions).toHaveLength(1));
    expect(() => controller.stopControl()).toThrow(/operations are in progress/i);

    releaseCreate();
    const launched = await launching;
    expect(launched.run.status).toBe("running");
    expect(controller.stopControl()).toMatchObject({ active: false });
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await controller.close();
  });

  it("drains close-time SDK creation and disposes the late handle", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    let releaseCreate!: () => void;
    sdk.createBarrier = new Promise((resolve) => {
      releaseCreate = resolve;
    });
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launching = controller.launch({
      lane: "sdk-local",
      name: "Late handle",
      prompt: "Create while closing.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    await waitFor(() => expect(sdk.createOptions).toHaveLength(1));
    const closing = controller.close();
    releaseCreate();

    await expect(launching).rejects.toThrow(/shutting down/i);
    await closing;
    expect([...sdk.agents.values()]).toHaveLength(1);
    expect([...sdk.agents.values()][0]!.closed).toBe(true);
  });

  it("rejects stale-controller completion after lease generation takeover", async () => {
    const fixture = await repository();
    let now = new Date("2026-07-23T20:00:00.000Z");
    const registry = new TrafficControlRegistry({
      origin: "cursor",
      path: join(fixture.root, "generation-traffic.db"),
      now: () => new Date(now),
      controllerTtlMs: 1_000,
    });
    registries.push(registry);
    const sdk = new FakeSdk();
    const firstController = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      instanceId: "generation-one",
    });
    const secondController = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      instanceId: "generation-two",
    });
    firstController.startControl();
    const launched = await firstController.launch({
      lane: "sdk-local",
      name: "Generation agent",
      prompt: "Initial.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await waitFor(() =>
      expect(registry.activeRun(launched.agent.id)).toBeUndefined(),
    );
    let releaseSend!: () => void;
    sdk.sendBarrier = new Promise((resolve) => {
      releaseSend = resolve;
    });
    const staleSend = firstController.send({
      agentId: launched.agent.id,
      prompt: "Stale generation turn.",
      description: "generation fencing",
      sdkMode: "plan",
      idempotencyKey: "generation-fenced-send",
    });
    await waitFor(() =>
      expect(registry.activeRun(launched.agent.id)).toBeTruthy(),
    );

    now = new Date(now.getTime() + 2_000);
    expect(secondController.startControl()).toMatchObject({
      active: true,
      ownerInstanceId: "generation-two",
      generation: 2,
    });
    releaseSend();
    await expect(staleSend).rejects.toThrow(
      /ambiguous external side effect/i,
    );
    await waitFor(() =>
      expect(registry.activeRun(launched.agent.id)).toBeUndefined(),
    );
    await firstController.close();
    await secondController.close();
  });

  it("refuses adoption of an active SDK-local executor", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const selection = {
      id: "fake-model",
      params: [{ id: "effort", value: "high" }],
    };
    const existing = await sdk.create({
      model: selection,
      local: { cwd: fixture.repo },
    });
    const externalRun = sdk.newRun(existing.agentId);
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    await expect(
      controller.adopt({
        lane: "sdk-local",
        externalId: existing.agentId,
        model: selection,
        cwd: fixture.repo,
      }),
    ).rejects.toThrow(/active SDK-local agents cannot be adopted/i);
    externalRun.finish("finished");
    await controller.close();
  });

  it("human-recovers a stale owned local run and preserves model variants", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const selection = {
      id: "fake-model",
      params: [{ id: "effort", value: "high" }],
    };
    const firstController = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      instanceId: "stale-owner",
    });
    firstController.startControl();
    const launched = await firstController.launch({
      lane: "sdk-local",
      name: "Recoverable local",
      prompt: "Become stale after controller exit.",
      model: selection,
      mode: "plan",
      cwd: fixture.repo,
    });
    await firstController.close();
    expect(registry.activeRun(launched.agent.id)).toBeTruthy();

    const recoveryController = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      instanceId: "recovery-owner",
    });
    recoveryController.startControl();
    expect(
      await recoveryController.recoverStaleLocalRun(launched.agent.id),
    ).toMatchObject({
      status: "error",
      forceExpired: true,
    });
    const location = await resolveTrafficLocation(fixture.repo);
    const blocker = claimSdkWriter(registry, location);
    await expect(
      recoveryController.send({
        agentId: launched.agent.id,
        prompt: "Fail before the forced send.",
        description: "preserve local force intent",
        sdkMode: "plan",
      }),
    ).rejects.toThrow(/another managed writer/i);
    expect(
      registry.requireAgent(launched.agent.id).forceLocalNextSend,
    ).toBe(true);
    registry.releaseWriter("sdk-agent", blocker.runId);
    registry.settleRun(blocker.runId, "cancelled");
    const followUp = await recoveryController.send({
      agentId: launched.agent.id,
      prompt: "Resume after stale-run recovery.",
      description: "stale local recovery",
      sdkMode: "plan",
    });
    expect(followUp.lane).toBe("sdk-local");
    expect(sdk.resumeOptions.at(-1)?.model).toEqual(selection);
    expect(sdk.sendOptions.at(-1)?.local).toEqual({ force: true });
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await recoveryController.close();
  });

  it("leaves detached cloud runs active during controller shutdown", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
    });
    controller.startControl();
    const launched = await controller.launch({
      lane: "sdk-cloud",
      name: "Cloud detachment",
      prompt: "Continue remotely.",
      model: { id: "fake-model" },
      mode: "agent",
      repositories: [{ url: "https://github.com/example/repository" }],
    });

    await controller.close();
    expect(registry.requireRun(launched.run.id).status).toBe("running");
  });

  it("gates initiative worktree discard through task and traffic cleanup leases", async () => {
    const fixture = await repository(false);
    const traffic = trafficRegistry(fixture.root);
    const tasks = new TaskRegistry(join(fixture.root, "initiative-tasks.db"));
    const initiatives = new InitiativeRegistry(
      "cursor",
      join(fixture.root, "initiatives.db"),
      tasks,
      traffic,
    );
    const initiative = await initiatives.create({
      name: "Traffic cleanup",
      objective: "Verify cleanup gating.",
      cwd: fixture.repo,
      preset: "max_plan",
      strategy: "shared_readonly",
    });
    const location = await resolveTrafficLocation(initiative.effectiveCwd);
    claimSdkWriter(traffic, location);

    await expect(
      initiatives.discardCleanInitiative(initiative.id),
    ).rejects.toThrow(/another managed writer/i);
    expect(initiatives.get(initiative.id).status).toBe("active");
    initiatives.close();
    tasks.close();
  });

  it("keeps ambiguous idempotency side effects until human reconciliation", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const owner = {
      instanceId: "idempotency-owner",
      pid: process.pid,
      leaseGeneration: 1,
    };
    expect(
      registry.reserveIdempotency("send", "retry-key", { value: 1 }, owner),
    ).toEqual({ reserved: true });
    registry.markIdempotencySideEffect(
      "send",
      "retry-key",
      {
        instanceId: owner.instanceId,
        leaseGeneration: owner.leaseGeneration,
      },
      randomUUID(),
    );
    registry.releaseIdempotency("send", "retry-key", {
      instanceId: owner.instanceId,
      leaseGeneration: owner.leaseGeneration,
    });
    expect(() =>
      registry.reserveIdempotency("send", "retry-key", { value: 1 }, owner),
    ).toThrow(/ambiguous side effect/i);

    registry.reconcileIdempotency({
      operation: "send",
      key: "retry-key",
      action: "release",
    });
    expect(
      registry.reserveIdempotency("send", "retry-key", { value: 1 }, owner),
    ).toEqual({ reserved: true });
  });

  it("abandons a crash-time pending run after its controller is inactive", async () => {
    process.env.AGENT_MESH_TRAFFIC_PENDING_GRACE_MS = "0";
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const sdk = new FakeSdk();
    const firstController = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      instanceId: "pending-owner",
    });
    const firstLease = firstController.startControl();
    const launched = await firstController.launch({
      lane: "sdk-local",
      name: "Pending recovery",
      prompt: "Create an agent before crash simulation.",
      model: { id: "fake-model" },
      mode: "plan",
      cwd: fixture.repo,
    });
    sdk.latestRun(launched.agent.externalId)!.finish("finished");
    await waitFor(() =>
      expect(registry.activeRun(launched.agent.id)).toBeUndefined(),
    );
    await firstController.close();
    const pending = registry.reserveRun(launched.agent.id, {
      instanceId: "pending-owner",
      pid: process.pid,
      controllerGeneration: firstLease.generation,
    });
    expect(pending.phase).toBe("reserved");
    const location = await resolveTrafficLocation(fixture.repo);
    registry.claimWriter({
      worktreeKey: location.worktreeKey,
      ownerKind: "sdk-agent",
      ownerId: pending.id,
      ownerPid: process.pid,
    });
    let releaseInventory!: () => void;
    sdk.listRunsBarrier = new Promise((resolve) => {
      releaseInventory = resolve;
    });

    const recoveryController = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk,
      instanceId: "pending-recovery",
    });
    recoveryController.startControl();
    expect(() => claimSdkWriter(registry, location)).toThrow(
      /another managed writer/i,
    );
    releaseInventory();
    await waitFor(() =>
      expect(registry.requireRun(pending.id).noMatchSince).toBeTruthy(),
    );
    await recoveryController.runs(launched.agent.id);
    expect(registry.activeRun(launched.agent.id)).toBeUndefined();
    expect(registry.requireRun(pending.id)).toMatchObject({
      status: "error",
      phase: "reserved",
    });
    await recoveryController.close();
  });

  it("refuses human idempotency release while the recorded owner is active", async () => {
    const fixture = await repository();
    const registry = trafficRegistry(fixture.root);
    const controller = new TrafficController({
      origin: "cursor",
      router: router(fixture.root),
      registry,
      sdk: new FakeSdk(),
      instanceId: "active-idempotency-owner",
    });
    const lease = controller.startControl();
    const owner = {
      instanceId: "active-idempotency-owner",
      pid: process.pid,
      leaseGeneration: lease.generation,
    };
    registry.reserveIdempotency("send", "active-key", { value: 1 }, owner);
    registry.markIdempotencySideEffect(
      "send",
      "active-key",
      {
        instanceId: owner.instanceId,
        leaseGeneration: owner.leaseGeneration,
      },
      randomUUID(),
    );

    expect(() =>
      registry.reconcileIdempotency({
        operation: "send",
        key: "active-key",
        action: "release",
      }),
    ).toThrow(/owning controller is active/i);
    await controller.close();
  });

  it("parses only sanitized Cursor process presence", () => {
    const parsed = parseTrafficPresence(
      [
        " 123 Thu Jul 23 19:00:00 2026 /Applications/Cursor.app/Contents/MacOS/Cursor",
        " 124 Thu Jul 23 19:00:01 2026 /Users/test/.local/bin/cursor-agent --api-key secret",
        " 125 Thu Jul 23 19:00:02 2026 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper",
        " 126 Thu Jul 23 19:00:03 2026 /bin/zsh",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      {
        pid: 123,
        startedAt: "Thu Jul 23 19:00:00 2026",
        process: "cursor-ide",
        verified: false,
        controllable: false,
      },
      {
        pid: 124,
        startedAt: "Thu Jul 23 19:00:01 2026",
        process: "cursor-agent",
        verified: false,
        controllable: false,
      },
      {
        pid: 125,
        startedAt: "Thu Jul 23 19:00:02 2026",
        process: "cursor-helper",
        verified: false,
        controllable: false,
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("api-key");
    expect(JSON.stringify(parsed)).not.toContain("/Applications");
  });
});

// MESH[2026-07-25T19:32Z][agent:codex][direction:user/1]
// What: covered supervision cursoring, watch behavior, scoping, redaction, and conditions.
// Why: the observation surface must be resumable, metadata-only, and conservative about remedies.
// Aligns-with: direction user revision 1 (supervision acceptance and threshold coverage).
// Status: complete
describe.sequential("mesh supervision", () => {
  async function fixture() {
    const repositoryFixture = await repository(false);
    const traffic = trafficRegistry(repositoryFixture.root, "supervision-traffic.db");
    const taskRouter = router(repositoryFixture.root);
    const task = {
      ...meshTask(repositoryFixture),
      status: "running" as const,
      model: "requested-model",
      actualModel: "actual-model",
      fallbackCount: 1,
      fallbackReason: "capacity",
    };
    taskRouter.registry.insert(task);
    const location = await resolveTrafficLocation(repositoryFixture.repo);
    const agent = traffic.upsertAgent({
      lane: "mesh-cli",
      externalId: `codex:supervision-${randomUUID()}`,
      provider: "codex",
      meshTaskId: task.id,
      name: "Supervised agent",
      status: "running",
      model: task.actualModel,
      modelSelection: { id: task.actualModel },
      location,
      adopted: false,
    });
    const peers = new PeerChannelRegistry({
      origin: "cursor",
      path: join(repositoryFixture.root, "supervision-peer.db"),
      agentResolver: (agentId) => traffic.getAgent(agentId),
    });
    peerRegistries.push(peers);
    const member = peers.ensureAgentEnrollment({
      agentId: agent.id,
      taskId: task.id,
      ownership: ["src/supervision.ts"],
    });
    const supervisor = new MeshSupervisor({
      origin: "cursor",
      peerRegistry: peers,
      trafficRegistry: traffic,
      taskRegistry: taskRouter.registry,
    });
    return {
      repositoryFixture,
      traffic,
      taskRouter,
      task,
      location,
      agent,
      peers,
      member,
      supervisor,
      binding: {
        origin: "cursor" as const,
        agentId: agent.id,
        memberId: member.id,
        membershipGeneration: member.generation,
        taskId: task.id,
      },
    };
  }

  function allEventIds(
    result: ReturnType<MeshSupervisor["poll"]>,
  ): string[] {
    return Object.values(result.delta).flatMap((events) =>
      events.map((event) => event.eventId),
    );
  }

  it("resumes each metadata event exactly once and omits bodies", async () => {
    const setup = await fixture();
    const channel = setup.peers
      .listChannels(setup.agent.id)
      .find((candidate) => candidate.kind === "repository")!;
    setup.peers.defineResource({
      channelId: channel.id,
      name: "supervision-writer",
      maximumTtlMs: 60_000,
      description: "Synthetic writer lease.",
    });
    const lease = setup.peers.acquireResource({
      binding: setup.binding,
      name: "supervision-writer",
      ttlMs: 60_000,
    });
    const direction = setup.peers.publishDirection({
      expectedRevision: 0,
      repoKey: setup.location.repoKey,
      title: "direction-title-sentinel",
      body: "direction-body-sentinel Bearer direction-secret",
      summary: "direction-summary-sentinel",
      provenance: "hook_prompt",
      disposition: "active",
      idempotencyKey: randomUUID(),
    });
    const question = setup.taskRouter.registry.createQuestion({
      taskId: setup.task.id,
      origin: "cursor",
      provider: "codex",
      sessionId: null,
      question: "question-body-sentinel",
      context: "question-context-sentinel",
      options: ["question-option-sentinel"],
    });
    setup.peers.recordFriction({
      repoKey: setup.location.repoKey,
      kind: "retry",
      severity: "medium",
      detail:
        `Observed ${setup.repositoryFixture.repo}/private.ts. ` +
        "Authorization: Bearer friction-secret",
      dedupeKey: "supervision-redaction",
      agentId: setup.agent.id,
    });

    const first = setup.supervisor.poll();
    expect(first.summary.materialEventCount).toBeGreaterThan(0);
    expect(first.delta.directions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "revision_published",
          directionId: direction.direction.id,
          pendingTargetIds: [setup.agent.id],
        }),
      ]),
    );
    expect(first.delta.progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task_transition",
          requestedModel: "requested-model",
          actualModel: "actual-model",
        }),
      ]),
    );
    expect(first.delta.questions).toEqual([
      expect.objectContaining({
        kind: "pending",
        questionId: question.id,
      }),
    ]);
    expect(first.delta.leases).toEqual([
      expect.objectContaining({
        kind: "acquired",
        leaseId: lease.id,
      }),
    ]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("direction-title-sentinel");
    expect(serialized).not.toContain("direction-body-sentinel");
    expect(serialized).not.toContain("direction-summary-sentinel");
    expect(serialized).not.toContain("question-body-sentinel");
    expect(serialized).not.toContain("question-context-sentinel");
    expect(serialized).not.toContain("question-option-sentinel");
    expect(serialized).not.toContain("Authorization: Bearer");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(setup.repositoryFixture.repo);

    const empty = setup.supervisor.poll({ afterCursor: first.nextCursor });
    expect(empty.summary.materialEventCount).toBe(0);
    expect(allEventIds(empty)).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 2));
    setup.peers.acquireResource({
      binding: setup.binding,
      name: "supervision-writer",
      ttlMs: 60_000,
    });
    setup.peers.acknowledgeDirection({
      binding: setup.binding,
      directionId: direction.direction.id,
      revision: direction.revision.revision,
      impact: "applies",
    });
    setup.traffic.updateAgent({
      id: setup.agent.id,
      status: "finished",
    });
    setup.taskRouter.registry.update(setup.task.id, {
      status: "completed",
      actualModel: "actual-model",
      completedAt: new Date().toISOString(),
    });
    setup.taskRouter.registry.answerQuestion(
      question.id,
      "cursor",
      "answer-body-sentinel",
    );
    const resumed = setup.supervisor.poll({ afterCursor: first.nextCursor });
    expect(resumed.delta.directions).toEqual([
      expect.objectContaining({
        kind: "acknowledged",
        impact: "applies",
      }),
    ]);
    expect(resumed.delta.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status_transition",
          fromStatus: "running",
          toStatus: "finished",
        }),
      ]),
    );
    expect(resumed.delta.progress).toEqual([
      expect.objectContaining({
        fromStatus: "running",
        toStatus: "completed",
      }),
    ]);
    expect(resumed.delta.questions).toEqual([
      expect.objectContaining({
        kind: "answered",
        questionId: question.id,
      }),
    ]);
    expect(resumed.delta.leases).toEqual([
      expect.objectContaining({
        kind: "renewed",
        leaseId: lease.id,
      }),
    ]);
    expect(JSON.stringify(resumed)).not.toContain("answer-body-sentinel");
    expect(
      allEventIds(first).filter((id) => allEventIds(resumed).includes(id)),
    ).toEqual([]);

    const exhausted = setup.supervisor.poll({
      afterCursor: resumed.nextCursor,
    });
    expect(exhausted.summary.materialEventCount).toBe(0);
    expect(allEventIds(exhausted)).toEqual([]);
  });

  it("long-polls promptly for arrivals and preserves the cursor on timeout", async () => {
    const setup = await fixture();
    const baseline = setup.supervisor.poll();
    const startedAt = Date.now();
    const watching = setup.supervisor.watch({
      afterCursor: baseline.nextCursor,
      include: ["friction"],
      timeoutMs: 2_000,
    });
    setTimeout(() => {
      setup.peers.recordFriction({
        repoKey: setup.location.repoKey,
        kind: "retry",
        detail: "A bounded retry arrived.",
        dedupeKey: `watch-arrival-${randomUUID()}`,
      });
    }, 50);
    const arrived = await watching;
    expect(arrived.timedOut).not.toBe(true);
    expect(arrived.delta.friction).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(1_500);

    const timeoutStartedAt = Date.now();
    const timedOut = await setup.supervisor.watch({
      afterCursor: arrived.nextCursor,
      include: ["friction"],
      timeoutMs: 40,
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.summary.materialEventCount).toBe(0);
    expect(timedOut.nextCursor).toBe(arrived.nextCursor);
    expect(Date.now() - timeoutStartedAt).toBeLessThan(1_000);
  });

  it("isolates origins and applies the repository filter", async () => {
    const setup = await fixture();
    const baseline = setup.supervisor.poll();
    setup.peers.recordFriction({
      repoKey: setup.location.repoKey,
      kind: "retry",
      detail: "Included repository event.",
      dedupeKey: "included-repository",
    });
    setup.peers.recordFriction({
      repoKey: "another-repository",
      kind: "retry",
      detail: "Excluded repository event.",
      dedupeKey: "excluded-repository",
    });

    const foreignTraffic = new TrafficControlRegistry({
      origin: "claude",
      path: setup.traffic.path,
    });
    registries.push(foreignTraffic);
    foreignTraffic.upsertAgent({
      lane: "mesh-cli",
      externalId: `claude:foreign-${randomUUID()}`,
      provider: "claude",
      meshTaskId: randomUUID(),
      name: "Foreign origin agent",
      status: "running",
      model: null,
      modelSelection: null,
      location: setup.location,
      adopted: false,
    });
    const foreignPeers = new PeerChannelRegistry({
      origin: "claude",
      path: setup.peers.path,
      agentResolver: (agentId) => foreignTraffic.getAgent(agentId),
    });
    peerRegistries.push(foreignPeers);
    foreignPeers.recordFriction({
      repoKey: setup.location.repoKey,
      kind: "retry",
      detail: "Foreign origin event.",
      dedupeKey: "foreign-origin",
    });

    const filtered = setup.supervisor.poll({
      afterCursor: baseline.nextCursor,
      repo: setup.location.repoKey,
    });
    expect(filtered.delta.friction).toEqual([
      expect.objectContaining({
        repo: setup.location.repoKey,
        detail: "Included repository event.",
      }),
    ]);
    expect(JSON.stringify(filtered)).not.toContain("Excluded repository event");
    expect(JSON.stringify(filtered)).not.toContain("Foreign origin event");
    expect(JSON.stringify(filtered)).not.toContain("Foreign origin agent");
  });

  it("derives every condition at threshold and stays quiet below it", () => {
    const now = new Date("2026-07-25T20:00:00.000Z");
    const old = new Date(now.getTime() - 2_000).toISOString();
    const recent = new Date(now.getTime() - 500).toISOString();
    const directionId = randomUUID();
    const revisionId = randomUUID();
    const direction: PeerDirectionOutboxEntry = {
      direction: {
        id: directionId,
        origin: "cursor",
        repoKey: "repo-one",
        currentRevision: 1,
        disposition: "active",
        directionHash: "direction-hash",
        createdAt: old,
        updatedAt: old,
      },
      revision: {
        id: revisionId,
        directionId,
        revision: 1,
        sequence: 1,
        title: "Synthetic",
        body: "Synthetic",
        summary: "Synthetic",
        affectedPaths: [],
        provenance: "hook_prompt",
        conversationId: null,
        previousHash: null,
        revisionHash: "revision-hash",
        idempotencyKey: "synthetic",
        controllerInstanceId: null,
        controllerGeneration: null,
        createdAt: old,
      },
      targets: [
        {
          id: randomUUID(),
          directionId,
          revision: 1,
          agentId: "agent-a",
          memberId: "member-a",
          memberGeneration: 1,
          state: "pending",
          impact: null,
          note: null,
          observedGitHead: null,
          ackHash: null,
          createdAt: old,
          acknowledgedAt: null,
          updatedAt: old,
        },
        {
          id: randomUUID(),
          directionId,
          revision: 1,
          agentId: "agent-b",
          memberId: "member-b",
          memberGeneration: 1,
          state: "acknowledged",
          impact: "conflict-needs-clarity",
          note: null,
          observedGitHead: null,
          ackHash: "ack-hash",
          createdAt: old,
          acknowledgedAt: recent,
          updatedAt: recent,
        },
      ],
    };
    const friction = (
      id: string,
      kind: PeerFrictionEvent["kind"],
      provider: PeerFrictionEvent["provider"] = null,
    ): PeerFrictionEvent => ({
      id,
      origin: "cursor",
      repoKey: "repo-one",
      occurredAt: recent,
      kind,
      provider,
      model: null,
      agentId: "agent-a",
      reference: "target-one",
      skillTier: null,
      severity: "medium",
      detail: "Synthetic redacted detail.",
      dedupeKey: id,
      createdAt: recent,
    });
    const evidence: SupervisionConditionEvidence = {
      directions: [direction],
      agents: [
        {
          id: "agent-a",
          status: "running",
          repoKey: "repo-one",
          repoLabel: "repository",
          lastSeenAt: old,
          lastEventAt: old,
        },
        {
          id: "agent-b",
          status: "running",
          repoKey: "repo-one",
          repoLabel: "repository",
          lastSeenAt: recent,
          lastEventAt: recent,
        },
      ],
      members: [
        {
          id: "member-a",
          agentId: "agent-a",
          repoKey: "repo-one",
          status: "active",
          ownership: ["src/**"],
        },
        {
          id: "member-b",
          agentId: "agent-b",
          repoKey: "repo-one",
          status: "active",
          ownership: ["src/supervision.ts"],
        },
      ],
      friction: [
        friction("collision-one", "writer_collision"),
        friction("collision-two", "stale_write_mismatch"),
        friction("fallback-one", "model_fallback", "codex"),
        friction("fallback-two", "model_fallback", "codex"),
      ],
      leases: [
        {
          id: "lease-one",
          channelId: "channel-one",
          resourceName: "writer",
          holderMemberId: "member-a",
          generation: 1,
          status: "active",
          acquiredAt: old,
          updatedAt: recent,
          expiresAt: new Date(now.getTime() + 500).toISOString(),
        },
      ],
    };
    const thresholds = {
      unacknowledgedDirectionMs: 1_000,
      thrashingWindowMs: 10_000,
      thrashingOccurrences: 2,
      stalledAgentMs: 1_000,
      fallbackWindowMs: 10_000,
      fallbackOccurrences: 2,
      leaseExpiryRiskMs: 1_000,
    };
    const conditions = deriveSupervisionConditions(evidence, {
      now,
      thresholds,
    });
    expect(new Set(conditions.map((condition) => condition.kind))).toEqual(
      new Set([
        "unacknowledged_direction",
        "open_direction_conflict",
        "writer_contention",
        "thrashing",
        "stalled_agent",
        "fallback_pressure",
        "lease_expiry_risk",
      ]),
    );
    expect(
      conditions.find((condition) => condition.kind === "thrashing")?.evidence,
    ).toMatchObject({
      occurrences: 2,
      threshold: 2,
      windowMs: 10_000,
    });
    for (const condition of conditions) {
      expect(condition.remedy.description).toBeTruthy();
      expect(typeof condition.remedy.reversible).toBe("boolean");
      expect(typeof condition.remedy.safeToAutoApply).toBe("boolean");
      if (
        !condition.remedy.reversible ||
        condition.remedy.requiresHumanJudgment
      ) {
        expect(condition.remedy.safeToAutoApply).toBe(false);
      } else {
        expect(condition.remedy.safeToAutoApply).toBe(true);
      }
    }
    expect(
      conditions.find(
        (condition) => condition.kind === "open_direction_conflict",
      )?.remedy,
    ).toMatchObject({
      reversible: false,
      safeToAutoApply: false,
      requiresHumanJudgment: true,
    });

    const belowThreshold: SupervisionConditionEvidence = {
      directions: [
        {
          ...direction,
          targets: [
            {
              ...direction.targets[0]!,
              createdAt: recent,
              updatedAt: recent,
            },
          ],
        },
      ],
      agents: [
        {
          ...evidence.agents[0]!,
          lastSeenAt: recent,
          lastEventAt: recent,
        },
        evidence.agents[1]!,
      ],
      members: [
        evidence.members[0]!,
        {
          ...evidence.members[1]!,
          ownership: ["tests/**"],
        },
      ],
      friction: [
        friction("single-thrash", "stale_write_mismatch"),
        friction("single-fallback", "model_fallback", "codex"),
      ],
      leases: [
        {
          ...evidence.leases[0]!,
          expiresAt: new Date(now.getTime() + 1_001).toISOString(),
        },
      ],
    };
    const quiet = deriveSupervisionConditions(belowThreshold, {
      now,
      thresholds,
    });
    expect(quiet.map((condition) => condition.kind)).not.toContain(
      "unacknowledged_direction",
    );
    expect(quiet.map((condition) => condition.kind)).not.toContain(
      "writer_contention",
    );
    expect(quiet.map((condition) => condition.kind)).not.toContain("thrashing");
    expect(quiet.map((condition) => condition.kind)).not.toContain(
      "stalled_agent",
    );
    expect(quiet.map((condition) => condition.kind)).not.toContain(
      "fallback_pressure",
    );
    expect(quiet.map((condition) => condition.kind)).not.toContain(
      "lease_expiry_risk",
    );
  });
});
