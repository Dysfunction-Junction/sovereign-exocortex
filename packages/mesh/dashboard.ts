import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { redactSecrets, stateDirectory } from "./security.js";

export const DASHBOARD_LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
export type DashboardLoopbackHost =
  (typeof DASHBOARD_LOOPBACK_HOSTS)[number];

export const DASHBOARD_API_PATHS = {
  tasks: "/api/tasks",
  sessions: "/api/sessions",
  questions: "/api/questions",
  usage: "/api/usage",
  workers: "/api/workers",
  traffic: "/api/traffic",
  peers: "/api/peers",
  snapshot: "/api/snapshot",
  progress: "/api/progress",
  bootstrap: "/auth/bootstrap",
} as const;

type MaybePromise<T> = T | Promise<T>;
type SnapshotReader = () => MaybePromise<unknown>;

export const DASHBOARD_SESSION_SNAPSHOT_PROTOCOL =
  "agent-mesh-dashboard-sessions/v1" as const;
export const DASHBOARD_SESSION_COOKIE = "agent_mesh_dashboard_session" as const;

export interface DashboardSessionSummary {
  provider: string;
  sessionId: string;
  name: string;
  status: string;
  taskCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export interface DashboardSessionsSnapshot {
  protocol: typeof DASHBOARD_SESSION_SNAPSHOT_PROTOCOL;
  sessions: DashboardSessionSummary[];
}

export type DashboardSessionsSnapshotReader = () => MaybePromise<
  DashboardSessionsSnapshot | readonly unknown[]
>;

export interface DashboardProgressEvent {
  type: string;
  at?: string;
  taskId?: string;
  sessionId?: string;
  workerId?: string;
  trafficAgentId?: string;
  trafficParticipantId?: string;
  peerChannelId?: string;
  peerWakeId?: string;
  lane?: string;
  provider?: string;
  status?: string;
  message?: string;
  progress?: number;
}

export interface DashboardSnapshotSources {
  tasks: SnapshotReader;
  sessions: DashboardSessionsSnapshotReader;
  questions: SnapshotReader;
  usage: SnapshotReader;
  workers: SnapshotReader;
  traffic?: SnapshotReader;
  peers?: SnapshotReader;
  /**
   * Optional push source. The returned function must detach the listener.
   * Callers can also publish through the returned DashboardHandle.
   */
  subscribeProgress?: (
    listener: (event: DashboardProgressEvent) => void,
  ) => () => void;
}

export interface DashboardOptions {
  sources: DashboardSnapshotSources;
  host?: DashboardLoopbackHost;
  port?: number;
  tokenFile?: string;
  sseKeepAliveMs?: number;
  removeTokenFileOnClose?: boolean;
}

export interface DashboardHandle {
  readonly server: Server;
  readonly host: DashboardLoopbackHost;
  readonly port: number;
  readonly origin: string;
  readonly tokenFile: string;
  readonly bootstrapPath: typeof DASHBOARD_API_PATHS.bootstrap;
  readonly bootstrapUrl: string;
  /**
   * One-time code for a trusted local launcher or manual paste into the
   * bootstrap form. This property is non-enumerable and must never be returned
   * through a model-facing MCP response.
   */
  readonly bootstrapCode: string;
  /**
   * Publish metadata-only progress to authenticated SSE clients. This is an
   * in-process integration hook, not an HTTP mutation endpoint.
   */
  publishProgress(event: DashboardProgressEvent): void;
  close(): Promise<void>;
}

interface SafeSnapshots {
  tasks: unknown;
  sessions: DashboardSessionsSnapshot;
  questions: unknown;
  usage: unknown;
  workers: unknown;
  traffic: unknown;
  peers: unknown;
}

const API_READERS: Readonly<
  Record<
    Exclude<
      keyof typeof DASHBOARD_API_PATHS,
      "snapshot" | "progress" | "bootstrap"
    >,
    keyof DashboardSnapshotSources
  >
> = {
  tasks: "tasks",
  sessions: "sessions",
  questions: "questions",
  usage: "usage",
  workers: "workers",
  traffic: "traffic",
  peers: "peers",
};

const PATH_TO_SOURCE = new Map<string, keyof DashboardSnapshotSources>(
  Object.entries(API_READERS).map(([pathKey, sourceKey]) => [
    DASHBOARD_API_PATHS[pathKey as keyof typeof API_READERS],
    sourceKey,
  ]),
);

const SAFE_SNAPSHOT_KEYS = new Set([
  // Top-level collections.
  "tasks",
  "sessions",
  "questions",
  "usage",
  "workers",
  "traffic",
  "peers",
  "data",
  // Common identifiers and display metadata.
  "id",
  "name",
  "origin",
  "provider",
  "description",
  "mode",
  "status",
  "model",
  "effort",
  "sessionId",
  "taskId",
  "parentTaskId",
  "workerId",
  "remoteTaskId",
  "taskCount",
  "activeTasks",
  "enabled",
  "kind",
  "transport",
  "createdAt",
  "updatedAt",
  "completedAt",
  "answeredAt",
  "lastHeartbeatAt",
  "heartbeatExpiresAt",
  // Agent traffic control.
  "controller",
  "agents",
  "participants",
  "runs",
  "lane",
  "displayName",
  "repoLabel",
  "worktreeLabel",
  "meshOwned",
  "adopted",
  "trust",
  "generation",
  "active",
  "startedAt",
  "heartbeatAt",
  "expiresAt",
  // Managed peer channels.
  "channels",
  "members",
  "deliveries",
  "wakes",
  "channelId",
  "agentId",
  "recipientMemberId",
  "wakePolicy",
  "policyVersion",
  "messageCount",
  "byteCount",
  "role",
  "label",
  "state",
  // Questions (answers and free-form context are deliberately omitted).
  "question",
  "options",
  "delivery",
  // Worker capabilities and provider inventory.
  "capabilities",
  "protocol",
  "maxConcurrentTasks",
  "modes",
  "isolation",
  "providers",
  "installed",
  "version",
  "models",
  // Normalized provider usage.
  "rateLimits",
  "cost",
  "session",
  "value",
  "source",
  "reason",
  "plan",
  "reachedType",
  "windows",
  "credits",
  "scope",
  "usedPercent",
  "remainingPercent",
  "windowDurationSeconds",
  "resetsAt",
  "hasCredits",
  "unlimited",
  "balance",
  "amount",
  "currency",
  "periodStart",
  "periodEnd",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
]);

const SECRET_KEY_PATTERN =
  /(?:token|secret|password|cookie|authorization|credential|api.?key|prompt|answer|output|result|transcript|event|error|stack|path|cwd|environment|command|argv|endpoint|host|email)/iu;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_ARRAY = 500;
const MAX_SNAPSHOT_STRING_BYTES = 4_096;
const MAX_SNAPSHOT_OBJECT_KEYS = 128;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SSE_CLIENT_BUFFER_BYTES = 256 * 1024;
const MAX_BOOTSTRAP_BODY_BYTES = 1_024;
const DEFAULT_SSE_KEEPALIVE_MS = 15_000;
const MIN_SSE_KEEPALIVE_MS = 1_000;
const MAX_SSE_KEEPALIVE_MS = 60_000;
const TOKEN_OWNER_PROTOCOL = "agent-mesh-dashboard-token-owner/v1";
const ACTIVE_TOKEN_OWNERS = new Map<string, string>();

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const set = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !set.has(key));
  if (extra.length > 0) {
    throw new TypeError(`${name} contains unsupported fields: ${extra.join(", ")}.`);
  }
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value) <= maximum) return value;
  const marker = "...[TRUNCATED]";
  const budget = Math.max(0, maximum - Buffer.byteLength(marker));
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return `${result}${marker}`;
}

