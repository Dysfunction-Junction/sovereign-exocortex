import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readlink,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  coordinationCapability,
  managedPeerCapability,
} from "../coordination-auth.js";
import {
  buildGrokMcpProfile,
  PERPLEXITY_MCP_LAUNCHER,
  PIECES_READONLY_MCP_LAUNCHER,
  type GrokMcpServerConfig,
  type GrokMcpProfileConfig,
} from "../mcp-profiles.js";
import { startLineProcess } from "../process.js";
import {
  buildSafeEnv,
  ensurePrivateDirectory,
  redactSecrets,
  resolveTrustedProviderExecutable,
  stateDirectory,
} from "../security.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderModel,
  ProviderResult,
  ProviderRunHooks,
  ProviderRunRequest,
} from "../types.js";

const execFileAsync = promisify(execFile);

const READ_ONLY_TOOLS = "read_file,grep,list_dir";
const IMPLEMENT_EDIT_TOOLS = `${READ_ONLY_TOOLS},search_replace`;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface GrokPreparedEnvironment {
  configPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
  lineageId: string;
  lineageWritable: boolean;
  sandboxProfile: string;
  sharedAuth: string;
  sourceAuth: string;
  sourceHome: string;
}

interface GrokSessionLineage {
  lineageId: string;
  writable: boolean;
}

