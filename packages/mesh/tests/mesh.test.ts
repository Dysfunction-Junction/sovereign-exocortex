import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { TaskRegistry } from "../src/registry.js";
import { startLineProcess } from "../src/process.js";
import {
  AgentMeshRouter,
  assertTaskPatchPromotable,
} from "../src/router.js";
import {
  accumulateGrokStreamEvent,
  grokToolsForMode,
  parseGrokModels,
  validateGrokInspectReport,
  type GrokStreamAccumulator,
} from "../src/adapters/grok.js";
import {
  ANTIGRAVITY_PROJECT_EXECUTABLE_CONFIGS,
  assertAntigravityResumeAllowed,
  buildAntigravityPrompt,
  parseAntigravityConversationId,
  parseAntigravityModels,
  rejectAntigravityProjectExecutables,
} from "../src/adapters/antigravity.js";
import {
  assertDelegationAllowed,
  assertNoActiveTaskAncestor,
  buildSafeEnv,
  canonicalizeAllowedCwd,
  redactSecrets,
  summarizeEventForLog,
} from "../src/security.js";
import type {
  ProviderAdapter,
  TaskRecord,
  ManagedPeerContext,
} from "../src/types.js";
import type { TaskTrafficGate } from "../src/router.js";
import {
  cleanupWorktree,
  collectWorktreeArtifacts,
  inspectBaseFreshness,
  prepareWorktree,
  verifyWorktreeArtifacts,
} from "../src/worktree.js";
import { PatchPromotionService } from "../src/patch-promotion.js";
import { runStopHook } from "../src/stop-hook-cli.js";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];
const originalStateDir = process.env.AGENT_MESH_STATE_DIR;

afterEach(async () => {
  delete process.env.AGENT_MESH_CHILD;
  delete process.env.AGENT_MESH_ALLOWED_ROOTS;
  if (originalStateDir === undefined) delete process.env.AGENT_MESH_STATE_DIR;
  else process.env.AGENT_MESH_STATE_DIR = originalStateDir;
  delete process.env.AGENT_MESH_MAX_PATCH_BYTES;
  delete process.env.AGENT_MESH_MAX_CONCURRENT;
  delete process.env.AGENT_MESH_MAX_PROVIDER_LINE_BYTES;
  delete process.env.AGENT_MESH_NATIVE_QUESTION_TIMEOUT_MS;
  delete process.env.AGENT_MESH_MAX_ANTIGRAVITY_PROMPT_BYTES;
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) =>
        rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
          () => undefined,
        ),
      ),
  );
});

async function waitForTaskStatus(
  router: AgentMeshRouter,
  taskId: string,
  status: TaskRecord["status"],
  timeoutMs = 2_000,
): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = router.getStatus(taskId);
    if (task.status === status) return task;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${status}; current=${task.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("security policy", () => {
  it("strips ambient credentials and marks delegated children", () => {
    process.env.OPENAI_API_KEY = "sk-should-not-pass";
    process.env.GITHUB_TOKEN = "ghp_should_not_pass";
    const env = buildSafeEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AGENT_MESH_CHILD).toBe("1");
    delete process.env.OPENAI_API_KEY;
    delete process.env.GITHUB_TOKEN;
  });

  it("rejects recursion and nested delegation", () => {
    expect(() => assertDelegationAllowed("cursor", "cursor")).toThrow(/recursive/);
    process.env.AGENT_MESH_CHILD = "1";
    expect(() => assertDelegationAllowed("cursor", "codex")).toThrow(/Nested/);
  });

  it("rejects descendants of active provider processes", () => {
    expect(() => assertNoActiveTaskAncestor([])).not.toThrow();
    expect(() => assertNoActiveTaskAncestor([process.ppid])).toThrow(/descendants/);
  });

  it("redacts common credential formats", () => {
    expect(redactSecrets("api_key=sk-abcdefghijklmnop")).not.toContain(
      "sk-abcdefghijklmnop",
    );
    expect(redactSecrets("XAI_API_KEY=xai-abcdefghijklmnop")).not.toContain(
      "xai-abcdefghijklmnop",
    );
    expect(
      redactSecrets(
        "eyJaaaaaaaaaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccccc",
      ),
    ).toContain("[REDACTED JWT]");
    expect(redactSecrets("Authorization: bearer-secret-value")).toContain("[REDACTED]");
  });

  it("redacts the credential after an Authorization scheme and every cookie pair", () => {
    const opaque = "meshd_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    expect(redactSecrets(`Authorization: Bearer ${opaque}`)).not.toContain(opaque);
    expect(redactSecrets(`authorization=Bearer ${opaque}`)).not.toContain(opaque);
    expect(redactSecrets(`{"authorization":"Basic ${opaque}"}`)).not.toContain(opaque);
    const cookies = redactSecrets("Cookie: first=aaaaaaaa; second=bbbbbbbb; third=cccccccc");
    expect(cookies).not.toContain("second=bbbbbbbb");
    expect(cookies).not.toContain("third=cccccccc");
  });

  it("summarizes provider events without retaining prompts or answers", () => {
    const summary = summarizeEventForLog({
      type: "user",
      session_id: "session",
      message: { content: [{ text: "sensitive prompt" }] },
    });
    expect(summary).toEqual({ type: "user", session_id: "session" });
    expect(JSON.stringify(summary)).not.toContain("sensitive prompt");
  });

  it("canonicalizes only configured roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-root-"));
    const outside = await mkdtemp(join(tmpdir(), "mesh-outside-"));
    cleanupPaths.push(root, outside);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    await mkdir(join(root, "project"));
    await expect(canonicalizeAllowedCwd(join(root, "project"))).resolves.toContain(root);
    await expect(canonicalizeAllowedCwd(outside)).rejects.toThrow(/outside configured/);
  });
});

describe("Grok streaming adapter", () => {
  it("never exposes shell execution to delegated Grok tasks", () => {
    for (const mode of ["ask", "plan", "review", "research", "implement"] as const) {
      expect(grokToolsForMode(mode)).not.toContain("run_terminal_cmd");
    }
    expect(grokToolsForMode("implement")).toContain("search_replace");
  });

  it("rejects unapproved Grok config, plugin, hook, and MCP discovery", () => {
    const configPath = "/private/task/grok-home/config.toml";
    const valid = {
      configSources: { layers: [{ role: "user", path: configPath }] },
      hooks: [],
      plugins: [],
      mcpServers: [
        {
          name: "perplexity",
          source: { type: "grokConfig", path: configPath },
        },
      ],
    };
    expect(() =>
      validateGrokInspectReport(valid, configPath, ["perplexity"]),
    ).not.toThrow();
    expect(() =>
      validateGrokInspectReport(
        {
          ...valid,
          configSources: {
            layers: [
              ...valid.configSources.layers,
              { role: "project", path: "/repo/.grok/config.toml" },
            ],
          },
        },
        configPath,
        ["perplexity"],
      ),
    ).toThrow(/configuration source/);
    expect(() =>
      validateGrokInspectReport({ ...valid, plugins: [{ name: "unsafe" }] }, configPath, [
        "perplexity",
      ]),
    ).toThrow(/plugins/);
    expect(() =>
      validateGrokInspectReport({ ...valid, hooks: [{ event: "SessionStart" }] }, configPath, [
        "perplexity",
      ]),
    ).toThrow(/hooks/);
    expect(() =>
      validateGrokInspectReport(
        {
          ...valid,
          mcpServers: [
            ...valid.mcpServers,
            {
              name: "unexpected",
              source: { type: "mcpJson", path: "/repo/.mcp.json" },
            },
          ],
        },
        configPath,
        ["perplexity"],
      ),
    ).toThrow(/unapproved MCP/);
  });

  it("accumulates text, session, usage, and exact spend metadata", () => {
    const state: GrokStreamAccumulator = {
      output: "",
      sessionId: "initial-session",
      metadata: {},
      error: "",
      completed: false,
    };
    accumulateGrokStreamEvent(state, { type: "thought", data: "private reasoning" });
    accumulateGrokStreamEvent(state, { type: "text", data: "GROK_" });
    accumulateGrokStreamEvent(state, { type: "text", data: "OK" });
    accumulateGrokStreamEvent(state, {
      type: "end",
      stopReason: "EndTurn",
      sessionId: "final-session",
      requestId: "request-1",
      usage: { input_tokens: 10, output_tokens: 2 },
      num_turns: 1,
      total_cost_usd: 0.001,
      total_cost_usd_ticks: 10_000_000,
      modelUsage: { "grok-4.5-build": { modelCalls: 1 } },
    });

    expect(state).toMatchObject({
      output: "GROK_OK",
      sessionId: "final-session",
      usage: { input_tokens: 10, output_tokens: 2 },
      metadata: {
        requestId: "request-1",
        stopReason: "EndTurn",
        numTurns: 1,
        totalCostUsd: 0.001,
        totalCostUsdTicks: 10_000_000,
      },
      error: "",
      completed: true,
    });
    expect(JSON.stringify(state)).not.toContain("private reasoning");
  });

  it("captures structured errors and parses only Grok model rows", () => {
    const state: GrokStreamAccumulator = {
      output: "",
      sessionId: "session",
      metadata: {},
      error: "",
      completed: false,
    };
    accumulateGrokStreamEvent(state, {
      type: "error",
      message: "authentication failed",
      sessionId: "failed-session",
    });
    expect(state.error).toBe("authentication failed");
    expect(state.sessionId).toBe("failed-session");
    const cancelled: GrokStreamAccumulator = {
      output: "partial",
      sessionId: "session",
      metadata: {},
      error: "",
      completed: false,
    };
    accumulateGrokStreamEvent(cancelled, {
      type: "end",
      stopReason: "Cancelled",
      sessionId: "session",
    });
    expect(cancelled.error).toMatch(/without completing/);
    expect(
      parseGrokModels(`Available models:
  * grok-4.5 (default)
  * grok-build
  * --unsafe
`),
    ).toMatchObject([
      { id: "grok-4.5", isDefault: true },
      { id: "grok-build", isDefault: false },
    ]);
  });
});

