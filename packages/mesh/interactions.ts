import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecrets, summarizeEventForLog } from "./security.js";
import { PROVIDERS, type Provider } from "./types.js";

export const QUESTION_ENVELOPE_OPEN = "<agent_mesh_question>";
export const QUESTION_ENVELOPE_CLOSE = "</agent_mesh_question>";

export const DEFAULT_TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TRANSCRIPT_TEXT_MAX_BYTES = 16 * 1024;
export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 50;
export const MAX_TRANSCRIPT_PAGE_SIZE = 500;

const HARD_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 256;
const MAX_ENTRY_TYPE_BYTES = 64;
const MAX_QUESTION_BYTES = 2_000;
const MAX_QUESTION_CONTEXT_BYTES = 4_000;
const MAX_QUESTION_OPTION_BYTES = 500;
const TRUNCATION_MARKER = "...[TRUNCATED]";
const PROVIDER_SET = new Set<string>(PROVIDERS);

export const TRANSCRIPT_ROLES = ["user", "assistant", "system", "tool"] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

const TRANSCRIPT_ROLE_SET = new Set<string>(TRANSCRIPT_ROLES);

export interface TranscriptEntryInput {
  role: TranscriptRole;
  type: string;
  text: string;
  timestamp?: string | Date;
  provider?: Provider | null;
  taskId?: string | null;
  sessionId?: string | null;
}

export interface TranscriptEntry {
  role: TranscriptRole;
  type: string;
  text: string;
  timestamp: string;
  provider: Provider | null;
  taskId: string | null;
  sessionId: string | null;
}

export interface TranscriptWriterOptions {
  maxTotalBytes?: number;
  maxEntryTextBytes?: number;
  syncOnAppend?: boolean;
}

export interface TranscriptReadOptions {
  /**
   * Zero-based line number of the next entry to read. Omit it with `tail: true`
   * to read the newest page.
   */
  cursor?: number;
  limit?: number;
  tail?: boolean;
  maxTotalBytes?: number;
  maxEntryTextBytes?: number;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  startCursor: number;
  nextCursor: number;
  hasMore: boolean;
  totalLines: number;
  totalBytes: number;
  tail: boolean;
}

export interface EventLogEntry {
  at: string;
  stream?: string;
  event: Record<string, unknown>;
}

export interface EventLogPage {
  entries: EventLogEntry[];
  startCursor: number;
  nextCursor: number;
  hasMore: boolean;
  totalLines: number;
  totalBytes: number;
  tail: boolean;
}

export interface BlockingQuestion {
  question: string;
  context?: string;
  options?: string[];
}

export interface NormalizedCodexUserInputQuestion {
  id: string;
  question: string;
  context?: string;
  options: string[];
}

export interface ParsedProviderOutput {
  output: string;
  question: BlockingQuestion | null;
  envelope: "none" | "valid" | "invalid";
  error?: string;
}

export interface InteractionMcpResponseInput {
  transcript?: TranscriptPage;
  events?: readonly unknown[];
}

export interface InteractionMcpResponseOptions {
  maxEntries?: number;
  maxEvents?: number;
  maxEntryTextBytes?: number;
  maxTextBytes?: number;
}

export interface SafeMcpResponse {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return resolved;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  if (maxBytes <= Buffer.byteLength(TRUNCATION_MARKER)) {
    return TRUNCATION_MARKER.slice(0, maxBytes);
  }

  const budget = maxBytes - Buffer.byteLength(TRUNCATION_MARKER);
  const chunks: string[] = [];
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > budget) break;
    chunks.push(character);
    used += bytes;
  }
  return `${chunks.join("")}${TRUNCATION_MARKER}`;
}

function normalizeText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  return truncateUtf8(redactSecrets(value), maxBytes);
}

