import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getDatabase, hasDatabase, getDefaultDbPath } from "./db-host.js";
import type { DeviceRecord as V3DeviceRecord } from "@exocortex/core";

// A stateless JWT alone cannot be revoked - the whole point of a device
// registry is to give a per-device revoked flag that every request checks,
// on top of standard signature/expiry validation. Small scale (a handful of
// personal devices), so a flat JSON file is enough - no database needed.

export interface DeviceRecord {
  deviceId: string;
  label: string;
  issuedAt: string;
  revoked: boolean;
}

export interface DeviceRegistry {
  devices: DeviceRecord[];
}

// The v3 DB may not be open yet in this process (fresh daemon start, revoke CLI) even though it
// exists on disk with enrolled/revoked devices; skipping it would ignore v3 revocations.
function v3DbAvailable(): boolean {
  return hasDatabase() || existsSync(getDefaultDbPath());
}

const REGISTRY_PATH = process.env.DEVICE_REGISTRY_PATH ?? "./devices.json";

function load(): DeviceRegistry {
  if (!existsSync(REGISTRY_PATH)) {
    return { devices: [] };
  }
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
}

function save(registry: DeviceRegistry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function addDevice(deviceId: string, label: string): DeviceRecord {
  const registry = load();
  if (registry.devices.some((d) => d.deviceId === deviceId)) {
    throw new Error(`Device ${deviceId} is already enrolled.`);
  }
  const record: DeviceRecord = { deviceId, label, issuedAt: new Date().toISOString(), revoked: false };
  registry.devices.push(record);
  save(registry);
  return record;
}

export function revokeDevice(deviceId: string): void {
  let foundAny = false;
  if (v3DbAvailable()) {
    try {
      const db = getDatabase();
      if (db.getDevice(deviceId)) {
        db.revokeDevice(deviceId);
        foundAny = true;
      }
    } catch {
      // DB query error
    }
  }
  const registry = load();
  const record = registry.devices.find((d) => d.deviceId === deviceId);
  if (record) {
    record.revoked = true;
    save(registry);
    foundAny = true;
  }
  if (!foundAny) throw new Error(`Device ${deviceId} not found.`);
}

export function isRevoked(deviceId: string): boolean {
  let v3Dev: V3DeviceRecord | null | undefined;
  if (v3DbAvailable()) {
    try {
      v3Dev = getDatabase().getDevice(deviceId);
    } catch {
      // Unexpected DB error: fail closed
      return true;
    }
  }

  if (v3Dev && v3Dev.revoked_at != null) {
    return true;
  }

  const registry = load();
  const record = registry.devices.find((d) => d.deviceId === deviceId);
  if (record && record.revoked) {
    return true;
  }

  // If neither store has any record of the device, fail closed
  return !v3Dev && !record;
}



export function listDevices(): DeviceRecord[] {
  return load().devices;
}
