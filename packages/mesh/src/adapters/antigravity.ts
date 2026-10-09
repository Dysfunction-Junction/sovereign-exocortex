import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildAntigravityMcpProfile,
  type AntigravityMcpProfileConfig,
  type AntigravityStdioMcpServerConfig,
} from "../mcp-profiles.js";
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

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_PROMPT_BYTES = 128 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CONVERSATION_PATTERN =
  /\b(?:Created conversation|Print mode: conversation=)\s*([0-9a-f-]{36})\b/gi;
export const ANTIGRAVITY_PROJECT_EXECUTABLE_CONFIGS = [
  ".agents/hooks.json",
  ".agents/mcp_config.json",
  ".agents/plugins",
  ".agents/plugins.json",
  ".agents/settings.json",
  ".gemini/hooks.json",
  ".gemini/mcp_config.json",
  ".gemini/plugins",
  ".gemini/plugins.json",
  ".gemini/settings.json",
] as const;

export interface AntigravityLineage {
  cwd: string;
  lineageId: string;
  writable: boolean;
}

interface PreparedAntigravityEnvironment {
  env: NodeJS.ProcessEnv;
  geminiDir: string;
  lineage: AntigravityLineage;
  logPath: string;
}

const providerRoot = () =>
  join(stateDirectory(), "provider-homes", "antigravity");

function lineageIndexDirectory(): string {
  return join(providerRoot(), "session-index");
}

function execFileClosed(
  command: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      command,
      args,
      options,
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolvePromise({ stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
    child.stdin?.end();
  });
}

function lineageRoot(lineageId: string): string {
  return join(providerRoot(), "lineages", lineageId);
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid Antigravity conversation ID: ${sessionId}`);
  }
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
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function readPrivateFile(path: string, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > maxBytes) {
      throw new Error(`Antigravity state is not a bounded private file: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readPrivateFilePrefix(
  path: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error(`Antigravity log is not a private regular file: ${path}`);
    }
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function indexPath(sessionId: string): string {
  assertSessionId(sessionId);
  return join(lineageIndexDirectory(), `${sessionId}.json`);
}

function parseLineage(value: string, sessionId: string): AntigravityLineage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Antigravity conversation ${sessionId} has corrupt mesh state.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Antigravity conversation ${sessionId} has corrupt mesh state.`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.cwd !== "string" ||
    typeof record.lineageId !== "string" ||
    typeof record.writable !== "boolean"
  ) {
    throw new Error(`Antigravity conversation ${sessionId} has corrupt mesh state.`);
  }
  assertSessionId(record.lineageId);
  return {
    cwd: record.cwd,
    lineageId: record.lineageId,
    writable: record.writable,
  };
}

async function resolveLineage(sessionId: string): Promise<AntigravityLineage> {
  await ensurePrivateDirectory(lineageIndexDirectory());
  try {
    return parseLineage(await readPrivateFile(indexPath(sessionId)), sessionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Antigravity conversation ${sessionId} is not in mesh lineage state.`,
      );
    }
    throw error;
  }
}