function normalizeMetadata(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${name} must not be empty.`);
  return truncateUtf8(redactSecrets(trimmed), MAX_METADATA_BYTES);
}

function normalizeTimestamp(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new TypeError("timestamp must be an ISO-8601 string or Date.");
  }
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("timestamp must be a valid date.");
  }
  return timestamp.toISOString();
}

function normalizeProvider(value: unknown): Provider | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !PROVIDER_SET.has(value)) {
    throw new TypeError(`provider must be one of: ${PROVIDERS.join(", ")}.`);
  }
  return value as Provider;
}

function normalizeEntry(value: unknown, maxEntryTextBytes: number): TranscriptEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("transcript entry must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.role !== "string" || !TRANSCRIPT_ROLE_SET.has(candidate.role)) {
    throw new TypeError(`role must be one of: ${TRANSCRIPT_ROLES.join(", ")}.`);
  }
  if (typeof candidate.type !== "string" || !candidate.type.trim()) {
    throw new TypeError("type must be a non-empty string.");
  }
  if (Buffer.byteLength(candidate.type.trim()) > MAX_ENTRY_TYPE_BYTES) {
    throw new RangeError(`type must not exceed ${MAX_ENTRY_TYPE_BYTES} bytes.`);
  }
  const type = redactSecrets(candidate.type.trim());

  return {
    role: candidate.role as TranscriptRole,
    type,
    text: normalizeText(candidate.text, "text", maxEntryTextBytes),
    timestamp: normalizeTimestamp(candidate.timestamp),
    provider: normalizeProvider(candidate.provider),
    taskId: normalizeMetadata(candidate.taskId, "taskId"),
    sessionId: normalizeMetadata(candidate.sessionId, "sessionId"),
  };
}

function assertPrivateRegularFile(info: Stats): void {
  if (!info.isFile()) throw new Error("Transcript path is not a regular file.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Transcript file must not be accessible by group or other users.");
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && info.uid !== currentUser) {
    throw new Error("Transcript file is not owned by the current user.");
  }
}

async function assertDirectParentDirectory(path: string): Promise<void> {
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink()) {
    throw new Error("Refusing a transcript path beneath a symlinked parent directory.");
  }
  if (!parent.isDirectory()) throw new Error("Transcript parent path is not a directory.");
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Unable to append the complete transcript entry.");
    offset += bytesWritten;
  }
}

/**
 * Create-only JSONL writer. The target must not already exist; callers should
 * retain the writer for the lifetime of the transcript.
 */
export class TranscriptWriter {
  private bytes = 0;
  private acceptingWrites = true;
  private writeTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    readonly maxTotalBytes: number,
    readonly maxEntryTextBytes: number,
    private readonly syncOnAppend: boolean,
  ) {}

  static async create(
    path: string,
    options: TranscriptWriterOptions = {},
  ): Promise<TranscriptWriter> {
    const maxTotalBytes = boundedInteger(
      options.maxTotalBytes,
      DEFAULT_TRANSCRIPT_MAX_BYTES,
      "maxTotalBytes",
      1,
      HARD_TRANSCRIPT_MAX_BYTES,
    );
    const maxEntryTextBytes = boundedInteger(
      options.maxEntryTextBytes,
      DEFAULT_TRANSCRIPT_TEXT_MAX_BYTES,
      "maxEntryTextBytes",
      1,
      DEFAULT_TRANSCRIPT_MAX_BYTES,
    );
    await assertDirectParentDirectory(path);
    const handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      assertPrivateRegularFile(await handle.stat());
      return new TranscriptWriter(
        path,
        handle,
        maxTotalBytes,
        maxEntryTextBytes,
        options.syncOnAppend ?? true,
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  get bytesWritten(): number {
    return this.bytes;
  }

  get remainingBytes(): number {
    return this.maxTotalBytes - this.bytes;
  }

  append(input: TranscriptEntryInput): Promise<TranscriptEntry> {
    if (!this.acceptingWrites) {
      return Promise.reject(new Error("Transcript writer is closed."));
    }
    const operation = this.writeTail.then(async () => {
      const entry = normalizeEntry(input, this.maxEntryTextBytes);
      const encoded = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
      if (this.bytes + encoded.byteLength > this.maxTotalBytes) {
        throw new RangeError(
          `Transcript exceeds its configured maximum of ${this.maxTotalBytes} bytes.`,
        );
      }
      await writeAll(this.handle, encoded);
      this.bytes += encoded.byteLength;
      if (this.syncOnAppend) await this.handle.sync();
      return entry;
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.acceptingWrites = false;
    this.closePromise = (async () => {
      await this.writeTail;
      try {
        await this.handle.sync();
      } finally {
        await this.handle.close();
      }
    })();
    return this.closePromise;
  }
}

export function createTranscriptWriter(
  path: string,
  options: TranscriptWriterOptions = {},
): Promise<TranscriptWriter> {
  return TranscriptWriter.create(path, options);
}

export async function appendTranscriptEntry(
  path: string,
  input: TranscriptEntryInput,
  options: TranscriptWriterOptions = {},
): Promise<TranscriptEntry> {
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes,
    DEFAULT_TRANSCRIPT_MAX_BYTES,
    "maxTotalBytes",
    1,
    HARD_TRANSCRIPT_MAX_BYTES,
  );
  const maxEntryTextBytes = boundedInteger(
    options.maxEntryTextBytes,
    DEFAULT_TRANSCRIPT_TEXT_MAX_BYTES,
    "maxEntryTextBytes",
    1,
    DEFAULT_TRANSCRIPT_MAX_BYTES,
  );
  await assertDirectParentDirectory(path);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    assertPrivateRegularFile(info);
    const entry = normalizeEntry(input, maxEntryTextBytes);
    const encoded = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    if (info.size + encoded.byteLength > maxTotalBytes) {
      throw new RangeError(
        `Transcript exceeds its configured maximum of ${maxTotalBytes} bytes.`,
      );
    }
    await writeAll(handle, encoded);
    if (options.syncOnAppend ?? true) await handle.sync();
    return entry;
  } finally {
    await handle.close();
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      throw new RangeError(`Transcript exceeds the read limit of ${maxBytes} bytes.`);
    }
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) {
      throw new RangeError(`Transcript exceeds the read limit of ${maxBytes} bytes.`);
    }
  }
  return Buffer.concat(chunks, total);
}

export async function readTranscript(
  path: string,
  options: TranscriptReadOptions = {},
): Promise<TranscriptPage> {
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes,
    DEFAULT_TRANSCRIPT_MAX_BYTES,
    "maxTotalBytes",
    1,
    HARD_TRANSCRIPT_MAX_BYTES,
  );
  const maxEntryTextBytes = boundedInteger(
    options.maxEntryTextBytes,
    DEFAULT_TRANSCRIPT_TEXT_MAX_BYTES,
    "maxEntryTextBytes",
    1,
    DEFAULT_TRANSCRIPT_MAX_BYTES,
  );
  const limit = boundedInteger(
    options.limit,
    DEFAULT_TRANSCRIPT_PAGE_SIZE,
    "limit",
    1,
    MAX_TRANSCRIPT_PAGE_SIZE,
  );
  if (options.tail && options.cursor !== undefined) {
    throw new TypeError("cursor and tail cannot be used together.");
  }

  await assertDirectParentDirectory(path);
  const lexical = await lstat(path);
  if (lexical.isSymbolicLink()) {
    throw new Error("Transcript path must not be a symbolic link.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assertPrivateRegularFile(info);
    if (info.size > maxTotalBytes) {
      throw new RangeError(`Transcript exceeds the read limit of ${maxTotalBytes} bytes.`);
    }
    const data = await readBounded(handle, maxTotalBytes);
    const decoded = data.toString("utf8");
    const lines = decoded.split("\n");
    if (lines.at(-1) === "") lines.pop();

    const totalLines = lines.length;
    const requestedCursor = boundedInteger(
      options.cursor,
      0,
      "cursor",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (requestedCursor > totalLines) {
      throw new RangeError(`cursor ${requestedCursor} exceeds ${totalLines} transcript lines.`);
    }
    const startCursor = options.tail ? Math.max(0, totalLines - limit) : requestedCursor;
    const endCursor = Math.min(totalLines, startCursor + limit);
    const entries = lines.slice(startCursor, endCursor).map((line, index) => {
      if (!line) {
        throw new Error(`Transcript line ${startCursor + index} is empty.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Transcript line ${startCursor + index} is not valid JSON.`);
      }
      return normalizeEntry(parsed, maxEntryTextBytes);
    });

    return {
      entries,
      startCursor,
      nextCursor: endCursor,
      hasMore: endCursor < totalLines,
      totalLines,
      totalBytes: data.byteLength,
      tail: options.tail ?? false,
    };
  } finally {
    await handle.close();
  }
}

export async function readEventLog(
  path: string,
  options: Pick<
    TranscriptReadOptions,
    "cursor" | "limit" | "tail" | "maxTotalBytes"
  > = {},
): Promise<EventLogPage> {
  const maxTotalBytes = boundedInteger(
    options.maxTotalBytes,
    DEFAULT_TRANSCRIPT_MAX_BYTES,
    "maxTotalBytes",
    1,
    HARD_TRANSCRIPT_MAX_BYTES,
  );
  const limit = boundedInteger(
    options.limit,
    DEFAULT_TRANSCRIPT_PAGE_SIZE,
    "limit",
    1,
    MAX_TRANSCRIPT_PAGE_SIZE,
  );
  if (options.tail && options.cursor !== undefined) {
    throw new TypeError("cursor and tail cannot be used together.");
  }
  await assertDirectParentDirectory(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assertPrivateRegularFile(info);
    const data = await readBounded(handle, maxTotalBytes);
    const lines = data.toString("utf8").split("\n").filter(Boolean);
    const totalLines = lines.length;
    const requestedCursor = boundedInteger(
      options.cursor,
      0,
      "cursor",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (requestedCursor > totalLines) {
      throw new RangeError(`cursor ${requestedCursor} exceeds ${totalLines} event lines.`);
    }
    const startCursor = options.tail ? Math.max(0, totalLines - limit) : requestedCursor;
    const endCursor = Math.min(totalLines, startCursor + limit);
    const entries = lines.slice(startCursor, endCursor).map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Event line ${startCursor + index} is not valid JSON.`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Event line ${startCursor + index} is not an object.`);
      }
      const record = parsed as Record<string, unknown>;
      const rawEvent = "event" in record ? record.event : record;
      return {
        at: normalizeTimestamp(record.at),
        ...(typeof record.stream === "string"
          ? { stream: truncateUtf8(redactSecrets(record.stream), 64) }
          : {}),
        event: safeEventSummary(rawEvent),
      };
    });
    return {
      entries,
      startCursor,
      nextCursor: endCursor,
      hasMore: endCursor < totalLines,
      totalLines,
      totalBytes: data.byteLength,
      tail: options.tail ?? false,
    };
  } finally {
    await handle.close();
  }
}

function invalidEnvelope(output: string, error: string): ParsedProviderOutput {
  return { output, question: null, envelope: "invalid", error };
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validatedQuestion(payload: unknown): BlockingQuestion | string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Question envelope payload must be a JSON object.";
  }
  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set(["question", "context", "options"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return "Question envelope contains unsupported fields.";
  }
  if (typeof record.question !== "string" || !record.question.trim()) {
    return "Question envelope requires a non-empty question.";
  }
  const question = record.question.trim();
  if (Buffer.byteLength(question) > MAX_QUESTION_BYTES) {
    return `Question must not exceed ${MAX_QUESTION_BYTES} bytes.`;
  }

  let context: string | undefined;
  if (record.context !== undefined) {
    if (typeof record.context !== "string" || !record.context.trim()) {
      return "Question context must be a non-empty string when provided.";
    }
    context = record.context.trim();
    if (Buffer.byteLength(context) > MAX_QUESTION_CONTEXT_BYTES) {
      return `Question context must not exceed ${MAX_QUESTION_CONTEXT_BYTES} bytes.`;
    }
  }

  let options: string[] | undefined;
  if (record.options !== undefined) {
    if (!Array.isArray(record.options) || record.options.length < 2 || record.options.length > 8) {
      return "Question options must contain 2 through 8 strings.";
    }
    options = [];
    for (const option of record.options) {
      if (typeof option !== "string" || !option.trim()) {
        return "Every question option must be a non-empty string.";
      }
      const trimmed = option.trim();
      if (Buffer.byteLength(trimmed) > MAX_QUESTION_OPTION_BYTES) {
        return `Question options must not exceed ${MAX_QUESTION_OPTION_BYTES} bytes each.`;
      }
      options.push(redactSecrets(trimmed));
    }
    if (new Set(options).size !== options.length) {
      return "Question options must be unique.";
    }
  }

  return {
    question: redactSecrets(question),
    ...(context ? { context: redactSecrets(context) } : {}),
    ...(options ? { options } : {}),
  };
}

/**
 * Normalize one Codex app-server requestUserInput batch. Batches are answered
 * sequentially by the adapter, so every durable mesh question maps to exactly
 * one Codex question id while the original server request stays open.
 */
export function normalizeCodexUserInputQuestions(
  value: unknown,
): NormalizedCodexUserInputQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new TypeError("Codex user-input requests must contain 1 through 8 questions.");
  }
  const seenIds = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`Codex user-input question ${index + 1} must be an object.`);
    }
    const record = raw as Record<string, unknown>;
    if (record.isSecret === true) {
      throw new Error("Codex secret-input questions cannot be bridged through agent-mesh.");
    }
    if (typeof record.id !== "string" || !record.id.trim()) {
      throw new TypeError(`Codex user-input question ${index + 1} requires an id.`);
    }
    const id = truncateUtf8(redactSecrets(record.id.trim()), MAX_METADATA_BYTES);
    if (seenIds.has(id)) throw new Error(`Duplicate Codex user-input question id: ${id}`);
    seenIds.add(id);
    if (typeof record.question !== "string" || !record.question.trim()) {
      throw new TypeError(`Codex user-input question ${id} requires question text.`);
    }
    const question = truncateUtf8(
      redactSecrets(record.question.trim()),
      MAX_QUESTION_BYTES,
    );
    const options: string[] = [];
    const optionContext: string[] = [];
    if (record.options !== undefined && record.options !== null) {
      if (!Array.isArray(record.options) || record.options.length > 8) {
        throw new TypeError(`Codex user-input question ${id} has invalid options.`);
      }
      for (const rawOption of record.options) {
        const option = rawOption as unknown;
        const candidate =
          typeof option === "string"
            ? { label: option }
            : option && typeof option === "object" && !Array.isArray(option)
              ? (option as Record<string, unknown>)
              : {};
        if (typeof candidate.label !== "string" || !candidate.label.trim()) {
          throw new TypeError(`Codex user-input question ${id} has an invalid option.`);
        }
        const label = truncateUtf8(
          redactSecrets(candidate.label.trim()),
          MAX_QUESTION_OPTION_BYTES,
        );
        if (options.includes(label)) {
          throw new Error(`Codex user-input question ${id} has duplicate options.`);
        }
        options.push(label);
        if (typeof candidate.description === "string" && candidate.description.trim()) {
          optionContext.push(
            `${label}: ${truncateUtf8(
              redactSecrets(candidate.description.trim()),
              MAX_QUESTION_OPTION_BYTES,
            )}`,
          );
        }
      }
    }
    const contextParts: string[] = [];
    if (typeof record.header === "string" && record.header.trim()) {
      contextParts.push(redactSecrets(record.header.trim()));
    }
    if (optionContext.length) contextParts.push(`Option details:\n${optionContext.join("\n")}`);
    const context = contextParts.length
      ? truncateUtf8(contextParts.join("\n\n"), MAX_QUESTION_CONTEXT_BYTES)
      : undefined;
    return { id, question, ...(context ? { context } : {}), options };
  });
}

/**
 * Parse exactly one, single-line question envelope at the end of provider
 * output. Embedded, repeated, or malformed sentinels remain in normal output
 * and are marked invalid rather than being interpreted as control data.
 */
export function parseBlockingQuestionEnvelope(output: string): ParsedProviderOutput {
  if (typeof output !== "string") throw new TypeError("Provider output must be a string.");
  const openCount = countOccurrences(output, QUESTION_ENVELOPE_OPEN);
  const closeCount = countOccurrences(output, QUESTION_ENVELOPE_CLOSE);
  if (openCount === 0 && closeCount === 0) {
    return { output, question: null, envelope: "none" };
  }
  if (openCount !== 1 || closeCount !== 1) {
    return invalidEnvelope(output, "Expected exactly one complete question envelope.");
  }

  const rightTrimmed = output.replace(/[ \t\r\n]+$/u, "");
  const finalEnvelopePattern =
    /(^|\n)<agent_mesh_question>([^\r\n]+)<\/agent_mesh_question>$/u;
  const match = finalEnvelopePattern.exec(rightTrimmed);
  if (!match) {
    return invalidEnvelope(
      output,
      "Question envelope must be a standalone, single final output line.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(match[2] ?? "") as unknown;
  } catch {
    return invalidEnvelope(output, "Question envelope payload is not valid JSON.");
  }
  const question = validatedQuestion(payload);
  if (typeof question === "string") return invalidEnvelope(output, question);

  const normalOutput = rightTrimmed.slice(0, match.index).trimEnd();
  return {
    output: normalOutput,
    question,
    envelope: "valid",
  };
}

export const AUTONOMOUS_QUESTION_INSTRUCTIONS = [
  "Agent-mesh autonomy: proceed without asking whenever a safe, reasonable path exists.",
  "Ask only when genuinely blocked by missing information or a choice that materially changes the result.",
  `If blocked, end your final output with exactly one standalone line: ${QUESTION_ENVELOPE_OPEN}{"question":"...","context":"...","options":["...","..."]}${QUESTION_ENVELOPE_CLOSE}`,
  "Context is optional; options are optional, but when used must contain 2-8 short strings. Otherwise complete the task autonomously and never emit the envelope.",
].join("\n");

export function appendAutonomousQuestionInstructions(prompt: string): string {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TypeError("Delegated prompt must be a non-empty string.");
  }
  if (prompt.includes(AUTONOMOUS_QUESTION_INSTRUCTIONS)) return prompt;
  return `${prompt.trimEnd()}\n\n${AUTONOMOUS_QUESTION_INSTRUCTIONS}`;
}

function sanitizeSummaryValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return truncateUtf8(redactSecrets(value), 2_000);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeSummaryValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      result[key] = sanitizeSummaryValue(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function safeEventSummary(event: unknown): Record<string, unknown> {
  try {
    return sanitizeSummaryValue(summarizeEventForLog(event)) as Record<string, unknown>;
  } catch {
    return { type: "unserializable" };
  }
}

function safeResponseEntry(entry: TranscriptEntry, maxTextBytes: number): TranscriptEntry {
  return normalizeEntry(entry, maxTextBytes);
}

/**
 * Convert bounded transcript pages and raw provider events into the standard
 * MCP content/structuredContent shape. Raw events are reduced through the
 * repository's allowlisted event summarizer before serialization.
 */
export function toSafeMcpInteractionResponse(
  input: InteractionMcpResponseInput,
  options: InteractionMcpResponseOptions = {},
): SafeMcpResponse {
  const maxEntries = boundedInteger(options.maxEntries, 100, "maxEntries", 1, 500);
  const maxEvents = boundedInteger(options.maxEvents, 100, "maxEvents", 1, 500);
  const maxEntryTextBytes = boundedInteger(
    options.maxEntryTextBytes,
    4_096,
    "maxEntryTextBytes",
    1,
    DEFAULT_TRANSCRIPT_TEXT_MAX_BYTES,
  );
  const maxTextBytes = boundedInteger(
    options.maxTextBytes,
    1_048_576,
    "maxTextBytes",
    256,
    2_097_152,
  );
  const structuredContent: Record<string, unknown> = {};

  if (input.transcript) {
    const entries = input.transcript.entries
      .slice(0, maxEntries)
      .map((entry) => safeResponseEntry(entry, maxEntryTextBytes));
    structuredContent.transcript = {
      entries,
      startCursor: input.transcript.startCursor,
      nextCursor: input.transcript.nextCursor,
      hasMore: input.transcript.hasMore,
      totalLines: input.transcript.totalLines,
      totalBytes: input.transcript.totalBytes,
      tail: input.transcript.tail,
      responseTruncated: input.transcript.entries.length > entries.length,
    };
  }

  if (input.events) {
    const selected = input.events.slice(-maxEvents);
    structuredContent.events = selected.map(safeEventSummary);
    structuredContent.eventsTruncated = input.events.length > selected.length;
  }

  const serialized = redactSecrets(JSON.stringify(structuredContent, null, 2));
  const text =
    Buffer.byteLength(serialized) <= maxTextBytes
      ? serialized
      : JSON.stringify(
          {
            truncated: true,
            message: "Text rendering exceeded its bound; use structuredContent.",
            totalBytes: Buffer.byteLength(serialized),
          },
          null,
          2,
        );
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}
