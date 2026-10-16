import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";

import { redactSecrets, summarizeEventForLog } from "./security.js";

const SUPERVISOR_PATH = fileURLToPath(new URL("./bin/supervise.mjs", import.meta.url));

export function supervisedInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    args: [SUPERVISOR_PATH],
    env: {
      ...env,
      AGENT_MESH_OWNER_PID: String(process.pid),
      AGENT_MESH_SUPERVISED_PROCESS: JSON.stringify({ command, args }),
    },
  };
}

export interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface RunningProcess {
  pid?: number;
  completion: Promise<ProcessOutcome>;
  cancel: () => Promise<void>;
}

export interface StartProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
  eventsPath: string;
  onStdoutLine: (line: string) => void;
  onStderrLine?: (line: string) => void;
  summarizeStdoutLine?: (line: string) => unknown;
  preserveEmptyStdoutLines?: boolean;
  appendEvents?: boolean;
}

function splitLines(
  onLine: (line: string) => void,
  maxLineBytes = Number(process.env.AGENT_MESH_MAX_LINE_BYTES || 1_048_576),
  onOverflow?: () => void,
  preserveEmptyLines = false,
): { push: (chunk: Buffer | string) => void; flush: () => void } {
  let buffer = "";
  let discarding = false;
  return {
    push(chunk) {
      const text = chunk.toString();
      if (discarding) {
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        discarding = false;
        buffer = text.slice(newline + 1);
      } else {
        buffer += text;
      }
      if (Buffer.byteLength(buffer) > maxLineBytes && !buffer.includes("\n")) {
        onOverflow?.();
        buffer = "";
        discarding = true;
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line && Buffer.byteLength(line) > maxLineBytes) {
          onOverflow?.();
          continue;
        }
        if (line || preserveEmptyLines) onLine(line);
      }
    },
    flush() {
      if (discarding) return;
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      if (line) onLine(line);
    },
  };
}

async function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  isSettled: () => boolean,
): Promise<void> {
  if (!pid || isSettled()) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

export function startLineProcess(options: StartProcessOptions): RunningProcess {
  const eventLog = createWriteStream(options.eventsPath, {
    flags: options.appendEvents ? "a" : "ax",
    mode: 0o600,
    encoding: "utf8",
  });
  let eventLogError: Error | undefined;
  eventLog.on("error", (error) => {
    eventLogError = error;
    console.error(`[agent-mesh] event log error: ${redactSecrets(error.message)}`);
  });
  const invocation = supervisedInvocation(options.command, options.args, options.env);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: invocation.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let stderr = "";
  let settled = false;
  let cancelled = false;
  let eventBytes = 0;
  let lineOverflowError: Error | undefined;
  const maxEventBytes = Number(process.env.AGENT_MESH_MAX_EVENT_BYTES || 10_485_760);

  const writeEvent = (stream: "stdout" | "stderr", event: unknown) => {
    if (eventBytes >= maxEventBytes) return;
    const record = `${JSON.stringify({ at: new Date().toISOString(), stream, event })}\n`;
    eventBytes += Buffer.byteLength(record);
    if (eventBytes <= maxEventBytes) eventLog.write(record);
  };
  const stdout = splitLines(
    (line) => {
      if (options.summarizeStdoutLine) {
        writeEvent("stdout", options.summarizeStdoutLine(line));
      } else {
        try {
          writeEvent("stdout", summarizeEventForLog(JSON.parse(line) as unknown));
        } catch {
          writeEvent("stdout", summarizeEventForLog(line));
        }
      }
      options.onStdoutLine(line);
    },
    Number(process.env.AGENT_MESH_MAX_PROVIDER_LINE_BYTES || 8_388_608),
    () => {
      lineOverflowError = new Error(
        `Provider emitted a line larger than the configured limit.`,
      );
      void signalProcessGroup(child.pid, "SIGTERM", () => settled);
    },
    options.preserveEmptyStdoutLines,
  );
  const stderrLines = splitLines((line) => {
    const redacted = redactSecrets(line);
    writeEvent("stderr", { message: redacted.slice(0, 2_000) });
    stderr = `${stderr}${stderr ? "\n" : ""}${redacted}`.slice(-64_000);
    options.onStderrLine?.(redacted);
  });

  child.stdout.on("data", stdout.push);
  child.stderr.on("data", stderrLines.push);
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();

  let terminatePromise: Promise<void> | undefined;
  let completion!: Promise<ProcessOutcome>;
  let rejectCompletion!: (error: Error) => void;
  const waitForExit = async (milliseconds: number) => {
    await Promise.race([
      completion.catch(() => undefined),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
      }),
    ]);
  };
  const terminate = async () => {
    if (terminatePromise) return terminatePromise;
    terminatePromise = (async () => {
      if (settled) return;
      await signalProcessGroup(child.pid, "SIGINT", () => settled);
      await waitForExit(750);
      if (settled) return;
      await signalProcessGroup(child.pid, "SIGTERM", () => settled);
      await waitForExit(1_500);
      if (settled) return;
      await signalProcessGroup(child.pid, "SIGKILL", () => settled);
      await waitForExit(2_000);
      if (!settled) {
        throw new Error(`Unable to terminate ${options.command} process group.`);
      }
    })();
    return terminatePromise;
  };

  completion = new Promise<ProcessOutcome>((resolve, reject) => {
    rejectCompletion = reject;
    const timer = setTimeout(() => {
      cancelled = true;
      void terminate().catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        rejectCompletion(
          new Error(
            `Timed out and could not terminate ${options.command}: ${detail}${stderr ? `\n${stderr}` : ""}`,
          ),
        );
      });
    }, options.timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      stdout.flush();
      stderrLines.flush();
      eventLog.end();
      void finished(eventLog)
        .catch(() => undefined)
        .finally(() => reject(error));
    });
    child.once("close", (code, signal) => {
      settled = true;
      clearTimeout(timer);
      stdout.flush();
      stderrLines.flush();
      eventLog.end();
      if (cancelled && !stderr) stderr = "Process cancelled or timed out.";
      void finished(eventLog)
        .then(() => {
          if (lineOverflowError) reject(lineOverflowError);
          else if (eventLogError) reject(eventLogError);
          else resolve({ code, signal, stderr });
        })
        .catch(reject);
    });
  });

  return {
    pid: child.pid,
    completion,
    async cancel() {
      if (settled) return;
      cancelled = true;
      await terminate();
    },
  };
}
