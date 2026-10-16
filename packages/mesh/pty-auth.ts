import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSafeEnv,
  ensurePrivateDirectory,
  isProcessAlive,
  redactSecrets,
  resolveTrustedProviderExecutable,
  stateDirectory,
} from "./security.js";
import { PROVIDERS, type Provider } from "./types.js";

export const AUTH_CHALLENGE_STATUSES = [
  "queued",
  "running",
  "waiting_for_browser",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AuthChallengeStatus = (typeof AUTH_CHALLENGE_STATUSES)[number];
export type AuthChallengeTarget = "provider" | "mcp";
export type AuthOperation = "login" | "logout";

export interface StartAuthChallengeInput {
  target: AuthChallengeTarget;
  provider: Provider;
  operation?: AuthOperation;
  serverName?: string;
  /**
   * Logout is destructive credential removal. The broker rejects every logout
   * unless this value is literally true.
   */
  confirmLogout?: boolean;
  /**
   * Needed for project-scoped MCP configurations. Provider-level auth defaults
   * to the user's home directory.
   */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Flat, scalar-only metadata so the same shape can be stored as JSON or mapped
 * directly to a future SQLite table. Raw terminal output and submitted input
 * are deliberately absent.
 */
export interface AuthChallengeRecord {
  id: string;
  target: AuthChallengeTarget;
  provider: Provider;
  operation: AuthOperation;
  serverName: string | null;
  status: AuthChallengeStatus;
  authorizationUrl: string | null;
  deviceCode: string | null;
  safePrompt: string | null;
  error: string | null;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  ownerPid: number | null;
}

export interface AuthChallengeFilter {
  target?: AuthChallengeTarget;
  provider?: Provider;
  status?: AuthChallengeStatus;
  limit?: number;
}

export interface AuthCommand {
  command: "cursor-agent" | "codex" | "claude" | "grok" | "agy";
  args: readonly string[];
}

export interface AuthInvocation extends AuthCommand {
  target: AuthChallengeTarget;
  provider: Provider;
  operation: AuthOperation;
  serverName: string | null;
  cwd: string;
}

export interface AuthExecutionOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface AuthExecution {
  completion: Promise<AuthExecutionOutcome>;
  write(input: string): Promise<void>;
  cancel(): Promise<void>;
}

export interface AuthExecutionObserver {
  onOutput(chunk: string): void;
}

export interface AuthExecutor {
  start(
    invocation: Readonly<AuthInvocation>,
    observer: AuthExecutionObserver,
  ): Promise<AuthExecution>;
}

export interface AuthChallengeStore {
  save(record: Readonly<AuthChallengeRecord>): Promise<void>;
  list(): Promise<AuthChallengeRecord[]>;
}

export interface InteractiveAuthBrokerOptions {
  store?: AuthChallengeStore;
  executor?: AuthExecutor;
  maxConcurrent?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
}

interface NormalizedStart {
  target: AuthChallengeTarget;
  provider: Provider;
  operation: AuthOperation;
  serverName: string | null;
  cwd: string;
  timeoutMs: number;
}

interface ChallengeRuntime {
  record: AuthChallengeRecord;
  cwd: string;
  outputBytes: number;
  scanBuffer: string;
  acceptingAuthorizationUrl: boolean;
  seenPrompts: Set<string>;
  execution?: AuthExecution;
  executionPromise?: Promise<AuthExecution>;
  timer?: NodeJS.Timeout;
  persistenceTail: Promise<void>;
}

const STATUS_SET = new Set<string>(AUTH_CHALLENGE_STATUSES);
const PROVIDER_SET = new Set<string>(PROVIDERS);
const TERMINAL_STATUSES = new Set<AuthChallengeStatus>([
  "completed",
  "failed",
  "cancelled",
]);
const ACTIVE_STATUSES = new Set<AuthChallengeStatus>([
  "queued",
  "running",
  "waiting_for_browser",
  "waiting_for_input",
]);
const SERVER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const CHALLENGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const SCAN_BUFFER_BYTES = 16 * 1_024;
const MAX_INPUT_BYTES = 8 * 1_024;
const SCRIPT_PATH = "/usr/bin/script";
const PTY_RUNNER_PATH = fileURLToPath(new URL("./bin/pty-runner.py", import.meta.url));
const AUTH_URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

const SAFE_PROMPTS = {
  redirect: "Paste the browser redirect URL or one-time authorization code.",
  code: "Enter the one-time authorization code shown by the provider.",
  enter: "Press Enter to continue the authentication flow.",
} as const;

function isTerminal(status: AuthChallengeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function cloneRecord(record: Readonly<AuthChallengeRecord>): AuthChallengeRecord {
  return { ...record };
}

function assertBoundedInteger(
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

function assertProvider(value: unknown): Provider {
  if (typeof value !== "string" || !PROVIDER_SET.has(value)) {
    throw new TypeError(`provider must be one of: ${PROVIDERS.join(", ")}.`);
  }
  return value as Provider;
}

function assertTarget(value: unknown): AuthChallengeTarget {
  if (value !== "provider" && value !== "mcp") {
    throw new TypeError("target must be provider or mcp.");
  }
  return value;
}

function assertOperation(value: unknown): AuthOperation {
  if (value !== "login" && value !== "logout") {
    throw new TypeError("operation must be login or logout.");
  }
  return value;
}

function assertServerName(value: unknown): string {
  if (typeof value !== "string" || !SERVER_NAME_PATTERN.test(value)) {
    throw new TypeError(
      "serverName must be 1-128 ASCII letters, numbers, periods, underscores, or hyphens.",
    );
  }
  return value;
}

function commandFor(
  target: AuthChallengeTarget,
  provider: Provider,
  operation: AuthOperation,
  serverName: string | null,
): AuthCommand {
  if (target === "provider") {
    if (serverName !== null) {
      throw new TypeError("serverName is only valid for downstream MCP authentication.");
    }
    if (operation === "login") {
      switch (provider) {
        case "cursor":
          return { command: "cursor-agent", args: ["login"] };
        case "codex":
          // Device auth avoids accepting API/access tokens over stdin.
          return { command: "codex", args: ["login", "--device-auth"] };
        case "claude":
          return { command: "claude", args: ["auth", "login"] };
        case "grok":
          return { command: "grok", args: ["login", "--device-auth"] };
        case "antigravity":
          return {
            command: "agy",
            args: ["--print", "Reply exactly AUTHENTICATED"],
          };
      }
    }
    switch (provider) {
      case "cursor":
        return { command: "cursor-agent", args: ["logout"] };
      case "codex":
        return { command: "codex", args: ["logout"] };
      case "claude":
        return { command: "claude", args: ["auth", "logout"] };
      case "grok":
        return { command: "grok", args: ["logout"] };
      case "antigravity":
        throw new Error("Antigravity CLI does not expose a logout command.");
    }
  }

  if (serverName === null) {
    throw new TypeError("serverName is required for downstream MCP authentication.");
  }
  if (operation === "login") {
    switch (provider) {
      case "cursor":
        return { command: "cursor-agent", args: ["mcp", "login", serverName] };
      case "codex":
        return { command: "codex", args: ["mcp", "login", serverName] };
      case "claude":
        return {
          command: "claude",
          args: ["mcp", "login", "--no-browser", serverName],
        };
      case "grok":
        throw new Error("Grok does not expose a downstream MCP login command.");
      case "antigravity":
        throw new Error(
          "Antigravity CLI does not expose a downstream MCP login command.",
        );
    }
  }
  switch (provider) {
    case "cursor":
      throw new Error("Cursor does not expose a downstream MCP logout command.");
    case "codex":
      return { command: "codex", args: ["mcp", "logout", serverName] };
    case "claude":
      return { command: "claude", args: ["mcp", "logout", serverName] };
    case "grok":
      throw new Error("Grok does not expose a downstream MCP logout command.");
    case "antigravity":
      throw new Error(
        "Antigravity CLI does not expose a downstream MCP logout command.",
      );
  }
}

/**
 * The only command construction entry point. No caller-provided command,
 * option, shell fragment, environment override, or extra argv is accepted.
 */
export function buildAuthCommand(input: StartAuthChallengeInput): AuthCommand {
  const target = assertTarget(input.target);
  const provider = assertProvider(input.provider);
  const operation = assertOperation(input.operation ?? "login");
  if (operation === "logout" && input.confirmLogout !== true) {
    throw new Error("Logout requires confirmLogout: true.");
  }
  const serverName =
    target === "mcp"
      ? assertServerName(input.serverName)
      : input.serverName === undefined
        ? null
        : (() => {
            throw new TypeError(
              "serverName is only valid for downstream MCP authentication.",
            );
          })();
  const command = commandFor(target, provider, operation, serverName);
  return Object.freeze({
    command: command.command,
    args: Object.freeze([...command.args]),
  });
}

function assertAllowedInvocation(invocation: Readonly<AuthInvocation>): void {
  const expected = commandFor(
    assertTarget(invocation.target),
    assertProvider(invocation.provider),
    assertOperation(invocation.operation),
    invocation.target === "mcp" ? assertServerName(invocation.serverName) : null,
  );
  if (
    invocation.command !== expected.command ||
    invocation.args.length !== expected.args.length ||
    invocation.args.some((argument, index) => argument !== expected.args[index])
  ) {
    throw new Error("Refusing a non-allowlisted authentication invocation.");
  }
}

async function canonicalDirectory(raw: string | undefined): Promise<string> {
  const candidate = raw ?? homedir();
  if (!isAbsolute(candidate) || candidate.includes("\0")) {
    throw new TypeError("cwd must be an absolute directory path.");
  }
  const canonical = await realpath(candidate);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new TypeError("cwd must reference a directory.");
  return canonical;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(
      // CSI, OSC, and common single-character ANSI escape sequences.
      /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu,
      "",
    )
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/gu, "");
}

function trimUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function trimUrlPunctuation(value: string): string {
  let result = value;
  while (/[),.;\]}]$/u.test(result)) result = result.slice(0, -1);
  return result;
}

