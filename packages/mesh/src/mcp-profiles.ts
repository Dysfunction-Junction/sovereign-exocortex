import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  CoordinationContext,
  ManagedPeerContext,
} from "./types.js";
import { stateDirectory } from "./security.js";
import {
  coordinationCapability,
  managedPeerCapability,
} from "./coordination-auth.js";

export const MCP_PROFILES = ["none", "research"] as const;
export type McpProfile = (typeof MCP_PROFILES)[number];

export const MCP_PROFILE_TASK_MODES = [
  "ask",
  "plan",
  "review",
  "research",
  "implement",
] as const;
export type McpProfileTaskMode = (typeof MCP_PROFILE_TASK_MODES)[number];
export type McpProfileProvider = "antigravity" | "claude" | "codex" | "grok";

import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PERPLEXITY_MCP_LAUNCHER =
  process.env.AGENT_MESH_PERPLEXITY_MCP_LAUNCHER ??
  join(homedir(), "Development", "MCP", "perplexity-mcp", "bin", "serve.sh");
export const PIECES_READONLY_MCP_LAUNCHER =
  join(REPO_ROOT, "bin", "pieces-readonly.sh");
export const PIECES_READONLY_TOOL_MANIFEST =
  join(REPO_ROOT, "pieces-readonly-tools.manifest.json");
export const CONTEXT7_MCP_URL = "https://mcp.context7.com/mcp";
export const DEFAULT_PIECES_MCP_URL =
  process.env.PIECES_MCP_URL ??
  "http://localhost:39301/model_context_protocol/2025-03-26/mcp";
export const RESEARCH_MCP_STARTUP_TIMEOUT_SEC = 30;
export const RESEARCH_MCP_TOOL_TIMEOUT_SEC = 300;
export const COORDINATION_MCP_LAUNCHER =
  join(REPO_ROOT, "bin", "coordinate.sh");
export const COORDINATION_TOOLS = [
  "coordination_status",
  "coordination_inbox",
  "coordination_wait",
  "coordination_send",
  "coordination_blackboard",
  "coordination_blackboard_set",
  "coordination_barrier_status",
  "coordination_barrier_arrive",
  "coordination_review_submit",
  "coordination_step_report_submit",
  "coordination_prior_reports",
  "coordination_open_findings",
] as const;
export const MANAGED_PEER_TOOLS = [
  "peer_channels_list",
  "peer_context_get",
  "peer_direction_ack",
  "peer_status_update",
  "peer_send",
  "peer_inbox",
  "peer_wait",
  "peer_ack",
  "peer_reply_and_ack",
  "peer_lease_acquire",
  "peer_lease_release",
] as const;

export const PERPLEXITY_RESEARCH_TOOLS = ["search", "chat"] as const;
export const CONTEXT7_RESEARCH_TOOLS = ["resolve-library-id", "query-docs"] as const;

/**
 * Explicit allowlist for the local Pieces LTM server. Keep this list read-only:
 * a newly added server tool is unavailable until it is deliberately reviewed.
 */
