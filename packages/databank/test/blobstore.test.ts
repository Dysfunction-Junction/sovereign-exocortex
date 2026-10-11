import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BlobStore, isBlobId } from "../src/blobstore.js";
import { DatabankKeys } from "../src/crypto.js";

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
