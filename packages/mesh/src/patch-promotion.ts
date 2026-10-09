import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import {
  buildSafeEnv,
  canonicalizeAllowedCwd,
  configuredRoots,
  getGitBinary,
  redactSecrets,
  stateDirectory,
} from "./security.js";
import { PROVIDERS, type Origin, type TaskRecord } from "./types.js";
import { verifyWorktreeArtifacts } from "./worktree.js";

const DEFAULT_MAX_PATCH_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_FINGERPRINT_BYTES = 512 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROMOTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_TASK_STATUSES = new Set<TaskRecord["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const PATCH_STATES = [
  "applying",
  "applied",
  "committed",
  "rolling_back",
  "rolled_back",
  "failed",
  "needs_attention",
] as const;
const ROLLBACK_STATES = [
  "not_available",
  "available",
  "in_progress",
  "rolled_back",
  "needs_attention",
] as const;
const OPERATION_PHASES = [
  "apply_prepared",
  "apply_mutating",
  "stable_applied",
  "stable_committed",
  "rollback_prepared",
  "rollback_mutating",
  "stable_rolled_back",
  "stable_failed",
  "needs_attention",
] as const;
const RECOVERY_STATES = [
  "none",
  "pending",
  "recovered_not_applied",
  "recovered_applied",
  "recovered_rolled_back",
  "needs_attention",
] as const;

export type PatchPromotionState = (typeof PATCH_STATES)[number];
export type PatchPromotionRollbackState = (typeof ROLLBACK_STATES)[number];
export type PatchPromotionOperationPhase = (typeof OPERATION_PHASES)[number];
export type PatchPromotionRecoveryState = (typeof RECOVERY_STATES)[number];
export type PatchPromotionErrorCode =
  | "INVALID_INPUT"
  | "CONFIRMATION_REQUIRED"
  | "NOT_FOUND"
  | "ORIGIN_MISMATCH"
  | "ARTIFACT_UNSAFE"
  | "PATCH_INVALID"
  | "TARGET_UNSAFE"
  | "HEAD_MISMATCH"
  | "DIRTY_TARGET"
  | "DUPLICATE"
  | "LOCKED"
  | "APPLY_FAILED"
  | "ROLLBACK_UNSAFE"
  | "SERVICE_CLOSING"
  | "STORE_CORRUPT";

export class PatchPromotionError extends Error {
  readonly code: PatchPromotionErrorCode;

  constructor(code: PatchPromotionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PatchPromotionError";
    this.code = code;
  }
}

export class PatchPromotionConfirmationError extends PatchPromotionError {
  readonly requiredConfirmation: string;

  constructor(requiredConfirmation: string) {
    super(
      "CONFIRMATION_REQUIRED",
      `Exact confirmation required: ${requiredConfirmation}`,
    );
    this.name = "PatchPromotionConfirmationError";
    this.requiredConfirmation = requiredConfirmation;
  }
}

export class PatchPromotionLockError extends PatchPromotionError {
  constructor(targetRepo: string) {
    super("LOCKED", `Patch promotion is already locked for target repository: ${targetRepo}`);
    this.name = "PatchPromotionLockError";
  }
}

export interface PatchPromotionTaskLookup {
  get(taskId: string): TaskRecord | undefined | Promise<TaskRecord | undefined>;
}

export type PatchPromotionTaskSource =
  | PatchPromotionTaskLookup
  | ((taskId: string) => TaskRecord | undefined | Promise<TaskRecord | undefined>);

export interface GitStatusSnapshot {
  /** Exact `git status --porcelain=v1 -z --untracked-files=all` output. */
  porcelainV1Z: string;
  sha256: string;
  clean: boolean;
}

export interface AffectedPathFingerprint {
  path: string;
  kind: "file" | "missing";
  sha256: string | null;
  bytes: number;
  mode: number | null;
}

export interface AffectedFilesFingerprint {
  sha256: string;
  totalBytes: number;
  paths: AffectedPathFingerprint[];
}

export interface PatchPromotionRecord {
  schemaVersion: 2;
  id: string;
  taskId: string;
  origin: Origin;
  state: PatchPromotionState;
  rollbackState: PatchPromotionRollbackState;
  operationPhase: PatchPromotionOperationPhase;
  recoveryState: PatchPromotionRecoveryState;
  sourceRepo: string;
  targetRepo: string;
  baseCommit: string;
  patchSha256: string;
  patchBytes: number;
  affectedPaths: string[];
  preStatus: GitStatusSnapshot;
  postStatus: GitStatusSnapshot | null;
  preFingerprint: AffectedFilesFingerprint;
  expectedPostFingerprint: AffectedFilesFingerprint;
  postFingerprint: AffectedFilesFingerprint | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  rollbackStartedAt: string | null;
  rolledBackAt: string | null;
  error: string | null;
}

export interface PatchPromotionPreview {
  taskId: string;
  origin: Origin;
  sourceRepo: string;
  targetRepo: string;
  baseCommit: string;
  patchSha256: string;
  patchBytes: number;
  affectedPaths: string[];
  preStatus: GitStatusSnapshot;
  preFingerprint: AffectedFilesFingerprint;
  expectedPostFingerprint: AffectedFilesFingerprint;
  previewedAt: string;
  requiredConfirmation: string;
  activePromotionId: string | null;
}

export interface PreviewPatchPromotionInput {
  taskId: string;
  targetRepo: string;
}

export interface ApplyPatchPromotionInput extends PreviewPatchPromotionInput {
  confirmation: string;
  /**
   * Digests a human approved from a prior preview. When present, apply fails
   * closed if the patch or its simulated result differs from what was shown.
   */
  expectedPatchSha256?: string;
  expectedPostFingerprintSha256?: string;
}

export interface RollbackPatchPromotionInput {
  promotionId: string;
  confirmation: string;
}

export interface ListPatchPromotionsInput {
  taskId?: string;
  targetRepo?: string;
  limit?: number;
}

export interface PatchPromotionServiceOptions {
  origin: Origin;
  /** A TaskRegistry-compatible lookup or a direct task lookup function. */
  taskLookup?: PatchPromotionTaskSource;
  /** Alias for passing a TaskRegistry without coupling this module to its implementation. */
  registry?: PatchPromotionTaskLookup;
  storeDirectory?: string;
  artifactsDirectory?: string;
  allowedRoots?: readonly string[];
  maxPatchBytes?: number;
  maxFingerprintBytes?: number;
  gitTimeoutMs?: number;
  staleLockMs?: number;
}

export interface PatchPromotionRecoveryReport {
  scanned: number;
  recovered: PatchPromotionRecord[];
  pending: string[];
  needsAttention: string[];
}

interface GitOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

interface LoadedArtifact {
  bytes: Buffer;
  text: string;
  sha256: string;
}

interface PreparedPromotion {
  task: TaskRecord;
  sourceRepo: string;
  targetRepo: string;
  artifact: LoadedArtifact;
  affectedPaths: string[];
  preStatus: GitStatusSnapshot;
  preChangedPaths: {
    all: string[];
    index: string[];
  };
  preFingerprint: AffectedFilesFingerprint;
  expectedPostFingerprint: AffectedFilesFingerprint;
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cloneRecord(record: PatchPromotionRecord): PatchPromotionRecord {
  return structuredClone(record);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 4_000);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertSafeTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId) || taskId === "." || taskId === "..") {
    throw new PatchPromotionError("INVALID_INPUT", "Invalid taskId.");
  }
}

function assertPromotionId(promotionId: string): void {
  if (!PROMOTION_ID_PATTERN.test(promotionId)) {
    throw new PatchPromotionError("INVALID_INPUT", "Invalid promotionId.");
  }
}

function assertBoundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PatchPromotionError(
      "INVALID_INPUT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new PatchPromotionError(
      "PATCH_INVALID",
      `${label} must contain valid UTF-8.`,
      { cause: error },
    );
  }
}

function statusSnapshot(raw: Buffer): GitStatusSnapshot {
  const porcelainV1Z = decodeUtf8(raw, "Git status");
  return {
    porcelainV1Z,
    sha256: sha256(raw),
    clean: raw.length === 0,
  };
}

function sameStatus(left: GitStatusSnapshot, right: GitStatusSnapshot): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.porcelainV1Z === right.porcelainV1Z &&
    left.clean === right.clean
  );
}

function fingerprintDigest(paths: readonly AffectedPathFingerprint[]): string {
  return sha256(JSON.stringify(paths));
}

function sameFingerprint(
  left: AffectedFilesFingerprint,
  right: AffectedFilesFingerprint,
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.totalBytes === right.totalBytes &&
    JSON.stringify(left.paths) === JSON.stringify(right.paths)
  );
}

function fingerprintDriftPaths(
  expected: AffectedFilesFingerprint,
  actual: AffectedFilesFingerprint,
): string[] {
  return expected.paths
    .filter(
      (entry, index) =>
        JSON.stringify(entry) !== JSON.stringify(actual.paths[index]),
    )
    .map((entry) => entry.path);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function statusChangedPaths(snapshot: GitStatusSnapshot): {
  all: string[];
  index: string[];
} {
  const entries = snapshot.porcelainV1Z.split("\0");
  const all = new Set<string>();
  const index = new Set<string>();
  for (let offset = 0; offset < entries.length - 1; offset += 1) {
    const entry = entries[offset]!;
    if (entry.length < 4 || entry[2] !== " ") {
      throw new PatchPromotionError(
        "STORE_CORRUPT",
        "Promotion status contains malformed path data.",
      );
    }
    const indexCode = entry[0]!;
    const worktreeCode = entry[1]!;
    const path = validateRelativePatchPath(entry.slice(3));
    all.add(path);
    if (indexCode !== " " && indexCode !== "?") index.add(path);
    if (
      indexCode === "R" ||
      indexCode === "C" ||
      worktreeCode === "R" ||
      worktreeCode === "C"
    ) {
      const source = entries[++offset];
      if (!source) {
        throw new PatchPromotionError(
          "STORE_CORRUPT",
          "Promotion status contains malformed rename data.",
        );
      }
      const sourcePath = validateRelativePatchPath(source);
      all.add(sourcePath);
      if (indexCode !== " " && indexCode !== "?") index.add(sourcePath);
    }
  }
  return {
    all: [...all].sort(),
    index: [...index].sort(),
  };
}

function preservesDisjointStatus(
  before: GitStatusSnapshot,
  after: GitStatusSnapshot,
  affectedPaths: readonly string[],
): boolean {
  const beforePaths = statusChangedPaths(before);
  const afterPaths = statusChangedPaths(after);
  const affected = new Set(affectedPaths);
  return (
    beforePaths.all.every((path) => afterPaths.all.includes(path)) &&
    afterPaths.all.every(
      (path) => beforePaths.all.includes(path) || affected.has(path),
    ) &&
    samePaths(beforePaths.index, afterPaths.index)
  );
}

function inactivePromotion(record: PatchPromotionRecord): boolean {
  return ["committed", "rolled_back", "failed"].includes(record.state);
}

function hardenedGitArgs(args: readonly string[]): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "diff.external=",
    "-c",
    "submodule.recurse=false",
    "-c",
    "core.autocrlf=false",
    ...args,
  ];
}

