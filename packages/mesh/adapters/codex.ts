import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { lstat, open, readFile, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import { supervisedInvocation } from "../process.js";
import {
  buildSafeEnv,
  ensurePrivateDirectory,
  redactSecrets,
  resolveTrustedProviderExecutable,
  stateDirectory,
  summarizeEventForLog,
} from "../security.js";
import { buildCodexMcpProfile } from "../mcp-profiles.js";
import { normalizeCodexUserInputQuestions } from "../interactions.js";
import type {
  NativeSession,
  NativeProviderQuestion,
  NativeQuestionResolution,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderModel,
  ProviderResult,
  ProviderRunHooks,
  ProviderRunRequest,
} from "../types.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TurnWaiter {
  resolve: (turn: JsonObject) => void;
  reject: (error: Error) => void;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

function codexEffort(effort: string | undefined): string | undefined {
  return effort === "ultra" ? "xhigh" : effort;
}

function splitJsonLines(onMessage: (message: JsonObject) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line) as JsonObject);
      } catch (error) {
        console.error(`[agent-mesh/codex] invalid JSON: ${redactSecrets(String(error))}`);
      }
    }
  };
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function isolatedCodexEnvironment(): Promise<NodeJS.ProcessEnv> {
  const codexHome = join(stateDirectory(), "codex-home");
  const runtimeHome = join(stateDirectory(), "provider-homes", "codex");
  await ensurePrivateDirectory(codexHome);
  await ensurePrivateDirectory(runtimeHome);
  let modelConfig = "";
  try {
    const sourceConfig = await readFile(join(homedir(), ".codex", "config.toml"), "utf8");
    modelConfig = sourceConfig
      .split("\n")
      .filter((line) => /^(model|model_reasoning_effort)\s*=/.test(line))
      .join("\n");
  } catch {
    // Codex will use its built-in account defaults.
  }
  // Toolchain + research-MCP allowances stay narrow: keep :root denied, but
  // permit Homebrew/nvm Node reads, temp dirs for npm caches, and outbound
  // network for npm registry + Context7/Perplexity. Secrets stay out of the
  // worktree via **/*.env deny and excluded credential-bearing env vars.
  const home = homedir();
  const config = `
${modelConfig}
mcp_servers = {}
default_permissions = "mesh-read"

[features]
apps = false
enable_mcp_apps = false
plugins = false
remote_plugin = false
plugin_sharing = false
hooks = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
computer_use = false
image_generation = false
in_app_browser = false
tool_suggest = false
workspace_dependencies = true

[permissions.mesh-read.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "read"
":slash_tmp" = "read"
"/opt/homebrew" = "read"
"/opt/homebrew/**" = "read"
"${home}/.nvm" = "read"
"${home}/.nvm/**" = "read"
"${home}/.local/bin" = "read"
"${home}/.local/bin/**" = "read"

[permissions.mesh-read.filesystem.":workspace_roots"]
"." = "read"
"**/*.env" = "deny"

[permissions.mesh-read.network]
enabled = true

[permissions.mesh-read.shell_environment_policy]
exclude = ["HOME", "CODEX_HOME", "SSH_AUTH_SOCK"]

[permissions.mesh-write.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "write"
":slash_tmp" = "write"
"/opt/homebrew" = "read"
"/opt/homebrew/**" = "read"
"${home}/.nvm" = "read"
"${home}/.nvm/**" = "read"
"${home}/.local/bin" = "read"
"${home}/.local/bin/**" = "read"

[permissions.mesh-write.filesystem.":workspace_roots"]
"." = "write"
"**/*.env" = "deny"

[permissions.mesh-write.network]
enabled = true

[permissions.mesh-write.shell_environment_policy]
exclude = ["HOME", "CODEX_HOME", "SSH_AUTH_SOCK"]
`.trimStart();
  await writePrivateFile(join(codexHome, "config.toml"), config);

  const sourceAuth = join(homedir(), ".codex", "auth.json");
  const isolatedAuth = join(codexHome, "auth.json");
  try {
    const info = await lstat(isolatedAuth);
    if (!info.isSymbolicLink() || (await readlink(isolatedAuth)) !== sourceAuth) {
      throw new Error("Isolated Codex auth path exists but is not the expected symlink.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await symlink(sourceAuth, isolatedAuth);
  }
  return buildSafeEnv({
    CODEX_HOME: codexHome,
    HOME: runtimeHome,
  });
}

class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly completedTurns = new Map<string, JsonObject>();
  private readonly messagesByThread = new Map<string, string[]>();
  private readonly eventHooksByThread = new Map<string, (event: unknown) => void>();
  private readonly questionHooksByThread = new Map<
    string,
    (question: NativeProviderQuestion) => Promise<NativeQuestionResolution>
  >();
  private readonly questionTimeoutsByThread = new Map<string, number>();
  private startPromise?: Promise<void>;
  private closingPromise?: Promise<void>;

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    if (this.closingPromise) await this.closingPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const env = await isolatedCodexEnvironment();
    const binary = await resolveTrustedProviderExecutable("codex");
    const invocation = supervisedInvocation(
      binary,
      ["app-server", "--listen", "stdio://"],
      env,
    );
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    });
    this.child = child;
    child.stdout.on("data", splitJsonLines((message) => this.handleMessage(message)));
    child.stderr.on("data", (chunk) => {
      const text = redactSecrets(chunk.toString()).trim();
      if (text) console.error(`[agent-mesh/codex] ${text}`);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.failAll(
        new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)})`),
      );
      this.child = undefined;
      this.startPromise = undefined;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "agent-mesh-mcp",
        title: "Agent Mesh MCP",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = undefined;
      this.startPromise = undefined;
      return;
    }
    this.closingPromise = new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 30_000);
      forceTimer.unref();
      child.once("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.kill("SIGTERM");
    }).finally(() => {
      if (this.child === child) this.child = undefined;
      this.startPromise = undefined;
      this.closingPromise = undefined;
    });
    return this.closingPromise;
  }

  async request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.closingPromise) await this.closingPromise;
    if (!this.child && method !== "initialize") await this.start();
    const child = this.child;
    if (!child) throw new Error("Codex app-server is unavailable.");
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.close()
          .then(() => reject(new Error(`Codex app-server request timed out: ${method}`)))
          .catch(reject);
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: JsonObject): void {
    if (!this.child) throw new Error("Codex app-server is unavailable.");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  watchThread(
    threadId: string,
    eventHook: (event: unknown) => void,
    questionHook: (question: NativeProviderQuestion) => Promise<NativeQuestionResolution>,
    questionTimeoutMs: number,
  ): void {
    this.eventHooksByThread.set(threadId, eventHook);
    this.questionHooksByThread.set(threadId, questionHook);
    this.questionTimeoutsByThread.set(threadId, questionTimeoutMs);
    this.messagesByThread.set(threadId, []);
  }

  unwatchThread(threadId: string): void {
    this.eventHooksByThread.delete(threadId);
    this.questionHooksByThread.delete(threadId);
    this.questionTimeoutsByThread.delete(threadId);
  }

  async waitForTurn(threadId: string, turnId: string, timeoutMs: number): Promise<JsonObject> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return completed;
    }
    return new Promise<JsonObject>((resolve, reject) => {
      let forceTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        void this.request("turn/interrupt", { threadId, turnId }, 10_000)
          .then(() => {
            forceTimer = setTimeout(() => {
              if (!this.turnWaiters.has(turnId)) return;
              this.turnWaiters.delete(turnId);
              void this.close()
                .then(() =>
                  reject(new Error(`Codex turn did not stop after timeout and interrupt.`)),
                )
                .catch(reject);
            }, 15_000);
            forceTimer.unref();
          })
          .catch((error) => {
            this.turnWaiters.delete(turnId);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      }, timeoutMs);
      timer.unref();
      this.turnWaiters.set(turnId, {
        resolve(turn) {
          clearTimeout(timer);
          if (forceTimer) clearTimeout(forceTimer);
          resolve(turn);
        },
        reject(error) {
          clearTimeout(timer);
          if (forceTimer) clearTimeout(forceTimer);
          reject(error);
        },
      });
    });
  }

  outputFor(threadId: string, turn: JsonObject): string {
    const items = Array.isArray(turn.items) ? turn.items.map(object) : [];
    const finalMessages = items.filter(
      (item) => item.type === "agentMessage" && item.phase === "final_answer",
    );
    const messages = (finalMessages.length ? finalMessages : items)
      .filter((item) => item.type === "agentMessage" && typeof item.text === "string")
      .map((item) => String(item.text));
    if (messages.length) return messages.at(-1)!;
    return this.messagesByThread.get(threadId)?.at(-1) ?? "";
  }

  private handleMessage(message: JsonObject): void {
    const params = object(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId) this.eventHooksByThread.get(threadId)?.(message);

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(object(message.result));
      }
      return;
    }

    if (typeof message.id === "number" && typeof message.method === "string") {
      if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval"
      ) {
        this.child?.stdin.write(
          `${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`,
        );
      } else if (message.method === "item/permissions/requestApproval") {
        this.child?.stdin.write(
          `${JSON.stringify({
            id: message.id,
            result: { permissions: {}, scope: "turn", strictAutoReview: false },
          })}\n`,
        );
      } else if (message.method === "item/tool/requestUserInput") {
        void this.handleUserInputRequest(message);
      } else if (message.method === "mcpServer/elicitation/request") {
        this.child?.stdin.write(
          `${JSON.stringify({
            id: message.id,
            result: { action: "decline", content: null },
          })}\n`,
        );
      } else {
        this.child?.stdin.write(
          `${JSON.stringify({
            id: message.id,
            error: { code: -32601, message: `Unsupported server request: ${message.method}` },
          })}\n`,
        );
      }
      return;
    }

    if (message.method === "item/completed" && threadId) {
      const item = object(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        this.messagesByThread.get(threadId)?.push(item.text);
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turn = object(params.turn);
      const turnId = typeof turn.id === "string" ? turn.id : "";
      const waiter = this.turnWaiters.get(turnId);
      if (waiter) {
        this.turnWaiters.delete(turnId);
        waiter.resolve(turn);
      } else if (turnId) {
        this.completedTurns.set(turnId, turn);
      }
    }
  }

  private async handleUserInputRequest(message: JsonObject): Promise<void> {
    const id = message.id;
    if (typeof id !== "number") return;
    const params = object(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const hook = this.questionHooksByThread.get(threadId);
    const resolutions: NativeQuestionResolution[] = [];
    const deliveredResolutions = new Set<NativeQuestionResolution>();
    const priorAnswers: string[] = [];
    let responded = false;
    try {
      if (!threadId || !hook) {
        throw new Error("Codex user-input request has no active mesh task.");
      }
      const questions = normalizeCodexUserInputQuestions(params.questions);
      const timeoutMs = this.questionTimeoutsByThread.get(threadId) ?? 900_000;
      const answers: Record<string, { answers: string[] }> = {};
      for (const [index, question] of questions.entries()) {
        const resolution = await hook({
          requestId: `${id}:${question.id}`,
          questionId: question.id,
          question: question.question,
          context: [
            question.context ?? "",
            priorAnswers.length
              ? `Earlier answers in this same request:\n${priorAnswers.join("\n")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          options: question.options,
          timeoutMs,
        });
        resolutions.push(resolution);
        answers[question.id] = { answers: [resolution.answer] };
        priorAnswers.push(`${question.question}: ${resolution.answer}`);
        // A batch is deliberately normalized into sequential durable questions.
        // Advancing here makes the next question the sole active blocker.
        if (index < questions.length - 1) {
          await resolution.delivered();
          deliveredResolutions.add(resolution);
        }
      }
      await this.sendMessage({ id, result: { answers } });
      responded = true;
      await resolutions.at(-1)!.delivered();
      deliveredResolutions.add(resolutions.at(-1)!);
    } catch (error) {
      await Promise.all(
        resolutions
          .filter((resolution) => !deliveredResolutions.has(resolution))
          .map((resolution) => resolution.deliveryFailed()),
      ).catch(() => undefined);
      if (!responded) {
        await this.sendMessage({
          id,
          error: {
            code: -32001,
            message: redactSecrets(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 2_000),
          },
        }).catch(() => undefined);
      }
      if (threadId && turnId) {
        await this.request("turn/interrupt", { threadId, turnId }, 10_000).catch(
          () => undefined,
        );
      }
    }
  }

  private sendMessage(message: JsonObject): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error("Codex app-server is unavailable."));
    }
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  private readonly server = new CodexAppServer();
  private readonly activeThreads = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();

  capabilities(): ProviderCapabilities {
    return {
      provider: this.provider,
      dynamicModelDiscovery: true,
      resume: true,
      fork: true,
      nativeSessionSearch: true,
      nativeCancellation: true,
      notes: ["Uses Codex app-server v2 thread/turn APIs over stdio."],
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return this.exclusive(async () => {
      try {
        await this.server.start();
        const response = await this.server.request("model/list", {});
        const data = Array.isArray(response.data) ? response.data.map(object) : [];
        return data.map((model) => ({
          id: String(model.id ?? model.model ?? ""),
          displayName: typeof model.displayName === "string" ? model.displayName : undefined,
          isDefault: model.isDefault === true,
          reasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts
                .map(object)
                .map((effort) => String(effort.reasoningEffort ?? ""))
                .filter(Boolean)
            : [],
          metadata: model,
        }));
      } finally {
        await this.server.close();
      }
    });
  }

  async searchNativeSessions(query: string, limit: number): Promise<NativeSession[]> {
    return this.exclusive(async () => {
      try {
        await this.server.start();
        const response = await this.server.request("thread/search", {
          searchTerm: query,
          limit,
          sortDirection: "desc",
          sortKey: "updated_at",
          sourceKinds: ["cli", "vscode", "exec", "appServer"],
        });
        const data = Array.isArray(response.data) ? response.data.map(object) : [];
        return data.map((entry) => {
          const thread = object(entry.thread);
          return {
            provider: this.provider,
            sessionId: String(thread.id ?? ""),
            name: typeof thread.name === "string" ? thread.name : undefined,
            preview: typeof thread.preview === "string" ? thread.preview : undefined,
            cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
            status: thread.status,
            createdAt: typeof thread.createdAt === "number" ? thread.createdAt : undefined,
            updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : undefined,
            native: true,
          };
        });
      } finally {
        await this.server.close();
      }
    });
  }

  async run(request: ProviderRunRequest, hooks: ProviderRunHooks): Promise<ProviderResult> {
    return this.exclusive(async () => {
      try {
        return await this.runInternal(request, hooks);
      } finally {
        await this.server.close();
      }
    });
  }

  private async runInternal(
    request: ProviderRunRequest,
    hooks: ProviderRunHooks,
  ): Promise<ProviderResult> {
    await this.server.start();
    const readOnly = request.mode !== "implement";
    const mcpProfile = buildCodexMcpProfile(request.mcpProfile, {
      coordination: request.coordination,
      peer: request.peer,
    });
    let cancelled = false;
    let activeThreadId = "";
    let activeTurnId = "";
    hooks.onStarted({
      pid: this.server.pid,
      cancel: async () => {
        cancelled = true;
        if (activeThreadId && activeTurnId) {
          await this.server.request(
            "turn/interrupt",
            { threadId: activeThreadId, turnId: activeTurnId },
            10_000,
          );
        }
      },
    });
    const overrides = {
      cwd: request.cwd,
      approvalPolicy: "never",
      permissions: readOnly ? "mesh-read" : "mesh-write",
      runtimeWorkspaceRoots: [request.cwd],
      config: mcpProfile,
      ...(request.model ? { model: request.model } : {}),
    };

    let threadResponse: JsonObject;
    if (request.sessionId && request.forkSession) {
      threadResponse = await this.server.request("thread/fork", {
        threadId: request.sessionId,
        ...overrides,
        ephemeral: false,
        threadSource: "agent-mesh",
      }, Math.min(request.timeoutMs, 30_000));
    } else if (request.sessionId) {
      threadResponse = await this.server.request("thread/resume", {
        threadId: request.sessionId,
        ...overrides,
        excludeTurns: true,
      }, Math.min(request.timeoutMs, 30_000));
    } else {
      threadResponse = await this.server.request("thread/start", {
        ...overrides,
        ephemeral: false,
        historyMode: "legacy",
        threadSource: "agent-mesh",
      }, Math.min(request.timeoutMs, 30_000));
    }
    if (cancelled) throw new Error("Codex task cancelled before thread start.");
    const thread = object(threadResponse.thread);
    const threadId = String(thread.id ?? "");
    if (!threadId) throw new Error("Codex did not return a thread id.");
    if (this.activeThreads.has(threadId)) {
      throw new Error(`Codex thread is already running: ${threadId}`);
    }
    this.activeThreads.add(threadId);
    activeThreadId = threadId;
    hooks.onSession(threadId);

    const eventLog = createWriteStream(join(request.taskDir, "events.ndjson"), {
      flags: "ax",
      mode: 0o600,
      encoding: "utf8",
    });
    eventLog.on("error", (error) => {
      console.error(`[agent-mesh/codex] event log error: ${redactSecrets(error.message)}`);
    });
    let eventBytes = 0;
    const maxEventBytes = Number(process.env.AGENT_MESH_MAX_EVENT_BYTES || 10_485_760);
    this.server.watchThread(
      threadId,
      (event) => {
        const line = `${JSON.stringify({
          at: new Date().toISOString(),
          stream: "codex",
          event: summarizeEventForLog(event),
        })}\n`;
        eventBytes += Buffer.byteLength(line);
        if (eventBytes <= maxEventBytes) eventLog.write(line);
        hooks.onEvent?.(event);
      },
      async (question) => {
        if (!hooks.onQuestion) {
          throw new Error("Native Codex questions require a mesh question handler.");
        }
        return hooks.onQuestion(question);
      },
      Math.max(1_000, request.timeoutMs - 1_000),
    );

    let turnId = "";
    try {
      const turnResponse = await this.server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt }],
        approvalPolicy: "never",
        permissions: readOnly ? "mesh-read" : "mesh-write",
        ...(request.model ? { model: request.model } : {}),
        ...(codexEffort(request.effort)
          ? { effort: codexEffort(request.effort) }
          : {}),
      }, Math.min(request.timeoutMs, 30_000));
      const startedTurn = object(turnResponse.turn);
      turnId = String(startedTurn.id ?? "");
      if (!turnId) throw new Error("Codex did not return a turn id.");
      activeTurnId = turnId;
      if (cancelled) {
        await this.server.request("turn/interrupt", { threadId, turnId }, 10_000);
      }
      const turn = await this.server.waitForTurn(threadId, turnId, request.timeoutMs);
      const status = String(turn.status ?? "");
      if (status !== "completed") {
        const error = object(turn.error);
        throw new Error(
          `Codex turn ${status || "failed"}: ${String(error.message ?? "no error detail")}`,
        );
      }
      return {
        output: this.server.outputFor(threadId, turn),
        sessionId: threadId,
        metadata: {
          turnId,
          status,
          model:
            typeof threadResponse.model === "string"
              ? threadResponse.model
              : typeof thread.model === "string"
                ? thread.model
                : null,
          reasoningEffort: threadResponse.reasoningEffort ?? null,
        },
      };
    } finally {
      this.activeThreads.delete(threadId);
      this.server.unwatchThread(threadId);
      eventLog.end();
      await finished(eventLog);
    }
  }

  async close(): Promise<void> {
    await this.operationTail;
    await this.server.close();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
