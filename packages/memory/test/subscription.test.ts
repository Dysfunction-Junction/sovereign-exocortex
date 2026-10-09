import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { OpenRouterError } from "../src/openrouter.js";
import { resolveReasoningClient, wrapOpenRouter } from "../src/reasoning.js";
import { OpenRouterClient } from "../src/openrouter.js";
import {
  parseAntigravityOutput,
  parseClaudeOutput,
  parseCodexOutput,
  SubscriptionCliClient,
  subscriptionChildEnv,
  type SpawnFn,
  type SpawnOptions,
  type SpawnStreams,
} from "../src/subscription.js";

delete process.env.CLAUDE_MODEL;
delete process.env.CODEX_MODEL;
delete process.env.ANTIGRAVITY_MODEL;
delete process.env.REASONING_PROVIDER;

function scriptedSpawn(script: {
  stdout?: string;
  stderr?: string;
  code?: number;
  onInvoke?: (command: string, args: string[], options: SpawnOptions, prompt: string) => void;
}): { spawnFn: SpawnFn; killed: () => boolean } {
  let killed = false;
  const spawnFn: SpawnFn = (command, args, options) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    let prompt = "";
    const child: SpawnStreams = {
      stdin: {
        write(data: string) {
          prompt += data;
        },
        end() {
          script.onInvoke?.(command, args, options, prompt);
          if (script.stdout) stdout.emit("data", Buffer.from(script.stdout));
          if (script.stderr) stderr.emit("data", Buffer.from(script.stderr));
          for (const listener of exitListeners) listener(script.code ?? 0, null);
        },
      },
      stdout,
      stderr,
      kill() {
        killed = true;
        return true;
      },
      on(event, listener) {
        if (event === "close") {
          exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        }
      },
    };
    return child;
  };
  return { spawnFn, killed: () => killed };
}

test("parseClaudeOutput reads the result field and rejects CLI errors", () => {
  assert.equal(parseClaudeOutput('{"result":" hello from claude ","is_error":false}'), "hello from claude");
  assert.throws(
    () => parseClaudeOutput('{"is_error":true,"result":"login required"}'),
    (err: unknown) => err instanceof OpenRouterError && err.code === "UPSTREAM_ERROR"
  );
});

test("parseCodexOutput prefers the final-message file, then JSONL", () => {
  assert.equal(parseCodexOutput("  from file  ", ""), "from file");
  const stdout = [
    '{"item":{"type":"command_execution","text":"nope"}}',
    '{"item":{"type":"agent_message","text":"from jsonl"}}',
  ].join("\n");
  assert.equal(parseCodexOutput("", stdout), "from jsonl");
});

