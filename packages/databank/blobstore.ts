/**
 * @file blobstore.ts
 * Immutable content-addressed blob store: `<root>/blobs/aa/bb/<id>`, id = HMAC(plaintext).
 * Blobs are written to a temp file in `<root>/tmp`, fsynced, then renamed into place, so a
 * crash never leaves a partial blob under a real ID. Identical content dedupes to one file.
 */

import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { DatabankKeys, LEGACY_MAGIC, MAGIC_V3, decryptFileStream, encryptStream } from "./crypto.js";

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
  private readonly migrating = new Set<string>();

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
        // Existence is not integrity: authenticate the incumbent before trusting it as a dedupe hit.
        if ((await this.verify(res.id)).ok) {
          await rm(tmp, { force: true });
          return { id: res.id, size: res.size, encrypted: true, deduped: true };
        }
        // Keep the bad copy for inspection, then replace it with the freshly written, id-checked one.
        await rename(finalPath, `${finalPath}.corrupt-${Date.now()}`);
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

  /**
   * Opt-in migration: re-encrypts one legacy XDB2 blob as XDB3 under the same id. The new file is
   * fully decrypted and checked against the id before it replaces the original, and the original is
   * kept as `<id>.bak` until the swap succeeds. `put()` never does this: it dedupes against the old file.
   */
  async rewriteLegacy(id: string): Promise<{ id: string; migrated: boolean }> {
    const finalPath = this.pathFor(id);
    if (this.migrating.has(id)) throw new Error("migration already in progress for this blob");
    this.migrating.add(id);
    try {
      const fh = await open(finalPath, "r");
      const head = Buffer.alloc(4);
      try {
        await fh.read(head, 0, 4, 0);
      } finally {
        await fh.close();
      }
      if (head.equals(MAGIC_V3)) return { id, migrated: false };
      if (!head.equals(LEGACY_MAGIC)) throw new Error("unrecognized blob format");

      const tmpDir = join(this.root, "tmp");
      await mkdir(tmpDir, { recursive: true });
      const tmp = join(tmpDir, `${Date.now()}-${randomBytes(6).toString("hex")}.part`);
      try {
        const res = await encryptStream(this.keys, this.get(id), tmp);
        if (res.id !== id) throw new Error("rewritten blob does not match its id");
        const out = await open(tmp, "r+"); // fsync needs a writable handle on Windows
        try {
          await out.sync();
        } finally {
          await out.close();
        }
        // Prove the new file decrypts end to end and hashes to the id before touching the original.
        const hasher = this.keys.idHasher();
        for await (const chunk of decryptFileStream(this.keys, tmp)) hasher.update(chunk as Buffer);
        if (hasher.digest() !== id) throw new Error("rewritten blob failed verification");
        await this.beforeReplace();
        // The original is never moved: take a hard-link (or copy) backup, then replace the final
        // path with ONE rename (atomic over an existing file on POSIX and Windows). The blob is
        // addressable by id at every instant, and the backup only goes away after the swap.
        const bak = `${finalPath}.bak`;
        await rm(bak, { force: true });
        try {
          await link(finalPath, bak);
        } catch {
          await copyFile(finalPath, bak);
        }
        try {
          await this.afterBackup(id);
          await rename(tmp, finalPath);
        } catch (err) {
          await rm(bak, { force: true });
          throw err;
        }
        await rm(bak, { force: true });
        return { id, migrated: true };
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    } finally {
      this.migrating.delete(id);
    }
  }

  /** Seam between "new blob verified" and "original replaced"; overridden by tests to simulate a crash. */
  protected async beforeReplace(): Promise<void> {}

  /** Seam after the backup exists and before the replacing rename; overridden by tests. */
  protected async afterBackup(_id: string): Promise<void> {}

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
