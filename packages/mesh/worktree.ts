import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  buildSafeEnv,
  canonicalizeAllowedCwd,
  ensurePrivateDirectory,
  getGitBinary,
  isWithin,
  stateDirectory,
} from "./security.js";
import type { TaskArtifacts } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_MAX_CARRIED_BYTES = 32 * 1024 * 1024;

async function gitRaw(args: string[], cwd: string): Promise<string> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const { stdout } = await execFileAsync(getGitBinary(), args, {
    cwd,
    env: buildSafeEnv({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_OPTIONAL_LOCKS: "0",
    }),
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await gitRaw(args, cwd)).trimEnd();
}

async function validateLocalGitConfig(repoRoot: string): Promise<void> {
  try {
    const dangerous = await git(
      [
        "config",
        "--includes",
        "--show-origin",
        "--show-scope",
        "--get-regexp",
        "^(include|includeIf\\.|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv)|core\\.(fsmonitor|hooksPath))",
      ],
      repoRoot,
    );
    const unsafe = dangerous
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.startsWith("command\tcommand line:"));
    if (unsafe.length) {
      throw new Error(
        `Repository has executable Git configuration that is unsafe for delegated checkout:\n${unsafe.join("\n")}`,
      );
    }
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 1) throw error;
  }
}

function hardenedArgs(args: string[]): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    ...args,
  ];
}

export interface PreparedWorktree {
  repoRoot: string;
  worktreePath: string;
  effectiveCwd: string;
  baseCommit: string;
}

export interface PrepareWorktreeOptions {
  carryUncommitted?: boolean;
  maxCarriedBytes?: number;
}

export interface PreparedLiveWorkspace {
  repoRoot: string;
  effectiveCwd: string;
  baseCommit: string;
}

export interface LiveWorkspaceArtifacts extends TaskArtifacts {
  kind: "live_diff_snapshot";
  snapshotPath: string;
  beforeHead: string;
  afterHead: string;
}

interface WorktreeSnapshot {
  changedFiles: string[];
  patch: string;
}

