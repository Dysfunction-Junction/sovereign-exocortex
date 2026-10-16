import { describe, expect, it } from "vitest";

import {
  PROVIDER_LOGOUT_CONFIRMATIONS,
  PROVIDER_UPDATE_CONFIRMATIONS,
  ProviderMutationConfirmationError,
  createProviderAdmin,
  isSafeClaudeModelId,
  type CodexReadClient,
  type CodexReadRequest,
  type ProviderAdminConfigReader,
  type ProviderCommandExecutor,
  type ProviderCommandOperation,
  type ProviderCommandOutput,
} from "../provider-admin.js";
import type { Provider } from "../types.js";
import {
  CLAUDE_FABLE_5_MODEL,
  CLAUDE_MAX_EFFORT,
  CLAUDE_OPUS_5_MODEL,
  CLAUDE_OPUS_5_FALLBACK_EFFORT,
  CLAUDE_OPUS_5_FALLBACK_MODEL,
  isClaudeFableModel,
  isClaudeOpus5Model,
  isClaudeUsageOrAvailabilityError,
  planClaudeFallback,
} from "../adapters/claude.js";

function output(
  stdout = "",
  options: Partial<ProviderCommandOutput> = {},
): ProviderCommandOutput {
  return {
    stdout,
    stderr: options.stderr ?? "",
    exitCode: options.exitCode ?? 0,
    signal: options.signal ?? null,
  };
}

class FakeExecutor implements ProviderCommandExecutor {
  readonly calls: Array<{ provider: Provider; operation: ProviderCommandOperation }> = [];
  readonly locateCalls: Provider[] = [];
  readonly paths: Record<Provider, string | null> = {
    cursor: "/fake/bin/cursor-agent",
    codex: "/fake/bin/codex",
    claude: "/fake/bin/claude",
    grok: "/fake/bin/grok",
    antigravity: "/fake/bin/agy",
  };
  private readonly responses = new Map<string, ProviderCommandOutput[]>();

  set(
    provider: Provider,
    operation: ProviderCommandOperation,
    ...responses: ProviderCommandOutput[]
  ): this {
    this.responses.set(`${provider}:${operation}`, [...responses]);
    return this;
  }

  async locate(provider: Provider): Promise<string | null> {
    this.locateCalls.push(provider);
    return this.paths[provider];
  }

  async run(
    provider: Provider,
    operation: ProviderCommandOperation,
  ): Promise<ProviderCommandOutput> {
    this.calls.push({ provider, operation });
    const key = `${provider}:${operation}`;
    const responses = this.responses.get(key);
    if (!responses?.length) throw new Error(`Unexpected fake command: ${key}`);
    if (responses.length === 1) return responses[0]!;
    return responses.shift()!;
  }
}

class FakeCodexClient implements CodexReadClient {
  readonly calls: CodexReadRequest[][] = [];

  constructor(
    private readonly handler: (
      requests: readonly CodexReadRequest[],
      call: number,
    ) => unknown[] | Promise<unknown[]>,
  ) {}

  async read(requests: readonly CodexReadRequest[]): Promise<unknown[]> {
    this.calls.push(requests.map((request) => structuredClone(request)));
    return this.handler(requests, this.calls.length);
  }
}

class FakeConfig implements ProviderAdminConfigReader {
  constructor(private readonly settings: unknown = {}) {}

  async readClaudeSettings(): Promise<unknown> {
    return structuredClone(this.settings);
  }
}

function noCodexCalls(): FakeCodexClient {
  return new FakeCodexClient((requests) => {
    throw new Error(
      `Unexpected fake Codex RPC: ${requests.map((request) => request.method).join(", ")}`,
    );
  });
}

function service(
  executor: FakeExecutor,
  options: {
    codex?: CodexReadClient;
    settings?: unknown;
    claudeFullModelIds?: readonly string[];
  } = {},
) {
  return createProviderAdmin({
    executor,
    codex: options.codex ?? noCodexCalls(),
    config: new FakeConfig(options.settings),
    claudeFullModelIds: options.claudeFullModelIds,
  });
}

