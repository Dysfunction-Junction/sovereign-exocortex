import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MCP_PROFILES, type McpProfile } from "./mcp-profiles.js";
import { redactSecrets, stateDirectory } from "./security.js";
import {
  PROVIDERS,
  TASK_MODES,
  type Origin,
  type Provider,
  type TaskMode,
} from "./types.js";

export const WORKER_KINDS = ["local", "ssh"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

export const WORKER_STATUSES = [
  "disabled",
  "never_seen",
  "online",
  "stale",
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const WORKER_DISPATCH_PROTOCOL = "agent-mesh-worker-dispatch/v3" as const;
export const WORKER_CAPABILITY_PROTOCOL = "agent-mesh-worker/v3" as const;

const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROVIDER_SET = new Set<string>(PROVIDERS);
const MODE_SET = new Set<string>(TASK_MODES);
const MCP_PROFILE_SET = new Set<string>(MCP_PROFILES);
const ISOLATION_MODES = ["auto", "none", "worktree"] as const;
const ISOLATION_SET = new Set<string>(ISOLATION_MODES);
const DEFAULT_HEARTBEAT_TTL_MS = 45_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;
const MIN_LOCAL_HEARTBEAT_INTERVAL_MS = 10;
const MIN_OPERATION_TIMEOUT_MS = 100;
const MAX_OPERATION_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_MODELS = 1_000;
const MAX_MODEL_ID_BYTES = 256;
const MAX_HEALTH_MESSAGE_BYTES = 2_000;
const MAX_PROMPT_BYTES = 1024 * 1024;

export type WorkerTransport =
  | { kind: "local" }
  | { kind: "ssh"; alias: string };

export interface WorkerCapabilities {
  protocol: typeof WORKER_CAPABILITY_PROTOCOL;
  maxConcurrentTasks: number;
  modes: TaskMode[];
  isolation: Array<(typeof ISOLATION_MODES)[number]>;
}

export interface WorkerProviderInventory {
  provider: Provider;
  installed: boolean;
  version: string | null;
  models: string[];
}

export interface WorkerSnapshot {
  id: string;
  name: string;
  transport: WorkerTransport;
  controlEndpoint: string | null;
  enabled: boolean;
  status: WorkerStatus;
  activeTasks: number;
  capabilities: WorkerCapabilities | null;
  providers: WorkerProviderInventory[];
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  heartbeatExpiresAt: string | null;
}

export interface RegisterWorkerInput {
  name: string;
  transport: WorkerTransport;
  controlEndpoint?: string;
  confirmation: string;
}

export interface WorkerRegistration {
  worker: WorkerSnapshot;
  /**
   * Returned exactly once. The durable registry stores only its SHA-256 digest.
   * Deliver this value to the fixed worker companion over a separate secure
   * channel; it is never included in list/status/dashboard records. For local
   * workers this property is intentionally non-enumerable so model-facing MCP
   * serialization cannot disclose it to the caller that registered the local
   * in-process worker.
   */
  token: string;
}

export interface WorkerHeartbeatInput {
  workerId: string;
  token: string;
  activeTasks: number;
  capabilities: WorkerCapabilities;
  providers: WorkerProviderInventory[];
}

export interface WorkerMutationInput {
  workerId: string;
  confirmation: string;
}

export interface WorkerRemoval {
  id: string;
  removed: true;
}

export interface WorkerRegistryOptions {
  path?: string;
  /**
   * SSH targets are aliases from an operator-maintained SSH configuration.
   * An empty allowlist (the default) disables SSH worker registration.
   */
  allowedSshAliases?: readonly string[];
  heartbeatTtlMs?: number;
  /**
   * Interval used by the registry-owned local heartbeat. The timer starts only
   * after the local worker submits one authenticated heartbeat.
   */
  localHeartbeatIntervalMs?: number;
  companion?: WorkerCompanion;
  now?: () => Date;
  idFactory?: () => string;
}

export interface LocalWorkerRefreshInput {
  activeTasks: number;
  capabilities: WorkerCapabilities;
  providers: WorkerProviderInventory[];
}

export interface LocalWorkerHeartbeatHandle {
  readonly workerId: string;
  refresh(input?: LocalWorkerRefreshInput): WorkerSnapshot;
  stop(): void;
}

export interface WorkerDispatchTask {
  taskId: string;
  origin: Origin;
  provider: Provider;
  prompt: string;
  description: string;
  cwd: string;
  mode: TaskMode;
  model: string | null;
  effort: string | null;
  mcpProfile: McpProfile;
  isolation: (typeof ISOLATION_MODES)[number];
  timeoutMs: number;
  baseRef: string | null;
}

export interface WorkerDispatchEnvelope {
  protocol: typeof WORKER_DISPATCH_PROTOCOL;
  dispatchId: string;
  workerId: string;
  issuedAt: string;
  expiresAt: string;
  task: WorkerDispatchTask;
}

export interface CreateWorkerDispatchInput {
  workerId: string;
  task: WorkerDispatchTask;
}

export interface CreateWorkerDispatchOptions {
  now?: Date;
  idFactory?: () => string;
  handoffTtlMs?: number;
}

export interface WorkerProbeReply {
  health: "healthy" | "degraded";
  message?: string;
  checkedAt?: string;
}

export interface WorkerHealthProbe {
  workerId: string;
  health: "healthy" | "degraded";
  message: string | null;
  checkedAt: string;
  durationMs: number;
}

export interface WorkerDispatchAcceptance {
  dispatchId: string;
  accepted: true;
  remoteTaskId: string;
  acceptedAt: string;
}

export const WORKER_DISPATCH_BARRIER_STATES = [
  "pending",
  "accepted",
  "quarantined",
  "late_accepted",
  "late_rejected",
  "late_invalid",
] as const;
export type WorkerDispatchBarrierState =
  (typeof WORKER_DISPATCH_BARRIER_STATES)[number];

export interface WorkerDispatchQuarantine {
  dispatchId: string;
  workerId: string;
  state: Exclude<WorkerDispatchBarrierState, "pending" | "accepted">;
  reason: string;
  createdAt: string;
  resolvedAt: string;
  remoteTaskId: string | null;
  acceptedAt: string | null;
}

export interface WorkerCompanionProbeRequest {
  worker: WorkerSnapshot;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface WorkerCompanionDispatchRequest {
  worker: WorkerSnapshot;
  envelope: WorkerDispatchEnvelope;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * The sole remote-transport boundary. Implementations may contact a fixed
 * companion through a registered HTTPS endpoint or a preconfigured SSH alias,
 * but callers cannot provide a command, host, shell fragment, environment, or
 * argv. No default implementation exists, so missing integration fails closed.
 */
export interface WorkerCompanion {
  probe(request: Readonly<WorkerCompanionProbeRequest>): Promise<WorkerProbeReply>;
  dispatch(
    request: Readonly<WorkerCompanionDispatchRequest>,
  ): Promise<WorkerDispatchAcceptance>;
}

export class WorkerCompanionUnavailableError extends Error {
  constructor(operation: "probe" | "dispatch") {
    super(
      `Worker ${operation} requires an installed companion transport; no companion is configured.`,
    );
    this.name = "WorkerCompanionUnavailableError";
  }
}

export class WorkerAuthenticationError extends Error {
  constructor() {
    super("Invalid worker credentials.");
    this.name = "WorkerAuthenticationError";
  }
}

export class WorkerOperationTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms.`);
    this.name = "WorkerOperationTimeoutError";
  }
}

export class WorkerConfirmationError extends Error {
  constructor(
    readonly operation: "register" | "disable" | "remove",
    readonly requiredConfirmation: string,
  ) {
    super(
      `Refusing worker ${operation}; confirmation must exactly equal "${requiredConfirmation}".`,
    );
    this.name = "WorkerConfirmationError";
  }
}

type Row = Record<string, unknown>;

interface StoredWorker {
  id: string;
  name: string;
  kind: WorkerKind;
  sshAlias: string | null;
  controlEndpoint: string | null;
  enabled: boolean;
  tokenHash: string;
  activeTasks: number;
  capabilities: WorkerCapabilities | null;
  providers: WorkerProviderInventory[];
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
}

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
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${name} contains unsupported fields: ${unexpected.join(", ")}.`);
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

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  return boundedInteger(
    value ?? fallback,
    name,
    MIN_OPERATION_TIMEOUT_MS,
    MAX_OPERATION_TIMEOUT_MS,
  );
}

function nonEmptyString(
  value: unknown,
  name: string,
  maxBytes: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  const result = value.trim();
  if (Buffer.byteLength(result) > maxBytes) {
    throw new RangeError(`${name} must not exceed ${maxBytes} bytes.`);
  }
  if (/[\u0000-\u001F\u007F]/u.test(result)) {
    throw new TypeError(`${name} must not contain control characters.`);
  }
  return result;
}

function safeIdentifier(value: unknown, name: string): string {
  const result = nonEmptyString(value, name, 256);
  if (!SAFE_IDENTIFIER_PATTERN.test(result)) {
    throw new TypeError(`${name} contains unsupported characters.`);
  }
  return result;
}

function workerName(value: unknown): string {
  const result = nonEmptyString(value, "name", 80);
  if (!WORKER_NAME_PATTERN.test(result)) {
    throw new TypeError(
      "name must start with an ASCII letter or number and contain only letters, numbers, spaces, periods, underscores, or hyphens.",
    );
  }
  return result;
}

function sshAlias(value: unknown): string {
  if (typeof value !== "string" || !SSH_ALIAS_PATTERN.test(value)) {
    throw new TypeError(
      "SSH alias must be 1-128 ASCII letters, numbers, periods, underscores, or hyphens and may not begin with a hyphen.",
    );
  }
  return value;
}

function controlEndpoint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const raw = nonEmptyString(value, "controlEndpoint", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("controlEndpoint must be a valid HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(
      "controlEndpoint must be an HTTPS URL without credentials, query parameters, or a fragment.",
    );
  }
  const decodedPath = decodeURIComponent(parsed.pathname);
  if (
    decodedPath.includes("\\") ||
    decodedPath.split("/").some((segment) => segment === "..")
  ) {
    throw new TypeError("controlEndpoint contains an unsafe path.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizedTransport(
  value: unknown,
  allowedSshAliases: ReadonlySet<string>,
): WorkerTransport {
  const candidate = object(value, "transport");
  if (candidate.kind === "local") {
    assertOnlyKeys(candidate, ["kind"], "local transport");
    return { kind: "local" };
  }
  if (candidate.kind === "ssh") {
    assertOnlyKeys(candidate, ["kind", "alias"], "SSH transport");
    const alias = sshAlias(candidate.alias);
    if (!allowedSshAliases.has(alias)) {
      throw new Error(`SSH alias is not preconfigured for agent-mesh workers: ${alias}`);
    }
    return { kind: "ssh", alias };
  }
  throw new TypeError("transport.kind must be local or ssh.");
}

function stringArray<T extends string>(
  value: unknown,
  name: string,
  allowed: ReadonlySet<string>,
  maximum: number,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${name} must be an array with at most ${maximum} entries.`);
  }
  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new TypeError(`${name} contains an unsupported value: ${String(item)}.`);
    }
    if (!result.includes(item as T)) result.push(item as T);
  }
  return result;
}

function normalizeCapabilities(value: unknown): WorkerCapabilities {
  const candidate = object(value, "capabilities");
  assertOnlyKeys(
    candidate,
    ["protocol", "maxConcurrentTasks", "modes", "isolation"],
    "capabilities",
  );
  if (candidate.protocol !== WORKER_CAPABILITY_PROTOCOL) {
    throw new TypeError(`capabilities.protocol must equal ${WORKER_CAPABILITY_PROTOCOL}.`);
  }
  return {
    protocol: WORKER_CAPABILITY_PROTOCOL,
    maxConcurrentTasks: boundedInteger(
      candidate.maxConcurrentTasks,
      "capabilities.maxConcurrentTasks",
      1,
      256,
    ),
    modes: stringArray<TaskMode>(
      candidate.modes,
      "capabilities.modes",
      MODE_SET,
      TASK_MODES.length,
    ),
    isolation: stringArray<(typeof ISOLATION_MODES)[number]>(
      candidate.isolation,
      "capabilities.isolation",
      ISOLATION_SET,
      ISOLATION_MODES.length,
    ),
  };
}

function normalizeProviderInventory(value: unknown): WorkerProviderInventory[] {
  if (!Array.isArray(value) || value.length > PROVIDERS.length) {
    throw new TypeError(
      `providers must be an array with at most ${PROVIDERS.length} entries.`,
    );
  }
  const seen = new Set<Provider>();
  return value.map((raw, index) => {
    const candidate = object(raw, `providers[${index}]`);
    assertOnlyKeys(
      candidate,
      ["provider", "installed", "version", "models"],
      `providers[${index}]`,
    );
    if (typeof candidate.provider !== "string" || !PROVIDER_SET.has(candidate.provider)) {
      throw new TypeError(`providers[${index}].provider is unsupported.`);
    }
    const provider = candidate.provider as Provider;
    if (seen.has(provider)) {
      throw new TypeError(`providers contains duplicate provider: ${provider}.`);
    }
    seen.add(provider);
    if (typeof candidate.installed !== "boolean") {
      throw new TypeError(`providers[${index}].installed must be a boolean.`);
    }
    const version =
      candidate.version === null
        ? null
        : nonEmptyString(candidate.version, `providers[${index}].version`, 128);
    if (!Array.isArray(candidate.models) || candidate.models.length > MAX_PROVIDER_MODELS) {
      throw new TypeError(
        `providers[${index}].models must contain at most ${MAX_PROVIDER_MODELS} entries.`,
      );
    }
    const models: string[] = [];
    for (const rawModel of candidate.models) {
      const model = nonEmptyString(
        rawModel,
        `providers[${index}].models`,
        MAX_MODEL_ID_BYTES,
      );
      if (model.startsWith("-") || /\s/u.test(model)) {
        throw new TypeError(`Unsafe provider model identifier: ${model}.`);
      }
      if (!models.includes(model)) models.push(model);
    }
    if (!candidate.installed && (version !== null || models.length > 0)) {
      throw new TypeError(
        `providers[${index}] cannot report a version or models when not installed.`,
      );
    }
    return {
      provider,
      installed: candidate.installed,
      version,
      models,
    };
  });
}

function isoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be an ISO timestamp.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${name} must be an ISO timestamp.`);
  }
  return date.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storedWorker(row: Row): StoredWorker {
  const kind = String(row.kind) as WorkerKind;
  return {
    id: String(row.id),
    name: String(row.name),
    kind,
    sshAlias: row.ssh_alias === null ? null : String(row.ssh_alias),
    controlEndpoint:
      row.control_endpoint === null ? null : String(row.control_endpoint),
    enabled: Number(row.enabled) === 1,
    tokenHash: String(row.token_hash),
    activeTasks: Number(row.active_tasks),
    capabilities: parseJson<WorkerCapabilities | null>(
      row.capabilities_json,
      null,
    ),
    providers: parseJson<WorkerProviderInventory[]>(row.providers_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastHeartbeatAt:
      row.last_heartbeat_at === null ? null : String(row.last_heartbeat_at),
  };
}

function dispatchQuarantine(row: Row): WorkerDispatchQuarantine {
  const state = String(row.state) as WorkerDispatchBarrierState;
  if (state === "pending" || state === "accepted") {
    throw new Error("Dispatch is not quarantined.");
  }
  return {
    dispatchId: String(row.dispatch_id),
    workerId: String(row.worker_id),
    state,
    reason: String(row.reason),
    createdAt: String(row.created_at),
    resolvedAt: String(row.resolved_at),
    remoteTaskId:
      row.remote_task_id === null ? null : String(row.remote_task_id),
    acceptedAt: row.accepted_at === null ? null : String(row.accepted_at),
  };
}

function snapshot(
  worker: StoredWorker,
  now: Date,
  heartbeatTtlMs: number,
): WorkerSnapshot {
  const lastHeartbeat = worker.lastHeartbeatAt
    ? new Date(worker.lastHeartbeatAt)
    : null;
  const heartbeatExpiresAt = lastHeartbeat
    ? new Date(lastHeartbeat.getTime() + heartbeatTtlMs).toISOString()
    : null;
  const status: WorkerStatus = !worker.enabled
    ? "disabled"
    : !lastHeartbeat
      ? "never_seen"
      : now.getTime() <= lastHeartbeat.getTime() + heartbeatTtlMs
        ? "online"
        : "stale";
  const transport: WorkerTransport =
    worker.kind === "local"
      ? { kind: "local" }
      : { kind: "ssh", alias: worker.sshAlias! };
  return {
    id: worker.id,
    name: worker.name,
    transport,
    controlEndpoint: worker.controlEndpoint,
    enabled: worker.enabled,
    status,
    activeTasks: worker.activeTasks,
    capabilities: worker.capabilities
      ? {
          ...worker.capabilities,
          modes: [...worker.capabilities.modes],
          isolation: [...worker.capabilities.isolation],
        }
      : null,
    providers: worker.providers.map((provider) => ({
      ...provider,
      models: [...provider.models],
    })),
    createdAt: worker.createdAt,
    updatedAt: worker.updatedAt,
    lastHeartbeatAt: worker.lastHeartbeatAt,
    heartbeatExpiresAt,
  };
}

function defaultWorkerToken(): string {
  return `meshw_${randomBytes(32).toString("base64url")}`;
}

function tokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

function validToken(token: unknown): string {
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 512 ||
    /\s|\u0000/u.test(token)
  ) {
    throw new WorkerAuthenticationError();
  }
  return token;
}

function tokenMatches(token: string, expectedDigest: string): boolean {
  const actual = Buffer.from(tokenDigest(token), "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function workerRegistrationConfirmation(name: string): string {
  return `REGISTER WORKER ${workerName(name)}`;
}

export function workerDisableConfirmation(workerId: string): string {
  return `DISABLE WORKER ${safeIdentifier(workerId, "workerId")}`;
}

export function workerRemoveConfirmation(workerId: string): string {
  return `REMOVE WORKER ${safeIdentifier(workerId, "workerId")}`;
}

function assertConfirmation(
  provided: unknown,
  required: string,
  operation: WorkerConfirmationError["operation"],
): void {
  if (provided !== required) throw new WorkerConfirmationError(operation, required);
}

function normalizedHeartbeat(input: WorkerHeartbeatInput): {
  workerId: string;
  token: string;
  activeTasks: number;
  capabilities: WorkerCapabilities;
  providers: WorkerProviderInventory[];
} {
  const candidate = object(input, "heartbeat");
  assertOnlyKeys(
    candidate,
    ["workerId", "token", "activeTasks", "capabilities", "providers"],
    "heartbeat",
  );
  return {
    workerId: safeIdentifier(candidate.workerId, "workerId"),
    token: validToken(candidate.token),
    activeTasks: boundedInteger(
      candidate.activeTasks,
      "activeTasks",
      0,
      100_000,
    ),
    capabilities: normalizeCapabilities(candidate.capabilities),
    providers: normalizeProviderInventory(candidate.providers),
  };
}

function normalizedLocalRefresh(input: LocalWorkerRefreshInput): LocalWorkerRefreshInput {
  const candidate = object(input, "local worker refresh");
  assertOnlyKeys(
    candidate,
    ["activeTasks", "capabilities", "providers"],
    "local worker refresh",
  );
  const capabilities = normalizeCapabilities(candidate.capabilities);
  const activeTasks = boundedInteger(
    candidate.activeTasks,
    "activeTasks",
    0,
    100_000,
  );
  if (activeTasks > capabilities.maxConcurrentTasks) {
    throw new RangeError(
      "activeTasks cannot exceed capabilities.maxConcurrentTasks.",
    );
  }
  return {
    activeTasks,
    capabilities,
    providers: normalizeProviderInventory(candidate.providers),
  };
}

function normalizeMutation(
  input: WorkerMutationInput,
  operation: "disable" | "remove",
): { workerId: string; confirmation: string } {
  const candidate = object(input, `${operation} input`);
  assertOnlyKeys(candidate, ["workerId", "confirmation"], `${operation} input`);
  const workerId = safeIdentifier(candidate.workerId, "workerId");
  const confirmation =
    typeof candidate.confirmation === "string" ? candidate.confirmation : "";
  const required =
    operation === "disable"
      ? workerDisableConfirmation(workerId)
      : workerRemoveConfirmation(workerId);
  assertConfirmation(confirmation, required, operation);
  return { workerId, confirmation };
}

function assertProvider(value: unknown, name: string): Provider {
  if (typeof value !== "string" || !PROVIDER_SET.has(value)) {
    throw new TypeError(`${name} must be one of: ${PROVIDERS.join(", ")}.`);
  }
  return value as Provider;
}

function assertMode(value: unknown): TaskMode {
  if (typeof value !== "string" || !MODE_SET.has(value)) {
    throw new TypeError(`task.mode must be one of: ${TASK_MODES.join(", ")}.`);
  }
  return value as TaskMode;
}

function nullableText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string | null {
  return value === null ? null : nonEmptyString(value, name, maximumBytes);
}

function normalizeDispatchTask(value: unknown): WorkerDispatchTask {
  const task = object(value, "task");
  assertOnlyKeys(
    task,
    [
      "taskId",
      "origin",
      "provider",
      "prompt",
      "description",
      "cwd",
      "mode",
      "model",
      "effort",
      "mcpProfile",
      "isolation",
      "timeoutMs",
      "baseRef",
    ],
    "task",
  );
  const origin = assertProvider(task.origin, "task.origin") as Origin;
  const provider = assertProvider(task.provider, "task.provider");
  if (origin === provider) {
    throw new Error("Worker dispatch refuses recursive provider delegation.");
  }
  const cwd = nonEmptyString(task.cwd, "task.cwd", 4_096);
  if (!isAbsolute(cwd) || cwd.includes("\0")) {
    throw new TypeError("task.cwd must be an absolute path.");
  }
  if (typeof task.mcpProfile !== "string" || !MCP_PROFILE_SET.has(task.mcpProfile)) {
    throw new TypeError(`task.mcpProfile must be one of: ${MCP_PROFILES.join(", ")}.`);
  }
  if (typeof task.isolation !== "string" || !ISOLATION_SET.has(task.isolation)) {
    throw new TypeError(
      `task.isolation must be one of: ${ISOLATION_MODES.join(", ")}.`,
    );
  }
  return {
    taskId: safeIdentifier(task.taskId, "task.taskId"),
    origin,
    provider,
    prompt: nonEmptyString(task.prompt, "task.prompt", MAX_PROMPT_BYTES),
    description: nonEmptyString(task.description, "task.description", 160),
    cwd,
    mode: assertMode(task.mode),
    model: nullableText(task.model, "task.model", 256),
    effort: nullableText(task.effort, "task.effort", 64),
    mcpProfile: task.mcpProfile as McpProfile,
    isolation: task.isolation as WorkerDispatchTask["isolation"],
    timeoutMs: boundedInteger(
      task.timeoutMs,
      "task.timeoutMs",
      1_000,
      7_200_000,
    ),
    baseRef: nullableText(task.baseRef, "task.baseRef", 512),
  };
}

export function createWorkerDispatchEnvelope(
  input: CreateWorkerDispatchInput,
  options: CreateWorkerDispatchOptions = {},
): WorkerDispatchEnvelope {
  const candidate = object(input, "dispatch input");
  assertOnlyKeys(candidate, ["workerId", "task"], "dispatch input");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date.");
  const handoffTtlMs = boundedTimeout(
    options.handoffTtlMs,
    DEFAULT_DISPATCH_TIMEOUT_MS,
    "handoffTtlMs",
  );
  return {
    protocol: WORKER_DISPATCH_PROTOCOL,
    dispatchId: safeIdentifier(
      (options.idFactory ?? randomUUID)(),
      "dispatchId",
    ),
    workerId: safeIdentifier(candidate.workerId, "workerId"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + handoffTtlMs).toISOString(),
    task: normalizeDispatchTask(candidate.task),
  };
}

export function assertWorkerDispatchEnvelope(
  value: unknown,
): WorkerDispatchEnvelope {
  const envelope = object(value, "dispatch envelope");
  assertOnlyKeys(
    envelope,
    ["protocol", "dispatchId", "workerId", "issuedAt", "expiresAt", "task"],
    "dispatch envelope",
  );
  if (envelope.protocol !== WORKER_DISPATCH_PROTOCOL) {
    throw new TypeError(`dispatch protocol must equal ${WORKER_DISPATCH_PROTOCOL}.`);
  }
  const issuedAt = isoTimestamp(envelope.issuedAt, "issuedAt");
  const expiresAt = isoTimestamp(envelope.expiresAt, "expiresAt");
  const lifetimeMs =
    new Date(expiresAt).getTime() - new Date(issuedAt).getTime();
  if (lifetimeMs <= 0) {
    throw new TypeError("dispatch envelope must expire after it is issued.");
  }
  if (lifetimeMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new TypeError(
      `dispatch envelope lifetime must not exceed ${MAX_OPERATION_TIMEOUT_MS}ms.`,
    );
  }
  return {
    protocol: WORKER_DISPATCH_PROTOCOL,
    dispatchId: safeIdentifier(envelope.dispatchId, "dispatchId"),
    workerId: safeIdentifier(envelope.workerId, "workerId"),
    issuedAt,
    expiresAt,
    task: normalizeDispatchTask(envelope.task),
  };
}

interface BoundedCompanionCallHooks<T> {
  onTimeout?: () => void;
  onLateResult?: (value: T) => void;
  onLateError?: (error: unknown) => void;
}

function safelyRunLateHook<T>(
  hook: ((value: T) => void) | undefined,
  value: T,
): void {
  try {
    hook?.(value);
  } catch {
    // A quarantine observer must never turn a settled companion promise into
    // an unhandled rejection.
  }
}

async function boundedCompanionCall<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  operationName: string,
  hooks: BoundedCompanionCallHooks<T> = {},
): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let state: "active" | "settled" | "timed_out" = "active";
  let timer: NodeJS.Timeout | undefined;

  const markTimedOut = (): WorkerOperationTimeoutError => {
    if (state === "active") {
      state = "timed_out";
      controller.abort();
      safelyRunLateHook(hooks.onTimeout, undefined);
    }
    return new WorkerOperationTimeoutError(operationName, timeoutMs);
  };

  const operationPromise = Promise.resolve().then(() =>
    operation(controller.signal),
  );
  operationPromise.then(
    (value) => {
      if (state === "timed_out") safelyRunLateHook(hooks.onLateResult, value);
    },
    (error: unknown) => {
      if (state === "timed_out") safelyRunLateHook(hooks.onLateError, error);
    },
  );

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(markTimedOut()), timeoutMs);
  });

  try {
    const value = await Promise.race([operationPromise, timeout]);
    if (Date.now() >= deadline) {
      const error = markTimedOut();
      safelyRunLateHook(hooks.onLateResult, value);
      throw error;
    }
    state = "settled";
    return value;
  } catch (error) {
    if (
      !(error instanceof WorkerOperationTimeoutError) &&
      state === "active" &&
      Date.now() >= deadline
    ) {
      const timeoutError = markTimedOut();
      safelyRunLateHook(hooks.onLateError, error);
      throw timeoutError;
    }
    if (state === "active") state = "settled";
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeProbeReply(
  value: unknown,
  workerId: string,
  startedAt: number,
  now: () => Date,
): WorkerHealthProbe {
  const reply = object(value, "worker probe reply");
  assertOnlyKeys(reply, ["health", "message", "checkedAt"], "worker probe reply");
  if (reply.health !== "healthy" && reply.health !== "degraded") {
    throw new TypeError("worker probe health must be healthy or degraded.");
  }
  const checkedAt =
    reply.checkedAt === undefined
      ? now().toISOString()
      : isoTimestamp(reply.checkedAt, "worker probe checkedAt");
  const message =
    reply.message === undefined
      ? null
      : redactSecrets(
          nonEmptyString(
            reply.message,
            "worker probe message",
            MAX_HEALTH_MESSAGE_BYTES,
          ),
        );
  return {
    workerId,
    health: reply.health,
    message,
    checkedAt,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function normalizeDispatchAcceptance(
  value: unknown,
  envelope: WorkerDispatchEnvelope,
): WorkerDispatchAcceptance {
  const receipt = object(value, "worker dispatch acceptance");
  assertOnlyKeys(
    receipt,
    ["dispatchId", "accepted", "remoteTaskId", "acceptedAt"],
    "worker dispatch acceptance",
  );
  if (
    receipt.dispatchId !== envelope.dispatchId ||
    receipt.accepted !== true
  ) {
    throw new Error("Worker companion did not explicitly accept the dispatch.");
  }
  return {
    dispatchId: envelope.dispatchId,
    accepted: true,
    remoteTaskId: safeIdentifier(receipt.remoteTaskId, "remoteTaskId"),
    acceptedAt: isoTimestamp(receipt.acceptedAt, "acceptedAt"),
  };
}

export class WorkerRegistry {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly allowedSshAliases: ReadonlySet<string>;
  private readonly heartbeatTtlMs: number;
  private readonly localHeartbeatIntervalMs: number;
  private readonly companion?: WorkerCompanion;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly ownedLocalTokens = new Map<string, string>();
  private readonly localHeartbeatTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(options: WorkerRegistryOptions | string = {}) {
    const normalizedOptions =
      typeof options === "string" ? { path: options } : options;
    this.path =
      normalizedOptions.path ?? join(stateDirectory(), "workers.db");
    if (this.path === ":memory:") {
      throw new Error("Worker registry must use a durable private file.");
    }
    const parent = resolve(dirname(this.path));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.allowedSshAliases = new Set(
      (normalizedOptions.allowedSshAliases ?? []).map(sshAlias),
    );
    this.heartbeatTtlMs = boundedInteger(
      normalizedOptions.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS,
      "heartbeatTtlMs",
      1_000,
      24 * 60 * 60 * 1_000,
    );
    this.localHeartbeatIntervalMs = boundedInteger(
      normalizedOptions.localHeartbeatIntervalMs ??
        Math.max(
          MIN_LOCAL_HEARTBEAT_INTERVAL_MS,
          Math.floor(this.heartbeatTtlMs / 3),
        ),
      "localHeartbeatIntervalMs",
      MIN_LOCAL_HEARTBEAT_INTERVAL_MS,
      this.heartbeatTtlMs - 1,
    );
    this.companion = normalizedOptions.companion;
    this.now = normalizedOptions.now ?? (() => new Date());
    this.idFactory = normalizedOptions.idFactory ?? randomUUID;

    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        ssh_alias TEXT,
        control_endpoint TEXT,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        token_hash TEXT NOT NULL,
        active_tasks INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT,
        providers_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_heartbeat_at TEXT,
        CHECK (
          (kind = 'local' AND ssh_alias IS NULL) OR
          (kind = 'ssh' AND ssh_alias IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_one_local
        ON workers(kind) WHERE kind = 'local';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_ssh_alias
        ON workers(ssh_alias) WHERE ssh_alias IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_workers_enabled
        ON workers(enabled, updated_at DESC);
      CREATE TABLE IF NOT EXISTS worker_dispatch_barriers (
        dispatch_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN (
            'pending', 'accepted', 'quarantined',
            'late_accepted', 'late_rejected', 'late_invalid'
          )
        ),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        remote_task_id TEXT,
        accepted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_worker_dispatch_barriers_state
        ON worker_dispatch_barriers(state, created_at DESC);
    `);
    const recoveredAt = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE worker_dispatch_barriers
         SET state = 'quarantined', reason = 'registry_restart',
             resolved_at = ?
         WHERE state = 'pending'`,
      )
      .run(recoveredAt);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.localHeartbeatTimers.values()) clearInterval(timer);
    this.localHeartbeatTimers.clear();
    this.ownedLocalTokens.clear();
    this.db.close();
  }

  register(input: RegisterWorkerInput): WorkerRegistration {
    const candidate = object(input, "worker registration");
    assertOnlyKeys(
      candidate,
      ["name", "transport", "controlEndpoint", "confirmation"],
      "worker registration",
    );
    const name = workerName(candidate.name);
    assertConfirmation(
      candidate.confirmation,
      workerRegistrationConfirmation(name),
      "register",
    );
    const transport = normalizedTransport(
      candidate.transport,
      this.allowedSshAliases,
    );
    const endpoint = controlEndpoint(candidate.controlEndpoint);
    const id = safeIdentifier(this.idFactory(), "generated worker id");
    const token = defaultWorkerToken();
    const now = this.now().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO workers (
            id, name, kind, ssh_alias, control_endpoint, enabled, token_hash,
            active_tasks, capabilities_json, providers_json,
            created_at, updated_at, last_heartbeat_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, NULL, '[]', ?, ?, NULL)`,
        )
        .run(
          id,
          name,
          transport.kind,
          transport.kind === "ssh" ? transport.alias : null,
          endpoint,
          tokenDigest(token),
          now,
          now,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const registration = {
      worker: this.status(id),
    } as WorkerRegistration;
    if (transport.kind === "local") {
      this.ownedLocalTokens.set(id, token);
      Object.defineProperty(registration, "token", {
        configurable: false,
        enumerable: false,
        value: token,
        writable: false,
      });
    } else {
      registration.token = token;
    }
    return registration;
  }

  heartbeat(input: WorkerHeartbeatInput): WorkerSnapshot {
    const heartbeat = normalizedHeartbeat(input);
    const worker = this.stored(heartbeat.workerId);
    if (!worker || !tokenMatches(heartbeat.token, worker.tokenHash)) {
      throw new WorkerAuthenticationError();
    }
    if (!worker.enabled) throw new Error("Worker is disabled.");
    if (heartbeat.activeTasks > heartbeat.capabilities.maxConcurrentTasks) {
      throw new RangeError(
        "activeTasks cannot exceed capabilities.maxConcurrentTasks.",
      );
    }
    const now = this.now().toISOString();
    const result = this.db
      .prepare(
        `UPDATE workers
         SET active_tasks = ?, capabilities_json = ?, providers_json = ?,
             last_heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND enabled = 1`,
      )
      .run(
        heartbeat.activeTasks,
        JSON.stringify(heartbeat.capabilities),
        JSON.stringify(heartbeat.providers),
        now,
        now,
        heartbeat.workerId,
      );
    if (result.changes !== 1) {
      throw new Error("Worker changed while recording its heartbeat.");
    }
    if (
      worker.kind === "local" &&
      this.ownedLocalTokens.get(worker.id) === heartbeat.token
    ) {
      this.ensureLocalHeartbeat(worker.id);
    }
    return this.status(heartbeat.workerId);
  }

  /**
   * Refresh a registry-owned local worker without passing its credential back
   * through a model-facing API. Omitting input renews the last authenticated
   * capability snapshot; trusted in-process callers may supply current state.
   */
  refreshLocal(
    workerId: string,
    input?: LocalWorkerRefreshInput,
  ): WorkerSnapshot {
    const id = safeIdentifier(workerId, "workerId");
    if (!this.ownedLocalTokens.has(id)) {
      throw new WorkerAuthenticationError();
    }
    const worker = this.stored(id);
    if (!worker || worker.kind !== "local") {
      throw new Error("Local heartbeat ownership is no longer valid.");
    }
    if (!worker.enabled) throw new Error("Worker is disabled.");
    const refresh = input
      ? normalizedLocalRefresh(input)
      : worker.capabilities
        ? {
            activeTasks: worker.activeTasks,
            capabilities: worker.capabilities,
            providers: worker.providers,
          }
        : null;
    if (!refresh) {
      throw new Error(
        "Local worker must submit one authenticated heartbeat before refresh.",
      );
    }
    const now = this.now().toISOString();
    const result = this.db
      .prepare(
        `UPDATE workers
         SET active_tasks = ?, capabilities_json = ?, providers_json = ?,
             last_heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND kind = 'local' AND enabled = 1`,
      )
      .run(
        refresh.activeTasks,
        JSON.stringify(refresh.capabilities),
        JSON.stringify(refresh.providers),
        now,
        now,
        id,
      );
    if (result.changes !== 1) {
      throw new Error("Worker changed while refreshing its local heartbeat.");
    }
    return this.status(id);
  }

  /**
   * Ensure recurring refresh is active and return a token-free in-process
   * controller. Authenticated local heartbeats start this loop automatically.
   */
  startLocalHeartbeat(workerId: string): LocalWorkerHeartbeatHandle {
    const id = safeIdentifier(workerId, "workerId");
    this.refreshLocal(id);
    this.ensureLocalHeartbeat(id);
    return Object.freeze({
      workerId: id,
      refresh: (input?: LocalWorkerRefreshInput) => this.refreshLocal(id, input),
      stop: () => this.stopLocalHeartbeat(id),
    });
  }

  list(options: { includeDisabled?: boolean } = {}): WorkerSnapshot[] {
    const rows = this.db
      .prepare(
        options.includeDisabled === false
          ? "SELECT * FROM workers WHERE enabled = 1 ORDER BY created_at ASC"
          : "SELECT * FROM workers ORDER BY created_at ASC",
      )
      .all() as Row[];
    const now = this.now();
    return rows.map((row) =>
      snapshot(storedWorker(row), now, this.heartbeatTtlMs),
    );
  }

  status(workerId: string): WorkerSnapshot {
    const id = safeIdentifier(workerId, "workerId");
    const worker = this.stored(id);
    if (!worker) throw new Error(`Unknown worker: ${id}`);
    return snapshot(worker, this.now(), this.heartbeatTtlMs);
  }

  /**
   * Return metadata-only dispatches that crossed a terminal barrier without a
   * timely acceptance. Prompts and task payloads are never persisted here.
   */
  listQuarantinedDispatches(
    options: { workerId?: string } = {},
  ): WorkerDispatchQuarantine[] {
    const workerId =
      options.workerId === undefined
        ? undefined
        : safeIdentifier(options.workerId, "workerId");
    const rows = (
      workerId
        ? this.db
            .prepare(
              `SELECT * FROM worker_dispatch_barriers
               WHERE worker_id = ?
                 AND state NOT IN ('pending', 'accepted')
               ORDER BY created_at DESC`,
            )
            .all(workerId)
        : this.db
            .prepare(
              `SELECT * FROM worker_dispatch_barriers
               WHERE state NOT IN ('pending', 'accepted')
               ORDER BY created_at DESC`,
            )
            .all()
    ) as Row[];
    return rows.map(dispatchQuarantine);
  }

  disable(input: WorkerMutationInput): WorkerSnapshot {
    const mutation = normalizeMutation(input, "disable");
    const now = this.now().toISOString();
    const result = this.db
      .prepare(
        `UPDATE workers
         SET enabled = 0, active_tasks = 0, updated_at = ?
         WHERE id = ? AND enabled = 1`,
      )
      .run(now, mutation.workerId);
    if (result.changes !== 1) {
      const existing = this.stored(mutation.workerId);
      if (!existing) throw new Error(`Unknown worker: ${mutation.workerId}`);
      throw new Error("Worker is already disabled.");
    }
    this.stopLocalHeartbeat(mutation.workerId);
    this.ownedLocalTokens.delete(mutation.workerId);
    return this.status(mutation.workerId);
  }

  remove(input: WorkerMutationInput): WorkerRemoval {
    const mutation = normalizeMutation(input, "remove");
    const existing = this.stored(mutation.workerId);
    if (!existing) throw new Error(`Unknown worker: ${mutation.workerId}`);
    if (existing.enabled) {
      throw new Error("Worker must be disabled before removal.");
    }
    const result = this.db
      .prepare("DELETE FROM workers WHERE id = ? AND enabled = 0")
      .run(mutation.workerId);
    if (result.changes !== 1) {
      throw new Error("Worker changed while removing it.");
    }
    this.stopLocalHeartbeat(mutation.workerId);
    this.ownedLocalTokens.delete(mutation.workerId);
    return { id: mutation.workerId, removed: true };
  }

  async probe(
    workerId: string,
    options: { timeoutMs?: number; companion?: WorkerCompanion } = {},
  ): Promise<WorkerHealthProbe> {
    const worker = this.status(workerId);
    if (!worker.enabled) throw new Error("Cannot probe a disabled worker.");
    const companion = options.companion ?? this.companion;
    if (!companion) throw new WorkerCompanionUnavailableError("probe");
    const timeoutMs = boundedTimeout(
      options.timeoutMs,
      DEFAULT_PROBE_TIMEOUT_MS,
      "timeoutMs",
    );
    const startedAt = Date.now();
    const reply = await boundedCompanionCall(
      timeoutMs,
      (signal) => companion.probe({ worker, timeoutMs, signal }),
      "Worker health probe",
    );
    return normalizeProbeReply(reply, worker.id, startedAt, this.now);
  }

  async dispatch(
    workerId: string,
    value: WorkerDispatchEnvelope,
    options: { timeoutMs?: number; companion?: WorkerCompanion } = {},
  ): Promise<WorkerDispatchAcceptance> {
    const worker = this.status(workerId);
    if (!worker.enabled) throw new Error("Cannot dispatch to a disabled worker.");
    if (worker.status !== "online") {
      throw new Error(`Cannot dispatch to a worker whose status is ${worker.status}.`);
    }
    const envelope = assertWorkerDispatchEnvelope(value);
    if (envelope.workerId !== worker.id) {
      throw new Error("Dispatch envelope targets a different worker.");
    }
    const now = this.now().getTime();
    const issuedAt = new Date(envelope.issuedAt).getTime();
    const expiresAt = new Date(envelope.expiresAt).getTime();
    if (issuedAt > now + 5_000) {
      throw new Error("Dispatch envelope was issued in the future.");
    }
    if (expiresAt <= now) {
      throw new Error("Dispatch envelope has expired.");
    }
    const capabilities = worker.capabilities;
    if (!capabilities) {
      throw new Error("Worker has not advertised dispatch capabilities.");
    }
    if (worker.activeTasks >= capabilities.maxConcurrentTasks) {
      throw new Error("Worker has no advertised task capacity.");
    }
    if (!capabilities.modes.includes(envelope.task.mode)) {
      throw new Error(
        `Worker does not advertise support for task mode ${envelope.task.mode}.`,
      );
    }
    if (!capabilities.isolation.includes(envelope.task.isolation)) {
      throw new Error(
        `Worker does not advertise support for isolation mode ${envelope.task.isolation}.`,
      );
    }
    const inventory = worker.providers.find(
      (entry) => entry.provider === envelope.task.provider,
    );
    if (!inventory?.installed) {
      throw new Error(
        `Worker does not advertise an installed ${envelope.task.provider} provider.`,
      );
    }
    if (
      envelope.task.model !== null &&
      !inventory.models.includes(envelope.task.model)
    ) {
      throw new Error(
        `Worker does not advertise requested model ${envelope.task.model}.`,
      );
    }
    const companion = options.companion ?? this.companion;
    if (!companion) throw new WorkerCompanionUnavailableError("dispatch");
    const timeoutMs = Math.min(
      boundedTimeout(
        options.timeoutMs,
        DEFAULT_DISPATCH_TIMEOUT_MS,
        "timeoutMs",
      ),
      expiresAt - now,
    );
    const reservation = this.db
      .prepare(
        `UPDATE workers
         SET active_tasks = active_tasks + 1, updated_at = ?
         WHERE id = ? AND enabled = 1 AND active_tasks = ?
           AND active_tasks < ?`,
      )
      .run(
        this.now().toISOString(),
        worker.id,
        worker.activeTasks,
        capabilities.maxConcurrentTasks,
      );
    if (reservation.changes !== 1) {
      throw new Error("Worker capacity changed before dispatch could be reserved.");
    }
    try {
      this.beginDispatchBarrier(envelope);
      const acceptance = await boundedCompanionCall(
        timeoutMs,
        (signal) =>
          companion.dispatch({
            worker,
            envelope,
            timeoutMs,
            signal,
          }),
        "Worker dispatch",
        {
          onTimeout: () => {
            this.quarantineDispatch(envelope, "timeout");
          },
          onLateResult: (value) => {
            this.recordLateDispatchResult(envelope, value);
          },
          onLateError: () => {
            this.recordLateDispatchError(envelope);
          },
        },
      );
      const normalized = normalizeDispatchAcceptance(acceptance, envelope);
      const result = this.db
        .prepare(
          `UPDATE worker_dispatch_barriers
           SET state = 'accepted', reason = 'accepted', resolved_at = ?,
               remote_task_id = ?, accepted_at = ?
           WHERE dispatch_id = ? AND state = 'pending'`,
        )
        .run(
          this.now().toISOString(),
          normalized.remoteTaskId,
          normalized.acceptedAt,
          envelope.dispatchId,
        );
      if (result.changes !== 1) {
        this.recordLateDispatchResult(envelope, normalized);
        throw new Error(
          "Worker dispatch crossed its terminal barrier before acceptance.",
        );
      }
      return normalized;
    } catch (error) {
      this.completeDispatch(worker.id);
      if (!(error instanceof WorkerOperationTimeoutError)) {
        this.quarantineDispatch(envelope, "companion_error");
      }
      throw error;
    }
  }

  completeDispatch(workerId: string): WorkerSnapshot {
    const id = safeIdentifier(workerId, "workerId");
    const result = this.db
      .prepare(
        `UPDATE workers
         SET active_tasks = CASE WHEN active_tasks > 0 THEN active_tasks - 1 ELSE 0 END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now().toISOString(), id);
    if (result.changes !== 1) throw new Error(`Unknown worker: ${id}`);
    return this.status(id);
  }

  private beginDispatchBarrier(envelope: WorkerDispatchEnvelope): void {
    try {
      this.db
        .prepare(
          `INSERT INTO worker_dispatch_barriers (
             dispatch_id, worker_id, state, reason, created_at, resolved_at,
             remote_task_id, accepted_at
           ) VALUES (?, ?, 'pending', 'in_flight', ?, NULL, NULL, NULL)`,
        )
        .run(
          envelope.dispatchId,
          envelope.workerId,
          this.now().toISOString(),
        );
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed/iu.test(error.message)
      ) {
        throw new Error(
          `Dispatch ${envelope.dispatchId} has already crossed or entered a dispatch barrier.`,
        );
      }
      throw error;
    }
  }

  private quarantineDispatch(
    envelope: WorkerDispatchEnvelope,
    reason: string,
  ): void {
    if (this.closed) return;
    this.db
      .prepare(
        `UPDATE worker_dispatch_barriers
         SET state = 'quarantined', reason = ?, resolved_at = ?
         WHERE dispatch_id = ? AND state = 'pending'`,
      )
      .run(reason, this.now().toISOString(), envelope.dispatchId);
  }

  private recordLateDispatchResult(
    envelope: WorkerDispatchEnvelope,
    value: unknown,
  ): void {
    if (this.closed) return;
    try {
      const acceptance = normalizeDispatchAcceptance(value, envelope);
      this.db
        .prepare(
          `UPDATE worker_dispatch_barriers
           SET state = 'late_accepted', reason = 'late_acceptance',
               resolved_at = ?, remote_task_id = ?, accepted_at = ?
           WHERE dispatch_id = ?
             AND state IN ('pending', 'quarantined')`,
        )
        .run(
          this.now().toISOString(),
          acceptance.remoteTaskId,
          acceptance.acceptedAt,
          envelope.dispatchId,
        );
    } catch {
      this.db
        .prepare(
          `UPDATE worker_dispatch_barriers
           SET state = 'late_invalid', reason = 'late_invalid_response',
               resolved_at = ?
           WHERE dispatch_id = ?
             AND state IN ('pending', 'quarantined')`,
        )
        .run(this.now().toISOString(), envelope.dispatchId);
    }
  }

  private recordLateDispatchError(envelope: WorkerDispatchEnvelope): void {
    if (this.closed) return;
    this.db
      .prepare(
        `UPDATE worker_dispatch_barriers
         SET state = 'late_rejected', reason = 'late_rejection',
             resolved_at = ?
         WHERE dispatch_id = ?
           AND state IN ('pending', 'quarantined')`,
      )
      .run(this.now().toISOString(), envelope.dispatchId);
  }

  private ensureLocalHeartbeat(workerId: string): void {
    if (this.closed || this.localHeartbeatTimers.has(workerId)) return;
    const timer = setInterval(() => {
      try {
        this.refreshLocal(workerId);
      } catch {
        this.stopLocalHeartbeat(workerId);
      }
    }, this.localHeartbeatIntervalMs);
    timer.unref();
    this.localHeartbeatTimers.set(workerId, timer);
  }

  private stopLocalHeartbeat(workerId: string): void {
    const timer = this.localHeartbeatTimers.get(workerId);
    if (!timer) return;
    clearInterval(timer);
    this.localHeartbeatTimers.delete(workerId);
  }

  private stored(workerId: string): StoredWorker | undefined {
    const row = this.db
      .prepare("SELECT * FROM workers WHERE id = ?")
      .get(workerId) as Row | undefined;
    return row ? storedWorker(row) : undefined;
  }
}