function runGit(
  args: readonly string[],
  cwd: string,
  options: {
    input?: Buffer;
    timeoutMs: number;
    maxOutputBytes?: number;
  },
): Promise<GitOutput> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return new Promise<GitOutput>((resolvePromise, rejectPromise) => {
    const child = spawn(getGitBinary(), hardenedGitArgs(args), {
      cwd,
      env: buildSafeEnv({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: nullDevice,
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      }),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let failure: Error | undefined;

    const failAndKill = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        failAndKill(new Error("Git stdout exceeded the configured output limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        failAndKill(new Error("Git stderr exceeded the configured output limit."));
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") failure ??= error;
    });

    const timer = setTimeout(() => {
      failAndKill(new Error(`Git command timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) {
        rejectPromise(failure);
        return;
      }
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
    child.stdin.end(options.input);
  });
}

function checkedGitError(operation: string, result: GitOutput): PatchPromotionError {
  const detail = result.stderr ? `: ${redactSecrets(result.stderr).slice(0, 2_000)}` : "";
  return new PatchPromotionError(
    "APPLY_FAILED",
    `Git ${operation} failed with exit code ${String(result.code)}${detail}`,
  );
}

function validateRelativePatchPath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path) > 4_096 ||
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new PatchPromotionError("PATCH_INVALID", `Unsafe patch path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git",
    )
  ) {
    throw new PatchPromotionError("PATCH_INVALID", `Unsafe patch path: ${JSON.stringify(path)}`);
  }
  return path;
}

function decodeGitQuotedPath(raw: string): string {
  if (!raw.startsWith('"')) return raw.split("\t", 1)[0]!;
  const bytes: number[] = [];
  let index = 1;
  let closed = false;
  while (index < raw.length) {
    const character = raw[index]!;
    if (character === '"') {
      closed = true;
      index += 1;
      break;
    }
    if (character !== "\\") {
      const encoded = Buffer.from(character);
      bytes.push(...encoded);
      index += character.length;
      continue;
    }
    index += 1;
    const escaped = raw[index];
    if (escaped === undefined) {
      throw new PatchPromotionError("PATCH_INVALID", "Malformed quoted patch path.");
    }
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    if (escaped in simple) {
      bytes.push(simple[escaped]!);
      index += 1;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      index += 1;
      for (let count = 1; count < 3 && index < raw.length && /[0-7]/.test(raw[index]!); count += 1) {
        octal += raw[index]!;
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    throw new PatchPromotionError("PATCH_INVALID", "Unsupported escape in quoted patch path.");
  }
  if (!closed || (raw.slice(index) && !raw.slice(index).startsWith("\t"))) {
    throw new PatchPromotionError("PATCH_INVALID", "Malformed quoted patch path.");
  }
  return decodeUtf8(Buffer.from(bytes), "Patch path");
}

function inspectPatchText(text: string): string[] {
  if (text.includes("\0")) {
    throw new PatchPromotionError("PATCH_INVALID", "Patch content must not contain NUL bytes.");
  }
  if (
    /^GIT binary patch\r?$/m.test(text) ||
    /^Binary files .+ differ\r?$/m.test(text) ||
    /^(?:literal|delta) [0-9]+\r?$/m.test(text)
  ) {
    throw new PatchPromotionError("PATCH_INVALID", "Binary patches are not promotable.");
  }
  if (
    /^(?:(?:new|deleted) file mode|old mode|new mode) (?:120000|160000)\r?$/m.test(text) ||
    /^index [0-9a-f]+\.\.[0-9a-f]+ (?:120000|160000)\r?$/im.test(text)
  ) {
    throw new PatchPromotionError(
      "PATCH_INVALID",
      "Symlink and submodule patches are not promotable.",
    );
  }

  const headerPaths: string[] = [];
  for (const originalLine of text.split("\n")) {
    const line = originalLine.replace(/\r$/, "");
    let raw: string | undefined;
    let stripPrefix = false;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      raw = line.slice(4);
      stripPrefix = true;
    } else {
      for (const marker of ["rename from ", "rename to ", "copy from ", "copy to "]) {
        if (line.startsWith(marker)) {
          raw = line.slice(marker.length);
          break;
        }
      }
    }
    if (raw === undefined) continue;
    let path = decodeGitQuotedPath(raw);
    if (path === "/dev/null") continue;
    if (stripPrefix && (path.startsWith("a/") || path.startsWith("b/"))) {
      path = path.slice(2);
    }
    headerPaths.push(validateRelativePatchPath(path));
  }
  return headerPaths;
}

function indexOfByte(value: Buffer, byte: number, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === byte) return index;
  }
  return -1;
}

function parseNumstat(output: Buffer): { paths: string[]; binary: boolean } {
  const paths: string[] = [];
  let binary = false;
  let offset = 0;
  while (offset < output.length) {
    const firstTab = indexOfByte(output, 0x09, offset);
    const secondTab = firstTab < 0 ? -1 : indexOfByte(output, 0x09, firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new PatchPromotionError("PATCH_INVALID", "Malformed Git numstat output.");
    }
    const added = output.subarray(offset, firstTab).toString("ascii");
    const deleted = output.subarray(firstTab + 1, secondTab).toString("ascii");
    if (!/^(?:[0-9]+|-)$/.test(added) || !/^(?:[0-9]+|-)$/.test(deleted)) {
      throw new PatchPromotionError("PATCH_INVALID", "Malformed Git numstat metrics.");
    }
    binary ||= added === "-" || deleted === "-";
    offset = secondTab + 1;
    if (output[offset] === 0x00) {
      offset += 1;
      const oldEnd = indexOfByte(output, 0x00, offset);
      if (oldEnd < 0) {
        throw new PatchPromotionError("PATCH_INVALID", "Malformed renamed path in patch.");
      }
      paths.push(decodeUtf8(output.subarray(offset, oldEnd), "Patch path"));
      offset = oldEnd + 1;
      const newEnd = indexOfByte(output, 0x00, offset);
      if (newEnd < 0) {
        throw new PatchPromotionError("PATCH_INVALID", "Malformed renamed path in patch.");
      }
      paths.push(decodeUtf8(output.subarray(offset, newEnd), "Patch path"));
      offset = newEnd + 1;
    } else {
      const pathEnd = indexOfByte(output, 0x00, offset);
      if (pathEnd < 0) {
        throw new PatchPromotionError("PATCH_INVALID", "Malformed path in Git numstat output.");
      }
      paths.push(decodeUtf8(output.subarray(offset, pathEnd), "Patch path"));
      offset = pathEnd + 1;
    }
  }
  return { paths, binary };
}

function parseNulPaths(output: Buffer, label: string): string[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0x00) {
    throw new PatchPromotionError("TARGET_UNSAFE", `Malformed ${label} path output.`);
  }
  const paths: string[] = [];
  let offset = 0;
  for (;;) {
    const end = indexOfByte(output, 0x00, offset);
    if (end < 0) break;
    if (end > offset) paths.push(decodeUtf8(output.subarray(offset, end), label));
    offset = end + 1;
    if (offset >= output.length) break;
  }
  return paths;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  return value;
}

function normalizeStatus(value: unknown, key: string): GitStatusSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  const record = value as Record<string, unknown>;
  const porcelainV1Z = typeof record.porcelainV1Z === "string" ? record.porcelainV1Z : null;
  const digest = typeof record.sha256 === "string" ? record.sha256 : null;
  const clean = typeof record.clean === "boolean" ? record.clean : null;
  if (
    porcelainV1Z === null ||
    digest === null ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    clean === null ||
    clean !== (porcelainV1Z.length === 0) ||
    sha256(Buffer.from(porcelainV1Z, "utf8")) !== digest
  ) {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  return { porcelainV1Z, sha256: digest, clean };
}

function normalizeFingerprint(value: unknown, key: string): AffectedFilesFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.paths) ||
    !Number.isSafeInteger(record.totalBytes) ||
    Number(record.totalBytes) < 0 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256)
  ) {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  const paths: AffectedPathFingerprint[] = record.paths.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
    }
    const item = entry as Record<string, unknown>;
    const path = validateRelativePatchPath(requiredString(item, "path"));
    const kind = item.kind;
    const bytes = item.bytes;
    if (
      (kind !== "file" && kind !== "missing") ||
      !Number.isSafeInteger(bytes) ||
      Number(bytes) < 0
    ) {
      throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
    }
    if (kind === "missing") {
      if (item.sha256 !== null || item.mode !== null || bytes !== 0) {
        throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
      }
      return { path, kind, sha256: null, bytes: 0, mode: null };
    }
    if (
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.mode) ||
      Number(item.mode) < 0 ||
      Number(item.mode) > 0o7777
    ) {
      throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
    }
    return {
      path,
      kind,
      sha256: item.sha256,
      bytes: Number(bytes),
      mode: Number(item.mode),
    };
  });
  if (
    paths.length === 0 ||
    paths.some((entry, index) => index > 0 && paths[index - 1]!.path >= entry.path) ||
    paths.reduce((total, entry) => total + entry.bytes, 0) !== Number(record.totalBytes) ||
    fingerprintDigest(paths) !== record.sha256
  ) {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  return {
    sha256: record.sha256,
    totalBytes: Number(record.totalBytes),
    paths,
  };
}

function normalizeTimestamp(value: unknown, key: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new PatchPromotionError("STORE_CORRUPT", `Promotion record has invalid ${key}.`);
  }
  return value;
}

