import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Databank, minMax, classifySensitivity, type Sensitivity, type SearchOptions, type Embedder } from "../databank.js";
import { SCHEMA_SQL } from "../schema.js";
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

  it("partitions keyword and vector candidates by owner before ranking", async () => {
    const own = await note("Own", "partitionword shared orchard");
    const gwen = await note("Gwen", "partitionword shared orchard", { meta: { owner: "gwen" } });
    await note("Legacy Gwen", "partitionword shared orchard", { source: "gwen-messenger" });
    await note("Tier Gwen", "partitionword shared orchard", { meta: { tier: "gwen-knowledge-base" } });
    for (const up of [true, false]) {
      emb.up = up;
      assert.deepEqual((await bank.search("partitionword")).map(h => h.itemId), [own.itemId]);
      const hers = await bank.search("partitionword", { owner: "gwen", maxSensitivity: "private" });
      assert.equal(hers.length, 3);
      assert.ok(hers.some(h => h.itemId === gwen.itemId));
      assert.deepEqual(await bank.search("partitionword", { source: "gwen-messenger" }), []);
    }
    emb.up = true;
    const [vector] = await emb.embedDocuments(["partitionword shared orchard"]);
    emb.embedQuery = async () => vector;
    const semantic = await bank.search("unmatchedqueryterm");
    assert.deepEqual(semantic.map(h => h.itemId), [own.itemId]);
    assert.equal(semantic[0].via, "vector");
    assert.equal((await bank.search("unmatchedqueryterm", { owner: "gwen", maxSensitivity: "private" })).length, 3);
  });

  it("keeps Michael candidates when Gwen fills the entire candidate window", async () => {
    for (let i = 0; i < 55; i++) {
      await note(`Gwen ${i}`, "windowfixture orchard", { meta: { owner: "gwen" }, storeBlob: false });
    }
    const own = await note("Own", "windowfixture orchard");
    emb.up = false;
    assert.deepEqual((await bank.search("windowfixture", { k: 1 })).map(h => h.itemId), [own.itemId]);
    emb.up = true;
    const [vector] = await emb.embedDocuments(["windowfixture orchard"]);
    emb.embedQuery = async () => vector;
    assert.deepEqual((await bank.search("unmatchedqueryterm", { k: 1 })).map(h => h.itemId), [own.itemId]);
    assert.equal((await bank.search("windowfixture", { owner: " Gwen " })).length, 10);
    await assert.rejects(bank.search("windowfixture", { owner: " " }), /invalid owner/);
  });

  it("enforces every ceiling and independent audience gate in FTS, hybrid and vector-only search", async () => {
    for (const sensitivity of ["public", "personal", "private", "secret", "clinical", "child"] as Sensitivity[]) {
      await note(`Fixture ${sensitivity}`, "sensitivityfixture orchard", { sensitivity });
    }
    const [vector] = await emb.embedDocuments(["sensitivityfixture orchard"]);
    const cases: Array<[SearchOptions, Sensitivity[]]> = [
      [{}, ["public", "personal"]],
      [{ maxSensitivity: "public" }, ["public"]],
      [{ maxSensitivity: "private" }, ["public", "personal", "private"]],
      [{ includeClinical: true }, ["public", "personal", "clinical"]],
      [{ includeChild: true }, ["public", "personal", "child"]],
      [{ maxSensitivity: "private", includeClinical: true, includeChild: true }, ["public", "personal", "private", "clinical", "child"]],
    ];
    for (const mode of ["fts", "hybrid", "vector"] as const) {
      emb.up = mode !== "fts";
      emb.embedQuery = async () => emb.up ? vector : null;
      for (const [options, expected] of cases) {
        const hits = await bank.search(mode === "vector" ? "unmatchedqueryterm" : "sensitivityfixture", options);
        assert.deepEqual(hits.map(h => h.title).sort(), expected.map(s => `Fixture ${s}`).sort(), mode);
        assert.ok(hits.every(h => h.via === mode));
      }
    }
  });

  it("ANDs owner with private clearance and audience flags", async () => {
    const gwen = await note("Private fixture", "audiencefixture orchard", { source: "gwen-messenger" });
    assert.equal(bank.getItem(gwen.itemId)?.sensitivity, "private");
    const open = { maxSensitivity: "private", includeClinical: true, includeChild: true } as const;
    assert.deepEqual(await bank.search("audiencefixture", open), []);
    assert.deepEqual(await bank.search("audiencefixture", { owner: "gwen" }), []);
    assert.equal((await bank.search("audiencefixture", { ...open, owner: "gwen" }))[0].itemId, gwen.itemId);
  });

  it("filters restricted items before the FTS and vector candidate windows", async () => {
    for (let i = 0; i < 55; i++) {
      await note(`Restricted ${i}`, "clearancewindow orchard", { sensitivity: "secret", storeBlob: false });
    }
    const own = await note("Allowed", "clearancewindow orchard");
    emb.up = false;
    assert.deepEqual((await bank.search("clearancewindow", { k: 1 })).map(h => h.itemId), [own.itemId]);
    emb.up = true;
    const [vector] = await emb.embedDocuments(["clearancewindow orchard"]);
    emb.embedQuery = async () => vector;
    assert.deepEqual((await bank.search("unmatchedqueryterm", { k: 1 })).map(h => h.itemId), [own.itemId]);
  });

  it("rechecks sensitivity when it changes during query embedding", async () => {
    const own = await note("Changed", "sensitivityrace orchard");
    emb.embedQuery = async () => {
      const raw = new DatabaseSync(join(root, "index", "databank.db"));
      try { raw.prepare("UPDATE items SET sensitivity = 'secret' WHERE item_id = ?").run(own.itemId); }
      finally { raw.close(); }
      return null;
    };
    assert.deepEqual(await bank.search("sensitivityrace"), []);
  });

  it("normalizes ingest hints into the column and never reads them as query-time fallbacks", async () => {
    const hidden = await note("Hint", "hintfixture", { meta: { sensitivity: "private" } });
    assert.equal(bank.getItem(hidden.itemId)?.sensitivity, "private");
    assert.deepEqual(await bank.search("hintfixture"), []);
    const raw = new DatabaseSync(join(root, "index", "databank.db"));
    try {
      raw.prepare("UPDATE items SET meta = ? WHERE item_id = ?").run('{"sensitivity":"public"}', hidden.itemId);
      assert.throws(() => raw.exec("UPDATE items SET sensitivity = 'bogus'"), /CHECK/);
    } finally { raw.close(); }
    assert.deepEqual(await bank.search("hintfixture"), []);
    assert.equal((await bank.search("hintfixture", { maxSensitivity: "private" }))[0].itemId, hidden.itemId);
    await assert.rejects(note("Bad hint", "body", { meta: { sensitivity: "bogus" } }), /invalid sensitivity/);
  });

  it("rejects runtime clearance bypasses", async () => {
    for (const options of [
      { maxSensitivity: "secret" }, { maxSensitivity: "clinical" }, { maxSensitivity: "bogus" },
      { minSensitivity: "private" }, { includeClinical: "true" }, { includeChild: 1 },
    ]) await assert.rejects(bank.search("x", options as unknown as SearchOptions), /invalid sensitivity/);
  });

  it("classifies text and files before their rows become searchable", async () => {
    const text = await note("Neutral fixture", "Form W-9 synthetic classificationfixture", { sensitivity: "public" });
    assert.equal(bank.getItem(text.itemId)?.sensitivity, "secret");
    const file = join(root, "Google_Passwords.txt");
    writeFileSync(file, "synthetic classificationfixture");
    const result = await bank.ingestFile(file, { source: "fixture" });
    assert.equal(bank.getItem(result.itemId)?.sensitivity, "secret");
    assert.deepEqual(await bank.search("classificationfixture", {
      maxSensitivity: "private", includeClinical: true, includeChild: true,
    }), []);
  });

  it("classifies the named synthetic rule fixtures and respects priority", () => {
    const fixtures: Array<[string, Sensitivity]> = [
      ["Google_Passwords.pdf", "secret"], ["Google_Passwords.xlsx", "secret"],
      ["passwd.txt", "secret"], ["SSN_scan.pdf", "secret"], ["EIN_notice.pdf", "secret"],
      ["000-00-0000.txt", "secret"], ["00-0000000.txt", "secret"],
      ["1040.pdf", "secret"], ["W-2.pdf", "secret"], ["W-9.pdf", "secret"],
      ["tax-return.pdf", "secret"], ["insurance_card.jpg", "secret"], ["Ordinary journal", "personal"],
    ];
    for (const [title, expected] of fixtures) assert.equal(classifySensitivity({ source: "fixture", title }).sensitivity, expected, title);
    assert.equal(classifySensitivity({ source: "fixture", title: "Scan", text: "Member ID: SYNTHETIC" }).sensitivity, "secret");
    assert.equal(classifySensitivity({ source: "fixture", title: "Scan", text: "Form W-9" }).sensitivity, "secret");
    assert.equal(classifySensitivity({ source: "fixture", title: "Scan", path: "archive/passwords/card.pdf" }).sensitivity, "secret");
    assert.equal(classifySensitivity({ source: "gwen-messenger", title: "Note", meta: { sensitivity: "public" } }).sensitivity, "private");
    assert.equal(classifySensitivity({ source: "gwen-messenger", title: "passwords" }).sensitivity, "secret");
    assert.equal(classifySensitivity({ source: "fixture", title: "Session", sensitivity: "clinical" }).sensitivity, "clinical");
    for (const path of ["Mana/YouTube Kids/history.html", "Mana/School Forms/enrollment.pdf", "Mana\\School Forms\\enrollment.pdf"]) {
      assert.equal(classifySensitivity({ source: "fixture", title: "Fixture", path }).sensitivity, "child");
    }
    for (const source of ["youtube-kids", "mana-youtube-kids", "school-forms"]) {
      assert.equal(classifySensitivity({ source, title: "Fixture", sensitivity: "public" }).sensitivity, "child");
    }
    assert.equal(classifySensitivity({ source: "fixture", title: "Export", sensitivity: "public" }).sensitivity, "public");
  });

  it("atomically migrates v2, preserves counts and storage tier, backs up, and records evidence", async () => {
    const legacy = mkdtempSync(join(tmpdir(), "dbk-v2-"));
    let migrated: Databank | undefined;
    try {
      Databank.provision(legacy, "fixture");
      const dbPath = join(legacy, "index", "databank.db");
      mkdirSync(join(legacy, "index"));
      const raw = new DatabaseSync(dbPath);
      raw.exec(SCHEMA_SQL.replace(/^.*sensitivity TEXT.*\n/m, ""));
      raw.exec("INSERT INTO meta VALUES ('schema_version', '2')");
      const insert = raw.prepare("INSERT INTO items (item_id, source, kind, title, path, ts, ingested_at) VALUES (?, ?, 'document', ?, ?, 1, 1)");
      for (const [id, source, title, path] of [
        ["a", "fixture", "passwords.pdf", ""], ["b", "fixture", "1040.pdf", ""],
        ["c", "fixture", "ssn.pdf", ""], ["d", "gwen-messenger", "Fixture", ""],
        ["e", "fixture", "Fixture", "Mana/School Forms/form.pdf"], ["f", "fixture", "Ordinary", ""],
      ]) {
        insert.run(id, source, title, path);
        raw.prepare("INSERT INTO chunks (item_id, ord, text) VALUES (?, 0, ?)").run(id, `${title} migrationfixture`);
      }
      raw.close();
      migrated = Databank.open({ root: legacy, keys, embedder: null });
      assert.equal(migrated.getItem("a")?.sensitivity, "secret");
      assert.equal(migrated.getItem("d")?.sensitivity, "private");
      assert.equal(migrated.getItem("e")?.sensitivity, "child");
      assert.equal(migrated.getItem("f")?.sensitivity, "personal");
      assert.equal(migrated.getItem("a")?.tier, "archived");
      for (const term of ["password", "1040", "ssn"]) assert.deepEqual(await migrated.search(term), []);
      const audit = new DatabaseSync(dbPath);
      const receipt = JSON.parse(String(audit.prepare("SELECT value FROM meta WHERE key = 'sensitivity_migration_v3'").get()?.value));
      assert.deepEqual(receipt.before, { items: 6, chunks: 6, vectors: 0, ingest_log: 0 });
      assert.deepEqual(receipt.before, receipt.after);
      assert.equal(receipt.classifiedByRule, 5);
      assert.equal(receipt.leftAtDefault, 1);
      assert.deepEqual(receipt.bySensitivity, { secret: 3, private: 1, child: 1, personal: 1 });
      assert.equal(audit.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, "3");
      audit.close();
      const backups = readdirSync(join(legacy, "index")).filter(p => p.startsWith("databank.pre-v3-"));
      assert.equal(backups.length, 1);
      const backup = new DatabaseSync(join(legacy, "index", backups[0]), { readOnly: true });
      assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, "2");
      assert.ok(!backup.prepare("PRAGMA table_info(items)").all().some(r => r.name === "sensitivity"));
      backup.close();
      migrated.close();
      migrated = Databank.open({ root: legacy, keys });
      assert.equal(readdirSync(join(legacy, "index")).filter(p => p.startsWith("databank.pre-v3-")).length, 1);
    } finally {
      migrated?.close();
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it("rolls back column creation, backfill and version together if migration fails", () => {
    const legacy = mkdtempSync(join(tmpdir(), "dbk-rollback-"));
    try {
      Databank.provision(legacy, "fixture");
      mkdirSync(join(legacy, "index"));
      const dbPath = join(legacy, "index", "databank.db");
      const raw = new DatabaseSync(dbPath);
      raw.exec(SCHEMA_SQL.replace(/^.*sensitivity TEXT.*\n/m, ""));
      raw.exec("INSERT INTO meta VALUES ('schema_version', '2'); INSERT INTO items (item_id, source, kind, title, ts, ingested_at) VALUES ('a', 'fixture', 'document', 'passwords', 1, 1)");
      raw.exec("CREATE TRIGGER refuse_backfill BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
      raw.close();
      assert.throws(() => Databank.open({ root: legacy, keys }), /fixture failure/);
      const check = new DatabaseSync(dbPath);
      assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, "2");
      assert.ok(!check.prepare("PRAGMA table_info(items)").all().some(r => r.name === "sensitivity"));
      assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'sensitivity_migration_v3'").get(), undefined);
      check.close();
    } finally { rmSync(legacy, { recursive: true, force: true }); }
  });

  it("rechecks ownership if it changes while query embedding is in flight", async () => {
    const own = await note("Reassigned", "reassignmentfixture orchard");
    assert.equal((await bank.search("reassignmentfixture"))[0].itemId, own.itemId);
    emb.embedQuery = async () => {
      const raw = new DatabaseSync(join(root, "index", "databank.db"));
      raw.prepare("UPDATE items SET meta = ? WHERE item_id = ?").run(JSON.stringify({ owner: "gwen" }), own.itemId);
      raw.close();
      return null;
    };
    assert.deepEqual(await bank.search("reassignmentfixture"), []);
    assert.equal((await bank.search("reassignmentfixture", { owner: "gwen" }))[0].itemId, own.itemId);
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

  it("archives old memories, skips new and malformed lines, and refuses to prune", async () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 11);
    const file = join(root, "memories.jsonl");
    const line = (title: string, ageDays: number) =>
      JSON.stringify({ title, body: `${title} body`, createdAt: new Date(now - ageDays * day).toISOString(), source: "test", tags: ["x"] });
    writeFileSync(file, [line("old one", 200), line("old two", 120), line("fresh", 3), "{not json"].join("\n") + "\n");

    const dry = await archiveMemories(bank, file, { olderThanDays: 90, now });
    assert.deepEqual([dry.scanned, dry.archived, dry.kept, dry.pruned], [3, 2, 2, false]);
    assert.ok(readFileSync(file, "utf8").includes("old one"));

    const before = readFileSync(file, "utf8");
    await assert.rejects(archiveMemories(bank, file, { olderThanDays: 90, prune: true, now }), /pruning is disabled/);
    assert.equal(readFileSync(file, "utf8"), before, "a refused prune must not touch the memory file");
    assert.deepEqual(readdirSync(root).filter((f) => f.includes(".pre-prune-") || f.includes(".tmp-")), []);

    const again = await archiveMemories(bank, file, { olderThanDays: 90, now });
    assert.equal(again.alreadyArchived, 2);
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

  it("search produces stable finite scores and handles unmatched terms gracefully", async () => {
    await note("TestDoc", "unique words to match query");
    const hitsEmpty = await bank.search("nonexistenttermthatcannotmatchanything");
    assert.deepEqual(hitsEmpty, []);

    const hitsMatch = await bank.search("unique");
    assert.ok(hitsMatch.length > 0);
    for (const h of hitsMatch) {
      assert.ok(Number.isFinite(h.score));
      assert.ok(h.score >= 0 && h.score <= 1.0);
    }
  });

  it("minMax normalizes correctly and never produces NaN or gives non-finite inputs max score", () => {
    // [NaN, 1]: single finite value maps to 1, NaN maps to 0
    assert.deepEqual(minMax([NaN, 1]), [0, 1]);
    // [NaN, NaN]: no finite values maps all to 0
    assert.deepEqual(minMax([NaN, NaN]), [0, 0]);
    // [Infinity, 2, 3]: Infinity maps to 0, 2 maps to 0, 3 maps to 1
    assert.deepEqual(minMax([Infinity, 2, 3]), [0, 0, 1]);
    // [5, 5]: equal values map to 1
    assert.deepEqual(minMax([5, 5]), [1, 1]);
    // Empty array maps to []
    assert.deepEqual(minMax([]), []);
  });
});
