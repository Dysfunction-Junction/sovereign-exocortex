// Android Keystore key-attestation verification (certificate chain + KeyDescription extension).
//
// Chain: leaf first, each cert signed by the next, last cert must be a pinned Google attestation root.
// The leaf SPKI must equal the registered key, and the KeyDescription must prove a hardware-backed,
// biometric-gated EC signing key generated on device for the server challenge.

import { X509Certificate } from "node:crypto";
import { GOOGLE_ATTESTATION_ROOTS_PEM } from "./attestation-roots/google-roots.js";

export const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
const MAX_CHAIN = 8;

// ---- minimal DER reader ----------------------------------------------------

interface Tlv {
  /** class bits (0 universal, 1 application, 2 context, 3 private) */
  cls: number;
  constructed: boolean;
  tag: number;
  value: Buffer;
  /** total encoded length */
  end: number;
}

function readTlv(buf: Buffer, off = 0): Tlv {
  if (off >= buf.length) throw new Error("der: truncated");
  const b0 = buf[off]!;
  let p = off + 1;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    for (let i = 0; ; i++) {
      if (p >= buf.length || i > 4) throw new Error("der: bad tag");
      const b = buf[p++]!;
      tag = tag * 128 + (b & 0x7f);
      if (!(b & 0x80)) break;
    }
  }
  if (p >= buf.length) throw new Error("der: truncated");
  let len = buf[p++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > buf.length) throw new Error("der: bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]!;
  }
  if (p + len > buf.length) throw new Error("der: length exceeds buffer");
  return { cls: b0 >> 6, constructed: !!(b0 & 0x20), tag, value: buf.subarray(p, p + len), end: p + len };
}

function readChildren(value: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let off = 0;
  while (off < value.length) {
    const t = readTlv(value, off);
    out.push(t);
    off = t.end;
  }
  return out;
}

function derInt(t: Tlv): number {
  if (t.value.length === 0 || t.value.length > 6) throw new Error("der: integer size");
  let n = 0;
  for (const b of t.value) n = n * 256 + b;
  return n;
}

