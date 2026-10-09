/**
 * Subscription reasoning via the official CLIs already logged in on this machine.
 *
 * Claude Code (`claude -p`) uses a Claude Pro/Max login.
 * Codex (`codex exec`) uses a ChatGPT Plus/Pro login.
 * Antigravity (`agy`) uses the signed-in Antigravity subscription.
 *
 * Claude is started with tools disabled and OAuth still enabled. Codex is read-only. Antigravity runs in
 * plan mode inside a sandbox, from an empty temp directory. Prompts go through stdin.
 * Credential files are checked for presence only and are never read or logged.
 * Child processes do not inherit API keys, so a leftover key cannot switch
 * billing off the subscription.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenRouterError,
  sanitizeDiagnostics,
  type CompletionOptions,
  type OpenRouterResponse,
} from "./openrouter.js";

export type SubscriptionProvider = "claude" | "codex" | "antigravity";

const OUTPUT_CAP_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MODEL_PATTERN = /^[a-zA-Z0-9_\-./:]+$/;

export interface SpawnStreams {
  stdin: { write(data: string): void; end(): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnStreams;

export interface SubscriptionCliClientOptions {
  provider: SubscriptionProvider;
  model?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
  credentialCheck?: () => boolean;
  tempDir?: string;
}

export function subscriptionCommand(provider: SubscriptionProvider): "claude" | "codex" | "agy" {
  if (provider === "antigravity") return "agy";
  return provider;
}

export function defaultCredentialCheck(provider: SubscriptionProvider): boolean {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return false;
  if (provider === "claude") {
    return existsSync(join(home, ".claude", ".credentials.json"));
  }
  if (provider === "codex") {
    return existsSync(join(home, ".codex", "auth.json"));
  }
  return existsSync(join(home, ".gemini", "oauth_creds.json"));
}

/**
 * Drop metered API keys so the official CLI bills the signed-in subscription.
 */
export function subscriptionChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}

export function parseClaudeOutput(stdout: string): string {
  const trimmed = stdout.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith("{")) {
      candidates.push(line);
      break;
    }
  }

  for (const candidate of candidates) {
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      data = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof OpenRouterError) throw err;
      continue;
    }

    if (data.is_error === true) {
      const message = typeof data.result === "string" && data.result.trim().length > 0
        ? data.result
        : "Claude CLI returned an error.";
      throw new OpenRouterError(502, "UPSTREAM_ERROR", sanitizeDiagnostics(message));
    }

    if (typeof data.result === "string" && data.result.trim().length > 0) {
      return data.result.trim();
    }
  }

  if (trimmed.length > 0 && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }

  throw new OpenRouterError(502, "EMPTY_RESPONSE", "Claude CLI returned no text.");
}

export function parseCodexOutput(fileText: string, stdout: string): string {
  const fromFile = fileText.trim();
  if (fromFile.length > 0) return fromFile;

  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const item = event.item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const text = record.text;
        const type = record.type;
        if (typeof text === "string" && (type === "agent_message" || type === "message")) {
          last = text;
        }
      }
      if (typeof event.message === "string") last = event.message;
    } catch {
      // Non-JSON log lines are ignored.
    }
  }

  if (last.trim().length > 0) return last.trim();
  throw new OpenRouterError(502, "EMPTY_RESPONSE", "Codex CLI returned no final message.");
}

export function parseAntigravityOutput(stdout: string): string {
  let result: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.event === "result" && event.result && typeof event.result === "object" && !Array.isArray(event.result)) {
        result = event.result as Record<string, unknown>;
      }
    } catch {
      // Log lines that are not JSON are ignored.
    }
  }

  if (!result) {
    throw new OpenRouterError(502, "EMPTY_RESPONSE", "Antigravity CLI returned no result.");
  }

  const response = typeof result.response === "string" ? result.response.trim() : "";
  if (response.length > 0) return response;

  const error = typeof result.error === "string" ? result.error.trim() : "";
  if (error.length > 0) {
    const quota = /quota|resource_exhausted|\b429\b/i.test(error);
    throw new OpenRouterError(
      quota ? 429 : 502,
      quota ? "RATE_LIMIT" : "UPSTREAM_ERROR",
      sanitizeDiagnostics(error)
    );
  }

  throw new OpenRouterError(502, "EMPTY_RESPONSE", "Antigravity CLI returned no text.");
}