function normalizePromotionRecord(value: unknown): PatchPromotionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PatchPromotionError("STORE_CORRUPT", "Stored promotion record is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2) {
    throw new PatchPromotionError("STORE_CORRUPT", "Unsupported promotion record schema.");
  }
  const id = requiredString(record, "id");
  assertPromotionId(id);
  const taskId = requiredString(record, "taskId");
  assertSafeTaskId(taskId);
  const origin = requiredString(record, "origin") as Origin;
  if (!(PROVIDERS as readonly string[]).includes(origin)) {
    throw new PatchPromotionError("STORE_CORRUPT", "Promotion record has invalid origin.");
  }
  const state = requiredString(record, "state") as PatchPromotionState;
  const rollbackState = requiredString(
    record,
    "rollbackState",
  ) as PatchPromotionRollbackState;
  const operationPhase = requiredString(
    record,
    "operationPhase",
  ) as PatchPromotionOperationPhase;
  const recoveryState = requiredString(record, "recoveryState") as PatchPromotionRecoveryState;
  if (
    !PATCH_STATES.includes(state) ||
    !ROLLBACK_STATES.includes(rollbackState) ||
    !OPERATION_PHASES.includes(operationPhase) ||
    !RECOVERY_STATES.includes(recoveryState)
  ) {
    throw new PatchPromotionError("STORE_CORRUPT", "Promotion record has invalid state.");
  }
  const affectedPaths = record.affectedPaths;
  if (
    !Array.isArray(affectedPaths) ||
    affectedPaths.length === 0 ||
    affectedPaths.length > 100_000 ||
    !affectedPaths.every((path) => typeof path === "string")
  ) {
    throw new PatchPromotionError("STORE_CORRUPT", "Promotion record has invalid affectedPaths.");
  }
  const normalizedPaths = affectedPaths.map((path) => validateRelativePatchPath(String(path)));
  const patchSha256 = requiredString(record, "patchSha256");
  if (!/^[0-9a-f]{64}$/.test(patchSha256)) {
    throw new PatchPromotionError("STORE_CORRUPT", "Promotion record has invalid patchSha256.");
  }
  const patchBytes = record.patchBytes;
  if (!Number.isSafeInteger(patchBytes) || Number(patchBytes) <= 0) {
    throw new PatchPromotionError("STORE_CORRUPT", "Promotion record has invalid patchBytes.");
  }
  const postStatus =
    record.postStatus === null ? null : normalizeStatus(record.postStatus, "postStatus");
  const preFingerprint = normalizeFingerprint(record.preFingerprint, "preFingerprint");
  const expectedPostFingerprint = normalizeFingerprint(
    record.expectedPostFingerprint,
    "expectedPostFingerprint",
  );
  const postFingerprint =
    record.postFingerprint === null
      ? null
      : normalizeFingerprint(record.postFingerprint, "postFingerprint");
  for (const fingerprint of [
    preFingerprint,
    expectedPostFingerprint,
    ...(postFingerprint ? [postFingerprint] : []),
  ]) {
    if (
      fingerprint.paths.length !== normalizedPaths.length ||
      fingerprint.paths.some((entry, index) => entry.path !== normalizedPaths[index])
    ) {
      throw new PatchPromotionError(
        "STORE_CORRUPT",
        "Promotion fingerprint paths do not match affectedPaths.",
      );
    }
  }
  return {
    schemaVersion: 2,
    id,
    taskId,
    origin,
    state,
    rollbackState,
    operationPhase,
    recoveryState,
    sourceRepo: requiredString(record, "sourceRepo"),
    targetRepo: requiredString(record, "targetRepo"),
    baseCommit: requiredString(record, "baseCommit"),
    patchSha256,
    patchBytes: Number(patchBytes),
    affectedPaths: normalizedPaths,
    preStatus: normalizeStatus(record.preStatus, "preStatus"),
    postStatus,
    preFingerprint,
    expectedPostFingerprint,
    postFingerprint,
    createdAt: normalizeTimestamp(record.createdAt, "createdAt")!,
    updatedAt: normalizeTimestamp(record.updatedAt, "updatedAt")!,
    appliedAt: normalizeTimestamp(record.appliedAt, "appliedAt", true),
    rollbackStartedAt: normalizeTimestamp(
      record.rollbackStartedAt,
      "rollbackStartedAt",
      true,
    ),
    rolledBackAt: normalizeTimestamp(record.rolledBackAt, "rolledBackAt", true),
    error: nullableString(record, "error"),
  };
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new PatchPromotionError(
      "ARTIFACT_UNSAFE",
      `${label} must be a private, non-symlink directory.`,
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new PatchPromotionError("ARTIFACT_UNSAFE", `${label} is owned by another user.`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PatchPromotionError(
      "STORE_CORRUPT",
      `Promotion store path must be a non-symlink directory: ${path}`,
    );
  }
  await chmod(path, 0o700);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new PatchPromotionError("STORE_CORRUPT", "Promotion store is owned by another user.");
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(errorCode(error) ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

async function writeNewPrivateFile(
  path: string,
  contents: Buffer | string,
  mode = 0o600,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(contents);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWritePrivateFile(path: string, contents: Buffer | string): Promise<void> {
  const directory = resolve(path, "..");
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeNewPrivateFile(temporary, contents, 0o600);
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(directory);
  } finally {
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

async function secureReadPrivateFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<{ bytes: Buffer; info: Stats }> {
  const pathInfo = await lstat(path);
  if (
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    pathInfo.nlink !== 1 ||
    (process.platform !== "win32" && (pathInfo.mode & 0o077) !== 0)
  ) {
    throw new PatchPromotionError(
      "ARTIFACT_UNSAFE",
      `${label} must be a private, single-link regular file.`,
    );
  }
  if (typeof process.getuid === "function" && pathInfo.uid !== process.getuid()) {
    throw new PatchPromotionError("ARTIFACT_UNSAFE", `${label} is owned by another user.`);
  }
  if (pathInfo.size <= 0 || pathInfo.size > maximumBytes) {
    throw new PatchPromotionError(
      "ARTIFACT_UNSAFE",
      `${label} exceeds the configured limit of ${maximumBytes} bytes or is empty.`,
    );
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== pathInfo.size ||
      before.ino !== pathInfo.ino ||
      before.dev !== pathInfo.dev
    ) {
      throw new PatchPromotionError("ARTIFACT_UNSAFE", `${label} changed while opening.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs ||
      bytes.length !== before.size
    ) {
      throw new PatchPromotionError("ARTIFACT_UNSAFE", `${label} changed while reading.`);
    }
    return { bytes, info: after };
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class FilePatchPromotionStore {
  readonly directory: string;
  readonly recordsDirectory: string;
  readonly locksDirectory: string;
  private readonly staleLockMs: number;

  constructor(directory = join(stateDirectory(), "patch-promotions"), staleLockMs = DEFAULT_STALE_LOCK_MS) {
    this.directory = resolve(directory);
    this.recordsDirectory = join(this.directory, "records");
    this.locksDirectory = join(this.directory, "locks");
    this.staleLockMs = assertBoundedInteger(
      staleLockMs,
      "staleLockMs",
      1_000,
      24 * 60 * 60_000,
    );
  }

  private async prepare(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    await ensurePrivateDirectory(this.recordsDirectory);
    await ensurePrivateDirectory(this.locksDirectory);
  }

  private recordDirectory(id: string): string {
    assertPromotionId(id);
    return join(this.recordsDirectory, id);
  }

  private recordPath(id: string): string {
    return join(this.recordDirectory(id), "record.json");
  }

  private patchPath(id: string): string {
    return join(this.recordDirectory(id), "patch.patch");
  }

  async create(record: PatchPromotionRecord, patch: Buffer): Promise<void> {
    const normalized = normalizePromotionRecord(record);
    if (patch.length !== normalized.patchBytes || sha256(patch) !== normalized.patchSha256) {
      throw new PatchPromotionError("STORE_CORRUPT", "Promotion patch does not match its record.");
    }
    await this.prepare();
    const target = this.recordDirectory(normalized.id);
    const temporary = join(
      this.recordsDirectory,
      `.${normalized.id}.${randomUUID()}.tmp`,
    );
    let published = false;
    try {
      await mkdir(temporary, { mode: 0o700 });
      await writeNewPrivateFile(
        join(temporary, "record.json"),
        `${JSON.stringify(normalized)}\n`,
      );
      await writeNewPrivateFile(join(temporary, "patch.patch"), patch, 0o400);
      await syncDirectory(temporary);
      await rename(temporary, target);
      published = true;
      await syncDirectory(this.recordsDirectory);
    } finally {
      if (!published) await rm(temporary, { recursive: true, force: true });
    }
  }

  async save(record: PatchPromotionRecord): Promise<void> {
    const normalized = normalizePromotionRecord(record);
    await this.prepare();
    await assertPrivateDirectory(this.recordDirectory(normalized.id), "Promotion directory");
    await atomicWritePrivateFile(
      this.recordPath(normalized.id),
      `${JSON.stringify(normalized)}\n`,
    );
  }

  async get(id: string): Promise<PatchPromotionRecord | undefined> {
    assertPromotionId(id);
    await this.prepare();
    const directory = this.recordDirectory(id);
    try {
      await assertPrivateDirectory(directory, "Promotion directory");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    const { bytes } = await secureReadPrivateFile(
      this.recordPath(id),
      MAX_RECORD_BYTES,
      "Promotion record",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeUtf8(bytes, "Promotion record"));
    } catch (error) {
      if (error instanceof PatchPromotionError) throw error;
      throw new PatchPromotionError("STORE_CORRUPT", "Promotion record is not valid JSON.", {
        cause: error,
      });
    }
    const record = normalizePromotionRecord(parsed);
    if (record.id !== id) {
      throw new PatchPromotionError("STORE_CORRUPT", "Promotion record ID does not match its path.");
    }
    return cloneRecord(record);
  }

  async list(): Promise<PatchPromotionRecord[]> {
    await this.prepare();
    const entries = await readdir(this.recordsDirectory, { withFileTypes: true });
    const records: PatchPromotionRecord[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROMOTION_ID_PATTERN.test(entry.name)) {
        throw new PatchPromotionError(
          "STORE_CORRUPT",
          "Promotion store contains an unexpected entry.",
        );
      }
      const record = await this.get(entry.name);
      if (!record) {
        throw new PatchPromotionError("STORE_CORRUPT", "Promotion record disappeared while listing.");
      }
      records.push(record);
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async readPatch(record: PatchPromotionRecord): Promise<Buffer> {
    await this.prepare();
    const current = await this.get(record.id);
    if (!current || current.patchSha256 !== record.patchSha256) {
      throw new PatchPromotionError("STORE_CORRUPT", "Stored promotion metadata changed.");
    }
    const { bytes } = await secureReadPrivateFile(
      this.patchPath(record.id),
      record.patchBytes,
      "Stored promotion patch",
    );
    if (bytes.length !== record.patchBytes || sha256(bytes) !== record.patchSha256) {
      throw new PatchPromotionError("STORE_CORRUPT", "Stored promotion patch failed verification.");
    }
    return bytes;
  }

  async withRepositoryLock<T>(targetRepo: string, operation: () => Promise<T>): Promise<T> {
    await this.prepare();
    const lockName = `${sha256(targetRepo)}.lock`;
    const lockPath = join(this.locksDirectory, lockName);
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeNewPrivateFile(
            join(lockPath, "owner.json"),
            `${JSON.stringify(owner)}\n`,
          );
          await syncDirectory(lockPath);
          acquired = true;
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const lockInfo = await lstat(lockPath);
        if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) {
          throw new PatchPromotionError("STORE_CORRUPT", "Promotion lock path is unsafe.");
        }
        let existing: LockOwner | undefined;
        try {
          const { bytes } = await secureReadPrivateFile(
            join(lockPath, "owner.json"),
            16 * 1024,
            "Promotion lock owner",
          );
          const parsed = JSON.parse(decodeUtf8(bytes, "Promotion lock owner")) as Partial<LockOwner>;
          if (
            Number.isSafeInteger(parsed.pid) &&
            typeof parsed.token === "string" &&
            typeof parsed.acquiredAt === "string"
          ) {
            existing = {
              pid: Number(parsed.pid),
              token: parsed.token,
              acquiredAt: parsed.acquiredAt,
            };
          }
        } catch (readError) {
          if (errorCode(readError) !== "ENOENT") throw readError;
        }
        const age = Date.now() - lockInfo.mtimeMs;
        if (
          age < this.staleLockMs ||
          (existing !== undefined && isProcessAlive(existing.pid))
        ) {
          throw new PatchPromotionLockError(targetRepo);
        }
        const stalePath = join(
          this.locksDirectory,
          `.${lockName}.${randomUUID()}.stale`,
        );
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
        } catch (reclaimError) {
          if (["ENOENT", "EEXIST"].includes(errorCode(reclaimError) ?? "")) continue;
          throw reclaimError;
        }
      }
    }
    if (!acquired) throw new PatchPromotionLockError(targetRepo);

    try {
      return await operation();
    } finally {
      try {
        const { bytes } = await secureReadPrivateFile(
          join(lockPath, "owner.json"),
          16 * 1024,
          "Promotion lock owner",
        );
        const current = JSON.parse(decodeUtf8(bytes, "Promotion lock owner")) as Partial<LockOwner>;
        if (current.token === owner.token && current.pid === owner.pid) {
          await rm(lockPath, { recursive: true, force: true });
          await syncDirectory(this.locksDirectory);
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

export class PatchPromotionService {
  readonly origin: Origin;
  readonly store: FilePatchPromotionStore;
  private readonly lookup: PatchPromotionTaskSource;
  private readonly artifactsDirectory: string;
  private readonly allowedRoots: readonly string[];
  private readonly maxPatchBytes: number;
  private readonly maxFingerprintBytes: number;
  private readonly gitTimeoutMs: number;
  private readonly inFlight = new Set<Promise<unknown>>();
  private recoveryPromise: Promise<PatchPromotionRecoveryReport> | undefined;
  private closing = false;

  constructor(options: PatchPromotionServiceOptions) {
    this.origin = options.origin;
    const lookup = options.taskLookup ?? options.registry;
    if (!lookup) {
      throw new PatchPromotionError(
        "INVALID_INPUT",
        "PatchPromotionService requires taskLookup or registry.",
      );
    }
    this.lookup = lookup;
    this.artifactsDirectory = resolve(
      options.artifactsDirectory ?? join(stateDirectory(), "tasks"),
    );
    this.allowedRoots = [...(options.allowedRoots ?? configuredRoots())];
    this.maxPatchBytes = assertBoundedInteger(
      options.maxPatchBytes ??
        Number(process.env.AGENT_MESH_MAX_PATCH_BYTES || DEFAULT_MAX_PATCH_BYTES),
      "maxPatchBytes",
      1,
      1024 * 1024 * 1024,
    );
    this.maxFingerprintBytes = assertBoundedInteger(
      options.maxFingerprintBytes ??
        Number(
          process.env.AGENT_MESH_MAX_PROMOTION_FINGERPRINT_BYTES ||
            DEFAULT_MAX_FINGERPRINT_BYTES,
        ),
      "maxFingerprintBytes",
      1,
      16 * 1024 * 1024 * 1024,
    );
    this.gitTimeoutMs = assertBoundedInteger(
      options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      "gitTimeoutMs",
      1_000,
      10 * 60_000,
    );
    this.store = new FilePatchPromotionStore(
      options.storeDirectory,
      options.staleLockMs,
    );
  }

  private async getTask(taskId: string): Promise<TaskRecord> {
    assertSafeTaskId(taskId);
    const task =
      typeof this.lookup === "function"
        ? await this.lookup(taskId)
        : await this.lookup.get(taskId);
    if (!task) {
      throw new PatchPromotionError("NOT_FOUND", `Unknown task: ${taskId}`);
    }
    if (task.id !== taskId) {
      throw new PatchPromotionError("ARTIFACT_UNSAFE", "Task lookup returned a mismatched ID.");
    }
    if (task.origin !== this.origin) {
      throw new PatchPromotionError(
        "ORIGIN_MISMATCH",
        "Task belongs to another mesh origin.",
      );
    }
    return task;
  }

  private async git(
    args: readonly string[],
    cwd: string,
    input?: Buffer,
  ): Promise<GitOutput> {
    return runGit(args, cwd, {
      input,
      timeoutMs: this.gitTimeoutMs,
    });
  }

  private async checkedGit(
    operation: string,
    args: readonly string[],
    cwd: string,
    input?: Buffer,
  ): Promise<GitOutput> {
    const result = await this.git(args, cwd, input);
    if (result.code !== 0) throw checkedGitError(operation, result);
    return result;
  }

  private async validateRepositoryConfig(repoRoot: string): Promise<void> {
    const result = await this.git(
      [
        "config",
        "--local",
        "--includes",
        "--get-regexp",
        "^(include|includeIf\\.|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv)|core\\.(fsmonitor|hooksPath|worktree))",
      ],
      repoRoot,
    );
    if (result.code !== 0 && result.code !== 1) {
      throw checkedGitError("config inspection", result);
    }
    if (result.code === 0 && result.stdout.length > 0) {
      throw new PatchPromotionError(
        "TARGET_UNSAFE",
        "Target repository has executable or redirecting local Git configuration.",
      );
    }
  }

  private async canonicalTarget(task: TaskRecord, requestedTarget: string): Promise<string> {
    if (!requestedTarget || typeof requestedTarget !== "string") {
      throw new PatchPromotionError("INVALID_INPUT", "targetRepo is required.");
    }
    if (!task.repoRoot || !task.baseCommit || !/^[0-9a-f]{40,64}$/i.test(task.baseCommit)) {
      throw new PatchPromotionError(
        "ARTIFACT_UNSAFE",
        "Task is missing a valid source repository or base commit.",
      );
    }
    const candidate = await canonicalizeAllowedCwd(requestedTarget, [...this.allowedRoots]);
    const rootResult = await this.checkedGit(
      "repository discovery",
      ["rev-parse", "--show-toplevel"],
      candidate,
    );
    const discovered = decodeUtf8(rootResult.stdout, "Repository path").trim();
    const targetRepo = await realpath(discovered);
    if (!isWithin(targetRepo, candidate)) {
      throw new PatchPromotionError(
        "TARGET_UNSAFE",
        "Requested target is not contained by its canonical Git repository.",
      );
    }
    const sourceRepo = await realpath(task.repoRoot);
    if (sourceRepo !== targetRepo) {
      throw new PatchPromotionError(
        "TARGET_UNSAFE",
        "Target repository does not match the task's canonical source repository.",
      );
    }
    const rootInfo = await lstat(targetRepo);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new PatchPromotionError(
        "TARGET_UNSAFE",
        "Target repository root must be a non-symlink directory.",
      );
    }
    await this.validateRepositoryConfig(targetRepo);
    return targetRepo;
  }

  private async loadArtifact(task: TaskRecord): Promise<LoadedArtifact> {
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new PatchPromotionError(
        "ARTIFACT_UNSAFE",
        "Only terminal tasks can promote captured patches.",
      );
    }
    if (
      task.artifactStatus !== "captured" ||
      !task.patchPath ||
      !task.baseCommit ||
      task.changedFiles.length === 0
    ) {
      throw new PatchPromotionError(
        "ARTIFACT_UNSAFE",
        "Task does not have a captured patch artifact.",
      );
    }
    const expectedTaskDirectory = join(this.artifactsDirectory, task.id);
    const expectedPatchPath = join(expectedTaskDirectory, "changes.patch");
    if (resolve(task.patchPath) !== expectedPatchPath) {
      throw new PatchPromotionError(
        "ARTIFACT_UNSAFE",
        "Captured patch is outside the task's private artifact directory.",
      );
    }
    await assertPrivateDirectory(this.artifactsDirectory, "Task artifact root");
    await assertPrivateDirectory(expectedTaskDirectory, "Task artifact directory");

    const first = await secureReadPrivateFile(
      expectedPatchPath,
      this.maxPatchBytes,
      "Captured patch",
    );
    const capturedAt = Date.parse(task.updatedAt);
    const mtimeGrace = process.platform === "win32" ? 1000 : 1;
    if (Number.isFinite(capturedAt) && first.info.mtimeMs > capturedAt + mtimeGrace) {
      throw new PatchPromotionError(
        "ARTIFACT_UNSAFE",
        "Captured patch was modified after the task record was finalized.",
      );
    }
    if (task.worktreePath) {
      try {
        await verifyWorktreeArtifacts(
          task.worktreePath,
          task.baseCommit,
          "captured",
          expectedPatchPath,
        );
      } catch (error) {
        if (error instanceof PatchPromotionError) throw error;
        throw new PatchPromotionError(
          "ARTIFACT_UNSAFE",
          error instanceof Error ? error.message : "Worktree artifact verification failed.",
        );
      }
      const second = await secureReadPrivateFile(
        expectedPatchPath,
        this.maxPatchBytes,
        "Captured patch",
      );
      if (
        first.info.ino !== second.info.ino ||
        first.info.dev !== second.info.dev ||
        first.info.mtimeMs !== second.info.mtimeMs ||
        !first.bytes.equals(second.bytes)
      ) {
        throw new PatchPromotionError(
          "ARTIFACT_UNSAFE",
          "Captured patch changed during worktree verification.",
        );
      }
    }
    const text = decodeUtf8(first.bytes, "Captured patch");
    if (!text.endsWith("\n")) {
      throw new PatchPromotionError(
        "PATCH_INVALID",
        "Captured patch must end with a newline.",
      );
    }
    return {
      bytes: first.bytes,
      text,
      sha256: sha256(first.bytes),
    };
  }

  private async inspectPatch(
    task: TaskRecord,
    targetRepo: string,
    artifact: LoadedArtifact,
  ): Promise<string[]> {
    const headerPaths = inspectPatchText(artifact.text);
    const result = await this.git(
      ["apply", "--numstat", "-z"],
      targetRepo,
      artifact.bytes,
    );
    if (result.code !== 0) {
      throw new PatchPromotionError(
        "PATCH_INVALID",
        `Captured patch could not be parsed by Git${
          result.stderr ? `: ${redactSecrets(result.stderr).slice(0, 2_000)}` : ""
        }`,
      );
    }
    const numstat = parseNumstat(result.stdout);
    if (numstat.binary) {
      throw new PatchPromotionError("PATCH_INVALID", "Binary patches are not promotable.");
    }
    const affectedPaths = [
      ...new Set([...headerPaths, ...numstat.paths].map(validateRelativePatchPath)),
    ].sort();
    if (affectedPaths.length === 0) {
      throw new PatchPromotionError("PATCH_INVALID", "Patch does not affect any files.");
    }
    const affected = new Set(affectedPaths);
    for (const changedFile of task.changedFiles) {
      const normalized = validateRelativePatchPath(changedFile);
      if (!affected.has(normalized)) {
        throw new PatchPromotionError(
          "ARTIFACT_UNSAFE",
          "Captured patch paths do not match the task's recorded changed files.",
        );
      }
    }
    return affectedPaths;
  }

  private async assertNoSymlinks(repoRoot: string, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      const validated = validateRelativePatchPath(path);
      const candidate = resolve(repoRoot, validated);
      if (!isWithin(repoRoot, candidate)) {
        throw new PatchPromotionError("PATCH_INVALID", "Patch path escapes target repository.");
      }
      let current = repoRoot;
      const segments = validated.split("/");
      for (let index = 0; index < segments.length; index += 1) {
        current = join(current, segments[index]!);
        try {
          const info = await lstat(current);
          if (info.isSymbolicLink()) {
            throw new PatchPromotionError(
              "PATCH_INVALID",
              `Patch path traverses a symlink: ${validated}`,
            );
          }
          if (index < segments.length - 1 && !info.isDirectory()) {
            throw new PatchPromotionError(
              "PATCH_INVALID",
              `Patch path traverses a non-directory: ${validated}`,
            );
          }
        } catch (error) {
          if (errorCode(error) === "ENOENT") break;
          throw error;
        }
      }
    }
  }

  private async fingerprintPaths(
    repoRoot: string,
    paths: readonly string[],
  ): Promise<AffectedFilesFingerprint> {
    const fingerprints: AffectedPathFingerprint[] = [];
    let totalBytes = 0;
    for (const path of [...paths].sort()) {
      const validated = validateRelativePatchPath(path);
      const candidate = resolve(repoRoot, validated);
      if (!isWithin(repoRoot, candidate)) {
        throw new PatchPromotionError("TARGET_UNSAFE", "Fingerprint path escapes repository.");
      }
      let pathInfo: Stats;
      try {
        pathInfo = await lstat(candidate);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          fingerprints.push({
            path: validated,
            kind: "missing",
            sha256: null,
            bytes: 0,
            mode: null,
          });
          continue;
        }
        throw error;
      }
      if (
        !pathInfo.isFile() ||
        pathInfo.isSymbolicLink() ||
        pathInfo.nlink !== 1
      ) {
        throw new PatchPromotionError(
          "TARGET_UNSAFE",
          `Affected path must be a single-link regular file: ${validated}`,
        );
      }
      totalBytes += pathInfo.size;
      if (totalBytes > this.maxFingerprintBytes) {
        throw new PatchPromotionError(
          "TARGET_UNSAFE",
          `Affected file content exceeds the fingerprint limit of ${this.maxFingerprintBytes} bytes.`,
        );
      }
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.ino !== pathInfo.ino ||
          before.dev !== pathInfo.dev ||
          before.size !== pathInfo.size
        ) {
          throw new PatchPromotionError(
            "TARGET_UNSAFE",
            `Affected path changed while opening: ${validated}`,
          );
        }
        const digest = createHash("sha256");
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(
            chunk,
            0,
            chunk.length,
            position,
          );
          if (bytesRead === 0) break;
          digest.update(chunk.subarray(0, bytesRead));
          position += bytesRead;
        }
        const after = await handle.stat();
        if (
          position !== before.size ||
          after.size !== before.size ||
          after.ino !== before.ino ||
          after.dev !== before.dev ||
          after.mtimeMs !== before.mtimeMs ||
          after.mode !== before.mode
        ) {
          throw new PatchPromotionError(
            "TARGET_UNSAFE",
            `Affected path changed while fingerprinting: ${validated}`,
          );
        }
        fingerprints.push({
          path: validated,
          kind: "file",
          sha256: digest.digest("hex"),
          bytes: position,
          mode:
            process.platform === "win32"
              ? (before.mode & 0o111 ? 0o755 : 0o644)
              : before.mode & 0o7777,
        });
      } finally {
        await handle.close();
      }
    }
    return {
      sha256: fingerprintDigest(fingerprints),
      totalBytes,
      paths: fingerprints,
    };
  }

  private async fingerprintCommitPaths(
    repoRoot: string,
    commit: string,
    paths: readonly string[],
  ): Promise<AffectedFilesFingerprint> {
    const fingerprints: AffectedPathFingerprint[] = [];
    let totalBytes = 0;
    for (const path of [...paths].sort()) {
      const validated = validateRelativePatchPath(path);
      const treeEntry = await this.checkedGit(
        "base tree inspection",
        ["ls-tree", "-z", commit, "--", validated],
        repoRoot,
      );
      if (treeEntry.stdout.length === 0) {
        fingerprints.push({
          path: validated,
          kind: "missing",
          sha256: null,
          bytes: 0,
          mode: null,
        });
        continue;
      }
      if (treeEntry.stdout[treeEntry.stdout.length - 1] !== 0x00) {
        throw new PatchPromotionError(
          "ARTIFACT_UNSAFE",
          `Base tree returned malformed data for ${validated}.`,
        );
      }
      const decoded = decodeUtf8(
        treeEntry.stdout.subarray(0, -1),
        "Base tree entry",
      );
      const tab = decoded.indexOf("\t");
      const metadata = decoded.slice(0, tab).split(" ");
      if (
        tab < 0 ||
        decoded.slice(tab + 1) !== validated ||
        metadata.length !== 3 ||
        metadata[1] !== "blob" ||
        !/^[0-9a-f]{40,64}$/i.test(metadata[2]!)
      ) {
        throw new PatchPromotionError(
          "ARTIFACT_UNSAFE",
          `Base tree has an unsupported entry for ${validated}.`,
        );
      }
      const mode =
        metadata[0] === "100755"
          ? 0o755
          : metadata[0] === "100644"
            ? 0o644
            : null;
      if (mode === null) {
        throw new PatchPromotionError(
          "ARTIFACT_UNSAFE",
          `Base tree has an unsupported file mode for ${validated}.`,
        );
      }
      const contents = (
        await this.checkedGit(
          "base blob inspection",
          ["cat-file", "blob", metadata[2]!],
          repoRoot,
        )
      ).stdout;
      totalBytes += contents.length;
      if (totalBytes > this.maxFingerprintBytes) {
        throw new PatchPromotionError(
          "TARGET_UNSAFE",
          `Affected file content exceeds the fingerprint limit of ${this.maxFingerprintBytes} bytes at ${validated}.`,
        );
      }
      fingerprints.push({
        path: validated,
        kind: "file",
        sha256: sha256(contents),
        bytes: contents.length,
        mode,
      });
    }
    return {
      sha256: fingerprintDigest(fingerprints),
      totalBytes,
      paths: fingerprints,
    };
  }

  private async simulatePostFingerprint(
    targetRepo: string,
    paths: readonly string[],
    patch: Buffer,
    preFingerprint: AffectedFilesFingerprint,
  ): Promise<AffectedFilesFingerprint> {
    await ensurePrivateDirectory(this.store.directory);
    const scratch = join(this.store.directory, `.simulation-${randomUUID()}`);
    await mkdir(scratch, { mode: 0o700 });
    try {
      for (const entry of preFingerprint.paths) {
        if (entry.kind === "missing") continue;
        const source = resolve(targetRepo, entry.path);
        const destination = resolve(scratch, entry.path);
        if (!isWithin(scratch, destination)) {
          throw new PatchPromotionError("TARGET_UNSAFE", "Simulation path escapes scratch root.");
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        await chmod(destination, entry.mode!);
      }
      const copiedFingerprint = await this.fingerprintPaths(scratch, paths);
      if (!sameFingerprint(copiedFingerprint, preFingerprint)) {
        throw new PatchPromotionError(
          "TARGET_UNSAFE",
          "Affected files changed while preparing the patch simulation.",
        );
      }
      await this.checkApply(scratch, patch);
      await this.checkedGit(
        "isolated patch simulation",
        ["apply", "--whitespace=warn"],
        scratch,
        patch,
      );
      await this.assertNoSymlinks(scratch, paths);
      return await this.fingerprintPaths(scratch, paths);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async head(repoRoot: string): Promise<string> {
    const result = await this.checkedGit(
      "HEAD inspection",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      repoRoot,
    );
    return decodeUtf8(result.stdout, "Git HEAD").trim();
  }

  private async status(repoRoot: string): Promise<GitStatusSnapshot> {
    const result = await this.checkedGit(
      "status inspection",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      repoRoot,
    );
    return statusSnapshot(result.stdout);
  }

  private async changedPaths(repoRoot: string): Promise<{
    all: string[];
    index: string[];
  }> {
    const [working, index, untracked] = await Promise.all([
      this.checkedGit("working tree inspection", ["diff", "--name-only", "-z", "--"], repoRoot),
      this.checkedGit(
        "index inspection",
        ["diff", "--cached", "--name-only", "-z", "--"],
        repoRoot,
      ),
      this.checkedGit(
        "untracked file inspection",
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
        repoRoot,
      ),
    ]);
    const indexPaths = parseNulPaths(index.stdout, "index").map(validateRelativePatchPath);
    const all = [
      ...new Set(
        [
          ...parseNulPaths(working.stdout, "working tree"),
          ...indexPaths,
          ...parseNulPaths(untracked.stdout, "untracked"),
        ].map(validateRelativePatchPath),
      ),
    ].sort();
    return { all, index: [...new Set(indexPaths)].sort() };
  }

  // MESH[2026-07-25T20:40Z][agent:codex][direction:user/2]
  // What: replaces repository-wide cleanliness and HEAD equality with exact affected-path preconditions.
  // Why: unrelated commits and dirty files are safe when the patch's base images and touched paths have not drifted.
  // Aligns-with: direction user revision 2 (path-precise promotion with named conflicts).
  // Status: complete
  private async assertPathPreconditions(
    task: TaskRecord,
    targetRepo: string,
    affectedPaths: readonly string[],
  ): Promise<{
    snapshot: GitStatusSnapshot;
    changed: { all: string[]; index: string[] };
    fingerprint: AffectedFilesFingerprint;
  }> {
    const [snapshot, changed, expectedFingerprint] = await Promise.all([
      this.status(targetRepo),
      this.changedPaths(targetRepo),
      this.fingerprintCommitPaths(
        targetRepo,
        task.baseCommit!,
        affectedPaths,
      ),
    ]);
    const affected = new Set(affectedPaths);
    const intersections = changed.all.filter((path) => affected.has(path));
    if (intersections.length > 0) {
      throw new PatchPromotionError(
        "DIRTY_TARGET",
        `Target has dirty affected paths: ${intersections.join(", ")}.`,
      );
    }
    const fingerprint = await this.fingerprintPaths(targetRepo, affectedPaths);
    const drifted = fingerprintDriftPaths(expectedFingerprint, fingerprint);
    if (drifted.length > 0) {
      throw new PatchPromotionError(
        "DIRTY_TARGET",
        `Target affected paths do not match the patch pre-image: ${drifted.join(", ")}.`,
      );
    }
    return { snapshot, changed, fingerprint };
  }

  private async checkApply(
    targetRepo: string,
    patch: Buffer,
    reverse = false,
  ): Promise<void> {
    const args = reverse
      ? ["apply", "--check", "--reverse", "--whitespace=warn"]
      : ["apply", "--check", "--whitespace=warn"];
    const result = await this.git(args, targetRepo, patch);
    if (result.code !== 0) {
      throw new PatchPromotionError(
        reverse ? "ROLLBACK_UNSAFE" : "APPLY_FAILED",
        `Git apply ${reverse ? "reverse " : ""}check failed${
          result.stderr ? `: ${redactSecrets(result.stderr).slice(0, 2_000)}` : ""
        }`,
      );
    }
  }

  private async prepare(taskId: string, requestedTarget: string): Promise<PreparedPromotion> {
    const task = await this.getTask(taskId);
    const targetRepo = await this.canonicalTarget(task, requestedTarget);
    const sourceRepo = await realpath(task.repoRoot!);
    const artifact = await this.loadArtifact(task);
    const affectedPaths = await this.inspectPatch(task, targetRepo, artifact);
    await this.assertNoSymlinks(targetRepo, affectedPaths);
    const preconditions = await this.assertPathPreconditions(
      task,
      targetRepo,
      affectedPaths,
    );
    const preStatus = preconditions.snapshot;
    await this.checkApply(targetRepo, artifact.bytes);
    const preFingerprint = preconditions.fingerprint;
    const expectedPostFingerprint = await this.simulatePostFingerprint(
      targetRepo,
      affectedPaths,
      artifact.bytes,
      preFingerprint,
    );
    const statusAfterSimulation = await this.status(targetRepo);
    const fingerprintAfterSimulation = await this.fingerprintPaths(
      targetRepo,
      affectedPaths,
    );
    if (
      !sameStatus(statusAfterSimulation, preStatus) ||
      !sameFingerprint(fingerprintAfterSimulation, preFingerprint)
    ) {
      throw new PatchPromotionError(
        "DIRTY_TARGET",
        "Target changed while computing the expected patch result.",
      );
    }
    return {
      task,
      sourceRepo,
      targetRepo,
      artifact,
      affectedPaths,
      preStatus,
      preChangedPaths: preconditions.changed,
      preFingerprint,
      expectedPostFingerprint,
    };
  }

  private async canonicalStoredTarget(record: PatchPromotionRecord): Promise<string> {
    const candidate = await canonicalizeAllowedCwd(record.targetRepo, [
      ...this.allowedRoots,
    ]);
    const discovered = await this.checkedGit(
      "repository discovery",
      ["rev-parse", "--show-toplevel"],
      candidate,
    );
    const targetRepo = await realpath(
      decodeUtf8(discovered.stdout, "Repository path").trim(),
    );
    if (candidate !== targetRepo || record.targetRepo !== targetRepo) {
      throw new PatchPromotionError(
        "TARGET_UNSAFE",
        "Stored target repository is not its canonical Git root.",
      );
    }
    await this.validateRepositoryConfig(targetRepo);
    return targetRepo;
  }

  private needsAttentionRecord(
    record: PatchPromotionRecord,
    error: unknown,
  ): PatchPromotionRecord {
    const now = new Date().toISOString();
    return {
      ...record,
      state: "needs_attention",
      rollbackState: "needs_attention",
      operationPhase: "needs_attention",
      recoveryState: "needs_attention",
      updatedAt: now,
      error: safeError(error),
    };
  }

  private async reconcileRecordLocked(
    original: PatchPromotionRecord,
    targetRepo: string,
  ): Promise<PatchPromotionRecord> {
    const current = await this.store.get(original.id);
    if (!current) {
      throw new PatchPromotionError(
        "STORE_CORRUPT",
        `Promotion disappeared during recovery: ${original.id}`,
      );
    }
    if (current.origin !== this.origin || current.targetRepo !== targetRepo) {
      throw new PatchPromotionError(
        "STORE_CORRUPT",
        "Promotion identity changed during recovery.",
      );
    }
    if (current.state === "applied") {
      const targetStatus = await this.status(targetRepo);
      const targetFingerprint = await this.fingerprintPaths(
        targetRepo,
        current.affectedPaths,
      );
      const dirty = statusChangedPaths(targetStatus);
      const affected = new Set(current.affectedPaths);
      if (
        dirty.all.every((path) => !affected.has(path)) &&
        sameFingerprint(
          targetFingerprint,
          current.expectedPostFingerprint,
        )
      ) {
        const committedAt = new Date().toISOString();
        const committed: PatchPromotionRecord = {
          ...current,
          state: "committed",
          rollbackState: "not_available",
          operationPhase: "stable_committed",
          recoveryState: "none",
          updatedAt: committedAt,
          error: null,
        };
        await this.store.save(committed);
        return committed;
      }
    }
    if (current.state !== "applying" && current.state !== "rolling_back") {
      return current;
    }

    try {
      await this.assertNoSymlinks(targetRepo, current.affectedPaths);
      const patch = await this.store.readPatch(current);
      const targetStatus = await this.status(targetRepo);
      const targetFingerprint = await this.fingerprintPaths(
        targetRepo,
        current.affectedPaths,
      );
      const matchesPre =
        sameStatus(targetStatus, current.preStatus) &&
        sameFingerprint(targetFingerprint, current.preFingerprint);
      const matchesExpectedPost =
        !targetStatus.clean &&
        preservesDisjointStatus(
          current.preStatus,
          targetStatus,
          current.affectedPaths,
        ) &&
        sameFingerprint(
          targetFingerprint,
          current.expectedPostFingerprint,
        );
      const matchesRecordedPost =
        current.postStatus !== null &&
        current.postFingerprint !== null &&
        sameStatus(targetStatus, current.postStatus) &&
        sameFingerprint(targetFingerprint, current.postFingerprint);
      const recoveredAt = new Date().toISOString();

      if (current.state === "applying") {
        if (matchesPre) {
          const recovered: PatchPromotionRecord = {
            ...current,
            state: "failed",
            rollbackState: "not_available",
            operationPhase: "stable_failed",
            recoveryState: "recovered_not_applied",
            postStatus: targetStatus,
            postFingerprint: targetFingerprint,
            updatedAt: recoveredAt,
            error: "Recovered interrupted apply before repository mutation completed.",
          };
          await this.store.save(recovered);
          return recovered;
        }
        if (matchesExpectedPost) {
          await this.checkApply(targetRepo, patch, true);
          const recovered: PatchPromotionRecord = {
            ...current,
            state: "applied",
            rollbackState: "available",
            operationPhase: "stable_applied",
            recoveryState: "recovered_applied",
            postStatus: targetStatus,
            postFingerprint: targetFingerprint,
            appliedAt: current.appliedAt ?? recoveredAt,
            updatedAt: recoveredAt,
            error: null,
          };
          await this.store.save(recovered);
          return recovered;
        }
        throw new PatchPromotionError(
          "APPLY_FAILED",
          "Interrupted apply left content that matches neither pre-apply nor expected post-apply state.",
        );
      }

      if (matchesPre) {
        const recovered: PatchPromotionRecord = {
          ...current,
          state: "rolled_back",
          rollbackState: "rolled_back",
          operationPhase: "stable_rolled_back",
          recoveryState: "recovered_rolled_back",
          rolledBackAt: current.rolledBackAt ?? recoveredAt,
          updatedAt: recoveredAt,
          error: null,
        };
        await this.store.save(recovered);
        return recovered;
      }
      if (matchesRecordedPost) {
        await this.checkApply(targetRepo, patch, true);
        const recovered: PatchPromotionRecord = {
          ...current,
          state: "applied",
          rollbackState: "available",
          operationPhase: "stable_applied",
          recoveryState: "recovered_applied",
          updatedAt: recoveredAt,
          error: null,
        };
        await this.store.save(recovered);
        return recovered;
      }
      throw new PatchPromotionError(
        "ROLLBACK_UNSAFE",
        "Interrupted rollback left content that matches neither recorded post-apply nor pre-apply state.",
      );
    } catch (error) {
      const needsAttention = this.needsAttentionRecord(current, error);
      await this.store.save(needsAttention);
      return needsAttention;
    }
  }

  private async reconcileTargetRecordsLocked(
    targetRepo: string,
  ): Promise<PatchPromotionRecord[]> {
    const targetRecords = (await this.store.list()).filter(
      (record) =>
        record.origin === this.origin &&
        record.targetRepo === targetRepo,
    );
    const interrupted = targetRecords.filter(
      (record) =>
        record.state === "applying" || record.state === "rolling_back",
    );
    if (interrupted.length > 1) {
      const recovered: PatchPromotionRecord[] = [];
      for (const record of interrupted) {
        const needsAttention = this.needsAttentionRecord(
          record,
          new Error("Multiple interrupted promotions target the same repository."),
        );
        await this.store.save(needsAttention);
        recovered.push(needsAttention);
      }
      return recovered;
    }
    if (interrupted.length === 1) {
      return [
        await this.reconcileRecordLocked(interrupted[0]!, targetRepo),
      ];
    }
    const reconciled: PatchPromotionRecord[] = [];
    for (const record of targetRecords.filter(
      (candidate) => candidate.state === "applied",
    )) {
      reconciled.push(await this.reconcileRecordLocked(record, targetRepo));
    }
    return reconciled;
  }

  private async recoverAllInternal(): Promise<PatchPromotionRecoveryReport> {
    const interrupted = (await this.store.list()).filter(
      (record) =>
        record.origin === this.origin &&
        (record.state === "applying" || record.state === "rolling_back"),
    );
    const report: PatchPromotionRecoveryReport = {
      scanned: interrupted.length,
      recovered: [],
      pending: [],
      needsAttention: [],
    };
    const byTarget = new Map<string, PatchPromotionRecord[]>();
    for (const record of interrupted) {
      const records = byTarget.get(record.targetRepo) ?? [];
      records.push(record);
      byTarget.set(record.targetRepo, records);
    }
    for (const records of byTarget.values()) {
      const first = records[0]!;
      try {
        const targetRepo = await this.canonicalStoredTarget(first);
        const reconciled = await this.store.withRepositoryLock(
          targetRepo,
          () => this.reconcileTargetRecordsLocked(targetRepo),
        );
        for (const record of reconciled) {
          report.recovered.push(record);
          if (record.recoveryState === "needs_attention") {
            report.needsAttention.push(record.id);
          }
        }
      } catch (error) {
        if (error instanceof PatchPromotionLockError) {
          report.pending.push(...records.map((record) => record.id));
          continue;
        }
        for (const record of records) {
          const needsAttention = this.needsAttentionRecord(record, error);
          await this.store.save(needsAttention);
          report.recovered.push(needsAttention);
          report.needsAttention.push(needsAttention.id);
        }
      }
    }
    return report;
  }

  private async ensureRecovered(): Promise<void> {
    this.recoveryPromise ??= this.recoverAllInternal()
      .finally(() => {
        this.recoveryPromise = undefined;
      });
    await this.recoveryPromise;
  }

  private async activePromotion(
    taskId: string,
    targetRepo: string,
  ): Promise<PatchPromotionRecord | undefined> {
    return (await this.store.list()).find(
      (record) =>
        record.origin === this.origin &&
        record.taskId === taskId &&
        record.targetRepo === targetRepo &&
        !inactivePromotion(record),
    );
  }

  private async assertNoActiveTargetPromotion(
    taskId: string,
    targetRepo: string,
  ): Promise<void> {
    const active = (await this.store.list()).find(
      (record) =>
        record.origin === this.origin &&
        record.targetRepo === targetRepo &&
        !inactivePromotion(record),
    );
    if (!active) return;
    const detail =
      active.taskId === taskId
        ? `Task ${taskId} already has promotion ${active.id}.`
        : `Target repository already has unresolved promotion ${active.id}.`;
    throw new PatchPromotionError("DUPLICATE", detail);
  }

  private async previewInternal(
    input: PreviewPatchPromotionInput,
  ): Promise<PatchPromotionPreview> {
    const task = await this.getTask(input.taskId);
    const targetRepo = await this.canonicalTarget(task, input.targetRepo);
    return this.store.withRepositoryLock(targetRepo, async () => {
      await this.reconcileTargetRecordsLocked(targetRepo);
      const prepared = await this.prepare(input.taskId, targetRepo);
      const active = await this.activePromotion(
        prepared.task.id,
        prepared.targetRepo,
      );
      return {
        taskId: prepared.task.id,
        origin: this.origin,
        sourceRepo: prepared.sourceRepo,
        targetRepo: prepared.targetRepo,
        baseCommit: prepared.task.baseCommit!,
        patchSha256: prepared.artifact.sha256,
        patchBytes: prepared.artifact.bytes.length,
        affectedPaths: [...prepared.affectedPaths],
        preStatus: { ...prepared.preStatus },
        preFingerprint: structuredClone(prepared.preFingerprint),
        expectedPostFingerprint: structuredClone(
          prepared.expectedPostFingerprint,
        ),
        previewedAt: new Date().toISOString(),
        requiredConfirmation: `APPLY ${prepared.task.id}`,
        activePromotionId: active?.id ?? null,
      };
    });
  }

  private async applyInternal(
    input: ApplyPatchPromotionInput,
  ): Promise<PatchPromotionRecord> {
    assertSafeTaskId(input.taskId);
    const requiredConfirmation = `APPLY ${input.taskId}`;
    if (input.confirmation !== requiredConfirmation) {
      throw new PatchPromotionConfirmationError(requiredConfirmation);
    }

    const task = await this.getTask(input.taskId);
    const targetRepo = await this.canonicalTarget(task, input.targetRepo);
    return this.store.withRepositoryLock(targetRepo, async () => {
      await this.reconcileTargetRecordsLocked(targetRepo);
      await this.assertNoActiveTargetPromotion(input.taskId, targetRepo);
      const prepared = await this.prepare(input.taskId, targetRepo);
      if (
        (input.expectedPatchSha256 !== undefined &&
          input.expectedPatchSha256 !== prepared.artifact.sha256) ||
        (input.expectedPostFingerprintSha256 !== undefined &&
          input.expectedPostFingerprintSha256 !==
            prepared.expectedPostFingerprint.sha256)
      ) {
        throw new PatchPromotionError(
          "ARTIFACT_UNSAFE",
          "Patch changed after it was previewed for approval; preview again.",
        );
      }
      const now = new Date().toISOString();
      let record: PatchPromotionRecord = {
        schemaVersion: 2,
        id: randomUUID(),
        taskId: prepared.task.id,
        origin: this.origin,
        state: "applying",
        rollbackState: "not_available",
        operationPhase: "apply_prepared",
        recoveryState: "pending",
        sourceRepo: prepared.sourceRepo,
        targetRepo: prepared.targetRepo,
        baseCommit: prepared.task.baseCommit!,
        patchSha256: prepared.artifact.sha256,
        patchBytes: prepared.artifact.bytes.length,
        affectedPaths: [...prepared.affectedPaths],
        preStatus: { ...prepared.preStatus },
        postStatus: null,
        preFingerprint: structuredClone(prepared.preFingerprint),
        expectedPostFingerprint: structuredClone(
          prepared.expectedPostFingerprint,
        ),
        postFingerprint: null,
        createdAt: now,
        updatedAt: now,
        appliedAt: null,
        rollbackStartedAt: null,
        rolledBackAt: null,
        error: null,
      };
      await this.store.create(record, prepared.artifact.bytes);

      try {
        const immediatelyBefore = await this.status(prepared.targetRepo);
        const fingerprintImmediatelyBefore = await this.fingerprintPaths(
          prepared.targetRepo,
          prepared.affectedPaths,
        );
        const changedImmediatelyBefore = await this.changedPaths(
          prepared.targetRepo,
        );
        if (
          !sameStatus(immediatelyBefore, prepared.preStatus) ||
          !sameFingerprint(
            fingerprintImmediatelyBefore,
            prepared.preFingerprint,
          ) ||
          !samePaths(
            changedImmediatelyBefore.all,
            prepared.preChangedPaths.all,
          ) ||
          !samePaths(
            changedImmediatelyBefore.index,
            prepared.preChangedPaths.index,
          )
        ) {
          throw new PatchPromotionError(
            "DIRTY_TARGET",
            "Target changed after promotion validation.",
          );
        }
        await this.checkApply(prepared.targetRepo, prepared.artifact.bytes);
        record = {
          ...record,
          operationPhase: "apply_mutating",
          updatedAt: new Date().toISOString(),
        };
        await this.store.save(record);
        await this.checkedGit(
          "three-way apply",
          ["apply", "--3way", "--whitespace=warn"],
          prepared.targetRepo,
          prepared.artifact.bytes,
        );
        await this.checkedGit(
          "post-apply index restoration",
          ["reset", "--quiet", "--", ...prepared.affectedPaths],
          prepared.targetRepo,
        );

        const postStatus = await this.status(prepared.targetRepo);
        const postFingerprint = await this.fingerprintPaths(
          prepared.targetRepo,
          prepared.affectedPaths,
        );
        if (
          !sameFingerprint(
            postFingerprint,
            prepared.expectedPostFingerprint,
          ) ||
          !preservesDisjointStatus(
            prepared.preStatus,
            postStatus,
            prepared.affectedPaths,
          )
        ) {
          throw new PatchPromotionError(
            "APPLY_FAILED",
            "Applied patch did not produce the expected isolated, unstaged repository state.",
          );
        }
        await this.assertNoSymlinks(prepared.targetRepo, prepared.affectedPaths);
        await this.checkApply(prepared.targetRepo, prepared.artifact.bytes, true);

        const appliedAt = new Date().toISOString();
        record = {
          ...record,
          state: "applied",
          rollbackState: "available",
          operationPhase: "stable_applied",
          recoveryState: "none",
          postStatus,
          postFingerprint,
          appliedAt,
          updatedAt: appliedAt,
        };
        await this.store.save(record);
        return cloneRecord(record);
      } catch (error) {
        let currentStatus: GitStatusSnapshot | null = null;
        let currentFingerprint: AffectedFilesFingerprint | null = null;
        let restored = false;
        try {
          currentStatus = await this.status(prepared.targetRepo);
          currentFingerprint = await this.fingerprintPaths(
            prepared.targetRepo,
            prepared.affectedPaths,
          );
          if (
            !sameStatus(currentStatus, prepared.preStatus) ||
            !sameFingerprint(currentFingerprint, prepared.preFingerprint)
          ) {
            if (
              sameFingerprint(
                currentFingerprint,
                prepared.expectedPostFingerprint,
              ) &&
              currentStatus !== null &&
              preservesDisjointStatus(
                prepared.preStatus,
                currentStatus,
                prepared.affectedPaths,
              )
            ) {
              await this.checkApply(prepared.targetRepo, prepared.artifact.bytes, true);
              await this.checkedGit(
                "automatic failed-apply recovery",
                ["apply", "--reverse", "--whitespace=warn"],
                prepared.targetRepo,
                prepared.artifact.bytes,
              );
              restored = sameStatus(
                await this.status(prepared.targetRepo),
                prepared.preStatus,
              ) && sameFingerprint(
                await this.fingerprintPaths(
                  prepared.targetRepo,
                  prepared.affectedPaths,
                ),
                prepared.preFingerprint,
              );
            }
          } else {
            restored = true;
          }
        } catch {
          restored = false;
        }
        const failedAt = new Date().toISOString();
        record = {
          ...record,
          state: restored ? "failed" : "needs_attention",
          rollbackState: restored ? "not_available" : "needs_attention",
          operationPhase: restored ? "stable_failed" : "needs_attention",
          recoveryState: restored ? "none" : "needs_attention",
          postStatus: currentStatus,
          postFingerprint: currentFingerprint,
          updatedAt: failedAt,
          error: safeError(error),
        };
        await this.store.save(record).catch(() => undefined);
        throw error;
      }
    });
  }

  private async rollbackInternal(
    input: RollbackPatchPromotionInput,
  ): Promise<PatchPromotionRecord> {
    assertPromotionId(input.promotionId);
    const requiredConfirmation = `ROLLBACK ${input.promotionId}`;
    if (input.confirmation !== requiredConfirmation) {
      throw new PatchPromotionConfirmationError(requiredConfirmation);
    }
    const initial = await this.store.get(input.promotionId);
    if (!initial) {
      throw new PatchPromotionError(
        "NOT_FOUND",
        `Unknown promotion: ${input.promotionId}`,
      );
    }
    if (initial.origin !== this.origin) {
      throw new PatchPromotionError(
        "ORIGIN_MISMATCH",
        "Promotion belongs to another mesh origin.",
      );
    }
    const canonical = await canonicalizeAllowedCwd(initial.targetRepo, [
      ...this.allowedRoots,
    ]);
    const targetRepo = await realpath(initial.targetRepo);
    if (canonical !== targetRepo) {
      throw new PatchPromotionError("TARGET_UNSAFE", "Stored target repository is not canonical.");
    }

    return this.store.withRepositoryLock(targetRepo, async () => {
      await this.reconcileTargetRecordsLocked(targetRepo);
      let record = await this.store.get(input.promotionId);
      if (!record) {
        throw new PatchPromotionError(
          "NOT_FOUND",
          `Unknown promotion: ${input.promotionId}`,
        );
      }
      if (record.origin !== this.origin) {
        throw new PatchPromotionError(
          "ORIGIN_MISMATCH",
          "Promotion belongs to another mesh origin.",
        );
      }
      if (
        record.state === "committed"
      ) {
        throw new PatchPromotionError(
          "ROLLBACK_UNSAFE",
          "Promotion changes are committed in target history and cannot be rolled back automatically.",
        );
      }
      if (
        record.state !== "applied" ||
        record.rollbackState !== "available" ||
        !record.postStatus ||
        !record.postFingerprint
      ) {
        throw new PatchPromotionError(
          "ROLLBACK_UNSAFE",
          `Promotion is not rollback-ready: ${record.state}/${record.rollbackState}`,
        );
      }
      const currentStatus = await this.status(targetRepo);
      const currentFingerprint = await this.fingerprintPaths(
        targetRepo,
        record.affectedPaths,
      );
      if (
        !sameStatus(currentStatus, record.postStatus) ||
        !sameFingerprint(currentFingerprint, record.postFingerprint)
      ) {
        throw new PatchPromotionError(
          "ROLLBACK_UNSAFE",
          "Target has unrelated or altered changes since promotion.",
        );
      }
      await this.assertNoSymlinks(targetRepo, record.affectedPaths);
      const patch = await this.store.readPatch(record);
      await this.checkApply(targetRepo, patch, true);

      const rollbackStartedAt = new Date().toISOString();
      record = {
        ...record,
        state: "rolling_back",
        rollbackState: "in_progress",
        operationPhase: "rollback_prepared",
        recoveryState: "pending",
        rollbackStartedAt,
        updatedAt: rollbackStartedAt,
        error: null,
      };
      await this.store.save(record);

      let reverseMutationStarted = false;
      try {
        const immediatelyBefore = await this.status(targetRepo);
        const fingerprintImmediatelyBefore = await this.fingerprintPaths(
          targetRepo,
          record.affectedPaths,
        );
        if (
          !record.postStatus ||
          !record.postFingerprint ||
          !sameStatus(immediatelyBefore, record.postStatus) ||
          !sameFingerprint(
            fingerprintImmediatelyBefore,
            record.postFingerprint,
          )
        ) {
          throw new PatchPromotionError(
            "ROLLBACK_UNSAFE",
            "Target changed after rollback validation.",
          );
        }
        await this.checkApply(targetRepo, patch, true);
        record = {
          ...record,
          operationPhase: "rollback_mutating",
          updatedAt: new Date().toISOString(),
        };
        await this.store.save(record);
        reverseMutationStarted = true;
        await this.checkedGit(
          "reverse apply",
          ["apply", "--reverse", "--whitespace=warn"],
          targetRepo,
          patch,
        );
        const restoredStatus = await this.status(targetRepo);
        const restoredFingerprint = await this.fingerprintPaths(
          targetRepo,
          record.affectedPaths,
        );
        if (
          !sameStatus(restoredStatus, record.preStatus) ||
          !sameFingerprint(restoredFingerprint, record.preFingerprint)
        ) {
          throw new PatchPromotionError(
            "ROLLBACK_UNSAFE",
            "Reverse apply did not restore the recorded pre-promotion state.",
          );
        }
        const rolledBackAt = new Date().toISOString();
        record = {
          ...record,
          state: "rolled_back",
          rollbackState: "rolled_back",
          operationPhase: "stable_rolled_back",
          recoveryState: "none",
          rolledBackAt,
          updatedAt: rolledBackAt,
          error: null,
        };
        await this.store.save(record);
        return cloneRecord(record);
      } catch (error) {
        const current = await this.status(targetRepo).catch(() => null);
        const currentFingerprint = await this.fingerprintPaths(
          targetRepo,
          record.affectedPaths,
        ).catch(() => null);
        const restored =
          !reverseMutationStarted &&
          current !== null &&
          currentFingerprint !== null &&
          record.postStatus !== null &&
          record.postFingerprint !== null &&
          sameStatus(current, record.postStatus) &&
          sameFingerprint(currentFingerprint, record.postFingerprint);
        const rolledBack =
          current !== null &&
          currentFingerprint !== null &&
          sameStatus(current, record.preStatus) &&
          sameFingerprint(currentFingerprint, record.preFingerprint);
        const failedAt = new Date().toISOString();
        record = {
          ...record,
          state: rolledBack ? "rolled_back" : restored ? "applied" : "needs_attention",
          rollbackState: rolledBack
            ? "rolled_back"
            : restored
              ? "available"
              : "needs_attention",
          operationPhase: rolledBack
            ? "stable_rolled_back"
            : restored
              ? "stable_applied"
              : "needs_attention",
          recoveryState:
            rolledBack || restored ? "none" : "needs_attention",
          rolledBackAt: rolledBack ? failedAt : record.rolledBackAt,
          updatedAt: failedAt,
          error: safeError(error),
        };
        await this.store.save(record).catch(() => undefined);
        throw error;
      }
    });
  }

  private async listPromotionsInternal(
    input: ListPatchPromotionsInput = {},
  ): Promise<PatchPromotionRecord[]> {
    if (input.taskId !== undefined) assertSafeTaskId(input.taskId);
    const limit = assertBoundedInteger(input.limit ?? 100, "limit", 1, 1_000);
    let targetRepo: string | undefined;
    if (input.targetRepo !== undefined) {
      targetRepo = await canonicalizeAllowedCwd(input.targetRepo, [
        ...this.allowedRoots,
      ]);
      const discovered = await this.checkedGit(
        "repository discovery",
        ["rev-parse", "--show-toplevel"],
        targetRepo,
      );
      targetRepo = await realpath(decodeUtf8(discovered.stdout, "Repository path").trim());
    }
    return (await this.store.list())
      .filter(
        (record) =>
          record.origin === this.origin &&
          (input.taskId === undefined || record.taskId === input.taskId) &&
          (targetRepo === undefined || record.targetRepo === targetRepo),
      )
      .slice(0, limit)
      .map(cloneRecord);
  }

  private runTracked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(
        new PatchPromotionError(
          "SERVICE_CLOSING",
          "Patch promotion service is closing and accepts no new operations.",
        ),
      );
    }
    const promise = Promise.resolve().then(operation);
    this.inFlight.add(promise);
    const remove = () => {
      this.inFlight.delete(promise);
    };
    promise.then(remove, remove);
    return promise;
  }

  get inFlightOperationCount(): number {
    return this.inFlight.size;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  preview(input: PreviewPatchPromotionInput): Promise<PatchPromotionPreview> {
    return this.runTracked(async () => {
      await this.ensureRecovered();
      return this.previewInternal(input);
    });
  }

  apply(input: ApplyPatchPromotionInput): Promise<PatchPromotionRecord> {
    return this.runTracked(async () => {
      await this.ensureRecovered();
      return this.applyInternal(input);
    });
  }

  rollback(input: RollbackPatchPromotionInput): Promise<PatchPromotionRecord> {
    return this.runTracked(async () => {
      await this.ensureRecovered();
      return this.rollbackInternal(input);
    });
  }

  listPromotions(
    input: ListPatchPromotionsInput = {},
  ): Promise<PatchPromotionRecord[]> {
    return this.runTracked(async () => {
      await this.ensureRecovered();
      return this.listPromotionsInternal(input);
    });
  }

  list(input: ListPatchPromotionsInput = {}): Promise<PatchPromotionRecord[]> {
    return this.listPromotions(input);
  }

  recoverPromotions(): Promise<PatchPromotionRecoveryReport> {
    return this.runTracked(() => this.recoverAllInternal());
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.drain();
  }

}

export function createPatchPromotionService(
  options: PatchPromotionServiceOptions,
): PatchPromotionService {
  return new PatchPromotionService(options);
}
