/**
 * @file blobstore.ts
 * Immutable content-addressed blob store: `<root>/blobs/aa/bb/<id>`, id = HMAC(plaintext).
 * Blobs are written to a temp file in `<root>/tmp`, fsynced, then renamed into place, so a
 * crash never leaves a partial blob under a real ID. Identical content dedupes to one file.
 */

import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { DatabankKeys, decryptFileStream, encryptStream } from "./crypto.js";

const ID_RE = /^[0-9a-f]{64}$/;

export function isBlobId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export interface PutResult {
  id: string;
  size: number;
  encrypted: boolean;
  deduped: boolean;
}

export class BlobStore {
  constructor(
    private readonly root: string,
    private readonly keys: DatabankKeys,
  ) {}

  pathFor(id: string): string {
    if (!isBlobId(id)) throw new Error("invalid blob id");
    return join(this.root, "blobs", id.slice(0, 2), id.slice(2, 4), id);
  }

  async has(id: string): Promise<boolean> {
    try {
      await stat(this.pathFor(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Stores a plaintext stream encrypted. The ID is only known after reading, hence the temp file. */
  async put(source: Readable): Promise<PutResult> {
    const tmpDir = join(this.root, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${Date.now()}-${randomBytes(6).toString("hex")}.part`);
    let res: { id: string; size: number };
    try {
      res = await encryptStream(this.keys, source, tmp);
      const fh = await open(tmp, "r+"); // fsync needs a writable handle on Windows
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      const finalPath = this.pathFor(res.id);
      if (await this.has(res.id)) {
        await rm(tmp, { force: true });
        return { id: res.id, size: res.size, encrypted: true, deduped: true };
      }
      await mkdir(dirname(finalPath), { recursive: true });
      await rename(tmp, finalPath);
      return { id: res.id, size: res.size, encrypted: true, deduped: false };
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async putFile(path: string): Promise<PutResult> {
    return this.put(createReadStream(path));
  }

  /** Plaintext stream; errors if the blob is missing or fails authentication. */
  get(id: string): Readable {
    return decryptFileStream(this.keys, this.pathFor(id));
  }

  /** Full re-read: decrypt, recompute the HMAC, compare with the ID. */
  async verify(id: string): Promise<{ ok: boolean; error?: string }> {
    const hasher = this.keys.idHasher();
    try {
      for await (const chunk of this.get(id)) hasher.update(chunk as Buffer);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return hasher.digest() === id ? { ok: true } : { ok: false, error: "content does not match id" };
  }
}
