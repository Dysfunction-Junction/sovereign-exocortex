import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WORKER_CAPABILITY_PROTOCOL,
  WorkerAuthenticationError,
  WorkerCompanionUnavailableError,
  WorkerConfirmationError,
  WorkerRegistry,
  createWorkerDispatchEnvelope,
  workerDisableConfirmation,
  workerRegistrationConfirmation,
  workerRemoveConfirmation,
  type RegisterWorkerInput,
  type WorkerCompanion,
  type WorkerHeartbeatInput,
} from "../src/workers.js";

const cleanupPaths: string[] = [];
const registries: WorkerRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) {
    try {
      registry.close();
    } catch {
      // A test may have closed it to verify durable reopen behavior.
    }
  }
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function registry(
  options: ConstructorParameters<typeof WorkerRegistry>[0] = {},
): Promise<{ registry: WorkerRegistry; root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "mesh-workers-"));
  cleanupPaths.push(root);
  const path = join(root, "workers.db");
  const value = new WorkerRegistry({
    ...(typeof options === "string" ? {} : options),
    path,
  });
  registries.push(value);
  return { registry: value, root, path };
}

function localRegistration(name = "Local Worker"): RegisterWorkerInput {
  return {
    name,
    transport: { kind: "local" },
    confirmation: workerRegistrationConfirmation(name),
  };
}

function heartbeat(
  workerId: string,
  token: string,
  overrides: Partial<WorkerHeartbeatInput> = {},
): WorkerHeartbeatInput {
  return {
    workerId,
    token,
    activeTasks: 1,
    capabilities: {
      protocol: WORKER_CAPABILITY_PROTOCOL,
      maxConcurrentTasks: 4,
      modes: ["ask", "review", "implement"],
      isolation: ["none", "worktree"],
    },
    providers: [
      {
        provider: "codex",
        installed: true,
        version: "0.144.1",
        models: ["gpt-5.6-sol"],
      },
      {
        provider: "claude",
        installed: false,
        version: null,
        models: [],
      },
      {
        provider: "grok",
        installed: true,
        version: "0.2.111",
        models: ["grok-4.5"],
      },
      {
        provider: "antigravity",
        installed: true,
        version: "1.1.5",
        models: ["gemini-3.1-pro-high"],
      },
    ],
    ...overrides,
  };
}

function dispatchEnvelope(workerId: string, dispatchId = "dispatch-1") {
  return createWorkerDispatchEnvelope(
    {
      workerId,
      task: {
        taskId: "task-1",
        origin: "cursor",
        provider: "codex",
        prompt: "Review only.",
        description: "bounded dispatch",
        cwd: "/tmp/project",
        mode: "review",
        model: null,
        effort: null,
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
        baseRef: null,
      },
    },
    { idFactory: () => dispatchId },
  );
}