export interface GrokStreamAccumulator {
  output: string;
  sessionId: string;
  usage?: unknown;
  metadata: Record<string, unknown>;
  error: string;
  completed: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function inspectInventory(
  value: unknown,
  expectedConfigPath: string,
): { names: string[]; servers: Record<string, unknown>[] } {
  const report = object(value);
  const configSources = object(report.configSources);
  const layers = Array.isArray(configSources.layers) ? configSources.layers : [];
  const configPaths = layers.map((layer) => object(layer).path);
  if (
    configPaths.length !== 1 ||
    typeof configPaths[0] !== "string" ||
    resolve(configPaths[0]) !== resolve(expectedConfigPath)
  ) {
    throw new Error("Grok discovered an unapproved configuration source.");
  }

  const hooks = Array.isArray(report.hooks) ? report.hooks : [];
  if (hooks.length > 0) {
    throw new Error("Grok discovered project or plugin hooks; delegated execution is refused.");
  }
  const plugins = Array.isArray(report.plugins) ? report.plugins : [];
  if (plugins.length > 0) {
    throw new Error("Grok discovered project or user plugins; delegated execution is refused.");
  }

  const servers = Array.isArray(report.mcpServers) ? report.mcpServers : [];
  const actualNames = servers.map((server) => object(server).name);
  if (actualNames.some((name) => typeof name !== "string")) {
    throw new Error("Grok returned an invalid MCP server inventory.");
  }
  const names = actualNames as string[];
  if (new Set(names).size !== names.length) {
    throw new Error("Grok returned duplicate MCP server names.");
  }
  return { names, servers: servers.map(object) };
}

export function validateGrokInspectReport(
  value: unknown,
  expectedConfigPath: string,
  expectedServerNames: readonly string[],
): void {
  const { names, servers } = inspectInventory(value, expectedConfigPath);
  const actual = [...names].sort();
  const expected = [...new Set(expectedServerNames)].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `Grok discovered an unapproved MCP server (expected=${expected.join(",") || "none"}; actual=${actual.join(",") || "none"}).`,
    );
  }
  for (const server of servers) {
    const sourcePath = object(server.source).path;
    if (
      typeof sourcePath !== "string" ||
      resolve(sourcePath) !== resolve(expectedConfigPath)
    ) {
      throw new Error("Grok MCP server provenance did not match the generated profile.");
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function renderMcpServer(name: string, server: GrokMcpServerConfig): string {
  const lines = [`[mcp_servers.${tomlString(name)}]`];
  if ("command" in server) {
    lines.push(`command = ${tomlString(server.command)}`);
    lines.push(`args = ${tomlArray(server.args)}`);
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
  }
  lines.push("enabled = true");
  lines.push(`startup_timeout_sec = ${server.startup_timeout_sec}`);
  lines.push(`tool_timeout_sec = ${server.tool_timeout_sec}`);
  if ("env" in server && Object.keys(server.env).length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${tomlString(name)}.env]`);
    for (const [key, value] of Object.entries(server.env)) {
      lines.push(`${tomlString(key)} = ${tomlString(value)}`);
    }
  }
  return lines.join("\n");
}

function renderDisabledMcpServer(name: string): string {
  return `[mcp_servers.${tomlString(name)}]
command = "/usr/bin/false"
enabled = false`;
}

function renderConfig(
  profile: GrokMcpProfileConfig,
  disabledServerNames: readonly string[] = [],
): string {
  const servers = [
    ...Object.entries(profile.mcp_servers).map(([name, server]) =>
      renderMcpServer(name, server),
    ),
    ...disabledServerNames.map(renderDisabledMcpServer),
  ].join("\n\n");
  return `${`
[cli]
auto_update = false

[features]
telemetry = false
feedback = false
remote_fetch = false
lsp_tools = false

[session]
load_envrc = false

[tools]
respect_gitignore = true

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false
`.trim()}\n${servers ? `\n\n${servers}\n` : "\n"}`;
}

function renderSandbox(
  request: ProviderRunRequest,
  profile: GrokMcpProfileConfig,
  lineageSessions: string,
): string {
  const home = homedir();
  const sourceHome = join(home, ".grok");
  const hasResearch = Boolean(
    profile.mcp_servers.perplexity ||
      profile.mcp_servers.context7 ||
      profile.mcp_servers.pieces,
  );
  const hasCoordination = Boolean(profile.mcp_servers.coordination);
  const agentMeshRoot = resolve(dirname(PIECES_READONLY_MCP_LAUNCHER), "..");
  const perplexityRoot = resolve(dirname(PERPLEXITY_MCP_LAUNCHER), "..");
  const mcpHomes = Object.values(profile.mcp_servers).flatMap((server) =>
    "env" in server && server.env.HOME ? [server.env.HOME] : [],
  );
  const readOnly = [
    ...(hasResearch || hasCoordination ? [join(home, ".nvm")] : []),
    ...(hasResearch
      ? [perplexityRoot, agentMeshRoot, ...mcpHomes]
      : []),
    ...(hasCoordination ? [agentMeshRoot] : []),
  ];
  const readWrite = [
    lineageSessions,
    // The capability-scoped coordination server needs the shared registries.
    // Read/Edit permission denies keep model tools out of this path.
    ...(hasCoordination ? [stateDirectory()] : []),
  ];
  const denied = [
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/.npmrc",
    "**/.pypirc",
    "**/.netrc",
    `${home}/.ssh/**`,
    `${home}/.aws/**`,
    `${home}/.gnupg/**`,
    `${home}/.kube/**`,
    `${home}/.config/gcloud/**`,
    `${home}/.docker/config.json`,
    `${home}/.codex/auth.json`,
    `${home}/.claude/.credentials.json`,
    `${home}/.cursor/mcp.json`,
    `${sourceHome}/bin/**`,
  ];
  const sharedReads = tomlArray([...new Set(readOnly)]);
  const sharedWrites = tomlArray([...new Set(readWrite)]);
  const deny = tomlArray(denied);
  return `
[profiles.mesh-readonly]
extends = "strict"
restrict_network = true
read_only = ${sharedReads}
read_write = ${sharedWrites}
deny = ${deny}

[profiles.mesh-research-readonly]
extends = "strict"
restrict_network = false
read_only = ${sharedReads}
read_write = ${sharedWrites}
deny = ${deny}

[profiles.mesh-workspace]
extends = "strict"
restrict_network = false
read_only = ${sharedReads}
read_write = ${sharedWrites}
deny = ${deny}

[profiles.mesh-research-workspace]
extends = "strict"
restrict_network = false
read_only = ${sharedReads}
read_write = ${sharedWrites}
deny = ${deny}
`.trimStart();
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
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
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle?.close();
  }
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid Grok session ID: ${sessionId}`);
  }
}

function grokProviderState(): {
  auth: string;
  index: string;
  lineages: string;
  runtimeHome: string;
} {
  const root = join(stateDirectory(), "provider-homes", "grok");
  return {
    auth: join(root, "auth"),
    index: join(root, "session-index"),
    lineages: join(root, "lineages"),
    runtimeHome: join(root, "runtime"),
  };
}

function lineageIndexPath(index: string, sessionId: string): string {
  assertSessionId(sessionId);
  return join(index, `${sessionId}.lineage`);
}

async function readPrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error(`Grok session index entry is not a private regular file: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseGrokAuthDocument(contents: string): Record<string, unknown> {
  if (Buffer.byteLength(contents) > 1024 * 1024) {
    throw new Error("Grok authentication state exceeds the size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Grok authentication state is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Grok authentication state has an invalid shape.");
  }
  return parsed as Record<string, unknown>;
}

function grokAuthIdentity(contents: string): string {
  const document = parseGrokAuthDocument(contents);
  const identities = Object.entries(document).map(([issuer, value]) => {
    const account = object(value);
    return {
      issuer,
      authMode: account.auth_mode,
      userId: account.user_id,
      principalId: account.principal_id,
      email: account.email,
      oidcIssuer: account.oidc_issuer,
      oidcClientId: account.oidc_client_id,
    };
  });
  if (identities.length === 0) {
    throw new Error("Grok authentication state has no account entries.");
  }
  return JSON.stringify(identities);
}

async function copyValidatedGrokAuth(source: string, target: string): Promise<void> {
  const contents = await readPrivateFile(source);
  parseGrokAuthDocument(contents);
  await writePrivateFile(target, contents.endsWith("\n") ? contents : `${contents}\n`);
}

async function prepareTaskAuth(
  sourceAuth: string,
  sharedAuth: string,
  taskAuth: string,
): Promise<void> {
  const sourceInfo = await lstat(sourceAuth);
  let refreshShared = false;
  try {
    const sharedInfo = await lstat(sharedAuth);
    refreshShared = sourceInfo.mtimeMs > sharedInfo.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    refreshShared = true;
  }
  if (refreshShared) await copyValidatedGrokAuth(sourceAuth, sharedAuth);
  await copyValidatedGrokAuth(sharedAuth, taskAuth);
}

async function syncTaskAuth(taskAuth: string, sharedAuth: string): Promise<void> {
  const [candidate, current] = await Promise.all([
    readPrivateFile(taskAuth),
    readPrivateFile(sharedAuth),
  ]);
  if (grokAuthIdentity(candidate) !== grokAuthIdentity(current)) {
    throw new Error("Refusing to persist Grok authentication state for another identity.");
  }
  await writePrivateFile(
    sharedAuth,
    candidate.endsWith("\n") ? candidate : `${candidate}\n`,
  );
}

async function preparePerplexityHome(grokHome: string): Promise<string> {
  const mcpHome = join(dirname(grokHome), "grok-mcp-home");
  const secrets = join(mcpHome, ".secrets");
  await ensurePrivateDirectory(mcpHome);
  await ensurePrivateDirectory(secrets);
  const key = (await readPrivateFile(join(homedir(), ".secrets", "perplexity_api_key"))).trim();
  if (!key || Buffer.byteLength(key) > 16 * 1024) {
    throw new Error("Perplexity authentication state is invalid.");
  }
  await writePrivateFile(join(secrets, "perplexity_api_key"), `${key}\n`);
  return mcpHome;
}

function parseSessionLineage(value: string, sessionId: string): GrokSessionLineage {
  // Pre-hardening development builds stored only the lineage UUID. Treat those
  // mappings as read-only so they can never be used for a mode escalation.
  if (SESSION_ID_PATTERN.test(value)) {
    return { lineageId: value, writable: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Grok session ${sessionId} has a corrupt lineage mapping.`);
  }
  const record = object(parsed);
  const lineageId =
    typeof record.lineageId === "string" ? record.lineageId : "";
  assertSessionId(lineageId);
  if (typeof record.writable !== "boolean") {
    throw new Error(`Grok session ${sessionId} has a corrupt lineage mapping.`);
  }
  return {
    lineageId,
    writable: record.writable,
  };
}

async function resolveSessionLineage(sessionId: string): Promise<GrokSessionLineage> {
  const paths = grokProviderState();
  await ensurePrivateDirectory(paths.index);
  let value: string;
  try {
    value = (await readPrivateFile(lineageIndexPath(paths.index, sessionId))).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Grok session ${sessionId} has no mesh lineage mapping and cannot be resumed.`,
      );
    }
    throw error;
  }
  return parseSessionLineage(value, sessionId);
}

async function registerSessionLineage(
  sessionId: string,
  lineage: GrokSessionLineage,
): Promise<void> {
  assertSessionId(sessionId);
  assertSessionId(lineage.lineageId);
  const paths = grokProviderState();
  await ensurePrivateDirectory(paths.index);
  const path = lineageIndexPath(paths.index, sessionId);
  try {
    const existing = parseSessionLineage((await readPrivateFile(path)).trim(), sessionId);
    if (
      existing.lineageId !== lineage.lineageId ||
      existing.writable !== lineage.writable
    ) {
      throw new Error(`Grok session ${sessionId} is already mapped to another lineage.`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writePrivateFile(path, `${JSON.stringify(lineage)}\n`);
}

async function ensureExpectedSymlink(path: string, target: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || (await readlink(path)) !== target) {
      throw new Error(`Grok isolation path is not the expected symlink: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await symlink(target, path);
  }
}

async function prepareGrokEnvironment(
  request: ProviderRunRequest,
  profile: GrokMcpProfileConfig,
): Promise<GrokPreparedEnvironment> {
  const grokHome = join(request.taskDir, "grok-home");
  const providerState = grokProviderState();
  const lineage = request.sessionId
    ? await resolveSessionLineage(request.sessionId)
    : {
        lineageId: request.taskId,
        writable: request.mode === "implement",
      };
  if (request.mode === "implement" && !lineage.writable) {
    throw new Error(
      "Refusing to resume a read-only Grok session as an implementation task.",
    );
  }
  const { lineageId } = lineage;
  assertSessionId(lineageId);
  const lineageRoot = join(providerState.lineages, lineageId);
  const lineageSessions = join(lineageRoot, "sessions");
  const sourceHome = join(homedir(), ".grok");
  const sourceAuth = join(sourceHome, "auth.json");
  const sharedAuth = join(providerState.auth, "auth.json");

  await access(sourceAuth, constants.R_OK).catch(() => {
    throw new Error("Grok is not authenticated; run `grok login --device-auth` first.");
  });
  await ensurePrivateDirectory(grokHome);
  await ensurePrivateDirectory(providerState.auth);
  await ensurePrivateDirectory(providerState.lineages);
  await ensurePrivateDirectory(lineageRoot);
  await ensurePrivateDirectory(lineageSessions);
  await ensurePrivateDirectory(providerState.runtimeHome);
  await prepareTaskAuth(sourceAuth, sharedAuth, join(grokHome, "auth.json"));
  await ensureExpectedSymlink(join(grokHome, "sessions"), lineageSessions);
  const perplexity = profile.mcp_servers.perplexity;
  if (perplexity && "env" in perplexity) {
    perplexity.env.HOME = await preparePerplexityHome(grokHome);
  }
  const configPath = join(grokHome, "config.toml");
  await writePrivateFile(configPath, renderConfig(profile));
  await writePrivateFile(
    join(grokHome, "sandbox.toml"),
    renderSandbox(request, profile, lineageSessions),
  );

  const sandboxProfile =
    request.mode === "implement"
      ? request.mcpProfile === "research"
        ? "mesh-research-workspace"
        : "mesh-workspace"
      : request.mcpProfile === "research"
        ? "mesh-research-readonly"
        : "mesh-readonly";
  const coordination = request.coordination;
  const peer = request.peer;
  return {
    configPath,
    home: grokHome,
    lineageId,
    lineageWritable: lineage.writable,
    sandboxProfile,
    sharedAuth,
    sourceAuth,
    sourceHome,
    env: buildSafeEnv({
      HOME: providerState.runtimeHome,
      GROK_HOME: grokHome,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_MEMORY: "0",
      GROK_CURSOR_SKILLS_ENABLED: "false",
      GROK_CURSOR_RULES_ENABLED: "false",
      GROK_CURSOR_AGENTS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_CURSOR_HOOKS_ENABLED: "false",
      GROK_CURSOR_SESSIONS_ENABLED: "false",
      GROK_CLAUDE_SKILLS_ENABLED: "false",
      GROK_CLAUDE_RULES_ENABLED: "false",
      GROK_CLAUDE_AGENTS_ENABLED: "false",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CLAUDE_HOOKS_ENABLED: "false",
      GROK_CLAUDE_SESSIONS_ENABLED: "false",
      MCP_TIMEOUT: "60000",
      AGENT_MESH_SCOPED_ORIGIN:
        coordination?.origin ?? peer?.origin,
      ...(coordination
        ? {
            AGENT_MESH_COORDINATION_ORIGIN: coordination.origin,
            AGENT_MESH_COORDINATION_SWARM_ID: coordination.swarmId,
            AGENT_MESH_COORDINATION_MEMBER_ID: coordination.memberId,
            AGENT_MESH_COORDINATION_CAPABILITY: coordinationCapability(coordination),
          }
        : {}),
      ...(peer
        ? {
            AGENT_MESH_PEER_AGENT_ID: peer.agentId,
            AGENT_MESH_PEER_MEMBER_ID: peer.memberId,
            AGENT_MESH_PEER_GENERATION: String(
              peer.membershipGeneration,
            ),
            AGENT_MESH_PEER_TASK_ID: peer.taskId,
            AGENT_MESH_PEER_RUN_ID: peer.runId,
            AGENT_MESH_PEER_CAUSAL_ROOT: peer.causalRoot,
            AGENT_MESH_PEER_CAUSAL_PATH:
              peer.causalPath?.join(","),
            AGENT_MESH_PEER_CAPABILITY: managedPeerCapability(peer),
          }
        : {}),
    }),
  };
}

function grokEffort(effort: string | undefined): string | undefined {
  return effort === "ultra" || effort === "xhigh" || effort === "max"
    ? "high"
    : effort;
}

export function grokToolsForMode(
  mode: ProviderRunRequest["mode"],
): string {
  return mode === "implement" ? IMPLEMENT_EDIT_TOOLS : READ_ONLY_TOOLS;
}

function permissionRules(
  request: ProviderRunRequest,
  profile: GrokMcpProfileConfig,
  prepared: GrokPreparedEnvironment,
): { allow: string[]; deny: string[] } {
  const allow = [
    "Read",
    "Grep",
    "Glob",
    ...(request.mode === "implement" ? ["Edit", "Write"] : []),
    ...profile.allowedTools,
  ];
  const protectedPaths = [
    join(prepared.sourceHome, "**"),
    join(prepared.home, "auth.json"),
    join(homedir(), ".secrets", "perplexity_api_key"),
    join(stateDirectory(), "**"),
    ...Object.values(profile.mcp_servers).flatMap((server) =>
      "env" in server && server.env.HOME ? [join(server.env.HOME, "**")] : [],
    ),
  ];
  const deny = [
    ...(profile.allowedTools.length === 0 ? ["MCPTool"] : []),
    "WebFetch",
    "WebSearch",
    ...["**/.env", "**/.env.*", "**/*.pem", "**/*.key"].flatMap((path) => [
      `Read(${path})`,
      `Grep(${path})`,
      `Glob(${path})`,
    ]),
    ...protectedPaths.flatMap((path) => [
      `Read(${path})`,
      `Grep(${path})`,
      `Glob(${path})`,
      `Edit(${path})`,
      `Write(${path})`,
    ]),
  ];
  return { allow, deny };
}

