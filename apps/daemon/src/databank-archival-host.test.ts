import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArchiveClient, type ArchiveIngestInput } from "@exocortex/memory/archive-client";
import { DatabankArchivalHost } from "./databank-archival-host.js";

function fakeFetch(status: number, body: unknown, onFetch?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    onFetch?.(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

test("DatabankArchivalHost: getStatus reports unconfigured when no ArchiveClient is available", async () => {
  const host = new DatabankArchivalHost({
    client: null,
  });
  const status = await host.getStatus();
  assert.equal(status.configured, false);
  assert.equal(status.available, false);
  assert.equal(status.reason, "not_configured");
  assert.equal(status.running, false);
});

test("DatabankArchivalHost: getStatus reports available: false when vault is locked or unreachable", async () => {
  const fakeDownFetch = fakeFetch(503, { error: "vault locked" });
  const client = new ArchiveClient({
    baseUrl: "https://vault.test",
    token: "mock-token",
    fetchImpl: fakeDownFetch,
  });

  const host = new DatabankArchivalHost({ client });
  const status = await host.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.available, false);
  assert.equal(status.reason, "error");
});

test("DatabankArchivalHost: getStatus reports items and chunks when vault is healthy", async () => {
  const healthyFetch = fakeFetch(200, { ok: true, items: 154, chunks: 890, blobs: 22 });
  const client = new ArchiveClient({
    baseUrl: "https://vault.test",
    token: "mock-token",
    fetchImpl: healthyFetch,
  });

  const host = new DatabankArchivalHost({ client });
  const status = await host.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.available, true);
  assert.equal(status.items, 154);
  assert.equal(status.chunks, 890);
  assert.equal(status.blobs, 22);
});

test("DatabankArchivalHost: runArchival skips gracefully when vault health check fails", async () => {
  const lockedFetch = fakeFetch(401, { error: "unauthorized" });
  const client = new ArchiveClient({
    baseUrl: "https://vault.test",
    token: "bad-token",
    fetchImpl: lockedFetch,
  });

  const host = new DatabankArchivalHost({ client });
  const result = await host.runArchival();
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "unauthorized");
});

test("DatabankArchivalHost: runArchival archives older memories and prunes with atomic backup", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "databank-test-"));
  try {
    const memoriesFile = join(tempDir, "memories.jsonl");

    const now = Date.parse("2026-10-15T12:00:00Z");
    const oldTs = now - 100 * 86_400_000; // 100 days old (older than 90)
    const freshTs = now - 10 * 86_400_000; // 10 days old (kept)

    const line1 = JSON.stringify({
      title: "Old Memory 1",
      body: "Distilled architecture decision from 100 days ago.",
      createdAt: new Date(oldTs).toISOString(),
      source: "ltm",
    });
    const line2 = JSON.stringify({
      title: "Fresh Memory 2",
      body: "Active workspace telemetry from last week.",
      createdAt: new Date(freshTs).toISOString(),
      source: "ltm",
    });

    await writeFile(memoriesFile, `${line1}\n${line2}\n`, "utf8");

    const ingested: ArchiveIngestInput[] = [];
    const fakeImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, items: 10, chunks: 50, blobs: 0 }), { status: 200 });
      }
      if (url.endsWith("/ingest/text")) {
        const parsed = JSON.parse(String(init?.body)) as ArchiveIngestInput;
        ingested.push(parsed);
        return new Response(JSON.stringify({ itemId: "item-ingested-1", existed: false, chunks: 2, vectors: 2, blobId: null }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const client = new ArchiveClient({
      baseUrl: "https://vault.test",
      token: "mock-token",
      fetchImpl: fakeImpl,
    });

    const host = new DatabankArchivalHost({
      client,
      memoryFilePath: memoriesFile,
      olderThanDays: 90,
      prune: true,
      now: () => now,
    });

    const result = await host.runArchival();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.scanned, 2);
      assert.equal(result.archived, 1);
      assert.equal(result.alreadyArchived, 0);
      assert.equal(result.kept, 1);
      assert.equal(result.pruned, true);
      assert.ok(result.backup);
    }

    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].title, "Old Memory 1");

    // Verify memory file only has fresh line kept
    const remaining = await readFile(memoriesFile, "utf8");
    assert.ok(remaining.includes("Fresh Memory 2"));
    assert.ok(!remaining.includes("Old Memory 1"));

    // Verify backup contains both lines
    if (result.ok && result.backup) {
      const backupContent = await readFile(result.backup, "utf8");
      assert.ok(backupContent.includes("Old Memory 1"));
      assert.ok(backupContent.includes("Fresh Memory 2"));
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("DatabankArchivalHost: prevents concurrent archival passes", async () => {
  let resolveHealth!: () => void;
  const gatePromise = new Promise<void>((res) => {
    resolveHealth = res;
  });

  const hangingFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      await gatePromise;
      return new Response(JSON.stringify({ ok: true, items: 0 }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  const client = new ArchiveClient({
    baseUrl: "https://vault.test",
    token: "mock-token",
    fetchImpl: hangingFetch,
  });

  const host = new DatabankArchivalHost({ client });

  // Start first run (hangs in health check)
  const run1Promise = host.runArchival();

  // Second run should immediately return already_running
  const run2Result = await host.runArchival();
  assert.equal(run2Result.ok, false);
  assert.equal((run2Result as { reason: string }).reason, "already_running");

  // Unblock first run
  resolveHealth();
  await run1Promise;
});

test("DatabankArchivalHost: start and stop lifecycle", () => {
  const host = new DatabankArchivalHost({
    client: null,
    intervalMs: 50_000,
    now: () => 1729000000000,
  });

  host.start();
  // Call stop cleanly
  host.stop();
});
