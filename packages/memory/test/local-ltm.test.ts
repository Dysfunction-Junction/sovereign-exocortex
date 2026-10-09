import test from "node:test";
import assert from "node:assert/strict";
import { rm, appendFile } from "node:fs/promises";
import { LocalLTM } from "../src/local-ltm.js";

const TEST_FILE = "data/test-memories.jsonl";

test("LocalLTM offline memory storage and retrieval", async (t) => {
  const ltm = new LocalLTM(TEST_FILE);
  await rm(TEST_FILE, { force: true });

  try {
    await t.test("adds memories to local storage with provenance", async () => {
      const mem1 = await ltm.addMemory({
        title: "Android Native Architecture",
        body: "Native AccessibilityService and NotificationListener with on-device Gemini Nano.",
        source: "pieces-android-companion-seamless",
        tags: ["android", "security"],
      });
      assert.equal(mem1.title, "Android Native Architecture");
      assert.equal(mem1.source, "pieces-android-companion-seamless");

      const mem2 = await ltm.addMemory({
        title: "Biometric Gating Plane",
        body: "Speculative pre-execution proposals gated by 128-bit single-use nonces.",
        source: "autonomous-triad",
        tags: ["biometric", "triad"],
      });
      assert.equal(mem2.title, "Biometric Gating Plane");
      assert.equal(mem2.source, "autonomous-triad");
    });

    await t.test("searches memories by keyword token overlap with zero cloud calls", async () => {
      const hits = await ltm.searchMemories("accessibility android", 5);
      assert.ok(hits.length >= 1);
      assert.equal(hits[0].title, "Android Native Architecture");
      assert.ok(hits[0].score > 0);
      assert.equal(hits[0].untrusted, true);

      const bioHits = await ltm.searchMemories("nonce biometric", 5);
      assert.ok(bioHits.length >= 1);
      assert.equal(bioHits[0].title, "Biometric Gating Plane");
      assert.equal(bioHits[0].untrusted, true);
    });

    await t.test("clamps limit safely and handles empty queries", async () => {
      const emptyHits = await ltm.searchMemories("", 5);
      assert.equal(emptyHits.length, 0);

      const clamped = await ltm.searchMemories("biometric", 100);
      assert.ok(clamped.length <= 50);
    });

    await t.test("sanitizes tags, strips untrusted fields, and provides fallback date for legacy records", async () => {
      // Append malformed JSON and missing-body records
      await appendFile(TEST_FILE, "NOT_JSON_AT_ALL\n", "utf8");
      await appendFile(TEST_FILE, JSON.stringify({ title: "Incomplete", tags: ["bad"] }) + "\n", "utf8");
      await appendFile(TEST_FILE, JSON.stringify({ body: "No Title", createdAt: "2026-10-08T00:00:00Z" }) + "\n", "utf8");

      // Append valid title & body with legacy missing date, mixed tags, and untrusted extraneous property
      await appendFile(
        TEST_FILE,
        JSON.stringify({
          title: "Legacy Note",
          body: "Legacy record with no createdAt and dirty tags",
          tags: ["valid-tag", 12345, null, "another-tag"],
          evilUntrustedKey: "should_be_stripped",
        }) + "\n",
        "utf8",
      );

      const all = await ltm.getAllMemories();
      // 2 earlier memories + 1 legacy note = 3 memories
      assert.equal(all.length, 3);

      const legacy = all.find((m) => m.title === "Legacy Note");
      assert.ok(legacy);
      assert.equal(legacy.createdAt, "1970-01-01T00:00:00.000Z");
      assert.deepEqual(legacy.tags, ["valid-tag", "another-tag"]);
      assert.equal((legacy as any).evilUntrustedKey, undefined);

      const searchHits = await ltm.searchMemories("Incomplete", 5);
      assert.equal(searchHits.length, 0);

      const legacyHits = await ltm.searchMemories("Legacy record", 5);
      assert.equal(legacyHits.length, 1);
      assert.equal(legacyHits[0].title, "Legacy Note");
    });

    await t.test("safely prepends newline if prior line ended without newline", async () => {
      // Append a line without trailing newline
      await appendFile(TEST_FILE, JSON.stringify({ title: "Unterminated", body: "No newline at end" }), "utf8");

      // addMemory should detect missing newline and prepend one
      await ltm.addMemory({
        title: "Clean Next",
        body: "Should not merge into Unterminated",
      });

      const all = await ltm.getAllMemories();
      const unterminated = all.find((m) => m.title === "Unterminated");
      const cleanNext = all.find((m) => m.title === "Clean Next");
      assert.ok(unterminated, "Unterminated record should be preserved");
      assert.ok(cleanNext, "Clean Next record should be preserved");
    });

    await t.test("rejects empty or whitespace title at write time", async () => {
      await assert.rejects(
        async () => {
          await ltm.addMemory({ title: "   ", body: "Valid body" });
        },
        /title is required/,
      );
    });

    await t.test("clamps future dates against Date.now()", async () => {
      const futureDate = new Date(Date.now() + 1000000000).toISOString();
      await appendFile(
        TEST_FILE,
        JSON.stringify({ title: "Future Post", body: "From year 3000", createdAt: futureDate }) + "\n",
        "utf8",
      );
      const all = await ltm.getAllMemories();
      const future = all.find((m) => m.title === "Future Post");
      assert.ok(future);
      assert.ok(new Date(future.createdAt).getTime() <= Date.now() + 1000);
    });
  } finally {
    await rm(TEST_FILE, { force: true });
  }
});