describe("Antigravity adapter", () => {
  it("parses and deduplicates only safe model IDs", () => {
    expect(
      parseAntigravityModels(`gemini-3.6-flash-high
gemini-3.1-pro-high
gemini-3.1-pro-high
claude-opus-4-6-thinking
--unsafe
not a model
`),
    ).toMatchObject([
      { id: "gemini-3.6-flash-high", isDefault: true },
      { id: "gemini-3.1-pro-high", isDefault: false },
      { id: "claude-opus-4-6-thinking", isDefault: false },
    ]);
  });

  it("parses conversation IDs and blocks resume privilege/workspace changes", () => {
    const sessionId = randomUUID();
    expect(
      parseAntigravityConversationId(
        `I0000 server.go] Created conversation ${sessionId}\n`,
      ),
    ).toBe(sessionId);
    const lineage = {
      cwd: "/workspace/one",
      lineageId: randomUUID(),
      writable: false,
    };
    expect(() =>
      assertAntigravityResumeAllowed(lineage, "/workspace/one", "review"),
    ).not.toThrow();
    expect(() =>
      assertAntigravityResumeAllowed(lineage, "/workspace/one", "implement"),
    ).toThrow(/read-only/);
    expect(() =>
      assertAntigravityResumeAllowed(lineage, "/workspace/two", "review"),
    ).toThrow(/move between workspaces/);
  });

  it("bounds argv prompts and preserves blank stdout lines", async () => {
    const request = {
      taskId: randomUUID(),
      prompt: "line one\n\nline three",
      cwd: "/workspace",
      mode: "review" as const,
      model: undefined,
      effort: undefined,
      mcpProfile: "none" as const,
      timeoutMs: 1_000,
      taskDir: "/tmp/task",
    };
    expect(buildAntigravityPrompt(request)).toContain("line one\n\nline three");
    process.env.AGENT_MESH_MAX_ANTIGRAVITY_PROMPT_BYTES = "32";
    expect(() => buildAntigravityPrompt(request)).toThrow(/argv limit/);
    delete process.env.AGENT_MESH_MAX_ANTIGRAVITY_PROMPT_BYTES;

    const root = await mkdtemp(join(tmpdir(), "mesh-antigravity-output-"));
    cleanupPaths.push(root);
    const lines: string[] = [];
    const running = startLineProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("one\\n\\nthree\\n")'],
      cwd: root,
      env: buildSafeEnv(),
      timeoutMs: 5_000,
      eventsPath: join(root, "events.ndjson"),
      preserveEmptyStdoutLines: true,
      summarizeStdoutLine: () => ({ type: "provider_output" }),
      onStdoutLine(line) {
        lines.push(line);
      },
    });
    await expect(running.completion).resolves.toMatchObject({ code: 0 });
    expect(lines).toEqual(["one", "", "three"]);
  });

  it("rejects every project-local executable customization", async () => {
    for (const relative of ANTIGRAVITY_PROJECT_EXECUTABLE_CONFIGS) {
      const root = await mkdtemp(join(tmpdir(), "mesh-antigravity-project-"));
      cleanupPaths.push(root);
      const path = join(root, relative);
      if (relative.endsWith("/plugins")) {
        await mkdir(path, { recursive: true });
      } else {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "{}\n");
      }
      await expect(rejectAntigravityProjectExecutables(root)).rejects.toThrow(
        relative,
      );
    }
  });
});

describe("task registry", () => {
  it("migrates requested-versus-actual model provenance columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-registry-migration-"));
    cleanupPaths.push(root);
    const path = join(root, "mesh.db");
    new TaskRegistry(path).close();
    const legacy = new DatabaseSync(path);
    for (const column of [
      "actual_model",
      "actual_effort",
      "fallback_count",
      "fallback_reason",
    ]) {
      legacy.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
    }
    legacy.close();

    new TaskRegistry(path).close();
    const migrated = new DatabaseSync(path);
    const columns = migrated
      .prepare("PRAGMA table_info(tasks)")
      .all()
      .map((column) => String((column as { name: unknown }).name));
    migrated.close();
    expect(columns).toEqual(
      expect.arrayContaining([
        "actual_model",
        "actual_effort",
        "fallback_count",
        "fallback_reason",
      ]),
    );
  });

  it("persists and searches task metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-registry-"));
    cleanupPaths.push(root);
    const registry = new TaskRegistry(join(root, "mesh.db"));
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: randomUUID(),
      origin: "cursor",
      provider: "codex",
      description: "adversarial review",
      mode: "review",
      status: "queued",
      cwd: root,
      effectiveCwd: root,
      repoRoot: null,
      worktreePath: null,
      baseCommit: null,
      model: "gpt-5.5",
      effort: "high",
      actualModel: "gpt-5.5-actual",
      actualEffort: "high",
      fallbackCount: 1,
      fallbackReason: "capacity",
      mcpProfile: "none",
      sessionId: null,
      parentTaskId: null,
      ownerPid: process.pid,
      pid: null,
      resultPath: null,
      eventsPath: null,
      transcriptPath: null,
      pendingQuestionId: null,
      patchPath: null,
      changedFiles: [],
      artifactStatus: "not_applicable",
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    registry.insert(task);
    registry.update(task.id, { status: "running", sessionId: "session-1" });
    expect(registry.require(task.id)).toMatchObject({
      status: "running",
      model: "gpt-5.5",
      actualModel: "gpt-5.5-actual",
      actualEffort: "high",
      fallbackCount: 1,
      fallbackReason: "capacity",
    });
    expect(
      registry.search({ origin: "cursor", query: "adversarial", limit: 10 }),
    ).toHaveLength(1);
    expect(registry.findBySession("cursor", "codex", "session-1")?.id).toBe(task.id);
    expect(registry.activePids()).toEqual([]);

    const worktreePath = join(root, "leased-worktree");
    const terminal = {
      ...task,
      id: randomUUID(),
      status: "completed" as const,
      sessionId: "terminal-session",
      worktreePath,
      baseCommit: "abc",
      artifactStatus: "clean" as const,
    };
    registry.insert(terminal);
    const waitingSibling = {
      ...terminal,
      id: randomUUID(),
      status: "waiting_for_input" as const,
      sessionId: "waiting-session",
      completedAt: null,
    };
    registry.insert(waitingSibling);
    expect(registry.acquireCleanupLease(worktreePath, terminal.id)).toBe(false);
    registry.update(waitingSibling.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    expect(registry.acquireCleanupLease(worktreePath, terminal.id)).toBe(true);
    expect(() =>
      registry.insertIfBelowLimit(
        {
          ...terminal,
          id: randomUUID(),
          status: "queued",
          sessionId: "new-session",
          completedAt: null,
        },
        10,
      ),
    ).toThrow(/leased for cleanup/);
    registry.releaseCleanupLease(worktreePath);
    registry.insert({
      ...terminal,
      id: randomUUID(),
      sessionId: "failed-sibling",
      status: "failed",
      artifactStatus: "failed",
    });
    expect(registry.acquireCleanupLease(worktreePath, terminal.id)).toBe(false);
    registry.close();
  });

  it("marks tasks from dead mesh owners as interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-orphan-"));
    cleanupPaths.push(root);
    const path = join(root, "mesh.db");
    const registry = new TaskRegistry(path);
    const now = new Date().toISOString();
    const id = randomUUID();
    registry.insert({
      id,
      origin: "cursor",
      provider: "claude",
      description: "orphan",
      mode: "ask",
      status: "running",
      cwd: root,
      effectiveCwd: root,
      repoRoot: null,
      worktreePath: null,
      baseCommit: null,
      model: null,
      effort: null,
      mcpProfile: "none",
      sessionId: null,
      parentTaskId: null,
      ownerPid: 2_147_483_646,
      pid: 2_147_483_645,
      resultPath: null,
      eventsPath: null,
      transcriptPath: null,
      pendingQuestionId: null,
      patchPath: null,
      changedFiles: [],
      artifactStatus: "not_applicable",
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    registry.close();
    const reopened = new TaskRegistry(path);
    expect(reopened.require(id).status).toBe("interrupted");
    reopened.close();
  });
});