function sanitizeAuthorizationUrl(raw: string): string | null {
  try {
    const parsed = new URL(trimUrlPunctuation(raw));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    const safeCodeKeys = new Set(["code_challenge", "code_challenge_method"]);
    for (const key of [...parsed.searchParams.keys()]) {
      if (safeCodeKeys.has(key.toLowerCase())) continue;
      if (
        /(?:^|[_-])(?:token|secret|password|api[_-]?key|access[_-]?key|authorization[_-]?code|code)(?:$|[_-])/iu.test(
          key,
        )
      ) {
        parsed.searchParams.set(key, "REDACTED");
      }
    }
    if (/(?:access_token|id_token|refresh_token|api[_-]?key|secret)=/iu.test(parsed.hash)) {
      parsed.hash = "";
    }
    return trimUtf8(parsed.toString(), 8 * 1_024);
  } catch {
    return null;
  }
}

function firstAuthorizationUrl(value: string): string | null {
  for (const match of value.matchAll(AUTH_URL_PATTERN)) {
    const safe = sanitizeAuthorizationUrl(match[0]);
    if (safe) return safe;
  }
  return null;
}

function withoutUrls(value: string): string {
  return value.replace(AUTH_URL_PATTERN, "[authorization URL]");
}

function deviceCodeFrom(value: string): string | null {
  const match =
    /(?:device|verification|one[- ]time|user)\s+code(?:\s+is)?\s*[:=]?\s*([A-Z0-9](?:[A-Z0-9-]{4,30}[A-Z0-9]))/iu.exec(
      value,
    );
  if (!match?.[1]) return null;
  const code = match[1];
  return /^[A-Z0-9][A-Z0-9-]{5,31}$/iu.test(code) ? code : null;
}