describe("durable private worker registry", () => {
  it("requires exact registration confirmation and stores only a token digest", async () => {
    const { registry: workers, root, path } = await registry();

    expect(() =>
      workers.register({
        ...localRegistration(),
        confirmation: "REGISTER WORKER local worker",
      }),
    ).toThrow(WorkerConfirmationError);
    expect(workers.list()).toEqual([]);

    const registration = workers.register(localRegistration());
    expect(registration.token).toMatch(/^meshw_[A-Za-z0-9_-]+$/);
    expect(Object.keys(registration)).toEqual(["worker"]);
    expect(JSON.stringify(registration)).not.toContain(registration.token);
    expect(registration.worker).toMatchObject({
      name: "Local Worker",
      transport: { kind: "local" },
      status: "never_seen",
      capabilities: null,
      providers: [],
    });

    const persisted = (await readFile(path)).toString("latin1");
    expect(persisted).not.toContain(registration.token);
    expect(persisted).toContain("sha256:");
    expect(JSON.stringify(workers.list())).not.toContain("token");
    expect((await stat(path)).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o600,
    );
    expect((await stat(root)).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o700,
    );

    workers.close();
    const reopened = new WorkerRegistry(path);
    registries.push(reopened);
    expect(reopened.status(registration.worker.id)).toMatchObject({
      id: registration.worker.id,
      status: "never_seen",
    });
  });

  it("allows one local worker and only validated preconfigured SSH aliases", async () => {
    const { registry: workers } = await registry({
      allowedSshAliases: ["build-mac", "gpu_1.example"],
    });
    workers.register(localRegistration());
    expect(() => workers.register(localRegistration("Second Local"))).toThrow(
      /UNIQUE constraint/,
    );

    expect(() =>
      workers.register({
        name: "Unknown SSH",
        transport: { kind: "ssh", alias: "unconfigured" },
        confirmation: workerRegistrationConfirmation("Unknown SSH"),
      }),
    ).toThrow(/not preconfigured/);
    expect(() =>
      workers.register({
        name: "Unsafe SSH",
        transport: { kind: "ssh", alias: "-oProxyCommand=bad" },
        confirmation: workerRegistrationConfirmation("Unsafe SSH"),
      }),
    ).toThrow(/SSH alias/);

    const remote = workers.register({
      name: "Build Mac",
      transport: { kind: "ssh", alias: "build-mac" },
      controlEndpoint: "https://worker.example.test/control",
      confirmation: workerRegistrationConfirmation("Build Mac"),
    });
    expect(remote.worker).toMatchObject({
      transport: { kind: "ssh", alias: "build-mac" },
      controlEndpoint: "https://worker.example.test/control",
    });
    expect(() =>
      workers.register({
        name: "HTTP Worker",
        transport: { kind: "ssh", alias: "gpu_1.example" },
        controlEndpoint: "http://worker.example.test/control",
        confirmation: workerRegistrationConfirmation("HTTP Worker"),
      }),
    ).toThrow(/HTTPS/);
  });

  it("rejects arbitrary command, host, argv, and transport fields", async () => {
    const { registry: workers } = await registry({
      allowedSshAliases: ["build-mac"],
    });
    expect(() =>
      workers.register({
        ...localRegistration(),
        command: "ssh",
        argv: ["attacker"],
      } as unknown as RegisterWorkerInput),
    ).toThrow(/unsupported fields/);
    expect(() =>
      workers.register({
        name: "Build",
        transport: {
          kind: "ssh",
          alias: "build-mac",
          host: "attacker.example",
        },
        confirmation: workerRegistrationConfirmation("Build"),
      } as unknown as RegisterWorkerInput),
    ).toThrow(/unsupported fields/);
  });
});