function sanitizeSnapshot(value: unknown, depth = 0): unknown {
  if (depth > MAX_SNAPSHOT_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return truncateUtf8(redactSecrets(value), MAX_SNAPSHOT_STRING_BYTES);
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_SNAPSHOT_ARRAY)
      .map((item) => sanitizeSnapshot(item, depth + 1));
  }
  if (!value || typeof value !== "object") return null;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(
    0,
    MAX_SNAPSHOT_OBJECT_KEYS,
  )) {
    if (SECRET_KEY_PATTERN.test(key) || !SAFE_SNAPSHOT_KEYS.has(key)) continue;
    result[key] = sanitizeSnapshot(item, depth + 1);
  }
  return result;
}

function safeSessionText(
  value: unknown,
  fallback: string,
  maximumBytes = 256,
): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return truncateUtf8(redactSecrets(value.trim()), maximumBytes);
}

function safeSessionTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function latestTimestamp(
  current: string | null,
  candidate: string | null,
): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return new Date(candidate).getTime() > new Date(current).getTime()
    ? candidate
    : current;
}

function earliestTimestamp(
  current: string | null,
  candidate: string | null,
): string | null {
  if (!candidate) return current;
  if (!current) return candidate;
  return new Date(candidate).getTime() < new Date(current).getTime()
    ? candidate
    : current;
}

/**
 * Convert either already-grouped session summaries or raw task records into a
 * versioned session-only contract. Raw task identifiers and task-only fields
 * cannot bleed into the sessions endpoint.
 */