function codexDoctorFixture(options: {
  overall?: string;
  current?: string;
  configuredModel?: string;
  latest?: string;
  latestStatus?: string;
} = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    overallStatus: options.overall ?? "warning",
    codexVersion: options.current ?? "0.144.1",
    checks: {
      "config.load": {
        id: "config.load",
        category: "config",
        status: "ok",
        summary: "config loaded",
        details: {
          model: options.configuredModel ?? "gpt-5.5",
        },
        remediation: null,
      },
      "updates.status": {
        id: "updates.status",
        category: "updates",
        status: "ok",
        summary: "update configuration is locally consistent",
        details: {
          "latest version": options.latest ?? "0.144.1",
          "latest version status":
            options.latestStatus ?? "current version is not older",
        },
        remediation: null,
      },
      "state.rollout_db_parity": {
        id: "state.rollout_db_parity",
        category: "threads",
        status: options.overall === "fail" ? "fail" : "warning",
        summary: "rollout inventory differs",
        remediation: "Check session files.",
      },
    },
  });
}

describe("provider status", () => {
  it("normalizes current Cursor JSON without exposing token material", async () => {
    const executor = new FakeExecutor()
      .set("cursor", "version", output("2026.07.09-a3815c0\n"))
      .set(
        "cursor",
        "authStatus",
        output(`informational preface
{
  "status": "authenticated",
  "isAuthenticated": true,
  "hasAccessToken": true,
  "hasRefreshToken": true,
  "userInfo": {
    "email": "founder@example.com",
    "userId": 1533,
    "firstName": "Ada",
    "lastName": "Lovelace",
    "teamId": 1195
  }
}`),
      )
      .set(
        "cursor",
        "about",
        output(
          JSON.stringify({
            cliVersion: "2026.07.09-a3815c0",
            model: "Auto",
            subscriptionTier: "Team",
            userEmail: "founder@example.com",
          }),
        ),
      );

    const status = await service(executor).providerStatus("cursor");

    expect(status).toMatchObject({
      provider: "cursor",
      installed: true,
      version: "2026.07.09-a3815c0",
      binaryPath: "/fake/bin/cursor-agent",
      configuredModel: "auto",
      defaultModel: "auto",
      auth: {
        state: "authenticated",
        account: {
          email: "founder@example.com",
          id: "1533",
          name: "Ada Lovelace",
          organizationId: "1195",
          plan: "Team",
        },
      },
      capabilities: {
        dynamicModelDiscovery: true,
        nativeDoctor: false,
      },
    });
    expect(JSON.stringify(status)).not.toContain("hasAccessToken");
    expect(executor.calls.map((call) => call.operation).sort()).toEqual([
      "about",
      "authStatus",
      "version",
    ]);
  });

  it("combines Codex doctor, login, account, and dynamic model data", async () => {
    const executor = new FakeExecutor()
      .set("codex", "version", output("codex-cli 0.144.1\n"))
      .set("codex", "authStatus", output("Logged in using ChatGPT\n"))
      .set(
        "codex",
        "doctor",
        output(codexDoctorFixture(), { exitCode: 1 }),
      );
    const codex = new FakeCodexClient((requests) =>
      requests.map((request) => {
        if (request.method === "account/read") {
          return {
            account: {
              type: "chatgpt",
              email: "ada@example.com",
              planType: "pro",
            },
            requiresOpenaiAuth: true,
          };
        }
        if (request.method === "model/list") {
          return {
            data: [
              {
                id: "gpt-5.6-sol",
                displayName: "GPT-5.6-Sol",
                isDefault: true,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "high" },
                ],
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }),
    );

    const status = await service(executor, { codex }).providerStatus("codex");

    expect(status).toMatchObject({
      provider: "codex",
      version: "0.144.1",
      configuredModel: "gpt-5.5",
      defaultModel: "gpt-5.6-sol",
      defaultModelSource: "provider",
      auth: {
        state: "authenticated",
        account: {
          email: "ada@example.com",
          plan: "pro",
          authMethod: "chatgpt",
        },
      },
      capabilities: {
        dynamicModelDiscovery: true,
        readOnlyUpdateCheck: true,
      },
    });
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]?.map((request) => request.method)).toEqual([
      "account/read",
      "model/list",
    ]);
  });

  it("reads Claude auth and a validated configured model", async () => {
    const executor = new FakeExecutor()
      .set("claude", "version", output("2.1.207 (Claude Code)\n"))
      .set(
        "claude",
        "authStatus",
        output(`notice
${JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  email: "ada@example.com",
  orgId: "org-1",
  orgName: "Example Org",
  subscriptionType: "max",
})}`),
      );

    const status = await service(executor, {
      settings: { model: "claude-sonnet-5-20260701" },
    }).providerStatus("claude");

    expect(status).toMatchObject({
      provider: "claude",
      version: "2.1.207",
      configuredModel: "claude-sonnet-5-20260701",
      defaultModel: "claude-sonnet-5-20260701",
      defaultModelSource: "configured",
      auth: {
        state: "authenticated",
        account: {
          email: "ada@example.com",
          organizationId: "org-1",
          organizationName: "Example Org",
          plan: "max",
          authMethod: "claude.ai",
        },
      },
    });
  });

  it("normalizes Grok authentication and its dynamic default model", async () => {
    const executor = new FakeExecutor()
      .set("grok", "version", output("grok 0.2.111 (94172f2aa4e5)\n"))
      .set(
        "grok",
        "authStatus",
        output(`You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
`),
      );

    const status = await service(executor).providerStatus("grok");

    expect(status).toMatchObject({
      provider: "grok",
      installed: true,
      version: "0.2.111",
      configuredModel: null,
      defaultModel: "grok-4.5",
      defaultModelSource: "provider",
      auth: {
        state: "authenticated",
        account: { authMethod: "grok.com" },
      },
      capabilities: {
        dynamicModelDiscovery: true,
        nativeDoctor: true,
        readOnlyUpdateCheck: true,
      },
    });
  });

  it("normalizes Antigravity authentication and its dynamic default model", async () => {
    const executor = new FakeExecutor()
      .set("antigravity", "version", output("1.1.5\n"))
      .set(
        "antigravity",
        "authStatus",
        output(`gemini-3.6-flash-high
gemini-3.1-pro-high
claude-opus-4-6-thinking
`),
      );

    const status = await service(executor).providerStatus("antigravity");

    expect(status).toMatchObject({
      provider: "antigravity",
      installed: true,
      version: "1.1.5",
      configuredModel: null,
      defaultModel: "gemini-3.6-flash-high",
      defaultModelSource: "provider",
      auth: {
        state: "authenticated",
        account: { authMethod: "google-oauth" },
      },
      capabilities: {
        dynamicModelDiscovery: true,
        nativeDoctor: false,
        readOnlyUpdateCheck: false,
      },
    });
  });

  it("reports an absent CLI without running any provider command", async () => {
    const executor = new FakeExecutor();
    executor.paths.claude = null;

    const status = await service(executor).providerStatus("claude");

    expect(status).toMatchObject({
      provider: "claude",
      installed: false,
      version: null,
      binaryPath: null,
      auth: { state: "unknown" },
    });
    expect(executor.calls).toEqual([]);
  });
});

