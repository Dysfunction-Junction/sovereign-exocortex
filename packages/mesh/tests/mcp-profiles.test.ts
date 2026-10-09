import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_RESEARCH_ALLOWED_TOOLS,
  CLAUDE_RESEARCH_DISALLOWED_TOOLS,
  CONTEXT7_MCP_URL,
  DEFAULT_PIECES_MCP_URL,
  MANAGED_PEER_TOOLS,
  PERPLEXITY_MCP_LAUNCHER,
  PIECES_FILESYSTEM_TOOLS,
  PIECES_MUTATION_TOOLS,
  PIECES_READ_ONLY_TOOLS,
  PIECES_READONLY_MCP_LAUNCHER,
  PIECES_READONLY_TOOL_MANIFEST,
  RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
  RESEARCH_MCP_TOOL_TIMEOUT_SEC,
  assertMcpProfileAllowed,
  buildAntigravityMcpProfile,
  buildClaudeMcpProfile,
  buildCodexMcpProfile,
  buildGrokMcpProfile,
  resolveMcpProfile,
  resolvePiecesMcpUrl,
} from "../src/mcp-profiles.js";

const temporaryDirectories: string[] = [];

function temporaryCursorConfig(config: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-mesh-mcp-profile-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "mcp.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

function isolatedOptions() {
  return {
    env: {},
    cursorMcpConfigPath: join(tmpdir(), "agent-mesh-definitely-missing-mcp.json"),
  };
}

function expectProxyArgs(
  args: string[],
  expectedUrl: string,
  expectedManifest = PIECES_READONLY_TOOL_MANIFEST,
): void {
  expect(args).toEqual([
    "--upstream-url",
    expectedUrl,
    "--allow-tools",
    PIECES_READ_ONLY_TOOLS.join(","),
    "--manifest",
    expectedManifest,
    "--startup-timeout-ms",
    String(RESEARCH_MCP_STARTUP_TIMEOUT_SEC * 1_000),
    "--call-timeout-ms",
    String(RESEARCH_MCP_TOOL_TIMEOUT_SEC * 1_000),
  ]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP profiles", () => {
  it("produces strict empty provider configs for none", () => {
    const claude = buildClaudeMcpProfile("none");
    expect(claude.mcpConfig).toEqual({ mcpServers: {} });
    expect(claude.mcpConfigJson).toBe('{"mcpServers":{}}');
    expect(claude.allowedTools).toEqual([]);
    expect(claude.disallowedTools).toEqual([]);

    const codex = buildCodexMcpProfile("none");
    expect(codex).toEqual({ mcp_servers: {} });
    expect(JSON.stringify(codex)).toBe('{"mcp_servers":{}}');

    const grok = buildGrokMcpProfile("none");
    expect(grok).toEqual({ mcp_servers: {}, allowedTools: [] });

    const antigravity = buildAntigravityMcpProfile("none");
    expect(antigravity).toEqual({ mcpServers: {} });
  });

  it("injects the task-bound managed-peer server independently of research", () => {
    const peer = {
      origin: "cursor" as const,
      agentId: "11111111-1111-4111-8111-111111111111",
      memberId: "22222222-2222-4222-8222-222222222222",
      membershipGeneration: 3,
      taskId: "33333333-3333-4333-8333-333333333333",
    };
    const claude = buildClaudeMcpProfile("none", { peer });
    expect(claude.mcpConfig.mcpServers.coordination).toBeDefined();
    expect(claude.allowedTools).toEqual(
      MANAGED_PEER_TOOLS.map((tool) => `mcp__coordination__${tool}`),
    );
    const codex = buildCodexMcpProfile("none", { peer });
    expect(codex.mcp_servers.coordination.enabled_tools).toEqual([
      ...MANAGED_PEER_TOOLS,
    ]);
    const antigravity = buildAntigravityMcpProfile("none", { peer });
    expect(antigravity.mcpServers.coordination).toBeDefined();
    const grok = buildGrokMcpProfile("none", { peer });
    expect(grok.allowedTools).toContain("MCPTool(coordination__peer_send)");
    expect(JSON.stringify(grok)).not.toContain(peer.agentId);
  });

  it("allowlists scoped direction acknowledgment for managed peers", () => {
    expect(MANAGED_PEER_TOOLS).toContain("peer_direction_ack");
  });

  it("routes Pieces through the pinned filtering proxy for both providers", () => {
    const options = isolatedOptions();
    const claude = buildClaudeMcpProfile("research", options);
    expect(claude.mcpConfig.mcpServers.perplexity).toEqual({
      type: "stdio",
      command: PERPLEXITY_MCP_LAUNCHER,
      args: [],
      env: {},
      timeout: 300_000,
    });
    expect(claude.mcpConfig.mcpServers.context7).toEqual({
      type: "http",
      url: CONTEXT7_MCP_URL,
      timeout: 300_000,
    });
    const claudePieces = claude.mcpConfig.mcpServers.pieces;
    expect(claudePieces).toMatchObject({
      type: "stdio",
      command: PIECES_READONLY_MCP_LAUNCHER,
      env: {},
    });
    expect(claudePieces).not.toHaveProperty("url");
    if ("args" in claudePieces) expectProxyArgs(claudePieces.args, DEFAULT_PIECES_MCP_URL);
    expect(JSON.parse(claude.mcpConfigJson)).toEqual(claude.mcpConfig);

    const codex = buildCodexMcpProfile("research", options);
    const codexPieces = codex.mcp_servers.pieces;
    expect(codexPieces).toMatchObject({
      command: PIECES_READONLY_MCP_LAUNCHER,
      env: {},
      required: true,
      startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
      tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
      enabled_tools: [...PIECES_READ_ONLY_TOOLS],
      default_tools_approval_mode: "approve",
    });
    expect(codexPieces).not.toHaveProperty("url");
    if ("args" in codexPieces) expectProxyArgs(codexPieces.args, DEFAULT_PIECES_MCP_URL);

    const grok = buildGrokMcpProfile("research", options);
    const grokPieces = grok.mcp_servers.pieces;
    expect(grokPieces).toMatchObject({
      command: PIECES_READONLY_MCP_LAUNCHER,
      env: {},
      enabled: true,
      startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
      tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
    });
    expect(grok.allowedTools).toContain("MCPTool(pieces__ask_pieces_ltm)");
    if ("args" in grokPieces) expectProxyArgs(grokPieces.args, DEFAULT_PIECES_MCP_URL);

    const antigravity = buildAntigravityMcpProfile("research", options);
    expect(antigravity.mcpServers.perplexity).toEqual({
      command: PERPLEXITY_MCP_LAUNCHER,
      args: [],
      env: {},
    });
    const antigravityPieces = antigravity.mcpServers.pieces;
    expect(antigravityPieces).toMatchObject({
      command: PIECES_READONLY_MCP_LAUNCHER,
      env: {},
    });
    if ("args" in antigravityPieces) {
      expectProxyArgs(antigravityPieces.args, DEFAULT_PIECES_MCP_URL);
    }
  });

  it("sets required, startup, tool, enablement, and approval policies", () => {
    const codex = buildCodexMcpProfile("research", isolatedOptions());
    for (const server of Object.values(codex.mcp_servers)) {
      expect(server).toMatchObject({
        required: true,
        startup_timeout_sec: RESEARCH_MCP_STARTUP_TIMEOUT_SEC,
        tool_timeout_sec: RESEARCH_MCP_TOOL_TIMEOUT_SEC,
        default_tools_approval_mode: "approve",
      });
      expect(server.enabled_tools.length).toBeGreaterThan(0);
    }
  });

  it("supports an injected pinned manifest path", () => {
    const manifestPath = join(tmpdir(), "custom-pieces-manifest.json");
    const pieces = buildClaudeMcpProfile("research", {
      ...isolatedOptions(),
      piecesManifestPath: manifestPath,
    }).mcpConfig.mcpServers.pieces;
    if ("args" in pieces) {
      expectProxyArgs(pieces.args, DEFAULT_PIECES_MCP_URL, manifestPath);
    }
  });

  it("discovers Pieces from an injected Cursor config with env priority", () => {
    const configPath = temporaryCursorConfig({
      mcpServers: {
        pieces: { url: "https://cursor-pieces.example.test/mcp" },
      },
    });

    expect(resolvePiecesMcpUrl({ env: {}, cursorMcpConfigPath: configPath })).toBe(
      "https://cursor-pieces.example.test/mcp",
    );
    expect(
      resolvePiecesMcpUrl({
        env: { AGENT_MESH_PIECES_URL: "https://env-pieces.example.test/mcp" },
        cursorMcpConfigPath: configPath,
      }),
    ).toBe("https://env-pieces.example.test/mcp");

    const claudePieces = buildClaudeMcpProfile("research", {
      env: {},
      cursorMcpConfigPath: configPath,
    }).mcpConfig.mcpServers.pieces;
    const codexPieces = buildCodexMcpProfile("research", {
      env: {},
      cursorMcpConfigPath: configPath,
    }).mcp_servers.pieces;
    const grokPieces = buildGrokMcpProfile("research", {
      env: {},
      cursorMcpConfigPath: configPath,
    }).mcp_servers.pieces;
    const antigravityPieces = buildAntigravityMcpProfile("research", {
      env: {},
      cursorMcpConfigPath: configPath,
    }).mcpServers.pieces;
    if ("args" in claudePieces) {
      expectProxyArgs(claudePieces.args, "https://cursor-pieces.example.test/mcp");
    }
    if ("args" in codexPieces) {
      expectProxyArgs(codexPieces.args, "https://cursor-pieces.example.test/mcp");
    }
    if ("args" in grokPieces) {
      expectProxyArgs(grokPieces.args, "https://cursor-pieces.example.test/mcp");
    }
    if ("args" in antigravityPieces) {
      expectProxyArgs(antigravityPieces.args, "https://cursor-pieces.example.test/mcp");
    }
  });

  it("allows no mutation or filesystem Pieces tools", () => {
    const mutationPattern = /(?:^|_)(?:create|update|patch|delete)(?:_|$)/;
    expect(PIECES_READ_ONLY_TOOLS.some((tool) => mutationPattern.test(tool))).toBe(false);

    const codexPieces = buildCodexMcpProfile("research", isolatedOptions()).mcp_servers
      .pieces;
    const enabledTools = "enabled_tools" in codexPieces ? codexPieces.enabled_tools : [];

    for (const tool of [...PIECES_MUTATION_TOOLS, ...PIECES_FILESYSTEM_TOOLS]) {
      expect(PIECES_READ_ONLY_TOOLS).not.toContain(tool);
      expect(enabledTools).not.toContain(tool);
      expect(CLAUDE_RESEARCH_ALLOWED_TOOLS).not.toContain(`mcp__pieces__${tool}`);
      expect(CLAUDE_RESEARCH_DISALLOWED_TOOLS).toContain(`mcp__pieces__${tool}`);
    }
    expect(CLAUDE_RESEARCH_ALLOWED_TOOLS).toContain("mcp__perplexity__search");
    expect(CLAUDE_RESEARCH_ALLOWED_TOOLS).toContain(
      "mcp__context7__resolve-library-id",
    );
    expect(CLAUDE_RESEARCH_ALLOWED_TOOLS).toContain("mcp__pieces__ask_pieces_ltm");
    expect(
      buildGrokMcpProfile("research", isolatedOptions()).allowedTools,
    ).toContain("MCPTool(perplexity__search)");
  });

  it("allows research MCPs for implementation as well as ask/plan/review", () => {
    for (const mode of ["ask", "plan", "research", "review", "implement"] as const) {
      expect(() => assertMcpProfileAllowed(mode, "research")).not.toThrow();
      expect(
        resolveMcpProfile({
          provider: "codex",
          profile: "research",
          mode,
          ...isolatedOptions(),
        }).profile,
      ).toBe("research");
      expect(
        resolveMcpProfile({
          provider: "antigravity",
          profile: "research",
          mode,
          ...isolatedOptions(),
        }).profile,
      ).toBe("research");
      expect(
        resolveMcpProfile({
          provider: "grok",
          profile: "research",
          mode,
          ...isolatedOptions(),
        }).profile,
      ).toBe("research");
    }
  });

  it("does not copy ambient credentials or embed package launchers", () => {
    const secrets = {
      PERPLEXITY_API_KEY: "pplx-do-not-copy-this-value",
      CONTEXT7_API_KEY: "ctx7-do-not-copy-this-value",
      OPENAI_API_KEY: "sk-do-not-copy-this-value",
      GITHUB_TOKEN: "ghp_do-not-copy-this-value",
    };
    const env = {
      AGENT_MESH_PIECES_URL: "https://pieces.example.test/mcp",
      ...secrets,
    };
    const generated = JSON.stringify({
      claude: buildClaudeMcpProfile("research", { env }),
      codex: buildCodexMcpProfile("research", { env }),
      grok: buildGrokMcpProfile("research", { env }),
      antigravity: buildAntigravityMcpProfile("research", { env }),
    });

    for (const [name, value] of Object.entries(secrets)) {
      expect(generated).not.toContain(name);
      expect(generated).not.toContain(value);
    }
    expect(generated).not.toMatch(/\bnpx\b/i);
    expect(generated).toContain(JSON.stringify(PERPLEXITY_MCP_LAUNCHER).slice(1, -1));
    expect(generated).toContain(JSON.stringify(PIECES_READONLY_MCP_LAUNCHER).slice(1, -1));
  });

  it("rejects invalid or secret-bearing discovered Pieces URLs", () => {
    expect(() =>
      buildClaudeMcpProfile("research", {
        env: { AGENT_MESH_PIECES_URL: "https://user:secret@pieces.example.test/mcp" },
      }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      buildCodexMcpProfile("research", {
        env: { AGENT_MESH_PIECES_URL: "https://pieces.example.test/mcp?token=secret" },
      }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      buildGrokMcpProfile("research", {
        env: { AGENT_MESH_PIECES_URL: "https://pieces.example.test/mcp?token=secret" },
      }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      buildAntigravityMcpProfile("research", {
        env: { AGENT_MESH_PIECES_URL: "https://pieces.example.test/mcp?token=secret" },
      }),
    ).toThrow(/must not contain credentials/);

    const configPath = temporaryCursorConfig({
      mcpServers: { pieces: { url: "file:///tmp/not-an-http-mcp" } },
    });
    expect(() => resolvePiecesMcpUrl({ env: {}, cursorMcpConfigPath: configPath })).toThrow(
      /must use HTTP or HTTPS/,
    );
  });
});
