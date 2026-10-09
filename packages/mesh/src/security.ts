import { access, chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Origin, Provider } from "./types.js";
import { PROVIDERS } from "./types.js";

const SAFE_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "Path",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SystemRoot",
  "SystemDrive",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "COMSPEC",
  "PATHEXT",
] as const;

export const DEFAULT_STATE_DIR = join(homedir(), ".local", "state", "agent-mesh");

export function parseOrigin(raw: string | undefined): Origin {
  if (raw && PROVIDERS.includes(raw as Provider)) return raw as Origin;
  throw new Error(`Missing or invalid --origin. Expected ${PROVIDERS.join(", ")}.`);
}

export function assertDelegationAllowed(origin: Origin, target: Provider): void {
  if (process.env.AGENT_MESH_CHILD === "1") {
    throw new Error("Nested delegation is disabled for agent-mesh child processes.");
  }
  if (origin === target) {
    throw new Error(`Refusing recursive delegation from ${origin} to itself.`);
  }
}

export function assertNoActiveTaskAncestor(activePids: number[]): void {
  if (process.env.AGENT_MESH_CHILD === "1") {
    throw new Error("Nested delegation is disabled for descendants of active mesh tasks.");
  }
  if (activePids.length === 0) return;
  const active = new Set(activePids);
  if (active.has(process.pid) || (process.ppid !== undefined && active.has(process.ppid))) {
    throw new Error("Nested delegation is disabled for descendants of active mesh tasks.");
  }
  if (process.platform === "win32") return;
  let pid = process.ppid;
  const visited = new Set<number>();
  for (let depth = 0; pid > 1 && depth < 32 && !visited.has(pid); depth += 1) {
    if (active.has(pid)) {
      throw new Error("Nested delegation is disabled for descendants of active mesh tasks.");
    }
    visited.add(pid);
    try {
      const parent = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
        env: buildSafeEnv({ AGENT_MESH_CHILD: "0" }),
      }).trim();
      pid = Number(parent);
      if (!Number.isInteger(pid)) break;
    } catch {
      break;
    }
  }
}

