/**
 * @file crypto.ts
 * Key handling and streamed authenticated encryption for the databank.
 *
 * One 32-byte master key (file: hex, base64 or raw) fans out through HKDF-SHA256 into
 * independent subkeys: `blob` (AES-256-GCM) and `id` (HMAC for content-addressed IDs).
 *
 * Blob format (XDB2): magic(4) | nonce_prefix(4) | frame* where each frame is
 *   u32be ciphertext_len | ciphertext | tag(16)
 * Frame nonce = nonce_prefix(4) || u64be frame_index. AAD = magic || prefix || index
 * || final_flag(1). The last frame carries final_flag=1, so a truncated file (missing
 * final frame), reordered frames or flipped bits all fail authentication.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { once } from "node:events";
import { Transform, type Readable } from "node:stream";

export const MAGIC = Buffer.from("XDB2");
export const FRAME_SIZE = 1024 * 1024;
const TAG_LEN = 16;
const NONCE_LEN = 12;
const PREFIX_LEN = 4;

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
  const n = Buffer.alloc(NONCE_LEN);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(index), PREFIX_LEN);
  return n;
}

function aadFor(prefix: Buffer, index: number, final: boolean): Buffer {
  const a = Buffer.alloc(MAGIC.length + PREFIX_LEN + 8 + 1);
  MAGIC.copy(a, 0);
  prefix.copy(a, MAGIC.length);
  a.writeBigUInt64BE(BigInt(index), MAGIC.length + PREFIX_LEN);
  a[a.length - 1] = final ? 1 : 0;
  return a;
}

function sealFrame(key: Buffer, prefix: Buffer, index: number, final: boolean, plain: Buffer): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonceFor(prefix, index));
  c.setAAD(aadFor(prefix, index, final));
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
  const out = createWriteStream(destPath, { flags: "wx", mode: 0o600 });
  const prefix = randomBytes(PREFIX_LEN);
  const hasher = keys.idHasher();
  let size = 0;
  let index = 0;
  let pending: Buffer = Buffer.alloc(0);

  const write = async (buf: Buffer): Promise<void> => {
    if (!out.write(buf)) await once(out, "drain");
  };

  try {
    await write(Buffer.concat([MAGIC, prefix]));
    for await (const chunk of source) {
      const c = chunk as Buffer;
      hasher.update(c);
      size += c.length;
      pending = pending.length === 0 ? c : Buffer.concat([pending, c]);
      // Hold back at least one byte so the last frame can always be flagged final.
      while (pending.length > FRAME_SIZE) {
        await write(sealFrame(keys.blobKey, prefix, index++, false, pending.subarray(0, FRAME_SIZE)));
        pending = pending.subarray(FRAME_SIZE);
      }
    }
    await write(sealFrame(keys.blobKey, prefix, index, true, pending));
    out.end();
    await once(out, "finish");
  } catch (err) {
    out.destroy();
    throw err;
  }
  return { id: hasher.digest(), size };
}

/** Transform: XDB2 bytes in, plaintext out. Any tampering, truncation or reorder errors the stream. */
export function decryptTransform(keys: DatabankKeys): Transform {
  let buf: Buffer = Buffer.alloc(0);
  let prefix: Buffer | null = null;
  let index = 0;
  let sawFinal = false;

  const open = (pfx: Buffer, i: number, final: boolean, ct: Buffer, tag: Buffer): Buffer | null => {
    try {
      const d = createDecipheriv("aes-256-gcm", keys.blobKey, nonceFor(pfx, i));
      d.setAAD(aadFor(pfx, i, final));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } catch {
      return null;
    }
  };

  const drain = (flush: boolean, push: (b: Buffer) => void): void => {
    if (!prefix) {
      if (buf.length < MAGIC.length + PREFIX_LEN) {
        if (flush) throw new Error("truncated blob header");
        return;
      }
      if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an XDB2 blob");
      prefix = Buffer.from(buf.subarray(MAGIC.length, MAGIC.length + PREFIX_LEN));
      buf = buf.subarray(MAGIC.length + PREFIX_LEN);
    }
    while (!sawFinal && buf.length >= 4) {
      const ctLen = buf.readUInt32BE(0);
      if (ctLen > FRAME_SIZE) throw new Error("frame too large");
      const total = 4 + ctLen + TAG_LEN;
      if (buf.length < total) break;
      const ct = buf.subarray(4, 4 + ctLen);
      const tag = buf.subarray(4 + ctLen, total);
      // Only a full-size frame can be non-final; anything shorter must be the final frame.
      let plain = ctLen === FRAME_SIZE ? open(prefix, index, false, ct, tag) : null;
      let final = false;
      if (!plain) {
        plain = open(prefix, index, true, ct, tag);
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
