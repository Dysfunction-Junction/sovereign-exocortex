import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { forwardDelegate, localNodes, type DelegateEnvelope } from "./network.js";
import { defaultReposRoot, MISHMASH_LAUNCH, startMishmash, stopMishmash, tsxBin } from "./mishmash-launch.js";

function envelope(to: string, action: string, capability: string, payload: Record<string, unknown> = {}): DelegateEnvelope {
  return {
    v: 1,
    id: "0123456789abcdef",
    from: "pieces-android-companion-seamless",
    to,
    capability,
    action,
    payload,
  };
}

test("forwardDelegate posts the envelope to the loopback upstream", async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; from: string; action: string };
      const payload = JSON.stringify({
        v: 1,
        inReplyTo: body.id,
        from: "hermes-api",
        to: body.from,
        ok: true,
        result: { action: body.action },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const outcome = await forwardDelegate(envelope("hermes-api", "ping", "device"), {
      HERMES_UPSTREAM: `http://127.0.0.1:${port}`,
    });
    assert.equal(outcome.status, 200);
    assert.equal((outcome.body as { ok: boolean }).ok, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

const reposRoot = defaultReposRoot();
const siblingsPresent = MISHMASH_LAUNCH.every((spec) => existsSync(join(reposRoot, spec.repo)));

test("every local project answers through one delegate path", { timeout: 90_000, skip: !siblingsPresent || !tsxBin() }, async () => {
  const ports: Record<string, number> = {};
  const probes: import("node:http").Server[] = [];
  for (const spec of MISHMASH_LAUNCH) {
    const probe = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const p = typeof address === "object" && address ? address.port : 0;
        resolve(p);
      });
      probe.on("error", reject);
    });
    ports[spec.id] = port;
    probes.push(probe);
  }
  await Promise.all(probes.map((p) => new Promise<void>((res) => p.close(() => res()))));

  const handle = await startMishmash({ reposRoot, ports });
  try {
    const patterns = [
      { id: "low", promotionScore: 1, lastObservedAt: "2026-10-01T00:00:00.000Z" },
      { id: "high", promotionScore: 10, lastObservedAt: "2026-10-01T00:00:00.000Z" },
    ];
    const checks: Array<{ id: string; capability: string; action: string; payload: Record<string, unknown>; check: (result: Record<string, unknown>) => void }> = [
      {
        id: "hermes-api",
        capability: "device",
        action: "decide",
        payload: {},
        check: (result) => assert.match(String(result.decision), /Tacos/),
      },
      {
        id: "autonomous-triad",
        capability: "intent",
        action: "classify",
        payload: { text: "review this diff" },
        check: (result) => assert.equal(result.intent, "REVIEW"),
      },
      {
        id: "pieces-for-all",
        capability: "memory",
        action: "status",
        payload: {},
        check: (result) => assert.equal(typeof result.piecesReachable, "boolean"),
      },
      {
        id: "agent-mesh-mcp",
        capability: "mesh",
        action: "skills",
        payload: {},
        check: (result) => assert.equal((result.skills as unknown[]).length, 4),
      },
      {
        id: "pattern-analyzer",
        capability: "patterns",
        action: "rank",
        payload: { patterns },
        check: (result) => assert.equal((result.order as Array<{ id: string }>)[0]?.id, "high"),
      },
      {
        id: "registry-app",
        capability: "staging",
        action: "stage",
        payload: { patterns },
        check: (result) => assert.equal(result.topId, "high"),
      },
      {
        id: "gut-instinct",
        capability: "coach",
        action: "contract",
        payload: {},
        check: (result) => {
          assert.equal(result.minEvidence, 3);
          assert.equal(result.packages, undefined);
        },
      },
      {
        id: "tool-registry-heartbeat",
        capability: "inventory",
        action: "inventory",
        payload: {},
        check: (result) => assert.ok((result.scripts as string[]).includes("heartbeat-wrapper.ps1")),
      },
    ];

    const ids = localNodes({}).map((node) => node.id);
    assert.deepEqual(ids, checks.map((item) => item.id));

    for (const item of checks) {
      const ping = await forwardDelegate(envelope(item.id, "ping", item.capability), handle.env);
      assert.equal(ping.status, 200, `${item.id} ping ${JSON.stringify(ping.body)} ${handle.logs()}`);
      const outcome = await forwardDelegate(
        envelope(item.id, item.action, item.capability, item.payload),
        handle.env,
      );
      assert.equal(outcome.status, 200, `${item.id} ${item.action} ${JSON.stringify(outcome.body)} ${handle.logs()}`);
      const body = outcome.body as { ok?: boolean; result?: Record<string, unknown> };
      assert.equal(body.ok, true);
      item.check(body.result ?? {});
    }
  } finally {
    await stopMishmash(handle);
  }
});
