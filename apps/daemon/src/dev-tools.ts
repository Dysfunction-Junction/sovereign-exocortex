// Operator-side helpers for the real-device approval test (docs/DEVICE_TEST_RUNBOOK.md).

import { generateKeyPairSync, randomUUID, createHash } from "node:crypto";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { HOST_DEVICE_ID } from "./shadow-recorder.js";

/**
 * Register a phone in the v3 database so its JWT can reach /v3 routes and later bind its approval key.
 * The stored key is a throwaway P-256 public key with key_attested=0: it can verify nothing, and the
 * phone replaces it through POST /v3/devices/approval-key (enrollment token + attestation chain).
 */
export function enrollV3Device(db: ExocortexDatabase, deviceId: string, label: string, now = Date.now()): void {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  db.registerDevice({
    device_id: deviceId,
    name: label.slice(0, 128),
    platform: "android",
    pubkey_spki: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
    key_attested: 0,
    scopes: ["telemetry:write", "approval:write"],
    enrolled_at: now,
    revoked_at: null,
  });
}

/**
 * Put one harmless SURFACED proposal in the database so the phone has something to approve.
 * The action is the allowlisted read-only diagnostic probe. Returns the proposal id.
 */
export function surfaceTestProposal(
  db: ExocortexDatabase,
  now = Date.now(),
  ttlMs = 10 * 60 * 1000,
  options: { shadow?: boolean } = {},
): string {
  if (!db.getDevice(HOST_DEVICE_ID)) {
    db.registerDevice({
      device_id: HOST_DEVICE_ID,
      name: "exocortexd host",
      platform: process.platform === "win32" ? "windows" : "linux",
      pubkey_spki: new Uint8Array([0]),
      key_attested: 0,
      scopes: ["host:proposal"],
      enrolled_at: now,
      revoked_at: null,
    });
  }
  const id = `devtest_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const action = JSON.stringify({ command: "diagnostic_probe", note: "device approval test" });
  const shadow = options.shadow !== undefined
    ? (options.shadow ? 1 : 0)
    : (process.env.SHADOW === "0" ? 0 : 1);
  db.withTransaction(() => {
    const { event } = db.ingestEvent(HOST_DEVICE_ID, {
      event_id: `proposal:${id}`,
      kind: "proposal",
      ts_device: now,
      schema_ver: 1,
      payload: { proposal_id: id, policy_type: "EPISTEMIC", summary: "Device approval test", shadow: shadow === 1 },
    });
    db.insertProposal({
      proposal_id: id,
      created_seq: event.seq,
      invariant_id: null,
      policy_type: "EPISTEMIC",
      tier: 1,
      summary: "Device approval test (read-only diagnostic probe)",
      action,
      action_hash: new Uint8Array(createHash("sha256").update(action).digest()),
      efe: 1,
      risk_term: 0.2,
      ambiguity_term: 0,
      state: "SURFACED",
      shadow,
      expires_at: now + ttlMs,
      updated_at: now,
    });
  });
  return id;
}