describe("model catalogs", () => {
  it("parses current Cursor text, flags the default, and rejects option-shaped IDs", async () => {
    const executor = new FakeExecutor().set(
      "cursor",
      "models",
      output(`Available models

auto - Auto (current, default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
--dangerous - Must not become an argument
not a model row

Tip: use --model <id>
`),
    );

    const models = await service(executor).listProviderModels("cursor");

    expect(models).toEqual([
      {
        id: "auto",
        displayName: "Auto",
        isDefault: true,
        metadata: { current: true, source: "cursor-cli" },
      },
      {
        id: "gpt-5.6-sol-high",
        displayName: "GPT-5.6 Sol 1M High",
        isDefault: false,
        metadata: { current: false, source: "cursor-cli" },
      },
    ]);
  });

  it("parses Grok's model catalog and reasoning tiers", async () => {
    const executor = new FakeExecutor().set(
      "grok",
      "models",
      output(`You are logged in with grok.com.

Available models:
  * grok-4.5 (default)
  * grok-build
`),
    );

    const models = await service(executor).listProviderModels("grok");

    expect(models.map((model) => model.id)).toEqual(["grok-4.5", "grok-build"]);
    expect(models[0]).toMatchObject({
      isDefault: true,
      reasoningEfforts: ["low", "medium", "high"],
      metadata: { source: "grok-cli" },
    });
  });

  it("parses Antigravity's heterogeneous model catalog", async () => {
    const executor = new FakeExecutor().set(
      "antigravity",
      "models",
      output(`gemini-3.6-flash-high
gemini-3.1-pro-high
claude-sonnet-4-6
gpt-oss-120b-medium
`),
    );

    const models = await service(executor).listProviderModels("antigravity");

    expect(models.map((model) => model.id)).toEqual([
      "gemini-3.6-flash-high",
      "gemini-3.1-pro-high",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium",
    ]);
    expect(models[0]).toMatchObject({
      isDefault: true,
      metadata: { source: "antigravity-cli" },
    });
  });

  it("paginates Codex's read-only model API and preserves safe capabilities", async () => {
    const executor = new FakeExecutor();
    const codex = new FakeCodexClient((requests, call) => {
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("model/list");
      if (call === 1) {
        expect(requests[0]?.params).toEqual({});
        return [
          {
            data: [
              {
                id: "gpt-5.6-sol",
                displayName: "GPT-5.6-Sol",
                isDefault: true,
                description: "Frontier coding model.",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "max" },
                ],
                inputModalities: ["text", "image"],
                additionalSpeedTiers: ["fast"],
              },
              { id: "--unsafe", displayName: "Unsafe" },
              { id: "hidden", displayName: "Hidden", hidden: true },
            ],
            nextCursor: "page-2",
          },
        ];
      }
      expect(requests[0]?.params).toEqual({ cursor: "page-2" });
      return [
        {
          data: [{ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" }],
          nextCursor: null,
        },
      ];
    });

    const models = await service(executor, { codex }).listProviderModels("codex");

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(models[0]).toMatchObject({
      isDefault: true,
      reasoningEfforts: ["low", "max"],
      metadata: {
        description: "Frontier coding model.",
        inputModalities: ["text", "image"],
        additionalSpeedTiers: ["fast"],
      },
    });
    expect(codex.calls).toHaveLength(2);
  });

  it("returns conservative Claude aliases and validated full IDs only", async () => {
    const executor = new FakeExecutor();
    const models = await service(executor, {
      settings: { model: "claude-sonnet-5-20260701" },
      claudeFullModelIds: ["claude-opus-4-8-20260615"],
    }).listProviderModels("claude");

    expect(models.slice(0, 3).map((model) => model.id)).toEqual([
      "fable",
      "opus",
      "sonnet",
    ]);
    expect(models.map((model) => model.id)).toContain("claude-fable-5");
    expect(models.map((model) => model.id)).toContain(
      "claude-sonnet-5-20260701",
    );
    expect(
      models.find((model) => model.id === "claude-sonnet-5-20260701"),
    ).toMatchObject({ isDefault: true, metadata: { source: "claude-settings" } });
    expect(isSafeClaudeModelId("claude-opus-4-8-20260615")).toBe(true);
    expect(isSafeClaudeModelId("claude-opus-5")).toBe(true);
    expect(isSafeClaudeModelId("--model")).toBe(false);
    expect(isSafeClaudeModelId("claude-opus;rm")).toBe(false);
  });

  it("plans only safe symmetric pre-execution Claude fallbacks", () => {
    expect(isClaudeFableModel("fable")).toBe(true);
    expect(isClaudeFableModel("claude-fable-5")).toBe(true);
    expect(isClaudeFableModel("claude-opus-5")).toBe(false);
    expect(isClaudeOpus5Model("opus")).toBe(true);
    expect(isClaudeOpus5Model("claude-opus-5")).toBe(true);
    expect(
      isClaudeUsageOrAvailabilityError(
        "ActionRequiredError: Model Blocked Please ask your admin to enable access to Fable 5.",
      ),
    ).toBe(true);
    expect(
      isClaudeUsageOrAvailabilityError("Weekly usage limit exceeded."),
    ).toBe(true);
    expect(
      isClaudeUsageOrAvailabilityError("Authentication failed."),
    ).toBe(false);
    for (const message of [
      "Network connection failed.",
      "Request timed out.",
      "Operation cancelled.",
    ]) {
      expect(isClaudeUsageOrAvailabilityError(message)).toBe(false);
    }
    const unobserved = {
      sawAssistantText: false,
      sawToolUse: false,
      sawReturnedResult: false,
      worktreeUnchanged: true,
    };
    expect(
      planClaudeFallback(
        CLAUDE_OPUS_5_MODEL,
        "Opus capacity overloaded.",
        unobserved,
      ),
    ).toEqual({
      model: CLAUDE_FABLE_5_MODEL,
      effort: CLAUDE_MAX_EFFORT,
      reason: "opus_usage_or_availability",
    });
    expect(
      planClaudeFallback(
        CLAUDE_FABLE_5_MODEL,
        "Fable credits exhausted.",
        unobserved,
      ),
    ).toEqual({
      model: CLAUDE_OPUS_5_MODEL,
      effort: CLAUDE_MAX_EFFORT,
      reason: "fable_usage_or_availability",
    });
    for (const observation of [
      { ...unobserved, sawAssistantText: true },
      { ...unobserved, sawToolUse: true },
      { ...unobserved, sawReturnedResult: true },
      { ...unobserved, worktreeUnchanged: false },
    ]) {
      expect(
        planClaudeFallback(
          CLAUDE_OPUS_5_MODEL,
          "Opus capacity overloaded.",
          observation,
        ),
      ).toBeUndefined();
    }
    expect(CLAUDE_OPUS_5_FALLBACK_MODEL).toBe("claude-opus-5");
    expect(CLAUDE_OPUS_5_FALLBACK_EFFORT).toBe("max");
  });

  it("rejects unsafe configured catalog extensions at construction", () => {
    const executor = new FakeExecutor();
    expect(() =>
      service(executor, { claudeFullModelIds: ["--dangerously-skip-permissions"] }),
    ).toThrow(/Unsafe Claude full model ID/);
  });
});

