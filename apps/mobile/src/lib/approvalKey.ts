import { registerPlugin } from "@capacitor/core";
import { getConnectionTargets } from "./config";
import { extractDeviceIdFromToken } from "./jwtDisplay";

// Device-bound approval signing (see ApprovalKeyPlugin.java). The signed message format MUST match
// approvalMessage()/approvalKeyMessage() in apps/daemon/src/approval-attestation.ts.

interface ApprovalKeyNative {
  isAvailable(): Promise<{ available: boolean; status: number }>;
  ensureKey(): Promise<{ publicKeyB64: string }>;
  resetKey(): Promise<void>;
  sign(options: { message: string; title?: string; subtitle?: string }): Promise<{ signatureB64: string }>;
}

export const ApprovalKey = registerPlugin<ApprovalKeyNative>("ApprovalKey");

export interface ApprovalAttestation {
  v: 1;
  method: "biometric";
  ts: number;
  sig: string;
}

export class ApprovalUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code: string = "UNAVAILABLE") {
    super(message);
    this.name = "ApprovalUnavailableError";
    this.code = code;
  }
}

const APPROVAL_MSG_PREFIX = "exo-approval-v1";
const APPROVAL_KEY_MSG_PREFIX = "exo-approval-key-v1";

function join(prefix: string, fields: string[]): string {
  for (const f of fields) {
    if (f.includes("\n")) throw new ApprovalUnavailableError("approval field contains a newline", "BAD_FIELD");
  }
  return [prefix, ...fields].join("\n");
}

export function approvalMessage(
  p: { deviceId: string; proposalId: string; nonce: string; action: string },
  ts: number
): string {
  return join(APPROVAL_MSG_PREFIX, [p.deviceId, p.proposalId, p.nonce, p.action, String(ts)]);
}

export function approvalKeyMessage(deviceId: string, challenge: string): string {
  return join(APPROVAL_KEY_MSG_PREFIX, [deviceId, challenge]);
}

/** The device id the gateway will see: the `deviceId` claim of the stored JWT. */
export async function getDeviceId(): Promise<string> {
  const targets = await getConnectionTargets();
  for (const t of targets) {
    const id = extractDeviceIdFromToken(t.token);
    if (id) return id;
  }
  throw new ApprovalUnavailableError("No device token configured", "NO_TOKEN");
}

async function callNative<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const code = typeof e?.code === "string" ? e.code : "UNAVAILABLE";
    throw new ApprovalUnavailableError(e?.message || "Biometric approval unavailable", code);
  }
}

/**
 * Prompts for a strong biometric and signs (deviceId, proposalId, nonce, action, ts).
 * Never fabricates a signature: any failure (no plugin, no key, cancelled) throws.
 */
export async function signApproval(p: {
  proposalId: string;
  nonce: string;
  action: string;
}): Promise<ApprovalAttestation> {
  const deviceId = await getDeviceId();
  const ts = Date.now();
  const message = approvalMessage({ deviceId, ...p }, ts);
  const { signatureB64 } = await callNative(() =>
    ApprovalKey.sign({ message, title: "Confirm approval", subtitle: "Authenticate to approve this action" })
  );
  return { v: 1, method: "biometric", ts, sig: signatureB64 };
}

/**
 * One-time (per key) registration: creates the Keystore key, fetches a server challenge, signs it
 * (biometric prompt) and binds the public key to this device. Requires the PC-side enrollment token.
 */
export async function registerApprovalKey(enrollToken: string): Promise<void> {
  if (!enrollToken.trim()) throw new ApprovalUnavailableError("Enrollment token required", "NO_ENROLL_TOKEN");
  const { available } = await callNative(() => ApprovalKey.isAvailable());
  if (!available) throw new ApprovalUnavailableError("Strong biometrics are not set up on this phone", "NO_BIOMETRIC");
  const deviceId = await getDeviceId();
  const { publicKeyB64 } = await callNative(() => ApprovalKey.ensureKey());

  const { postApprovalKeyChallenge, postApprovalKey } = await import("./api");
  const challenge = await postApprovalKeyChallenge();
  const { signatureB64 } = await callNative(() =>
    ApprovalKey.sign({
      message: approvalKeyMessage(deviceId, challenge),
      title: "Register approval key",
      subtitle: "Authenticate to bind this phone's approval key",
    })
  );
  await postApprovalKey({ pubkey_b64: publicKeyB64, challenge, signature_b64: signatureB64 }, enrollToken.trim());
}