export const PIECES_READ_ONLY_TOOLS = [
  "workstream_summaries_full_text_search",
  "connectors_full_text_search",
  "conversations_full_text_search",
  "tags_full_text_search",
  "annotations_full_text_search",
  "persons_full_text_search",
  "anchors_full_text_search",
  "workstream_events_full_text_search",
  "websites_full_text_search",
  "hints_full_text_search",
  "wpe_sources_full_text_search",
  "wpe_source_windows_full_text_search",
  "conversation_messages_full_text_search",
  "materials_vector_search",
  "workstream_summaries_vector_search",
  "hints_vector_search",
  "tags_vector_search",
  "workstream_events_vector_search",
  "signals_vector_search",
  "material_identifiers",
  "list_gcal_connectors",
  "get_gcal_events",
  "get_gcal_event",
  "get_user_persona",
  "time_compute",
  "anchor_points_batch_snapshot",
  "anchors_batch_snapshot",
  "annotations_batch_snapshot",
  "conversation_messages_batch_snapshot",
  "connectors_batch_snapshot",
  "conversations_batch_snapshot",
  "hints_batch_snapshot",
  "persons_batch_snapshot",
  "ranges_batch_snapshot",
  "tags_batch_snapshot",
  "websites_batch_snapshot",
  "workstream_events_batch_snapshot",
  "workstream_summaries_batch_snapshot",
  "wpe_source_windows_batch_snapshot",
  "wpe_sources_batch_snapshot",
  "browser_lookup",
  "browser_activity",
  "search_memory",
  "ask_memory",
  "anchor_point_snapshot",
  "anchor_snapshot",
  "annotation_snapshot",
  "connector_snapshot",
  "conversation_message_snapshot",
  "conversation_snapshot",
  "hint_snapshot",
  "person_snapshot",
  "range_snapshot",
  "tag_snapshot",
  "website_snapshot",
  "workstream_event_snapshot",
  "workstream_summary_snapshot",
  "wpe_source_snapshot",
  "wpe_source_window_snapshot",
  "extract_temporal_range",
  "ask_pieces_ltm",
] as const;

export const PIECES_MUTATION_TOOLS = [
  "create_gcal_event",
  "patch_gcal_event",
  "delete_gcal_event",
  "create_pieces_memory",
] as const;

export const PIECES_FILESYSTEM_TOOLS = [
  "filesystem_search_paths",
  "filesystem_search_text",
  "filesystem_read_chunk",
] as const;

export interface McpProfileEnvironment {
  readonly [key: string]: string | undefined;
}

export interface McpProfileBuildOptions {
  /**
   * Defaults to process.env. Credential variables are never copied into a
   * generated provider configuration.
   */
  env?: McpProfileEnvironment;
  /**
   * Explicit dependency-injection override. Normal discovery checks
   * AGENT_MESH_PIECES_URL, then the `pieces` server in Cursor's MCP config.
   */
  piecesUrl?: string;
  cursorMcpConfigPath?: string;
  piecesManifestPath?: string;
  coordination?: CoordinationContext;
  peer?: ManagedPeerContext;
}

export interface ClaudeStdioMcpServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
}

export interface ClaudeHttpMcpServerConfig {
  type: "http";
  url: string;
  timeout: number;
}

export type ClaudeMcpServerConfig = ClaudeStdioMcpServerConfig | ClaudeHttpMcpServerConfig;

export interface ClaudeMcpConfig {
  mcpServers: Record<string, ClaudeMcpServerConfig>;
}

export interface ClaudeMcpProfileConfig {
  mcpConfig: ClaudeMcpConfig;
  mcpConfigJson: string;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface CodexStdioMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  required: true;
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  enabled_tools: string[];
  default_tools_approval_mode: "approve";
}

export interface CodexHttpMcpServerConfig {
  url: string;
  required: true;
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  enabled_tools: string[];
  default_tools_approval_mode: "approve";
}

export type CodexMcpServerConfig = CodexStdioMcpServerConfig | CodexHttpMcpServerConfig;

export interface CodexThreadMcpConfig {
  mcp_servers: Record<string, CodexMcpServerConfig>;
}

export interface GrokStdioMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: true;
  startup_timeout_sec: number;
  tool_timeout_sec: number;
}

export interface GrokHttpMcpServerConfig {
  url: string;
  enabled: true;
  startup_timeout_sec: number;
  tool_timeout_sec: number;
}

export type GrokMcpServerConfig = GrokStdioMcpServerConfig | GrokHttpMcpServerConfig;

export interface GrokMcpProfileConfig {
  mcp_servers: Record<string, GrokMcpServerConfig>;
  allowedTools: string[];
}

export interface AntigravityStdioMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AntigravitySseMcpServerConfig {
  serverUrl: string;
}

