import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabankKeys, FRAME_SIZE, decryptFileStream, encryptStream, parseKey } from "../crypto.js";
import { legacyEncrypt } from "./legacy-xdb2.js";

const HEADER = 36; // XDB3: magic(4) + salt(32)

const keys = new DatabankKeys(Buffer.alloc(32, 7));

async function decryptAll(file: string, k: DatabankKeys = keys): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of decryptFileStream(k, file)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function roundTrip(plain: Buffer): Promise<{ id: string; out: Buffer; file: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "dbk-crypto-"));
  const file = join(dir, "blob");
  const { id, size } = await encryptStream(keys, Readable.from([plain]), file);
  assert.equal(size, plain.length);
  return { id, out: await decryptAll(file), file, dir };
}

describe("crypto", () => {
  for (const [name, len] of [
    ["empty", 0],
    ["tiny", 5],
    ["exactly one frame", FRAME_SIZE],
    ["one frame plus one byte", FRAME_SIZE + 1],
    ["multi frame", FRAME_SIZE * 3 + 12345],
  ] as const) {
    it(`round-trips ${name}`, async () => {
      const plain = Buffer.alloc(len);
      for (let i = 0; i < len; i += 4099) plain[i] = (i * 31) & 0xff;
      const r = await roundTrip(plain);
      assert.ok(r.out.equals(plain));
      assert.match(r.id, /^[0-9a-f]{64}$/);
      rmSync(r.dir, { recursive: true, force: true });
    });
  }

  it("blob id is keyed: same content gives the same id, a different key a different id", async () => {
    const a = await roundTrip(Buffer.from("hello"));
    const b = await roundTrip(Buffer.from("hello"));
    assert.equal(a.id, b.id);
    const h = new DatabankKeys(Buffer.alloc(32, 9)).idHasher();
    h.update(Buffer.from("hello"));
    assert.notEqual(h.digest(), a.id);
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("detects a flipped bit, a wrong key, truncation, a dropped final frame and trailing data", async () => {
    const r = await roundTrip(Buffer.alloc(FRAME_SIZE * 2 + 10, 3));
    const good = readFileSync(r.file);

    const flipped = Buffer.from(good);
    flipped[flipped.length >> 1] ^= 1;
    writeFileSync(r.file, flipped);
    await assert.rejects(decryptAll(r.file), /authentication failed/);

    writeFileSync(r.file, good);
    await assert.rejects(decryptAll(r.file, new DatabankKeys(Buffer.alloc(32, 1))), /authentication failed/);

    // Drop the whole final frame: the remaining frames are valid but the final flag never appears.
    const frameLen = 4 + FRAME_SIZE + 16;
    writeFileSync(r.file, good.subarray(0, HEADER + 2 * frameLen));
    await assert.rejects(decryptAll(r.file), /missing final frame|authentication failed/);

    writeFileSync(r.file, good.subarray(0, good.length - 3));
    await assert.rejects(decryptAll(r.file), /truncated|missing final frame|authentication failed/);

    writeFileSync(r.file, Buffer.concat([good, Buffer.from("x")]));
    await assert.rejects(decryptAll(r.file), /data after final frame|authentication failed/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("detects reordered frames", async () => {
    const r = await roundTrip(Buffer.alloc(FRAME_SIZE * 3, 5));
    const good = readFileSync(r.file);
    const fl = 4 + FRAME_SIZE + 16;
    writeFileSync(
      r.file,
      Buffer.concat([
        good.subarray(0, HEADER),
        good.subarray(HEADER + fl, HEADER + 2 * fl),
        good.subarray(HEADER, HEADER + fl),
        good.subarray(HEADER + 2 * fl),
      ]),
    );
    await assert.rejects(decryptAll(r.file), /authentication failed/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("ciphertext differs per write and never contains the plaintext", async () => {
    const a = await roundTrip(Buffer.from("same plaintext"));
    const b = await roundTrip(Buffer.from("same plaintext"));
    assert.ok(!readFileSync(a.file).equals(readFileSync(b.file)));
    assert.ok(!readFileSync(a.file).includes(Buffer.from("same plaintext")));
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("parses hex, base64 and raw keys and rejects bad ones", () => {
    const raw = Buffer.alloc(32, 1);
    assert.ok(parseKey(Buffer.from(raw.toString("hex") + "\n")).equals(raw));
    assert.ok(parseKey(Buffer.from(raw.toString("base64"))).equals(raw));
    assert.ok(parseKey(raw).equals(raw));
    assert.throws(() => parseKey(Buffer.from("short")), /key file must contain/);
    assert.throws(() => new DatabankKeys(Buffer.alloc(16)), /32 bytes/);
  });
});

describe("XDB3 format", () => {
  async function decryptBuf(bytes: Buffer, k: DatabankKeys = keys, chunk = bytes.length || 1): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), "dbk-x3-"));
    const file = join(dir, "blob");
    writeFileSync(file, bytes);
    try {
      const { decryptTransform } = await import("../crypto.js");
      const t = decryptTransform(k);
      const outChunks: Buffer[] = [];
      t.on("data", (c: Buffer) => outChunks.push(c));
      const done = new Promise<void>((resolve, reject) => {
        t.on("end", resolve);
        t.on("error", reject);
      });
      for (let i = 0; i < bytes.length; i += chunk) t.write(bytes.subarray(i, i + chunk));
      t.end();
      await done;
      return Buffer.concat(outChunks);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("default writes start with XDB3 magic and a 32-byte salt", async () => {
    const r = await roundTrip(Buffer.from("hello"));
    const raw = readFileSync(r.file);
    assert.equal(raw.subarray(0, 4).toString(), "XDB3");
    assert.equal(raw.length, HEADER + 4 + 5 + 16);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("two writes of the same plaintext get different salts", async () => {
    const a = await roundTrip(Buffer.from("same"));
    const b = await roundTrip(Buffer.from("same"));
    assert.ok(!readFileSync(a.file).subarray(4, HEADER).equals(readFileSync(b.file).subarray(4, HEADER)));
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  });

  it("different salts derive different frame keys, and bad salt lengths throw", () => {
    const k1 = keys.deriveBlobKey(Buffer.alloc(32, 1));
    const k2 = keys.deriveBlobKey(Buffer.alloc(32, 2));
    assert.equal(k1.length, 32);
    assert.ok(!k1.equals(k2));
    assert.ok(!k1.equals(keys.blobKey));
    assert.throws(() => keys.deriveBlobKey(Buffer.alloc(31)), /invalid XDB3 salt length/);
  });

  it("rejects a flipped salt byte and a wrong key", async () => {
    const r = await roundTrip(Buffer.from("payload"));
    const good = readFileSync(r.file);
    const bad = Buffer.from(good);
    bad[10] ^= 1;
    await assert.rejects(decryptBuf(bad), /authentication failed/);
    await assert.rejects(decryptBuf(good, new DatabankKeys(Buffer.alloc(32, 1))), /authentication failed/);
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("parses a header split across chunk boundaries and 7-byte chunking", async () => {
    const plain = Buffer.alloc(FRAME_SIZE + 100, 9);
    const r = await roundTrip(plain);
    const raw = readFileSync(r.file);
    // tiny chunks only across the header and first frame head; the rest in big pieces
    const small = Buffer.alloc(0);
    const t = (await import("../crypto.js")).decryptTransform(keys);
    const out: Buffer[] = [];
    t.on("data", (c: Buffer) => out.push(c));
    const done = new Promise<void>((resolve, reject) => {
      t.on("end", resolve);
      t.on("error", reject);
    });
    for (let i = 0; i < 50; i += 3) t.write(raw.subarray(i, Math.min(i + 3, 50)));
    t.write(raw.subarray(50));
    t.end();
    await done;
    assert.ok(Buffer.concat([small, ...out]).equals(plain));
    assert.ok((await decryptBuf(raw, keys, 777777)).equals(plain));
    rmSync(r.dir, { recursive: true, force: true });
  });

  it("rejects an unknown magic and a truncated header", async () => {
    await assert.rejects(decryptBuf(Buffer.from("XDB9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), /not an XDB blob/);
    await assert.rejects(decryptBuf(Buffer.concat([Buffer.from("XDB3"), Buffer.alloc(10)])), /truncated blob header/);
    await assert.rejects(decryptBuf(Buffer.from("XD")), /truncated blob header/);
  });

  it("rejects an oversized frame length", async () => {
    const hdr = Buffer.concat([Buffer.from("XDB3"), Buffer.alloc(32, 4)]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(FRAME_SIZE + 1);
    await assert.rejects(decryptBuf(Buffer.concat([hdr, len, Buffer.alloc(64)])), /frame too large/);
  });
});

describe("legacy XDB2 compatibility", () => {
  const prefix = Buffer.from([1, 2, 3, 4]);

  it("a fixed XDB2 fixture still decrypts, including multi-frame", async () => {
    for (const len of [0, 5, FRAME_SIZE, FRAME_SIZE * 2 + 17]) {
      const plain = Buffer.alloc(len, len & 0xff);
      const dir = mkdtempSync(join(tmpdir(), "dbk-x2-"));
      const file = join(dir, "blob");
      writeFileSync(file, legacyEncrypt(keys, plain, prefix));
      assert.ok((await decryptAll(file)).equals(plain), `len ${len}`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy blobs with the same prefix reuse the keystream (the defect XDB3 removes)", () => {
    const a = Buffer.alloc(64, 0x00);
    const b = Buffer.alloc(64, 0xff);
    const ca = legacyEncrypt(keys, a, prefix).subarray(8 + 4, 8 + 4 + 64);
    const cb = legacyEncrypt(keys, b, prefix).subarray(8 + 4, 8 + 4 + 64);
    // ciphertext XOR equals plaintext XOR: confidentiality of overlapping bytes is lost
    for (let i = 0; i < 64; i++) assert.equal(ca[i] ^ cb[i], a[i] ^ b[i]);
  });

  it("XDB3 blobs of identical plaintext do not leak equal keystreams", async () => {
    const a = await roundTrip(Buffer.alloc(64, 0));
    const b = await roundTrip(Buffer.alloc(64, 0xff));
    const ca = readFileSync(a.file).subarray(HEADER + 4, HEADER + 4 + 64);
    const cb = readFileSync(b.file).subarray(HEADER + 4, HEADER + 4 + 64);
    assert.ok(!ca.every((byte, i) => (byte ^ cb[i]) === 0xff));
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  });
});