describe("router lifecycle", () => {
  const capabilities = {
    provider: "codex" as const,
    dynamicModelDiscovery: false,
    resume: true,
    fork: true,
    nativeSessionSearch: false,
    nativeCancellation: false,
    notes: [],
  };

  it("persists actual-model provenance and resumes with the model that ran", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-provenance-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = join(root, "state");
    const registryPath = join(root, "mesh.db");
    const sessionId = "claude-provenance-session";
    let replacementCancelled = false;
    const firstAdapter: ProviderAdapter = {
      provider: "claude",
      capabilities: () => ({ ...capabilities, provider: "claude" }),
      listModels: async () => [],
      run: async (_request, hooks) => {
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onStarted({
          cancel: async () => {
            replacementCancelled = true;
          },
        });
        hooks.onSession(sessionId);
        return {
          output: "Fable completed the task.",
          sessionId,
          metadata: {
            requestedModel: "claude-opus-5",
            actualModel: "claude-fable-5",
            actualEffort: "max",
            fallbackCount: 1,
            fallbackReason: "opus_usage_or_availability",
          },
        };
      },
    };
    const firstRouter = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(registryPath),
      [firstAdapter],
    );
    const first = await firstRouter.start(
      {
        provider: "claude",
        prompt: "Review the repository.",
        description: "model provenance",
        cwd: root,
        mode: "review",
        model: "claude-opus-5",
        effort: "max",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 30_000,
      },
      { background: false },
    );
    expect(first.task).toMatchObject({
      model: "claude-opus-5",
      effort: "max",
      actualModel: "claude-fable-5",
      actualEffort: "max",
      fallbackCount: 1,
      fallbackReason: "opus_usage_or_availability",
    });
    expect(replacementCancelled).toBe(false);
    await firstRouter.close();

    let resumedModel: string | undefined;
    let resumedEffort: string | undefined;
    const resumedAdapter: ProviderAdapter = {
      provider: "claude",
      capabilities: () => ({ ...capabilities, provider: "claude" }),
      listModels: async () => [],
      run: async (request, hooks) => {
        resumedModel = request.model;
        resumedEffort = request.effort;
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession(sessionId);
        return {
          output: "Continued on Fable.",
          sessionId,
          metadata: {
            actualModel: request.model ?? null,
            actualEffort: request.effort ?? null,
            fallbackCount: 0,
          },
        };
      },
    };
    const reopened = new TaskRegistry(registryPath);
    expect(reopened.require(first.task.id)).toMatchObject({
      model: "claude-opus-5",
      actualModel: "claude-fable-5",
      fallbackCount: 1,
    });
    const resumedRouter = new AgentMeshRouter(
      "cursor",
      reopened,
      [resumedAdapter],
    );
    const resumed = await resumedRouter.continueSession({
      provider: "claude",
      sessionId,
      prompt: "Continue.",
      description: "provenance resume",
      timeoutMs: 30_000,
      background: false,
      fork: false,
    });
    expect(resumedModel).toBe("claude-fable-5");
    expect(resumedEffort).toBe("max");
    expect(resumed.task).toMatchObject({
      model: "claude-fable-5",
      actualModel: "claude-fable-5",
    });
    await resumedRouter.close();
  });

  it("passes a task-bound peer context and rebinds its provider session", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-peer-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = join(root, "state");
    const context: ManagedPeerContext = {
      origin: "cursor",
      agentId: "11111111-1111-4111-8111-111111111111",
      memberId: "22222222-2222-4222-8222-222222222222",
      membershipGeneration: 1,
    };
    let boundSession = "";
    let releasedTask = "";
    let captured: ManagedPeerContext | undefined;
    const gate: TaskTrafficGate = {
      reserve: async (task) => ({ ...context, taskId: task.id }),
      bindSession: (taskId, sessionId) => {
        boundSession = sessionId;
        return {
          ...context,
          membershipGeneration: 2,
          taskId,
        };
      },
      release: (taskId) => {
        releasedTask = taskId;
      },
    };
    const adapter: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (request, hooks) => {
        captured = request.peer ? { ...request.peer } : undefined;
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession("peer-session");
        return { output: "ok", sessionId: "peer-session" };
      },
    };
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(root, "mesh.db")),
      [adapter],
      gate,
    );
    const result = await router.start(
      {
        provider: "codex",
        prompt: "coordinate",
        description: "peer context",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 30_000,
      },
      { background: false },
    );
    expect(captured).toMatchObject({
      agentId: context.agentId,
      memberId: context.memberId,
      membershipGeneration: 1,
      taskId: result.task.id,
    });
    expect(boundSession).toBe("peer-session");
    expect(releasedTask).toBe(result.task.id);
    await router.close();
  });

  it("defers fork peer identity until the provider returns a new session", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-peer-fork-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = join(root, "state");
    const oldSession = "11111111-1111-4111-8111-111111111111";
    const newSession = "22222222-2222-4222-8222-222222222222";
    const bound: string[] = [];
    const gate: TaskTrafficGate = {
      reserve: async (task) => ({
        origin: "cursor",
        agentId: "33333333-3333-4333-8333-333333333333",
        memberId: "44444444-4444-4444-8444-444444444444",
        membershipGeneration: 1,
        taskId: task.id,
      }),
      bindSession: (_taskId, sessionId, peer) => {
        bound.push(sessionId);
        return peer;
      },
      release: () => undefined,
    };
    const adapter: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (_request, hooks) => {
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession(oldSession);
        return { output: "forked", sessionId: newSession };
      },
    };
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(root, "mesh.db")),
      [adapter],
      gate,
    );
    const result = await router.start(
      {
        provider: "codex",
        prompt: "fork",
        description: "fork peer identity",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 30_000,
        resumeSessionId: oldSession,
        forkSession: true,
      },
      { background: false },
    );
    expect(bound).toEqual([newSession]);
    expect(result.task.sessionId).toBe(newSession);
    await router.close();
  });

  function nativeQuestionAdapter(onCancel: () => void = () => undefined): ProviderAdapter {
    return {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (_request, hooks) => {
        hooks.onStarted({
          cancel: async () => {
            onCancel();
          },
        });
        hooks.onSession("native-question-session");
        if (!hooks.onQuestion) throw new Error("missing native question hook");
        const resolution = await hooks.onQuestion({
          requestId: "request-1:database",
          questionId: "database",
          question: "Which database should I use?",
          context: "Both adapters are installed.",
          options: ["Postgres", "SQLite"],
          timeoutMs: 5_000,
        });
        await resolution.delivered();
        return {
          output: `Implemented with ${resolution.answer}.`,
          sessionId: "native-question-session",
        };
      },
    };
  }

  it("records background provider failures without rejecting the server loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-failure-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = join(root, "state");
    const registry = new TaskRegistry(join(root, "mesh.db"));
    const failing: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async () => {
        throw new Error("expected provider failure");
      },
    };
    const router = new AgentMeshRouter("cursor", registry, [failing]);
    const started = await router.start(
      {
        provider: "codex",
        prompt: "fail",
        description: "background failure",
        cwd: root,
        mode: "ask",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    const result = await router.getResult(started.task.id, true, 2_000);
    expect(result.task.status).toBe("failed");
    expect(result.task.error).toContain("expected provider failure");
    await router.close();
  });

  it("completes durable reservations before launching a provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-reservation-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = join(root, "state");
    const registry = new TaskRegistry(join(root, "mesh.db"));
    let providerRan = false;
    let reservedTaskId = "";
    const adapter: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async () => {
        providerRan = true;
        return { output: "unexpected", sessionId: "unexpected" };
      },
    };
    const router = new AgentMeshRouter("cursor", registry, [adapter]);
    await expect(
      router.start(
        {
          provider: "codex",
          prompt: "must not launch",
          description: "reservation failure",
          cwd: root,
          mode: "ask",
          mcpProfile: "none",
          isolation: "none",
          timeoutMs: 5_000,
        },
        {
          background: true,
          onReserved: async (task) => {
            reservedTaskId = task.id;
            throw new Error("reservation rejected");
          },
        },
      ),
    ).rejects.toThrow("reservation rejected");
    expect(providerRan).toBe(false);
    expect(router.getStatus(reservedTaskId)).toMatchObject({
      status: "failed",
      error: "reservation rejected",
    });
    await router.close();
  });

  it("settles cancellation as a monotonic terminal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-cancel-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = join(root, "state");
    const registry = new TaskRegistry(join(root, "mesh.db"));
    const cancellable: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (_request, hooks) =>
        new Promise((_resolve, reject) => {
          hooks.onStarted({
            cancel: async () => reject(new Error("cancelled in fake adapter")),
          });
        }),
    };
    const router = new AgentMeshRouter("cursor", registry, [cancellable]);
    const started = await router.start(
      {
        provider: "codex",
        prompt: "wait",
        description: "cancellation state",
        cwd: root,
        mode: "ask",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    const cancelled = await router.cancel(started.task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(router.getStatus(started.task.id).status).toBe("cancelled");
    await router.close();
  });

  it("prevents another origin from reading task metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-owner-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = join(root, "state");
    const path = join(root, "mesh.db");
    const success: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (_request, hooks) => {
        hooks.onSession("owned-session");
        hooks.onStarted({ cancel: async () => undefined });
        return { output: "ok", sessionId: "owned-session" };
      },
    };
    const owner = new AgentMeshRouter("cursor", new TaskRegistry(path), [success]);
    const completed = await owner.start(
      {
        provider: "codex",
        prompt: "ok",
        description: "owned task",
        cwd: root,
        mode: "ask",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: false },
    );
    const other = new AgentMeshRouter("claude", new TaskRegistry(path), [success]);
    expect(() => other.getStatus(completed.task.id)).toThrow(/different mesh origin/);
    await owner.close();
    await other.close();
  });

  it("waits for an active task owned by another mesh connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-cross-wait-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-router-cross-wait-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    const path = join(state, "mesh.db");
    const delayed: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (_request, hooks) => {
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession("cross-wait-session");
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { output: "done", sessionId: "cross-wait-session" };
      },
    };
    const owner = new AgentMeshRouter("cursor", new TaskRegistry(path), [delayed]);
    const observer = new AgentMeshRouter("cursor", new TaskRegistry(path), [delayed]);
    const started = await owner.start(
      {
        provider: "codex",
        prompt: "wait",
        description: "cross process wait",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    const began = Date.now();
    const result = await observer.getResult(started.task.id, true, 2_000);
    expect(result.task.status).toBe("completed");
    expect(Date.now() - began).toBeGreaterThanOrEqual(150);
    await owner.close();
    await observer.close();
  });

  it("pauses for a blocking question, records history, and resumes from the answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-question-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-router-question-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    process.env.AGENT_MESH_MAX_CONCURRENT = "1";
    const questioning: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (request, hooks) => {
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession("question-session");
        if (request.prompt.includes("delegating parent answered")) {
          return { output: "Implemented with Postgres.", sessionId: "question-session" };
        }
        return {
          output:
            'Investigated both options.\n<agent_mesh_question>{"question":"Which database should I use?","options":["Postgres","SQLite"]}</agent_mesh_question>',
          sessionId: "question-session",
        };
      },
    };
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(state, "mesh.db")),
      [questioning],
    );
    const waiting = await router.start(
      {
        provider: "codex",
        prompt: "Implement the database layer.",
        description: "question flow",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: false },
    );
    expect(waiting.task.status).toBe("waiting_for_input");
    expect(waiting.result?.output).toBe("Investigated both options.");
    expect(waiting.questions?.[0]?.options).toEqual(["Postgres", "SQLite"]);
    expect(waiting.questions?.[0]?.delivery).toBe("resume");
    const question = router.listQuestions({ status: "pending", limit: 10 })[0]!;
    const history = await router.getTaskHistory(waiting.task.id, { limit: 20 });
    expect(history.entries.map((entry) => entry.type)).toEqual([
      "prompt",
      "final",
      "blocking_question",
    ]);

    const resumed = await router.answerQuestion({
      questionId: question.id,
      answer: "Postgres",
      background: false,
      timeoutMs: 5_000,
    });
    expect(resumed.task.status).toBe("completed");
    expect(resumed.result?.output).toContain("Postgres");
    expect(router.getStatus(waiting.task.id).status).toBe("completed");
    expect(router.listQuestions({ status: "answered", limit: 10 })[0]?.answer).toBe(
      "Postgres",
    );
    const sessionHistory = await router.getSessionHistory({
      provider: "codex",
      sessionId: "question-session",
      cursor: 0,
      limit: 50,
    });
    expect(sessionHistory.entries.some((entry) => entry.text.includes("Postgres"))).toBe(true);
    await router.close();
  });

  it("delivers a native answer from another matching-origin router exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-native-answer-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-native-answer-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    const path = join(state, "mesh.db");
    const owner = new AgentMeshRouter("cursor", new TaskRegistry(path), [
      nativeQuestionAdapter(),
    ]);
    const started = await owner.start(
      {
        provider: "codex",
        prompt: "Implement the database layer.",
        description: "native question answer",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    await waitForTaskStatus(owner, started.task.id, "waiting_for_input");
    const question = owner.listQuestions({ status: "pending", limit: 10 })[0]!;
    expect(question).toMatchObject({
      delivery: "native",
      options: ["Postgres", "SQLite"],
    });

    const answerer = new AgentMeshRouter("cursor", new TaskRegistry(path), [
      nativeQuestionAdapter(),
    ]);
    await answerer.answerQuestion({
      questionId: question.id,
      answer: "Postgres",
      background: true,
      timeoutMs: 5_000,
    });
    await expect(
      answerer.answerQuestion({
        questionId: question.id,
        answer: "SQLite",
        background: true,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/not pending/);

    const result = await owner.getResult(started.task.id, true, 2_000);
    expect(result.task.status).toBe("completed");
    expect(result.result?.output).toContain("Postgres");
    expect(owner.listQuestions({ status: "answered", limit: 10 })[0]?.answer).toBe(
      "Postgres",
    );
    const history = await owner.getTaskHistory(started.task.id, { limit: 20 });
    expect(history.entries.map((entry) => entry.type)).toEqual([
      "prompt",
      "native_question",
      "parent_answer",
      "final",
    ]);
    await answerer.close();
    await owner.close();
  });

  it("interrupts and atomically dismisses a natively waiting task", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-native-cancel-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-native-cancel-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    let cancellations = 0;
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(state, "mesh.db")),
      [nativeQuestionAdapter(() => (cancellations += 1))],
    );
    const started = await router.start(
      {
        provider: "codex",
        prompt: "Wait for a choice.",
        description: "native question cancellation",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    await waitForTaskStatus(router, started.task.id, "waiting_for_input");
    const cancelled = await router.cancel(started.task.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancellations).toBe(1);
    expect(
      router.listQuestions({ taskId: started.task.id, status: "dismissed", limit: 10 }),
    ).toHaveLength(1);
    expect(
      router.listQuestions({ taskId: started.task.id, status: "pending", limit: 10 }),
    ).toHaveLength(0);
    await router.close();
  });

  it("times out and dismisses an unanswered native question", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-native-timeout-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-native-timeout-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    process.env.AGENT_MESH_NATIVE_QUESTION_TIMEOUT_MS = "1000";
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(state, "mesh.db")),
      [nativeQuestionAdapter()],
    );
    const started = await router.start(
      {
        provider: "codex",
        prompt: "Wait for parent input.",
        description: "native question timeout",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    const result = await router.getResult(started.task.id, true, 2_500);

    expect(result.task.status).toBe("failed");
    expect(result.task.error).toMatch(/timed out/);
    expect(
      router.listQuestions({ taskId: started.task.id, status: "dismissed", limit: 10 }),
    ).toHaveLength(1);
    const history = await router.getTaskHistory(started.task.id, { limit: 20 });
    expect(history.entries.map((entry) => entry.type)).toContain("question_timeout");
    await router.close();
  });

  it("protects native questions from a different mesh origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-native-origin-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-native-origin-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    const path = join(state, "mesh.db");
    const owner = new AgentMeshRouter("cursor", new TaskRegistry(path), [
      nativeQuestionAdapter(),
    ]);
    const started = await owner.start(
      {
        provider: "codex",
        prompt: "Ask.",
        description: "native origin protection",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    await waitForTaskStatus(owner, started.task.id, "waiting_for_input");
    const question = owner.listQuestions({ status: "pending", limit: 10 })[0]!;
    const other = new AgentMeshRouter("claude", new TaskRegistry(path), [
      nativeQuestionAdapter(),
    ]);
    await expect(
      other.answerQuestion({
        questionId: question.id,
        answer: "Postgres",
        background: true,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/another mesh origin/);
    await owner.cancel(started.task.id);
    await other.close();
    await owner.close();
  });

  it("recovers a dead native owner into the resumable envelope path", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-native-recovery-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-native-recovery-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    const path = join(state, "mesh.db");
    const registry = new TaskRegistry(path);
    const now = new Date().toISOString();
    const taskId = randomUUID();
    registry.insert({
      id: taskId,
      origin: "cursor",
      provider: "codex",
      description: "recover native question",
      mode: "ask",
      status: "running",
      cwd: root,
      effectiveCwd: root,
      repoRoot: null,
      worktreePath: null,
      baseCommit: null,
      model: null,
      effort: null,
      mcpProfile: "none",
      sessionId: "orphaned-native-session",
      parentTaskId: null,
      ownerPid: process.pid,
      pid: 2_147_483_645,
      resultPath: null,
      eventsPath: null,
      transcriptPath: null,
      pendingQuestionId: null,
      patchPath: null,
      changedFiles: [],
      artifactStatus: "not_applicable",
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const native = registry.createNativeQuestionAndWait({
      taskId,
      origin: "cursor",
      provider: "codex",
      sessionId: "orphaned-native-session",
      nativeRequestId: "request-1:database",
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    });
    registry.update(taskId, { ownerPid: 2_147_483_646 });
    registry.close();

    const recoveredRegistry = new TaskRegistry(path);
    expect(recoveredRegistry.requireQuestion(native.question.id)).toMatchObject({
      delivery: "resume",
      status: "pending",
      answer: null,
    });
    expect(recoveredRegistry.require(taskId)).toMatchObject({
      status: "waiting_for_input",
      pid: null,
    });
    const resumedAdapter: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (_request, hooks) => {
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession("orphaned-native-session");
        return {
          output: "Recovered and continued with Postgres.",
          sessionId: "orphaned-native-session",
        };
      },
    };
    const router = new AgentMeshRouter("cursor", recoveredRegistry, [resumedAdapter]);
    const resumed = await router.answerQuestion({
      questionId: native.question.id,
      answer: "Postgres",
      background: false,
      timeoutMs: 5_000,
    });
    expect(resumed.task.status).toBe("completed");
    expect(resumed.result?.output).toContain("Postgres");
    expect(router.getStatus(taskId).status).toBe("completed");
    await router.close();
  });

  it("retains a resumable question when the live Codex connection drops", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-native-connection-loss-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-native-connection-loss-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    const adapter: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (request, hooks) => {
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession("connection-loss-session");
        if (request.prompt.includes("delegating parent answered")) {
          return {
            output: "Continued safely with Postgres.",
            sessionId: "connection-loss-session",
          };
        }
        if (!hooks.onQuestion) throw new Error("missing native question hook");
        void hooks
          .onQuestion({
            requestId: "request-1:database",
            questionId: "database",
            question: "Which database?",
            options: ["Postgres", "SQLite"],
            timeoutMs: 5_000,
          })
          .catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("simulated app-server connection loss");
      },
    };
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(state, "mesh.db")),
      [adapter],
    );
    const started = await router.start(
      {
        provider: "codex",
        prompt: "Implement storage.",
        description: "native connection recovery",
        cwd: root,
        mode: "ask",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 5_000,
      },
      { background: true },
    );
    const recovered = await router.getResult(started.task.id, true, 2_000);
    expect(recovered.task.status).toBe("waiting_for_input");
    expect(recovered.questions?.[0]).toMatchObject({
      delivery: "resume",
      status: "pending",
    });

    const resumed = await router.answerQuestion({
      questionId: recovered.questions![0]!.id,
      answer: "Postgres",
      background: false,
      timeoutMs: 5_000,
    });
    expect(resumed.task.status).toBe("completed");
    expect(resumed.result?.output).toContain("Postgres");
    await router.close();
  });

  it("refuses cleanup when artifact capture fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-router-artifact-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-router-artifact-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    process.env.AGENT_MESH_MAX_PATCH_BYTES = "1";
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });

    const writer: ProviderAdapter = {
      provider: "codex",
      capabilities: () => capabilities,
      listModels: async () => [],
      run: async (request, hooks) => {
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession("artifact-session");
        await writeFile(join(request.cwd, "generated.txt"), "changed\n");
        return { output: "done", sessionId: "artifact-session" };
      },
    };
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(state, "mesh.db")),
      [writer],
    );
    const result = await router.start(
      {
        provider: "codex",
        prompt: "write",
        description: "artifact failure",
        cwd: root,
        mode: "implement",
        isolation: "auto",
        timeoutMs: 5_000,
      },
      { background: false },
    );
    expect(result.task.status).toBe("failed");
    expect(result.task.artifactStatus).toBe("failed");
    await expect(router.cleanup(result.task.id)).rejects.toThrow(/artifact capture/);
    await router.close();
  });
});

