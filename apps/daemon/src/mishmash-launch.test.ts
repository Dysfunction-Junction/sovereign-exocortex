import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { waitForPing, buildChildEnv, MISHMASH_LAUNCH } from "./mishmash-launch.js";

test("D2: waitForPing stops polling promptly once the child has exited and reports the failure", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const started = Date.now();
  await assert.rejects(
    waitForPing("fake-node", "http://127.0.0.1:1", () => "LOGS", child),
    /fake-node exited early with code=3/,
  );
  assert.ok(Date.now() - started < 3000, `waitForPing kept polling for ${Date.now() - started}ms`);
});

function pingFetch(seen: Array<Record<string, string>>, from: string): typeof fetch {
  return (async (_u: unknown, init: RequestInit) => {
    seen.push({ ...(init.headers as Record<string, string>) });
    return new Response(JSON.stringify({ ok: true, from }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("waitForPing sends TRIAD_SERVER_TOKEN only to autonomous-triad", async () => {
  const env = { TRIAD_SERVER_TOKEN: "tok-123" } as NodeJS.ProcessEnv;
  const triadSeen: Array<Record<string, string>> = [];
  await waitForPing("autonomous-triad", "http://127.0.0.1:1", () => "", undefined, 2000, { env, fetchImpl: pingFetch(triadSeen, "autonomous-triad") });
  assert.equal(triadSeen[0]?.Authorization, "Bearer tok-123");
  const otherSeen: Array<Record<string, string>> = [];
  await waitForPing("registry-app", "http://127.0.0.1:1", () => "", undefined, 2000, { env, fetchImpl: pingFetch(otherSeen, "registry-app") });
  assert.equal(otherSeen[0]?.Authorization, undefined, "token must not leak to other nodes");
});

test("buildChildEnv passes the databank settings to the memory gateway only", () => {
  const prev = { url: process.env.DATABANK_URL, token: process.env.DATABANK_TOKEN };
  process.env.DATABANK_URL = "https://bank.example";
  process.env.DATABANK_TOKEN = "bank-token-123456";
  try {
    const memory = buildChildEnv("PORT", 1, {}, "pieces-for-all");
    assert.equal(memory.DATABANK_URL, "https://bank.example");
    assert.equal(memory.DATABANK_TOKEN, "bank-token-123456");
    for (const other of ["autonomous-triad", "registry-app", "agent-mesh-mcp", "pattern-analyzer"]) {
      const env = buildChildEnv("PORT", 1, {}, other);
      assert.equal(env.DATABANK_URL, undefined, `${other} must not see the databank url`);
      assert.equal(env.DATABANK_TOKEN, undefined, `${other} must not see the databank token`);
    }
    assert.equal(buildChildEnv("PORT", 1, {}).DATABANK_TOKEN, undefined, "no node id, no token");
  } finally {
    if (prev.url === undefined) delete process.env.DATABANK_URL;
    else process.env.DATABANK_URL = prev.url;
    if (prev.token === undefined) delete process.env.DATABANK_TOKEN;
    else process.env.DATABANK_TOKEN = prev.token;
  }
});

test("buildChildEnv passes TRIAD_SERVER_TOKEN to the triad child only", () => {
  const prev = process.env.TRIAD_SERVER_TOKEN;
  process.env.TRIAD_SERVER_TOKEN = "tok-xyz";
  try {
    assert.equal(buildChildEnv("PORT", 1, {}, "autonomous-triad").TRIAD_SERVER_TOKEN, "tok-xyz");
    assert.equal(buildChildEnv("PORT", 1, {}, "registry-app").TRIAD_SERVER_TOKEN, undefined);
  } finally {
    if (prev === undefined) delete process.env.TRIAD_SERVER_TOKEN;
    else process.env.TRIAD_SERVER_TOKEN = prev;
  }
});

test("waitForPing sends the memory gateway token only to pieces-for-all", async () => {
  const env = { GATEWAY_TOKEN: " mem-tok " } as NodeJS.ProcessEnv;
  const memSeen: Array<Record<string, string>> = [];
  await waitForPing("pieces-for-all", "http://127.0.0.1:1", () => "", undefined, 2000, { env, fetchImpl: pingFetch(memSeen, "pieces-for-all") });
  assert.equal(memSeen[0]?.Authorization, "Bearer mem-tok");
  const otherSeen: Array<Record<string, string>> = [];
  await waitForPing("registry-app", "http://127.0.0.1:1", () => "", undefined, 2000, { env, fetchImpl: pingFetch(otherSeen, "registry-app") });
  assert.equal(otherSeen[0]?.Authorization, undefined);
});

test("buildChildEnv passes the gateway token to the memory gateway only", () => {
  const prev = { g: process.env.GATEWAY_TOKEN, p: process.env.PIECES_GATEWAY_TOKEN };
  process.env.GATEWAY_TOKEN = "gw-tok";
  process.env.PIECES_GATEWAY_TOKEN = "pg-tok";
  try {
    const mem = buildChildEnv("PORT", 1, {}, "pieces-for-all");
    assert.equal(mem.GATEWAY_TOKEN, "gw-tok");
    assert.equal(mem.PIECES_GATEWAY_TOKEN, "pg-tok");
    const other = buildChildEnv("PORT", 1, {}, "registry-app");
    assert.equal(other.GATEWAY_TOKEN, undefined);
    assert.equal(other.PIECES_GATEWAY_TOKEN, undefined);
  } finally {
    if (prev.g === undefined) delete process.env.GATEWAY_TOKEN; else process.env.GATEWAY_TOKEN = prev.g;
    if (prev.p === undefined) delete process.env.PIECES_GATEWAY_TOKEN; else process.env.PIECES_GATEWAY_TOKEN = prev.p;
  }
});

const PROTECTED = ["TRIAD_SERVER_TOKEN", "GATEWAY_TOKEN", "PIECES_GATEWAY_TOKEN"] as const;

function withSentinelTokens<T>(fn: (sentinels: Record<string, string>) => T): T {
  const sentinels = Object.fromEntries(PROTECTED.map((k) => [k, `sentinel-${k.toLowerCase()}`]));
  const prev = Object.fromEntries(PROTECTED.map((k) => [k, process.env[k]]));
  Object.assign(process.env, sentinels);
  try {
    return fn(sentinels);
  } finally {
    for (const k of PROTECTED) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("buildChildEnv gives unrelated nodes none of the protected service tokens", () => {
  withSentinelTokens((sentinels) => {
    for (const spec of MISHMASH_LAUNCH) {
      if (spec.id === "autonomous-triad" || spec.id === "pieces-for-all") continue;
      const env = buildChildEnv(spec.portVariable, spec.port, sentinels, spec.id);
      for (const k of PROTECTED) assert.equal(env[k], undefined, `${spec.id} leaked ${k}`);
    }
  });
});

test("buildChildEnv gives the triad only its server token and the memory gateway only the gateway tokens", () => {
  withSentinelTokens((sentinels) => {
    const triad = buildChildEnv("PORT", 1, sentinels, "autonomous-triad");
    assert.equal(triad.TRIAD_SERVER_TOKEN, sentinels.TRIAD_SERVER_TOKEN);
    assert.equal(triad.GATEWAY_TOKEN, undefined);
    assert.equal(triad.PIECES_GATEWAY_TOKEN, undefined);

    const memory = buildChildEnv("PORT", 1, sentinels, "pieces-for-all");
    assert.equal(memory.GATEWAY_TOKEN, sentinels.GATEWAY_TOKEN);
    assert.equal(memory.PIECES_GATEWAY_TOKEN, sentinels.PIECES_GATEWAY_TOKEN);
    assert.equal(memory.TRIAD_SERVER_TOKEN, undefined);
  });
});
