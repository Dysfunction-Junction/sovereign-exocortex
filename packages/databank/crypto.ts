/**
 * @file crypto.ts
 * Key handling and streamed authenticated encryption for the databank.
 *
 * One 32-byte master key (file: hex, base64 or raw) fans out through HKDF-SHA256 into
 * independent subkeys: `blob` (AES-256-GCM) and `id` (HMAC for content-addressed IDs).
 *
 * Blob format (XDB3, written): magic(4) | salt(32) | frame* where each frame is
 *   u32be ciphertext_len | ciphertext | tag(16)
 * The frame key is HKDF(blobKey, salt) so every blob has its own AES key; the frame nonce
 * is zero(4) || u64be frame_index. AAD = whole header || index || final_flag(1). The last
 * frame carries final_flag=1, so a truncated file (missing final frame), reordered frames,
 * a swapped salt or flipped bits all fail authentication.
 *
 * Legacy XDB2 (read only): magic(4) | nonce_prefix(4) | frame*, one key for all blobs and
 * only 32 random bits of nonce separation between blobs, which is why it is no longer written.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const LEGACY_MAGIC = Buffer.from("XDB2");
export const MAGIC_V3 = Buffer.from("XDB3");
export const FRAME_SIZE = 1024 * 1024;
const TAG_LEN = 16;
const NONCE_LEN = 12;
const PREFIX_LEN = 4;
const SALT_LEN = 32;
const V3_HEADER_LEN = MAGIC_V3.length + SALT_LEN;

export class DatabankKeys {
  readonly blobKey: Buffer;
  readonly idKey: Buffer;

  constructor(master: Buffer) {
    if (master.length !== 32) throw new Error("master key must be exactly 32 bytes");
    const derive = (info: string): Buffer =>
      Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `exocortex-databank/${info}`, 32));
    this.blobKey = derive("blob-aes-256-gcm/v1");
    this.idKey = derive("blob-id-hmac/v1");
  }

  /** Per-blob AES key for XDB3: HKDF over the blob key with the blob's random salt. */
  deriveBlobKey(salt: Buffer): Buffer {
    if (salt.length !== SALT_LEN) throw new Error("invalid XDB3 salt length");
    return Buffer.from(
      hkdfSync("sha256", this.blobKey, salt, "exocortex-databank/xdb3/frame-key/v1", 32),
    );
  }

  static generate(): Buffer {
    return randomBytes(32);
  }

  static fromFile(path: string): DatabankKeys {
    return new DatabankKeys(parseKey(readFileSync(path)));
  }

  /** Incremental HMAC-SHA256 of the plaintext: the content-addressed blob ID (64 hex). */
  idHasher(): { update(chunk: Buffer): void; digest(): string } {
    const h = createHmac("sha256", this.idKey);
    return { update: (c) => void h.update(c), digest: () => h.digest("hex") };
  }
}

/** Accepts 64 hex chars, base64 of 32 bytes, or 32 raw bytes. */
export function parseKey(raw: Buffer): Buffer {
  if (raw.length === 32) return raw;
  const text = raw.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  const b64 = Buffer.from(text, "base64");
  if (b64.length === 32) return b64;
  throw new Error("key file must contain 64 hex chars, base64 of 32 bytes, or 32 raw bytes");
}

function nonceFor(prefix: Buffer, index: number): Buffer {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("frame index out of range");
  const n = Buffer.alloc(NONCE_LEN);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(index), PREFIX_LEN);
  return n;
}

/** XDB2 additional data; kept byte-for-byte so old archives stay readable. */
function legacyAad(prefix: Buffer, index: number, final: boolean): Buffer {
  const a = Buffer.alloc(LEGACY_MAGIC.length + PREFIX_LEN + 8 + 1);
  LEGACY_MAGIC.copy(a, 0);
  prefix.copy(a, LEGACY_MAGIC.length);
  a.writeBigUInt64BE(BigInt(index), LEGACY_MAGIC.length + PREFIX_LEN);
  a[a.length - 1] = final ? 1 : 0;
  return a;
}

/** XDB3 additional data: the entire header (magic + salt) is bound to every frame. */
function aadV3(header: Buffer, index: number, final: boolean): Buffer {
  const a = Buffer.alloc(header.length + 8 + 1);
  header.copy(a, 0);
  a.writeBigUInt64BE(BigInt(index), header.length);
  a[a.length - 1] = final ? 1 : 0;
  return a;
}

const ZERO_PREFIX = Buffer.alloc(PREFIX_LEN);

function sealFrame(key: Buffer, header: Buffer, index: number, final: boolean, plain: Buffer): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonceFor(ZERO_PREFIX, index));
  c.setAAD(aadV3(header, index, final));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(ct.length);
  return Buffer.concat([head, ct, c.getAuthTag()]);
}

/**
 * Encrypts a plaintext stream into a new file (fails if it exists) and returns the HMAC
 * blob ID of the plaintext plus its size. Memory use is about two frames.
 */
