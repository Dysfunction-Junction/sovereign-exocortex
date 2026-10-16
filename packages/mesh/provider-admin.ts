import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { parseAntigravityModels } from "./adapters/antigravity.js";
import { parseGrokModels } from "./adapters/grok.js";
import {
  buildSafeEnv,
  redactSecrets,
  resolveTrustedProviderExecutable,
} from "./security.js";
import { PROVIDERS, type Provider, type ProviderModel } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const MAX_CODEX_RPC_REQUESTS = 16;
const MAX_CODEX_MODEL_PAGES = 10;
const MAX_MODELS = 1_000;

const PROVIDER_BINARIES: Readonly<Record<Provider, string>> = {
  cursor: "cursor-agent",
  codex: "codex",
  claude: "claude",
  grok: "grok",
  antigravity: "agy",
};

export type ProviderCommandOperation =
  | "version"
  | "authStatus"
  | "about"
  | "models"
  | "doctor"
  | "updateCheck"
  | "update"
  | "logout";

export interface ProviderCommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Injection boundary for tests and embedders. Implementations must dispatch
 * operations from the closed ProviderCommandOperation allowlist; callers never
 * supply an executable, arguments, or a shell command.
 */
export interface ProviderCommandExecutor {
  locate(provider: Provider): Promise<string | null>;
  run(provider: Provider, operation: ProviderCommandOperation): Promise<ProviderCommandOutput>;
}

interface CommandSpec {
  args: readonly string[];
  timeoutKind: "read" | "mutation";
}

const COMMAND_SPECS: Readonly<
  Record<Provider, Partial<Record<ProviderCommandOperation, CommandSpec>>>
> = {
  cursor: {
    version: { args: ["--version"], timeoutKind: "read" },
    authStatus: { args: ["status", "--format", "json"], timeoutKind: "read" },
    about: { args: ["about", "--format", "json"], timeoutKind: "read" },
    models: { args: ["models"], timeoutKind: "read" },
    update: { args: ["update"], timeoutKind: "mutation" },
    logout: { args: ["logout"], timeoutKind: "mutation" },
  },
  codex: {
    version: { args: ["--version"], timeoutKind: "read" },
    authStatus: { args: ["login", "status"], timeoutKind: "read" },
    doctor: { args: ["doctor", "--json"], timeoutKind: "read" },
    update: { args: ["update"], timeoutKind: "mutation" },
    logout: { args: ["logout"], timeoutKind: "mutation" },
  },
  claude: {
    version: { args: ["--version"], timeoutKind: "read" },
    authStatus: { args: ["auth", "status", "--json"], timeoutKind: "read" },
    doctor: { args: ["doctor"], timeoutKind: "read" },
    update: { args: ["update"], timeoutKind: "mutation" },
    logout: { args: ["auth", "logout"], timeoutKind: "mutation" },
  },
  grok: {
    version: { args: ["--version"], timeoutKind: "read" },
    authStatus: { args: ["models"], timeoutKind: "read" },
    models: { args: ["models"], timeoutKind: "read" },
    doctor: { args: ["doctor", "--json"], timeoutKind: "read" },
    updateCheck: { args: ["update", "--check", "--json"], timeoutKind: "read" },
    update: { args: ["update"], timeoutKind: "mutation" },
    logout: { args: ["logout"], timeoutKind: "mutation" },
  },
  antigravity: {
    version: { args: ["--version"], timeoutKind: "read" },
    authStatus: { args: ["models"], timeoutKind: "read" },
    models: { args: ["models"], timeoutKind: "read" },
  },
};

export type CodexReadRequest =
  | { method: "account/read"; params?: Record<string, never> }
  | { method: "account/rateLimits/read"; params?: Record<string, never> }
  | { method: "model/list"; params?: { cursor?: string } };

/**
 * Read-only Codex app-server boundary. A batch shares one short-lived process.
 * The default implementation rejects methods and params outside this union.
 */
export interface CodexReadClient {
  read(requests: readonly CodexReadRequest[]): Promise<unknown[]>;
}

export interface ProviderAdminConfigReader {
  readClaudeSettings(): Promise<unknown>;
}

export type ProviderAuthState = "authenticated" | "unauthenticated" | "unknown";

export interface ProviderAccount {
  email?: string;
  id?: string;
  name?: string;
  organizationId?: string;
  organizationName?: string;
  plan?: string;
  authMethod?: string;
}

export interface ProviderAuth {
  state: ProviderAuthState;
  account: ProviderAccount | null;
  summary: string;
}

export interface ProviderAdminCapabilities {
  dynamicModelDiscovery: boolean;
  nativeDoctor: boolean;
  readOnlyUpdateCheck: boolean;
  update: boolean;
  logout: boolean;
  usage: {
    rateLimits: boolean;
    cost: boolean;
    session: boolean;
  };
  notes: string[];
}

export interface ProviderStatus {
  provider: Provider;
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  auth: ProviderAuth;
  configuredModel: string | null;
  defaultModel: string | null;
  defaultModelSource: "provider" | "configured" | "unknown";
  capabilities: ProviderAdminCapabilities;
  warnings: string[];
}

export interface AvailableField<T> {
  status: "available";
  value: T;
  source: string;
}

export interface UnsupportedField {
  status: "unsupported";
  value: null;
  reason: string;
}

export interface UnavailableField {
  status: "unavailable";
  value: null;
  reason: string;
}

export type ProviderUsageField<T> = AvailableField<T> | UnsupportedField | UnavailableField;

export interface NormalizedRateLimitWindow {
  scope: "primary" | "secondary" | "individual";
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationSeconds: number | null;
  resetsAt: string | null;
}

export interface NormalizedCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
}

export interface NormalizedRateLimit {
  id: string;
  name: string | null;
  plan: string | null;
  reachedType: string | null;
  windows: NormalizedRateLimitWindow[];
  credits: NormalizedCredits | null;
}