export type AntigravityMcpServerConfig =
  | AntigravityStdioMcpServerConfig
  | AntigravitySseMcpServerConfig;

export interface AntigravityMcpProfileConfig {
  mcpServers: Record<string, AntigravityMcpServerConfig>;
}

const RESEARCH_TASK_MODES = new Set<McpProfileTaskMode>([
  "ask",
  "plan",
  "research",
  "review",
  // Implementers need docs/search while building/testing (Context7 + Perplexity).
  "implement",
]);

function qualifiedTools(server: string, tools: readonly string[]): string[] {
  return tools.map((tool) => `mcp__${server}__${tool}`);
}

function grokQualifiedTools(server: string, tools: readonly string[]): string[] {
  return tools.map((tool) => `MCPTool(${server}__${tool})`);
}

export const CLAUDE_RESEARCH_ALLOWED_TOOLS = [
  ...qualifiedTools("perplexity", PERPLEXITY_RESEARCH_TOOLS),
  ...qualifiedTools("context7", CONTEXT7_RESEARCH_TOOLS),
  ...qualifiedTools("pieces", PIECES_READ_ONLY_TOOLS),
] as const;

export const CLAUDE_RESEARCH_DISALLOWED_TOOLS = qualifiedTools(
  "pieces",
  [...PIECES_MUTATION_TOOLS, ...PIECES_FILESYSTEM_TOOLS],
);

function peerArgs(context: ManagedPeerContext): string[] {
  return [
    "--peer-agent-id",
    context.agentId,
    "--peer-member-id",
    context.memberId,
    "--peer-generation",
    String(context.membershipGeneration),
    ...(context.taskId ? ["--peer-task-id", context.taskId] : []),
    ...(context.runId ? ["--peer-run-id", context.runId] : []),
    ...(context.causalRoot
      ? ["--peer-causal-root", context.causalRoot]
      : []),
    ...(context.causalPath?.length
      ? ["--peer-causal-path", context.causalPath.join(",")]
      : []),
    "--peer-capability",
    managedPeerCapability(context),
  ];
}

function scopedArgs(options: {
  coordination?: CoordinationContext;
  peer?: ManagedPeerContext;
}): string[] {
  const origin = options.coordination?.origin ?? options.peer?.origin;
  if (!origin) throw new Error("Scoped MCP requires an origin.");
  return [
    "--origin",
    origin,
    ...(options.coordination
      ? [
          "--swarm-id",
          options.coordination.swarmId,
          "--member-id",
          options.coordination.memberId,
          "--capability",
          coordinationCapability(options.coordination),
        ]
      : []),
    ...(options.peer ? peerArgs(options.peer) : []),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readPiecesUrlFromCursorConfig(configPath: string): string | undefined {
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read the Cursor MCP configuration.", { cause: error });
  }

  let config: unknown;
  try {
    config = JSON.parse(source);
  } catch (error) {
    throw new Error("Cursor MCP configuration is not valid JSON.", { cause: error });
  }
  if (!isRecord(config)) throw new Error("Cursor MCP configuration must be a JSON object.");

  const servers = config.mcpServers;
  if (servers === undefined) return undefined;
  if (!isRecord(servers)) {
    throw new Error("Cursor MCP configuration mcpServers must be a JSON object.");
  }

  const pieces = servers.pieces;
  if (pieces === undefined) return undefined;
  if (!isRecord(pieces)) {
    throw new Error('Cursor MCP configuration server "pieces" must be a JSON object.');
  }
  if (pieces.url === undefined) return undefined;
  if (typeof pieces.url !== "string" || !pieces.url.trim()) {
    throw new Error('Cursor MCP configuration server "pieces" must have a non-empty URL.');
  }
  return pieces.url.trim();
}

function validatedPiecesUrl(candidate: string): string {
  const trimmed = candidate.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Pieces MCP URL must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Pieces MCP URL must use HTTP or HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "Pieces MCP URL must not contain credentials, query parameters, or a fragment.",
    );
  }
  return trimmed;
}