export function configuredRoots(): string[] {
  const configured = process.env.AGENT_MESH_ALLOWED_ROOTS;
  const roots = configured
    ? configured.split(delimiter).map((entry) => entry.trim()).filter(Boolean)
    : [join(homedir(), "Development")];
  return [...roots.map((entry) => resolve(entry)), join(stateDirectory(), "worktrees")];
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function canonicalizeAllowedCwd(
  cwd: string,
  roots = configuredRoots(),
): Promise<string> {
  const canonical = await realpath(resolve(cwd));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${canonical}`);

  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return resolve(root);
      }
    }),
  );
  if (!canonicalRoots.some((root) => isWithin(root, canonical))) {
    throw new Error(
      `cwd is outside configured development roots: ${canonical}; allowed=${canonicalRoots.join(", ")}`,
    );
  }
  return canonical;
}

const PROVIDER_EXECUTABLE_ROOTS: Record<string, string[]> = {
  "cursor-agent": [
    join(homedir(), ".local", "share", "cursor-agent", "versions"),
    join(homedir(), "AppData", "Local", "Programs", "cursor"),
  ],
  claude: [
    join(homedir(), ".local", "share", "claude", "versions"),
    join(homedir(), "AppData", "Roaming", "npm"),
    join(homedir(), "AppData", "Local", "Programs"),
  ],
  codex: [
    join(homedir(), ".codex", "packages", "standalone", "releases"),
    join(homedir(), "AppData", "Local", "Programs", "OpenAI", "Codex", "bin"),
  ],
  grok: [
    join(homedir(), ".grok", "bin"),
    "/opt/homebrew/Caskroom/grok-build",
  ],
  agy: [
    "/opt/homebrew/Caskroom/antigravity-cli",
    join(homedir(), "AppData", "Local", "agy", "bin"),
  ],
};

const PROVIDER_EXACT_EXECUTABLES: Record<string, string[]> = {
  claude: [
    ...(process.platform === "win32"
      ? [join(homedir(), ".local", "bin", "claude.exe")]
      : []),
  ],
};

export async function resolveTrustedProviderExecutable(name: string): Promise<string> {
  const roots = PROVIDER_EXECUTABLE_ROOTS[name];
  if (!roots) throw new Error(`Unsupported provider executable: ${name}`);
  const exacts = PROVIDER_EXACT_EXECUTABLES[name] ?? [];
  const links = [
    ...(process.platform === "win32"
      ? [join(homedir(), ".local", "bin", `${name}.exe`)]
      : []),
    join(homedir(), ".local", "bin", name),
    join(homedir(), ".grok", "bin", name),
    join(homedir(), "AppData", "Local", name, "bin", `${name}.exe`),
    join(homedir(), "AppData", "Local", "agy", "bin", `${name}.exe`),
    join(homedir(), "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", `${name}.exe`),
    join(homedir(), "AppData", "Roaming", "npm", `${name}.cmd`),
    join(homedir(), "AppData", "Roaming", "npm", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const candidate of links) {
    try {
      if (process.platform !== "win32") {
        await access(candidate, constants.X_OK);
      } else {
        await access(candidate, constants.F_OK);
      }
      const resolved = await realpath(candidate);
      const allowed = await Promise.all(
        roots.map(async (root) => {
          try {
            return await realpath(root);
          } catch {
            return resolve(root);
          }
        }),
      );
      const canonicalExacts = await Promise.all(
        exacts.map(async (entry) => {
          try {
            return await realpath(entry);
          } catch {
            return resolve(entry);
          }
        }),
      );
      const matchesExact = canonicalExacts.some((entry) =>
        process.platform === "win32"
          ? entry.toLowerCase() === resolved.toLowerCase()
          : entry === resolved,
      );
      if (!matchesExact && !allowed.some((root) => isWithin(root, resolved))) continue;
      const info = await lstat(resolved);
      const uid = process.getuid?.();
      if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o022) !== 0)) {
        throw new Error(`Provider executable is writable by group/other: ${resolved}`);
      }
      if (uid !== undefined && info.uid !== uid && info.uid !== 0) {
        throw new Error(`Provider executable has an unexpected owner: ${resolved}`);
      }
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof Error && /writable|owner/.test(error.message)) throw error;
    }
  }
  throw new Error(`Trusted ${name} executable was not found.`);
}

let cachedGitBinary: string | null = null;
export function getGitBinary(): string {
  if (cachedGitBinary) return cachedGitBinary;
  if (process.platform === "win32") {
    const standardPaths = [
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      join(homedir(), "AppData", "Local", "Programs", "Git", "cmd", "git.exe"),
      join(homedir(), "AppData", "Local", "Programs", "Git", "bin", "git.exe"),
    ];
    for (const p of standardPaths) {
      if (existsSync(p)) return (cachedGitBinary = p);
    }
    const pathDirs = (process.env.PATH ?? process.env.Path ?? "")
      .split(";")
      .map((entry) => entry.trim())
      .filter((d) => d && isAbsolute(d));
    for (const d of pathDirs) {
      const p = join(d, "git.exe");
      if (existsSync(p)) return (cachedGitBinary = p);
    }
    return (cachedGitBinary = "git.exe");
  }
  for (const candidate of ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]) {
    if (existsSync(candidate)) return (cachedGitBinary = candidate);
  }
  return (cachedGitBinary = "git");
}

export function buildSafeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.HOME ??= homedir();
  if (process.platform === "win32") {
    const rawPath = process.env.PATH ?? process.env.Path ?? "";
    env.PATH = rawPath
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry && isAbsolute(entry))
      .join(";");
    delete env.Path;
    env.SystemRoot ??= process.env.SystemRoot ?? "C:\\Windows";
    env.USERPROFILE ??= homedir();
    env.TMPDIR ??= tmpdir();
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "NUL";
    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_CONFIG_COUNT = "3";
    env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    env.GIT_CONFIG_VALUE_0 = "NUL";
    env.GIT_CONFIG_KEY_1 = "core.fsmonitor";
    env.GIT_CONFIG_VALUE_1 = "false";
    env.GIT_CONFIG_KEY_2 = "diff.external";
    env.GIT_CONFIG_VALUE_2 = "";
  } else {
    const nvmNodeBin = process.env.NVM_BIN?.trim();
    const pathParts = [
      `${homedir()}/.local/bin`,
      ...(nvmNodeBin ? [nvmNodeBin] : []),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];
    env.PATH = pathParts.join(":");
    env.TMPDIR ??= tmpdir();
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_CONFIG_COUNT = "3";
    env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    env.GIT_CONFIG_VALUE_0 = "/dev/null";
    env.GIT_CONFIG_KEY_1 = "core.fsmonitor";
    env.GIT_CONFIG_VALUE_1 = "false";
    env.GIT_CONFIG_KEY_2 = "diff.external";
    env.GIT_CONFIG_VALUE_2 = "";
  }
  env.TERM = "dumb";
  env.CI = "1";
  env.NO_OPEN_BROWSER = "1";
  env.AGENT_MESH_CHILD = "1";

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?(?:token|key)|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|authorization|cookie)["']?\s*[:=]\s*["']?))[^"'\s,;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:token|secret|key|api[_-]?key|access[_-]?key)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-|xai-|pplx-|gh[oprsu]_|github_pat_|xox[baprs]-|glpat-|ctx7sk-|apify_api_)[A-Za-z0-9_-]{12,}\b/g,
      "[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
      "[REDACTED JWT]",
    )
    .replace(/\bya29\.[A-Za-z0-9._-]{20,}\b/g, "[REDACTED GOOGLE TOKEN]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(
      /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

export function summarizeEventForLog(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return { type: "nonJson", message: redactSecrets(String(value)).slice(0, 2_000) };
  }
  const event = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["type", "subtype", "method", "id", "session_id", "request_id"]) {
    const item = event[key];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      summary[key] = item;
    }
  }
  if (typeof event.threadId === "string") summary.threadId = event.threadId;
  const params =
    event.params && typeof event.params === "object"
      ? (event.params as Record<string, unknown>)
      : undefined;
  if (params && typeof params.threadId === "string") summary.threadId = params.threadId;
  for (const containerName of ["item", "turn"] as const) {
    const container =
      (params?.[containerName] ?? event[containerName]) &&
      typeof (params?.[containerName] ?? event[containerName]) === "object"
        ? ((params?.[containerName] ?? event[containerName]) as Record<string, unknown>)
        : undefined;
    if (!container) continue;
    const safe: Record<string, unknown> = {};
    for (const key of ["id", "type", "status", "tool", "server", "phase"]) {
      const item = container[key];
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        safe[key] = item;
      }
    }
    summary[containerName] = safe;
  }
  if (event.error) summary.error = redactSecrets(JSON.stringify(event.error)).slice(0, 2_000);
  return summary;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export function stateDirectory(): string {
  return resolve(process.env.AGENT_MESH_STATE_DIR || DEFAULT_STATE_DIR);
}

export async function taskDirectory(taskId: string): Promise<string> {
  const path = join(stateDirectory(), "tasks", taskId);
  await ensurePrivateDirectory(path);
  return path;
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