export interface ProviderCostUsage {
  amount: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface ProviderSessionUsage {
  sessionId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cost: ProviderCostUsage | null;
}

export interface ProviderUsage {
  provider: Provider;
  rateLimits: ProviderUsageField<NormalizedRateLimit[]>;
  cost: ProviderUsageField<ProviderCostUsage>;
  session: ProviderUsageField<ProviderSessionUsage>;
}

export type ProviderDoctorHealth = "ok" | "warning" | "error" | "unavailable";

export interface ProviderDoctorCheck {
  id: string;
  category: string;
  health: ProviderDoctorHealth;
  summary: string;
  remediation: string | null;
}

export interface ProviderDoctorResult {
  provider: Provider;
  health: ProviderDoctorHealth;
  native: boolean;
  checks: ProviderDoctorCheck[];
  summary: string;
}

export interface ProviderUpdateCheckResult {
  provider: Provider;
  supported: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  source: string;
  reason: string | null;
}

export interface MutationConfirmation {
  confirmation: string;
}

export interface ProviderUpdateResult {
  provider: Provider;
  operation: "update";
  beforeVersion: string | null;
  afterVersion: string | null;
  changed: boolean | null;
  summary: string;
}

export interface ProviderLogoutResult {
  provider: Provider;
  operation: "logout";
  summary: string;
}

export interface ProviderAdministration {
  providerStatus(provider: Provider): Promise<ProviderStatus>;
  providerUsage(provider: Provider): Promise<ProviderUsage>;
  providerDoctor(provider: Provider): Promise<ProviderDoctorResult>;
  providerUpdateCheck(provider: Provider): Promise<ProviderUpdateCheckResult>;
  providerUpdate(
    provider: Provider,
    confirmation: MutationConfirmation,
  ): Promise<ProviderUpdateResult>;
  providerLogout(
    provider: Provider,
    confirmation: MutationConfirmation,
  ): Promise<ProviderLogoutResult>;
  listProviderModels(provider: Provider): Promise<ProviderModel[]>;
}

export interface ProviderAdminOptions {
  executor?: ProviderCommandExecutor;
  codex?: CodexReadClient;
  config?: ProviderAdminConfigReader;
  /**
   * Extra Claude full model IDs verified by the embedding application.
   * Values are accepted only when they match the conservative full-ID grammar.
   */
  claudeFullModelIds?: readonly string[];
  maxOutputBytes?: number;
  readTimeoutMs?: number;
  mutationTimeoutMs?: number;
  rpcTimeoutMs?: number;
}

export const PROVIDER_UPDATE_CONFIRMATIONS: Readonly<Record<Provider, string>> = {
  cursor: "UPDATE cursor",
  codex: "UPDATE codex",
  claude: "UPDATE claude",
  grok: "UPDATE grok",
  antigravity: "UPDATE antigravity",
};

export const PROVIDER_LOGOUT_CONFIRMATIONS: Readonly<Record<Provider, string>> = {
  cursor: "LOGOUT cursor",
  codex: "LOGOUT codex",
  claude: "LOGOUT claude",
  grok: "LOGOUT grok",
  antigravity: "LOGOUT antigravity",
};

const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
const BUILTIN_CLAUDE_FULL_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;

const ADMIN_CAPABILITIES: Readonly<Record<Provider, ProviderAdminCapabilities>> = {
  cursor: {
    dynamicModelDiscovery: true,
    nativeDoctor: false,
    readOnlyUpdateCheck: false,
    update: true,
    logout: true,
    usage: { rateLimits: false, cost: false, session: false },
    notes: [
      "Model discovery uses `cursor-agent models`.",
      "Cursor exposes update installation but no separate read-only update check.",
      "Cursor CLI does not expose account rate limits, cost, or historical session usage.",
    ],
  },
  codex: {
    dynamicModelDiscovery: true,
    nativeDoctor: true,
    readOnlyUpdateCheck: true,
    update: true,
    logout: true,
    usage: { rateLimits: true, cost: false, session: false },
    notes: [
      "Models, account details, and rate limits use read-only app-server methods.",
      "Cost and historical per-session usage are not exposed by the current admin APIs.",
    ],
  },
  claude: {
    dynamicModelDiscovery: false,
    nativeDoctor: true,
    readOnlyUpdateCheck: false,
    update: true,
    logout: true,
    usage: { rateLimits: false, cost: false, session: false },
    notes: [
      "Claude Code has no machine-readable model catalog; only conservative aliases and verified full IDs are returned.",
      "The update command combines checking and installation, so read-only update checks never invoke it.",
      "Claude Code does not expose account rate limits, cost, or historical session usage.",
    ],
  },
  grok: {
    dynamicModelDiscovery: true,
    nativeDoctor: true,
    readOnlyUpdateCheck: true,
    update: true,
    logout: true,
    usage: { rateLimits: false, cost: false, session: false },
    notes: [
      "Model discovery and authentication status use `grok models`.",
      "Update checks use the read-only `grok update --check --json` command.",
      "Grok does not expose account rate limits or historical session usage through its CLI.",
    ],
  },
  antigravity: {
    dynamicModelDiscovery: true,
    nativeDoctor: false,
    readOnlyUpdateCheck: false,
    update: false,
    logout: false,
    usage: { rateLimits: false, cost: false, session: false },
    notes: [
      "Model discovery and authentication status use `agy models`.",
      "Antigravity update mutation is disabled until its non-interactive behavior is verified; no logout subcommand exists.",
      "Antigravity CLI does not expose normalized usage or cost telemetry.",
    ],
  },
};

class ProviderAdminError extends Error {
  constructor(
    readonly provider: Provider,
    readonly operation: string,
    message: string,
  ) {
    super(`${provider} ${operation}: ${message}`);
    this.name = "ProviderAdminError";
  }
}

export class ProviderMutationConfirmationError extends Error {
  constructor(
    readonly provider: Provider,
    readonly operation: "update" | "logout",
    readonly requiredConfirmation: string,
  ) {
    super(
      `Refusing ${provider} ${operation}; confirmation must exactly equal "${requiredConfirmation}".`,
    );
    this.name = "ProviderMutationConfirmationError";
  }
}

function assertProvider(provider: Provider): void {
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Unsupported provider: ${String(provider)}`);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function adminEnvironment(): NodeJS.ProcessEnv {
  return buildSafeEnv({
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    NO_OPEN_BROWSER: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_AUTO_UPDATE: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CURSOR_AGENT_DISABLE_AUTO_UPDATE: "1",
    CODEX_DISABLE_AUTO_UPDATE: "1",
    GROK_DISABLE_AUTOUPDATER: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
  });
}

function redactAndBound(value: string, maxBytes: number): string {
  const redacted = redactSecrets(value);
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.length <= maxBytes) return redacted;
  const marker = "\n[output truncated]";
  const markerBytes = Buffer.byteLength(marker);
  return `${bytes.subarray(0, Math.max(0, maxBytes - markerBytes)).toString("utf8")}${marker}`;
}

function safeError(error: unknown): string {
  return redactAndBound(error instanceof Error ? error.message : String(error), 2_000);
}

async function locateProviderBinary(provider: Provider): Promise<string | null> {
  try {
    return await resolveTrustedProviderExecutable(PROVIDER_BINARIES[provider]);
  } catch {
    return null;
  }
}

class ExecFileProviderCommandExecutor implements ProviderCommandExecutor {
  private readonly maxOutputBytes: number;
  private readonly readTimeoutMs: number;
  private readonly mutationTimeoutMs: number;

  constructor(options: ProviderAdminOptions) {
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    this.readTimeoutMs = positiveInteger(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS);
    this.mutationTimeoutMs = positiveInteger(
      options.mutationTimeoutMs,
      DEFAULT_MUTATION_TIMEOUT_MS,
    );
  }

  locate(provider: Provider): Promise<string | null> {
    assertProvider(provider);
    return locateProviderBinary(provider);
  }

  async run(
    provider: Provider,
    operation: ProviderCommandOperation,
  ): Promise<ProviderCommandOutput> {
    assertProvider(provider);
    const spec = COMMAND_SPECS[provider][operation];
    if (!spec) {
      throw new ProviderAdminError(provider, operation, "operation is not allowlisted");
    }
    const binaryPath = await this.locate(provider);
    if (!binaryPath) {
      throw new ProviderAdminError(provider, operation, "CLI binary was not found");
    }
    const timeout =
      spec.timeoutKind === "mutation" ? this.mutationTimeoutMs : this.readTimeoutMs;
    const environment = adminEnvironment();
    if (operation === "doctor") environment.TERM = "xterm-256color";

    return new Promise<ProviderCommandOutput>((resolve, reject) => {
      const child = execFile(
        binaryPath,
        [...spec.args],
        {
          cwd: homedir(),
          env: environment,
          encoding: "utf8",
          maxBuffer: this.maxOutputBytes,
          timeout,
          killSignal: "SIGTERM",
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          const boundedStdout = redactAndBound(stdout, this.maxOutputBytes);
          const boundedStderr = redactAndBound(stderr, this.maxOutputBytes);
          if (
            error &&
            (error.killed ||
              error.code === "ENOENT" ||
              error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          ) {
            reject(
              new ProviderAdminError(
                provider,
                operation,
                `${safeError(error)}${boundedStderr ? `: ${boundedStderr}` : ""}`,
              ),
            );
            return;
          }
          resolve({
            stdout: boundedStdout,
            stderr: boundedStderr,
            exitCode: error
              ? typeof error.code === "number"
                ? error.code
                : null
              : 0,
            signal: error?.signal ?? null,
          });
        },
      );
      child.stdin?.end();
    });
  }
}

function normalizeCodexReadRequest(request: CodexReadRequest): {
  method: CodexReadRequest["method"];
  params: Record<string, unknown>;
} {
  if (request.method === "account/read" || request.method === "account/rateLimits/read") {
    return { method: request.method, params: {} };
  }
  if (request.method === "model/list") {
    const cursor = request.params?.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 512)) {
      throw new Error("Invalid Codex model cursor.");
    }
    return {
      method: request.method,
      params: cursor === undefined ? {} : { cursor },
    };
  }
  const exhaustive: never = request;
  throw new Error(`Unsupported Codex read request: ${String(exhaustive)}`);
}

interface PendingRpcRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class CodexAppServerReadClient implements CodexReadClient {
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly resolveBinary: () => Promise<string | null>,
    options: ProviderAdminOptions,
  ) {
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    this.timeoutMs = positiveInteger(options.rpcTimeoutMs, DEFAULT_RPC_TIMEOUT_MS);
  }

  async read(requests: readonly CodexReadRequest[]): Promise<unknown[]> {
    if (requests.length === 0) return [];
    if (requests.length > MAX_CODEX_RPC_REQUESTS) {
      throw new ProviderAdminError("codex", "read", "too many app-server requests");
    }
    const normalized = requests.map(normalizeCodexReadRequest);
    const binaryPath = await this.resolveBinary();
    if (!binaryPath) {
      throw new ProviderAdminError("codex", "read", "CLI binary was not found");
    }

    const child: ChildProcessWithoutNullStreams = spawn(
      binaryPath,
      ["app-server", "--listen", "stdio://"],
      {
        cwd: homedir(),
        env: adminEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      },
    );
    const pending = new Map<number, PendingRpcRequest>();
    let nextId = 1;
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let stderr = "";
    let closing = false;
    let fatalError: Error | undefined;

    const fail = (error: Error) => {
      if (!fatalError) fatalError = error;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
      if (!closing && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    };

    const writeMessage = (message: Record<string, unknown>): Promise<void> =>
      new Promise((resolve, reject) => {
        if (fatalError || child.stdin.destroyed) {
          reject(
            fatalError ??
              new ProviderAdminError("codex", "read", "app-server stdin is closed"),
          );
          return;
        }
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

    const request = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      const id = nextId++;
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new ProviderAdminError(
              "codex",
              method,
              `app-server request timed out after ${this.timeoutMs}ms`,
            ),
          );
        }, this.timeoutMs);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
      });
      void writeMessage({ id, method, params }).catch((error) => {
        const item = pending.get(id);
        if (!item) return;
        pending.delete(id);
        clearTimeout(item.timer);
        item.reject(
          new ProviderAdminError("codex", method, `write failed: ${safeError(error)}`),
        );
      });
      return response;
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        message = parsed as Record<string, unknown>;
      } catch {
        // Current app-server emits JSONL, but tolerate bounded informational lines.
        return;
      }
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) {
          item.reject(
            new ProviderAdminError(
              "codex",
              "read",
              redactAndBound(JSON.stringify(message.error), 2_000),
            ),
          );
        } else {
          item.resolve(message.result);
        }
        return;
      }
      if (typeof message.id === "number" && typeof message.method === "string") {
        void writeMessage({
          id: message.id,
          error: {
            code: -32601,
            message: "Provider administration does not handle server-initiated requests.",
          },
        }).catch(() => undefined);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > this.maxOutputBytes) {
        fail(
          new ProviderAdminError(
            "codex",
            "read",
            `app-server output exceeded ${this.maxOutputBytes} bytes`,
          ),
        );
        return;
      }
      stdoutBuffer += text;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = redactAndBound(`${stderr}${chunk.toString()}`, this.maxOutputBytes);
    });
    child.once("error", (error) => {
      fail(
        new ProviderAdminError(
          "codex",
          "read",
          `${safeError(error)}${stderr ? `: ${stderr}` : ""}`,
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (!closing) {
        fail(
          new ProviderAdminError(
            "codex",
            "read",
            `app-server exited (code=${String(code)}, signal=${String(signal)})${
              stderr ? `: ${stderr}` : ""
            }`,
          ),
        );
      }
    });

    const overallTimer = setTimeout(() => {
      fail(
        new ProviderAdminError(
          "codex",
          "read",
          `app-server batch timed out after ${this.timeoutMs}ms`,
        ),
      );
    }, this.timeoutMs);
    overallTimer.unref();

    try {
      await request("initialize", {
        clientInfo: {
          name: "agent-mesh-provider-admin",
          title: "Agent Mesh Provider Admin",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      await writeMessage({ method: "initialized", params: {} });
      const results: unknown[] = [];
      for (const item of normalized) {
        results.push(await request(item.method, item.params));
      }
      return results;
    } finally {
      clearTimeout(overallTimer);
      closing = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new ProviderAdminError("codex", "read", "app-server batch closed"));
      }
      pending.clear();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([
        once(child, "close").catch(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
          timer.unref();
        }),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}

class FileProviderAdminConfigReader implements ProviderAdminConfigReader {
  constructor(private readonly maxBytes: number) {}

  async readClaudeSettings(): Promise<unknown> {
    try {
      const contents = await readFile(join(homedir(), ".claude", "settings.json"));
      if (contents.byteLength > this.maxBytes) return null;
      return parseJsonDocument(contents.toString("utf8"));
    } catch {
      return null;
    }
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(
      // eslint-disable-next-line no-control-regex
      /\u001B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g,
      "",
    )
    .replace(/\r/g, "");
}

function parseJsonDocument(value: string): unknown {
  const text = stripAnsi(value).replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Some CLI versions prefix JSON with an informational line. Scan for the
    // first balanced JSON object/array while respecting quoted strings.
  }
  for (let start = 0; start < text.length; start += 1) {
    const opening = text[start];
    if (opening !== "{" && opening !== "[") continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }
      if (character !== "}" && character !== "]") continue;
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) break;
      if (stack.length === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function commandText(output: ProviderCommandOutput | null): string {
  if (!output) return "";
  return stripAnsi([output.stdout, output.stderr].filter(Boolean).join("\n")).trim();
}

function parseVersion(value: string): string | null {
  const match = stripAnsi(value).match(
    /\b\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?\b/,
  );
  return match?.[0] ?? null;
}

function safeModelId(value: unknown): string | null {
  const id = stringValue(value);
  if (!id || id.length > 256 || id.startsWith("-")) return null;
  if (/[\s\u0000-\u001F\u007F]/.test(id)) return null;
  return id;
}

export function isSafeClaudeModelId(value: string): boolean {
  if ((CLAUDE_ALIASES as readonly string[]).includes(value)) return true;
  return (
    value.length <= 128 &&
    /^claude-[a-z0-9]+(?:-[a-z0-9]+){1,10}(?:-\d{8})?$/.test(value)
  );
}

function modelFromLabel(value: unknown): string | null {
  const label = stringValue(value);
  if (!label) return null;
  if (label.toLowerCase() === "auto") return "auto";
  return safeModelId(label);
}

function providerCapabilities(provider: Provider): ProviderAdminCapabilities {
  const capability = ADMIN_CAPABILITIES[provider];
  return {
    ...capability,
    usage: { ...capability.usage },
    notes: [...capability.notes],
  };
}

function emptyAuth(summary: string): ProviderAuth {
  return { state: "unknown", account: null, summary };
}

function unavailableStatus(
  provider: Provider,
  binaryPath: string | null,
  warning?: string,
): ProviderStatus {
  return {
    provider,
    installed: false,
    version: null,
    binaryPath,
    auth: emptyAuth("CLI is not installed."),
    configuredModel: null,
    defaultModel: null,
    defaultModelSource: "unknown",
    capabilities: providerCapabilities(provider),
    warnings: warning ? [warning] : [],
  };
}

function outputFailure(
  provider: Provider,
  operation: string,
  output: ProviderCommandOutput,
): ProviderAdminError {
  return new ProviderAdminError(
    provider,
    operation,
    `command failed (code=${String(output.exitCode)}, signal=${String(output.signal)}): ${
      commandText(output) || "no diagnostic output"
    }`,
  );
}

function requireSuccess(
  provider: Provider,
  operation: string,
  output: ProviderCommandOutput,
): ProviderCommandOutput {
  if (output.exitCode !== 0) throw outputFailure(provider, operation, output);
  return output;
}

function accountFromCursor(
  status: Record<string, unknown>,
  about: Record<string, unknown>,
): ProviderAuth {
  const authenticated =
    status.isAuthenticated === true ||
    String(status.status ?? "").toLowerCase() === "authenticated" ||
    Boolean(stringValue(about.userEmail));
  const unauthenticated =
    status.isAuthenticated === false ||
    /unauthenticated|logged.?out|not authenticated/i.test(String(status.status ?? ""));
  const user = object(status.userInfo);
  const firstName = stringValue(user.firstName);
  const lastName = stringValue(user.lastName);
  const name = [firstName, lastName].filter(Boolean).join(" ") || undefined;
  const email = stringValue(user.email) ?? stringValue(about.userEmail) ?? undefined;
  const id =
    typeof user.userId === "number" || typeof user.userId === "string"
      ? String(user.userId)
      : undefined;
  const team =
    typeof user.teamId === "number" || typeof user.teamId === "string"
      ? String(user.teamId)
      : undefined;
  const plan = stringValue(about.subscriptionTier) ?? undefined;
  const account =
    email || id || name || team || plan
      ? {
          email,
          id,
          name,
          organizationId: team,
          plan,
          authMethod: "cursor",
        }
      : null;
  return {
    state: authenticated ? "authenticated" : unauthenticated ? "unauthenticated" : "unknown",
    account,
    summary: authenticated
      ? "Authenticated with Cursor."
      : unauthenticated
        ? "Not authenticated with Cursor."
        : "Cursor authentication state is unknown.",
  };
}

function accountFromCodex(value: unknown, fallbackText: string): ProviderAuth {
  const root = object(value);
  const accountValue = object(root.account);
  const type = stringValue(accountValue.type);
  const email = stringValue(accountValue.email) ?? undefined;
  const plan = stringValue(accountValue.planType) ?? undefined;
  if (Object.keys(accountValue).length > 0) {
    return {
      state: "authenticated",
      account: {
        email,
        plan,
        authMethod: type ?? undefined,
      },
      summary: type ? `Authenticated with Codex using ${type}.` : "Authenticated with Codex.",
    };
  }
  if (/logged in|authenticated/i.test(fallbackText) && !/not logged in|unauthenticated/i.test(fallbackText)) {
    return {
      state: "authenticated",
      account: {
        authMethod: fallbackText.match(/using\s+([^\n.]+)/i)?.[1]?.trim(),
      },
      summary: "Authenticated with Codex.",
    };
  }
  if (/not logged in|unauthenticated|logged out/i.test(fallbackText)) {
    return {
      state: "unauthenticated",
      account: null,
      summary: "Not authenticated with Codex.",
    };
  }
  return emptyAuth("Codex authentication state is unknown.");
}

function accountFromClaude(value: unknown): ProviderAuth {
  const root = object(value);
  const loggedIn = booleanValue(root.loggedIn);
  const email = stringValue(root.email) ?? undefined;
  const organizationId = stringValue(root.orgId) ?? undefined;
  const organizationName = stringValue(root.orgName) ?? undefined;
  const plan = stringValue(root.subscriptionType) ?? undefined;
  const authMethod = stringValue(root.authMethod) ?? undefined;
  const account =
    email || organizationId || organizationName || plan || authMethod
      ? { email, organizationId, organizationName, plan, authMethod }
      : null;
  return {
    state: loggedIn === true ? "authenticated" : loggedIn === false ? "unauthenticated" : "unknown",
    account,
    summary:
      loggedIn === true
        ? "Authenticated with Claude Code."
        : loggedIn === false
          ? "Not authenticated with Claude Code."
          : "Claude Code authentication state is unknown.",
  };
}

function accountFromGrok(value: string): ProviderAuth {
  const text = stripAnsi(value);
  if (/you are logged in with grok\.com/i.test(text)) {
    return {
      state: "authenticated",
      account: { authMethod: "grok.com" },
      summary: "Authenticated with Grok.",
    };
  }
  if (/not authenticated|not logged in|signed out/i.test(text)) {
    return {
      state: "unauthenticated",
      account: null,
      summary: "Not authenticated with Grok.",
    };
  }
  return emptyAuth("Grok authentication state is unknown.");
}

function accountFromAntigravity(value: string): ProviderAuth {
  const text = stripAnsi(value);
  if (/^\s*(?:gemini|claude|gpt)-[a-z0-9.-]+\s*$/im.test(text)) {
    return {
      state: "authenticated",
      account: { authMethod: "google-oauth" },
      summary: "Authenticated with Antigravity.",
    };
  }
  if (/please sign in|authentication required|not logged in/i.test(text)) {
    return {
      state: "unauthenticated",
      account: null,
      summary: "Not authenticated with Antigravity.",
    };
  }
  return emptyAuth("Antigravity authentication state is unknown.");
}

function codexDoctorRoot(output: ProviderCommandOutput | null): Record<string, unknown> {
  return object(parseJsonDocument(commandText(output)));
}

function codexDoctorDetail(
  root: Record<string, unknown>,
  checkId: string,
  detail: string,
): string | null {
  const checks = object(root.checks);
  const check = object(checks[checkId]);
  return stringValue(object(check.details)[detail]);
}

function healthFromValue(value: unknown): ProviderDoctorHealth {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "ok" || normalized === "pass" || normalized === "healthy") return "ok";
  if (normalized === "warning" || normalized === "warn" || normalized === "note") {
    return "warning";
  }
  if (normalized === "fail" || normalized === "failed" || normalized === "error") {
    return "error";
  }
  return "unavailable";
}

function aggregateHealth(checks: readonly ProviderDoctorCheck[]): ProviderDoctorHealth {
  if (checks.some((check) => check.health === "error")) return "error";
  if (checks.some((check) => check.health === "warning")) return "warning";
  if (checks.some((check) => check.health === "ok")) return "ok";
  return "unavailable";
}

function parseCodexDoctor(output: ProviderCommandOutput): ProviderDoctorResult {
  const root = codexDoctorRoot(output);
  const rawChecks = object(root.checks);
  const checks: ProviderDoctorCheck[] = [];
  for (const [id, value] of Object.entries(rawChecks)) {
    const check = object(value);
    const category = stringValue(check.category) ?? id.split(".")[0] ?? "codex";
    checks.push({
      id,
      category,
      health: healthFromValue(check.status),
      summary: stringValue(check.summary) ?? "No summary provided.",
      remediation: stringValue(check.remediation),
    });
  }
  const declared = healthFromValue(root.overallStatus);
  const health = declared === "unavailable" ? aggregateHealth(checks) : declared;
  return {
    provider: "codex",
    health,
    native: true,
    checks,
    summary:
      checks.length > 0
        ? `Codex doctor reported ${health}.`
        : `Codex doctor output could not be parsed${output.exitCode === 0 ? "." : ` (exit ${String(output.exitCode)}).`}`,
  };
}

function parseClaudeDoctor(output: ProviderCommandOutput): ProviderDoctorResult {
  const text = commandText(output);
  const checks: ProviderDoctorCheck[] = [];
  const keyMap: Readonly<Record<string, string>> = {
    Running: "runtime",
    Platform: "platform",
    Path: "installation",
    Search: "search",
    "Auto-updates": "auto-updates",
    "Auto-update channel": "update-channel",
    "Last update attempt": "last-update",
  };
  for (const line of text.split("\n")) {
    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    const key = match[1]!.trim();
    const id = keyMap[key];
    if (!id) continue;
    const value = match[2]!.trim();
    const failure = /\b(?:fail(?:ed|ure)?|error|missing|not found)\b/i.test(value);
    const warning = /\b(?:disabled|warning|unknown)\b/i.test(value);
    checks.push({
      id,
      category: id === "search" ? "runtime" : "installation",
      health: failure ? "error" : warning ? "warning" : "ok",
      summary: `${key}: ${value}`,
      remediation: null,
    });
  }
  const explicitSuccess = /No installation issues found/i.test(text);
  const health =
    output.exitCode !== 0
      ? "error"
      : explicitSuccess
        ? aggregateHealth(checks) === "error"
          ? "error"
          : "ok"
        : aggregateHealth(checks);
  return {
    provider: "claude",
    health,
    native: true,
    checks,
    summary: explicitSuccess
      ? "Claude Code reports no installation issues."
      : text.split("\n").find((line) => /issue|error|failed/i.test(line)) ??
        `Claude Code doctor reported ${health}.`,
  };
}

function parseGrokDoctor(output: ProviderCommandOutput): ProviderDoctorResult {
  const root = object(parseJsonDocument(commandText(output)));
  const findings = Array.isArray(root.findings) ? root.findings : [];
  const checks: ProviderDoctorCheck[] = findings.map((value, index) => {
    const finding = object(value);
    const id = stringValue(finding.id) ?? `finding-${index + 1}`;
    const disposition = String(finding.disposition ?? "").toLowerCase();
    const health: ProviderDoctorHealth =
      disposition === "issue"
        ? id.startsWith("terminal.")
          ? "warning"
          : "error"
        : disposition === "recommendation"
          ? "warning"
          : "ok";
    return {
      id,
      category: id.split(".")[0] ?? "grok",
      health,
      summary:
        stringValue(finding.message) ??
        stringValue(finding.note) ??
        "Grok reported a diagnostic finding.",
      remediation:
        stringValue(finding.remediation) ??
        stringValue(finding.note) ??
        stringValue(finding.automaticRemediation),
    };
  });
  const health =
    output.exitCode !== 0
      ? "error"
      : checks.length === 0
        ? "ok"
        : aggregateHealth(checks);
  return {
    provider: "grok",
    health,
    native: true,
    checks,
    summary:
      checks.length === 0
        ? "Grok doctor reported no findings."
        : `Grok doctor reported ${checks.length} finding${checks.length === 1 ? "" : "s"}.`,
  };
}

function parseCursorModels(output: string): ProviderModel[] {
  const parsed = parseJsonDocument(output);
  const jsonModels = parseGenericModels(parsed);
  if (jsonModels.length > 0) return jsonModels;
  const models: ProviderModel[] = [];
  for (const rawLine of stripAnsi(output).split("\n")) {
    const match = rawLine.match(/^\s*(\S+)\s+(?:-|—)\s+(.+?)\s*$/);
    if (!match) continue;
    const id = safeModelId(match[1]);
    if (!id) continue;
    let displayName = match[2]!.trim();
    let flags = "";
    const marker = displayName.match(/\s+\(([^()]*)\)\s*$/);
    if (marker && /\b(?:current|default)\b/i.test(marker[1]!)) {
      flags = marker[1]!;
      displayName = displayName.slice(0, marker.index).trim();
    }
    models.push({
      id,
      displayName: displayName || undefined,
      isDefault: /\bdefault\b/i.test(flags),
      metadata: {
        current: /\bcurrent\b/i.test(flags),
        source: "cursor-cli",
      },
    });
  }
  return deduplicateModels(models);
}

function parseGenericModels(value: unknown): ProviderModel[] {
  const root = object(value);
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(root.data)
        ? root.data
        : [];
  return deduplicateModels(
    candidates.flatMap((candidate): ProviderModel[] => {
      const model = object(candidate);
      const id = safeModelId(model.id ?? model.model);
      if (!id) return [];
      return [
        {
          id,
          displayName:
            stringValue(model.displayName ?? model.name ?? model.label) ?? undefined,
          isDefault:
            model.isDefault === true ||
            model.default === true ||
            String(model.status ?? "").toLowerCase() === "default",
        },
      ];
    }),
  );
}

function parseCodexModels(value: unknown): ProviderModel[] {
  const root = object(value);
  const candidates = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(value)
        ? value
        : [];
  return deduplicateModels(
    candidates.flatMap((candidate): ProviderModel[] => {
      const model = object(candidate);
      if (model.hidden === true) return [];
      const id = safeModelId(model.id ?? model.model);
      if (!id) return [];
      const efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
            .map((entry) => stringValue(object(entry).reasoningEffort ?? entry))
            .filter((entry): entry is string => Boolean(entry))
        : [];
      const modalities = Array.isArray(model.inputModalities)
        ? model.inputModalities
            .map(stringValue)
            .filter((entry): entry is string => Boolean(entry))
        : [];
      const speedTiers = Array.isArray(model.additionalSpeedTiers)
        ? model.additionalSpeedTiers
            .map(stringValue)
            .filter((entry): entry is string => Boolean(entry))
        : [];
      return [
        {
          id,
          displayName: stringValue(model.displayName) ?? undefined,
          isDefault: model.isDefault === true,
          reasoningEfforts: efforts,
          metadata: {
            description: stringValue(model.description),
            defaultReasoningEffort: stringValue(model.defaultReasoningEffort),
            inputModalities: modalities,
            supportsPersonality: booleanValue(model.supportsPersonality),
            additionalSpeedTiers: speedTiers,
            source: "codex-app-server",
          },
        },
      ];
    }),
  );
}

function deduplicateModels(models: readonly ProviderModel[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const model of models) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].slice(0, MAX_MODELS);
}

function resetTimestamp(value: unknown): string | null {
  const numeric = numberValue(value);
  if (numeric !== null) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizedWindow(
  value: unknown,
  scope: NormalizedRateLimitWindow["scope"],
): NormalizedRateLimitWindow | null {
  const window = object(value);
  if (Object.keys(window).length === 0) return null;
  const used = numberValue(window.usedPercent ?? window.used_percent);
  const boundedUsed = used === null ? null : Math.min(100, Math.max(0, used));
  const durationMinutes = numberValue(
    window.windowDurationMins ??
      window.window_duration_mins ??
      window.windowDurationMinutes,
  );
  return {
    scope,
    usedPercent: boundedUsed,
    remainingPercent: boundedUsed === null ? null : 100 - boundedUsed,
    windowDurationSeconds:
      durationMinutes === null ? null : Math.max(0, durationMinutes * 60),
    resetsAt: resetTimestamp(window.resetsAt ?? window.resets_at),
  };
}

function normalizedCredits(value: unknown): NormalizedCredits | null {
  const credits = object(value);
  if (Object.keys(credits).length === 0) return null;
  const rawBalance = credits.balance;
  return {
    hasCredits: booleanValue(credits.hasCredits ?? credits.has_credits),
    unlimited: booleanValue(credits.unlimited),
    balance:
      typeof rawBalance === "string" || typeof rawBalance === "number"
        ? String(rawBalance)
        : null,
  };
}

function normalizeRateLimits(value: unknown): NormalizedRateLimit[] {
  const root = object(value);
  const byId = object(root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id);
  const entries: Array<[string, unknown]> =
    Object.keys(byId).length > 0
      ? Object.entries(byId)
      : Object.keys(object(root.rateLimits ?? root.rate_limits)).length > 0
        ? [["default", root.rateLimits ?? root.rate_limits]]
        : [];
  const limits: NormalizedRateLimit[] = [];
  for (const [fallbackId, raw] of entries) {
    const limit = object(raw);
    const id = stringValue(limit.limitId ?? limit.limit_id) ?? fallbackId;
    const windows = [
      normalizedWindow(limit.primary, "primary"),
      normalizedWindow(limit.secondary, "secondary"),
      normalizedWindow(limit.individualLimit ?? limit.individual_limit, "individual"),
    ].filter((entry): entry is NormalizedRateLimitWindow => Boolean(entry));
    limits.push({
      id,
      name: stringValue(limit.limitName ?? limit.limit_name),
      plan: stringValue(limit.planType ?? limit.plan_type),
      reachedType: stringValue(limit.rateLimitReachedType ?? limit.rate_limit_reached_type),
      windows,
      credits: normalizedCredits(limit.credits),
    });
  }
  return limits;
}

function unsupported(reason: string): UnsupportedField {
  return { status: "unsupported", value: null, reason };
}

function unavailable(reason: string): UnavailableField {
  return { status: "unavailable", value: null, reason: redactAndBound(reason, 2_000) };
}

function updateAvailability(
  current: string | null,
  latest: string | null,
  status: string | null,
): boolean | null {
  if (
    status &&
    /\b(?:not older|up[- ]?to[- ]?date|already (?:current|latest)|no update)\b/i.test(
      status,
    )
  ) {
    return false;
  }
  if (status && /\b(?:older|update available|outdated)\b/i.test(status)) return true;
  if (status && /\bcurrent\b/i.test(status)) return false;
  if (current && latest) return current === latest ? false : null;
  return null;
}

function mutationSummary(output: ProviderCommandOutput): string {
  const text = commandText(output);
  return text ? redactAndBound(text, 4_000) : "Command completed successfully.";
}

class ProviderAdminService implements ProviderAdministration {
  private readonly executor: ProviderCommandExecutor;
  private readonly codex: CodexReadClient;
  private readonly config: ProviderAdminConfigReader;
  private readonly claudeFullModelIds: string[];

  constructor(options: ProviderAdminOptions) {
    this.executor = options.executor ?? new ExecFileProviderCommandExecutor(options);
    this.codex =
      options.codex ??
      new CodexAppServerReadClient(() => this.executor.locate("codex"), options);
    this.config =
      options.config ??
      new FileProviderAdminConfigReader(
        positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      );
    const candidates = [
      ...BUILTIN_CLAUDE_FULL_MODEL_IDS,
      ...(options.claudeFullModelIds ?? []),
    ];
    for (const id of candidates) {
      if (!isSafeClaudeModelId(id) || (CLAUDE_ALIASES as readonly string[]).includes(id)) {
        throw new Error(`Unsafe Claude full model ID: ${id}`);
      }
    }
    this.claudeFullModelIds = [...new Set(candidates)];
  }

  async providerStatus(provider: Provider): Promise<ProviderStatus> {
    assertProvider(provider);
    let binaryPath: string | null;
    try {
      binaryPath = await this.executor.locate(provider);
    } catch (error) {
      return unavailableStatus(provider, null, safeError(error));
    }
    if (!binaryPath) return unavailableStatus(provider, null);
    if (provider === "cursor") return this.cursorStatus(binaryPath);
    if (provider === "codex") return this.codexStatus(binaryPath);
    if (provider === "claude") return this.claudeStatus(binaryPath);
    if (provider === "grok") return this.grokStatus(binaryPath);
    return this.antigravityStatus(binaryPath);
  }

  async providerUsage(provider: Provider): Promise<ProviderUsage> {
    assertProvider(provider);
    const cost = unsupported(
      `${provider} CLI does not expose normalized account cost through a read-only admin API.`,
    );
    const session = unsupported(
      `${provider} CLI does not expose historical per-session usage through a read-only admin API.`,
    );
    if (provider !== "codex") {
      return {
        provider,
        rateLimits: unsupported(
          `${provider} CLI does not expose account rate limits through a read-only admin API.`,
        ),
        cost,
        session,
      };
    }
    try {
      const [response] = await this.codex.read([
        { method: "account/rateLimits/read" },
      ]);
      const limits = normalizeRateLimits(response);
      return {
        provider,
        rateLimits:
          limits.length > 0
            ? {
                status: "available",
                value: limits,
                source: "codex app-server account/rateLimits/read",
              }
            : unavailable("Codex returned no recognizable rate-limit records."),
        cost,
        session,
      };
    } catch (error) {
      return {
        provider,
        rateLimits: unavailable(safeError(error)),
        cost,
        session,
      };
    }
  }

  async providerDoctor(provider: Provider): Promise<ProviderDoctorResult> {
    assertProvider(provider);
    if (provider === "codex") {
      try {
        const output = await this.executor.run(provider, "doctor");
        return parseCodexDoctor(output);
      } catch (error) {
        return {
          provider,
          health: "unavailable",
          native: true,
          checks: [],
          summary: safeError(error),
        };
      }
    }
    if (provider === "claude") {
      try {
        const output = await this.executor.run(provider, "doctor");
        return parseClaudeDoctor(output);
      } catch (error) {
        return {
          provider,
          health: "unavailable",
          native: true,
          checks: [],
          summary: safeError(error),
        };
      }
    }
    if (provider === "grok") {
      try {
        const output = await this.executor.run(provider, "doctor");
        return parseGrokDoctor(output);
      } catch (error) {
        return {
          provider,
          health: "unavailable",
          native: true,
          checks: [],
          summary: safeError(error),
        };
      }
    }
    if (provider === "antigravity") return this.antigravityDoctor();
    return this.cursorDoctor();
  }

  async providerUpdateCheck(provider: Provider): Promise<ProviderUpdateCheckResult> {
    assertProvider(provider);
    const binaryPath = await this.executor.locate(provider).catch(() => null);
    if (!binaryPath) {
      return {
        provider,
        supported: false,
        currentVersion: null,
        latestVersion: null,
        updateAvailable: null,
        source: "binary lookup",
        reason: "CLI binary was not found.",
      };
    }
    const versionOutput = await this.executor.run(provider, "version").catch(() => null);
    const currentFromCommand = parseVersion(commandText(versionOutput));
    if (provider === "antigravity") {
      return {
        provider,
        supported: false,
        currentVersion: currentFromCommand,
        latestVersion: null,
        updateAvailable: null,
        source: "agy --version",
        reason:
          "Antigravity CLI exposes only a combined update/install command; a read-only check is unavailable.",
      };
    }
    if (provider === "grok") {
      const checkOutput = await this.executor
        .run(provider, "updateCheck")
        .catch(() => null);
      if (!checkOutput) {
        return {
          provider,
          supported: false,
          currentVersion: currentFromCommand,
          latestVersion: null,
          updateAvailable: null,
          source: "grok update --check --json",
          reason: "The read-only Grok update check was unavailable.",
        };
      }
      const check = object(parseJsonDocument(commandText(checkOutput)));
      const current = stringValue(check.currentVersion) ?? currentFromCommand;
      const latest = stringValue(check.latestVersion);
      const available = booleanValue(check.updateAvailable);
      return {
        provider,
        supported: checkOutput.exitCode === 0 && Boolean(current || latest),
        currentVersion: current,
        latestVersion: latest,
        updateAvailable: available,
        source: "grok update --check --json",
        reason:
          checkOutput.exitCode === 0
            ? null
            : stringValue(check.error) ?? "Grok update check failed.",
      };
    }
    if (provider === "cursor") {
      return {
        provider,
        supported: false,
        currentVersion: currentFromCommand,
        latestVersion: null,
        updateAvailable: null,
        source: "cursor-agent --version",
        reason:
          "Cursor Agent exposes only a combined update/install command; a read-only check is unavailable.",
      };
    }
    const doctorOutput = await this.executor.run(provider, "doctor").catch(() => null);
    if (!doctorOutput) {
      return {
        provider,
        supported: false,
        currentVersion: currentFromCommand,
        latestVersion: null,
        updateAvailable: null,
        source: `${provider} doctor`,
        reason: "The read-only doctor command was unavailable.",
      };
    }
    if (provider === "codex") {
      const root = codexDoctorRoot(doctorOutput);
      const current = stringValue(root.codexVersion) ?? currentFromCommand;
      const latest = codexDoctorDetail(root, "updates.status", "latest version");
      const status = codexDoctorDetail(
        root,
        "updates.status",
        "latest version status",
      );
      return {
        provider,
        supported: Boolean(latest || status),
        currentVersion: current,
        latestVersion: latest,
        updateAvailable: updateAvailability(current, latest, status),
        source: "codex doctor --json",
        reason:
          latest || status
            ? null
            : "Codex doctor did not report update metadata.",
      };
    }
    const text = commandText(doctorOutput);
    const latest =
      text.match(/^(?:Latest version|Available version):\s*(\S+)/im)?.[1] ?? null;
    const statusLine =
      text.match(/^(?:Update status|Updates):\s*(.+)$/im)?.[1]?.trim() ?? null;
    return {
      provider,
      supported: Boolean(latest || statusLine),
      currentVersion: currentFromCommand,
      latestVersion: latest,
      updateAvailable: updateAvailability(currentFromCommand, latest, statusLine),
      source: "claude doctor",
      reason:
        latest || statusLine
          ? null
          : "Claude Code doctor does not expose a latest version; the update command may install immediately.",
    };
  }

  async providerUpdate(
    provider: Provider,
    confirmation: MutationConfirmation,
  ): Promise<ProviderUpdateResult> {
    assertProvider(provider);
    if (!ADMIN_CAPABILITIES[provider].update) {
      throw new ProviderAdminError(
        provider,
        "update",
        "the provider CLI update operation has not been verified",
      );
    }
    this.requireConfirmation(
      provider,
      "update",
      confirmation,
      PROVIDER_UPDATE_CONFIRMATIONS[provider],
    );
    const beforeVersion = await this.readVersion(provider);
    const output = requireSuccess(
      provider,
      "update",
      await this.executor.run(provider, "update"),
    );
    const afterVersion = await this.readVersion(provider);
    return {
      provider,
      operation: "update",
      beforeVersion,
      afterVersion,
      changed:
        beforeVersion && afterVersion ? beforeVersion !== afterVersion : null,
      summary: mutationSummary(output),
    };
  }

  async providerLogout(
    provider: Provider,
    confirmation: MutationConfirmation,
  ): Promise<ProviderLogoutResult> {
    assertProvider(provider);
    if (!ADMIN_CAPABILITIES[provider].logout) {
      throw new ProviderAdminError(
        provider,
        "logout",
        "the provider CLI does not expose a logout command",
      );
    }
    this.requireConfirmation(
      provider,
      "logout",
      confirmation,
      PROVIDER_LOGOUT_CONFIRMATIONS[provider],
    );
    const output = requireSuccess(
      provider,
      "logout",
      await this.executor.run(provider, "logout"),
    );
    return {
      provider,
      operation: "logout",
      summary: mutationSummary(output),
    };
  }

  async listProviderModels(provider: Provider): Promise<ProviderModel[]> {
    assertProvider(provider);
    if (provider === "cursor") {
      const output = requireSuccess(
        provider,
        "models",
        await this.executor.run(provider, "models"),
      );
      return parseCursorModels(output.stdout);
    }
    if (provider === "codex") return this.listCodexModels();
    if (provider === "antigravity") {
      const output = requireSuccess(
        provider,
        "models",
        await this.executor.run(provider, "models"),
      );
      return parseAntigravityModels(commandText(output));
    }
    if (provider === "grok") {
      const output = requireSuccess(
        provider,
        "models",
        await this.executor.run(provider, "models"),
      );
      return parseGrokModels(commandText(output));
    }
    const settings = object(await this.config.readClaudeSettings());
    const configured = stringValue(settings.model);
    const verifiedConfigured =
      configured && isSafeClaudeModelId(configured) ? configured : null;
    const models: ProviderModel[] = CLAUDE_ALIASES.map((id) => ({
      id,
      displayName: `${id[0]!.toUpperCase()}${id.slice(1)} (current alias)`,
      isDefault: verifiedConfigured === id,
      metadata: { kind: "alias", source: "claude-cli-help" },
    }));
    const fullIds = [...this.claudeFullModelIds];
    if (
      verifiedConfigured &&
      !(CLAUDE_ALIASES as readonly string[]).includes(verifiedConfigured) &&
      !fullIds.includes(verifiedConfigured)
    ) {
      fullIds.push(verifiedConfigured);
    }
    for (const id of fullIds) {
      models.push({
        id,
        displayName: id,
        isDefault: verifiedConfigured === id,
        metadata: {
          kind: "full-id",
          source: id === verifiedConfigured ? "claude-settings" : "conservative-catalog",
        },
      });
    }
    return deduplicateModels(models);
  }

  private async cursorStatus(binaryPath: string): Promise<ProviderStatus> {
    const warnings: string[] = [];
    const [versionResult, authResult, aboutResult] = await Promise.allSettled([
      this.executor.run("cursor", "version"),
      this.executor.run("cursor", "authStatus"),
      this.executor.run("cursor", "about"),
    ]);
    const versionOutput = this.settledOutput(versionResult, "version", warnings);
    const authOutput = this.settledOutput(authResult, "auth status", warnings);
    const aboutOutput = this.settledOutput(aboutResult, "about", warnings);
    const status = object(parseJsonDocument(commandText(authOutput)));
    const about = object(parseJsonDocument(commandText(aboutOutput)));
    const configuredModel = modelFromLabel(about.model);
    return {
      provider: "cursor",
      installed: true,
      version: stringValue(about.cliVersion) ?? parseVersion(commandText(versionOutput)),
      binaryPath,
      auth: accountFromCursor(status, about),
      configuredModel,
      defaultModel: configuredModel,
      defaultModelSource: configuredModel ? "provider" : "unknown",
      capabilities: providerCapabilities("cursor"),
      warnings,
    };
  }

  private async codexStatus(binaryPath: string): Promise<ProviderStatus> {
    const warnings: string[] = [];
    const [versionResult, authResult, doctorResult, rpcResult] =
      await Promise.allSettled([
        this.executor.run("codex", "version"),
        this.executor.run("codex", "authStatus"),
        this.executor.run("codex", "doctor"),
        this.codex.read([{ method: "account/read" }, { method: "model/list" }]),
      ]);
    const versionOutput = this.settledOutput(versionResult, "version", warnings);
    const authOutput = this.settledOutput(authResult, "auth status", warnings);
    const doctorOutput = this.settledOutput(doctorResult, "doctor", warnings, true);
    const doctor = codexDoctorRoot(doctorOutput);
    const rpc =
      rpcResult.status === "fulfilled"
        ? rpcResult.value
        : (warnings.push(`app-server: ${safeError(rpcResult.reason)}`), []);
    const account = rpc[0];
    const models = parseCodexModels(rpc[1]);
    return {
      provider: "codex",
      installed: true,
      version: stringValue(doctor.codexVersion) ?? parseVersion(commandText(versionOutput)),
      binaryPath,
      auth: accountFromCodex(account, commandText(authOutput)),
      configuredModel: codexDoctorDetail(doctor, "config.load", "model"),
      defaultModel: models.find((model) => model.isDefault)?.id ?? null,
      defaultModelSource: models.some((model) => model.isDefault)
        ? "provider"
        : "unknown",
      capabilities: providerCapabilities("codex"),
      warnings,
    };
  }

  private async claudeStatus(binaryPath: string): Promise<ProviderStatus> {
    const warnings: string[] = [];
    const [versionResult, authResult, settingsResult] = await Promise.allSettled([
      this.executor.run("claude", "version"),
      this.executor.run("claude", "authStatus"),
      this.config.readClaudeSettings(),
    ]);
    const versionOutput = this.settledOutput(versionResult, "version", warnings);
    const authOutput = this.settledOutput(authResult, "auth status", warnings);
    const settings =
      settingsResult.status === "fulfilled"
        ? object(settingsResult.value)
        : (warnings.push(`settings: ${safeError(settingsResult.reason)}`), {});
    const configuredCandidate = stringValue(settings.model);
    const configuredModel =
      configuredCandidate && isSafeClaudeModelId(configuredCandidate)
        ? configuredCandidate
        : null;
    if (configuredCandidate && !configuredModel) {
      warnings.push("Configured Claude model was omitted because it is not a safe model ID.");
    }
    return {
      provider: "claude",
      installed: true,
      version: parseVersion(commandText(versionOutput)),
      binaryPath,
      auth: accountFromClaude(parseJsonDocument(commandText(authOutput))),
      configuredModel,
      defaultModel: configuredModel,
      defaultModelSource: configuredModel ? "configured" : "unknown",
      capabilities: providerCapabilities("claude"),
      warnings,
    };
  }

  private async grokStatus(binaryPath: string): Promise<ProviderStatus> {
    const warnings: string[] = [];
    const [versionResult, authResult] = await Promise.allSettled([
      this.executor.run("grok", "version"),
      this.executor.run("grok", "authStatus"),
    ]);
    const versionOutput = this.settledOutput(versionResult, "version", warnings);
    const authOutput = this.settledOutput(authResult, "auth status", warnings);
    const authText = commandText(authOutput);
    const models = parseGrokModels(authText);
    const defaultModel = models.find((model) => model.isDefault)?.id ?? null;
    return {
      provider: "grok",
      installed: true,
      version: parseVersion(commandText(versionOutput)),
      binaryPath,
      auth: accountFromGrok(authText),
      configuredModel: null,
      defaultModel,
      defaultModelSource: defaultModel ? "provider" : "unknown",
      capabilities: providerCapabilities("grok"),
      warnings,
    };
  }

  private async antigravityStatus(binaryPath: string): Promise<ProviderStatus> {
    const warnings: string[] = [];
    const [versionResult, authResult] = await Promise.allSettled([
      this.executor.run("antigravity", "version"),
      this.executor.run("antigravity", "authStatus"),
    ]);
    const versionOutput = this.settledOutput(versionResult, "version", warnings);
    const authOutput = this.settledOutput(authResult, "auth status", warnings);
    const authText = commandText(authOutput);
    const models = parseAntigravityModels(authText);
    const defaultModel = models.find((model) => model.isDefault)?.id ?? null;
    return {
      provider: "antigravity",
      installed: true,
      version: parseVersion(commandText(versionOutput)),
      binaryPath,
      auth: accountFromAntigravity(authText),
      configuredModel: null,
      defaultModel,
      defaultModelSource: defaultModel ? "provider" : "unknown",
      capabilities: providerCapabilities("antigravity"),
      warnings,
    };
  }

  private async antigravityDoctor(): Promise<ProviderDoctorResult> {
    const status = await this.providerStatus("antigravity");
    const checks: ProviderDoctorCheck[] = [
      {
        id: "installation",
        category: "installation",
        health: status.installed ? "ok" : "error",
        summary: status.installed
          ? `Antigravity CLI ${status.version ?? "version unknown"} is installed.`
          : "Antigravity CLI is not installed.",
        remediation: status.installed
          ? null
          : "Install the antigravity-cli Homebrew cask.",
      },
      {
        id: "authentication",
        category: "auth",
        health:
          status.auth.state === "authenticated"
            ? "ok"
            : status.auth.state === "unauthenticated"
              ? "error"
              : "warning",
        summary: status.auth.summary,
        remediation:
          status.auth.state === "authenticated"
            ? null
            : "Launch `agy` interactively and complete Google authentication.",
      },
      {
        id: "models",
        category: "models",
        health: status.defaultModel ? "ok" : "warning",
        summary: status.defaultModel
          ? `Antigravity default model is ${status.defaultModel}.`
          : "Antigravity returned no model catalog.",
        remediation: null,
      },
    ];
    return {
      provider: "antigravity",
      health: aggregateHealth(checks),
      native: false,
      checks,
      summary:
        "Antigravity has no native doctor command; installation, authentication, and models were probed read-only.",
    };
  }

  private async cursorDoctor(): Promise<ProviderDoctorResult> {
    const checks: ProviderDoctorCheck[] = [];
    const status = await this.providerStatus("cursor");
    checks.push({
      id: "installation",
      category: "installation",
      health: status.installed ? "ok" : "error",
      summary: status.installed
        ? `Cursor Agent ${status.version ?? "version unknown"} is installed.`
        : "Cursor Agent is not installed.",
      remediation: status.installed ? null : "Install Cursor Agent and ensure it is on PATH.",
    });
    checks.push({
      id: "authentication",
      category: "auth",
      health:
        status.auth.state === "authenticated"
          ? "ok"
          : status.auth.state === "unauthenticated"
            ? "error"
            : "warning",
      summary: status.auth.summary,
      remediation:
        status.auth.state === "authenticated" ? null : "Run `cursor-agent login` interactively.",
    });
    if (status.installed) {
      try {
        const models = await this.listProviderModels("cursor");
        checks.push({
          id: "models",
          category: "models",
          health: models.length > 0 ? "ok" : "warning",
          summary:
            models.length > 0
              ? `${models.length} Cursor models are available.`
              : "Cursor returned an empty model catalog.",
          remediation: null,
        });
      } catch (error) {
        checks.push({
          id: "models",
          category: "models",
          health: "error",
          summary: safeError(error),
          remediation: "Check Cursor authentication and network access.",
        });
      }
    }
    return {
      provider: "cursor",
      health: aggregateHealth(checks),
      native: false,
      checks,
      summary: "Cursor has no native doctor command; installation, auth, and model discovery were probed read-only.",
    };
  }

  private async listCodexModels(): Promise<ProviderModel[]> {
    const all: ProviderModel[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CODEX_MODEL_PAGES; page += 1) {
      const [response] = await this.codex.read([
        {
          method: "model/list",
          params: cursor === undefined ? {} : { cursor },
        },
      ]);
      all.push(...parseCodexModels(response));
      if (all.length >= MAX_MODELS) break;
      const next = stringValue(object(response).nextCursor ?? object(response).next_cursor);
      if (!next) break;
      if (cursors.has(next)) {
        throw new ProviderAdminError("codex", "models", "model pagination cursor repeated");
      }
      cursors.add(next);
      cursor = next;
    }
    return deduplicateModels(all);
  }

  private settledOutput(
    result: PromiseSettledResult<ProviderCommandOutput>,
    operation: string,
    warnings: string[],
    allowNonZero = false,
  ): ProviderCommandOutput | null {
    if (result.status === "rejected") {
      warnings.push(`${operation}: ${safeError(result.reason)}`);
      return null;
    }
    if (!allowNonZero && result.value.exitCode !== 0) {
      warnings.push(
        `${operation}: command exited ${String(result.value.exitCode)}${
          commandText(result.value) ? `: ${commandText(result.value)}` : ""
        }`,
      );
    }
    return result.value;
  }

  private async readVersion(provider: Provider): Promise<string | null> {
    try {
      const output = requireSuccess(
        provider,
        "version",
        await this.executor.run(provider, "version"),
      );
      return parseVersion(commandText(output));
    } catch {
      return null;
    }
  }

  private requireConfirmation(
    provider: Provider,
    operation: "update" | "logout",
    provided: MutationConfirmation,
    required: string,
  ): void {
    if (!provided || provided.confirmation !== required) {
      throw new ProviderMutationConfirmationError(provider, operation, required);
    }
  }
}

export function createProviderAdmin(
  options: ProviderAdminOptions = {},
): ProviderAdministration {
  return new ProviderAdminService(options);
}

let defaultProviderAdmin: ProviderAdministration | undefined;

function defaults(): ProviderAdministration {
  defaultProviderAdmin ??= createProviderAdmin();
  return defaultProviderAdmin;
}

export function providerStatus(provider: Provider): Promise<ProviderStatus> {
  return defaults().providerStatus(provider);
}

export function providerUsage(provider: Provider): Promise<ProviderUsage> {
  return defaults().providerUsage(provider);
}

export function providerDoctor(provider: Provider): Promise<ProviderDoctorResult> {
  return defaults().providerDoctor(provider);
}

export function providerUpdateCheck(
  provider: Provider,
): Promise<ProviderUpdateCheckResult> {
  return defaults().providerUpdateCheck(provider);
}

export function providerUpdate(
  provider: Provider,
  confirmation: MutationConfirmation,
): Promise<ProviderUpdateResult> {
  return defaults().providerUpdate(provider, confirmation);
}

export function providerLogout(
  provider: Provider,
  confirmation: MutationConfirmation,
): Promise<ProviderLogoutResult> {
  return defaults().providerLogout(provider, confirmation);
}

export function listProviderModels(provider: Provider): Promise<ProviderModel[]> {
  return defaults().listProviderModels(provider);
}
