/**
 * Test-only writer for the retired XDB2 format. Production code can no longer write XDB2;
 * this reimplements the old layout so compatibility and migration can be tested against
 * real legacy bytes.
 */
import { createCipheriv } from "node:crypto";
import { FRAME_SIZE, type DatabankKeys } from "../crypto.js";

export function legacyEncrypt(keys: DatabankKeys, plain: Buffer, prefix: Buffer): Buffer {
  if (prefix.length !== 4) throw new Error("prefix must be 4 bytes");
  const magic = Buffer.from("XDB2");
  const parts: Buffer[] = [magic, prefix];
  let off = 0;
  let index = 0;
  for (;;) {
    const final = plain.length - off <= FRAME_SIZE;
    const chunk = plain.subarray(off, final ? plain.length : off + FRAME_SIZE);
    const nonce = Buffer.alloc(12);
    prefix.copy(nonce, 0);
    nonce.writeBigUInt64BE(BigInt(index), 4);
    const aad = Buffer.alloc(magic.length + 4 + 8 + 1);
    magic.copy(aad, 0);
    prefix.copy(aad, magic.length);
    aad.writeBigUInt64BE(BigInt(index), magic.length + 4);
    aad[aad.length - 1] = final ? 1 : 0;
    const c = createCipheriv("aes-256-gcm", keys.blobKey, nonce);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(chunk), c.final()]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(ct.length);
    parts.push(head, ct, c.getAuthTag());
    if (final) break;
    off += FRAME_SIZE;
    index++;
  }
  return Buffer.concat(parts);
}