// MESH[2026-07-25T17:52Z][agent:codex][direction:user/1]
// What: captures canonical checkout provenance without creating or cleaning a worktree.
// Why: live workspace mode intentionally permits pre-existing and concurrent dirty changes.
// Aligns-with: direction user revision 1 (live-checkout writes and HEAD-bounded snapshots).
// Status: complete
export async function prepareLiveWorkspace(
  cwd: string,
): Promise<PreparedLiveWorkspace> {
  const canonicalCwd = await canonicalizeAllowedCwd(cwd);
  const discoveredRoot = await git(["rev-parse", "--show-toplevel"], canonicalCwd);
  const repoRoot = await realpath(discoveredRoot);
  await canonicalizeAllowedCwd(repoRoot);
  const relativeCwd = relative(repoRoot, canonicalCwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) {
    throw new Error(`cwd escapes discovered repository root: ${canonicalCwd}`);
  }
  await validateLocalGitConfig(repoRoot);
  const baseCommit = await git(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  return { repoRoot, effectiveCwd: canonicalCwd, baseCommit };
}

// MESH[2026-07-25T22:00Z][agent:cursor-parent][direction:user/7]
// What: reports how far a base has drifted from its upstream. Fetch only.
// Why: agents should know when they are building on a stale base, but the mesh
//   must never pull or merge into a checkout it does not own. Auto-merging
//   would mutate the human's tree, could conflict, and could silently swallow
//   unpushed local commits. Basing on the remote instead of local HEAD would
//   also recreate the problem carrying uncommitted work solved: an agent
//   working against code the human does not actually have.
// Aligns-with: direction user revision 7 (keep bases fresh).
// Status: complete
export interface BaseFreshness {
  upstream: string | null;
  behind: number;
  ahead: number;
  fetched: boolean;
  summary: string;
}

export async function inspectBaseFreshness(
  repoRoot: string,
  baseRef = "HEAD",
): Promise<BaseFreshness> {
  let upstream: string | null = null;
  try {
    upstream = (
      await git(
        hardenedArgs(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
        repoRoot,
      )
    ).trim();
  } catch {
    return {
      upstream: null,
      behind: 0,
      ahead: 0,
      fetched: false,
      summary: "No upstream is configured, so base freshness is unknown.",
    };
  }
  let fetched = false;
  try {
    // Read-only: updates remote-tracking refs without touching the work tree,
    // the index, or any local branch.
    await git(hardenedArgs(["fetch", "--quiet", "--no-tags"]), repoRoot);
    fetched = true;
  } catch {
    // An offline or unreachable remote must never block delegation.
  }
  try {
    const counts = await git(
      hardenedArgs(["rev-list", "--left-right", "--count", `${upstream}...${baseRef}`]),
      repoRoot,
    );
    const [behindRaw, aheadRaw] = counts.trim().split(/\s+/u);
    const behind = Number(behindRaw ?? 0);
    const ahead = Number(aheadRaw ?? 0);
    return {
      upstream,
      behind: Number.isSafeInteger(behind) ? behind : 0,
      ahead: Number.isSafeInteger(ahead) ? ahead : 0,
      fetched,
      summary:
        behind === 0
          ? `Base is current with ${upstream}${ahead > 0 ? ` and ${ahead} commit(s) ahead` : ""}.`
          : `Base is ${behind} commit(s) behind ${upstream}${ahead > 0 ? ` and ${ahead} ahead` : ""}. ` +
            "The human owns this checkout, so integrate deliberately rather than assuming the base is current.",
    };
  } catch {
    return {
      upstream,
      behind: 0,
      ahead: 0,
      fetched,
      summary: `Could not compare the base against ${upstream}.`,
    };
  }
}

export async function prepareWorktree(
  cwd: string,
  taskId: string,
  baseRef = "HEAD",
  options: PrepareWorktreeOptions = {},
): Promise<PreparedWorktree> {
  const canonicalCwd = await realpath(cwd);
  const discoveredRoot = await git(["rev-parse", "--show-toplevel"], canonicalCwd);
  const repoRoot = await realpath(discoveredRoot);
  await canonicalizeAllowedCwd(repoRoot);
  const relativeCwd = relative(repoRoot, canonicalCwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) {
    throw new Error(`cwd escapes discovered repository root: ${canonicalCwd}`);
  }
  await validateLocalGitConfig(repoRoot);
  const carryUncommitted = options.carryUncommitted ?? true;
  const maxCarriedBytes =
    options.maxCarriedBytes ??
    Number(
      process.env.AGENT_MESH_MAX_CARRIED_WORKTREE_BYTES ||
        DEFAULT_MAX_CARRIED_BYTES,
    );
  if (
    !Number.isSafeInteger(maxCarriedBytes) ||
    maxCarriedBytes <= 0 ||
    maxCarriedBytes > 1024 * 1024 * 1024
  ) {
    throw new Error(
      "maxCarriedBytes must be an integer between 1 and 1073741824.",
    );
  }
  const dirty = await git(
    hardenedArgs(["status", "--porcelain=v1", "--untracked-files=all"]),
    repoRoot,
  );
  if (dirty && !carryUncommitted) {
    throw new Error(
      "Implementation delegation requires a clean source worktree so the child cannot silently miss uncommitted changes.",
    );
  }

  const worktreesRoot = join(stateDirectory(), "worktrees");
  await ensurePrivateDirectory(worktreesRoot);
  const worktreePath = join(worktreesRoot, taskId);
  await rm(worktreePath, { recursive: true, force: true });
  const baseCommit = await git(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot);
  await git(
    hardenedArgs(["worktree", "add", "--detach", worktreePath, baseCommit]),
    repoRoot,
  );
  try {
    const canonicalWorktree = await realpath(worktreePath);
    let carriedBaseline = baseCommit;
    if (dirty) {
      carriedBaseline = await carrySourceState(
        repoRoot,
        canonicalWorktree,
        maxCarriedBytes,
      );
    }
    const effectiveCwd = await realpath(
      relativeCwd ? join(canonicalWorktree, relativeCwd) : canonicalWorktree,
    );
    const effectiveRelative = relative(canonicalWorktree, effectiveCwd);
    if (effectiveRelative === ".." || effectiveRelative.startsWith(`..${sep}`)) {
      throw new Error(`Effective cwd escapes delegated worktree: ${effectiveCwd}`);
    }
    return {
      repoRoot,
      worktreePath: canonicalWorktree,
      effectiveCwd,
      baseCommit: carriedBaseline,
    };
  } catch (error) {
    await git(
      hardenedArgs(["worktree", "remove", "--force", worktreePath]),
      repoRoot,
    ).catch(() => undefined);
    await git(hardenedArgs(["worktree", "prune"]), repoRoot).catch(
      () => undefined,
    );
    throw error;
  }
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function safeCarriedPath(repoRoot: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Refusing unsafe carried path: ${JSON.stringify(path)}.`);
  }
  const candidate = resolve(repoRoot, path);
  const pathRelative = relative(repoRoot, candidate);
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`)) {
    throw new Error(`Refusing carried path that escapes the repository: ${path}.`);
  }
  return candidate;
}

async function assertSafeCarriedEntry(
  repoRoot: string,
  path: string,
): Promise<number> {
  const candidate = safeCarriedPath(repoRoot, path);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      const target = await readlink(candidate);
      const resolvedTarget = resolve(dirname(candidate), target);
      const targetRelative = relative(repoRoot, resolvedTarget);
      if (
        isAbsolute(target) ||
        targetRelative === ".." ||
        targetRelative.startsWith(`..${sep}`)
      ) {
        throw new Error(
          `Refusing carried symlink that points outside the delegated worktree: ${path}.`,
        );
      }
      return Buffer.byteLength(target);
    }
    if (!info.isFile()) {
      throw new Error(`Refusing non-file carried path: ${path}.`);
    }
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function ensureSafeParents(root: string, path: string): Promise<void> {
  const parentRelative = relative(root, dirname(path));
  let current = root;
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Carried path traverses a non-directory: ${path}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function copyUntrackedEntry(
  sourceRoot: string,
  worktreeRoot: string,
  path: string,
  remainingBytes: number,
): Promise<number> {
  const source = safeCarriedPath(sourceRoot, path);
  const destination = safeCarriedPath(worktreeRoot, path);
  await ensureSafeParents(worktreeRoot, destination);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) {
    const target = await readlink(source);
    const resolvedTarget = resolve(dirname(source), target);
    const targetRelative = relative(sourceRoot, resolvedTarget);
    if (
      isAbsolute(target) ||
      targetRelative === ".." ||
      targetRelative.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `Refusing carried symlink that points outside the delegated worktree: ${path}.`,
      );
    }
    if (Buffer.byteLength(target) > remainingBytes) {
      throw new Error(
        `Carried working tree exceeds the configured size limit at ${path}.`,
      );
    }
    await symlink(target, destination);
    return Buffer.byteLength(target);
  }
  if (!sourceInfo.isFile()) {
    throw new Error(`Refusing non-file carried path: ${path}.`);
  }
  if (sourceInfo.size > remainingBytes) {
    throw new Error(
      `Carried working tree exceeds the configured size limit at ${path}.`,
    );
  }
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const destinationHandle = await open(
    destination,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    sourceInfo.mode & 0o7777,
  );
  try {
    const before = await sourceHandle.stat();
    const contents = await sourceHandle.readFile();
    const after = await sourceHandle.stat();
    if (
      !before.isFile() ||
      before.ino !== sourceInfo.ino ||
      before.dev !== sourceInfo.dev ||
      before.size !== contents.length ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`Source changed while carrying path: ${path}.`);
    }
    await destinationHandle.writeFile(contents);
    await destinationHandle.sync();
    await destinationHandle.chmod(sourceInfo.mode & 0o7777);
    return contents.length;
  } finally {
    await sourceHandle.close();
    await destinationHandle.close();
  }
}

