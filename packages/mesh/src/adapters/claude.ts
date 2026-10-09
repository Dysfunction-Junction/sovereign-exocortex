import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { startLineProcess } from "../process.js";
import {
  buildSafeEnv,
  getGitBinary,
  resolveTrustedProviderExecutable,
} from "../security.js";
import { buildClaudeMcpProfile } from "../mcp-profiles.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderModel,
  ProviderResult,
  ProviderRunHooks,
  ProviderRunRequest,
} from "../types.js";

const SAFE_SETTINGS = JSON.stringify({
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    // Needed for npm install/test and research MCP HTTP (Context7 / Perplexity).
    network: {
      allowUnixSockets: [
        "/var/run/mDNSResponder",
        "/private/var/run/mDNSResponder",
      ],
    },
  },
  permissions: {
    allow: [
      // Build / test
      "Bash(npm *)",
      "Bash(node *)",
      "Bash(npx *)",
      "Bash(java *)",
      "Bash(bash *)",
      "Bash(sh *)",
      // Data / log analysis (Homebrew CLIs under /opt/homebrew/bin)
      "Bash(jq *)",
      "Bash(rg *)",
      "Bash(yq *)",
      "Bash(curl *)",
      "Bash(python3 *)",
      "Bash(python *)",
      "Bash(sqlite3 *)",
      "Bash(gh *)",
      "Bash(git *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(sort *)",
      "Bash(uniq *)",
      "Bash(wc *)",
      "Bash(cut *)",
      "Bash(tr *)",
      "Bash(sed *)",
      "Bash(awk *)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(find *)",
      "Bash(xargs *)",
    ],
  },
});

const execFileAsync = promisify(execFile);
const MAX_FINGERPRINT_BYTES = 32 * 1024 * 1024;

export const CLAUDE_OPUS_5_MODEL = "claude-opus-5";
export const CLAUDE_FABLE_5_MODEL = "claude-fable-5";
export const CLAUDE_MAX_EFFORT = "max";

// Retained as compatibility aliases for callers that imported the old one-way names.
export const CLAUDE_FABLE_MODEL = CLAUDE_FABLE_5_MODEL;
export const CLAUDE_OPUS_5_FALLBACK_MODEL = CLAUDE_OPUS_5_MODEL;
export const CLAUDE_OPUS_5_FALLBACK_EFFORT = CLAUDE_MAX_EFFORT;

export function isClaudeFableModel(model: string | undefined): boolean {
  return model === "fable" || Boolean(model?.startsWith("claude-fable-5"));
}

export function isClaudeOpus5Model(model: string | undefined): boolean {
  return model === "opus" || Boolean(model?.startsWith("claude-opus-5"));
}

export function isClaudeUsageOrAvailabilityError(message: string): boolean {
  if (
    /(?:auth(?:entication|orization)?|unauthenticated|permission denied|network|connection|econn|dns|socket|timed?\s*out|timeout|deadline|cancel(?:led|ed)?|abort(?:ed)?)/iu.test(
      message,
    )
  ) {
    return false;
  }
  return /(?:actionrequirederror:\s*model blocked|credits?\s+(?:exhausted|depleted|unavailable)|insufficient credits?|out of credits?|credit balance[^.\n]*(?:low|empty)|(?:quota|usage|weekly limit|rate.?limit|limit exceeded)|model[^.\n]*(?:blocked|unavailable)|(?:capacity|overloaded))/iu.test(
    message,
  );
}

export interface ClaudeAttemptObservation {
  sawAssistantText: boolean;
  sawToolUse: boolean;
  sawReturnedResult: boolean;
  worktreeUnchanged: boolean;
}

export interface ClaudeFallbackPlan {
  model: typeof CLAUDE_OPUS_5_MODEL | typeof CLAUDE_FABLE_5_MODEL;
  effort: typeof CLAUDE_MAX_EFFORT;
  reason: "opus_usage_or_availability" | "fable_usage_or_availability";
}

