import test from "node:test";
import assert from "node:assert/strict";
import { rm, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { LocalLTM } from "../src/local-ltm.js";
import { OllamaEmbedder, VectorCache, cosine } from "../src/embeddings.js";

const TEST_FILE = "data/test-embeddings-memories.jsonl";
const CACHE_FILE = `${TEST_FILE}.vec.jsonl`;

// Concept groups stand in for a real model: words in one group share a
// dimension, so "medication" and "prescription" are close with zero keyword
// overlap, which is exactly what token-overlap search cannot do.
const CONCEPTS: string[][] = [
  ["prescription", "medication", "pharmacy", "refill", "pills"],
  ["biometric", "fingerprint", "face", "approval"],
  ["log", "event", "audit", "ledger"],
  ["pizza", "food", "dinner"],
];

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const v = CONCEPTS.map((group) => group.filter((w) => lower.includes(w)).length);
  v.push(0.05); // keeps vectors non-zero
  return v;
}

function makeFetch(counter: { calls: number; inputs: string[] }, fail = false): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    counter.calls += 1;
    if (fail) throw new Error("connect ECONNREFUSED");
    const body = JSON.parse(String(init?.body));
    counter.inputs.push(...body.input);
    return new Response(JSON.stringify({ embeddings: (body.input as string[]).map(fakeVector) }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("OllamaEmbedder contract", async (t) => {
  await t.test("applies nomic task prefixes and returns one vector per input", async () => {
    const counter = { calls: 0, inputs: [] as string[] };
    const e = new OllamaEmbedder({ fetchImpl: makeFetch(counter) });
    const q = await e.embedQuery("medication");
    const d = await e.embedDocuments(["alpha", "beta"]);
    assert.ok(q && q.length === CONCEPTS.length + 1);
    assert.equal(d.length, 2);
    assert.deepEqual(counter.inputs, ["search_query: medication", "search_document: alpha", "search_document: beta"]);
  });

  await t.test("returns null (never throws) when Ollama is unreachable", async () => {
    const e = new OllamaEmbedder({ fetchImpl: makeFetch({ calls: 0, inputs: [] }, true) });
    assert.equal(await e.embedQuery("x"), null);
    assert.deepEqual(await e.embedDocuments(["a", "b"]), [null, null]);
  });

  await t.test("returns null on malformed, mismatched, or non-ok responses", async () => {
    const respond = (status: number, payload: unknown) =>
      (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
    assert.equal(await new OllamaEmbedder({ fetchImpl: respond(500, {}) }).embedQuery("x"), null);
    assert.equal(await new OllamaEmbedder({ fetchImpl: respond(200, { embeddings: [] }) }).embedQuery("x"), null);
    assert.equal(await new OllamaEmbedder({ fetchImpl: respond(200, { embeddings: [["a"]] }) }).embedQuery("x"), null);
    assert.equal(await new OllamaEmbedder({ fetchImpl: respond(200, { embeddings: [[NaN]] }) }).embedQuery("x"), null);
  });

  await t.test("cosine handles zero and mismatched vectors", () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([0, 0], [1, 1]), 0);
    assert.equal(cosine([1], [1, 1]), 0);
    assert.equal(cosine([], []), 0);
  });
});

test("LocalLTM hybrid semantic search", async (t) => {
  await rm(TEST_FILE, { force: true });
  await rm(CACHE_FILE, { force: true });

  try {
    const counter = { calls: 0, inputs: [] as string[] };
    const ltm = new LocalLTM(TEST_FILE, { embedder: new OllamaEmbedder({ fetchImpl: makeFetch(counter) }) });
    await ltm.addMemory({ title: "Pharmacy refill", body: "Prescription pills ready for pickup.", source: "sms" });
    await ltm.addMemory({ title: "Event ledger", body: "Append-only audit log of everything.", source: "core" });
    await ltm.addMemory({ title: "Dinner plan", body: "Order pizza on Friday.", source: "notes" });

    await t.test("finds a memory by meaning with zero keyword overlap", async () => {
      assert.deepEqual((await ltm.searchMemories("medication", 5)).length, 0, "lexical search cannot match");
      const hits = await ltm.searchMemoriesHybrid("medication", 5);
      assert.equal(hits[0]?.title, "Pharmacy refill");
      assert.equal(hits[0].untrusted, true);
      assert.ok(hits[0].score > 0);
    });

    await t.test("caches document vectors so later searches only embed the query", async () => {
      assert.ok(existsSync(CACHE_FILE));
      counter.inputs.length = 0;
      await ltm.searchMemoriesHybrid("audit", 5);
      assert.deepEqual(counter.inputs, ["search_query: audit"]);
    });

    await t.test("re-embeds only the memory that changed", async () => {
      await ltm.addMemory({ title: "Biometric gate", body: "Fingerprint approval.", source: "triad" });
      counter.inputs.length = 0;
      await ltm.searchMemoriesHybrid("face", 5);
      assert.equal(counter.inputs.length, 2, "one query + one new document");
      assert.ok(counter.inputs[1].startsWith("search_document: Biometric gate"));
    });

    await t.test("falls back to token-overlap search when Ollama is down", async () => {
      const down = new LocalLTM(TEST_FILE, {
        embedder: new OllamaEmbedder({ fetchImpl: makeFetch({ calls: 0, inputs: [] }, true) }),
      });
      const hits = await down.searchMemoriesHybrid("pizza friday", 5);
      assert.equal(hits[0]?.title, "Dinner plan");
      assert.deepEqual(await down.searchMemoriesHybrid("medication", 5), []);
    });

    await t.test("without an embedder behaves exactly like searchMemories", async () => {
      const plain = new LocalLTM(TEST_FILE);
      assert.deepEqual(await plain.searchMemoriesHybrid("pizza friday", 5), await plain.searchMemories("pizza friday", 5));
    });

    await t.test("empty query returns nothing", async () => {
      assert.deepEqual(await ltm.searchMemoriesHybrid("   ", 5), []);
    });

    await t.test("persists vectors only in the sidecar and tolerates malformed cache lines", async () => {
      await appendFile(CACHE_FILE, "not json\n{\"k\":1}\n", "utf8");
      const cache = new VectorCache(CACHE_FILE, "nomic-embed-text");
      const map = await cache.load();
      assert.ok(map.size >= 3);
      const raw = await readFile(TEST_FILE, "utf8");
      assert.ok(!raw.includes('"v":['), "vectors must never be written into the memory file");
    });
  } finally {
    await rm(TEST_FILE, { force: true });
    await rm(CACHE_FILE, { force: true });
  }
});

test("LocalLTM resolves its embedder lazily, after .env would have loaded", async () => {
  const file = "data/test-lazy-memories.jsonl";
  await rm(file, { force: true });
  await rm(`${file}.vec.jsonl`, { force: true });
  try {
    let factoryCalls = 0;
    const ltm = new LocalLTM(file, {
      embedderFactory: () => {
        factoryCalls++;
        return null; // env says embeddings are off by the time it is first needed
      },
    });
    assert.equal(factoryCalls, 0, "nothing is read at construction/import time");
    await ltm.addMemory({ title: "Lazy", body: "resolved on first use", source: "test" });
    assert.equal((await ltm.searchMemoriesHybrid("lazy", 3))[0]?.title, "Lazy");
    await ltm.searchMemoriesHybrid("lazy", 3);
    assert.equal(factoryCalls, 1, "resolved once and reused");
  } finally {
    await rm(file, { force: true });
    await rm(`${file}.vec.jsonl`, { force: true });
  }
});