function oidString(value: Buffer): string {
  if (value.length === 0) throw new Error("der: empty oid");
  const parts: number[] = [Math.floor(value[0]! / 40), value[0]! % 40];
  let n = 0;
  for (let i = 1; i < value.length; i++) {
    n = n * 128 + (value[i]! & 0x7f);
    if (!(value[i]! & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}

/** Extension value (the OCTET STRING contents) of the first extension with this OID, or null. */
export function findExtension(certDer: Buffer, oid: string): Buffer | null {
  const cert = readTlv(certDer);
  const tbs = readChildren(cert.value)[0];
  if (!tbs) throw new Error("der: no tbsCertificate");
  for (const f of readChildren(tbs.value)) {
    if (f.cls !== 2 || f.tag !== 3) continue; // [3] EXPLICIT extensions
    const exts = readChildren(readChildren(f.value)[0]!.value);
    for (const ext of exts) {
      const kids = readChildren(ext.value);
      if (kids[0]!.tag === 6 && oidString(kids[0]!.value) === oid) {
        const octets = kids[kids.length - 1]!;
        if (octets.tag !== 4) throw new Error("der: extension value");
        return octets.value;
      }
    }
  }
  return null;
}

// ---- KeyDescription --------------------------------------------------------

export interface AuthList {
  purpose: number[];
  algorithm?: number;
  origin?: number;
  userAuthType?: number;
  noAuthRequired: boolean;
}

export interface KeyDescription {
  attestationSecurityLevel: number;
  keymasterSecurityLevel: number;
  attestationChallenge: Buffer;
  softwareEnforced: AuthList;
  teeEnforced: AuthList;
}

function parseAuthList(t: Tlv): AuthList {
  const out: AuthList = { purpose: [], noAuthRequired: false };
  for (const f of readChildren(t.value)) {
    if (f.cls !== 2) continue;
    const inner = f.value.length ? readTlv(f.value) : null;
    switch (f.tag) {
      case 1: // purpose SET OF INTEGER
        if (inner) out.purpose = readChildren(inner.value).map(derInt);
        break;
      case 2:
        if (inner) out.algorithm = derInt(inner);
        break;
      case 503:
        out.noAuthRequired = true;
        break;
      case 504:
        if (inner) out.userAuthType = derInt(inner);
        break;
      case 702:
        if (inner) out.origin = derInt(inner);
        break;
    }
  }
  return out;
}

export function parseKeyDescription(der: Buffer): KeyDescription {
  const seq = readTlv(der);
  const k = readChildren(seq.value);
  if (k.length < 8) throw new Error("keydescription: too few fields");
  return {
    attestationSecurityLevel: derInt(k[1]!),
    keymasterSecurityLevel: derInt(k[3]!),
    attestationChallenge: Buffer.from(k[4]!.value),
    softwareEnforced: parseAuthList(k[6]!),
    teeEnforced: parseAuthList(k[7]!),
  };
}

// ---- chain verification ----------------------------------------------------

export type ChainResult = { ok: true; securityLevel: number } | { ok: false; reason: string };

let rootsOverride: readonly string[] | null = null;
/** Test hook: replace the pinned roots (pass null to restore). Never driven by env. */
export function setAttestationRootsForTest(pems: readonly string[] | null): void {
  rootsOverride = pems;
}

export function pinnedRoots(): X509Certificate[] {
  return (rootsOverride ?? GOOGLE_ATTESTATION_ROOTS_PEM).map((p) => new X509Certificate(p));
}

export interface ChainOptions {
  /** PEM roots to trust instead of the pinned Google bundle (tests). */
  roots?: readonly string[];
  now?: number;
}

export function verifyKeyAttestationChain(
  chainB64: unknown,
  ctx: { pubkeySpki: Uint8Array; challenge: string },
  opts: ChainOptions = {},
): ChainResult {
  const now = opts.now ?? Date.now();
  if (!Array.isArray(chainB64) || chainB64.length < 2 || chainB64.length > MAX_CHAIN) {
    return { ok: false, reason: "attestation_chain must be an array of 2-8 base64 DER certificates" };
  }
  const certs: X509Certificate[] = [];
  try {
    for (const c of chainB64) {
      if (typeof c !== "string" || c.length === 0 || c.length > 8192) throw new Error("bad cert");
      certs.push(new X509Certificate(Buffer.from(c, "base64")));
    }
  } catch {
    return { ok: false, reason: "attestation_chain contains an unparseable certificate" };
  }

  for (const c of certs) {
    if (now < new Date(c.validFrom).getTime() || now > new Date(c.validTo).getTime()) {
      return { ok: false, reason: "attestation certificate outside its validity period" };
    }
  }
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i]!.verify(certs[i + 1]!.publicKey)) {
      return { ok: false, reason: "attestation chain signature invalid" };
    }
  }
  const last = certs[certs.length - 1]!;
  let roots: X509Certificate[];
  try {
    roots = (opts.roots ? opts.roots.map((p) => new X509Certificate(p)) : pinnedRoots());
  } catch {
    return { ok: false, reason: "attestation roots unavailable" };
  }
  if (!roots.some((r) => r.raw.equals(last.raw)) || !last.verify(last.publicKey)) {
    return { ok: false, reason: "attestation chain does not end at a pinned root" };
  }

  const leafSpki = certs[0]!.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  if (!leafSpki.equals(Buffer.from(ctx.pubkeySpki))) {
    return { ok: false, reason: "attested key does not match pubkey_b64" };
  }

  let kd: KeyDescription;
  try {
    const ext = findExtension(certs[0]!.raw, KEY_DESCRIPTION_OID);
    if (!ext) return { ok: false, reason: "leaf has no key attestation extension" };
    kd = parseKeyDescription(ext);
  } catch {
    return { ok: false, reason: "key attestation extension malformed" };
  }

  const challengeBytes = [Buffer.from(ctx.challenge, "utf8"), Buffer.from(ctx.challenge, "base64url")];
  if (!challengeBytes.some((b) => b.length > 0 && b.equals(kd.attestationChallenge))) {
    return { ok: false, reason: "attestation challenge mismatch" };
  }
  if (kd.attestationSecurityLevel < 1 || kd.keymasterSecurityLevel < 1) {
    return { ok: false, reason: "key is not hardware-backed (software-only attestation)" };
  }
  const t = kd.teeEnforced;
  if (!t.purpose.includes(2)) return { ok: false, reason: "key purpose must include SIGN" };
  if (t.algorithm !== 3) return { ok: false, reason: "key algorithm must be EC" };
  if (t.origin !== 0) return { ok: false, reason: "key was not generated on device" };
  if (t.noAuthRequired) return { ok: false, reason: "key does not require user authentication" };
  if (t.userAuthType === undefined || (t.userAuthType & 2) === 0) {
    return { ok: false, reason: "key is not gated by biometric authentication" };
  }
  return { ok: true, securityLevel: Math.min(kd.attestationSecurityLevel, kd.keymasterSecurityLevel) };
}

export function allowUnattestedKeys(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXOCORTEX_ALLOW_UNATTESTED_KEYS === "1";
}