describe("process lifecycle", () => {
  it("cancels a detached process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-process-"));
    cleanupPaths.push(root);
    const running = startLineProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: buildSafeEnv(),
      timeoutMs: 10_000,
      eventsPath: join(root, "events.ndjson"),
      onStdoutLine() {},
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await running.cancel();
    const outcome = await running.completion;
    expect(outcome.code !== null || outcome.signal !== null).toBe(true);
  });

  it("terminates supervised providers when their mesh owner disappears", async () => {
    const supervisor = join(process.cwd(), "bin", "supervise.mjs");
    const child = spawn(process.execPath, [supervisor], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...buildSafeEnv(),
        AGENT_MESH_OWNER_PID: "2147483646",
        AGENT_MESH_SUPERVISED_PROCESS: JSON.stringify({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        }),
      },
    });
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("supervisor did not stop orphaned provider")),
          5_000,
        );
        timer.unref();
      }),
    ]);
    expect(result.code !== null || result.signal !== null).toBe(true);
  });

  it("fails explicitly instead of splitting oversized provider JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-process-overflow-"));
    cleanupPaths.push(root);
    process.env.AGENT_MESH_MAX_PROVIDER_LINE_BYTES = "256";
    const running = startLineProcess({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({result:'x'.repeat(2000)}))"],
      cwd: root,
      env: buildSafeEnv(),
      timeoutMs: 10_000,
      eventsPath: join(root, "events.ndjson"),
      onStdoutLine() {},
    });
    await expect(running.completion).rejects.toThrow(/larger than the configured limit/);
  });
});

