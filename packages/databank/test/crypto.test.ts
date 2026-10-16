import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabankKeys, FRAME_SIZE, decryptFileStream, encryptStream, parseKey } from "../crypto.js";

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
    writeFileSync(r.file, good.subarray(0, 8 + 2 * frameLen));
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
      Buffer.concat([good.subarray(0, 8), good.subarray(8 + fl, 8 + 2 * fl), good.subarray(8, 8 + fl), good.subarray(8 + 2 * fl)]),
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