export function createDashboardSessionsSnapshot(
  value: unknown,
): DashboardSessionsSnapshot {
  const candidate =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).protocol ===
      DASHBOARD_SESSION_SNAPSHOT_PROTOCOL
      ? (value as Record<string, unknown>).sessions
      : value;
  if (!Array.isArray(candidate)) {
    return {
      protocol: DASHBOARD_SESSION_SNAPSHOT_PROTOCOL,
      sessions: [],
    };
  }

  const sessions = new Map<string, DashboardSessionSummary>();
  for (const raw of candidate.slice(0, MAX_SNAPSHOT_ARRAY)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.sessionId !== "string" || !row.sessionId.trim()) continue;
    const sessionId = safeSessionText(row.sessionId, "", 256);
    const provider = safeSessionText(row.provider, "unknown", 64);
    if (!sessionId) continue;
    const key = `${provider}\u0000${sessionId}`;
    const explicitTaskCount =
      typeof row.taskCount === "number" &&
      Number.isSafeInteger(row.taskCount) &&
      row.taskCount >= 0
        ? Math.min(row.taskCount, MAX_SNAPSHOT_ARRAY)
        : 1;
    const createdAt = safeSessionTimestamp(row.createdAt);
    const updatedAt =
      safeSessionTimestamp(row.updatedAt) ??
      safeSessionTimestamp(row.completedAt) ??
      createdAt;
    const completedAt = safeSessionTimestamp(row.completedAt);
    const existing = sessions.get(key);
    const name = safeSessionText(
      row.name ?? row.description,
      existing?.name ?? sessionId,
      512,
    );
    const status = safeSessionText(
      row.status,
      existing?.status ?? "unknown",
      64,
    );
    if (!existing) {
      sessions.set(key, {
        provider,
        sessionId,
        name,
        status,
        taskCount: explicitTaskCount,
        createdAt,
        updatedAt,
        completedAt,
      });
      continue;
    }
    const candidateIsLatest =
      updatedAt !== null &&
      (existing.updatedAt === null ||
        new Date(updatedAt).getTime() >=
          new Date(existing.updatedAt).getTime());
    existing.taskCount = Math.min(
      MAX_SNAPSHOT_ARRAY,
      existing.taskCount + explicitTaskCount,
    );
    existing.createdAt = earliestTimestamp(existing.createdAt, createdAt);
    existing.updatedAt = latestTimestamp(existing.updatedAt, updatedAt);
    existing.completedAt = latestTimestamp(existing.completedAt, completedAt);
    if (candidateIsLatest) {
      existing.name = name;
      existing.status = status;
    }
  }

  return {
    protocol: DASHBOARD_SESSION_SNAPSHOT_PROTOCOL,
    sessions: [...sessions.values()].sort((left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    ),
  };
}

function safeProgressEvent(value: unknown): DashboardProgressEvent {
  const event = object(value, "progress event");
  assertOnlyKeys(
    event,
    [
      "type",
      "at",
      "taskId",
      "sessionId",
      "workerId",
      "trafficAgentId",
      "trafficParticipantId",
      "peerChannelId",
      "peerWakeId",
      "lane",
      "provider",
      "status",
      "message",
      "progress",
    ],
    "progress event",
  );
  if (typeof event.type !== "string" || !event.type.trim()) {
    throw new TypeError("progress event type must be a non-empty string.");
  }
  const result: DashboardProgressEvent = {
    type: truncateUtf8(redactSecrets(event.type.trim()), 64),
  };
  for (const key of [
    "taskId",
    "sessionId",
    "workerId",
    "trafficAgentId",
    "trafficParticipantId",
    "peerChannelId",
    "peerWakeId",
    "lane",
    "provider",
    "status",
  ] as const) {
    const item = event[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || !item.trim()) {
      throw new TypeError(`progress event ${key} must be a non-empty string.`);
    }
    result[key] = truncateUtf8(redactSecrets(item.trim()), 256);
  }
  if (event.message !== undefined) {
    if (typeof event.message !== "string" || !event.message.trim()) {
      throw new TypeError("progress event message must be a non-empty string.");
    }
    result.message = truncateUtf8(
      redactSecrets(event.message.trim()),
      MAX_SNAPSHOT_STRING_BYTES,
    );
  }
  if (event.progress !== undefined) {
    if (
      typeof event.progress !== "number" ||
      !Number.isFinite(event.progress) ||
      event.progress < 0 ||
      event.progress > 1
    ) {
      throw new RangeError("progress event progress must be from 0 through 1.");
    }
    result.progress = event.progress;
  }
  if (event.at !== undefined) {
    if (typeof event.at !== "string") {
      throw new TypeError("progress event at must be an ISO timestamp.");
    }
    const timestamp = new Date(event.at);
    if (!Number.isFinite(timestamp.getTime())) {
      throw new TypeError("progress event at must be an ISO timestamp.");
    }
    result.at = timestamp.toISOString();
  } else {
    result.at = new Date().toISOString();
  }
  return result;
}