describe("heartbeats and worker lifecycle", () => {
  it("authenticates heartbeats and tracks capabilities, providers, and staleness", async () => {
    let now = new Date("2026-07-12T20:00:00.000Z");
    const { registry: workers } = await registry({
      heartbeatTtlMs: 5_000,
      now: () => new Date(now),
    });
    const registration = workers.register(localRegistration());

    expect(() =>
      workers.heartbeat(heartbeat(registration.worker.id, "x".repeat(40))),
    ).toThrow(WorkerAuthenticationError);
    const legacy = heartbeat(registration.worker.id, registration.token);
    legacy.capabilities.protocol =
      "agent-mesh-worker/v2" as typeof WORKER_CAPABILITY_PROTOCOL;
    expect(() => workers.heartbeat(legacy)).toThrow(/protocol must equal/);
    const alive = workers.heartbeat(
      heartbeat(registration.worker.id, registration.token),
    );
    expect(alive).toMatchObject({
      status: "online",
      activeTasks: 1,
      capabilities: {
        protocol: WORKER_CAPABILITY_PROTOCOL,
        maxConcurrentTasks: 4,
        modes: ["ask", "review", "implement"],
      },
      providers: [
        {
          provider: "codex",
          installed: true,
          version: "0.144.1",
          models: ["gpt-5.6-sol"],
        },
        {
          provider: "claude",
          installed: false,
        },
        {
          provider: "grok",
          installed: true,
          version: "0.2.111",
          models: ["grok-4.5"],
        },
        {
          provider: "antigravity",
          installed: true,
          version: "1.1.5",
          models: ["gemini-3.1-pro-high"],
        },
      ],
      lastHeartbeatAt: "2026-07-12T20:00:00.000Z",
      heartbeatExpiresAt: "2026-07-12T20:00:05.000Z",
    });

    now = new Date("2026-07-12T20:00:06.000Z");
    expect(workers.status(registration.worker.id).status).toBe("stale");
  });

  it("recurs local refreshes without serializing or re-supplying the token", async () => {
    let now = new Date("2026-07-12T20:00:00.000Z");
    const { registry: workers } = await registry({
      heartbeatTtlMs: 1_000,
      localHeartbeatIntervalMs: 20,
      now: () => new Date(now),
    });
    const registration = workers.register(localRegistration());
    workers.heartbeat(heartbeat(registration.worker.id, registration.token));

    now = new Date("2026-07-12T20:00:00.900Z");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    expect(workers.status(registration.worker.id)).toMatchObject({
      status: "online",
      lastHeartbeatAt: "2026-07-12T20:00:00.900Z",
      heartbeatExpiresAt: "2026-07-12T20:00:01.900Z",
    });

    const localHeartbeat = workers.startLocalHeartbeat(registration.worker.id);
    expect(localHeartbeat).not.toHaveProperty("token");
    expect(JSON.stringify(localHeartbeat)).not.toContain(registration.token);
    localHeartbeat.stop();

    now = new Date("2026-07-12T20:00:01.901Z");
    expect(workers.status(registration.worker.id).status).toBe("stale");
  });

  it("requires exact disable/remove confirmations and removal follows disable", async () => {
    const { registry: workers } = await registry();
    const registration = workers.register(localRegistration());
    expect(() =>
      workers.disable({
        workerId: registration.worker.id,
        confirmation: "yes",
      }),
    ).toThrow(WorkerConfirmationError);

    const disabled = workers.disable({
      workerId: registration.worker.id,
      confirmation: workerDisableConfirmation(registration.worker.id),
    });
    expect(disabled.status).toBe("disabled");
    expect(() =>
      workers.heartbeat(
        heartbeat(registration.worker.id, registration.token, {
          activeTasks: 0,
        }),
      ),
    ).toThrow(/disabled/);
    expect(() =>
      workers.remove({
        workerId: registration.worker.id,
        confirmation: "REMOVE WORKER wrong",
      }),
    ).toThrow(WorkerConfirmationError);
    expect(
      workers.remove({
        workerId: registration.worker.id,
        confirmation: workerRemoveConfirmation(registration.worker.id),
      }),
    ).toEqual({ id: registration.worker.id, removed: true });
    expect(() => workers.status(registration.worker.id)).toThrow(/Unknown worker/);
  });
});