function containsCredentialPrompt(value: string): boolean {
  const text = withoutUrls(value);
  return (
    /--with-(?:api-key|access-token)\b/iu.test(text) ||
    /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|CURSOR_API_KEY|XAI_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY)\b/u.test(
      text,
    ) ||
    /\b(?:enter|paste|type|provide|input|supply)\b[\s\S]{0,80}\b(?:password|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key)\b/iu.test(
      text,
    ) ||
    /\b(?:password|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key)\b[\s\S]{0,80}\b(?:stdin|terminal|prompt)\b/iu.test(
      text,
    )
  );
}

function safePromptFrom(value: string): string | null {
  const text = withoutUrls(value);
  if (
    /\b(?:paste|enter|provide)\b[\s\S]{0,100}\b(?:redirect|callback)\b[\s\S]{0,60}\b(?:url|uri)\b/iu.test(
      text,
    ) ||
    /\b(?:redirect|callback)\b[\s\S]{0,60}\b(?:url|uri)\b[\s\S]{0,100}\b(?:paste|enter|provide)\b/iu.test(
      text,
    )
  ) {
    return SAFE_PROMPTS.redirect;
  }
  if (
    /\b(?:paste|enter|provide)\b[\s\S]{0,80}\b(?:one[- ]time\s+)?authorization\s+code\b/iu.test(
      text,
    ) ||
    /\bauthorization\s+code\b[\s\S]{0,80}\b(?:paste|enter|provide)\b/iu.test(text)
  ) {
    return SAFE_PROMPTS.code;
  }
  if (/\bpress\s+(?:the\s+)?enter\b/iu.test(text)) return SAFE_PROMPTS.enter;
  return null;
}

