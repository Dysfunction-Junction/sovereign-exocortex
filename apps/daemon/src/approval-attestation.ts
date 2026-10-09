// Device-bound approval attestation.
//
// The phone signs (deviceId, proposalId, nonce, action, ts) with an Android Keystore EC P-256 key that
// requires a fresh strong-biometric auth per signature. The daemon verifies that signature against the
// key bound to the authenticated device before forwarding any approval. Freshness comes from the single-use
// proposal nonce (consumed by the triad); ts is only audit data plus a loose skew window.

import { createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";

export const APPROVAL_MSG_PREFIX = "exo-approval-v1";
export const LABEL_MSG_PREFIX = "exo-label-v1";
export const APPROVAL_KEY_MSG_PREFIX = "exo-approval-key-v1";
/** Loose on purpose: phone and PC clocks drift, and the nonce is what makes an approval single-use. */
export const APPROVAL_TS_WINDOW_MS = 10 * 60 * 1000;
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export interface ApprovalContext {
  deviceId: string;
  proposalId: string;
  nonce: string;
  action: string;
}

function joinFields(prefix: string, fields: string[]): Buffer {
  for (const f of fields) {
    if (f.includes("\n")) throw new Error("field contains newline");
  }
  return Buffer.from([prefix, ...fields].join("\n"), "utf8");
}

export function approvalMessage(ctx: ApprovalContext, ts: number): Buffer {
  return joinFields(APPROVAL_MSG_PREFIX, [ctx.deviceId, ctx.proposalId, ctx.nonce, ctx.action, String(ts)]);
}

export interface LabelContext {
  deviceId: string;
  proposalId: string;
  label: string;
}

/** "exo-label-v1
{deviceId}
{proposalId}
{label}
{ts}" */
export function labelMessage(ctx: LabelContext, ts: number): Buffer {
  return joinFields(LABEL_MSG_PREFIX, [ctx.deviceId, ctx.proposalId, ctx.label, String(ts)]);
}

export function approvalKeyMessage(deviceId: string, challenge: string): Buffer {
  return joinFields(APPROVAL_KEY_MSG_PREFIX, [deviceId, challenge]);
}

/** Parse an SPKI and require EC P-256. Returns null when it is anything else. */
export function parseP256Spki(spki: Uint8Array) {
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec") return null;
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

/** ECDSA/SHA-256, DER-encoded signature (what Android's SHA256withECDSA emits). */
export function verifyEcSignature(spki: Uint8Array, message: Buffer, sigB64: string): boolean {
  const key = parseP256Spki(spki);
  if (!key) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(sigB64, "base64");
  } catch {
    return false;
  }
  if (sig.length < 8 || sig.length > 80) return false;
  try {
    const v = createVerify("sha256");
    v.update(message);
    return v.verify(key, sig);
  } catch {
    return false;
  }
}

export type AttestationResult = { ok: true; ts: number } | { ok: false; reason: string };

export function verifyApprovalAttestation(
  attestation: unknown,
  ctx: ApprovalContext,
  deviceKeySpki: Uint8Array | null,
  keyAttested: boolean,
  now = Date.now(),
): AttestationResult {
  return verifyBiometricAttestation(attestation, (ts) => approvalMessage(ctx, ts), deviceKeySpki, keyAttested, now);
}

/** Same signature scheme and +-10min window as approvals, over the label message. */
export function verifyLabelAttestation(
  attestation: unknown,
  ctx: LabelContext,
  deviceKeySpki: Uint8Array | null,
  keyAttested: boolean,
  now = Date.now(),
): AttestationResult {
  return verifyBiometricAttestation(attestation, (ts) => labelMessage(ctx, ts), deviceKeySpki, keyAttested, now);
}

function verifyBiometricAttestation(
  attestation: unknown,
  buildMessage: (ts: number) => Buffer,
  deviceKeySpki: Uint8Array | null,
  keyAttested: boolean,
  now: number,
): AttestationResult {
  if (!deviceKeySpki || !keyAttested) return { ok: false, reason: "device has no registered approval key" };
  let att = attestation;
  if (typeof att === "string") {
    try {
      att = JSON.parse(att);
    } catch {
      return { ok: false, reason: "attestation is not valid JSON" };
    }
  }
  if (!att || typeof att !== "object" || Array.isArray(att)) return { ok: false, reason: "attestation required" };
  const a = att as Record<string, unknown>;
  if (a.v !== 1 || a.method !== "biometric") return { ok: false, reason: "unsupported attestation" };
  const ts = a.ts;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts)) return { ok: false, reason: "attestation ts invalid" };
  if (Math.abs(now - ts) > APPROVAL_TS_WINDOW_MS) return { ok: false, reason: "attestation timestamp outside allowed window" };
  if (typeof a.sig !== "string" || a.sig.length === 0) return { ok: false, reason: "attestation signature missing" };
  let msg: Buffer;
  try {
    msg = buildMessage(ts);
  } catch {
    return { ok: false, reason: "invalid approval fields" };
  }
  if (!verifyEcSignature(deviceKeySpki, msg, a.sig)) return { ok: false, reason: "attestation signature invalid" };
  return { ok: true, ts };
}

/** Single-use, short-lived challenges for approval-key registration (proof of possession). */
export class ChallengeStore {
  private readonly items = new Map<string, { challenge: string; expiresAt: number }>();

  issue(deviceId: string, now = Date.now()): string {
    for (const [k, v] of this.items) if (v.expiresAt <= now) this.items.delete(k);
    const challenge = randomBytes(24).toString("base64url");
    this.items.set(deviceId, { challenge, expiresAt: now + CHALLENGE_TTL_MS });
    return challenge;
  }

  /** Consumes the challenge whether or not it matches. */
  consume(deviceId: string, presented: string, now = Date.now()): boolean {
    const item = this.items.get(deviceId);
    this.items.delete(deviceId);
    if (!item || item.expiresAt <= now) return false;
    const a = Buffer.from(item.challenge);
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