async function registerLineage(
  sessionId: string,
  lineage: AntigravityLineage,
): Promise<void> {
  assertSessionId(sessionId);
  assertSessionId(lineage.lineageId);
  await ensurePrivateDirectory(lineageIndexDirectory());
  const path = indexPath(sessionId);
  try {
    const existing = parseLineage(await readPrivateFile(path), sessionId);
    if (
      existing.cwd !== lineage.cwd ||
      existing.lineageId !== lineage.lineageId ||
      existing.writable !== lineage.writable
    ) {
      throw new Error(
        `Antigravity conversation ${sessionId} is mapped to another lineage.`,
      );
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writePrivateFile(path, `${JSON.stringify(lineage)}\n`);
}

export async function rejectAntigravityProjectExecutables(
  cwd: string,
): Promise<void> {
  for (const relative of ANTIGRAVITY_PROJECT_EXECUTABLE_CONFIGS) {
    try {
      await lstat(join(cwd, relative));
      throw new Error(
        `Antigravity delegated execution refuses project executable configuration: ${relative}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export function assertAntigravityResumeAllowed(
  lineage: AntigravityLineage,
  canonicalCwd: string,
  mode: ProviderRunRequest["mode"],
): void {
  if (lineage.cwd !== canonicalCwd) {
    throw new Error("Antigravity conversations cannot move between workspaces.");
  }
  if (mode === "implement" && !lineage.writable) {
    throw new Error(
      "Refusing to resume a read-only Antigravity conversation as implementation.",
    );
  }
}

function modelEffort(effort: string | undefined): string | undefined {
  return effort === "ultra" || effort === "xhigh" || effort === "max"
    ? "high"
    : effort;
}

function configuredByteLimit(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function buildAntigravityPrompt(request: ProviderRunRequest): string {
  const prompt = `Agent mesh task: ${request.taskId}
Target repository directory: ${request.cwd}
Operate only inside that target repository. Do not use the Antigravity scratch directory.

${request.prompt}`;
  const maxBytes = configuredByteLimit(
    "AGENT_MESH_MAX_ANTIGRAVITY_PROMPT_BYTES",
    DEFAULT_MAX_PROMPT_BYTES,
  );
  if (Buffer.byteLength(prompt) > maxBytes) {
    throw new Error(`Antigravity prompt exceeds the ${maxBytes}-byte argv limit.`);
  }
  return prompt;
}

function safeProjectName(lineageId: string): string {
  return `mesh-${lineageId.slice(0, 8)}`;
}

async function prepareEnvironment(
  request: ProviderRunRequest,
  profile: AntigravityMcpProfileConfig,
): Promise<PreparedAntigravityEnvironment> {
  await rejectAntigravityProjectExecutables(request.cwd);
  const canonicalCwd = await realpath(request.cwd);
  const lineage = request.sessionId
    ? await resolveLineage(request.sessionId)
    : {
        cwd: canonicalCwd,
        lineageId: request.taskId,
        writable: request.mode === "implement",
      };
  assertAntigravityResumeAllowed(lineage, canonicalCwd, request.mode);

  assertSessionId(lineage.lineageId);
  const root = lineageRoot(lineage.lineageId);
  const geminiDir = join(root, "gemini");
  const configDir = join(geminiDir, "config");
  const projectsDir = join(configDir, "projects");
  const appDataDir = join(geminiDir, "antigravity-cli");
  await ensurePrivateDirectory(providerRoot());
  await ensurePrivateDirectory(join(providerRoot(), "lineages"));
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(geminiDir);
  await ensurePrivateDirectory(configDir);
  await ensurePrivateDirectory(projectsDir);
  await ensurePrivateDirectory(appDataDir);
  const projectName = safeProjectName(lineage.lineageId);
  await writePrivateFile(
    join(geminiDir, "projects.json"),
    `${JSON.stringify({ projects: { [canonicalCwd]: projectName } })}\n`,
  );
  await writePrivateFile(
    join(configDir, "config.json"),
    `${JSON.stringify({ userSettings: {} })}\n`,
  );
  await writePrivateFile(
    join(projectsDir, "default-cli-project.json"),
    `${JSON.stringify({
      id: "default-cli-project",
      name: "CLI Project",
      projectResources: {},
    })}\n`,
  );
  await writePrivateFile(
    join(configDir, "mcp_config.json"),
    `${JSON.stringify(profile)}\n`,
  );
  await writePrivateFile(
    join(appDataDir, "settings.json"),
    `${JSON.stringify({
      permissions: {
        allow: [
          "read_file(*)",
          "view_file(*)",
          "list_directory(*)",
          "search_code(*)",
          "grep_search(*)",
          "find_by_name(*)",
          // MESH[2026-07-25T22:35Z][agent:cursor-parent][direction:user/9]
          // What: grants the terminal permission for read-only runs.
          // Why: implement mode passes --dangerously-skip-permissions, but every
          //   other mode had no command rule, so the first shell call was
          //   auto-denied in headless mode and the run produced no output at all.
          //   Both Antigravity review tasks failed exactly this way. The real
          //   boundary stays --sandbox, which is always passed, plus plan mode,
          //   which withholds edit tools.
          // Aligns-with: direction user revision 9 (Antigravity review failures).
          // Status: complete
          "command(*)",
          // Antigravity 1.1.5 accepts only an MCP permission wildcard here.
          // The generated config contains only Perplexity, the manifest-pinned
          // Pieces proxy, and the capability-scoped coordination server.
          ...(Object.keys(profile.mcpServers).length > 0 ? ["mcp(*)"] : []),
        ],
      },
    })}\n`,
  );

  const logPath = join(request.taskDir, "antigravity.log");
  await writePrivateFile(logPath, "");
  return {
    env: buildSafeEnv({
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      NO_COLOR: "1",
    }),
    geminiDir,
    lineage,
    logPath,
  };
}

export function parseAntigravityConversationId(log: string): string | undefined {
  let conversationId: string | undefined;
  for (const match of log.matchAll(CONVERSATION_PATTERN)) {
    if (match[1] && SESSION_ID_PATTERN.test(match[1])) conversationId = match[1];
  }
  return conversationId;
}

export function parseAntigravityModels(output: string): ProviderModel[] {
  const models = new Map<string, ProviderModel>();
  for (const rawLine of output.replace(/\r/g, "").split("\n")) {
    const id = rawLine.trim();
    if (
      !id ||
      id.startsWith("-") ||
      id.length > 256 ||
      /[\s\u0000-\u001F\u007F]/.test(id)
    ) {
      continue;
    }
    if (!models.has(id)) {
      models.set(id, {
        id,
        displayName: id,
        isDefault: models.size === 0,
        metadata: { source: "antigravity-cli" },
      });
    }
  }
  return [...models.values()];
}

async function prepareModelDirectory(): Promise<string> {
  const modelRuns = join(providerRoot(), "model-runs");
  await ensurePrivateDirectory(providerRoot());
  await ensurePrivateDirectory(modelRuns);
  const geminiDir = await mkdtemp(join(modelRuns, "gemini-"));
  await ensurePrivateDirectory(geminiDir);
  await ensurePrivateDirectory(join(geminiDir, "config"));
  await writePrivateFile(
    join(geminiDir, "config", "config.json"),
    `${JSON.stringify({ userSettings: {} })}\n`,
  );
  await writePrivateFile(
    join(geminiDir, "config", "mcp_config.json"),
    `${JSON.stringify({ mcpServers: {} })}\n`,
  );
  return geminiDir;
}

export class AntigravityAdapter implements ProviderAdapter {
  readonly provider = "antigravity" as const;

  capabilities(): ProviderCapabilities {
    return {
      provider: this.provider,
      dynamicModelDiscovery: true,
      resume: true,
      fork: false,
      nativeSessionSearch: false,
      nativeCancellation: false,
      notes: [
        "Models are discovered with `agy models`.",
        "Headless output is plain text; token and cost telemetry are unavailable.",
        "Prompts are passed through `--print` and are visible to same-user process inspection.",
        "Sandboxed implementation uses auto-approval inside the isolated mesh worktree.",
        "Conversation search remains mesh-authoritative because agy exposes no machine-readable search.",
      ],
    };
  }

  async listModels(): Promise<ProviderModel[]> {
    const binary = await resolveTrustedProviderExecutable("agy");
    const geminiDir = await prepareModelDirectory();
    try {
      const { stdout } = await execFileClosed(
        binary,
        ["--gemini_dir", geminiDir, "models"],
        {
          cwd: homedir(),
          env: buildSafeEnv({
            AGY_CLI_DISABLE_AUTO_UPDATE: "1",
            NO_COLOR: "1",
          }),
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 30_000,
        },
      );
      return parseAntigravityModels(stdout);
    } finally {
      await rm(geminiDir, { recursive: true, force: true });
    }
  }

  async run(request: ProviderRunRequest, hooks: ProviderRunHooks): Promise<ProviderResult> {
    const binary = await resolveTrustedProviderExecutable("agy");
    const mcpProfile = buildAntigravityMcpProfile(request.mcpProfile, {
      coordination: request.coordination,
      peer: request.peer,
    });
    const prepared = await prepareEnvironment(request, mcpProfile);
    const timeoutSeconds = Math.max(1, Math.ceil(request.timeoutMs / 1_000));
    const args = [
      "--gemini_dir",
      prepared.geminiDir,
      "--log-file",
      prepared.logPath,
      "--sandbox",
      "--print-timeout",
      `${timeoutSeconds}s`,
      "--project",
      "default-cli-project",
    ];
    if (request.mode === "implement") args.push("--dangerously-skip-permissions");
    else args.push("--mode", "plan");
    if (request.model) args.push("--model", request.model);
    const effort = modelEffort(request.effort);
    if (effort) args.push("--effort", effort);
    if (request.sessionId) {
      assertSessionId(request.sessionId);
      args.push("--conversation", request.sessionId);
      hooks.onSession(request.sessionId);
    }
    args.push(
      "--print",
      buildAntigravityPrompt({
        ...request,
        cwd: prepared.lineage.cwd,
      }),
    );

    let output = "";
    let outputBytes = 0;
    let outputOverflow = false;
    let emittedOutputEvent = false;
    let cancelForOverflow: (() => Promise<void>) | undefined;
    const maxOutputBytes = configuredByteLimit(
      "AGENT_MESH_MAX_ANTIGRAVITY_OUTPUT_BYTES",
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    const running = startLineProcess({
      command: binary,
      args,
      cwd: prepared.lineage.cwd,
      env: prepared.env,
      stdin: "",
      timeoutMs: request.timeoutMs,
      eventsPath: join(request.taskDir, "events.ndjson"),
      summarizeStdoutLine: () => ({ type: "provider_output" }),
      preserveEmptyStdoutLines: true,
      onStdoutLine(line) {
        outputBytes += Buffer.byteLength(line) + 1;
        if (outputBytes > maxOutputBytes) {
          outputOverflow = true;
          void cancelForOverflow?.();
          return;
        }
        output += `${line}\n`;
        if (!emittedOutputEvent) {
          emittedOutputEvent = true;
          hooks.onEvent?.({ type: "assistant", provider: "antigravity" });
        }
      },
    });
    cancelForOverflow = running.cancel;
    hooks.onStarted({ pid: running.pid, cancel: running.cancel });
    const outcome = await running.completion;
    let log: string;
    try {
      log = await readPrivateFilePrefix(prepared.logPath);
    } finally {
      await unlink(prepared.logPath).catch(() => undefined);
    }
    const conversationId =
      request.sessionId ?? parseAntigravityConversationId(log);
    output = output.trim();
    if (outcome.code !== 0 || outputOverflow || !conversationId || !output) {
      throw new Error(
        `Antigravity CLI failed (code=${String(outcome.code)}, signal=${String(outcome.signal)}): ${
          outputOverflow
            ? `output exceeded ${maxOutputBytes} bytes`
            : outcome.stderr || (!conversationId ? "no conversation ID" : "no result")
        }`,
      );
    }
    await registerLineage(conversationId, prepared.lineage);
    if (!request.sessionId) hooks.onSession(conversationId);
    return {
      output,
      sessionId: conversationId,
      metadata: {
        model: request.model ?? null,
        effort: effort ?? null,
        sandbox: true,
      },
    };
  }
}