export function accumulateGrokStreamEvent(
  state: GrokStreamAccumulator,
  value: unknown,
): void {
  const event = object(value);
  if (event.type === "text" && typeof event.data === "string") {
    state.output += event.data;
    return;
  }
  if (event.type !== "end" && event.type !== "error") return;

  if (typeof event.sessionId === "string") state.sessionId = event.sessionId;
  if (event.usage !== undefined) state.usage = event.usage;
  if (event.type === "end") state.completed = true;
  for (const [source, target] of [
    ["requestId", "requestId"],
    ["stopReason", "stopReason"],
    ["num_turns", "numTurns"],
    ["modelUsage", "modelUsage"],
    ["total_cost_usd", "totalCostUsd"],
    ["total_cost_usd_ticks", "totalCostUsdTicks"],
    ["cost_is_partial", "costIsPartial"],
    ["usage_is_incomplete", "usageIsIncomplete"],
  ] as const) {
    if (event[source] !== undefined) state.metadata[target] = event[source];
  }
  if (event.type === "end" && event.stopReason === "Cancelled") {
    state.error = "Grok ended the turn without completing a denied or cancelled tool call.";
  }
  if (event.type === "error") {
    state.error =
      typeof event.message === "string" ? event.message : "Grok returned an error event.";
  }
}

