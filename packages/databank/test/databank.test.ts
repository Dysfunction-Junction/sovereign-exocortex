import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Databank, type Embedder } from "../databank.js";
import { archiveMemories } from "../archive.js";
import { DatabankKeys } from "../crypto.js";
import { chunkText } from "../text.js";

/** Deterministic bag-of-words embedder: shared words give high cosine. Can be switched off. */
class FakeEmbedder implements Embedder {
  readonly model = "fake-bow";
  up = true;
  calls = 0;
  private vec(text: string): number[] {
    const v = new Array(64).fill(0);
    for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64;
      v[h] += 1;
    }
    return v;
  }
  async embedQuery(t: string): Promise<number[] | null> {
    return this.up ? this.vec(t) : null;
  }
  async embedDocuments(ts: string[]): Promise<(number[] | null)[]> {
    this.calls++;
    return ts.map((t) => (this.up ? this.vec(t) : null));
  }
}

describe("Databank", () => {
  let root: string;
  let emb: FakeEmbedder;
  let bank: Databank;
  const keys = new DatabankKeys(Buffer.alloc(32, 2));
  let t = 1_700_000_000_000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dbk-bank-"));
    Databank.provision(root, "test-vault");
    emb = new FakeEmbedder();
    bank = Databank.open({ root, keys, embedder: emb, now: () => ++t });
  });
  afterEach(() => {
    bank.close();
    rmSync(root, { recursive: true, force: true });
  });

  const note = (title: string, text: string, extra: Partial<Parameters<Databank["ingestText"]>[0]> = {}) =>
    bank.ingestText({ source: "ltm", kind: "memory", title, text, ...extra });

  it("refuses an unprovisioned or unmounted vault", () => {
    const bare = mkdtempSync(join(tmpdir(), "dbk-bare-"));
    assert.throws(() => Databank.open({ root: bare, keys }), /vault not mounted or not provisioned/);
    rmSync(bare, { recursive: true, force: true });
  });

  it("indexes text and finds it by keyword and by meaning", async () => {
    await note("Pharmacy", "prescription refill ready for pickup tomorrow");
    await note("Dentist", "appointment with the dentist at three");
    await note("Recipe", "slow cooked chili with beans and peppers");

    const kw = await bank.search("prescription");
    assert.equal(kw[0].title, "Pharmacy");
    assert.equal(kw[0].via, "hybrid");

    const sem = await bank.search("refill pickup");
    assert.equal(sem[0].title, "Pharmacy");
    assert.ok(sem[0].score > 0);
  });

  it("is idempotent: the same item is not stored or embedded twice", async () => {
    const a = await note("A", "same body text");
    const calls = emb.calls;
    const b = await note("A", "same body text");
    assert.equal(a.itemId, b.itemId);
    assert.equal(b.existed, true);
    assert.equal(emb.calls, calls);
    assert.equal(bank.stats().items, 1);
  });

  it("falls back to keyword search when the embedder is down, and reindex backfills", async () => {
    emb.up = false;
    const r = await note("Offline", "keyword only item about gardening");
    assert.equal(r.vectors, 0);
    const hits = await bank.search("gardening");
    assert.equal(hits[0].via, "fts");

    emb.up = true;
    assert.ok((await bank.reindex()) >= 1);
    assert.equal(bank.stats().vectors, bank.stats().chunks);
    assert.equal((await bank.search("gardening"))[0].via, "hybrid");
  });

  it("applies kind, source and time filters", async () => {
    await note("Old memo", "budget review notes", { ts: 1_000, source: "a" });
    await note("New memo", "budget review notes", { ts: 9_000, source: "b" });
    await bank.ingestText({ source: "b", kind: "document", title: "Doc", text: "budget review notes" });
    assert.equal((await bank.search("budget review", { source: "a" })).length, 1);
    assert.equal((await bank.search("budget review", { kind: "document" })).length, 1);
    const recent = await bank.search("budget review", { since: 5_000, kind: "memory" });
    assert.deepEqual(recent.map((h) => h.title), ["New memo"]);
  });

  it("treats FTS operators and quotes in queries as plain text", async () => {
    await note("Quote", 'he said "hello" (twice) AND left');
    for (const q of ['"hello', "hello OR (", "NEAR(a b)", "*", "-hello", "a:b"]) {
      await assert.doesNotReject(bank.search(q));
    }
    assert.equal((await bank.search('"hello"'))[0].title, "Quote");
  });

  it("ingests files: media by path words, documents by content, blobs round-trip", async () => {
    const src = mkdtempSync(join(tmpdir(), "dbk-src-"));
    mkdirSync(join(src, "Vacation 2019", "Beach"), { recursive: true });
    writeFileSync(join(src, "Vacation 2019", "Beach", "IMG_0042.jpg"), Buffer.from([0xff, 0xd8, 1, 2, 3]));
    writeFileSync(join(src, "taxes.txt"), "Schedule C expenses for the smokehouse truck");
    writeFileSync(join(src, "desktop.ini"), "skip me");
    const s = await bank.ingestDir(src, { source: "oldpc" });
    assert.equal(s.files, 2);
    assert.equal(s.newItems, 2);
    assert.deepEqual(s.failed, []);

    const photo = (await bank.search("beach vacation", { kind: "photo" }))[0];
    assert.equal(photo.title, "IMG_0042.jpg");
    assert.equal(photo.path, "Vacation 2019/Beach/IMG_0042.jpg");

    const doc = (await bank.search("smokehouse truck expenses"))[0];
    assert.equal(doc.title, "taxes.txt");
    const parts: Buffer[] = [];
    for await (const c of bank.blobs.get(doc.blobId!)) parts.push(c as Buffer);
    assert.equal(Buffer.concat(parts).toString(), "Schedule C expenses for the smokehouse truck");

    // Re-running over the same tree changes nothing.
    const again = await bank.ingestDir(src, { source: "oldpc" });
    assert.equal(again.newItems, 0);
    assert.equal(again.existing, 2);
    rmSync(src, { recursive: true, force: true });
  });

  it("refuses to ingest a directory that overlaps the vault", async () => {
    await assert.rejects(bank.ingestDir(root, { source: "x" }), /inside the vault|contains/);
    await assert.rejects(bank.ingestDir(join(root, "blobs"), { source: "x" }), /inside the vault|contains/);
    await assert.rejects(bank.ingestDir(join(root, ".."), { source: "x" }), /inside the vault|contains/);
  });

  it("keeps the ingest log hash-chained, append-only and tamper-evident", async () => {
    await note("one", "first");
    await note("two", "second");
    assert.deepEqual(bank.verifyLog(), { ok: true, entries: 2 });

    const raw = new DatabaseSync(join(root, "index", "databank.db"));
    assert.throws(() => raw.exec("UPDATE ingest_log SET action = 'x'"), /append-only/);
    assert.throws(() => raw.exec("DELETE FROM ingest_log"), /append-only/);
    raw.exec("DROP TRIGGER ingest_log_no_update");
    raw.exec("UPDATE ingest_log SET item_id = 'forged' WHERE seq = 1");
    raw.close();
    const v = bank.verifyLog();
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
  });

  it("verifyBlobs reports corrupted blobs", async () => {
    const r = await note("blobby", "some content to protect");
    assert.deepEqual((await bank.verifyBlobs()).bad, []);
    const p = bank.blobs.pathFor(r.blobId!);
    const bytes = readFileSync(p);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(p, bytes);
    const res = await bank.verifyBlobs();
    assert.equal(res.bad.length, 1);
    assert.equal(res.bad[0].id, r.blobId);
  });

  it("archives old memories, skips new and malformed lines, and prunes with a backup", async () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 11);
    const file = join(root, "memories.jsonl");
    const line = (title: string, ageDays: number) =>
      JSON.stringify({ title, body: `${title} body`, createdAt: new Date(now - ageDays * day).toISOString(), source: "test", tags: ["x"] });
    writeFileSync(file, [line("old one", 200), line("old two", 120), line("fresh", 3), "{not json"].join("\n") + "\n");

    const dry = await archiveMemories(bank, file, { olderThanDays: 90, now });
    assert.deepEqual([dry.scanned, dry.archived, dry.kept, dry.pruned], [3, 2, 2, false]);
    assert.ok(readFileSync(file, "utf8").includes("old one"));

    const done = await archiveMemories(bank, file, { olderThanDays: 90, prune: true, now });
    assert.equal(done.alreadyArchived, 2);
    assert.equal(done.archived, 0);
    assert.ok(done.pruned && existsSync(done.backup!));
    const left = readFileSync(file, "utf8");
    assert.ok(left.includes("fresh") && left.includes("{not json") && !left.includes("old one"));
    assert.equal((await bank.search("old two"))[0].title, "old two");
  });

  it("chunks long text with overlap and caps degenerate input", () => {
    const para = Array.from({ length: 120 }, (_, i) => `Sentence number ${i} says something.`).join(" ");
    const chunks = chunkText(para);
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every((c) => c.length <= 1000));
    assert.deepEqual(chunkText("   "), []);
    assert.equal(chunkText("short").length, 1);
    assert.ok(chunkText("x".repeat(5000)).length >= 6);
  });
});