describe("worktree isolation", () => {
  it("runs live implementation in a dirty canonical checkout and captures a HEAD-bounded snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-live-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-live-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], {
      cwd: root,
    });
    await writeFile(join(root, "sample.txt"), "before\n");
    await execFileAsync("git", ["add", "sample.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    await writeFile(join(root, "sample.txt"), "already dirty\n");

    const prompts: string[] = [];
    const adapter: ProviderAdapter = {
      provider: "codex",
      capabilities: () => ({
        provider: "codex",
        dynamicModelDiscovery: false,
        resume: true,
        fork: true,
        nativeSessionSearch: false,
        nativeCancellation: false,
        notes: [],
      }),
      listModels: async () => [],
      run: async (request, hooks) => {
        prompts.push(request.prompt);
        hooks.onStarted({ cancel: async () => undefined });
        hooks.onSession(`live-session-${prompts.length}`);
        if (request.mode === "implement") {
          await writeFile(join(request.cwd, "live.txt"), "written live\n");
        }
        return {
          output: "done",
          sessionId: `live-session-${prompts.length}`,
        };
      },
    };
    const router = new AgentMeshRouter(
      "cursor",
      new TaskRegistry(join(state, "mesh.db")),
      [adapter],
    );
    const completed = await router.start(
      {
        provider: "codex",
        prompt: "Implement directly.",
        description: "live implementation",
        cwd: root,
        mode: "implement",
        mcpProfile: "none",
        isolation: "auto",
        workspace: "live",
        timeoutMs: 30_000,
      },
      { background: false },
    );
    const canonicalRoot = await realpath(root);
    expect(completed.task).toMatchObject({
      status: "completed",
      effectiveCwd: canonicalRoot,
      repoRoot: canonicalRoot,
      worktreePath: null,
      baseCommit: head,
    });
    expect(String(completed.task.artifactStatus)).toBe("live_snapshot");
    expect(await readFile(join(root, "live.txt"), "utf8")).toBe("written live\n");
    const snapshotPath = completed.task.patchPath!;
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
      kind: string;
      beforeHead: string;
      afterHead: string;
      changedFiles: string[];
      diff: string;
    };
    expect(snapshot).toMatchObject({
      kind: "live_diff_snapshot",
      beforeHead: head,
      afterHead: head,
    });
    expect(snapshot.changedFiles).toEqual(
      expect.arrayContaining(["live.txt", "sample.txt"]),
    );
    expect(snapshot.diff).toContain("written live");
    expect(prompts[0]).toMatch(/^## Mandatory write synchronization/);

    await router.start(
      {
        provider: "codex",
        prompt: "Research only.",
        description: "read only",
        cwd: root,
        mode: "research",
        mcpProfile: "none",
        isolation: "none",
        timeoutMs: 30_000,
      },
      { background: false },
    );
    expect(prompts[1]).not.toContain("Mandatory write synchronization");
    await router.close();
  });

  it("refuses to promote a live diff snapshot as a patch", () => {
    expect(() =>
      assertTaskPatchPromotable({
        artifactStatus: "live_snapshot",
      } as unknown as TaskRecord),
    ).toThrow(/live-workspace diff snapshots.*cannot be promoted/i);
  });

  // MESH[2026-07-25T20:50Z][agent:codex][direction:user/2]
  // What: proves tracked, untracked, ignored, binary, mode, and source-integrity behavior for carried baselines.
  // Why: the safe round trip depends on importing the human's exact visible state without exporting it as child work.
  // Aligns-with: direction user revision 2 (dirty-source delegation and child-only artifact capture).
  // Status: complete
  it("carries the visible source state without mutating it and captures only child changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-dirty-worktree-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-dirty-worktree-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], {
      cwd: root,
    });
    await writeFile(join(root, ".gitignore"), "ignored.bin\n");
    await writeFile(join(root, "modified.txt"), "before\n");
    await writeFile(join(root, "deleted.txt"), "delete me\n");
    await writeFile(join(root, "rename-from.txt"), "rename me\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const originalHead = (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      })
    ).stdout.trim();

    await writeFile(join(root, "modified.txt"), "human change\n");
    await chmod(join(root, "modified.txt"), 0o755);
    await writeFile(join(root, "added.txt"), "human addition\n");
    await execFileAsync("git", ["add", "added.txt"], { cwd: root });
    await rm(join(root, "deleted.txt"));
    await execFileAsync("git", ["mv", "rename-from.txt", "rename-to.txt"], {
      cwd: root,
    });
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 128, 64]));
    await writeFile(
      join(root, "untracked.bin"),
      Buffer.from([255, 0, 254, 1]),
    );
    await writeFile(join(root, "ignored.bin"), "never delegate this\n");
    const statusBefore = (
      await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { cwd: root },
      )
    ).stdout;

    const taskId = randomUUID();
    const prepared = await prepareWorktree(root, taskId);
    const statusAfter = (
      await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { cwd: root },
      )
    ).stdout;
    expect(Buffer.from(statusAfter)).toEqual(Buffer.from(statusBefore));
    expect(prepared.baseCommit).not.toBe(originalHead);
    expect(
      (
        await execFileAsync("git", ["status", "--porcelain=v1"], {
          cwd: prepared.worktreePath,
          encoding: "utf8",
        })
      ).stdout,
    ).toBe("");
    await expect(
      readFile(join(prepared.worktreePath, "deleted.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(prepared.worktreePath, "modified.txt"), "utf8"),
    ).toBe("human change\n");
    expect(
      await readFile(join(prepared.worktreePath, "added.txt"), "utf8"),
    ).toBe("human addition\n");
    expect(
      await readFile(join(prepared.worktreePath, "rename-to.txt"), "utf8"),
    ).toBe("rename me\n");
    await expect(
      readFile(join(prepared.worktreePath, "rename-from.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(prepared.worktreePath, "binary.bin")),
    ).toEqual(Buffer.from([0, 255, 128, 64]));
    expect(
      await readFile(join(prepared.worktreePath, "untracked.bin")),
    ).toEqual(Buffer.from([255, 0, 254, 1]));
    await expect(
      access(join(prepared.worktreePath, "ignored.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await execFileAsync(
          "git",
          ["ls-tree", "HEAD", "modified.txt"],
          { cwd: prepared.worktreePath, encoding: "utf8" },
        )
      ).stdout,
    ).toMatch(process.platform === "win32" ? /^100644 blob / : /^100755 blob /);

    await writeFile(
      join(prepared.worktreePath, "modified.txt"),
      "child change\n",
    );
    await writeFile(join(prepared.worktreePath, "child-only.txt"), "child\n");
    const taskDir = join(state, "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    const artifacts = await collectWorktreeArtifacts(
      prepared.worktreePath,
      prepared.baseCommit,
      taskDir,
    );
    const patch = await readFile(artifacts.patchPath!, "utf8");
    expect(artifacts.changedFiles.sort()).toEqual([
      "child-only.txt",
      "modified.txt",
    ]);
    expect(patch).toContain("-human change");
    expect(patch).toContain("+child change");
    expect(patch).not.toContain("+human change");
    expect(patch).not.toContain("added.txt");
    expect(patch).not.toContain("deleted.txt");
    expect(patch).not.toContain("rename-from.txt");
    expect(patch).not.toContain("rename-to.txt");
    expect(patch).not.toContain("binary.bin");
    expect(patch).not.toContain("untracked.bin");

    await cleanupWorktree(prepared.repoRoot, prepared.worktreePath);
  });

  it("names the path that exceeds the carried-state size bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-carry-limit-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-carry-limit-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], {
      cwd: root,
    });
    await writeFile(join(root, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
    await writeFile(join(root, "too-large.bin"), Buffer.alloc(9, 0x5a));

    await expect(
      prepareWorktree(root, randomUUID(), "HEAD", { maxCarriedBytes: 8 }),
    ).rejects.toThrow(/8 bytes.*too-large\.bin/);
  });

  it("reclaims a waiting task after a second owner death and settles dead artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-reclaim-"));
    cleanupPaths.push(root);
    const path = join(root, "mesh.db");
    const registry = new TaskRegistry(path);
    const now = new Date().toISOString();
    const taskId = randomUUID();
    const strandedId = randomUUID();
    const record = {
      origin: "cursor" as const,
      provider: "codex" as const,
      description: "reclaim after two owner deaths",
      mode: "ask" as const,
      status: "running" as const,
      cwd: root,
      effectiveCwd: root,
      repoRoot: null,
      worktreePath: null,
      baseCommit: null,
      model: null,
      effort: null,
      mcpProfile: "none" as const,
      parentTaskId: null,
      ownerPid: process.pid,
      pid: null,
      resultPath: null,
      eventsPath: null,
      transcriptPath: null,
      pendingQuestionId: null,
      patchPath: null,
      changedFiles: [],
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    registry.insert({
      ...record,
      id: taskId,
      sessionId: "reclaim-session",
      artifactStatus: "not_applicable",
    });
    const native = registry.createNativeQuestionAndWait({
      taskId,
      origin: "cursor",
      provider: "codex",
      sessionId: "reclaim-session",
      nativeRequestId: "request-1:approach",
      question: "Which approach?",
      options: ["A", "B"],
    });
    // A task killed mid-capture keeps claiming capture is in progress forever.
    registry.insert({
      ...record,
      id: strandedId,
      sessionId: "stranded-session",
      artifactStatus: "pending",
    });
    registry.update(taskId, { ownerPid: 2_147_483_646 });
    registry.update(strandedId, { ownerPid: 2_147_483_646 });
    registry.close();

    // First recovery converts native delivery to resume and claims the task.
    const firstRecovery = new TaskRegistry(path);
    expect(firstRecovery.requireQuestion(native.question.id).delivery).toBe(
      "resume",
    );
    expect(firstRecovery.require(taskId).ownerPid).toBe(process.pid);
    // That owner then dies too, which previously stranded the task forever.
    firstRecovery.update(taskId, { ownerPid: 2_147_483_646 });
    firstRecovery.close();

    const secondRecovery = new TaskRegistry(path);
    expect(secondRecovery.require(taskId)).toMatchObject({
      status: "waiting_for_input",
      ownerPid: process.pid,
    });
    expect(secondRecovery.require(strandedId)).toMatchObject({
      status: "interrupted",
      artifactStatus: "failed",
    });
    secondRecovery.close();
  });

  it("reports finished mesh tasks to the parent exactly once", async () => {
    const state = await mkdtemp(join(tmpdir(), "mesh-stop-hook-"));
    cleanupPaths.push(state);
    process.env.AGENT_MESH_STATE_DIR = state;
    const meshPath = join(state, "mesh.db");
    const db = new DatabaseSync(meshPath);
    db.exec(
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY, origin TEXT, provider TEXT, description TEXT,
         status TEXT, error TEXT, updated_at TEXT, completed_at TEXT,
         cwd TEXT, repo_root TEXT
       );`,
    );

    // No watermark yet: establish a baseline instead of replaying history.
    expect(runStopHook({ conversation_id: "c1" }, { meshPath, workspaceRoots: [] }).reason).toBe(
      "baseline-recorded",
    );
    expect(runStopHook({ conversation_id: "c1" }, { meshPath, workspaceRoots: [] }).reason).toBe(
      "nothing-new",
    );

    const finishedAt = new Date(Date.now() + 1_000).toISOString();
    db.prepare(
      "INSERT INTO tasks VALUES (?, 'cursor', 'codex', 'deep review', 'completed', NULL, ?, ?, '/repo/a', '/repo/a')",
    ).run("11111111-2222-4333-8444-555555555555", finishedAt, finishedAt);
    db.prepare(
      "INSERT INTO tasks VALUES (?, 'cursor', 'grok', 'probe', 'failed', 'sk-live-secret-value', ?, ?, '/repo/a', '/repo/a')",
    ).run("66666666-7777-4888-8999-000000000000", finishedAt, finishedAt);

    const reported = runStopHook(
      { conversation_id: "c1" },
      { meshPath, workspaceRoots: [] },
    );
    expect(reported.reason).toBe("reported");
    expect(reported.followupMessage).toContain("11111111");
    expect(reported.followupMessage).toContain("66666666");
    expect(reported.followupMessage).not.toContain("sk-live-secret-value");

    // The same completions must never be replayed on the next turn.
    expect(runStopHook({ conversation_id: "c1" }, { meshPath, workspaceRoots: [] }).reason).toBe(
      "nothing-new",
    );

    // Another repository's work must never interrupt this conversation, and must
    // not be replayed here later either.
    const otherRepoAt = new Date(Date.now() + 1_500).toISOString();
    db.prepare(
      "INSERT INTO tasks VALUES (?, 'cursor', 'codex', 'unrelated repo', 'completed', NULL, ?, ?, '/repo/b', '/repo/b')",
    ).run("cccccccc-dddd-4eee-8fff-111111111111", otherRepoAt, otherRepoAt);
    expect(
      runStopHook(
        { conversation_id: "c1", workspace_roots: ["/repo/a"] },
        { meshPath },
      ).reason,
    ).toBe("nothing-new");
    expect(
      runStopHook(
        { conversation_id: "c1", workspace_roots: ["/repo/b"] },
        { meshPath },
      ).reason,
    ).toBe("nothing-new");

    // A runaway follow-up loop is bounded even when news exists.
    const later = new Date(Date.now() + 2_000).toISOString();
    db.prepare(
      "INSERT INTO tasks VALUES (?, 'cursor', 'claude', 'later', 'completed', NULL, ?, ?, '/repo/a', '/repo/a')",
    ).run("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", later, later);
    expect(
      runStopHook({ conversation_id: "c1", loop_count: 9 }, { meshPath, workspaceRoots: [] }).reason,
    ).toBe("loop-budget-exhausted");

    db.close();
    expect(runStopHook({ conversation_id: "c2" }, { meshPath: join(state, "absent.db") }).reason).toBe(
      "no-mesh-state",
    );
  });

  it("reports base drift without ever merging the checkout", async () => {
    const remote = await mkdtemp(join(tmpdir(), "mesh-remote-"));
    const root = await mkdtemp(join(tmpdir(), "mesh-fresh-"));
    cleanupPaths.push(remote, root);
    await execFileAsync("git", ["init", "-q", "--bare"], { cwd: remote });
    await execFileAsync("git", ["clone", "-q", remote, root]);
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], {
      cwd: root,
    });
    await writeFile(join(root, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
    await execFileAsync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: root });

    // A second clone advances the remote behind this checkout's back.
    const other = await mkdtemp(join(tmpdir(), "mesh-other-"));
    cleanupPaths.push(other);
    await execFileAsync("git", ["clone", "-q", remote, other]);
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], {
      cwd: other,
    });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], {
      cwd: other,
    });
    await writeFile(join(other, "remote-only.txt"), "remote\n");
    await execFileAsync("git", ["add", "remote-only.txt"], { cwd: other });
    await execFileAsync("git", ["commit", "-qm", "remote work"], { cwd: other });
    await execFileAsync("git", ["push", "-q"], { cwd: other });

    const headBefore = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    const freshness = await inspectBaseFreshness(root, "HEAD");

    expect(freshness.behind).toBe(1);
    expect(freshness.summary).toMatch(/behind/i);
    // Fetching must never move HEAD, touch the work tree, or create the file.
    expect(
      (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
    ).toBe(headBefore);
    expect(
      (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: root })).stdout,
    ).toBe("");
    await expect(access(join(root, "remote-only.txt"))).rejects.toThrow();
  });

  it("ignores dependency output and names the offender when capture is too large", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-capture-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-capture-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], {
      cwd: root,
    });
    await writeFile(join(root, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });

    const taskId = randomUUID();
    const prepared = await prepareWorktree(root, taskId);
    // Exactly the shape that destroyed a real lane: a package cache written
    // beside a small, legitimate source change.
    await mkdir(join(prepared.worktreePath, ".npm-cache", "index-v5"), {
      recursive: true,
    });
    await writeFile(
      join(prepared.worktreePath, ".npm-cache", "index-v5", "blob.bin"),
      Buffer.alloc(512 * 1024, 0x7a),
    );
    await writeFile(join(prepared.worktreePath, "authored.txt"), "real work\n");
    const taskDir = join(state, "tasks", taskId);
    await mkdir(taskDir, { recursive: true });

    const artifacts = await collectWorktreeArtifacts(
      prepared.worktreePath,
      prepared.baseCommit,
      taskDir,
    );
    expect(artifacts.changedFiles).toContain("authored.txt");
    expect(
      artifacts.changedFiles.some((path) => path.startsWith(".npm-cache/")),
    ).toBe(false);

    // When a genuine capture is still too large, the error must name what caused it.
    process.env.AGENT_MESH_MAX_PATCH_BYTES = "256";
    try {
      await writeFile(
        join(prepared.worktreePath, "huge-authored.txt"),
        "x".repeat(4096),
      );
      await expect(
        collectWorktreeArtifacts(
          prepared.worktreePath,
          prepared.baseCommit,
          taskDir,
        ),
      ).rejects.toThrow(/huge-authored\.txt/);
    } finally {
      delete process.env.AGENT_MESH_MAX_PATCH_BYTES;
    }

    await cleanupWorktree(prepared.repoRoot, prepared.worktreePath);
  });

  it("captures a patch without changing the source checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-git-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], { cwd: root });
    await writeFile(join(root, "sample.txt"), "before\n");
    await execFileAsync("git", ["add", "sample.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: root });
    const sourceHead = (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      })
    ).stdout.trim();
    const hookMarker = join(root, "hook-ran");
    const hookPath = join(root, ".git", "hooks", "post-checkout");
    await writeFile(hookPath, `#!/bin/sh\nprintf hook > '${hookMarker}'\n`);
    await chmod(hookPath, 0o755);

    const taskId = randomUUID();
    const prepared = await prepareWorktree(root, taskId);
    expect(prepared.baseCommit).toBe(sourceHead);
    await expect(access(hookMarker)).rejects.toThrow();
    await writeFile(join(prepared.worktreePath, "sample.txt"), "after\n");
    await execFileAsync("git", ["add", "sample.txt"], { cwd: prepared.worktreePath });
    await execFileAsync("git", ["commit", "-qm", "agent commit"], {
      cwd: prepared.worktreePath,
    });
    const taskDir = join(state, "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    const artifacts = await collectWorktreeArtifacts(
      prepared.worktreePath,
      prepared.baseCommit,
      taskDir,
    );

    expect(artifacts.changedFiles).toContain("sample.txt");
    expect(await readFile(join(root, "sample.txt"), "utf8")).toBe("before\n");
    expect(await readFile(artifacts.patchPath!, "utf8")).toContain("+after");
    await writeFile(join(prepared.worktreePath, "sample.txt"), "late mutation\n");
    await expect(
      verifyWorktreeArtifacts(
        prepared.worktreePath,
        prepared.baseCommit,
        "captured",
        artifacts.patchPath!,
      ),
    ).rejects.toThrow(/changed after/);
    await writeFile(join(prepared.worktreePath, "sample.txt"), "after\n");

    await cleanupWorktree(prepared.repoRoot, prepared.worktreePath);
    await expect(access(prepared.worktreePath)).rejects.toThrow();
  });

  it("rejects executable Git configuration reached through includes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-git-config-"));
    const state = await mkdtemp(join(tmpdir(), "mesh-git-config-state-"));
    cleanupPaths.push(root, state);
    process.env.AGENT_MESH_ALLOWED_ROOTS = root;
    process.env.AGENT_MESH_STATE_DIR = state;
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], { cwd: root });
    await writeFile(join(root, "base.txt"), "base\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
    const included = join(root, "dangerous.gitconfig");
    await writeFile(included, '[filter "danger"]\n\tprocess = /bin/false\n');
    await execFileAsync("git", ["config", "--local", "include.path", included], { cwd: root });

    await expect(prepareWorktree(root, randomUUID())).rejects.toThrow(
      /executable Git configuration/,
    );
  });
});

