import { existsSync, readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase, hasDatabase, getDefaultDbPath } from "./db-host.js";
import type { DeviceRecord as V3DeviceRecord } from "@exocortex/core";

export interface DeviceRecord {
  deviceId: string;
  label: string;
  issuedAt: string;
  revoked: boolean;
}

export interface DeviceRegistry {
  devices: DeviceRecord[];
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const legacyPaths = [...new Set([
  process.env.DEVICE_REGISTRY_PATH ? resolve(process.env.DEVICE_REGISTRY_PATH) : "",
  resolve("./devices.json"),
  resolve(moduleDir, "../devices.json"),
].filter(Boolean))];
let legacyMigrationDone = false;

function v3DbAvailable(): boolean {
  return hasDatabase() || existsSync(getDefaultDbPath()) || legacyPaths.some((path) => existsSync(path));
}

function migrateLegacyDevices(): void {
  if (legacyMigrationDone) return;
  const db = getDatabase();
  const legacyRegistries: Array<{ path: string; registry: DeviceRegistry }> = [];
  for (const path of legacyPaths) {
    if (!existsSync(path)) continue;
    try {
      const legacy = JSON.parse(readFileSync(path, "utf8")) as DeviceRegistry;
      if (!legacy || !Array.isArray(legacy.devices)) {
        throw new Error("legacy registry must contain a devices array");
      }
      legacyRegistries.push({ path, registry: legacy });
    } catch (err) {
      throw new Error(`[device-registry] could not read legacy registry at ${path}`, { cause: err });
    }
  }
  db.withTransaction(() => {
    for (const { registry } of legacyRegistries) {
      for (const record of registry.devices) {
        if (!record || typeof record.deviceId !== "string" || !record.deviceId) continue;
        const existing = db.getDevice(record.deviceId);
        if (existing) {
          if (record.revoked && existing.revoked_at === null) db.revokeDevice(record.deviceId);
          continue;
        }
        const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const issuedAt = Date.parse(record.issuedAt);
        db.registerDevice({
          device_id: record.deviceId,
          name: typeof record.label === "string" ? record.label.slice(0, 128) : record.deviceId,
          platform: "android",
          pubkey_spki: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
          key_attested: 0,
          scopes: ["telemetry:write"],
          enrolled_at: Number.isFinite(issuedAt) ? issuedAt : Date.now(),
          revoked_at: record.revoked ? Date.now() : null,
        });
      }
    }
  });
  legacyMigrationDone = true;
}

function toLegacyShape(device: V3DeviceRecord): DeviceRecord {
  return {
    deviceId: device.device_id,
    label: device.name,
    issuedAt: new Date(device.enrolled_at).toISOString(),
    revoked: device.revoked_at !== null,
  };
}

export function addDevice(deviceId: string, label: string): DeviceRecord {
  migrateLegacyDevices();
  const db = getDatabase();
  if (db.getDevice(deviceId)) throw new Error(`Device ${deviceId} is already enrolled.`);
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  db.registerDevice({
    device_id: deviceId,
    name: label.slice(0, 128),
    platform: "android",
    pubkey_spki: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
    key_attested: 0,
    scopes: ["telemetry:write", "approval:write"],
    enrolled_at: Date.now(),
    revoked_at: null,
  });
  return toLegacyShape(db.getDevice(deviceId)!);
}

export function revokeDevice(deviceId: string): void {
  if (!v3DbAvailable()) throw new Error(`Device ${deviceId} not found.`);
  migrateLegacyDevices();
  const db = getDatabase();
  if (!db.getDevice(deviceId)) throw new Error(`Device ${deviceId} not found.`);
  db.revokeDevice(deviceId);
}

export function isRevoked(deviceId: string): boolean {
  if (!v3DbAvailable()) return true;
  try {
    migrateLegacyDevices();
    const device = getDatabase().getDevice(deviceId);
    return !device || device.revoked_at !== null;
  } catch {
    // A database read or legacy migration failure must fail closed.
    return true;
  }
}

export function listDevices(): DeviceRecord[] {
  migrateLegacyDevices();
  return getDatabase().listDevices().map(toLegacyShape);
}
