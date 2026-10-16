import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendAutonomousQuestionInstructions,
  AUTONOMOUS_QUESTION_INSTRUCTIONS,
  createTranscriptWriter,
  normalizeCodexUserInputQuestions,
  parseBlockingQuestionEnvelope,
  QUESTION_ENVELOPE_CLOSE,
  QUESTION_ENVELOPE_OPEN,
  readEventLog,
  readTranscript,
  toSafeMcpInteractionResponse,
  type TranscriptEntryInput,
} from "../interactions.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

function entry(text: string, overrides: Partial<TranscriptEntryInput> = {}): TranscriptEntryInput {
  return {
    role: "assistant",
    type: "message",
    text,
    timestamp: "2026-07-12T12:00:00.000Z",
    provider: "codex",
    taskId: "task-1",
    sessionId: "session-1",
    ...overrides,
  };
}

describe("secure transcript storage", () => {
  it("creates a private JSONL file and redacts and caps text before writing", async () => {
    const root = await temporaryDirectory("mesh-interactions-redaction-");
    const path = join(root, "transcript.jsonl");
    const secret = "sk-abcdefghijklmnop";
    const writer = await createTranscriptWriter(path, { maxEntryTextBytes: 80 });

    const written = await writer.append(
      entry(`api_key=${secret} ${"x".repeat(200)}`, {
        role: "user",
        type: "prompt",
        provider: "claude",
      }),
    );
    await writer.close();

    expect(written.text).not.toContain(secret);
    expect(written.text).toContain("[REDACTED]");
    expect(Buffer.byteLength(written.text)).toBeLessThanOrEqual(80);
    expect(written.text).toContain("[TRUNCATED]");
    expect(await readFile(path, "utf8")).not.toContain(secret);
    expect((await stat(path)).mode & 0o777).toBe(
      process.platform === "win32" ? 0o666 : 0o600,
    );

    const page = await readTranscript(path);
    expect(page.entries).toEqual([written]);
    expect(page.entries[0]).toMatchObject({
      role: "user",
      type: "prompt",
      provider: "claude",
      taskId: "task-1",
      sessionId: "session-1",
      timestamp: "2026-07-12T12:00:00.000Z",
    });
  });

  it("rejects an entry that would exceed the total transcript bound", async () => {
    const root = await temporaryDirectory("mesh-interactions-size-");
    const path = join(root, "transcript.jsonl");
    const writer = await createTranscriptWriter(path, {
      maxTotalBytes: 240,
      maxEntryTextBytes: 80,
    });

    await writer.append(entry("first"));
    await expect(writer.append(entry("second"))).rejects.toThrow(/maximum of 240 bytes/);
    await writer.close();

    expect((await stat(path)).size).toBeLessThanOrEqual(240);
    expect((await readTranscript(path)).entries.map((item) => item.text)).toEqual(["first"]);
  });

  it("refuses to read a transcript above the configured read bound", async () => {
    const root = await temporaryDirectory("mesh-interactions-read-size-");
    const path = join(root, "oversized.jsonl");
    await writeFile(path, "x".repeat(300), { mode: 0o600 });
    await chmod(path, 0o600);

    await expect(readTranscript(path, { maxTotalBytes: 128 })).rejects.toThrow(/read limit/);
  });

  it("paginates by line cursor and returns the newest entries in tail mode", async () => {
    const root = await temporaryDirectory("mesh-interactions-pagination-");
    const path = join(root, "transcript.jsonl");
    const writer = await createTranscriptWriter(path);
    for (let index = 0; index < 5; index += 1) {
      await writer.append(entry(`message-${index}`));
    }
    await writer.close();

    const first = await readTranscript(path, { cursor: 0, limit: 2 });
    expect(first.entries.map((item) => item.text)).toEqual(["message-0", "message-1"]);
    expect(first).toMatchObject({
      startCursor: 0,
      nextCursor: 2,
      hasMore: true,
      totalLines: 5,
      tail: false,
    });

    const second = await readTranscript(path, { cursor: first.nextCursor, limit: 2 });
    expect(second.entries.map((item) => item.text)).toEqual(["message-2", "message-3"]);
    expect(second.nextCursor).toBe(4);

    const tail = await readTranscript(path, { tail: true, limit: 2 });
    expect(tail.entries.map((item) => item.text)).toEqual(["message-3", "message-4"]);
    expect(tail).toMatchObject({
      startCursor: 3,
      nextCursor: 5,
      hasMore: false,
      totalLines: 5,
      tail: true,
    });
    await expect(readTranscript(path, { tail: true, cursor: 1 })).rejects.toThrow(
      /cannot be used together/,
    );
  });

  it("refuses symlink targets for creation and reading", async () => {
    const root = await temporaryDirectory("mesh-interactions-symlink-");
    const target = join(root, "target.jsonl");
    const link = join(root, "transcript.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    await chmod(target, 0o600);
    await symlink(target, link);

    await expect(createTranscriptWriter(link)).rejects.toThrow();
    await expect(readTranscript(link)).rejects.toThrow();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("");
  });
});

describe("blocking-question envelope", () => {
  it("parses a valid final envelope, validates options, and removes it from output", () => {
    const payload = JSON.stringify({
      question: "Which database should I target?",
      context: "The repository config names both.",
      options: ["Postgres", "SQLite"],
    });
    const parsed = parseBlockingQuestionEnvelope(
      `Investigation complete.\n${QUESTION_ENVELOPE_OPEN}${payload}${QUESTION_ENVELOPE_CLOSE}\n`,
    );

    expect(parsed).toEqual({
      output: "Investigation complete.",
      question: {
        question: "Which database should I target?",
        context: "The repository config names both.",
        options: ["Postgres", "SQLite"],
      },
      envelope: "valid",
    });
  });

  it("accepts a question without optional context or options", () => {
    const parsed = parseBlockingQuestionEnvelope(
      `${QUESTION_ENVELOPE_OPEN}{"question":"What is the required account ID?"}${QUESTION_ENVELOPE_CLOSE}`,
    );
    expect(parsed.envelope).toBe("valid");
    expect(parsed.output).toBe("");
    expect(parsed.question).toEqual({ question: "What is the required account ID?" });
  });

  it("does not interpret malformed or embedded envelopes as control data", () => {
    const embedded = `Use ${QUESTION_ENVELOPE_OPEN}{"question":"Example?"}${QUESTION_ENVELOPE_CLOSE} in docs.`;
    const malformed = `${QUESTION_ENVELOPE_OPEN}{"question":}${QUESTION_ENVELOPE_CLOSE}`;
    const fenced = [
      "Example:",
      "```",
      `${QUESTION_ENVELOPE_OPEN}{"question":"Example?"}${QUESTION_ENVELOPE_CLOSE}`,
      "```",
    ].join("\n");

    for (const output of [embedded, malformed, fenced]) {
      const parsed = parseBlockingQuestionEnvelope(output);
      expect(parsed.envelope).toBe("invalid");
      expect(parsed.question).toBeNull();
      expect(parsed.output).toBe(output);
      expect(parsed.error).toBeTruthy();
    }
  });

  it("requires 2-8 unique string options and rejects unknown fields", () => {
    const invalidPayloads = [
      { question: "Choose", options: ["only-one"] },
      { question: "Choose", options: Array.from({ length: 9 }, (_, index) => String(index)) },
      { question: "Choose", options: ["same", "same"] },
      { question: "Choose", extra: true },
    ];

    for (const payload of invalidPayloads) {
      const parsed = parseBlockingQuestionEnvelope(
        `${QUESTION_ENVELOPE_OPEN}${JSON.stringify(payload)}${QUESTION_ENVELOPE_CLOSE}`,
      );
      expect(parsed.envelope).toBe("invalid");
      expect(parsed.question).toBeNull();
    }
  });
});

describe("Codex native question normalization", () => {
  it("normalizes app-server labels, option details, and question batches", () => {
    const questions = normalizeCodexUserInputQuestions([
      {
        id: "database",
        header: "Storage",
        question: "Which database should I use?",
        options: [
          { label: "Postgres", description: "Production service" },
          { label: "SQLite", description: "Local-only file" },
        ],
      },
      {
        id: "migration",
        question: "Should I migrate existing data?",
        options: ["Yes", "No"],
      },
    ]);

    expect(questions).toEqual([
      {
        id: "database",
        question: "Which database should I use?",
        context:
          "Storage\n\nOption details:\nPostgres: Production service\nSQLite: Local-only file",
        options: ["Postgres", "SQLite"],
      },
      {
        id: "migration",
        question: "Should I migrate existing data?",
        options: ["Yes", "No"],
      },
    ]);
  });

  it("fails closed for secret, duplicate, or malformed native questions", () => {
    expect(() =>
      normalizeCodexUserInputQuestions([
        { id: "token", question: "Enter token", isSecret: true },
      ]),
    ).toThrow(/secret-input/);
    expect(() =>
      normalizeCodexUserInputQuestions([
        { id: "same", question: "First?" },
        { id: "same", question: "Second?" },
      ]),
    ).toThrow(/Duplicate/);
    expect(() => normalizeCodexUserInputQuestions([])).toThrow(/1 through 8/);
  });
});

describe("event timeline reading", () => {
  it("reads current and legacy metadata event formats without exposing content", async () => {
    const root = await temporaryDirectory("mesh-interactions-events-");
    const path = join(root, "events.ndjson");
    await writeFile(
      path,
      [
        JSON.stringify({
          at: "2026-07-12T12:00:00.000Z",
          stream: "codex",
          event: {
            method: "item/completed",
            item: { id: "1", type: "agentMessage", text: "secret answer" },
          },
        }),
        JSON.stringify({
          method: "turn/completed",
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", output: "hidden" },
        }),
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    await chmod(path, 0o600);

    const page = await readEventLog(path, { limit: 10 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]?.event).toMatchObject({
      method: "item/completed",
      item: { id: "1", type: "agentMessage" },
    });
    expect(page.entries[1]?.event).toMatchObject({
      method: "turn/completed",
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    expect(JSON.stringify(page)).not.toContain("secret answer");
    expect(JSON.stringify(page)).not.toContain("hidden");
  });
});

describe("autonomous prompt and MCP response helpers", () => {
  it("appends exact, idempotent instructions that reserve questions for blockers", () => {
    const prompt = appendAutonomousQuestionInstructions("Implement the requested change.");
    expect(prompt).toContain("genuinely blocked");
    expect(prompt).toContain("complete the task autonomously");
    expect(prompt).toContain(QUESTION_ENVELOPE_OPEN);
    expect(prompt).toContain(QUESTION_ENVELOPE_CLOSE);
    expect(prompt.endsWith(AUTONOMOUS_QUESTION_INSTRUCTIONS)).toBe(true);
    expect(appendAutonomousQuestionInstructions(prompt)).toBe(prompt);
  });

  it("returns redacted transcript data and allowlisted event summaries as an MCP response", () => {
    const secret = "ghp_abcdefghijklmnop";
    const transcriptEntry = {
      ...entry(`authorization=${secret}`),
      timestamp: "2026-07-12T12:00:00.000Z",
      provider: "codex" as const,
      taskId: "task-1",
      sessionId: "session-1",
    };
    const response = toSafeMcpInteractionResponse({
      transcript: {
        entries: [transcriptEntry],
        startCursor: 0,
        nextCursor: 1,
        hasMore: false,
        totalLines: 1,
        totalBytes: 200,
        tail: false,
      },
      events: [
        {
          type: "assistant",
          session_id: "session-1",
          message: { content: [{ text: `prompt containing ${secret}` }] },
        },
        { type: "error", error: { authorization: secret } },
      ],
    });
    const serialized = JSON.stringify(response);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("prompt containing");
    expect(serialized).toContain("[REDACTED]");
    expect(response.content[0]?.type).toBe("text");
    expect(response.structuredContent).toHaveProperty("transcript");
    expect(response.structuredContent).toHaveProperty("events");
  });
});