function indicatesBrowserWait(value: string): boolean {
  return (
    /https?:\/\//iu.test(value) ||
    /\b(?:open|visit|continue in|waiting for)\b[\s\S]{0,60}\b(?:browser|authorization|authentication)\b/iu.test(
      withoutUrls(value),
    )
  );
}

function validateSubmittedInput(input: unknown): string {
  if (typeof input !== "string") throw new TypeError("challenge input must be a string.");
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
    throw new RangeError(`challenge input must not exceed ${MAX_INPUT_BYTES} bytes.`);
  }
  if (input.includes("\n") || input.includes("\r") || input.includes("\0")) {
    throw new TypeError("challenge input must be a single terminal line.");
  }
  if (input === "") return input;
  if (
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(input) ||
    /^(?:Bearer\s+|sk-|xai-|pplx-|gh[oprsu]_|github_pat_|xox[baprs]-|glpat-|AIza|ya29\.)/iu.test(
      input,
    )
  ) {
    throw new Error("Credential values are not accepted by the authentication broker.");
  }
  try {
    const parsed = new URL(input);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("Only credential-free HTTP(S) redirect URLs are accepted.");
    }
    return input;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Only credential-free")) throw error;
  }
  if (!/^[A-Za-z0-9._~+/%=-]{1,4096}$/u.test(input)) {
    throw new TypeError("challenge input must be a redirect URL or one-time authorization code.");
  }
  return input;
}

function safeRecordError(message: string): string {
  return trimUtf8(redactSecrets(message), 1_024);
}

function validTimestamp(value: unknown, field: string, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
    throw new Error(`Stored authentication challenge has an invalid ${field}.`);
  }
  return new Date(value).toISOString();
}

function normalizeStoredRecord(value: unknown): AuthChallengeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored authentication challenge must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !CHALLENGE_ID_PATTERN.test(record.id)) {
    throw new Error("Stored authentication challenge has an invalid id.");
  }
  const target = assertTarget(record.target);
  const provider = assertProvider(record.provider);
  const operation = assertOperation(record.operation);
  if (typeof record.status !== "string" || !STATUS_SET.has(record.status)) {
    throw new Error("Stored authentication challenge has an invalid status.");
  }
  const serverName =
    target === "mcp"
      ? assertServerName(record.serverName)
      : record.serverName === null
        ? null
        : (() => {
            throw new Error("Stored provider challenge must not have a server name.");
          })();
  const authorizationUrl =
    record.authorizationUrl === null
      ? null
      : typeof record.authorizationUrl === "string"
        ? sanitizeAuthorizationUrl(record.authorizationUrl)
        : null;
  if (record.authorizationUrl !== null && !authorizationUrl) {
    throw new Error("Stored authentication challenge has an invalid authorization URL.");
  }
  const deviceCode =
    record.deviceCode === null
      ? null
      : typeof record.deviceCode === "string" &&
          /^[A-Z0-9][A-Z0-9-]{5,31}$/iu.test(record.deviceCode)
        ? record.deviceCode
        : (() => {
            throw new Error("Stored authentication challenge has an invalid device code.");
          })();
  const safePrompt =
    record.safePrompt === null
      ? null
      : typeof record.safePrompt === "string" &&
          Object.values(SAFE_PROMPTS).includes(
            record.safePrompt as (typeof SAFE_PROMPTS)[keyof typeof SAFE_PROMPTS],
          )
        ? record.safePrompt
        : (() => {
            throw new Error("Stored authentication challenge has an unsafe prompt.");
          })();
  const error =
    record.error === null
      ? null
      : typeof record.error === "string"
        ? safeRecordError(record.error)
        : (() => {
            throw new Error("Stored authentication challenge has an invalid error.");
          })();
  return {
    id: record.id,
    target,
    provider,
    operation,
    serverName,
    status: record.status as AuthChallengeStatus,
    authorizationUrl,
    deviceCode,
    safePrompt,
    error,
    timeoutMs: assertBoundedInteger(
      Number(record.timeoutMs),
      "stored timeoutMs",
      10,
      DEFAULT_MAX_TIMEOUT_MS,
    ),
    createdAt: validTimestamp(record.createdAt, "createdAt", false)!,
    updatedAt: validTimestamp(record.updatedAt, "updatedAt", false)!,
    startedAt: validTimestamp(record.startedAt, "startedAt", true),
    expiresAt: validTimestamp(record.expiresAt, "expiresAt", true),
    completedAt: validTimestamp(record.completedAt, "completedAt", true),
    ownerPid:
      typeof record.ownerPid === "number" &&
      Number.isSafeInteger(record.ownerPid) &&
      record.ownerPid > 1
        ? record.ownerPid
        : null,
  };
}

