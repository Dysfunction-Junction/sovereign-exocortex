import { registerPlugin } from "@capacitor/core";
import { recordEvent, peekQueue, MAX_QUEUE_SIZE } from "./usage";
import { flushUsageEvents } from "./flush";
import { getSmsBackfillHighWater, setSmsBackfillHighWater } from "./config";

const SmsReader = registerPlugin<any>("SmsReader");

const PAGE_SIZE = 200;
// Hard cap per run so a first backfill against a huge history doesn't hold the
// queue lock for minutes — the high-water mark advances page by page, so the
// next run resumes where this one stopped.
const MAX_PER_RUN = 5000;

/**
 * Stable event id for one SMS: the phone's own message id and date, plus a hash of who and what.
 * Re-pulling the same message (a reset marker, a retried run) then produces the same id, so neither
 * the local queue nor the daemon (UNIQUE event_id) stores it twice. Random ids made every re-pull look new.
 */
export function stableSmsEventId(m: { id: string; address: string; body: string; date: number }): string {
  // cyrb53: small, fast, deterministic 53-bit string hash (not security-sensitive).
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const text = `${m.address}
${m.body}`;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const digest = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  return `sms-${m.id}-${m.date}-${digest}`;
}

export interface SmsBackfillProgress {
  ingested: number;
  done: boolean;
}

export interface SmsContact {
  name: string;
  numbers: string[];
}

interface SmsRow {
  id: string;
  address: string;
  contactName: string;
  body: string;
  date: number;
  direction: "inbound" | "outbound" | "draft" | "other";
}

interface BackfillPage {
  messages: SmsRow[];
  hasMore: boolean;
  scanned: number;
  lastScannedDate: number;
}

export async function smsPermissions(): Promise<{ sms: boolean; contacts: boolean }> {
  try {
    const r = await SmsReader.hasPermission();
    return { sms: !!r.granted, contacts: !!r.contactsGranted };
  } catch {
    return { sms: false, contacts: false };
  }
}

export async function smsPermissionGranted(): Promise<boolean> {
  return (await smsPermissions()).sms;
}

export async function openSmsAppSettings(): Promise<void> {
  await SmsReader.openAppSettings();
}

// --- Contact allowlist --------------------------------------------------

export async function listSmsContacts(): Promise<SmsContact[]> {
  const { contacts } = (await SmsReader.listContacts()) as { contacts: SmsContact[] };
  return contacts ?? [];
}

export async function getSmsAllowlist(): Promise<string[]> {
  const { numbers } = (await SmsReader.getAllowlist()) as { numbers: string[] };
  return numbers ?? [];
}

export async function setSmsAllowlist(numbers: string[]): Promise<number> {
  const { count } = (await SmsReader.setAllowlist({ numbers })) as { count: number };
  return count;
}

// --- Backfill ---------------------------------------------------------

/**
 * Resets the SMS backfill cursor to a recent window (default: last 30 days)
 * relative to the newest message on the device. This ensures recent, active
 * conversations populate first before older multi-year archives.
 */
export async function resetSmsBackfillToRecent(days = 30): Promise<number> {
  const latestRes = (await SmsReader.latestMessageDate().catch(() => null)) as { date?: number } | null;
  const latestDate = Number(latestRes?.date ?? 0);
  const baseTime = latestDate > 0 ? latestDate : Date.now();
  const target = Math.max(0, baseTime - days * 86400 * 1000);
  await setSmsBackfillHighWater(target);
  return target;
}

// recordEvent evicts the OLDEST queue entries past MAX_QUEUE_SIZE, and the
// high-water mark advances per page — so ingesting a page into a queue without
// room would silently and permanently drop messages. Flush to make room, and
// pause the run (high-water untouched) if the queue still can't take a page.
async function ensureQueueRoom(needed: number): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = (await peekQueue()).length;
    if (MAX_QUEUE_SIZE - before >= needed) return true;
    await flushUsageEvents();
    const after = (await peekQueue()).length;
    if (after >= before) return false; // flush made no progress (offline / untriaged head)
  }
  return false;
}

/**
 * Pull SMS history newer than the stored high-water mark into the usage queue,
 * up to MAX_PER_RUN messages per call. Flushed in the background by flushUsageEvents.
 * Safe to call repeatedly — a no-op once caught up or when the allowlist is empty.
 */
let inFlight: Promise<SmsBackfillProgress> | null = null;

/**
 * Single-flight: it now runs on every foreground, so a run that is still going (a big first history) must
 * not be started a second time. Callers that arrive meanwhile share the running one.
 */
export function runSmsBackfill(onProgress?: (p: SmsBackfillProgress) => void): Promise<SmsBackfillProgress> {
  if (inFlight) return inFlight;
  const run = runSmsBackfillOnce(onProgress).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function runSmsBackfillOnce(
  onProgress?: (p: SmsBackfillProgress) => void
): Promise<SmsBackfillProgress> {
  if (!(await smsPermissionGranted())) {
    return { ingested: 0, done: false };
  }
  // Nothing to do until the user has ticked at least one contact.
  if ((await getSmsAllowlist()).length === 0) {
    return { ingested: 0, done: true };
  }

  let since = await getSmsBackfillHighWater();
  if (since === 0) {
    // Initial run: start at the recent window (last 30 days) so recent messages
    // populate immediately into PiecesOS and Mem0 instead of walking years of history first.
    since = await resetSmsBackfillToRecent(30);
  }

  let ingested = 0;

  while (ingested < MAX_PER_RUN) {
    if (!(await ensureQueueRoom(PAGE_SIZE))) return { ingested, done: false };
    const page = (await SmsReader.backfill({
      sinceMillis: since,
      limit: PAGE_SIZE,
    })) as BackfillPage;

    const { messages, hasMore, scanned, lastScannedDate } = page;

    for (const m of messages ?? []) {
      const who = m.contactName || m.address || "unknown";
      await recordEvent({
        id: stableSmsEventId(m),
        type: "system_telemetry",
        screen: "background",
        // Prefix parsed by apps/proxy/src/seeder.ts summarizeTelemetry.
        telemetry: `SMS ${m.direction} ${who}\n${m.body}`,
        package: "com.android.messaging",
        app_label: "Messages",
        timestamp: new Date(m.date).toISOString(),
        triaged: false,
      });
      ingested++;
      since = Math.max(since, m.date);
    }

    // Advance past everything scanned (incl. allowlist-filtered rows) so the
    // next run doesn't re-scan them; never move backwards.
    if (lastScannedDate && lastScannedDate > since) since = lastScannedDate;
    await setSmsBackfillHighWater(since);
    onProgress?.({ ingested, done: !hasMore });

    if (!hasMore || (scanned ?? 0) === 0) return { ingested, done: true };
  }

  // Hit the per-run cap; more remains for the next call.
  return { ingested, done: false };
}