export function parseGrokModels(output: string): ProviderModel[] {
  const models = new Map<string, ProviderModel>();
  for (const line of stripAnsi(output).split("\n")) {
    const match = line.match(/^\s*\*\s+(\S+?)(?:\s+\(([^)]*)\))?\s*$/);
    if (!match?.[1]) continue;
    const id = match[1];
    if (id.startsWith("-") || id.length > 256 || /[\u0000-\u001F\u007F]/.test(id)) {
      continue;
    }
    if (models.has(id)) continue;
    models.set(id, {
      id,
      displayName: id,
      isDefault: /\bdefault\b/i.test(match[2] ?? ""),
      reasoningEfforts: ["low", "medium", "high"],
      metadata: { source: "grok-cli" },
    });
  }
  return [...models.values()];
}

async function readGrokInspectReport(
  binary: string,
  request: ProviderRunRequest,
  prepared: GrokPreparedEnvironment,
): Promise<unknown> {
  let stdout: string;
  try {
    const result = await execFileAsync(binary, ["inspect", "--json"], {
      cwd: request.cwd,
      env: prepared.env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: Math.min(request.timeoutMs, 30_000),
    });
    stdout = result.stdout;
  } catch (error) {
    throw new Error(
      `Grok configuration preflight failed: ${redactSecrets(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 2_000)}`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("Grok configuration preflight returned invalid JSON.");
  }
  return report;
}

async function verifyGrokDiscovery(
  binary: string,
  request: ProviderRunRequest,
  prepared: GrokPreparedEnvironment,
  profile: GrokMcpProfileConfig,
): Promise<void> {
  const expectedNames = Object.keys(profile.mcp_servers);
  const expectedSet = new Set(expectedNames);
  let report = await readGrokInspectReport(binary, request, prepared);
  const initial = inspectInventory(report, prepared.configPath);
  for (const server of initial.servers) {
    if (!expectedSet.has(String(server.name))) continue;
    const sourcePath = object(server.source).path;
    if (
      typeof sourcePath !== "string" ||
      resolve(sourcePath) !== resolve(prepared.configPath)
    ) {
      throw new Error("Grok MCP server provenance did not match the generated profile.");
    }
  }

  const extras = initial.names.filter((name) => !expectedSet.has(name));
  if (
    extras.length > 64 ||
    extras.some(
      (name) =>
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name) ||
        expectedSet.has(name),
    )
  ) {
    throw new Error("Grok discovered an MCP server that cannot be safely disabled.");
  }
  if (extras.length > 0) {
    await writePrivateFile(
      prepared.configPath,
      renderConfig(profile, extras),
    );
    report = await readGrokInspectReport(binary, request, prepared);
  }
  validateGrokInspectReport(
    report,
    prepared.configPath,
    expectedNames,
  );
}