describe("provider usage", () => {
  it("normalizes Codex rate limits and explicitly marks unsupported fields", async () => {
    const executor = new FakeExecutor();
    const codex = new FakeCodexClient(() => [
      {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: 1_784_495_645,
          },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            limitName: null,
            planType: "pro",
            rateLimitReachedType: null,
            primary: {
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: 1_784_495_645,
            },
            secondary: {
              usedPercent: 80,
              windowDurationMins: 60,
              resetsAt: 1_784_400_000,
            },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: "12.50",
            },
          },
        },
      },
    ]);

    const usage = await service(executor, { codex }).providerUsage("codex");

    expect(usage.rateLimits).toMatchObject({
      status: "available",
      value: [
        {
          id: "codex",
          plan: "pro",
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: "12.50",
          },
          windows: [
            {
              scope: "primary",
              usedPercent: 25,
              remainingPercent: 75,
              windowDurationSeconds: 18_000,
              resetsAt: new Date(1_784_495_645_000).toISOString(),
            },
            {
              scope: "secondary",
              usedPercent: 80,
              remainingPercent: 20,
              windowDurationSeconds: 3_600,
            },
          ],
        },
      ],
    });
    expect(usage.cost).toMatchObject({
      status: "unsupported",
      value: null,
    });
    expect(usage.session).toMatchObject({
      status: "unsupported",
      value: null,
    });
    expect(codex.calls[0]?.[0]?.method).toBe("account/rateLimits/read");
  });

  it.each(["cursor", "claude", "grok", "antigravity"] as const)(
    "returns explicit unsupported fields for %s without probing commands",
    async (provider) => {
      const executor = new FakeExecutor();
      const usage = await service(executor).providerUsage(provider);

      expect(usage.rateLimits.status).toBe("unsupported");
      expect(usage.cost.status).toBe("unsupported");
      expect(usage.session.status).toBe("unsupported");
      expect(executor.calls).toEqual([]);
      expect(executor.locateCalls).toEqual([]);
    },
  );

  it("marks a failed supported Codex query unavailable rather than unsupported", async () => {
    const executor = new FakeExecutor();
    const codex = new FakeCodexClient(() => {
      throw new Error("api_key=sk-super-secret-value");
    });

    const usage = await service(executor, { codex }).providerUsage("codex");

    expect(usage.rateLimits.status).toBe("unavailable");
    expect(usage.rateLimits).not.toEqual(
      expect.objectContaining({ reason: expect.stringContaining("sk-super-secret-value") }),
    );
    expect(usage.cost.status).toBe("unsupported");
  });
});

