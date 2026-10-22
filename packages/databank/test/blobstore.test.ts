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
