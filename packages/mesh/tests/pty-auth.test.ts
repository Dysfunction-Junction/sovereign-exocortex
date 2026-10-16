import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileAuthChallengeStore,
  InteractiveAuthBroker,
  buildAuthCommand,
  type AuthChallengeRecord,
  type AuthChallengeStatus,
  type AuthChallengeStore,
  type AuthExecution,
  type AuthExecutionObserver,
  type AuthExecutionOutcome,
  type AuthExecutor,
  type AuthInvocation,
} from "../pty-auth.js";

class MemoryStore implements AuthChallengeStore {
  readonly records = new Map<string, AuthChallengeRecord>();

  async save(record: Readonly<AuthChallengeRecord>): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async list(): Promise<AuthChallengeRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}

interface FakeRun {
  invocation: Readonly<AuthInvocation>;
  writes: string[];
  cancelled: boolean;
  emit(chunk: string): void;
  finish(outcome?: AuthExecutionOutcome): void;
}

class FakeExecutor implements AuthExecutor {
  readonly runs: FakeRun[] = [];

  async start(
    invocation: Readonly<AuthInvocation>,
    observer: AuthExecutionObserver,
  ): Promise<AuthExecution> {
    let settled = false;
    let resolve!: (outcome: AuthExecutionOutcome) => void;
    const completion = new Promise<AuthExecutionOutcome>((complete) => {
      resolve = complete;
    });
    const run: FakeRun = {
      invocation,
      writes: [],
      cancelled: false,
      emit(chunk) {
        observer.onOutput(chunk);
      },
      finish(outcome = { exitCode: 0, signal: null }) {
        if (settled) return;
        settled = true;
        resolve(outcome);
      },
    };
    this.runs.push(run);
    return {
      completion,
      async write(input: string) {
        if (settled) throw new Error("already settled");
        run.writes.push(input);
      },
      async cancel() {
        run.cancelled = true;
        run.finish({ exitCode: null, signal: "SIGTERM" });
      },
    };
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForRun(executor: FakeExecutor, index = 0): Promise<FakeRun> {
  await waitUntil(() => executor.runs.length > index);
  return executor.runs[index]!;
}

async function waitForStatus(
  broker: InteractiveAuthBroker,
  id: string,
  status: AuthChallengeStatus,
  timeoutMs = 3_000,
): Promise<AuthChallengeRecord> {
  await waitUntil(async () => (await broker.getChallenge(id))?.status === status, timeoutMs);
  return (await broker.getChallenge(id))!;
}

function brokerWith(
  executor = new FakeExecutor(),
  store = new MemoryStore(),
  options: { maxConcurrent?: number; maxOutputBytes?: number } = {},
): {
  broker: InteractiveAuthBroker;
  executor: FakeExecutor;
  store: MemoryStore;
} {
  return {
    broker: new InteractiveAuthBroker({
      executor,
      store,
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 5_000,
      ...options,
    }),
    executor,
    store,
  };
}

describe("allowlisted authentication commands", () => {
  it("builds only the supported provider and downstream MCP login argv", () => {
    expect(buildAuthCommand({ target: "provider", provider: "cursor" })).toEqual({
      command: "cursor-agent",
      args: ["login"],
    });
    expect(buildAuthCommand({ target: "provider", provider: "codex" })).toEqual({
      command: "codex",
      args: ["login", "--device-auth"],
    });
    expect(buildAuthCommand({ target: "provider", provider: "claude" })).toEqual({
      command: "claude",
      args: ["auth", "login"],
    });
    expect(buildAuthCommand({ target: "provider", provider: "grok" })).toEqual({
      command: "grok",
      args: ["login", "--device-auth"],
    });
    expect(
      buildAuthCommand({ target: "provider", provider: "antigravity" }),
    ).toEqual({
      command: "agy",
      args: ["--print", "Reply exactly AUTHENTICATED"],
    });
    expect(
      buildAuthCommand({ target: "mcp", provider: "cursor", serverName: "pieces-prod" }),
    ).toEqual({
      command: "cursor-agent",
      args: ["mcp", "login", "pieces-prod"],
    });
    expect(
      buildAuthCommand({ target: "mcp", provider: "codex", serverName: "pieces-prod" }),
    ).toEqual({
      command: "codex",
      args: ["mcp", "login", "pieces-prod"],
    });
    expect(
      buildAuthCommand({ target: "mcp", provider: "claude", serverName: "pieces-prod" }),
    ).toEqual({
      command: "claude",
      args: ["mcp", "login", "--no-browser", "pieces-prod"],
    });
    expect(() =>
      buildAuthCommand({ target: "mcp", provider: "grok", serverName: "pieces-prod" }),
    ).toThrow(/does not expose/);
    expect(() =>
      buildAuthCommand({
        target: "mcp",
        provider: "antigravity",
        serverName: "pieces-prod",
      }),
    ).toThrow(/does not expose/);
  });

  it("rejects shell metacharacters, missing names, and unconfirmed logout", () => {
    expect(() =>
      buildAuthCommand({
        target: "mcp",
        provider: "codex",
        serverName: "safe; touch /tmp/pwned",
      }),
    ).toThrow(/serverName/);
    expect(() =>
      buildAuthCommand({
        target: "mcp",
        provider: "claude",
      }),
    ).toThrow(/serverName/);
    expect(() =>
      buildAuthCommand({
        target: "provider",
        provider: "cursor",
        operation: "logout",
      }),
    ).toThrow(/confirmLogout/);
    expect(
      buildAuthCommand({
        target: "provider",
        provider: "cursor",
        operation: "logout",
        confirmLogout: true,
      }),
    ).toEqual({ command: "cursor-agent", args: ["logout"] });
    expect(
      buildAuthCommand({
        target: "provider",
        provider: "grok",
        operation: "logout",
        confirmLogout: true,
      }),
    ).toEqual({ command: "grok", args: ["logout"] });
    expect(() =>
      buildAuthCommand({
        target: "provider",
        provider: "antigravity",
        operation: "logout",
        confirmLogout: true,
      }),
    ).toThrow(/does not expose/);
    expect(() =>
      buildAuthCommand({
        target: "mcp",
        provider: "cursor",
        operation: "logout",
        confirmLogout: true,
        serverName: "pieces",
      }),
    ).toThrow(/does not expose/);
  });
});

describe("interactive authentication broker", () => {
  it("captures a safe URL/device code and accepts one pasted redirect only", async () => {
    const { broker, executor, store } = brokerWith();
    const challenge = await broker.startChallenge({
      target: "mcp",
      provider: "claude",
      serverName: "pieces-prod",
    });
    expect(challenge.status).toBe("queued");

    const run = await waitForRun(executor);
    expect(run.invocation).toMatchObject({
      command: "claude",
      args: ["mcp", "login", "--no-browser", "pieces-prod"],
      target: "mcp",
      provider: "claude",
      serverName: "pieces-prod",
    });
    const outputSecret = "sk-output-only-secret";
    run.emit(
      [
        `Open https://auth.example.test/authorize?client_id=mesh&state=safe&access_token=${outputSecret}`,
        "Device code: ABCD-EFGH",
        "Paste the redirect URL back when prompted:",
      ].join("\n"),
    );

    const waiting = await waitForStatus(broker, challenge.id, "waiting_for_input");
    expect(waiting.authorizationUrl).toContain("https://auth.example.test/authorize");
    expect(waiting.authorizationUrl).toContain("access_token=REDACTED");
    expect(waiting.authorizationUrl).not.toContain(outputSecret);
    expect(waiting.deviceCode).toBe("ABCD-EFGH");
    expect(waiting.safePrompt).toBe(
      "Paste the browser redirect URL or one-time authorization code.",
    );

    const redirect =
      "http://127.0.0.1:8765/callback?code=one-time-callback-secret&state=safe";
    await broker.submitChallengeInput(challenge.id, redirect);
    expect(run.writes).toEqual([redirect]);
    await expect(broker.submitChallengeInput(challenge.id, redirect)).rejects.toThrow(
      /not waiting for input/,
    );

    const persisted = JSON.stringify([...store.records.values()]);
    expect(persisted).not.toContain(outputSecret);
    expect(persisted).not.toContain("one-time-callback-secret");
    run.finish();
    const completed = await waitForStatus(broker, challenge.id, "completed");
    expect(completed.completedAt).not.toBeNull();
    expect((await broker.listChallenges())[0]?.id).toBe(challenge.id);
  });

  it("accepts a one-time authorization code without retaining it", async () => {
    const { broker, executor, store } = brokerWith();
    const challenge = await broker.startChallenge({
      target: "provider",
      provider: "cursor",
    });
    const run = await waitForRun(executor);
    run.emit("Enter the one-time authorization code in this terminal:");
    await waitForStatus(broker, challenge.id, "waiting_for_input");

    await expect(
      broker.submitChallengeInput(challenge.id, "xai-abcdefghijklmnop"),
    ).rejects.toThrow(/Credential values/);
    await expect(
      broker.submitChallengeInput(challenge.id, "AIzaSyExampleCredentialValue1234"),
    ).rejects.toThrow(/Credential values/);
    await broker.submitChallengeInput(challenge.id, "ABCD-1234_oauth");
    expect(run.writes).toEqual(["ABCD-1234_oauth"]);
    expect(JSON.stringify([...store.records.values()])).not.toContain("ABCD-1234_oauth");
    run.finish();
    await waitForStatus(broker, challenge.id, "completed");
  });

  it("times out and terminates an executor that never completes", async () => {
    const { broker, executor } = brokerWith();
    const challenge = await broker.startChallenge({
      target: "provider",
      provider: "codex",
      timeoutMs: 25,
    });
    const run = await waitForRun(executor);

    const failed = await waitForStatus(broker, challenge.id, "failed");
    expect(failed.error).toMatch(/timed out/);
    expect(run.cancelled).toBe(true);
  });

  it("cancels a running challenge without allowing completion to overwrite it", async () => {
    const { broker, executor } = brokerWith();
    const challenge = await broker.startChallenge({
      target: "provider",
      provider: "claude",
    });
    const run = await waitForRun(executor);

    const cancelled = await broker.cancelChallenge(challenge.id);
    expect(cancelled.status).toBe("cancelled");
    expect(run.cancelled).toBe(true);
    run.finish();
    expect((await broker.getChallenge(challenge.id))?.status).toBe("cancelled");
  });

  it("keeps later challenges queued until the active challenge settles", async () => {
    const { broker, executor } = brokerWith(new FakeExecutor(), new MemoryStore(), {
      maxConcurrent: 1,
    });
    const first = await broker.startChallenge({
      target: "provider",
      provider: "cursor",
    });
    const second = await broker.startChallenge({
      target: "provider",
      provider: "claude",
    });
    const firstRun = await waitForRun(executor);
    expect((await broker.getChallenge(first.id))?.status).toBe("running");
    expect((await broker.getChallenge(second.id))?.status).toBe("queued");

    firstRun.finish();
    await waitForStatus(broker, first.id, "completed");
    const secondRun = await waitForRun(executor, 1);
    expect((await broker.getChallenge(second.id))?.status).toBe("running");
    secondRun.finish();
    await waitForStatus(broker, second.id, "completed");
  });

  it("fails closed on unsupported credential-entry/noninteractive flows", async () => {
    const { broker, executor, store } = brokerWith();
    const challenge = await broker.startChallenge({
      target: "provider",
      provider: "codex",
    });
    const run = await waitForRun(executor);
    const secret = "sk-abcdefghijklmnop";
    run.emit(`Noninteractive mode: paste your API key in this terminal: ${secret}`);

    const failed = await waitForStatus(broker, challenge.id, "failed");
    expect(failed.error).toMatch(/unsupported/);
    expect(failed.safePrompt).toBeNull();
    expect(run.cancelled).toBe(true);
    expect(JSON.stringify([...store.records.values()])).not.toContain(secret);
  });

  it("bounds terminal output and cancels an over-producing command", async () => {
    const { broker, executor } = brokerWith(new FakeExecutor(), new MemoryStore(), {
      maxOutputBytes: 64,
    });
    const challenge = await broker.startChallenge({
      target: "provider",
      provider: "cursor",
    });
    const run = await waitForRun(executor);
    run.emit("x".repeat(65));

    const failed = await waitForStatus(broker, challenge.id, "failed");
    expect(failed.error).toMatch(/output exceeded/);
    expect(run.cancelled).toBe(true);
  });

  it("persists only private, redacted metadata records", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-mesh-pty-auth-"));
    try {
      const directory = join(root, "challenges");
      const executor = new FakeExecutor();
      const broker = new InteractiveAuthBroker({
        executor,
        store: new FileAuthChallengeStore(directory),
        defaultTimeoutMs: 5_000,
        maxTimeoutMs: 10_000,
      });
      const challenge = await broker.startChallenge({
        target: "mcp",
        provider: "codex",
        serverName: "pieces",
        timeoutMs: 10_000,
      });
      const run = await waitForRun(executor);
      run.emit(
        "Open https://auth.example.test/oauth?client_id=mesh&token=do-not-persist\n",
      );
      await waitForStatus(broker, challenge.id, "waiting_for_browser");

      const path = join(directory, `${challenge.id}.json`);
      expect((await stat(path)).mode & 0o777).toBe(
        process.platform === "win32" ? 0o666 : 0o600,
      );
      const persisted = await readFile(path, "utf8");
      expect(persisted).not.toContain("do-not-persist");
      expect(persisted).not.toMatch(/terminal output/i);
      run.finish();
      await waitForStatus(broker, challenge.id, "completed");
      await broker.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