function loopbackHost(value: unknown): DashboardLoopbackHost {
  if (
    typeof value !== "string" ||
    !(DASHBOARD_LOOPBACK_HOSTS as readonly string[]).includes(value)
  ) {
    throw new TypeError(
      `Dashboard host must be loopback-only: ${DASHBOARD_LOOPBACK_HOSTS.join(" or ")}.`,
    );
  }
  return value as DashboardLoopbackHost;
}

function assertSources(value: unknown): DashboardSnapshotSources {
  const sources = object(value, "sources");
  for (const name of ["tasks", "sessions", "questions", "usage", "workers"]) {
    if (typeof sources[name] !== "function") {
      throw new TypeError(`sources.${name} must be a function.`);
    }
  }
  if (sources.traffic !== undefined && typeof sources.traffic !== "function") {
    throw new TypeError("sources.traffic must be a function.");
  }
  if (sources.peers !== undefined && typeof sources.peers !== "function") {
    throw new TypeError("sources.peers must be a function.");
  }
  if (
    sources.subscribeProgress !== undefined &&
    typeof sources.subscribeProgress !== "function"
  ) {
    throw new TypeError("sources.subscribeProgress must be a function.");
  }
  return value as DashboardSnapshotSources;
}

function randomDashboardSecret(prefix: "meshd" | "meshb" | "meshs"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function bearerAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    authorization.length > 1_024 ||
    !authorization.startsWith("Bearer ")
  ) {
    return false;
  }
  const supplied = authorization.slice("Bearer ".length);
  return secretsEqual(supplied, token);
}

function cookieAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.cookie;
  if (typeof header !== "string" || Buffer.byteLength(header) > 8_192) {
    return false;
  }
  const supplied = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${DASHBOARD_SESSION_COOKIE}=`))
    .map((part) => part.slice(DASHBOARD_SESSION_COOKIE.length + 1));
  return supplied.length === 1 && secretsEqual(supplied[0] ?? "", token);
}

interface DashboardTokenOwner {
  protocol: typeof TOKEN_OWNER_PROTOCOL;
  pid: number;
  nonce: string;
  tokenDigest: string;
  createdAt: string;
}

function ownerFile(path: string): string {
  return `${path}.owner`;
}

function tokenDigest(value: string): string {
  return digest(value).toString("base64url");
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = resolve(dirname(path));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Dashboard token parent must be a private real directory.");
  }
  await chmod(parent, 0o700);
}

async function writePrivateFileExclusive(
  path: string,
  contents: string,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("Dashboard token file is not private.");
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readPrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error("Dashboard credential file is not a private regular file.");
    }
    if (
      typeof process.getuid === "function" &&
      info.uid !== process.getuid()
    ) {
      throw new Error("Dashboard credential file has a different owner.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTokenOwner(path: string): Promise<DashboardTokenOwner> {
  const raw = await readPrivateFile(ownerFile(path));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Dashboard token owner file is invalid.");
  }
  const owner = object(parsed, "dashboard token owner");
  if (
    owner.protocol !== TOKEN_OWNER_PROTOCOL ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce !== "string" ||
    !owner.nonce ||
    typeof owner.tokenDigest !== "string" ||
    !owner.tokenDigest ||
    typeof owner.createdAt !== "string" ||
    !Number.isFinite(new Date(owner.createdAt).getTime())
  ) {
    throw new Error("Dashboard token owner file is invalid.");
  }
  return owner as unknown as DashboardTokenOwner;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function ownerIsStale(path: string, owner: DashboardTokenOwner): boolean {
  if (owner.pid === process.pid) {
    return ACTIVE_TOKEN_OWNERS.get(path) !== owner.nonce;
  }
  return !processIsAlive(owner.pid);
}

async function removeStaleOwnedTokenFiles(
  path: string,
  owner: DashboardTokenOwner,
): Promise<void> {
  try {
    const current = (await readPrivateFile(path)).trim();
    if (tokenDigest(current) !== owner.tokenDigest) {
      throw new Error(
        "Dashboard token file does not match its stale ownership record.",
      );
    }
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const currentOwner = await readTokenOwner(path);
  if (currentOwner.nonce !== owner.nonce) {
    throw new Error("Dashboard token ownership changed during recovery.");
  }
  await unlink(ownerFile(path));
}

async function writePrivateTokenFile(
  path: string,
  token: string,
  ownerNonce: string,
): Promise<void> {
  await ensurePrivateParent(path);
  const owner: DashboardTokenOwner = {
    protocol: TOKEN_OWNER_PROTOCOL,
    pid: process.pid,
    nonce: ownerNonce,
    tokenDigest: tokenDigest(token),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writePrivateFileExclusive(
        ownerFile(path),
        `${JSON.stringify(owner)}\n`,
      );
      ACTIVE_TOKEN_OWNERS.set(path, ownerNonce);
      try {
        await writePrivateFileExclusive(path, `${token}\n`);
        return;
      } catch (error) {
        ACTIVE_TOKEN_OWNERS.delete(path);
        await unlink(ownerFile(path)).catch(() => undefined);
        if (isAlreadyExists(error)) {
          throw new Error(
            "Dashboard token file already exists without matching ownership metadata.",
          );
        }
        throw error;
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readTokenOwner(path);
      if (!ownerIsStale(path, existing)) {
        throw new Error("Dashboard token file is owned by an active dashboard.");
      }
      await removeStaleOwnedTokenFiles(path, existing);
    }
  }
  throw new Error("Dashboard could not safely recover its stale token file.");
}

async function removeOwnedTokenFile(
  path: string,
  token: string,
  ownerNonce: string,
): Promise<void> {
  if (ACTIVE_TOKEN_OWNERS.get(path) === ownerNonce) {
    ACTIVE_TOKEN_OWNERS.delete(path);
  }
  try {
    const owner = await readTokenOwner(path);
    if (
      owner.nonce !== ownerNonce ||
      owner.tokenDigest !== tokenDigest(token)
    ) {
      return;
    }
    const current = (await readPrivateFile(path)).trim();
    if (secretsEqual(current, token)) await unlink(path);
    await unlink(ownerFile(path)).catch(() => undefined);
  } catch {
    // The credential may already have been removed or rotated by the operator.
  }
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  return (
    value === "::1" ||
    value.startsWith("127.") ||
    value.startsWith("::ffff:127.")
  );
}

function unsafeRequestTarget(rawUrl: string): boolean {
  const rawPath = rawUrl.split("?", 1)[0] ?? "";
  if (
    !rawPath.startsWith("/") ||
    rawPath.includes("\\") ||
    rawPath.includes("\0") ||
    /%(?:2e|2f|5c|00)/iu.test(rawPath)
  ) {
    return true;
  }
  let decoded = rawPath;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return true;
  }
  return (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((segment) => segment === "..")
  );
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

function sendBody(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
    sendBody(
      request,
      response,
      503,
      "application/json; charset=utf-8",
      JSON.stringify({ error: "Snapshot exceeds the dashboard response bound." }),
    );
    return;
  }
  sendBody(
    request,
    response,
    status,
    "application/json; charset=utf-8",
    body,
  );
}

function sendError(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(request, response, status, { error: message });
}

function sendRedirect(
  request: IncomingMessage,
  response: ServerResponse,
  location: string,
  cookie?: string,
): void {
  securityHeaders(response);
  response.statusCode = 303;
  response.setHeader("Location", location);
  if (cookie) response.setHeader("Set-Cookie", cookie);
  response.setHeader("Content-Length", "0");
  response.end();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function countSnapshot(value: unknown): string {
  if (Array.isArray(value)) return String(value.length);
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).sessions)
  ) {
    return String((value as { sessions: unknown[] }).sessions.length);
  }
  if (value && typeof value === "object") return String(Object.keys(value).length);
  return value === null ? "0" : "1";
}

function renderBootstrap(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Agent Mesh Dashboard Sign In</title>
  <style>
    :root{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e8edf5;background:#0b0f17}
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}
    main{width:min(440px,100%);padding:24px;border:1px solid #253047;border-radius:14px;background:#111827}
    h1{margin:0 0 8px;font-size:1.5rem}p{margin:0 0 20px;color:#95a2b7;line-height:1.5}
    label{display:block;margin-bottom:8px;font-weight:600}input,button{width:100%;border-radius:9px;font:inherit}
    input{padding:11px 12px;color:#e8edf5;background:#0b0f17;border:1px solid #334155}
    button{margin-top:12px;padding:11px 12px;border:0;color:#08111f;background:#8fb8ff;font-weight:700;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>Agent Mesh</h1>
    <p>Paste the one-time bootstrap code from your trusted local launcher.</p>
    <form method="post" action="${DASHBOARD_API_PATHS.bootstrap}">
      <label for="code">Bootstrap code</label>
      <input id="code" name="code" type="password" required autocomplete="one-time-code" maxlength="512" autofocus>
      <button type="submit">Open dashboard</button>
    </form>
  </main>
</body>
</html>`;
}