// MESH[2026-07-25T20:40Z][agent:codex][direction:user/2]
// What: carries the source's non-ignored working state into a detached synthetic baseline.
// Why: delegated work must start from the human's real files while outgoing artifacts exclude that pre-existing work.
// Aligns-with: direction user revision 2 (symmetric dirty-worktree delegation without source checkout mutation).
// Status: complete
async function carrySourceState(
  repoRoot: string,
  worktreePath: string,
  maxCarriedBytes: number,
): Promise<string> {
  const trackedNames = nulPaths(
    await gitRaw(
      hardenedArgs(["diff", "--name-only", "-z", "HEAD", "--"]),
      repoRoot,
    ),
  );
  const untrackedNames = nulPaths(
    await gitRaw(
      hardenedArgs(["ls-files", "--others", "--exclude-standard", "-z", "--"]),
      repoRoot,
    ),
  );
  const carriedPaths = [...new Set([...trackedNames, ...untrackedNames])].sort();
  let carriedBytes = 0;
  for (const path of carriedPaths) {
    carriedBytes += await assertSafeCarriedEntry(repoRoot, path);
    if (carriedBytes > maxCarriedBytes) {
      throw new Error(
        `Carried working tree exceeds the configured size limit of ${maxCarriedBytes} bytes at ${path}.`,
      );
    }
  }

  const trackedPatch = await gitRaw(
    hardenedArgs([
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ]),
    repoRoot,
  );
  if (trackedPatch) {
    const patchPath = join(dirname(worktreePath), `.carry-${taskSafeName(worktreePath)}.patch`);
    const patchHandle = await open(
      patchPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await patchHandle.writeFile(trackedPatch, "utf8");
      await patchHandle.sync();
      await git(
        hardenedArgs([
          "apply",
          "--index",
          "--binary",
          "--whitespace=nowarn",
          patchPath,
        ]),
        worktreePath,
      );
    } finally {
      await patchHandle.close();
      await unlink(patchPath).catch(() => undefined);
    }
  }

  let copiedBytes = carriedBytes;
  for (const path of untrackedNames) {
    const entryBytes = await assertSafeCarriedEntry(repoRoot, path);
    copiedBytes -= entryBytes;
    await copyUntrackedEntry(
      repoRoot,
      worktreePath,
      path,
      maxCarriedBytes - copiedBytes,
    );
    copiedBytes += entryBytes;
  }
  await git(hardenedArgs(["add", "--all", "--"]), worktreePath);
  await git(
    hardenedArgs([
      "-c",
      "user.name=Agent Mesh",
      "-c",
      "user.email=agent-mesh@localhost.invalid",
      "commit",
      "--quiet",
      "--no-verify",
      "--no-gpg-sign",
      "-m",
      "agent-mesh: carried working tree baseline",
    ]),
    worktreePath,
  );
  return git(["rev-parse", "--verify", "HEAD^{commit}"], worktreePath);
}