export function planClaudeFallback(
  model: string | undefined,
  error: string,
  observation: ClaudeAttemptObservation,
): ClaudeFallbackPlan | undefined {
  if (
    !isClaudeUsageOrAvailabilityError(error) ||
    observation.sawAssistantText ||
    observation.sawToolUse ||
    observation.sawReturnedResult ||
    !observation.worktreeUnchanged
  ) {
    return undefined;
  }
  if (isClaudeOpus5Model(model)) {
    return {
      model: CLAUDE_FABLE_5_MODEL,
      effort: CLAUDE_MAX_EFFORT,
      reason: "opus_usage_or_availability",
    };
  }
  if (isClaudeFableModel(model)) {
    return {
      model: CLAUDE_OPUS_5_MODEL,
      effort: CLAUDE_MAX_EFFORT,
      reason: "fable_usage_or_availability",
    };
  }
  return undefined;
}

export class ClaudeModelRoutingError extends Error {
  readonly retryable = false;

  constructor(
    message: string,
    readonly code:
      | "claude_fallback_blocked_after_effect"
      | "claude_model_attempt_failed"
      | "claude_model_attempts_exhausted",
    readonly attemptedModels: string[],
    readonly actualModel: string | null,
    readonly actualEffort: string | null,
    readonly fallbackCount: number,
    readonly fallbackReason: string | null,
    readonly observableEffects: string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeModelRoutingError";
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(getGitBinary(), args, {
    cwd,
    env: buildSafeEnv({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    }),
    encoding: "utf8",
    maxBuffer: MAX_FINGERPRINT_BYTES,
  });
  return stdout;
}

export async function fingerprintClaudeWorktree(
  cwd: string,
): Promise<string | null> {
  try {
    const hardened = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
    ];
    const root = (
      await gitOutput(cwd, ["rev-parse", "--show-toplevel"])
    ).trim();
    const [status, diff] = await Promise.all([
      gitOutput(root, [
        ...hardened,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      gitOutput(root, [
        ...hardened,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
      ]),
    ]);
    const hash = createHash("sha256")
      .update(status)
      .update("\0")
      .update(diff);
    for (const entry of status.split("\0")) {
      if (!entry.startsWith("?? ")) continue;
      const relativePath = entry.slice(3);
      const path = join(root, relativePath);
      const info = await lstat(path);
      hash.update("\0").update(relativePath).update("\0");
      if (info.isSymbolicLink()) {
        hash.update("symlink\0").update(await readlink(path));
      } else if (info.isFile()) {
        hash.update("file\0");
        for await (const chunk of createReadStream(path)) {
          hash.update(chunk);
        }
      } else {
        hash.update(`${info.mode}:${info.size}:${info.mtimeMs}`);
      }
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  capabilities(): ProviderCapabilities {
    return {
      provider: this.provider,
      dynamicModelDiscovery: false,
      resume: true,
      fork: true,
      nativeSessionSearch: false,
      nativeCancellation: false,
      notes: [
        "Full model IDs and current aliases are accepted, but Claude Code has no machine-readable model catalog command.",
        "Cancellation uses process-group signals.",
        "Session search covers mesh-created sessions; Claude's interactive picker is not machine-readable.",
      ],
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    return [];
  }

  async run(request: ProviderRunRequest, hooks: ProviderRunHooks): Promise<ProviderResult> {
    const readOnly = request.mode !== "implement";
    const binary = await resolveTrustedProviderExecutable("claude");
    const mcpProfile = buildClaudeMcpProfile(request.mcpProfile, {
      coordination: request.coordination,
      peer: request.peer,
    });
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-chrome",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--mcp-config",
      mcpProfile.mcpConfigJson,
      "--settings",
      SAFE_SETTINGS,
      "--permission-mode",
      readOnly
        ? request.mcpProfile === "none" &&
          !request.coordination &&
          !request.peer
          ? "plan"
          : "auto"
        : "acceptEdits",
      "--tools",
      // Read-only modes keep Edit/Write off, but Bash is required so plan/review/
      // tester waves can run `npm test` / typecheck after we seed node_modules.
      readOnly ? "Read,Glob,Grep,Bash" : "Read,Edit,Write,Glob,Grep,Bash",
    ];
    if (
      request.mcpProfile === "none" &&
      !request.coordination &&
      !request.peer
    ) {
      args.push("--safe-mode");
    } else {
      args.push("--setting-sources", "");
    }
    const allowedTools = [
      ...(!readOnly ? ["Read", "Edit", "Write", "Glob", "Grep", "Bash"] : []),
      ...mcpProfile.allowedTools,
    ];
    if (allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
    if (mcpProfile.disallowedTools.length) {
      args.push("--disallowedTools", mcpProfile.disallowedTools.join(","));
    }
    const requestedModel = request.model ?? null;
    const requestedEffort = request.effort ?? null;
    const selectedModel = request.model ?? CLAUDE_OPUS_5_MODEL;
    const selectedEffort =
      isClaudeOpus5Model(selectedModel) || isClaudeFableModel(selectedModel)
        ? CLAUDE_MAX_EFFORT
        : request.effort;
    const sessionArgs = request.sessionId
      ? [
          "--resume",
          request.sessionId,
          ...(request.forkSession ? ["--fork-session"] : []),
        ]
      : ["--session-id", request.taskId];

    const attempt = async (
      model: string | undefined,
      effort: string | undefined,
      appendEvents = false,
    ) => {
      const attemptArgs = [
        ...args,
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
        ...sessionArgs,
      ];
      let sessionId = request.sessionId ?? request.taskId;
      let output = "";
      let usage: unknown;
      let resultError = "";
      let sawAssistantText = false;
      let sawToolUse = false;
      let sawReturnedResult = false;
      hooks.onSession(sessionId);
      const running = startLineProcess({
        command: binary,
        args: attemptArgs,
        cwd: request.cwd,
        env: buildSafeEnv({ MCP_TIMEOUT: "60000" }),
        stdin: request.prompt,
        timeoutMs: request.timeoutMs,
        eventsPath: join(request.taskDir, "events.ndjson"),
        appendEvents,
        onStdoutLine(line) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return;
          }
          hooks.onEvent?.(event);
          if (
            typeof event.session_id === "string" &&
            event.session_id !== sessionId
          ) {
            sessionId = event.session_id;
            hooks.onSession(sessionId);
          }
          const eventType =
            typeof event.type === "string" ? event.type : "";
          if (/tool/iu.test(eventType)) sawToolUse = true;
          if (event.type === "result") {
            sawReturnedResult = true;
            if (typeof event.result === "string") output = event.result;
            usage = event.usage;
            if (event.is_error === true) {
              resultError =
                typeof event.result === "string"
                  ? event.result
                  : "Claude returned an error result.";
            }
          } else if (event.type === "assistant") {
            const message = event.message as
              | {
                  content?: Array<{
                    type?: string;
                    text?: string;
                  }>;
                }
              | undefined;
            if (
              message?.content?.some((item) =>
                /tool/iu.test(item.type ?? ""),
              )
            ) {
              sawToolUse = true;
            }
            const text = message?.content
              ?.filter(
                (item) =>
                  item.type === "text" &&
                  typeof item.text === "string",
              )
              .map((item) => item.text)
              .join("");
            if (text) {
              sawAssistantText = true;
              output = text;
            }
          }
        },
      });
      hooks.onStarted({
        pid: running.pid,
        cancel: running.cancel,
      });
      const outcome = await running.completion;
      const error =
        outcome.code !== 0 || resultError
          ? `Claude Code failed (code=${String(outcome.code)}, signal=${String(
              outcome.signal,
            )}): ${resultError || outcome.stderr || "no result"}`
          : "";
      return {
        output,
        sessionId,
        usage,
        error,
        sawAssistantText,
        sawToolUse,
        sawReturnedResult,
      };
    };

    const attemptedModels = [selectedModel];
    const worktreeBefore = await fingerprintClaudeWorktree(request.cwd);
    const primary = await attempt(selectedModel, selectedEffort);
    if (!primary.error) {
      return {
        output: primary.output,
        sessionId: primary.sessionId,
        usage: primary.usage,
        metadata: {
          requestedModel,
          requestedEffort,
          attemptedModels,
          actualModel: selectedModel,
          actualEffort: selectedEffort ?? null,
          fallback: false,
          fallbackCount: 0,
          fallbackReason: null,
        },
      };
    }
    const worktreeAfterPrimary = await fingerprintClaudeWorktree(request.cwd);
    const worktreeUnchanged =
      worktreeBefore !== null &&
      worktreeAfterPrimary !== null &&
      worktreeBefore === worktreeAfterPrimary;
    const primaryEffects = [
      ...(primary.sawAssistantText ? ["assistant_text"] : []),
      ...(primary.sawToolUse ? ["tool_use"] : []),
      ...(primary.sawReturnedResult ? ["returned_result"] : []),
      ...(worktreeBefore !== null &&
      worktreeAfterPrimary !== null &&
      worktreeBefore !== worktreeAfterPrimary
        ? ["worktree_mutation"]
        : []),
    ];
    const fallbackPlan = planClaudeFallback(selectedModel, primary.error, {
      sawAssistantText: primary.sawAssistantText,
      sawToolUse: primary.sawToolUse,
      sawReturnedResult: primary.sawReturnedResult,
      worktreeUnchanged,
    });
    if (!fallbackPlan) {
      throw new ClaudeModelRoutingError(
        primary.error,
        primaryEffects.length
          ? "claude_fallback_blocked_after_effect"
          : "claude_model_attempt_failed",
        attemptedModels,
        primaryEffects.length ? selectedModel : null,
        primaryEffects.length ? (selectedEffort ?? null) : null,
        0,
        null,
        primaryEffects,
        { cause: new Error(primary.error) },
      );
    }

    attemptedModels.push(fallbackPlan.model);
    const fallback = await attempt(
      fallbackPlan.model,
      fallbackPlan.effort,
      true,
    );
    if (fallback.error) {
      const worktreeAfterFallback = await fingerprintClaudeWorktree(request.cwd);
      const fallbackEffects = [
        ...(fallback.sawAssistantText ? ["assistant_text"] : []),
        ...(fallback.sawToolUse ? ["tool_use"] : []),
        ...(fallback.sawReturnedResult ? ["returned_result"] : []),
        ...(worktreeAfterPrimary !== null &&
        worktreeAfterFallback !== null &&
        worktreeAfterPrimary !== worktreeAfterFallback
          ? ["worktree_mutation"]
          : []),
      ];
      throw new ClaudeModelRoutingError(
        fallback.error,
        fallbackEffects.length
          ? "claude_fallback_blocked_after_effect"
          : "claude_model_attempts_exhausted",
        attemptedModels,
        fallbackEffects.length ? fallbackPlan.model : null,
        fallbackEffects.length ? fallbackPlan.effort : null,
        1,
        fallbackPlan.reason,
        fallbackEffects,
        { cause: new Error(fallback.error) },
      );
    }
    return {
      output: fallback.output,
      sessionId: fallback.sessionId,
      usage: fallback.usage,
      metadata: {
        requestedModel,
        requestedEffort,
        attemptedModels,
        actualModel: fallbackPlan.model,
        actualEffort: fallbackPlan.effort,
        fallback: true,
        fallbackCount: 1,
        fallbackReason: fallbackPlan.reason,
      },
    };
  }
}