test("subscriptionChildEnv removes metered API keys from the CLI environment", () => {
  const env = subscriptionChildEnv({
    ANTHROPIC_API_KEY: "sk-anthropic-sentinel",
    OPENAI_API_KEY: "sk-openai-sentinel",
    OPENROUTER_API_KEY: "sk-or-v1-sentinel",
    GEMINI_API_KEY: "gemini-sentinel",
    GOOGLE_API_KEY: "google-sentinel",
    ANTHROPIC_AUTH_TOKEN: "tok-sentinel",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    PATH: "C:\\Windows",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.PATH, "C:\\Windows");
});

test("parseAntigravityOutput reads the result response and maps quota errors", () => {
  const ok = [
    '{"event":"init","init":{}}',
    '{"event":"result","result":{"status":"SUCCESS","response":" pong "}}',
  ].join("\n");
  assert.equal(parseAntigravityOutput(ok), "pong");

  const quota = '{"event":"result","result":{"status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription."}}';
  assert.throws(
    () => parseAntigravityOutput(quota),
    (err: unknown) => err instanceof OpenRouterError && err.status === 429 && err.code === "RATE_LIMIT"
  );
});

test("Claude subscription CLI disables tools and keeps the prompt off the command line", async () => {
  const needle = "UNIQUE_PROMPT_NEEDLE";
  let seenArgs: string[] = [];
  let seenPrompt = "";
  let seenEnv: NodeJS.ProcessEnv = {};
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-anthropic-sentinel";

  const { spawnFn } = scriptedSpawn({
    stdout: JSON.stringify({ result: "subscription answer", is_error: false }),
    onInvoke: (_command, args, options, prompt) => {
      seenArgs = args;
      seenPrompt = prompt;
      seenEnv = options.env;
    },
  });

  try {
    const client = new SubscriptionCliClient({
      provider: "claude",
      spawnFn,
      credentialCheck: () => true,
    });
    const result = await client.chat(needle, "Use the notes.");
    assert.equal(result.content, "subscription answer");
    assert.equal(result.model, "claude-subscription");
    assert.ok(seenArgs.includes("-p"));
    assert.equal(seenArgs.includes("--bare"), false);
    assert.ok(seenArgs.includes("--tools"));
    assert.equal(seenArgs[seenArgs.indexOf("--tools") + 1], "");
    // token stripping: no user MCP tools / settings / default agent prompt
    assert.ok(seenArgs.includes("--strict-mcp-config"));
    assert.equal(seenArgs[seenArgs.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.equal(seenArgs[seenArgs.indexOf("--setting-sources") + 1], "");
    assert.ok(seenArgs.includes("--system-prompt"));
    assert.ok(seenArgs.includes("--disable-slash-commands"));
    assert.equal(seenArgs.includes(needle), false);
    assert.match(seenPrompt, new RegExp(needle));
    assert.match(seenPrompt, /Use the notes/);
    assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, "sk-anthropic-sentinel");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("Codex subscription CLI stays read-only and reads the final message file", async () => {
  const needle = "CODEX_PROMPT_NEEDLE";
  let seenArgs: string[] = [];
  const { spawnFn } = scriptedSpawn({
    onInvoke: (_command, args, _options, prompt) => {
      seenArgs = args;
      assert.equal(args.includes(needle), false);
      assert.match(prompt, new RegExp(needle));
      const file = args[args.indexOf("-o") + 1];
      assert.ok(file);
      writeFileSync(file!, "codex subscription answer");
    },
  });

  const client = new SubscriptionCliClient({
    provider: "codex",
    spawnFn,
    credentialCheck: () => true,
  });
  const result = await client.chat(needle);
  assert.equal(result.content, "codex subscription answer");
  assert.ok(seenArgs.includes("exec"));
  assert.ok(seenArgs.includes("read-only"));
  assert.ok(seenArgs.includes("--ephemeral"));
  assert.equal(seenArgs.at(-1), "-");
});

test("Antigravity CLI sends the prompt as stdin JSON and stays in plan mode", async () => {
  const needle = "AGY_PROMPT_NEEDLE";
  let seenCommand = "";
  let seenArgs: string[] = [];
  let seenPrompt = "";
  const { spawnFn } = scriptedSpawn({
    code: 3,
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"from antigravity"}}',
    onInvoke: (command, args, _options, prompt) => {
      seenCommand = command;
      seenArgs = args;
      seenPrompt = prompt;
    },
  });

  const client = new SubscriptionCliClient({
    provider: "antigravity",
    spawnFn,
    credentialCheck: () => true,
    timeoutMs: 5000,
  });
  const result = await client.chat(needle);
  assert.equal(result.content, "from antigravity");
  assert.equal(seenCommand, "agy");
  assert.ok(seenArgs.includes("--mode"));
  assert.equal(seenArgs[seenArgs.indexOf("--mode") + 1], "plan");
  assert.ok(seenArgs.includes("--sandbox"));
  assert.equal(seenArgs.includes(needle), false);
  const parsed = JSON.parse(seenPrompt) as { event: string; message: { content: string } };
  assert.equal(parsed.event, "user");
  assert.match(parsed.message.content, new RegExp(needle));
});

test("Subscription client does not spawn when the login file is absent", async () => {
  let spawned = false;
  const client = new SubscriptionCliClient({
    provider: "claude",
    credentialCheck: () => false,
    spawnFn: () => {
      spawned = true;
      throw new Error("spawned");
    },
  });
  await assert.rejects(
    () => client.chat("hello"),
    (err: unknown) => err instanceof OpenRouterError && err.code === "MISSING_SUBSCRIPTION"
  );
  assert.equal(spawned, false);
});

test("Subscription CLI redacts secrets from a failed CLI stderr", async () => {
  const { spawnFn } = scriptedSpawn({
    code: 1,
    stderr: "auth failed for sk-abcdefghijklmnopqrstuvwxyz",
  });
  const client = new SubscriptionCliClient({
    provider: "claude",
    spawnFn,
    credentialCheck: () => true,
  });
  await assert.rejects(
    () => client.chat("hello"),
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.code, "UPSTREAM_ERROR");
      assert.equal(err.message.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
      assert.equal((err.details ?? "").includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
      return true;
    }
  );
});

test("Aborting the caller kills the subscription CLI", async () => {
  const controller = new AbortController();
  const { spawnFn, killed } = scriptedSpawn({
    onInvoke: () => {
      controller.abort();
    },
    code: 0,
    stdout: '{"result":"too late"}',
  });
  const client = new SubscriptionCliClient({
    provider: "claude",
    spawnFn,
    credentialCheck: () => true,
    timeoutMs: 5000,
  });
  await assert.rejects(
    () => client.chat("hello", undefined, { signal: controller.signal }),
    (err: unknown) => err instanceof OpenRouterError && err.code === "CLIENT_ABORTED"
  );
  assert.equal(killed(), true);
});

test("resolveReasoningClient selects a provider from REASONING_PROVIDER", () => {
  const openRouter = new OpenRouterClient({ apiKey: "present" });
  assert.equal(resolveReasoningClient(openRouter, {}).provider, "openrouter");
  assert.equal(resolveReasoningClient(openRouter, { REASONING_PROVIDER: "claude" }).provider, "claude");
  assert.equal(resolveReasoningClient(openRouter, { REASONING_PROVIDER: "codex" }).billing, "subscription");
  assert.equal(resolveReasoningClient(openRouter, { REASONING_PROVIDER: "antigravity" }).provider, "antigravity");
  assert.equal(wrapOpenRouter(openRouter).hasCredentials(), true);
  assert.throws(
    () => resolveReasoningClient(openRouter, { REASONING_PROVIDER: "browser-cookie" }),
    /Unknown REASONING_PROVIDER/
  );
});

test("Subscription CLI waits for stdio close so late stdout is not truncated", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const spawnFn: SpawnFn = () => ({
    stdin: {
      write() {},
      end() {
        // exit fires first; the result arrives on stdout afterwards, then close.
        setImmediate(() => {
          exitListener?.(0, null);
          stdout.emit("data", Buffer.from('{"result":"late answer"}'));
          closeListener?.(0, null);
        });
      },
    },
    stdout,
    stderr,
    kill: () => true,
    on(event: string, listener: any) {
      if (event === "close") closeListener = listener;
      if (event === "exit") exitListener = listener;
    },
  } as SpawnStreams);
  const client = new SubscriptionCliClient({ provider: "claude", spawnFn, credentialCheck: () => true });
  const res = await client.chat("hello");
  assert.equal(res.content, "late answer");
});

test("Subscription CLI survives an async EPIPE error on stdin", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const spawnFn: SpawnFn = () => ({
    stdin: Object.assign(stdinEmitter, {
      write() {},
      end() {
        setImmediate(() => {
          // Without an error listener this emit throws (uncaught in production).
          stdinEmitter.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
          stderr.emit("data", Buffer.from("bad flag"));
          closeListener?.(2, null);
        });
      },
    }),
    stdout,
    stderr,
    kill: () => true,
    on(event: string, listener: any) {
      if (event === "close") closeListener = listener;
    },
  } as SpawnStreams);
  const client = new SubscriptionCliClient({ provider: "claude", spawnFn, credentialCheck: () => true });
  await assert.rejects(
    () => client.chat("hello"),
    (err: unknown) => err instanceof OpenRouterError && err.code === "UPSTREAM_ERROR"
  );
});

test("Subscription CLI never forwards a model id that starts with a dash", async () => {
  let seenArgs: string[] = [];
  const { spawnFn } = scriptedSpawn({
    stdout: '{"result":"ok"}',
    onInvoke: (_c, args) => {
      seenArgs = args;
    },
  });
  const client = new SubscriptionCliClient({ provider: "claude", spawnFn, credentialCheck: () => true });
  await client.chat("hello", undefined, { model: "--dangerously-skip-permissions" });
  assert.equal(seenArgs.includes("--dangerously-skip-permissions"), false);
  assert.equal(seenArgs.includes("--model"), false);
});
