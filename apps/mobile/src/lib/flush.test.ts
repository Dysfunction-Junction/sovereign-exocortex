import { describe, it, expect, vi, beforeEach } from "vitest";
import { usageEventToV3, flushUsageEvents } from "./flush";
import type { UsageEvent } from "./usage";
import * as config from "./config";
import * as usage from "./usage";

vi.mock("./config", () => ({
  getConnectionTargets: vi.fn(),
}));

vi.mock("./usage", () => ({
  peekQueue: vi.fn(),
  clearSentEvents: vi.fn(),
}));

describe("flushUsageEvents & usageEventToV3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts UsageEvent to Schema v3 EventIn", () => {
    const askEvent: UsageEvent = {
      type: "ask",
      screen: "ask",
      query: "How do I fix the bridge?",
      result: "answered",
      timestamp: "2026-10-09T10:00:00.000Z",
      id: "evt_ask_1",
    };
    const v3Ask = usageEventToV3(askEvent);
    expect(v3Ask.event_id).toBe("evt_ask_1");
    expect(v3Ask.kind).toBe("query");
    expect(v3Ask.schema_ver).toBe(1);
    expect(v3Ask.ts_device).toBe(new Date("2026-10-09T10:00:00.000Z").getTime());
    expect(v3Ask.payload.query).toBe("How do I fix the bridge?");

    const sysEvent: UsageEvent = {
      type: "system_telemetry",
      screen: "background",
      telemetry: "notification received",
      package: "com.whatsapp",
      timestamp: "2026-10-09T10:01:00.000Z",
      triaged: true,
    };
    const v3Sys = usageEventToV3(sysEvent);
    expect(v3Sys.kind).toBe("telemetry");
    expect(v3Sys.payload.package).toBe("com.whatsapp");
  });

  it("posts batched events to POST /v3/events and clears sent items on success", async () => {
    const sampleEvents: UsageEvent[] = [
      {
        type: "screen_view",
        screen: "status",
        timestamp: "2026-10-09T10:05:00.000Z",
        id: "evt_screen_1",
      },
    ];

    vi.mocked(usage.peekQueue).mockResolvedValueOnce(sampleEvents);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      {
        baseUrl: "http://127.0.0.1:8788",
        token: "bearer_dummy_token",
        mode: "lan",
      },
    ]);

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    globalThis.fetch = mockFetch;

    await flushUsageEvents();

    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/v3/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer bearer_dummy_token",
        }),
      })
    );
    expect(usage.clearSentEvents).toHaveBeenCalledWith(sampleEvents);
  });

  it("falls back to legacy /mobile/usage-report if /v3/events returns 404 or 403", async () => {
    const sampleEvents: UsageEvent[] = [
      {
        type: "screen_view",
        screen: "status",
        timestamp: "2026-10-09T10:05:00.000Z",
        id: "evt_screen_legacy",
      },
    ];

    vi.mocked(usage.peekQueue).mockResolvedValueOnce(sampleEvents);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      {
        baseUrl: "http://127.0.0.1:8788",
        token: "bearer_dummy_token",
        mode: "lan",
      },
    ]);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });
    globalThis.fetch = mockFetch;

    await flushUsageEvents();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8788/v3/events",
      expect.anything()
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8788/mobile/usage-report",
      expect.anything()
    );
    expect(usage.clearSentEvents).toHaveBeenCalledWith(sampleEvents);
  });

  it("clears poison pill events on 400 or 409 to prevent queue deadlock", async () => {
    const malformedEvents: UsageEvent[] = [
      {
        type: "screen_view",
        screen: "status",
        timestamp: "2026-10-09T10:05:00.000Z",
        id: "evt_malformed",
      },
    ];

    vi.mocked(usage.peekQueue).mockResolvedValueOnce(malformedEvents);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      {
        baseUrl: "http://127.0.0.1:8788",
        token: "bearer_dummy_token",
        mode: "lan",
      },
    ]);

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
    });
    globalThis.fetch = mockFetch;

    await flushUsageEvents();

    expect(usage.clearSentEvents).toHaveBeenCalledWith(malformedEvents);
  });
});