describe("doctor and update checks", () => {
  it("parses a nonzero Codex doctor report as health data", async () => {
    const executor = new FakeExecutor().set(
      "codex",
      "doctor",
      output(codexDoctorFixture({ overall: "fail" }), { exitCode: 1 }),
    );

    const result = await service(executor).providerDoctor("codex");

    expect(result).toMatchObject({
      provider: "codex",
      health: "error",
      native: true,
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "state.rollout_db_parity",
          health: "error",
          remediation: "Check session files.",
        }),
      ]),
    );
  });

  it("parses Claude's current text doctor output", async () => {
    const executor = new FakeExecutor().set(
      "claude",
      "doctor",
      output(`Claude Code doctor

Running: native (2.1.207)
Platform: darwin-arm64
Search: OK (bundled)
Auto-updates: enabled
Auto-update channel: latest
Last update attempt: none recorded

No installation issues found.
`),
    );

    const result = await service(executor).providerDoctor("claude");

    expect(result).toMatchObject({
      health: "ok",
      native: true,
      summary: "Claude Code reports no installation issues.",
    });
    expect(result.checks.map((check) => check.id)).toContain("auto-updates");
  });

  it("parses Grok's native JSON doctor findings", async () => {
    const executor = new FakeExecutor().set(
      "grok",
      "doctor",
      output(
        JSON.stringify({
          schemaVersion: 1,
          counts: { issues: 0, recommendations: 1, probeNotes: 0 },
          findings: [
            {
              id: "terminal.truecolor",
              disposition: "recommendation",
              message: "Truecolor is not enabled.",
              note: "Set COLORTERM=truecolor.",
              remediation: null,
            },
          ],
        }),
      ),
    );

    const result = await service(executor).providerDoctor("grok");

    expect(result).toMatchObject({
      provider: "grok",
      health: "warning",
      native: true,
      checks: [
        {
          id: "terminal.truecolor",
          category: "terminal",
          health: "warning",
          remediation: "Set COLORTERM=truecolor.",
        },
      ],
    });
  });

  it("uses Codex doctor metadata for a read-only update check", async () => {
    const executor = new FakeExecutor()
      .set("codex", "version", output("codex-cli 0.144.1"))
      .set(
        "codex",
        "doctor",
        output(
          codexDoctorFixture({
            current: "0.144.1",
            latest: "0.145.0",
            latestStatus: "current version is older",
          }),
          { exitCode: 1 },
        ),
      );

    const result = await service(executor).providerUpdateCheck("codex");

    expect(result).toEqual({
      provider: "codex",
      supported: true,
      currentVersion: "0.144.1",
      latestVersion: "0.145.0",
      updateAvailable: true,
      source: "codex doctor --json",
      reason: null,
    });
    expect(executor.calls.map((call) => call.operation)).toEqual([
      "version",
      "doctor",
    ]);
    expect(executor.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("uses Grok's dedicated read-only JSON update check", async () => {
    const executor = new FakeExecutor()
      .set("grok", "version", output("grok 0.2.111"))
      .set(
        "grok",
        "updateCheck",
        output(
          JSON.stringify({
            currentVersion: "0.2.111",
            latestVersion: "0.2.112",
            updateAvailable: true,
            channel: "stable",
            error: null,
          }),
        ),
      );

    const result = await service(executor).providerUpdateCheck("grok");

    expect(result).toEqual({
      provider: "grok",
      supported: true,
      currentVersion: "0.2.111",
      latestVersion: "0.2.112",
      updateAvailable: true,
      source: "grok update --check --json",
      reason: null,
    });
    expect(executor.calls.map((call) => call.operation)).toEqual([
      "version",
      "updateCheck",
    ]);
    expect(executor.calls.some((call) => call.operation === "update")).toBe(false);
  });

  it("never invokes Cursor's combined updater during a read-only check", async () => {
    const executor = new FakeExecutor().set(
      "cursor",
      "version",
      output("2026.07.09-a3815c0"),
    );

    const result = await service(executor).providerUpdateCheck("cursor");

    expect(result).toMatchObject({
      supported: false,
      currentVersion: "2026.07.09-a3815c0",
      latestVersion: null,
      updateAvailable: null,
    });
    expect(executor.calls).toEqual([
      { provider: "cursor", operation: "version" },
    ]);
  });

  it("never invokes Antigravity's combined updater during a read-only check", async () => {
    const executor = new FakeExecutor().set(
      "antigravity",
      "version",
      output("1.1.5"),
    );

    const result = await service(executor).providerUpdateCheck("antigravity");

    expect(result).toMatchObject({
      provider: "antigravity",
      supported: false,
      currentVersion: "1.1.5",
      latestVersion: null,
      updateAvailable: null,
    });
    expect(executor.calls).toEqual([
      { provider: "antigravity", operation: "version" },
    ]);
  });

  it("builds a read-only synthetic Antigravity doctor", async () => {
    const executor = new FakeExecutor()
      .set("antigravity", "version", output("1.1.5"))
      .set(
        "antigravity",
        "authStatus",
        output("gemini-3.6-flash-high\ngemini-3.1-pro-high\n"),
      );

    const result = await service(executor).providerDoctor("antigravity");

    expect(result).toMatchObject({
      provider: "antigravity",
      native: false,
      health: "ok",
    });
    expect(result.checks.map((check) => check.id)).toEqual([
      "installation",
      "authentication",
      "models",
    ]);
  });

  it("builds a read-only synthetic Cursor doctor", async () => {
    const executor = new FakeExecutor()
      .set("cursor", "version", output("2026.07.09-a3815c0"))
      .set(
        "cursor",
        "authStatus",
        output(JSON.stringify({ status: "authenticated", isAuthenticated: true })),
      )
      .set(
        "cursor",
        "about",
        output(JSON.stringify({ cliVersion: "2026.07.09-a3815c0", model: "Auto" })),
      )
      .set("cursor", "models", output("auto - Auto (current, default)"));

    const result = await service(executor).providerDoctor("cursor");

    expect(result).toMatchObject({
      provider: "cursor",
      native: false,
      health: "ok",
    });
    expect(executor.calls.some((call) => call.operation === "update")).toBe(false);
    expect(executor.calls.some((call) => call.operation === "logout")).toBe(false);
  });
});

describe("confirmed mutations", () => {
  it("rejects update before any command unless the exact phrase matches", async () => {
    const executor = new FakeExecutor();
    const admin = service(executor);

    await expect(
      admin.providerUpdate("codex", { confirmation: "update codex" }),
    ).rejects.toBeInstanceOf(ProviderMutationConfirmationError);
    await expect(
      admin.providerUpdate("codex", {
        confirmation: `${PROVIDER_UPDATE_CONFIRMATIONS.codex} `,
      }),
    ).rejects.toBeInstanceOf(ProviderMutationConfirmationError);
    expect(executor.calls).toEqual([]);
    expect(executor.locateCalls).toEqual([]);
  });

  it("runs only the allowlisted updater after exact confirmation", async () => {
    const executor = new FakeExecutor()
      .set(
        "claude",
        "version",
        output("2.1.207 (Claude Code)"),
        output("2.1.208 (Claude Code)"),
      )
      .set(
        "claude",
        "update",
        output("Updated successfully. api_key=sk-abcdefghijklmnop"),
      );

    const result = await service(executor).providerUpdate("claude", {
      confirmation: PROVIDER_UPDATE_CONFIRMATIONS.claude,
    });

    expect(result).toMatchObject({
      operation: "update",
      beforeVersion: "2.1.207",
      afterVersion: "2.1.208",
      changed: true,
    });
    expect(result.summary).not.toContain("sk-abcdefghijklmnop");
    expect(result.summary).toContain("[REDACTED]");
    expect(executor.calls).toEqual([
      { provider: "claude", operation: "version" },
      { provider: "claude", operation: "update" },
      { provider: "claude", operation: "version" },
    ]);
  });

  it("rejects logout before any command unless the exact phrase matches", async () => {
    const executor = new FakeExecutor();
    const admin = service(executor);

    await expect(
      admin.providerLogout("cursor", { confirmation: "yes" }),
    ).rejects.toMatchObject({
      requiredConfirmation: PROVIDER_LOGOUT_CONFIRMATIONS.cursor,
    });
    expect(executor.calls).toEqual([]);
  });

  it("rejects unsupported Antigravity logout without invoking the CLI", async () => {
    const executor = new FakeExecutor();

    await expect(
      service(executor).providerLogout("antigravity", {
        confirmation: PROVIDER_LOGOUT_CONFIRMATIONS.antigravity,
      }),
    ).rejects.toThrow(/does not expose a logout command/);
    expect(executor.calls).toEqual([]);
  });

  it("rejects unverified Antigravity update without invoking the CLI", async () => {
    const executor = new FakeExecutor();

    await expect(
      service(executor).providerUpdate("antigravity", {
        confirmation: PROVIDER_UPDATE_CONFIRMATIONS.antigravity,
      }),
    ).rejects.toThrow(/has not been verified/);
    expect(executor.calls).toEqual([]);
  });

  it("runs only the allowlisted logout after exact confirmation", async () => {
    const executor = new FakeExecutor().set(
      "cursor",
      "logout",
      output("Logged out."),
    );

    const result = await service(executor).providerLogout("cursor", {
      confirmation: PROVIDER_LOGOUT_CONFIRMATIONS.cursor,
    });

    expect(result).toEqual({
      provider: "cursor",
      operation: "logout",
      summary: "Logged out.",
    });
    expect(executor.calls).toEqual([
      { provider: "cursor", operation: "logout" },
    ]);
  });
});
