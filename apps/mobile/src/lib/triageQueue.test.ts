import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./onDeviceTriage", () => ({
  tryOnDeviceTriage: vi.fn(),
}));
vi.mock("./textEmbedder", () => ({
  embed: vi.fn(),
}));
vi.mock("./flush", () => ({
  flushUsageEvents: vi.fn(async () => {}),
}));

import { tryOnDeviceTriage } from "./onDeviceTriage";
import { embed } from "./textEmbedder";
import { triageQueue, triageQueueSafe } from "./triageQueue";
import { recordEvent, peekQueue } from "./usage";
import { readIndex, clearIndex } from "./captureIndex";
import { Preferences } from "@capacitor/preferences";

beforeEach(async () => {
  await Preferences.remove({ key: "pieces-android:usageQueue" });
  await clearIndex();
  vi.clearAllMocks();
});

describe("triageQueue indexing", () => {
  test("a successful triage appends an embedded entry to the capture index", async () => {
    await recordEvent({
      type: "system_telemetry",
      screen: "background",
      telemetry: "Package: com.example\n\nraw screen text",
      package: "com.example",
      app_label: "Example",
      timestamp: "2026-02-01T10:00:00.000Z",
    });
    vi.mocked(tryOnDeviceTriage).mockResolvedValue({ ok: true, summary: "looked at a thing", category: "shopping" });
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [0.5, 0.5] });

    await triageQueue();

    const index = await readIndex();
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      id: "local:2026-02-01T10:00:00.000Z",
      text: "looked at a thing",
      vector: [0.5, 0.5],
      source: "local",
      app_label: "Example",
    });
  });

  test("a failed triage does NOT touch the capture index", async () => {
    await recordEvent({
      type: "system_telemetry",
      screen: "background",
      telemetry: "Package: com.example\n\nraw",
      timestamp: "2026-02-01T11:00:00.000Z",
    });
    vi.mocked(tryOnDeviceTriage).mockResolvedValue({ ok: false });

    await triageQueue();

    expect(await readIndex()).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  test("embed failure is non-fatal — queue still rewritten, index untouched", async () => {
    await recordEvent({
      type: "system_telemetry",
      screen: "background",
      telemetry: "Package: com.example\n\nraw",
      timestamp: "2026-02-01T12:00:00.000Z",
    });
    vi.mocked(tryOnDeviceTriage).mockResolvedValue({ ok: true, summary: "s", category: "c" });
    vi.mocked(embed).mockResolvedValue({ ok: false });

    await triageQueue();

    expect(await readIndex()).toEqual([]);
    const queue = await peekQueue();
    expect(queue[0]).toMatchObject({ triaged: true });
  });
});

describe("triageQueue single-flight", () => {
  const ev = {
    type: "system_telemetry" as const,
    screen: "background" as const,
    telemetry: "Package: com.example\n\nraw",
    timestamp: "2026-02-01T13:00:00.000Z",
  };

  test("concurrent calls share one run", async () => {
    await recordEvent(ev);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(tryOnDeviceTriage).mockImplementation(async () => {
      await gate;
      return { ok: false };
    });
    const a = triageQueue();
    const b = triageQueue();
    expect(b).toBe(a);
    release();
    await Promise.all([a, b]);
    expect(tryOnDeviceTriage).toHaveBeenCalledTimes(1);
    // after completion a new run may start
    await triageQueue();
  });

  test("a rejected run clears the guard and triageQueueSafe never rejects unhandled", async () => {
    await recordEvent(ev);
    vi.mocked(tryOnDeviceTriage).mockRejectedValueOnce(new Error("boom"));
    triageQueueSafe();
    await new Promise((r) => setTimeout(r, 20));
    // vitest fails the run on any unhandled rejection, so reaching here proves none escaped
    vi.mocked(tryOnDeviceTriage).mockResolvedValue({ ok: false });
    await expect(triageQueue()).resolves.toBeUndefined();
  });
});
