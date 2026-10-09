import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { waitForPing, buildChildEnv } from "./mishmash-launch.js";

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