export class FileAuthChallengeStore implements AuthChallengeStore {
  readonly directory: string;

  constructor(directory = join(stateDirectory(), "auth-challenges")) {
    this.directory = directory;
  }

  private async prepare(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Authentication challenge store must be a real directory.");
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error("Authentication challenge store must be private.");
    }
  }

  private pathFor(id: string): string {
    if (!CHALLENGE_ID_PATTERN.test(id)) throw new Error("Invalid authentication challenge id.");
    return join(this.directory, `${id}.json`);
  }

  async save(record: Readonly<AuthChallengeRecord>): Promise<void> {
    const normalized = normalizeStoredRecord(record);
    await this.prepare();
    const target = this.pathFor(normalized.id);
    const temporary = join(this.directory, `.${normalized.id}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(normalized)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      renamed = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  async list(): Promise<AuthChallengeRecord[]> {
    await this.prepare();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const records: AuthChallengeRecord[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Authentication challenge store contains a non-regular record.");
      }
      const id = entry.name.slice(0, -".json".length);
      const path = this.pathFor(id);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
        throw new Error("Authentication challenge record must be a private regular file.");
      }
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      records.push(normalizeStoredRecord(parsed));
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

function tailByBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let bytes = 0;
  const characters = [...value];
  let index = characters.length;
  while (index > 0) {
    const size = Buffer.byteLength(characters[index - 1]!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index -= 1;
  }
  return characters.slice(index).join("");
}

async function signalProcess(
  pid: number | undefined,
  signal: NodeJS.Signals,
  settled: () => boolean,
): Promise<void> {
  if (!pid || settled()) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class TerminalAuthExecutor implements AuthExecutor {
  async start(
    invocation: Readonly<AuthInvocation>,
    observer: AuthExecutionObserver,
  ): Promise<AuthExecution> {
    assertAllowedInvocation(invocation);
    const safeEnvironment = buildSafeEnv({
      CI: "0",
      NO_OPEN_BROWSER: "1",
      TERM: "xterm-256color",
    });
    const env = Object.fromEntries(
      Object.entries(safeEnvironment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const providerBinary = await resolveTrustedProviderExecutable(invocation.command);
    const child = spawn(
      "/usr/bin/python3",
      [PTY_RUNNER_PATH, "--", providerBinary, ...invocation.args],
      {
      cwd: invocation.cwd,
      env,
        detached: false,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer | string) => observer.onOutput(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer | string) => observer.onOutput(chunk.toString()));

    let settled = false;
    let terminatePromise: Promise<void> | undefined;
    const completion = new Promise<AuthExecutionOutcome>((resolve) => {
      const finish = (outcome: AuthExecutionOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      child.once("error", () => {
        finish({
          exitCode: null,
          signal: null,
          error: "Authentication executable could not be started.",
        });
      });
      child.once("close", (exitCode, signal) => {
        finish({ exitCode, signal });
      });
    });

    const cancel = async () => {
      if (terminatePromise) return terminatePromise;
      terminatePromise = (async () => {
        if (settled) return;
        await signalProcess(child.pid, "SIGINT", () => settled);
        await Promise.race([completion.then(() => undefined), delay(500)]);
        if (settled) return;
        await signalProcess(child.pid, "SIGTERM", () => settled);
        await Promise.race([completion.then(() => undefined), delay(1_000)]);
        if (settled) return;
        await signalProcess(child.pid, "SIGKILL", () => settled);
        await Promise.race([completion.then(() => undefined), delay(1_000)]);
      })();
      return terminatePromise;
    };

    return {
      completion,
      async write(input: string) {
        if (settled) {
          throw new Error("Authentication process is no longer accepting input.");
        }
        if (child.stdin.destroyed) {
          throw new Error("Authentication process is no longer accepting input.");
        }
        await new Promise<void>((resolve, reject) => {
          child.stdin.write(`${input}\n`, (error) => {
            if (error) reject(new Error("Authentication input could not be delivered."));
            else resolve();
          });
        });
      },
      cancel,
    };
  }
}

function transitionAllowed(
  from: AuthChallengeStatus,
  to: AuthChallengeStatus,
): boolean {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  if (to === "failed" || to === "cancelled") return true;
  if (from === "queued") return to === "running";
  if (to === "completed") return true;
  if (to === "running") {
    return from === "waiting_for_browser" || from === "waiting_for_input";
  }
  if (to === "waiting_for_browser") {
    return from === "running" || from === "waiting_for_input";
  }
  if (to === "waiting_for_input") {
    return from === "running" || from === "waiting_for_browser";
  }
  return false;
}

export class InteractiveAuthBroker {
  private readonly store: AuthChallengeStore;
  private readonly executor: AuthExecutor;
  private readonly maxConcurrent: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly records = new Map<string, AuthChallengeRecord>();
  private readonly runtimes = new Map<string, ChallengeRuntime>();
  private readonly queue: string[] = [];
  private initializePromise?: Promise<void>;
  private pumpScheduled = false;
  private active = 0;

  constructor(options: InteractiveAuthBrokerOptions = {}) {
    this.store = options.store ?? new FileAuthChallengeStore();
    this.executor = options.executor ?? new TerminalAuthExecutor();
    this.maxConcurrent = assertBoundedInteger(
      options.maxConcurrent ?? 1,
      "maxConcurrent",
      1,
      8,
    );
    this.maxTimeoutMs = assertBoundedInteger(
      options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
      "maxTimeoutMs",
      10,
      DEFAULT_MAX_TIMEOUT_MS,
    );
    this.defaultTimeoutMs = assertBoundedInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
      10,
      this.maxTimeoutMs,
    );
    this.maxOutputBytes = assertBoundedInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
      64,
      1024 * 1024,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      const stored = await this.store.list();
      for (const record of stored) this.records.set(record.id, cloneRecord(record));
      for (const record of this.records.values()) {
        if (!ACTIVE_STATUSES.has(record.status)) continue;
        if (record.ownerPid && isProcessAlive(record.ownerPid)) continue;
        const completedAt = this.timestamp();
        Object.assign(record, {
          status: "failed" as const,
          error: "Authentication challenge was interrupted by a broker restart.",
          updatedAt: completedAt,
          completedAt,
        });
        await this.store.save(record);
      }
    })();
    return this.initializePromise;
  }

  private persist(runtime: ChallengeRuntime): Promise<void> {
    const snapshot = cloneRecord(runtime.record);
    const operation = runtime.persistenceTail.then(() => this.store.save(snapshot));
    runtime.persistenceTail = operation.catch(() => undefined);
    return operation;
  }

  private persistInBackground(runtime: ChallengeRuntime): void {
    void this.persist(runtime).catch(() => {
      if (isTerminal(runtime.record.status)) return;
      const completedAt = this.timestamp();
      Object.assign(runtime.record, {
        status: "failed" as const,
        error: "Authentication challenge state could not be persisted.",
        updatedAt: completedAt,
        completedAt,
      });
      if (runtime.timer) clearTimeout(runtime.timer);
      void runtime.execution?.cancel().catch(() => undefined);
    });
  }

  private updateRecord(
    runtime: ChallengeRuntime,
    patch: Partial<AuthChallengeRecord>,
  ): Promise<void> {
    if (patch.status && !transitionAllowed(runtime.record.status, patch.status)) {
      throw new Error(
        `Invalid authentication challenge transition: ${runtime.record.status} -> ${patch.status}`,
      );
    }
    Object.assign(runtime.record, patch, { updatedAt: this.timestamp() });
    return this.persist(runtime);
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const runtime = this.runtimes.get(id);
      if (!runtime || runtime.record.status !== "queued") continue;
      this.active += 1;
      void this.run(runtime).finally(() => {
        this.active -= 1;
        this.schedulePump();
      });
    }
  }

  private async fail(
    runtime: ChallengeRuntime,
    message: string,
    cancelExecution: boolean,
  ): Promise<void> {
    if (isTerminal(runtime.record.status)) return;
    const completedAt = this.timestamp();
    try {
      await this.updateRecord(runtime, {
        status: "failed",
        error: safeRecordError(message),
        completedAt,
      });
    } finally {
      if (runtime.timer) clearTimeout(runtime.timer);
      if (cancelExecution) {
        await runtime.execution?.cancel().catch(() => undefined);
      }
    }
  }

  private handleOutput(runtime: ChallengeRuntime, rawChunk: string): void {
    if (isTerminal(runtime.record.status) || rawChunk.length === 0) return;
    runtime.outputBytes += Buffer.byteLength(rawChunk);
    if (runtime.outputBytes > this.maxOutputBytes) {
      void this.fail(
        runtime,
        `Authentication output exceeded the ${this.maxOutputBytes}-byte limit.`,
        true,
      );
      return;
    }

    const chunk = stripTerminalControls(rawChunk);
    runtime.scanBuffer = tailByBytes(
      `${runtime.scanBuffer}${chunk}`,
      SCAN_BUFFER_BYTES,
    );
    if (containsCredentialPrompt(runtime.scanBuffer)) {
      void this.fail(
        runtime,
        "Credential-entry and noninteractive token flows are unsupported.",
        true,
      );
      return;
    }

    let changed = false;
    if (!runtime.record.authorizationUrl && runtime.acceptingAuthorizationUrl) {
      const authorizationUrl = firstAuthorizationUrl(runtime.scanBuffer);
      if (authorizationUrl) {
        runtime.record.authorizationUrl = authorizationUrl;
        changed = true;
      }
    }
    if (!runtime.record.deviceCode && runtime.acceptingAuthorizationUrl) {
      const deviceCode = deviceCodeFrom(runtime.scanBuffer);
      if (deviceCode) {
        runtime.record.deviceCode = deviceCode;
        changed = true;
      }
    }

    const safePrompt = safePromptFrom(runtime.scanBuffer);
    if (safePrompt && !runtime.seenPrompts.has(safePrompt)) {
      runtime.seenPrompts.add(safePrompt);
      runtime.record.safePrompt = safePrompt;
      if (
        runtime.record.status === "running" ||
        runtime.record.status === "waiting_for_browser"
      ) {
        runtime.record.status = "waiting_for_input";
      }
      changed = true;
    } else if (
      !safePrompt &&
      runtime.record.status === "running" &&
      indicatesBrowserWait(runtime.scanBuffer)
    ) {
      runtime.record.status = "waiting_for_browser";
      changed = true;
    }

    if (changed) {
      runtime.record.updatedAt = this.timestamp();
      this.persistInBackground(runtime);
    }
  }

  private invocation(runtime: ChallengeRuntime): AuthInvocation {
    const command = commandFor(
      runtime.record.target,
      runtime.record.provider,
      runtime.record.operation,
      runtime.record.serverName,
    );
    return Object.freeze({
      target: runtime.record.target,
      provider: runtime.record.provider,
      operation: runtime.record.operation,
      serverName: runtime.record.serverName,
      command: command.command,
      args: Object.freeze([...command.args]),
      cwd: runtime.cwd,
    });
  }

  private async run(runtime: ChallengeRuntime): Promise<void> {
    const startedAt = this.timestamp();
    const expiresAt = new Date(
      new Date(startedAt).getTime() + runtime.record.timeoutMs,
    ).toISOString();
    try {
      await this.updateRecord(runtime, {
        status: "running",
        startedAt,
        expiresAt,
        error: null,
      });
      runtime.timer = setTimeout(() => {
        void this.fail(runtime, "Authentication challenge timed out.", true);
      }, runtime.record.timeoutMs);
      runtime.timer.unref();

      runtime.executionPromise = this.executor.start(this.invocation(runtime), {
        onOutput: (chunk) => this.handleOutput(runtime, chunk),
      });
      const execution = await runtime.executionPromise;
      runtime.execution = execution;
      if (isTerminal(runtime.record.status)) {
        await execution.cancel().catch(() => undefined);
        return;
      }

      const outcome = await execution.completion;
      if (runtime.timer) clearTimeout(runtime.timer);
      if (isTerminal(runtime.record.status)) return;
      const completedAt = this.timestamp();
      if (outcome.exitCode === 0 && !outcome.error) {
        await this.updateRecord(runtime, {
          status: "completed",
          error: null,
          completedAt,
        });
      } else {
        const detail = outcome.error
          ? "Authentication executable could not be started."
          : `Authentication command failed with exit code ${String(outcome.exitCode)}.`;
        await this.updateRecord(runtime, {
          status: "failed",
          error: detail,
          completedAt,
        });
      }
    } catch {
      await this.fail(runtime, "Authentication executor failed.", true).catch(
        () => undefined,
      );
    } finally {
      if (runtime.timer) clearTimeout(runtime.timer);
    }
  }

  async startChallenge(input: StartAuthChallengeInput): Promise<AuthChallengeRecord> {
    await this.initialize();
    const command = buildAuthCommand(input);
    void command;
    const timeoutMs = assertBoundedInteger(
      input.timeoutMs ?? this.defaultTimeoutMs,
      "timeoutMs",
      10,
      this.maxTimeoutMs,
    );
    const normalized: NormalizedStart = {
      target: assertTarget(input.target),
      provider: assertProvider(input.provider),
      operation: assertOperation(input.operation ?? "login"),
      serverName: input.target === "mcp" ? assertServerName(input.serverName) : null,
      cwd: await canonicalDirectory(input.cwd),
      timeoutMs,
    };
    const id = this.idFactory();
    if (!CHALLENGE_ID_PATTERN.test(id) || this.records.has(id)) {
      throw new Error("idFactory must return a unique UUID.");
    }
    const createdAt = this.timestamp();
    const record: AuthChallengeRecord = {
      id,
      target: normalized.target,
      provider: normalized.provider,
      operation: normalized.operation,
      serverName: normalized.serverName,
      status: "queued",
      authorizationUrl: null,
      deviceCode: null,
      safePrompt: null,
      error: null,
      timeoutMs: normalized.timeoutMs,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      expiresAt: null,
      completedAt: null,
      ownerPid: process.pid,
    };
    await this.store.save(record);
    const runtime: ChallengeRuntime = {
      record,
      cwd: normalized.cwd,
      outputBytes: 0,
      scanBuffer: "",
      acceptingAuthorizationUrl: true,
      seenPrompts: new Set(),
      persistenceTail: Promise.resolve(),
    };
    this.records.set(id, record);
    this.runtimes.set(id, runtime);
    this.queue.push(id);
    this.schedulePump();
    return cloneRecord(record);
  }

  async getChallenge(id: string): Promise<AuthChallengeRecord | undefined> {
    await this.initialize();
    if (typeof id !== "string" || !CHALLENGE_ID_PATTERN.test(id)) {
      throw new TypeError("challenge id must be a UUID.");
    }
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async listChallenges(
    filter: AuthChallengeFilter = {},
  ): Promise<AuthChallengeRecord[]> {
    await this.initialize();
    const target = filter.target === undefined ? undefined : assertTarget(filter.target);
    const provider =
      filter.provider === undefined ? undefined : assertProvider(filter.provider);
    const status =
      filter.status === undefined
        ? undefined
        : STATUS_SET.has(filter.status)
          ? filter.status
          : (() => {
              throw new TypeError("Invalid authentication challenge status.");
            })();
    const limit = assertBoundedInteger(filter.limit ?? 100, "limit", 1, 1_000);
    return [...this.records.values()]
      .filter((record) => !target || record.target === target)
      .filter((record) => !provider || record.provider === provider)
      .filter((record) => !status || record.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async submitChallengeInput(
    id: string,
    input: string,
  ): Promise<AuthChallengeRecord> {
    await this.initialize();
    const runtime = this.runtimes.get(id);
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown authentication challenge: ${id}`);
    if (!runtime) {
      throw new Error("Authentication challenge is not attached to a live executor.");
    }
    if (record.status !== "waiting_for_input") {
      throw new Error(`Authentication challenge is not waiting for input: ${record.status}`);
    }
    const safeInput = validateSubmittedInput(input);

    // Transition synchronously before the first await so concurrent or duplicate
    // submissions cannot both claim the same prompt.
    record.status = "running";
    record.updatedAt = this.timestamp();
    runtime.acceptingAuthorizationUrl = false;
    runtime.scanBuffer = "";
    await this.persist(runtime);

    const execution = runtime.execution ?? (await runtime.executionPromise);
    if (!execution || isTerminal(record.status)) {
      throw new Error("Authentication challenge stopped before input delivery.");
    }
    try {
      await execution.write(safeInput);
    } catch {
      await this.fail(runtime, "Authentication input could not be delivered.", true);
      throw new Error("Authentication input could not be delivered.");
    }
    return cloneRecord(record);
  }

  async cancelChallenge(id: string): Promise<AuthChallengeRecord> {
    await this.initialize();
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown authentication challenge: ${id}`);
    if (isTerminal(record.status)) {
      if (record.status === "cancelled") return cloneRecord(record);
      throw new Error(`Authentication challenge is already ${record.status}.`);
    }
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error("Authentication challenge is not attached to a live executor.");
    const completedAt = this.timestamp();
    await this.updateRecord(runtime, {
      status: "cancelled",
      error: "Authentication challenge cancelled by request.",
      completedAt,
    });
    if (runtime.timer) clearTimeout(runtime.timer);
    const execution = runtime.execution ?? (await runtime.executionPromise?.catch(() => undefined));
    await execution?.cancel().catch(() => undefined);
    return cloneRecord(record);
  }

  async close(): Promise<void> {
    await this.initialize();
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        if (!isTerminal(runtime.record.status)) {
          await runtime.execution?.cancel().catch(() => undefined);
        }
        await runtime.persistenceTail.catch(() => undefined);
      }),
    );
  }
}

export function createInteractiveAuthBroker(
  options: InteractiveAuthBrokerOptions = {},
): InteractiveAuthBroker {
  return new InteractiveAuthBroker(options);
}