export async function encryptStream(
  keys: DatabankKeys,
  source: Readable,
  destPath: string,
): Promise<{ id: string; size: number }> {
  const header = Buffer.concat([MAGIC_V3, randomBytes(SALT_LEN)]);
  const frameKey = keys.deriveBlobKey(header.subarray(MAGIC_V3.length));
  const hasher = keys.idHasher();
  let size = 0;

  async function* frames(): AsyncGenerator<Buffer> {
    let index = 0;
    let pending: Buffer = Buffer.alloc(0);
    yield header;
    for await (const chunk of source) {
      const c = chunk as Buffer;
      hasher.update(c);
      size += c.length;
      pending = pending.length === 0 ? c : Buffer.concat([pending, c]);
      // Hold back at least one byte so the last frame can always be flagged final.
      while (pending.length > FRAME_SIZE) {
        yield sealFrame(frameKey, header, index++, false, pending.subarray(0, FRAME_SIZE));
        pending = pending.subarray(FRAME_SIZE);
      }
    }
    yield sealFrame(frameKey, header, index, true, pending);
  }

  // pipeline observes errors on both ends and destroys both streams, so a destination or source
  // failure rejects here instead of surfacing as an unhandled stream error.
  await pipeline(Readable.from(frames()), createWriteStream(destPath, { flags: "wx", mode: 0o600 }));
  return { id: hasher.digest(), size };
}

interface FrameOpener {
  open(index: number, final: boolean, ct: Buffer, tag: Buffer): Buffer | null;
}

function gcmOpener(key: Buffer, nonce: (i: number) => Buffer, aad: (i: number, f: boolean) => Buffer): FrameOpener {
  return {
    open(index, final, ct, tag) {
      try {
        const d = createDecipheriv("aes-256-gcm", key, nonce(index));
        d.setAAD(aad(index, final));
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]);
      } catch {
        return null;
      }
    },
  };
}

/** Transform: XDB3 (or legacy XDB2) bytes in, plaintext out. Any tampering, truncation or reorder errors the stream. */
export function decryptTransform(keys: DatabankKeys): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let opener: FrameOpener | null = null;
  let index = 0;
  let sawFinal = false;

  const readHeader = (flush: boolean): boolean => {
    if (buf.length < MAGIC_V3.length) {
      if (flush) throw new Error("truncated blob header");
      return false;
    }
    const magic = buf.subarray(0, MAGIC_V3.length);
    if (magic.equals(MAGIC_V3)) {
      if (buf.length < V3_HEADER_LEN) {
        if (flush) throw new Error("truncated blob header");
        return false;
      }
      const header = Buffer.from(buf.subarray(0, V3_HEADER_LEN));
      const frameKey = keys.deriveBlobKey(header.subarray(MAGIC_V3.length));
      opener = gcmOpener(frameKey, (i) => nonceFor(ZERO_PREFIX, i), (i, f) => aadV3(header, i, f));
      buf = buf.subarray(V3_HEADER_LEN);
      return true;
    }
    if (magic.equals(LEGACY_MAGIC)) {
      if (buf.length < LEGACY_MAGIC.length + PREFIX_LEN) {
        if (flush) throw new Error("truncated blob header");
        return false;
      }
      const prefix = Buffer.from(buf.subarray(LEGACY_MAGIC.length, LEGACY_MAGIC.length + PREFIX_LEN));
      opener = gcmOpener(keys.blobKey, (i) => nonceFor(prefix, i), (i, f) => legacyAad(prefix, i, f));
      buf = buf.subarray(LEGACY_MAGIC.length + PREFIX_LEN);
      return true;
    }
    throw new Error("not an XDB blob");
  };

  const drain = (flush: boolean, push: (b: Buffer) => void): void => {
    if (!opener && !readHeader(flush)) return;
    const frames = opener as unknown as FrameOpener;
    while (!sawFinal && buf.length >= 4) {
      const ctLen = buf.readUInt32BE(0);
      if (ctLen > FRAME_SIZE) throw new Error("frame too large");
      const total = 4 + ctLen + TAG_LEN;
      if (buf.length < total) break;
      const ct = buf.subarray(4, 4 + ctLen);
      const tag = buf.subarray(4 + ctLen, total);
      // Only a full-size frame can be non-final; anything shorter must be the final frame.
      let plain = ctLen === FRAME_SIZE ? frames.open(index, false, ct, tag) : null;
      let final = false;
      if (!plain) {
        plain = frames.open(index, true, ct, tag);
        final = true;
      }
      if (!plain) throw new Error(`authentication failed at frame ${index}`);
      push(plain);
      buf = buf.subarray(total);
      index++;
      if (final) sawFinal = true;
    }
    if (sawFinal && buf.length > 0) throw new Error("data after final frame");
    if (flush && !sawFinal) throw new Error("truncated blob: missing final frame");
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      try {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        drain(false, (b) => this.push(b));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        drain(true, (b) => this.push(b));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

export function decryptFileStream(keys: DatabankKeys, path: string): Readable {
  const t = decryptTransform(keys);
  const src = createReadStream(path);
  src.on("error", (e) => t.destroy(e));
  return src.pipe(t);
}
