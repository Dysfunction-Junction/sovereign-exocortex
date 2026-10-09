// Test-only synthetic X.509 + Android KeyDescription builder (no openssl needed).
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

const len = (n: number) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag: number, ...c: Buffer[]) => {
  const body = Buffer.concat(c);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const int = (n: number) => {
  const b: number[] = [];
  let v = n;
  do {
    b.unshift(v & 255);
    v = Math.floor(v / 256);
  } while (v > 0);
  if (b[0]! & 0x80) b.unshift(0);
  return tlv(0x02, Buffer.from(b));
};
const oid = (s: string) => {
  const p = s.split(".").map(Number);
  const out = [p[0]! * 40 + p[1]!];
  for (const n of p.slice(2)) {
    const t = [n & 127];
    let v = n >> 7;
    while (v > 0) {
      t.unshift((v & 127) | 128);
      v >>= 7;
    }
    out.push(...t);
  }
  return tlv(0x06, Buffer.from(out));
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);
const set = (...c: Buffer[]) => tlv(0x31, ...c);
const octets = (b: Buffer) => tlv(0x04, b);
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
function ctx(tagNum: number, ...c: Buffer[]): Buffer {
  const tag: number[] = [];
  let v = tagNum;
  tag.unshift(v & 127);
  v >>= 7;
  while (v > 0) {
    tag.unshift((v & 127) | 128);
    v >>= 7;
  }
  const head = tagNum < 31 ? Buffer.from([0xa0 | tagNum]) : Buffer.from([0xbf, ...tag]);
  const body = Buffer.concat(c);
  return Buffer.concat([head, len(body.length), body]);
}

export interface AuthSpec {
  purpose?: number[];
  algorithm?: number;
  origin?: number;
  noAuthRequired?: boolean;
  userAuthType?: number;
}

function authList(a: AuthSpec): Buffer {
  const f: Buffer[] = [];
  if (a.purpose) f.push(ctx(1, set(...a.purpose.map(int))));
  if (a.algorithm !== undefined) f.push(ctx(2, int(a.algorithm)));
  if (a.noAuthRequired) f.push(ctx(503, Buffer.from([0x05, 0x00])));
  if (a.userAuthType !== undefined) f.push(ctx(504, int(a.userAuthType)));
  if (a.origin !== undefined) f.push(ctx(702, int(a.origin)));
  return seq(...f);
}

export const GOOD_TEE: AuthSpec = { purpose: [2], algorithm: 3, origin: 0, userAuthType: 2 };

export function keyDescription(o: {
  level?: number;
  kmLevel?: number;
  challenge: Buffer;
  tee?: AuthSpec;
  software?: AuthSpec;
}): Buffer {
  return seq(
    int(300),
    tlv(0x0a, Buffer.from([o.level ?? 1])),
    int(300),
    tlv(0x0a, Buffer.from([o.kmLevel ?? o.level ?? 1])),
    octets(o.challenge),
    octets(Buffer.alloc(0)),
    authList(o.software ?? {}),
    authList(o.tee ?? GOOD_TEE),
  );
}

export interface Cert {
  der: Buffer;
  key: KeyObject;
  pem: string;
  b64: string;
}

export function makeCert(o: {
  subject: string;
  issuer?: string;
  issuerKey?: KeyObject;
  subjectKey?: { publicKey: KeyObject; privateKey: KeyObject };
  keyDescription?: Buffer;
  notBefore?: Date;
  notAfter?: Date;
}): Cert {
  const kp = o.subjectKey ?? generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"));
  const exts = o.keyDescription ? [seq(oid("1.3.6.1.4.1.11129.2.1.17"), octets(o.keyDescription))] : [];
  const tbs = seq(
    ctx(0, int(2)),
    int(Math.floor(Math.random() * 1e9) + 1),
    sigAlg,
    name(o.issuer ?? o.subject),
    seq(utc(o.notBefore ?? new Date(Date.now() - 86400_000)), utc(o.notAfter ?? new Date(Date.now() + 365 * 86400_000))),
    name(o.subject),
    spki,
    ...(exts.length ? [ctx(3, seq(...exts))] : []),
  );
  const signer = createSign("sha256");
  signer.update(tbs);
  const sig = signer.sign(o.issuerKey ?? kp.privateKey);
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = der.toString("base64");
  const pem = `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { der, key: kp.privateKey, pem, b64 };
}

/** root -> intermediate -> leaf(device key). */
export function makeChain(deviceKey: { publicKey: KeyObject; privateKey: KeyObject }, kd: Buffer) {
  const root = makeCert({ subject: "Test Attestation Root" });
  const inter = makeCert({ subject: "Test Attestation Intermediate", issuer: "Test Attestation Root", issuerKey: root.key });
  const leaf = makeCert({
    subject: "Test Attestation Leaf",
    issuer: "Test Attestation Intermediate",
    issuerKey: inter.key,
    subjectKey: deviceKey,
    keyDescription: kd,
  });
  return { root, inter, leaf, chainB64: [leaf.b64, inter.b64, root.b64], rootPem: root.pem };
}
