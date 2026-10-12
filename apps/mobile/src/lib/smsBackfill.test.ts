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

describe("SMS event ids and overlapping runs", () => {
  const msg = (i: number, extra: Record<string, unknown> = {}) => ({
    id: String(i), address: "+15555550100", contactName: "Pat", body: `hello ${i}`, date: BASE + i, direction: "inbound" as const, ...extra,
  });
  const onePage = (messages: unknown[]) =>
    sms.backfill.mockImplementation(async () => ({ messages, hasMore: false, scanned: messages.length, lastScannedDate: BASE + 50 }));

  it("gives the same message the same id, and a different one to a different message", async () => {
    const { stableSmsEventId } = await import("./smsBackfill");
    expect(stableSmsEventId(msg(1))).toBe(stableSmsEventId(msg(1)));
    expect(stableSmsEventId(msg(1))).not.toBe(stableSmsEventId(msg(2)));
    expect(stableSmsEventId(msg(1))).not.toBe(stableSmsEventId(msg(1, { body: "edited" })));
    expect(stableSmsEventId(msg(1))).not.toBe(stableSmsEventId(msg(1, { address: "+15555550199" })));
    expect(stableSmsEventId(msg(1)).length).toBeLessThanOrEqual(128);
  });

  it("does not queue a message twice when the marker is reset and it is pulled again", async () => {
    onePage([msg(1), msg(2), msg(3)]);
    await runSmsBackfill();
    expect((await peekQueue()).length).toBe(3);

    await Preferences.set({ key: "pieces-android:smsBackfillHighWater", value: "0" }); // marker lost
    await runSmsBackfill();
    const queue = await peekQueue();
    expect(queue.length).toBe(3);
    expect(new Set(queue.map((e) => (e as { id: string }).id)).size).toBe(3);
  });

  it("shares one run between callers that overlap (resume + cold start)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sms.backfill.mockImplementation(async () => {
      await gate;
      return { messages: [msg(1)], hasMore: false, scanned: 1, lastScannedDate: BASE + 1 };
    });
    const a = runSmsBackfill();
    const b = runSmsBackfill();
    expect(b).toBe(a);
    release();
    await a;
    expect(sms.backfill).toHaveBeenCalledTimes(1);
    expect((await peekQueue()).length).toBe(1);
  });
});