export function resolvePiecesMcpUrl(options: McpProfileBuildOptions = {}): string {
  const env = options.env ?? process.env;
  const cursorMcpConfigPath =
    options.cursorMcpConfigPath ??
    join(env.HOME?.trim() || homedir(), ".cursor", "mcp.json");
  const candidate =
    options.piecesUrl?.trim() ||
    env.AGENT_MESH_PIECES_URL?.trim() ||
    readPiecesUrlFromCursorConfig(cursorMcpConfigPath) ||
    DEFAULT_PIECES_MCP_URL;
  return validatedPiecesUrl(candidate);
}

export function buildPiecesReadonlyProxyArgs(
  options: McpProfileBuildOptions = {},
): string[] {
  return [
    "--upstream-url",
    resolvePiecesMcpUrl(options),
    "--allow-tools",
    PIECES_READ_ONLY_TOOLS.join(","),
    "--manifest",
    resolve(options.piecesManifestPath ?? PIECES_READONLY_TOOL_MANIFEST),
    "--startup-timeout-ms",
    String(RESEARCH_MCP_STARTUP_TIMEOUT_SEC * 1_000),
    "--call-timeout-ms",
    String(RESEARCH_MCP_TOOL_TIMEOUT_SEC * 1_000),
  ];
}

export function isMcpProfileAllowed(
  mode: McpProfileTaskMode,
  profile: McpProfile,
): boolean {
  if (profile === "none") return true;
  return RESEARCH_TASK_MODES.has(mode);
}

export function assertMcpProfileAllowed(
  mode: McpProfileTaskMode,
  profile: McpProfile,
): void {
  if (isMcpProfileAllowed(mode, profile)) return;
  throw new Error(
    `The "research" MCP profile is not supported for ${mode} tasks; use ask, plan, research, review, or implement.`,
  );
}

export function buildClaudeMcpProfile(
  profile: McpProfile,
  options: McpProfileBuildOptions = {},
): ClaudeMcpProfileConfig {
  const mcpConfig: ClaudeMcpConfig = {
    mcpServers: profile === "research" ? {
      perplexity: {
        type: "stdio",
        command: PERPLEXITY_MCP_LAUNCHER,
        args: [],
        env: {},
        timeout: RESEARCH_MCP_TOOL_TIMEOUT_SEC * 1_000,
      },
      context7: {
        type: "http",
        url: CONTEXT7_MCP_URL,
        timeout: RESEARCH_MCP_TOOL_TIMEOUT_SEC * 1_000,
      },
      pieces: {
        type: "stdio",
        command: PIECES_READONLY_MCP_LAUNCHER,
        args: buildPiecesReadonlyProxyArgs(options),
        env: {},
        timeout: RESEARCH_MCP_TOOL_TIMEOUT_SEC * 1_000,
      },
    } : {},
  };
  if (options.coordination || options.peer) {
    mcpConfig.mcpServers.coordination = {
      type: "stdio",
      command: COORDINATION_MCP_LAUNCHER,
      args: scopedArgs(options),
      env: { AGENT_MESH_STATE_DIR: stateDirectory() },
      timeout: 600_000,
    };
  }
  return {
    mcpConfig,
    mcpConfigJson: JSON.stringify(mcpConfig),
    allowedTools: [
      ...(profile === "research" ? CLAUDE_RESEARCH_ALLOWED_TOOLS : []),
      ...(options.coordination ? qualifiedTools("coordination", COORDINATION_TOOLS) : []),
      ...(options.peer ? qualifiedTools("coordination", MANAGED_PEER_TOOLS) : []),
    ],
    disallowedTools:
      profile === "research" ? [...CLAUDE_RESEARCH_DISALLOWED_TOOLS] : [],
  };
}