interface MeshPromotionFixture {
  root: string;
  targetRepo: string;
  artifactsDirectory: string;
  tasks: Map<string, TaskRecord>;
  service: PatchPromotionService;
}

async function createMeshPromotionFixture(): Promise<MeshPromotionFixture> {
  const root = await mkdtemp(join(tmpdir(), "mesh-path-promotion-"));
  cleanupPaths.push(root);
  const targetRepo = join(root, "target");
  const artifactsDirectory = join(root, "state", "tasks");
  const storeDirectory = join(root, "state", "promotions");
  await mkdir(targetRepo, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: targetRepo });
  await execFileAsync("git", ["config", "user.email", "mesh@example.invalid"], {
    cwd: targetRepo,
  });
  await execFileAsync("git", ["config", "user.name", "Agent Mesh Tests"], {
    cwd: targetRepo,
  });
  await writeFile(join(targetRepo, "a.txt"), "a before\n");
  await writeFile(join(targetRepo, "b.txt"), "b before\n");
  await writeFile(join(targetRepo, "unrelated.txt"), "unrelated before\n");
  await execFileAsync("git", ["add", "."], { cwd: targetRepo });
  await execFileAsync("git", ["commit", "-qm", "baseline"], {
    cwd: targetRepo,
  });
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  await chmod(join(root, "state"), 0o700);
  await chmod(artifactsDirectory, 0o700);
  const tasks = new Map<string, TaskRecord>();
  const service = new PatchPromotionService({
    origin: "cursor",
    taskLookup: tasks,
    artifactsDirectory,
    storeDirectory,
    allowedRoots: [root],
  });
  return { root, targetRepo, artifactsDirectory, tasks, service };
}

