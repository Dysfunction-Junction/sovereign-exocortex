import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { startLineProcess } from "../process.js";
import {
  buildSafeEnv,
  ensurePrivateDirectory,
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
const CONTROL_WORKSPACE = join(stateDirectory(), "cursor-control");
let controlWorkspacePromise: Promise<void> | undefined;

async function prepareControlWorkspace(): Promise<void> {
  if (controlWorkspacePromise) return controlWorkspacePromise;
  controlWorkspacePromise = (async () => {
    const cursorDir = join(CONTROL_WORKSPACE, ".cursor");
    await ensurePrivateDirectory(cursorDir);
    await writeFile(join(cursorDir, "mcp.json"), '{"mcpServers":{}}\n', {
      encoding: "utf8",
      mode: 0o600,
    });
    const globalConfigPath = join(homedir(), ".cursor", "mcp.json");
    let serverNames: string[] = [];
    try {
      const config = JSON.parse(await readFile(globalConfigPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      serverNames = Object.keys(config.mcpServers ?? {}).sort();
    } catch {
      // The empty project config remains the fail-closed baseline.
    }
    const fingerprint = createHash("sha256").update(serverNames.join("\n")).digest("hex");
    const markerPath = join(CONTROL_WORKSPACE, ".mcp-disabled-fingerprint");
    try {
      if ((await readFile(markerPath, "utf8")).trim() === fingerprint) return;
    } catch {
      // First setup or changed global fleet.
    }
    const cursorBinary = await resolveTrustedProviderExecutable("cursor-agent");
    for (const serverName of serverNames) {
      await execFileAsync(cursorBinary, ["mcp", "disable", serverName], {
        cwd: CONTROL_WORKSPACE,
        env: buildSafeEnv(),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
    }
    await writeFile(markerPath, `${fingerprint}\n`, { encoding: "utf8", mode: 0o600 });
  })().catch((error) => {
    controlWorkspacePromise = undefined;
    throw error;
  });
  return controlWorkspacePromise;
}

export class CursorAdapter implements ProviderAdapter {
  readonly provider = "cursor" as const;

  capabilities(): ProviderCapabilities {
    return {
      provider: this.provider,
      dynamicModelDiscovery: true,
      resume: true,
      fork: false,
      nativeSessionSearch: false,
      nativeCancellation: false,
      notes: [
        "Cancellation uses process-group signals.",
        "Session search covers mesh-created sessions; Cursor's interactive picker is not machine-readable.",
        "Tasks run from a disposable MCP-empty control workspace with the target added explicitly.",
      ],
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const binary = await resolveTrustedProviderExecutable("cursor-agent");
    const { stdout } = await execFileAsync(binary, ["models"], {
      env: buildSafeEnv(),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.match(/^(\S+)\s+-\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({
        id: match[1]!,
        displayName: match[2]!,
        isDefault: match[1] === "auto",
      }));
  }

  async run(request: ProviderRunRequest, hooks: ProviderRunHooks): Promise<ProviderResult> {
    await prepareControlWorkspace();
    const binary = await resolveTrustedProviderExecutable("cursor-agent");
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--sandbox",
      "enabled",
      "--trust",
      "--workspace",
      CONTROL_WORKSPACE,
      "--add-dir",
      request.cwd,
    ];
    if (request.mode === "implement") args.push("--force");
    else args.push("--mode", request.mode === "plan" ? "plan" : "ask");
    if (request.model) args.push("--model", request.model);
    if (request.sessionId) args.push("--resume", request.sessionId);

    let sessionId = request.sessionId ?? "";
    let output = "";
    let usage: unknown;
    const running = startLineProcess({
      command: binary,
      args,
      cwd: CONTROL_WORKSPACE,
      env: buildSafeEnv(),
      stdin: `Target project directory: ${request.cwd}\n\n${request.prompt}`,
      timeoutMs: request.timeoutMs,
      eventsPath: join(request.taskDir, "events.ndjson"),
      onStdoutLine(line) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        hooks.onEvent?.(event);
        if (typeof event.session_id === "string" && event.session_id !== sessionId) {
          sessionId = event.session_id;
          hooks.onSession(sessionId);
        }
        if (event.type === "result") {
          if (typeof event.result === "string") output = event.result;
          usage = event.usage;
        } else if (event.type === "assistant") {
          const message = event.message as
            | { content?: Array<{ type?: string; text?: string }> }
            | undefined;
          const text = message?.content
            ?.filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("");
          if (text) output = text;
        }
      },
    });
    hooks.onStarted({ pid: running.pid, cancel: running.cancel });
    const outcome = await running.completion;
    if (outcome.code !== 0 || !sessionId) {
      throw new Error(
        `Cursor Agent failed (code=${String(outcome.code)}, signal=${String(outcome.signal)}): ${outcome.stderr || "no result"}`,
      );
    }
    return { output, sessionId, usage };
  }
}
