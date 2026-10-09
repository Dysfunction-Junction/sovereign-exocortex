import { beforeEach, describe, expect, it, vi } from "vitest";

const sms = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  getAllowlist: vi.fn(),
  latestMessageDate: vi.fn(),
  backfill: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => sms,
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("./flush", () => ({ flushUsageEvents: vi.fn(async () => {}) }));

import { Preferences } from "@capacitor/preferences";
import { flushUsageEvents } from "./flush";
import { peekQueue, replaceQueue } from "./usage";
import { getSmsBackfillHighWater } from "./config";
import { runSmsBackfill } from "./smsBackfill";

const BASE = 1_700_000_000_000;
const PAGE = 200;

function installPages(totalPages: number) {
  let page = 0;
  sms.backfill.mockImplementation(async () => {
    const start = page * PAGE;
    const messages = Array.from({ length: PAGE }, (_, i) => ({
      id: String(start + i),
      address: "+15555550100",
      contactName: "Pat",
      body: `msg ${start + i}`,
      date: BASE + start + i,
      direction: "inbound" as const,
    }));
    page++;
    return {
      messages,
      hasMore: page < totalPages,
      scanned: PAGE,
      lastScannedDate: BASE + start + PAGE - 1,
    };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await Preferences.remove({ key: "pieces-android:usageQueue" });
  await Preferences.remove({ key: "pieces-android:smsBackfillHighWater" });
  sms.hasPermission.mockResolvedValue({ granted: true, contactsGranted: true });
  sms.getAllowlist.mockResolvedValue({ numbers: ["+15555550100"] });
  sms.latestMessageDate.mockResolvedValue({ date: BASE });
});

describe("runSmsBackfill queue capacity", () => {
  it("pauses instead of evicting un-flushed messages when the queue is full", async () => {
    installPages(4); // 800 messages, but the queue only holds 500
    const res = await runSmsBackfill();

    const queue = await peekQueue();
    expect(res.done).toBe(false);
    // Nothing that was ingested may have been evicted from the queue...
    expect(queue.length).toBe(res.ingested);
    expect(res.ingested).toBeLessThanOrEqual(500);
    // ...and the high-water mark must not run past the last queued message.
    const last = queue[queue.length - 1] as { timestamp: string };
    expect(await getSmsBackfillHighWater()).toBe(new Date(last.timestamp).getTime());
  });

  it("keeps ingesting across pages when flush frees room", async () => {
    installPages(4);
    const sent: unknown[] = [];
    vi.mocked(flushUsageEvents).mockImplementation(async () => {
      sent.push(...(await peekQueue()));
      await replaceQueue([]);
    });

    const res = await runSmsBackfill();
    const remaining = await peekQueue();
    expect(res.done).toBe(true);
    expect(res.ingested).toBe(800);
    expect(sent.length + remaining.length).toBe(800);
  });
});