describe("bounded companion operations", () => {
  it("fails closed when no worker companion is installed", async () => {
    const { registry: workers } = await registry();
    const registration = workers.register(localRegistration());
    workers.heartbeat(heartbeat(registration.worker.id, registration.token));
    const envelope = createWorkerDispatchEnvelope({
      workerId: registration.worker.id,
      task: {
        taskId: "task-1",
        origin: "cursor",
        provider: "codex",
        prompt: "Review the implementation.",
        description: "remote review",
        cwd: "/tmp/project",
        mode: "review",
        model: null,
        effort: null,
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
        baseRef: null,
      },
    });

    await expect(workers.probe(registration.worker.id)).rejects.toBeInstanceOf(
      WorkerCompanionUnavailableError,
    );
    await expect(
      workers.dispatch(registration.worker.id, envelope),
    ).rejects.toBeInstanceOf(WorkerCompanionUnavailableError);
  });

  it("bounds health probes and returns only explicit dispatch acceptance", async () => {
    const neverReplies: WorkerCompanion = {
      probe: async () => new Promise(() => undefined),
      dispatch: async () => new Promise(() => undefined),
    };
    const { registry: workers } = await registry({ companion: neverReplies });
    const registration = workers.register(localRegistration());
    workers.heartbeat(heartbeat(registration.worker.id, registration.token));

    const started = Date.now();
    await expect(
      workers.probe(registration.worker.id, { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms/);
    expect(Date.now() - started).toBeLessThan(1_000);

    let receivedTransport: unknown;
    const companion: WorkerCompanion = {
      async probe({ worker }) {
        receivedTransport = worker.transport;
        return {
          health: "healthy",
          message: "api_key=sk-abcdefghijklmnop",
          checkedAt: "2026-07-12T20:00:00.000Z",
        };
      },
      async dispatch({ worker, envelope }) {
        receivedTransport = worker.transport;
        return {
          dispatchId: envelope.dispatchId,
          accepted: true,
          remoteTaskId: "remote-task-1",
          acceptedAt: "2026-07-12T20:00:00.000Z",
        };
      },
    };
    const probe = await workers.probe(registration.worker.id, { companion });
    expect(probe.health).toBe("healthy");
    expect(probe.message).toContain("[REDACTED]");
    expect(probe.message).not.toContain("sk-abcdefghijklmnop");

    const envelope = createWorkerDispatchEnvelope({
      workerId: registration.worker.id,
      task: {
        taskId: "task-1",
        origin: "cursor",
        provider: "codex",
        prompt: "Review only.",
        description: "bounded dispatch",
        cwd: "/tmp/project",
        mode: "review",
        model: null,
        effort: null,
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
        baseRef: null,
      },
    });
    const acceptance = await workers.dispatch(
      registration.worker.id,
      envelope,
      { companion },
    );
    expect(acceptance).toEqual({
      dispatchId: envelope.dispatchId,
      accepted: true,
      remoteTaskId: "remote-task-1",
      acceptedAt: "2026-07-12T20:00:00.000Z",
    });
    expect(receivedTransport).toEqual({ kind: "local" });
    expect(acceptance).not.toHaveProperty("completed");
    expect(acceptance).not.toHaveProperty("result");
  });

  it("quarantines late acceptance when a companion ignores abort", async () => {
    let dispatchCalls = 0;
    const companion: WorkerCompanion = {
      async probe() {
        return { health: "healthy" };
      },
      async dispatch({ envelope }) {
        dispatchCalls += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 160));
        return {
          dispatchId: envelope.dispatchId,
          accepted: true,
          remoteTaskId: "ghost-task-1",
          acceptedAt: new Date().toISOString(),
        };
      },
    };
    const { registry: workers } = await registry({ companion });
    const registration = workers.register(localRegistration());
    workers.heartbeat(heartbeat(registration.worker.id, registration.token));
    const envelope = dispatchEnvelope(
      registration.worker.id,
      "late-dispatch-1",
    );

    await expect(
      workers.dispatch(registration.worker.id, envelope, { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms/);
    expect(workers.listQuarantinedDispatches()).toMatchObject([
      {
        dispatchId: envelope.dispatchId,
        state: "quarantined",
        reason: "timeout",
        remoteTaskId: null,
      },
    ]);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    expect(workers.listQuarantinedDispatches()).toMatchObject([
      {
        dispatchId: envelope.dispatchId,
        state: "late_accepted",
        reason: "late_acceptance",
        remoteTaskId: "ghost-task-1",
      },
    ]);
    await expect(
      workers.dispatch(registration.worker.id, envelope, { companion }),
    ).rejects.toThrow(/already crossed or entered a dispatch barrier/);
    expect(dispatchCalls).toBe(1);
  });
});