function renderDashboard(snapshots: SafeSnapshots, generatedAt: string): string {
  const sections = (
    Object.entries(snapshots) as Array<[keyof SafeSnapshots, unknown]>
  )
    .map(
      ([name, value]) => `<section>
        <div class="section-title">
          <h2>${escapeHtml(name)}</h2>
          <span>${countSnapshot(value)}</span>
        </div>
        <pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>
      </section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Agent Mesh Control Dashboard</title>
  <style>
    :root{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e8edf5;background:#0b0f17}
    *{box-sizing:border-box}body{margin:0}main{width:min(1200px,100%);margin:auto;padding:clamp(16px,4vw,48px)}
    header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:24px}
    h1,h2,p{margin:0}h1{font-size:clamp(1.5rem,4vw,2.4rem)}p{color:#95a2b7;font-size:.85rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px}
    section{min-width:0;border:1px solid #253047;border-radius:14px;background:#111827;overflow:hidden}
    .section-title{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #253047}
    h2{font-size:1rem;text-transform:capitalize}.section-title span{color:#8fb8ff;font-variant-numeric:tabular-nums}
    pre{margin:0;padding:16px;max-height:420px;overflow:auto;color:#cad5e5;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
    @media(max-width:560px){header{align-items:flex-start;flex-direction:column}.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main>
    <header><h1>Agent Mesh</h1><p>Read-only snapshot · ${escapeHtml(generatedAt)}</p></header>
    <div class="grid">${sections}</div>
  </main>
</body>
</html>`;
}

interface DashboardAuthState {
  bearerToken: string;
  sessionToken: string;
  bootstrapDigest: Buffer;
  bootstrapConsumed: boolean;
}

function requestTargetsOrigin(
  request: IncomingMessage,
  origin: string,
): boolean {
  const expected = new URL(origin);
  if (request.headers.host !== expected.host) return false;
  const suppliedOrigin = request.headers.origin;
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  return (
    fetchSite === undefined ||
    fetchSite === "same-origin" ||
    fetchSite === "none"
  );
}

async function readBoundedBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<string> {
  const declared = request.headers["content-length"];
  if (
    typeof declared !== "string" ||
    !/^\d+$/u.test(declared) ||
    Number(declared) > maximumBytes
  ) {
    throw new RangeError("Invalid dashboard request body length.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximumBytes) {
      throw new RangeError("Dashboard request body is too large.");
    }
    chunks.push(buffer);
  }
  if (total !== Number(declared)) {
    throw new RangeError("Dashboard request body length did not match.");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sessionCookie(token: string): string {
  return `${DASHBOARD_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

function listen(
  server: Server,
  host: DashboardLoopbackHost,
  port: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
    server.closeIdleConnections();
  });
}

export class ControlDashboard {
  private readonly sources: DashboardSnapshotSources;
  private readonly host: DashboardLoopbackHost;
  private readonly port: number;
  private readonly tokenFile: string;
  private readonly sseKeepAliveMs: number;
  private readonly removeTokenFileOnClose: boolean;
  private started = false;

  constructor(options: DashboardOptions) {
    const candidate = object(options, "dashboard options");
    assertOnlyKeys(
      candidate,
      [
        "sources",
        "host",
        "port",
        "tokenFile",
        "sseKeepAliveMs",
        "removeTokenFileOnClose",
      ],
      "dashboard options",
    );
    this.sources = assertSources(candidate.sources);
    this.host = loopbackHost(candidate.host ?? "127.0.0.1");
    this.port = boundedInteger(candidate.port ?? 0, "port", 0, 65_535);
    if (
      candidate.tokenFile !== undefined &&
      (typeof candidate.tokenFile !== "string" ||
        !isAbsoluteTokenPath(candidate.tokenFile))
    ) {
      throw new TypeError("tokenFile must be an absolute path without NUL bytes.");
    }
    this.tokenFile = resolve(
      (candidate.tokenFile as string | undefined) ??
        join(stateDirectory(), "dashboard.token"),
    );
    this.sseKeepAliveMs = boundedInteger(
      candidate.sseKeepAliveMs ?? DEFAULT_SSE_KEEPALIVE_MS,
      "sseKeepAliveMs",
      MIN_SSE_KEEPALIVE_MS,
      MAX_SSE_KEEPALIVE_MS,
    );
    if (
      candidate.removeTokenFileOnClose !== undefined &&
      typeof candidate.removeTokenFileOnClose !== "boolean"
    ) {
      throw new TypeError("removeTokenFileOnClose must be a boolean.");
    }
    this.removeTokenFileOnClose =
      (candidate.removeTokenFileOnClose as boolean | undefined) ?? true;
  }

  async start(): Promise<DashboardHandle> {
    if (this.started) throw new Error("Control dashboard has already been started.");
    this.started = true;
    const token = randomDashboardSecret("meshd");
    const bootstrapCode = randomDashboardSecret("meshb");
    const sessionToken = randomDashboardSecret("meshs");
    const ownerNonce = randomBytes(24).toString("base64url");
    const auth: DashboardAuthState = {
      bearerToken: token,
      sessionToken,
      bootstrapDigest: digest(bootstrapCode),
      bootstrapConsumed: false,
    };
    const clients = new Set<ServerResponse>();
    let eventSequence = 0;
    let closed = false;
    let detachProgress: (() => void) | undefined;
    let origin = "";

    const publishProgress = (event: DashboardProgressEvent): void => {
      if (closed) return;
      const safe = safeProgressEvent(event);
      const frame = `id: ${++eventSequence}\nevent: progress\ndata: ${JSON.stringify(
        safe,
      )}\n\n`;
      for (const client of clients) {
        if (
          client.destroyed ||
          client.writableEnded ||
          client.writableLength > MAX_SSE_CLIENT_BUFFER_BYTES
        ) {
          clients.delete(client);
          client.destroy();
          continue;
        }
        client.write(frame);
      }
    };

    const server = createServer((request, response) => {
      void this.handleRequest(
        request,
        response,
        auth,
        clients,
        origin,
      ).catch(() => {
        if (!response.headersSent) {
          sendError(
            request,
            response,
            503,
            "Dashboard snapshot is temporarily unavailable.",
          );
        } else {
          response.destroy();
        }
      });
    });
    server.maxHeadersCount = 64;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });

    try {
      await writePrivateTokenFile(this.tokenFile, token, ownerNonce);
      await listen(server, this.host, this.port);
      if (this.sources.subscribeProgress) {
        const detached = this.sources.subscribeProgress(publishProgress);
        if (typeof detached !== "function") {
          throw new TypeError(
            "sources.subscribeProgress must return an unsubscribe function.",
          );
        }
        detachProgress = detached;
      }
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      await removeOwnedTokenFile(this.tokenFile, token, ownerNonce);
      this.started = false;
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      await removeOwnedTokenFile(this.tokenFile, token, ownerNonce);
      this.started = false;
      throw new Error("Dashboard did not bind a TCP loopback address.");
    }
    if (!isLoopbackAddress(address.address)) {
      await closeServer(server);
      await removeOwnedTokenFile(this.tokenFile, token, ownerNonce);
      this.started = false;
      throw new Error("Dashboard refused a non-loopback listener.");
    }

    const keepAlive = setInterval(() => {
      for (const client of clients) {
        if (client.destroyed || client.writableEnded) {
          clients.delete(client);
        } else {
          client.write(`: keepalive ${Date.now()}\n\n`);
        }
      }
    }, this.sseKeepAliveMs);
    keepAlive.unref();

    const port = address.port;
    origin =
      this.host === "::1"
        ? `http://[::1]:${port}`
        : `http://${this.host}:${port}`;
    let closePromise: Promise<void> | undefined;
    const handle = {
      server,
      host: this.host,
      port,
      origin,
      tokenFile: this.tokenFile,
      bootstrapPath: DASHBOARD_API_PATHS.bootstrap,
      bootstrapUrl: `${origin}${DASHBOARD_API_PATHS.bootstrap}`,
      publishProgress,
      close: () => {
        closePromise ??= (async () => {
          closed = true;
          clearInterval(keepAlive);
          detachProgress?.();
          for (const client of clients) client.end();
          clients.clear();
          await closeServer(server);
          if (this.removeTokenFileOnClose) {
            await removeOwnedTokenFile(this.tokenFile, token, ownerNonce);
          } else {
            ACTIVE_TOKEN_OWNERS.delete(this.tokenFile);
          }
        })();
        return closePromise;
      },
    } as DashboardHandle;
    Object.defineProperty(handle, "bootstrapCode", {
      configurable: false,
      enumerable: false,
      value: bootstrapCode,
      writable: false,
    });
    return handle;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: DashboardAuthState,
    clients: Set<ServerResponse>,
    origin: string,
  ): Promise<void> {
    const rawUrl = request.url ?? "/";
    if (
      unsafeRequestTarget(rawUrl) ||
      rawUrl.includes("?") ||
      !origin
    ) {
      sendError(request, response, 400, "Invalid dashboard request.");
      return;
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendError(request, response, 403, "Dashboard is loopback-only.");
      return;
    }
    if (!requestTargetsOrigin(request, origin)) {
      sendError(request, response, 403, "Dashboard request origin is invalid.");
      return;
    }

    const path = new URL(rawUrl, origin).pathname;
    if (path === DASHBOARD_API_PATHS.bootstrap) {
      await this.handleBootstrapRequest(request, response, auth);
      return;
    }

    if (
      request.headers["transfer-encoding"] !== undefined ||
      (request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0")
    ) {
      sendError(request, response, 400, "Invalid dashboard request.");
      return;
    }
    if (
      !bearerAuthorized(request, auth.bearerToken) &&
      !cookieAuthorized(request, auth.sessionToken)
    ) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="agent-mesh-dashboard"');
      sendError(request, response, 401, "Bearer authentication required.");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendError(request, response, 405, "Dashboard endpoints are read-only.");
      return;
    }

    if (path === DASHBOARD_API_PATHS.progress) {
      if (request.method === "HEAD") {
        securityHeaders(response);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.end();
        return;
      }
      securityHeaders(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Connection", "keep-alive");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      response.write(
        `retry: 2000\nevent: ready\ndata: ${JSON.stringify({
          connectedAt: new Date().toISOString(),
        })}\n\n`,
      );
      clients.add(response);
      request.once("close", () => clients.delete(response));
      response.once("close", () => clients.delete(response));
      return;
    }

    if (path === DASHBOARD_API_PATHS.snapshot) {
      const snapshots = await this.readAllSnapshots();
      sendJson(request, response, 200, {
        generatedAt: new Date().toISOString(),
        data: snapshots,
      });
      return;
    }

    const sourceName = PATH_TO_SOURCE.get(path);
    if (sourceName && sourceName !== "subscribeProgress") {
      const reader = this.sources[sourceName];
      if (!reader) {
        sendError(request, response, 404, "Dashboard source is not enabled.");
        return;
      }
      const data =
        sourceName === "sessions"
          ? createDashboardSessionsSnapshot(await reader())
          : sanitizeSnapshot(await reader());
      sendJson(request, response, 200, {
        generatedAt: new Date().toISOString(),
        data,
      });
      return;
    }

    if (path === "/") {
      const generatedAt = new Date().toISOString();
      const snapshots = await this.readAllSnapshots();
      sendBody(
        request,
        response,
        200,
        "text/html; charset=utf-8",
        renderDashboard(snapshots, generatedAt),
      );
      return;
    }

    sendError(request, response, 404, "Dashboard route not found.");
  }

  private async handleBootstrapRequest(
    request: IncomingMessage,
    response: ServerResponse,
    auth: DashboardAuthState,
  ): Promise<void> {
    if (request.method === "GET" || request.method === "HEAD") {
      if (cookieAuthorized(request, auth.sessionToken)) {
        sendRedirect(request, response, "/");
        return;
      }
      sendBody(
        request,
        response,
        200,
        "text/html; charset=utf-8",
        renderBootstrap(),
      );
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "GET, HEAD, POST");
      sendError(request, response, 405, "Unsupported bootstrap method.");
      return;
    }
    if (
      request.headers["transfer-encoding"] !== undefined ||
      request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/x-www-form-urlencoded"
    ) {
      sendError(request, response, 400, "Invalid bootstrap request.");
      return;
    }

    let body: string;
    try {
      body = await readBoundedBody(request, MAX_BOOTSTRAP_BODY_BYTES);
    } catch (error) {
      sendError(
        request,
        response,
        error instanceof RangeError ? 413 : 400,
        "Invalid bootstrap request.",
      );
      return;
    }
    const values = new URLSearchParams(body);
    const keys = [...values.keys()];
    const codes = values.getAll("code");
    if (
      keys.some((key) => key !== "code") ||
      codes.length !== 1 ||
      !codes[0] ||
      codes[0].length > 512
    ) {
      sendError(request, response, 400, "Invalid bootstrap request.");
      return;
    }
    if (auth.bootstrapConsumed) {
      sendError(request, response, 410, "Bootstrap code has already been consumed.");
      return;
    }
    if (
      !timingSafeEqual(
        digest(codes[0]),
        auth.bootstrapDigest,
      )
    ) {
      sendError(request, response, 401, "Invalid bootstrap code.");
      return;
    }
    auth.bootstrapConsumed = true;
    sendRedirect(
      request,
      response,
      "/",
      sessionCookie(auth.sessionToken),
    );
  }

  private async readAllSnapshots(): Promise<SafeSnapshots> {
    const [tasks, sessions, questions, usage, workers, traffic, peers] = await Promise.all([
      this.sources.tasks(),
      this.sources.sessions(),
      this.sources.questions(),
      this.sources.usage(),
      this.sources.workers(),
      this.sources.traffic?.() ?? [],
      this.sources.peers?.() ?? [],
    ]);
    return {
      tasks: sanitizeSnapshot(tasks),
      sessions: createDashboardSessionsSnapshot(sessions),
      questions: sanitizeSnapshot(questions),
      usage: sanitizeSnapshot(usage),
      workers: sanitizeSnapshot(workers),
      traffic: sanitizeSnapshot(traffic),
      peers: sanitizeSnapshot(peers),
    };
  }
}

function isAbsoluteTokenPath(value: string): boolean {
  return isAbsolute(value) && !value.includes("\0");
}

export function createControlDashboard(
  options: DashboardOptions,
): ControlDashboard {
  return new ControlDashboard(options);
}

export function startDashboard(
  options: DashboardOptions,
): Promise<DashboardHandle> {
  return new ControlDashboard(options).start();
}
