import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDefaultDbPath } from "./db-host.js";

const STATUS_URL = "https://android.googleapis.com/attestation/status";
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const CACHE_PATH = resolve(dirname(getDefaultDbPath()), "attestation-status.json");

interface StatusCache {
  fetchedAt: number;
  maxAgeMs: number;
  entries: Record<string, { status: string }>;
}

let cached: StatusCache | null | undefined;
let warnedOffline = false;

function loadCache(): StatusCache | null {
  if (cached !== undefined) return cached;
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Partial<StatusCache>;
    if (!Number.isFinite(parsed.fetchedAt) || !parsed.entries || typeof parsed.entries !== "object") throw new Error("invalid cache");
    cached = {
      fetchedAt: parsed.fetchedAt!,
      maxAgeMs: Number.isFinite(parsed.maxAgeMs) && parsed.maxAgeMs! > 0 ? parsed.maxAgeMs! : DEFAULT_MAX_AGE_MS,
      entries: parsed.entries,
    };
  } catch {
    cached = null;
  }
  return cached;
}

function maxAgeFromHeader(value: string | null): number {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(value ?? "");
  return match ? Number(match[1]) * 1000 : DEFAULT_MAX_AGE_MS;
}

function statusEntries(value: unknown): Record<string, { status: string }> {
  if (!value || typeof value !== "object" || !("entries" in value)) throw new Error("status document has no entries");
  const entries = (value as { entries: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("status entries are invalid");
  const normalized: Record<string, { status: string }> = {};
  for (const [serial, raw] of Object.entries(entries)) {
    if (!/^[a-f1-9][a-f0-9]*$/i.test(serial) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("status entry is invalid");
    }
    const status = (raw as { status?: unknown }).status;
    if (status !== "REVOKED" && status !== "SUSPENDED") throw new Error("status entry has an unsupported status");
    normalized[serial.toLowerCase()] = { status };
  }
  return normalized;
}

async function readStatusBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("status response has no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > MAX_STATUS_BYTES) {
        await reader.cancel();
        throw new Error("status document exceeds size limit");
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function saveCache(cache: StatusCache): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  const tempPath = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(cache));
  renameSync(tempPath, CACHE_PATH);
}

/** Refresh Google's status list when its cache lifetime expires; use the last known list when offline. */
export async function getRevokedAttestationSerials(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<ReadonlySet<string>> {
  const previous = loadCache();
  if (previous && now < previous.fetchedAt + previous.maxAgeMs) {
    return new Set(Object.keys(previous.entries));
  }
  try {
    const response = await fetchImpl(STATUS_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_STATUS_BYTES) throw new Error("status document exceeds size limit");
    const body = await readStatusBody(response);
    const next: StatusCache = {
      fetchedAt: now,
      maxAgeMs: maxAgeFromHeader(response.headers.get("cache-control")),
      entries: statusEntries(JSON.parse(body)),
    };
    saveCache(next);
    cached = next;
    warnedOffline = false;
    return new Set(Object.keys(next.entries));
  } catch (err) {
    if (!warnedOffline) {
      console.warn(`[attestation-status] refresh failed; using ${previous ? "last cached" : "empty"} status list: ${err instanceof Error ? err.message : String(err)}`);
      warnedOffline = true;
    }
    if (!previous) throw new Error("Google attestation status is unavailable and no local cache exists");
    return new Set(Object.keys(previous?.entries ?? {}));
  }
}

export function normalizeCertificateSerial(serial: string): string {
  return serial.toLowerCase().replace(/^0+/, "");
}