export function buildCodexMcpProfile(
  profile: McpProfile,
  options: McpProfileBuildOptions = {},
): CodexThreadMcpConfig {
  const mcp_servers: Record<string, CodexMcpServerConfig> =
    profile === "research" ? {
      perplexity: {
        command: PERPLEXITY_MCP_LAUNCHER,
        args: [],
        env: { HOME: process.env.HOME ?? homedir() },
        required: true,
        startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
        tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
        enabled_tools: [...PERPLEXITY_RESEARCH_TOOLS],
        default_tools_approval_mode: "approve",
      },
      context7: {
        url: CONTEXT7_MCP_URL,
        required: true,
        startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
        tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
        enabled_tools: [...CONTEXT7_RESEARCH_TOOLS],
        default_tools_approval_mode: "approve",
      },
      pieces: {
        command: PIECES_READONLY_MCP_LAUNCHER,
        args: buildPiecesReadonlyProxyArgs(options),
        env: {},
        required: true,
        startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
        tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
        enabled_tools: [...PIECES_READ_ONLY_TOOLS],
        default_tools_approval_mode: "approve",
      },
    } : {};
  if (options.coordination || options.peer) {
    mcp_servers.coordination = {
      command: COORDINATION_MCP_LAUNCHER,
      args: scopedArgs(options),
      env: { AGENT_MESH_STATE_DIR: stateDirectory() },
      required: true,
      startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
      tool_timeout_sec: 600,
      enabled_tools: [
        ...(options.coordination ? COORDINATION_TOOLS : []),
        ...(options.peer ? MANAGED_PEER_TOOLS : []),
      ],
      default_tools_approval_mode: "approve",
    };
  }
  return {
    mcp_servers,
  };
}

export function buildGrokMcpProfile(
  profile: McpProfile,
  options: McpProfileBuildOptions = {},
): GrokMcpProfileConfig {
  const mcp_servers: Record<string, GrokMcpServerConfig> =
    profile === "research"
      ? {
          perplexity: {
            command: PERPLEXITY_MCP_LAUNCHER,
            args: [],
            env: { HOME: process.env.HOME ?? homedir() },
            enabled: true,
            startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
            tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
          },
          context7: {
            url: CONTEXT7_MCP_URL,
            enabled: true,
            startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
            tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
          },
          pieces: {
            command: PIECES_READONLY_MCP_LAUNCHER,
            args: buildPiecesReadonlyProxyArgs(options),
            env: {},
            enabled: true,
            startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
            tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
          },
        }
      : {};
  if (options.coordination || options.peer) {
    mcp_servers.coordination = {
      command: COORDINATION_MCP_LAUNCHER,
      args: [
        "--origin",
        options.coordination
          ? "${AGENT_MESH_COORDINATION_ORIGIN}"
          : "${AGENT_MESH_SCOPED_ORIGIN}",
        ...(options.coordination
          ? [
              "--swarm-id",
              "${AGENT_MESH_COORDINATION_SWARM_ID}",
              "--member-id",
              "${AGENT_MESH_COORDINATION_MEMBER_ID}",
              "--capability",
              "${AGENT_MESH_COORDINATION_CAPABILITY}",
            ]
          : []),
        ...(options.peer
          ? [
              "--peer-agent-id",
              "${AGENT_MESH_PEER_AGENT_ID}",
              "--peer-member-id",
              "${AGENT_MESH_PEER_MEMBER_ID}",
              "--peer-generation",
              "${AGENT_MESH_PEER_GENERATION}",
              ...(options.peer.taskId
                ? ["--peer-task-id", "${AGENT_MESH_PEER_TASK_ID}"]
                : []),
              ...(options.peer.runId
                ? ["--peer-run-id", "${AGENT_MESH_PEER_RUN_ID}"]
                : []),
              ...(options.peer.causalRoot
                ? [
                    "--peer-causal-root",
                    "${AGENT_MESH_PEER_CAUSAL_ROOT}",
                  ]
                : []),
              ...(options.peer.causalPath?.length
                ? [
                    "--peer-causal-path",
                    "${AGENT_MESH_PEER_CAUSAL_PATH}",
                  ]
                : []),
              "--peer-capability",
              "${AGENT_MESH_PEER_CAPABILITY}",
            ]
          : []),
      ],
      env: { AGENT_MESH_STATE_DIR: stateDirectory() },
      enabled: true,
      startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
      tool_timeout_sec: 600,
    };
  }
  return {
    mcp_servers,
    allowedTools: [
      ...(profile === "research"
        ? [
            ...grokQualifiedTools("perplexity", PERPLEXITY_RESEARCH_TOOLS),
            ...grokQualifiedTools("context7", CONTEXT7_RESEARCH_TOOLS),
            ...grokQualifiedTools("pieces", PIECES_READ_ONLY_TOOLS),
          ]
        : []),
      ...(options.coordination
        ? grokQualifiedTools("coordination", COORDINATION_TOOLS)
        : []),
      ...(options.peer
        ? grokQualifiedTools("coordination", MANAGED_PEER_TOOLS)
        : []),
    ],
  };
}