export class GrokAdapter implements ProviderAdapter {
  readonly provider = "grok" as const;

  capabilities(): ProviderCapabilities {
    return {
      provider: this.provider,
      dynamicModelDiscovery: true,
      resume: true,
      fork: true,
      nativeSessionSearch: false,
      nativeCancellation: false,
      notes: [
        "Models are discovered with `grok models`.",
        "Headless tasks use newline-delimited streaming JSON and process-group cancellation.",
        "Each task gets an isolated GROK_HOME, strict MCP profile, and OS-level sandbox.",
        "Grok's native session search is human-readable, so mesh session search remains authoritative.",
      ],
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const binary = await resolveTrustedProviderExecutable("grok");
    const { stdout, stderr } = await execFileAsync(binary, ["models"], {
      env: buildSafeEnv({
        GROK_DISABLE_AUTOUPDATER: "1",
        NO_COLOR: "1",
      }),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseGrokModels(`${stdout}\n${stderr}`);
  }

  async run(request: ProviderRunRequest, hooks: ProviderRunHooks): Promise<ProviderResult> {
    const binary = await resolveTrustedProviderExecutable("grok");
    const mcpProfile = buildGrokMcpProfile(request.mcpProfile, {
      coordination: request.coordination,
      peer: request.peer,
    });
    const prepared = await prepareGrokEnvironment(request, mcpProfile);
    await verifyGrokDiscovery(binary, request, prepared, mcpProfile);
    const rules = permissionRules(request, mcpProfile, prepared);
    const args = [
      "--prompt-file",
      "/dev/stdin",
      "--output-format",
      "streaming-json",
      "--disable-web-search",
      "--no-memory",
      "--no-subagents",
      "--permission-mode",
      request.mode === "implement" ? "acceptEdits" : "dontAsk",
      "--tools",
      grokToolsForMode(request.mode),
      "--disallowed-tools",
      "web_search,web_fetch,Agent",
    ];
    // Grok persists the sandbox profile in the session and refuses a different
    // profile on resume. Omit the flag for continuations so the pinned profile
    // is restored even if a caller requests a different logical task mode.
    if (!request.sessionId) args.push("--sandbox", prepared.sandboxProfile);
    if (request.model) args.push("--model", request.model);
    const effort = grokEffort(request.effort);
    if (effort) args.push("--effort", effort);
    for (const rule of rules.allow) args.push("--allow", rule);
    for (const rule of rules.deny) args.push("--deny", rule);
    if (request.sessionId) {
      args.push("--resume", request.sessionId);
      if (request.forkSession) {
        args.push("--fork-session", "--session-id", request.taskId);
      }
    } else {
      args.push("--session-id", request.taskId);
    }

    const state: GrokStreamAccumulator = {
      output: "",
      sessionId: request.forkSession
        ? request.taskId
        : request.sessionId ?? request.taskId,
      metadata: {},
      error: "",
      completed: false,
    };
    hooks.onSession(state.sessionId);
    const running = startLineProcess({
      command: binary,
      args,
      cwd: request.cwd,
      env: prepared.env,
      stdin: request.prompt,
      timeoutMs: request.timeoutMs,
      eventsPath: join(request.taskDir, "events.ndjson"),
      onStdoutLine(line) {
        let event: unknown;
        try {
          event = JSON.parse(line) as unknown;
        } catch {
          return;
        }
        hooks.onEvent?.(event);
        const previousSession = state.sessionId;
        accumulateGrokStreamEvent(state, event);
        if (state.sessionId !== previousSession) hooks.onSession(state.sessionId);
      },
    });
    hooks.onStarted({ pid: running.pid, cancel: running.cancel });
    const outcome = await running.completion;
    if (outcome.code !== 0 || state.error || !state.completed || !state.sessionId) {
      throw new Error(
        `Grok Build failed (code=${String(outcome.code)}, signal=${String(outcome.signal)}): ${
          state.error || outcome.stderr || "no result"
        }`,
      );
    }
    await syncTaskAuth(join(prepared.home, "auth.json"), prepared.sharedAuth);
    await registerSessionLineage(state.sessionId, {
      lineageId: prepared.lineageId,
      writable: prepared.lineageWritable,
    });
    return {
      output: state.output,
      sessionId: state.sessionId,
      usage: state.usage,
      metadata: state.metadata,
    };
  }
}
