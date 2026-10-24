import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BlobStore, isBlobId } from "../blobstore.js";
import { DatabankKeys } from "../crypto.js";
import { legacyEncrypt } from "./legacy-xdb2.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

describe("BlobStore", () => {
  let dir: string;
  let store: BlobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dbk-blob-"));
    store = new BlobStore(dir, new DatabankKeys(Buffer.alloc(32, 4)));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = async (id: string): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const c of store.get(id)) parts.push(c as Buffer);
    return Buffer.concat(parts);
  };

  it("replaces a corrupt incumbent instead of deduplicating against it", async () => {
    const data = Buffer.from("integrity matters ".repeat(200));
    const first = await store.put(Readable.from([data]));
    const blobPath = store.pathFor(first.id);
    const good = readFileSync(blobPath);
    writeFileSync(blobPath, good.subarray(0, Math.floor(good.length / 2))); // truncate: corrupt incumbent
    assert.equal((await store.verify(first.id)).ok, false);

    const second = await store.put(Readable.from([data]));
    assert.equal(second.id, first.id);
    assert.equal(second.deduped, false, "a corrupt incumbent must not be reported as a dedupe hit");
    assert.equal((await store.verify(first.id)).ok, true);
    assert.ok(readdirSync(dirname(blobPath)).some((f) => f.includes(".corrupt-")), "the bad copy is kept for inspection");
  });

  it("still deduplicates against an intact incumbent", async () => {
    const data = Buffer.from("same bytes");
    const first = await store.put(Readable.from([data]));
    const second = await store.put(Readable.from([data]));
    assert.equal(second.id, first.id);
    assert.equal(second.deduped, true);
  });

  it("stores, dedupes identical content and reads it back", async () => {
    const a = await store.put(Readable.from([Buffer.from("photo bytes")]));
    const b = await store.put(Readable.from([Buffer.from("photo bytes")]));
    assert.equal(a.id, b.id);
    assert.equal(a.deduped, false);
    assert.equal(b.deduped, true);
    assert.equal((await read(a.id)).toString(), "photo bytes");
    assert.ok(isBlobId(a.id));
  });

  it("new blobs are XDB3 and keep the HMAC id of the plaintext", async () => {
    const r = await store.put(Readable.from([Buffer.from("fresh")]));
    assert.equal(readFileSync(store.pathFor(r.id)).subarray(0, 4).toString(), "XDB3");
    const h = new DatabankKeys(Buffer.alloc(32, 4)).idHasher();
    h.update(Buffer.from("fresh"));
    assert.equal(h.digest(), r.id);
  });

  it("reads and verifies an existing XDB2 blob, and put() dedupes against it without rewriting", async () => {
    const keys = new DatabankKeys(Buffer.alloc(32, 4));
    const h = keys.idHasher();
    h.update(Buffer.from("old data"));
    const id = h.digest();
    mkdirSync(dirname(store.pathFor(id)), { recursive: true });
    writeFileSync(store.pathFor(id), legacyEncrypt(keys, Buffer.from("old data"), Buffer.from([9, 9, 9, 9])));
    assert.equal((await read(id)).toString(), "old data");
    assert.deepEqual(await store.verify(id), { ok: true });
    const again = await store.put(Readable.from([Buffer.from("old data")]));
    assert.equal(again.id, id);
    assert.equal(again.deduped, true);
    assert.equal(readFileSync(store.pathFor(id)).subarray(0, 4).toString(), "XDB2");
  });

  it("leaves no temp files and never writes plaintext to disk", async () => {
    const r = await store.put(Readable.from([Buffer.from("secret text")]));
    assert.deepEqual(readdirSync(join(dir, "tmp")), []);
    assert.ok(!readFileSync(store.pathFor(r.id)).includes(Buffer.from("secret text")));
  });

  it("verify passes, then fails after corruption", async () => {
    const r = await store.put(Readable.from([Buffer.alloc(3000, 1)]));
    assert.deepEqual(await store.verify(r.id), { ok: true });
    const p = store.pathFor(r.id);
    const bytes = readFileSync(p);
    bytes[20] ^= 0xff;
    writeFileSync(p, bytes);
    assert.equal((await store.verify(r.id)).ok, false);
  });

  it("rejects path-traversal style ids", () => {
    for (const bad of ["../etc/passwd", "a".repeat(63), "G".repeat(64), "", "../".repeat(30)]) {
      assert.throws(() => store.pathFor(bad), /invalid blob id/);
    }
  });
});