export function buildAntigravityMcpProfile(
  profile: McpProfile,
  options: McpProfileBuildOptions = {},
): AntigravityMcpProfileConfig {
  const mcpServers: Record<string, AntigravityMcpServerConfig> =
    profile === "research"
      ? {
          perplexity: {
            command: PERPLEXITY_MCP_LAUNCHER,
            args: [],
            env: {},
          },
          pieces: {
            command: PIECES_READONLY_MCP_LAUNCHER,
            args: buildPiecesReadonlyProxyArgs(options),
            env: {},
          },
        }
      : {};
  if (options.coordination || options.peer) {
    mcpServers.coordination = {
      command: COORDINATION_MCP_LAUNCHER,
      args: scopedArgs(options),
      env: { AGENT_MESH_STATE_DIR: stateDirectory() },
    };
  }
  return { mcpServers };
}

export interface ResolveMcpProfileInput
  extends McpProfileBuildOptions {
  provider: McpProfileProvider;
  profile: McpProfile;
  mode: McpProfileTaskMode;
}

export type ResolvedMcpProfile =
  | {
      provider: "antigravity";
      profile: McpProfile;
      config: AntigravityMcpProfileConfig;
    }
  | {
      provider: "claude";
      profile: McpProfile;
      config: ClaudeMcpProfileConfig;
    }
  | {
      provider: "codex";
      profile: McpProfile;
      config: CodexThreadMcpConfig;
    }
  | {
      provider: "grok";
      profile: McpProfile;
      config: GrokMcpProfileConfig;
    };

export function resolveMcpProfile(input: ResolveMcpProfileInput): ResolvedMcpProfile {
  assertMcpProfileAllowed(input.mode, input.profile);
  const options = {
    env: input.env,
    piecesUrl: input.piecesUrl,
    cursorMcpConfigPath: input.cursorMcpConfigPath,
    piecesManifestPath: input.piecesManifestPath,
    coordination: input.coordination,
    peer: input.peer,
  };
  if (input.provider === "antigravity") {
    return {
      provider: input.provider,
      profile: input.profile,
      config: buildAntigravityMcpProfile(input.profile, options),
    };
  }
  if (input.provider === "claude") {
    return {
      provider: input.provider,
      profile: input.profile,
      config: buildClaudeMcpProfile(input.profile, options),
    };
  }
  if (input.provider === "grok") {
    return {
      provider: input.provider,
      profile: input.profile,
      config: buildGrokMcpProfile(input.profile, options),
    };
  }
  return {
    provider: input.provider,
    profile: input.profile,
    config: buildCodexMcpProfile(input.profile, options),
  };
}