function taskSafeName(worktreePath: string): string {
  return worktreePath
    .slice(worktreePath.lastIndexOf(sep) + 1)
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

// MESH[2026-07-25T21:50Z][agent:cursor-parent][direction:user/6]
// What: untracked output under these directories is never captured.
// Why: an agent that ran a package install with a repository-local cache put
//   38 MB of untracked files in its worktree, which blew the patch limit and
//   discarded an otherwise complete 53 KB change. These directories are build
//   and dependency output, never authored work. Tracked files are unaffected,
//   so a repository that genuinely commits one of these paths still works.
// Aligns-with: direction user revision 6 (patch capture hygiene).
// Status: complete
const EPHEMERAL_UNTRACKED_DIRECTORIES = [
  "node_modules",
  ".npm-cache",
  ".npm",
  ".yarn/cache",
  ".pnpm-store",
  ".cache",
  ".turbo",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".tox",
  "coverage",
];

function isEphemeralUntracked(path: string): boolean {
  const segments = path.split("/");
  return EPHEMERAL_UNTRACKED_DIRECTORIES.some((directory) => {
    const parts = directory.split("/");
    return segments.some((_, index) =>
      parts.every((part, offset) => segments[index + offset] === part),
    );
  });
}

async function largestPaths(
  worktreePath: string,
  paths: readonly string[],
  limit = 5,
): Promise<string[]> {
  const sized = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, bytes: (await lstat(join(worktreePath, path))).size };
      } catch {
        return { path, bytes: 0 };
      }
    }),
  );
  return sized
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit)
    .map(({ path, bytes }) => `${path} (${Math.round(bytes / 1024)} KiB)`);
}

async function snapshotWorktree(
  worktreePath: string,
  baseCommit: string,
): Promise<WorktreeSnapshot> {
  const maxPatchBytes = Number(process.env.AGENT_MESH_MAX_PATCH_BYTES || MAX_BUFFER);
  const trackedNames = await git(
    hardenedArgs(["diff", "--name-only", "-z", baseCommit, "--"]),
    worktreePath,
  );
  const untrackedOutput = await git(
    hardenedArgs(["ls-files", "--others", "--exclude-standard", "-z"]),
    worktreePath,
  );
  const untracked = untrackedOutput
    .split("\0")
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => !isEphemeralUntracked(name));
  const changedFiles = [
    ...new Set([
      ...trackedNames
        .split("\0")
        .map((name) => name.trim())
        .filter(Boolean),
      ...untracked,
    ]),
  ];
  if (changedFiles.length === 0) {
    return { changedFiles: [], patch: "" };
  }

  const exceeded = async (): Promise<Error> =>
    new Error(
      `Patch exceeds configured limit of ${maxPatchBytes} bytes. ` +
        `Largest captured paths: ${(await largestPaths(worktreePath, changedFiles)).join(", ")}. ` +
        "Keep build and dependency output out of the worktree, or raise AGENT_MESH_MAX_PATCH_BYTES.",
    );

  let patch = await git(
    hardenedArgs(["diff", "--binary", "--no-ext-diff", "--no-textconv", baseCommit, "--"]),
    worktreePath,
  );
  if (Buffer.byteLength(patch) > maxPatchBytes) {
    throw await exceeded();
  }
  for (const path of untracked) {
    try {
      await git(
        hardenedArgs([
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          "--no-index",
          "--",
          "/dev/null",
          path,
        ]),
        worktreePath,
      );
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      const code = (error as { code?: number }).code;
      if (code !== 1 || typeof stdout !== "string") throw error;
      patch = `${patch}${patch ? "\n" : ""}${stdout.trimEnd()}`;
      if (Buffer.byteLength(patch) > maxPatchBytes) {
        throw await exceeded();
      }
    }
  }
  return { changedFiles, patch };
}