async function addMeshPromotionTask(
  fixture: MeshPromotionFixture,
  path: string,
  contents: string,
): Promise<TaskRecord> {
  const taskId = `task-${randomUUID()}`;
  const delegatedRepo = join(fixture.root, `delegated-${taskId}`);
  await execFileAsync("git", ["clone", "-q", fixture.targetRepo, delegatedRepo], {
    cwd: fixture.root,
  });
  const baseCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: delegatedRepo,
      encoding: "utf8",
    })
  ).stdout.trim();
  await writeFile(join(delegatedRepo, path), contents);
  const patch = (
    await execFileAsync(
      "git",
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        baseCommit,
        "--",
      ],
      { cwd: delegatedRepo, encoding: "utf8" },
    )
  ).stdout;
  const taskDirectory = join(fixture.artifactsDirectory, taskId);
  const patchPath = join(taskDirectory, "changes.patch");
  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  await writeFile(patchPath, patch, { mode: 0o600 });
  await chmod(taskDirectory, 0o700);
  await chmod(patchPath, 0o600);
  const completedAt = new Date(Date.now() + 1_000).toISOString();
  const task = {
    id: taskId,
    origin: "cursor",
    provider: "codex",
    description: `change ${path}`,
    mode: "implement",
    status: "completed",
    cwd: fixture.targetRepo,
    effectiveCwd: delegatedRepo,
    repoRoot: fixture.targetRepo,
    worktreePath: null,
    baseCommit,
    model: null,
    effort: null,
    mcpProfile: "none",
    sessionId: null,
    parentTaskId: null,
    ownerPid: process.pid,
    pid: null,
    resultPath: null,
    eventsPath: null,
    transcriptPath: null,
    pendingQuestionId: null,
    patchPath,
    changedFiles: [path],
    artifactStatus: "captured",
    error: null,
    createdAt: completedAt,
    updatedAt: completedAt,
    completedAt,
  } as TaskRecord;
  fixture.tasks.set(task.id, task);
  return task;
}