describe("BlobStore.rewriteLegacy", () => {
  let dir: string;
  let keys: DatabankKeys;
  let store: BlobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dbk-mig-"));
    keys = new DatabankKeys(Buffer.alloc(32, 5));
    store = new BlobStore(dir, keys);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plant = (plain: Buffer): string => {
    const h = keys.idHasher();
    h.update(plain);
    const id = h.digest();
    mkdirSync(dirname(store.pathFor(id)), { recursive: true });
    writeFileSync(store.pathFor(id), legacyEncrypt(keys, plain, Buffer.from([7, 7, 7, 7])));
    return id;
  };
  const magic = (id: string): string => readFileSync(store.pathFor(id)).subarray(0, 4).toString();
  const read = async (id: string): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for await (const c of store.get(id)) parts.push(c as Buffer);
    return Buffer.concat(parts);
  };

  it("replaces an XDB2 blob with XDB3 under the same id and plaintext", async () => {
    const plain = Buffer.alloc(1024 * 1024 + 99, 3);
    const id = plant(plain);
    assert.deepEqual(await store.rewriteLegacy(id), { id, migrated: true });
    assert.equal(magic(id), "XDB3");
    assert.ok((await read(id)).equals(plain));
    assert.deepEqual(await store.verify(id), { ok: true });
    assert.deepEqual(readdirSync(join(dir, "tmp")), []);
    assert.deepEqual(readdirSync(dirname(store.pathFor(id))).filter((f) => f.endsWith(".bak")), []);
  });

  it("is a no-op for an XDB3 blob", async () => {
    const r = await store.put(Readable.from([Buffer.from("already new")]));
    const before = readFileSync(store.pathFor(r.id));
    assert.deepEqual(await store.rewriteLegacy(r.id), { id: r.id, migrated: false });
    assert.ok(readFileSync(store.pathFor(r.id)).equals(before));
  });

  it("a corrupt legacy blob throws and the original is untouched", async () => {
    const id = plant(Buffer.from("will be damaged"));
    const bytes = readFileSync(store.pathFor(id));
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(store.pathFor(id), bytes);
    await assert.rejects(store.rewriteLegacy(id));
    assert.ok(readFileSync(store.pathFor(id)).equals(bytes));
    assert.deepEqual(readdirSync(join(dir, "tmp")), []);
  });

  it("a failure after the temp file is written keeps the original readable and removes the temp", async () => {
    class Flaky extends BlobStore {
      protected override async beforeReplace(): Promise<void> {
        throw new Error("simulated crash before replace");
      }
    }
    const flaky = new Flaky(dir, keys);
    const id = plant(Buffer.from("survive me"));
    const original = readFileSync(flaky.pathFor(id));
    await assert.rejects(flaky.rewriteLegacy(id), /simulated crash/);
    assert.ok(readFileSync(flaky.pathFor(id)).equals(original));
    assert.deepEqual(readdirSync(join(dir, "tmp")), []);
    assert.equal(magic(id), "XDB2");
    assert.deepEqual(await flaky.verify(id), { ok: true });
  });

  it("the original stays addressable and a backup exists at every point of the swap (no rename gap)", async () => {
    const seen: { called: boolean; finalPresent: boolean; backupPresent: boolean } = {
      called: false,
      finalPresent: false,
      backupPresent: false,
    };
    class Probe extends BlobStore {
      protected override async afterBackup(id: string): Promise<void> {
        seen.called = true;
        seen.finalPresent = await this.has(id);
        seen.backupPresent = readdirSync(dirname(this.pathFor(id))).some((f) => f.endsWith(".bak"));
      }
    }
    const probe = new Probe(dir, keys);
    const id = plant(Buffer.from("never missing"));
    assert.deepEqual(await probe.rewriteLegacy(id), { id, migrated: true });
    assert.equal(seen.called, true, "afterBackup hook must run between backup and replace");
    assert.equal(seen.finalPresent, true, "blob must still resolve by id while the backup exists");
    assert.equal(seen.backupPresent, true);
    assert.deepEqual(readdirSync(dirname(probe.pathFor(id))).filter((f) => f.endsWith(".bak")), []);
    assert.deepEqual(await probe.verify(id), { ok: true });
  });

  it("a crash right after the backup is taken leaves the blob readable under its id", async () => {
    class Crashy extends BlobStore {
      protected override async afterBackup(): Promise<void> {
        throw new Error("simulated crash after backup");
      }
    }
    const crashy = new Crashy(dir, keys);
    const id = plant(Buffer.from("crash window"));
    await assert.rejects(crashy.rewriteLegacy(id), /simulated crash after backup/);
    assert.deepEqual(await crashy.verify(id), { ok: true });
    assert.equal(magic(id), "XDB2");
    assert.deepEqual(readdirSync(dirname(crashy.pathFor(id))).filter((f) => f.endsWith(".bak")), []);
  });

  it("refuses an id that does not exist or is not a blob id", async () => {
    await assert.rejects(store.rewriteLegacy("not-an-id"), /invalid blob id/);
    await assert.rejects(store.rewriteLegacy("a".repeat(64)));
  });
});