export async function collectWorktreeArtifacts(
  worktreePath: string,
  baseCommit: string,
  taskDir: string,
  existingPatchHandle?: FileHandle,
): Promise<TaskArtifacts> {
  const { changedFiles, patch } = await snapshotWorktree(worktreePath, baseCommit);
  if (changedFiles.length === 0) {
    return { changedFiles: [], worktreePath };
  }
  const patchPath = join(taskDir, "changes.patch");
  await mkdir(dirname(patchPath), { recursive: true, mode: 0o700 });
  const patchHandle =
    existingPatchHandle ??
    (await open(
      patchPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    ));
  await patchHandle.truncate(0);
  await patchHandle.writeFile(`${patch}\n`, { encoding: "utf8" });
  await patchHandle.sync();
  await patchHandle.chmod(0o600);
  if (!existingPatchHandle) await patchHandle.close();
  return { changedFiles, patchPath, worktreePath };
}

export async function collectLiveWorkspaceArtifacts(
  repoRoot: string,
  beforeHead: string,
  taskDir: string,
  existingSnapshotHandle?: FileHandle,
): Promise<LiveWorkspaceArtifacts> {
  const { changedFiles, patch } = await snapshotWorktree(repoRoot, beforeHead);
  const afterHead = await git(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
  const snapshotPath = join(taskDir, "live-diff.snapshot.json");
  await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const snapshotHandle =
    existingSnapshotHandle ??
    (await open(
      snapshotPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    ));
  const snapshot = JSON.stringify(
    {
      kind: "live_diff_snapshot",
      beforeHead,
      afterHead,
      changedFiles,
      diff: patch,
    },
    null,
    2,
  );
  await snapshotHandle.truncate(0);
  await snapshotHandle.writeFile(`${snapshot}\n`, { encoding: "utf8" });
  await snapshotHandle.sync();
  await snapshotHandle.chmod(0o600);
  if (!existingSnapshotHandle) await snapshotHandle.close();
  return {
    kind: "live_diff_snapshot",
    changedFiles,
    patchPath: snapshotPath,
    snapshotPath,
    beforeHead,
    afterHead,
  };
}

export async function verifyWorktreeArtifacts(
  worktreePath: string,
  baseCommit: string,
  artifactStatus: "clean" | "captured",
  patchPath: string | null,
): Promise<void> {
  const snapshot = await snapshotWorktree(worktreePath, baseCommit);
  if (artifactStatus === "clean") {
    if (snapshot.changedFiles.length > 0) {
      throw new Error("Worktree changed after it was recorded as clean.");
    }
    return;
  }
  if (!patchPath) throw new Error("Captured worktree is missing its patch artifact.");
  const recordedPatch = await readFile(patchPath, "utf8");
  if (recordedPatch !== `${snapshot.patch}\n`) {
    throw new Error("Worktree changed after its patch artifact was captured.");
  }
}

export async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const allowedRoot = await realpath(resolve(join(stateDirectory(), "worktrees")));
  const info = await lstat(worktreePath);
  if (info.isSymbolicLink()) throw new Error("Refusing to remove a symlinked worktree path.");
  const candidate = await realpath(worktreePath);
  const same = (a: string, b: string) => relative(a, b) === "";
  if (!isWithin(allowedRoot, candidate) || same(allowedRoot, candidate)) {
    throw new Error(`Refusing to remove worktree outside mesh state: ${candidate}`);
  }
  const listed = await git(hardenedArgs(["worktree", "list", "--porcelain"]), repoRoot);
  if (
    !listed
      .split("\n")
      .some(
        (line) =>
          line.startsWith("worktree ") &&
          same(resolve(line.slice("worktree ".length).trim()), candidate),
      )
  ) {
    throw new Error(`Path is not a registered worktree for ${repoRoot}: ${candidate}`);
  }
  await git(hardenedArgs(["worktree", "remove", "--force", candidate]), repoRoot);
  await git(hardenedArgs(["worktree", "prune"]), repoRoot);
}