function defaultSpawn(command: string, args: string[], options: SpawnOptions): SpawnStreams {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  }) as unknown as SpawnStreams;
}

function collectStream(
  stream: { on(event: "data", listener: (chunk: Buffer | string) => void): void },
  cap: number
): { text: () => string } {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (size >= cap) return;
    const room = cap - size;
    chunks.push(buf.subarray(0, room));
    size += Math.min(buf.length, room);
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function safeModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed || trimmed.length > 128 || !MODEL_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export class SubscriptionCliClient {
  readonly provider: SubscriptionProvider;
  readonly billing = "subscription" as const;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;
  private readonly credentialCheck: () => boolean;
  private readonly tempDir: string;

  constructor(options: SubscriptionCliClientOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.credentialCheck = options.credentialCheck ?? (() => defaultCredentialCheck(options.provider));
    this.tempDir = options.tempDir ?? tmpdir();
  }

  hasCredentials(): boolean {
    return this.credentialCheck();
  }

  getModel(): string {
    if (this.model) return this.model;
    if (this.provider === "claude") return process.env.CLAUDE_MODEL ?? "claude-subscription";
    if (this.provider === "codex") return process.env.CODEX_MODEL ?? "codex-subscription";
    return process.env.ANTIGRAVITY_MODEL ?? "antigravity-subscription";
  }

  async chat(prompt: string, systemPrompt?: string, options: CompletionOptions = {}): Promise<OpenRouterResponse> {
    if (!this.hasCredentials()) {
      const login = subscriptionCommand(this.provider);
      throw new OpenRouterError(
        503,
        "MISSING_SUBSCRIPTION",
        `No ${this.provider} subscription login found. Run \`${login}\` once and sign in with the subscription you already pay for.`
      );
    }

    const model = safeModel(options.model) ?? safeModel(this.getModel());
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const stdinPrompt = [
      systemPrompt?.trim() ? systemPrompt.trim() : "",
      prompt,
      "",
      "Reply with the answer only. Do not edit files, run commands, or use tools.",
    ].filter((part) => part.length > 0).join("\n\n");

    if (this.provider === "claude") {
      return this.runClaude(stdinPrompt, model, timeoutMs, options.signal);
    }
    if (this.provider === "codex") {
      return this.runCodex(stdinPrompt, model, timeoutMs, options.signal);
    }
    return this.runAntigravity(stdinPrompt, model, timeoutMs, options.signal);
  }

  private claudeArgs(model: string | undefined): string[] {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      // Token stripping: without these the CLI loads every user MCP tool, CLAUDE.md,
      // hooks and the full agent system prompt (~576k input tokens per Ask measured
      // 2026-10-06; ~600 with them). The grounded system prompt travels on stdin.
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--system-prompt",
      "Answer concisely from the provided context.",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-prompts",
      "none",
    ];
    if (model && model !== "claude-subscription") {
      args.push("--model", model);
    }
    return args;
  }

  private codexArgs(model: string | undefined, outputFile: string, cwd: string): string[] {
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--color",
      "never",
      "--json",
      "-o",
      outputFile,
      "-C",
      cwd,
    ];
    if (model && model !== "codex-subscription") {
      args.push("-m", model);
    }
    args.push("-");
    return args;
  }

  private antigravityArgs(model: string | undefined, timeoutMs: number): string[] {
    const seconds = Math.max(1, Math.floor(timeoutMs / 1000));
    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--mode",
      "plan",
      "--sandbox",
      "--print-timeout",
      `${seconds}s`,
    ];
    if (model && model !== "antigravity-subscription") {
      args.push("--model", model);
    }
    return args;
  }

  private antigravityStdin(prompt: string): string {
    return JSON.stringify({
      event: "user",
      message: { role: "user", content: prompt },
    });
  }

  private async runClaude(
    prompt: string,
    model: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<OpenRouterResponse> {
    const workDir = await mkdtemp(join(this.tempDir, "pieces-for-all-"));
    try {
      const stdout = await this.runProcess({
        command: "claude",
        args: this.claudeArgs(model),
        prompt,
        timeoutMs,
        signal,
        cwd: workDir,
      });
      return {
        id: `claude-${randomUUID()}`,
        content: parseClaudeOutput(stdout),
        model: model && model !== "claude-subscription" ? model : this.getModel(),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runCodex(
    prompt: string,
    model: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<OpenRouterResponse> {
    const workDir = await mkdtemp(join(this.tempDir, "pieces-for-all-"));
    const outputFile = join(workDir, "last-message.txt");
    try {
      const stdout = await this.runProcess({
        command: "codex",
        args: this.codexArgs(model, outputFile, workDir),
        prompt,
        timeoutMs,
        signal,
        cwd: workDir,
      });
      let fileText = "";
      try {
        fileText = await readFile(outputFile, "utf8");
      } catch {
        fileText = "";
      }
      return {
        id: `codex-${randomUUID()}`,
        content: parseCodexOutput(fileText, stdout),
        model: model && model !== "codex-subscription" ? model : this.getModel(),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runAntigravity(
    prompt: string,
    model: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<OpenRouterResponse> {
    const workDir = await mkdtemp(join(this.tempDir, "pieces-for-all-"));
    try {
      const stdout = await this.runProcess({
        command: "agy",
        args: this.antigravityArgs(model, timeoutMs),
        prompt: this.antigravityStdin(prompt),
        timeoutMs,
        signal,
        cwd: workDir,
        acceptNonZero: true,
      });
      return {
        id: `antigravity-${randomUUID()}`,
        content: parseAntigravityOutput(stdout),
        model: model && model !== "antigravity-subscription" ? model : this.getModel(),
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private runProcess(input: {
    command: "claude" | "codex" | "agy";
    args: string[];
    prompt: string;
    timeoutMs: number;
    signal?: AbortSignal;
    cwd: string;
    acceptNonZero?: boolean;
  }): Promise<string> {
    if (input.signal?.aborted) {
      return Promise.reject(new OpenRouterError(499, "CLIENT_ABORTED", "Client aborted request before execution."));
    }

    const child = this.spawnFn(input.command, input.args, {
      cwd: input.cwd,
      env: subscriptionChildEnv(),
      windowsHide: true,
    });
    const stdout = collectStream(child.stdout, OUTPUT_CAP_BYTES);
    const stderr = collectStream(child.stderr, OUTPUT_CAP_BYTES);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(() => {
          reject(new OpenRouterError(
            504,
            "TIMEOUT",
            `${input.command} timed out after ${input.timeoutMs}ms.`
          ));
        });
      }, input.timeoutMs);

      const onAbort = () => {
        child.kill();
        finish(() => {
          reject(new OpenRouterError(499, "CLIENT_ABORTED", "Client disconnected while waiting for the subscription CLI."));
        });
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (err.code === "ENOENT") {
            reject(new OpenRouterError(
              503,
              "CLI_NOT_FOUND",
              `${input.command} is not installed or not on PATH.`
            ));
            return;
          }
          reject(new OpenRouterError(
            502,
            "CLI_ERROR",
            `Failed to start ${input.command}.`,
            sanitizeDiagnostics(err.message)
          ));
        });
      });

      child.on("exit", (code) => {
        finish(() => {
          const text = stdout.text();
          if (code === 0 || (input.acceptNonZero && text.trim().length > 0)) {
            resolve(text);
            return;
          }
          const details = sanitizeDiagnostics(stderr.text() || stdout.text());
          reject(new OpenRouterError(
            502,
            "UPSTREAM_ERROR",
            `${input.command} exited with code ${code ?? "unknown"}.`,
            details || undefined
          ));
        });
      });

      try {
        child.stdin.write(input.prompt);
        child.stdin.end();
      } catch (err) {
        finish(() => {
          reject(new OpenRouterError(
            502,
            "CLI_ERROR",
            `Failed to send the prompt to ${input.command}.`,
            sanitizeDiagnostics(err instanceof Error ? err.message : String(err))
          ));
        });
      }
    });
  }
}
