import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertManifestMatchesUpstream,
  createFilteringServer,
  createManifestFilteringServer,
  createToolManifest,
  createUpstreamRequestInit,
  loadToolManifest,
  loadHeaderSecretHeaders,
  loadUpstreamUrlSecret,
  parseHeaderSecretReference,
  parseMcpFilterProxyOptions,
  parseUpstreamUrlSecretPath,
  type LoadedMcpToolManifest,
} from "../src/mcp-filter-proxy.js";
import {
  PIECES_READ_ONLY_TOOLS,
  PIECES_READONLY_TOOL_MANIFEST,
} from "../src/mcp-profiles.js";

const READ_TOOL: Tool = {
  name: "read_echo",
  title: "Read echo",
  description: "Returns an input without mutation.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    $defs: { nonEmpty: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    properties: { echoed: { type: "string" } },
    required: ["echoed"],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { fixture: "preserve-me" },
};

const MUTATION_TOOL: Tool = {
  name: "delete_everything",
  description: "Test-only blocked mutation.",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

const GITHUB_READONLY_MANIFEST = join(
  process.cwd(),
  "github-readonly-tools.manifest.json",
);
const EXA_READONLY_MANIFEST = join(
  process.cwd(),
  "exa-readonly-tools.manifest.json",
);
const FRAMER_READONLY_MANIFEST = join(
  process.cwd(),
  "framer-readonly-tools.manifest.json",
);
const temporaryDirectories: string[] = [];

function secretFixture(value = "test-secret-value", mode = 0o600): {
  home: string;
  root: string;
  path: string;
  value: string;
} {
  const home = mkdtempSync(join(tmpdir(), "mcp-filter-secret-home-"));
  temporaryDirectories.push(home);
  const root = join(home, ".secrets");
  mkdirSync(root, { mode: 0o700 });
  const path = join(root, "token");
  writeFileSync(path, value, { mode });
  return { home, root, path, value };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  upstreamServer: Server;
  upstreamClient: Client;
  calls: string[];
  close(): Promise<void>;
}

function manifestFor(tools: readonly Tool[]): LoadedMcpToolManifest {
  const manifest = createToolManifest(
    tools,
    {
      name: "proxy-test-upstream",
      version: "1.0.0",
      protocolVersion: "2025-11-25",
    },
    "2026-07-12T00:00:00.000Z",
  );
  return { ...manifest, tools: structuredClone(tools) };
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function createUpstreamFixture(delayMs = 0): Promise<Fixture> {
  const calls: string[] = [];
  const upstreamServer = new Server(
    { name: "proxy-test-upstream", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  upstreamServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [READ_TOOL, MUTATION_TOOL],
  }));
  upstreamServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    if (request.params.name === READ_TOOL.name) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const echoed = String(request.params.arguments?.message ?? "");
      return {
        content: [{ type: "text", text: echoed, _meta: { preserved: true } }],
        structuredContent: { echoed },
        _meta: { upstream: "fixture" },
      };
    }
    if (request.params.name === MUTATION_TOOL.name) {
      return { content: [{ type: "text", text: "mutation-called" }] };
    }
    throw new McpError(ErrorCode.InvalidParams, "Unknown fixture tool.");
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await upstreamServer.connect(serverTransport);
  const upstreamClient = new Client(
    { name: "proxy-test-upstream-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await upstreamClient.connect(clientTransport);

  return {
    upstreamServer,
    upstreamClient,
    calls,
    async close() {
      await Promise.allSettled([upstreamClient.close(), upstreamServer.close()]);
    },
  };
}

describe("MCP filtering proxy", () => {
  it("loads the checked-in hashed Pieces manifest", () => {
    const manifest = loadToolManifest(
      PIECES_READONLY_TOOL_MANIFEST,
      PIECES_READ_ONLY_TOOLS,
    );
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      ...PIECES_READ_ONLY_TOOLS,
    ]);
    expect(manifest.payloadSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.schemaSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.upstream).toEqual({
      name: "pieces-mcp-server",
      version: "1.0.0",
      protocolVersion: "2025-11-25",
    });
  });

  it("loads the reviewed GitHub manifest with only non-egress readonly tools", () => {
    const manifest = loadToolManifest(GITHUB_READONLY_MANIFEST);
    expect(manifest.tools).toHaveLength(27);
    expect(
      manifest.tools.every((tool) => tool.annotations?.readOnlyHint === true),
    ).toBe(true);
    expect(manifest.allowlist).not.toContain("run_secret_scanning");
    expect(manifest.allowlist).not.toContain("delete_file");
    expect(manifest.allowlist).not.toContain("push_files");

    const raw = JSON.parse(readFileSync(GITHUB_READONLY_MANIFEST, "utf8")) as {
      policy: {
        reviewedToolCount: number;
        excludedContentEgressTools: string[];
        excludedWriteTools: string[];
      };
    };
    expect(raw.policy.reviewedToolCount).toBe(47);
    expect(raw.policy.excludedContentEgressTools).toEqual([
      "run_secret_scanning",
    ]);
    expect(raw.policy.excludedWriteTools).toContain("delete_file");
    expect(raw.policy.excludedWriteTools).toContain("merge_pull_request");
  });

  it("loads the reviewed Exa and Framer manifests", () => {
    const exa = loadToolManifest(EXA_READONLY_MANIFEST);
    expect(exa.allowlist).toEqual(["web_search_exa", "web_fetch_exa"]);
    expect(
      exa.tools.every((tool) => tool.annotations?.readOnlyHint === true),
    ).toBe(true);

    const framer = loadToolManifest(FRAMER_READONLY_MANIFEST);
    expect(framer.allowlist).toEqual([
      "getProjectXml",
      "getSelectedNodesXml",
      "getNodeXml",
      "searchFonts",
      "exportReactComponents",
      "readCodeFile",
      "getComponentInsertUrlAndTypes",
      "getProjectWebsiteUrl",
      "getCMSCollections",
      "getCMSItems",
    ]);
    expect(framer.allowlist).not.toContain("updateXmlForNode");
    expect(framer.allowlist).not.toContain("deleteNode");
    expect(framer.allowlist).not.toContain("upsertCMSItem");

    const raw = JSON.parse(readFileSync(FRAMER_READONLY_MANIFEST, "utf8")) as {
      policy: {
        reviewedToolCount: number;
        excludedMutationTools: string[];
      };
    };
    expect(raw.policy.reviewedToolCount).toBe(22);
    expect(raw.policy.excludedMutationTools).toContain("deleteNode");
    expect(raw.policy.excludedMutationTools).toContain("createPage");
  });

  it("exposes only the exact startup-validated allowlist and preserves payloads", async () => {
    const upstream = await createUpstreamFixture();
    const filtering = await createFilteringServer({
      upstreamClient: upstream.upstreamClient,
      allowTools: [READ_TOOL.name],
      startupTimeoutMs: 1_000,
      callTimeoutMs: 1_000,
    });
    const [proxyTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await filtering.server.connect(proxyTransport);
    const client = new Client(
      { name: "proxy-test-downstream", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools).toEqual([READ_TOOL]);

      const result = await client.callTool({
        name: READ_TOOL.name,
        arguments: { message: "safe result" },
      });
      expect(result).toMatchObject({
        content: [{ type: "text", text: "safe result", _meta: { preserved: true } }],
        structuredContent: { echoed: "safe result" },
        _meta: { upstream: "fixture" },
      });

      await expect(
        client.callTool({ name: MUTATION_TOOL.name, arguments: {} }),
      ).rejects.toThrow(/not exposed/);
      expect(upstream.calls).toEqual([READ_TOOL.name]);
    } finally {
      await Promise.allSettled([client.close(), filtering.server.close()]);
      await upstream.close();
    }
  });

  it("serves the pinned manifest immediately and gates calls until validation", async () => {
    const upstream = await createUpstreamFixture();
    const gate = deferred();
    const filtering = createManifestFilteringServer({
      upstreamClient: upstream.upstreamClient,
      manifest: manifestFor([READ_TOOL]),
      validation: gate.promise,
      callTimeoutMs: 1_000,
    });
    const [proxyTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await filtering.server.connect(proxyTransport);
    const client = new Client(
      { name: "manifest-startup-downstream", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const startedAt = performance.now();
      expect((await client.listTools()).tools).toEqual([READ_TOOL]);
      expect(performance.now() - startedAt).toBeLessThan(100);

      let settled = false;
      const call = client
        .callTool({ name: READ_TOOL.name, arguments: { message: "after validation" } })
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
      expect(upstream.calls).toEqual([]);

      gate.resolve();
      await expect(call).resolves.toMatchObject({
        structuredContent: { echoed: "after validation" },
      });
      expect(upstream.calls).toEqual([READ_TOOL.name]);
    } finally {
      await Promise.allSettled([client.close(), filtering.server.close()]);
      await upstream.close();
    }
  });

  it("rejects schema drift and never forwards a call after failed validation", async () => {
    const upstream = await createUpstreamFixture();
    const manifest = manifestFor([READ_TOOL]);
    const driftedTool: Tool = {
      ...READ_TOOL,
      inputSchema: {
        type: "object",
        properties: { changed: { type: "boolean" } },
      },
    };
    expect(() =>
      assertManifestMatchesUpstream(manifest, [
        { ...READ_TOOL, description: "Runtime-only description changed." },
      ]),
    ).not.toThrow();
    expect(() => assertManifestMatchesUpstream(manifest, [driftedTool])).toThrow(
      /schemas do not match/,
    );

    const gate = deferred();
    const filtering = createManifestFilteringServer({
      upstreamClient: upstream.upstreamClient,
      manifest,
      validation: gate.promise,
      callTimeoutMs: 1_000,
    });
    const [proxyTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await filtering.server.connect(proxyTransport);
    const client = new Client(
      { name: "manifest-mismatch-downstream", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      await client.listTools();
      const call = client.callTool({
        name: READ_TOOL.name,
        arguments: { message: "must-not-run" },
      });
      gate.reject(new Error("Upstream MCP schemas do not match the pinned tool manifest."));
      await expect(call).rejects.toThrow(/schemas do not match/);
      expect(upstream.calls).toEqual([]);
    } finally {
      await Promise.allSettled([client.close(), filtering.server.close()]);
      await upstream.close();
    }
  });

  it("blocks nonallowlisted Framer mutations before upstream dispatch", async () => {
    const upstream = await createUpstreamFixture();
    const filtering = createManifestFilteringServer({
      upstreamClient: upstream.upstreamClient,
      manifest: loadToolManifest(FRAMER_READONLY_MANIFEST),
      validation: Promise.resolve(),
      callTimeoutMs: 1_000,
    });
    const [proxyTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await filtering.server.connect(proxyTransport);
    const client = new Client(
      { name: "framer-readonly-downstream", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    try {
      await expect(
        client.callTool({
          name: "updateXmlForNode",
          arguments: { nodeId: "blocked", xml: "<Frame />" },
        }),
      ).rejects.toThrow(/not exposed/);
      expect(upstream.calls).toEqual([]);
    } finally {
      await Promise.allSettled([client.close(), filtering.server.close()]);
      await upstream.close();
    }
  });

  it("fails startup when any allowlisted tool is absent or duplicated", async () => {
    const upstream = await createUpstreamFixture();
    try {
      await expect(
        createFilteringServer({
          upstreamClient: upstream.upstreamClient,
          allowTools: ["missing_tool"],
          startupTimeoutMs: 1_000,
        }),
      ).rejects.toThrow(/missing allowlisted tools: missing_tool/);
      await expect(
        createFilteringServer({
          upstreamClient: upstream.upstreamClient,
          allowTools: [READ_TOOL.name, READ_TOOL.name],
          startupTimeoutMs: 1_000,
        }),
      ).rejects.toThrow(/Duplicate MCP tool/);
    } finally {
      await upstream.close();
    }
  });

  it("caps forwarded tool calls and closes access when disabled", async () => {
    const upstream = await createUpstreamFixture(100);
    const filtering = await createFilteringServer({
      upstreamClient: upstream.upstreamClient,
      allowTools: [READ_TOOL.name],
      startupTimeoutMs: 1_000,
      callTimeoutMs: 20,
    });
    const [proxyTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await filtering.server.connect(proxyTransport);
    const client = new Client(
      { name: "proxy-timeout-downstream", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      await expect(
        client.callTool({ name: READ_TOOL.name, arguments: { message: "slow" } }),
      ).rejects.toThrow();
      filtering.disable();
      expect((await client.listTools()).tools).toEqual([READ_TOOL]);
      await expect(
        client.callTool({ name: READ_TOOL.name, arguments: { message: "closed" } }),
      ).rejects.toThrow(/upstream is unavailable/);
    } finally {
      await Promise.allSettled([client.close(), filtering.server.close()]);
      await upstream.close();
    }
  });

  it("validates secret header names and paths under the private root", () => {
    const fixture = secretFixture();
    expect(
      parseHeaderSecretReference(`X-GitHub-Token=${fixture.path}`, fixture.root),
    ).toEqual({
      header: "X-GitHub-Token",
      path: fixture.path,
    });
    expect(() =>
      parseHeaderSecretReference(`Bad Header=${fixture.path}`, fixture.root),
    ).toThrow(/Invalid secret header name/);
    expect(() =>
      parseHeaderSecretReference(`Host=${fixture.path}`, fixture.root),
    ).toThrow(/reserved by the MCP transport/);
    expect(() =>
      parseHeaderSecretReference("Authorization=relative-token", fixture.root),
    ).toThrow(/must be absolute/);
    expect(() =>
      parseHeaderSecretReference(
        `Authorization=${join(fixture.home, "outside-token")}`,
        fixture.root,
      ),
    ).toThrow(/beneath ~\/\.secrets/);
  });

  it("loads private secrets and injects only upstream request headers", () => {
    const fixture = secretFixture("github-test-token\n");
    const apiKeyPath = join(fixture.root, "api-key");
    writeFileSync(apiKeyPath, "second-private-value", { mode: 0o400 });
    const references = [
      parseHeaderSecretReference(`Authorization=${fixture.path}`, fixture.root),
      parseHeaderSecretReference(`X-Api-Key=${apiKeyPath}`, fixture.root),
    ];
    const loaded = loadHeaderSecretHeaders(references, fixture.root);
    expect(loaded.headers).toEqual({
      Authorization: "Bearer github-test-token",
      "X-Api-Key": "second-private-value",
    });
    const requestInit = createUpstreamRequestInit(loaded);
    expect(new Headers(requestInit.headers).get("authorization")).toBe(
      "Bearer github-test-token",
    );
    expect(requestInit).toEqual({
      redirect: "error",
      headers: {
        Authorization: "Bearer github-test-token",
        "X-Api-Key": "second-private-value",
      },
    });

    const parsed = parseMcpFilterProxyOptions(
      [
        "--upstream-url=https://example.test/mcp",
        `--allow-tools=${READ_TOOL.name}`,
        "--manifest=/tmp/manifest.json",
        `--header-secret=Authorization=${fixture.path}`,
        `--header-secret=X-Api-Key=${apiKeyPath}`,
      ],
      { HOME: fixture.home },
    );
    expect(JSON.stringify(parsed)).not.toContain("github-test-token");
    expect(JSON.stringify(parsed)).not.toContain("second-private-value");
    expect(parsed.headerSecrets).toEqual(references);
    expect(loaded.redact("Bearer github-test-token failed")).toBe(
      "[REDACTED] failed",
    );
  });

  it("rejects symlinked or non-private secret files without leaking values", () => {
    const exposed = secretFixture("DO_NOT_LEAK_THIS_SECRET", 0o644);
    const exposedReference = parseHeaderSecretReference(
      `Authorization=${exposed.path}`,
      exposed.root,
    );
    if (process.platform !== "win32") {
      let modeError = "";
      try {
        loadHeaderSecretHeaders([exposedReference], exposed.root);
      } catch (error) {
        modeError = error instanceof Error ? error.message : String(error);
      }
      expect(modeError).toMatch(/mode 0600 or stricter/);
      expect(modeError).not.toContain(exposed.value);
    }

    chmodSync(exposed.path, 0o600);
    const symlinkPath = join(exposed.root, "token-link");
    symlinkSync(exposed.path, symlinkPath);
    const symlinkReference = parseHeaderSecretReference(
      `Authorization=${symlinkPath}`,
      exposed.root,
    );
    expect(() =>
      loadHeaderSecretHeaders([symlinkReference], exposed.root),
    ).toThrow(/non-symlink regular file/);
  });

  it("loads query credentials only from a private upstream URL file", () => {
    const privateUrl =
      "https://private.example.test/mcp?id=private-id&secret=private-secret";
    const fixture = secretFixture(privateUrl);
    expect(parseUpstreamUrlSecretPath(fixture.path, fixture.root)).toBe(
      fixture.path,
    );
    const loaded = loadUpstreamUrlSecret(fixture.path, fixture.root);
    expect(loaded.url.hostname).toBe("private.example.test");
    expect(loaded.url.searchParams.get("id")).toBe("private-id");
    expect(
      loaded.redact(`request failed: ${privateUrl}; private-secret`),
    ).not.toContain("private-id");
    expect(
      loaded.redact(`request failed: ${privateUrl}; private-secret`),
    ).not.toContain("private-secret");

    const parsed = parseMcpFilterProxyOptions(
      [
        `--upstream-url-secret=${fixture.path}`,
        `--allow-tools=${READ_TOOL.name}`,
        "--manifest=/tmp/manifest.json",
      ],
      { HOME: fixture.home },
    );
    expect(parsed.upstreamUrl).toBeUndefined();
    expect(parsed.upstreamUrlSecretPath).toBe(fixture.path);
    expect(JSON.stringify(parsed)).not.toContain("private-id");
    expect(JSON.stringify(parsed)).not.toContain("private-secret");

    expect(() =>
      parseMcpFilterProxyOptions(
        [
          "--upstream-url=https://public.example.test/mcp",
          `--upstream-url-secret=${fixture.path}`,
          `--allow-tools=${READ_TOOL.name}`,
          "--manifest=/tmp/manifest.json",
        ],
        { HOME: fixture.home },
      ),
    ).toThrow(/either --upstream-url or --upstream-url-secret/);
    expect(() =>
      parseMcpFilterProxyOptions([
        "--upstream-url=https://public.example.test/mcp?secret=plaintext",
        `--allow-tools=${READ_TOOL.name}`,
        "--manifest=/tmp/manifest.json",
      ]),
    ).toThrow(/must not contain credentials/);
  });

  it("rejects insecure private upstream URL files", () => {
    const exposed = secretFixture(
      "https://private.example.test/mcp?secret=DO_NOT_LEAK",
      0o644,
    );
    if (process.platform !== "win32") {
      let errorMessage = "";
      try {
        loadUpstreamUrlSecret(exposed.path, exposed.root);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      expect(errorMessage).toMatch(/mode 0600 or stricter/);
      expect(errorMessage).not.toContain("DO_NOT_LEAK");
    }

    chmodSync(exposed.path, 0o600);
    const link = join(exposed.root, "url-link");
    symlinkSync(exposed.path, link);
    expect(() => loadUpstreamUrlSecret(link, exposed.root)).toThrow(
      /non-symlink regular file/,
    );
  });

  it("rejects invalid upstream and allowlist configuration before connecting", () => {
    expect(() =>
      parseMcpFilterProxyOptions([
        "--upstream-url",
        "file:///tmp/not-http",
        "--allow-tools",
        READ_TOOL.name,
        "--manifest",
        "/tmp/manifest.json",
      ]),
    ).toThrow(/must use HTTP or HTTPS/);
    expect(() =>
      parseMcpFilterProxyOptions([
        "--upstream-url",
        "https://user:secret@example.test/mcp",
        "--allow-tools",
        READ_TOOL.name,
        "--manifest",
        "/tmp/manifest.json",
      ]),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      parseMcpFilterProxyOptions([
        "--upstream-url",
        "https://example.test/mcp",
        "--allow-tools",
        "",
        "--manifest",
        "/tmp/manifest.json",
      ]),
    ).toThrow(/at least one tool name/);
    expect(() =>
      parseMcpFilterProxyOptions([
        "--upstream-url",
        "https://example.test/mcp",
        "--allow-tools",
        `${READ_TOOL.name},${READ_TOOL.name}`,
        "--manifest",
        "/tmp/manifest.json",
      ]),
    ).toThrow(/Duplicate MCP tool/);
  });

  it("accepts an exact environment allowlist and gives CLI values priority", () => {
    const fromEnvironment = parseMcpFilterProxyOptions([], {
      MCP_FILTER_UPSTREAM_URL: "https://environment.example.test/mcp",
      MCP_FILTER_ALLOW_TOOLS: JSON.stringify([READ_TOOL.name]),
      MCP_FILTER_MANIFEST_PATH: "/tmp/environment-manifest.json",
      MCP_FILTER_STARTUP_TIMEOUT_MS: "1234",
      MCP_FILTER_CALL_TIMEOUT_MS: "5678",
    });
    expect(fromEnvironment).toMatchObject({
      allowTools: [READ_TOOL.name],
      manifestPath: resolve("/tmp/environment-manifest.json"),
      startupTimeoutMs: 1234,
      callTimeoutMs: 5678,
    });
    expect(fromEnvironment.upstreamUrl.toString()).toBe(
      "https://environment.example.test/mcp",
    );

    const fromCli = parseMcpFilterProxyOptions(
      [
        "--upstream-url=https://cli.example.test/mcp",
        `--allow-tools=${READ_TOOL.name}`,
        "--manifest=/tmp/cli-manifest.json",
      ],
      {
        MCP_FILTER_UPSTREAM_URL: "file:///environment-must-not-win",
        MCP_FILTER_ALLOW_TOOLS: MUTATION_TOOL.name,
        MCP_FILTER_MANIFEST_PATH: "/tmp/environment-manifest.json",
      },
    );
    expect(fromCli.upstreamUrl.toString()).toBe("https://cli.example.test/mcp");
    expect(fromCli.allowTools).toEqual([READ_TOOL.name]);
    expect(fromCli.manifestPath).toBe(resolve("/tmp/cli-manifest.json"));
  });
});
