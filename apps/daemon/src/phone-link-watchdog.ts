// Tells the user when their phone has stopped checking in with the PC.
//
// The phone only ever uploads in batches, so a "dropped link" is learned about after the link is already
// back. The reliable signal is silence seen from the PC side. Silence is only counted while this process
// was running: if the PC slept (a tick arrives far later than its interval) the clock restarts, so a
// laptop waking up in the morning never blames the phone for the night.

import type { ExocortexDatabase } from "@exocortex/core/db";
import { defaultPushNotifier } from "./push-notifier.js";
import { getDatabase } from "./db-host.js";

export interface PhoneStatus {
  deviceId: string;
  name: string;
  /** Server time of the newest event received from this phone. */
  lastSeenMs: number;
}

export interface PhoneLinkWatchdogOptions {
  listPhones: () => PhoneStatus[];
  notify: (title: string, body: string) => Promise<{ sent: number }>;
  now?: () => number;
  log?: (msg: string) => void;
  /** How long the phone may stay silent, while the PC is awake, before the user is told. */
  silenceMs?: number;
  tickMs?: number;
  /** Phones silent longer than this are treated as retired and never reported. */
  retireMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;

export class PhoneLinkWatchdog {
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly silenceMs: number;
  private readonly tickMs: number;
  private readonly retireMs: number;
  private baseline: number;
  private lastTick: number;
  private readonly alertedAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: PhoneLinkWatchdogOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.silenceMs = opts.silenceMs ?? 4 * HOUR_MS;
    this.tickMs = opts.tickMs ?? 60_000;
    this.retireMs = opts.retireMs ?? 7 * 24 * HOUR_MS;
    this.lastTick = this.baseline = this.now();
  }

  async tick(): Promise<void> {
    const now = this.now();
    if (now - this.lastTick > 3 * this.tickMs) this.baseline = now; // this PC was asleep: start counting afresh
    this.lastTick = now;
    let phones: PhoneStatus[];
    try {
      phones = this.opts.listPhones();
    } catch (err) {
      this.log(`[phone-link-watchdog] could not read phones: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const p of phones) {
      if (now - p.lastSeenMs > this.retireMs) continue;
      const alerted = this.alertedAt.get(p.deviceId);
      if (alerted !== undefined && p.lastSeenMs > alerted) {
        this.alertedAt.delete(p.deviceId); // it checked in again: a later silence is a new episode
        this.log(`[phone-link-watchdog] ${p.name} is checking in again`);
      } else if (alerted !== undefined) {
        continue;
      }
      const silentSince = Math.max(p.lastSeenMs, this.baseline);
      if (now - silentSince < this.silenceMs) continue;
      const hours = Math.max(1, Math.round((now - silentSince) / HOUR_MS));
      const result = await this.opts.notify(
        "Your phone hasn't checked in",
        `Your PC hasn't heard from ${p.name} for about ${hours} ${hours === 1 ? "hour" : "hours"}. Check that the phone is on and connected to the internet.`,
      );
      if (result.sent > 0) {
        this.alertedAt.set(p.deviceId, now);
        this.log(`[phone-link-watchdog] told the user ${p.name} has been silent ~${hours}h`);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Android phones that have ever sent an event, with the time of the newest one. */
export function listPhonesFromDb(db: ExocortexDatabase): PhoneStatus[] {
  const rows = db.raw
    .prepare(
      `SELECT d.device_id AS id, d.name AS name, MAX(e.ts_server) AS last
         FROM devices d JOIN events e ON e.device_id = d.device_id
        WHERE d.revoked_at IS NULL AND d.platform = 'android' GROUP BY d.device_id`,
    )
    .all() as Array<{ id: string; name: string | null; last: number }>;
  return rows.map((r) => ({ deviceId: String(r.id), name: r.name && r.name !== "--" ? String(r.name) : "your phone", lastSeenMs: Number(r.last) }));
}

export const defaultPhoneLinkWatchdog = new PhoneLinkWatchdog({
  listPhones: () => listPhonesFromDb(getDatabase()),
  notify: (title, body) => defaultPushNotifier.sendNotice(title, body),
  silenceMs: Number(process.env.EXOCORTEX_PHONE_SILENCE_MIN) > 0 ? Number(process.env.EXOCORTEX_PHONE_SILENCE_MIN) * 60_000 : undefined,
});