// MESH[2026-07-25T20:50Z][agent:codex][direction:user/2]
// What: covers path-precise promotion, disjoint dirt, committed reconciliation, and terminal rollback refusal.
// Why: repository-wide HEAD and cleanliness checks hid the actual conflict boundary and left successful records active forever.
// Aligns-with: direction user revision 2 (real-working-tree promotion lifecycle).
// Status: complete
describe("path-precise patch promotion", () => {
  it("applies after HEAD moves when affected pre-images still match", async () => {
    const fixture = await createMeshPromotionFixture();
    const task = await addMeshPromotionTask(fixture, "a.txt", "a after\n");
    await writeFile(
      join(fixture.targetRepo, "unrelated.txt"),
      "unrelated committed\n",
    );
    await execFileAsync("git", ["add", "unrelated.txt"], {
      cwd: fixture.targetRepo,
    });
    await execFileAsync("git", ["commit", "-qm", "move head"], {
      cwd: fixture.targetRepo,
    });

    await expect(
      fixture.service.apply({
        taskId: task.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${task.id}`,
      }),
    ).resolves.toMatchObject({ state: "applied" });
    expect(await readFile(join(fixture.targetRepo, "a.txt"), "utf8")).toBe(
      "a after\n",
    );
  });

  it("names drifted or dirty affected paths but permits disjoint dirt", async () => {
    const drifted = await createMeshPromotionFixture();
    const driftTask = await addMeshPromotionTask(
      drifted,
      "a.txt",
      "a after\n",
    );
    await writeFile(join(drifted.targetRepo, "a.txt"), "a drifted\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: drifted.targetRepo });
    await execFileAsync("git", ["commit", "-qm", "drift a"], {
      cwd: drifted.targetRepo,
    });
    await expect(
      drifted.service.preview({
        taskId: driftTask.id,
        targetRepo: drifted.targetRepo,
      }),
    ).rejects.toThrow(/pre-image: a\.txt/);

    const intersecting = await createMeshPromotionFixture();
    const intersectingTask = await addMeshPromotionTask(
      intersecting,
      "a.txt",
      "a after\n",
    );
    await writeFile(join(intersecting.targetRepo, "a.txt"), "human dirty\n");
    await expect(
      intersecting.service.preview({
        taskId: intersectingTask.id,
        targetRepo: intersecting.targetRepo,
      }),
    ).rejects.toThrow(/dirty affected paths: a\.txt/);

    const disjoint = await createMeshPromotionFixture();
    const disjointTask = await addMeshPromotionTask(
      disjoint,
      "a.txt",
      "a after\n",
    );
    await writeFile(join(disjoint.targetRepo, "human-notes.txt"), "keep me\n");
    await expect(
      disjoint.service.apply({
        taskId: disjointTask.id,
        targetRepo: disjoint.targetRepo,
        confirmation: `APPLY ${disjointTask.id}`,
      }),
    ).resolves.toMatchObject({ state: "applied" });
    expect(
      await readFile(join(disjoint.targetRepo, "human-notes.txt"), "utf8"),
    ).toBe("keep me\n");
  }, 15000);

  it("reconciles committed promotions so later work proceeds and rollback refuses", async () => {
    const fixture = await createMeshPromotionFixture();
    const firstTask = await addMeshPromotionTask(
      fixture,
      "a.txt",
      "a after\n",
    );
    const first = await fixture.service.apply({
      taskId: firstTask.id,
      targetRepo: fixture.targetRepo,
      confirmation: `APPLY ${firstTask.id}`,
    });
    await execFileAsync("git", ["add", "a.txt"], { cwd: fixture.targetRepo });
    await execFileAsync("git", ["commit", "-qm", "commit promotion"], {
      cwd: fixture.targetRepo,
    });

    const secondTask = await addMeshPromotionTask(
      fixture,
      "b.txt",
      "b after\n",
    );
    await expect(
      fixture.service.preview({
        taskId: secondTask.id,
        targetRepo: fixture.targetRepo,
      }),
    ).resolves.toMatchObject({ activePromotionId: null });
    expect(
      (await fixture.service.listPromotions()).find(
        (record) => record.id === first.id,
      ),
    ).toMatchObject({
      state: "committed",
      rollbackState: "not_available",
    });
    await expect(
      fixture.service.apply({
        taskId: secondTask.id,
        targetRepo: fixture.targetRepo,
        confirmation: `APPLY ${secondTask.id}`,
      }),
    ).resolves.toMatchObject({ state: "applied" });
    await expect(
      fixture.service.rollback({
        promotionId: first.id,
        confirmation: `ROLLBACK ${first.id}`,
      }),
    ).rejects.toThrow(/committed in target history.*cannot be rolled back/i);
  });
});
