import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { usageEventToV3, flushUsageEvents, resetBridgeStateForTest } from "./flush";
import type { UsageEvent } from "./usage";
import * as config from "./config";
import * as usage from "./usage";

vi.mock("./config", () => ({
  getConnectionTargets: vi.fn(),
}));

vi.mock("./usage", () => ({
  peekQueue: vi.fn(),
  clearSentEvents: vi.fn(),
  recordEvent: vi.fn(),
  getBridgeState: vi.fn(async () => undefined),
  setBridgeState: vi.fn(async () => {}),
}));

describe("flushUsageEvents & usageEventToV3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBridgeStateForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

    const healthEvent: UsageEvent = {
      type: "health_observation",
      factor: "link_health",
      observation: "ws_dropped",
      timestamp: "2026-10-09T10:02:00.000Z",
      id: "evt_link_down",
    };
    const v3Health = usageEventToV3(healthEvent);
    expect(v3Health.kind).toBe("observation");
    expect(v3Health.payload).toMatchObject({ factor: "link_health", observation: "ws_dropped" });
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
    vi.stubGlobal("fetch", mockFetch);

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
    expect(usage.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "health_observation",
      factor: "link_health",
      observation: "ping_fast",
    }));
  });

  it("queues a bridge-down observation after total network failure and reports recovery on the next upload", async () => {
    vi.mocked(usage.peekQueue).mockResolvedValueOnce([{
      type: "screen_view",
      screen: "status",
      timestamp: "2026-10-09T10:05:00.000Z",
      id: "evt_offline",
    }]);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      { baseUrl: "http://127.0.0.1:8788", token: "device-token", mode: "lan" },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down")));

    await flushUsageEvents();

    expect(usage.clearSentEvents).not.toHaveBeenCalled();
    expect(usage.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "health_observation",
      factor: "link_health",
      observation: "ws_dropped",
    }));

    const queuedDownEvent: UsageEvent = {
      type: "health_observation",
      factor: "link_health",
      observation: "ws_dropped",
      timestamp: "2026-10-09T10:06:00.000Z",
      id: "evt_link_down",
    };
    vi.mocked(usage.peekQueue).mockResolvedValueOnce([queuedDownEvent]);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      { baseUrl: "http://127.0.0.1:8788", token: "device-token", mode: "lan" },
    ]);
    const recoveredFetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", recoveredFetch);

    await flushUsageEvents();

    expect(JSON.parse(recoveredFetch.mock.calls[0][1].body)).toMatchObject({
      events: [{ kind: "observation", payload: { factor: "link_health", observation: "ws_dropped" } }],
    });
    expect(usage.clearSentEvents).toHaveBeenCalledWith([queuedDownEvent]);
    expect(usage.recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "health_observation",
      factor: "link_health",
      observation: "ping_fast",
    }));
  });

  it("does not label the bridge down when the daemon responded before legacy fallback failed", async () => {
    vi.mocked(usage.peekQueue).mockResolvedValueOnce([{
      type: "screen_view",
      screen: "status",
      timestamp: "2026-10-09T10:05:00.000Z",
      id: "evt_legacy_unavailable",
    }]);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      { baseUrl: "http://127.0.0.1:8788", token: "device-token", mode: "lan" },
    ]);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockRejectedValueOnce(new Error("legacy route unavailable")));

    await flushUsageEvents();

    expect(usage.recordEvent).not.toHaveBeenCalled();
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
    vi.stubGlobal("fetch", mockFetch);

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

  it("fails over to secondary target if first target returns 403 on both v3 and legacy", async () => {
    const sampleEvents: UsageEvent[] = [
      {
        type: "screen_view",
        screen: "status",
        timestamp: "2026-10-09T10:05:00.000Z",
        id: "evt_screen_failover",
      },
    ];

    vi.mocked(usage.peekQueue).mockResolvedValueOnce(sampleEvents);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      {
        baseUrl: "http://127.0.0.1:8788",
        token: "target1_token",
        mode: "lan",
      },
      {
        baseUrl: "https://pieces.dysfunctionjunction.xyz",
        token: "target2_token",
        mode: "remote",
      },
    ]);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 }) // target 1 v3 -> 403
      .mockResolvedValueOnce({ ok: false, status: 403 }) // target 1 legacy -> 403
      .mockResolvedValueOnce({ ok: true, status: 200 }); // target 2 v3 -> 200 OK!
    vi.stubGlobal("fetch", mockFetch);

    await flushUsageEvents();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "https://pieces.dysfunctionjunction.xyz/v3/events",
      expect.anything()
    );
    expect(usage.clearSentEvents).toHaveBeenCalledWith(sampleEvents);
  });

  it("clears isolated single poison pill on 400 or 409, and isolates poison pills inside multi-event batches", async () => {
    const singleMalformed: UsageEvent[] = [
      {
        type: "screen_view",
        screen: "status",
        timestamp: "2026-10-09T10:05:00.000Z",
        id: "evt_single_malformed",
      },
    ];

    vi.mocked(usage.peekQueue).mockResolvedValueOnce(singleMalformed);
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
    vi.stubGlobal("fetch", mockFetch);

    await flushUsageEvents();

    // Single item is cleared to prevent infinite loop
    expect(usage.clearSentEvents).toHaveBeenCalledWith(singleMalformed);

    // Now test multi-item batch: isolate the bad event instead of wiping or wedging
    vi.clearAllMocks();
    const multiEvents: UsageEvent[] = [
      { type: "screen_view", screen: "status", timestamp: "2026-10-09T10:05:00.000Z", id: "evt_1" },
      { type: "screen_view", screen: "status", timestamp: "2026-10-09T10:06:00.000Z", id: "evt_2" },
    ];
    vi.mocked(usage.peekQueue).mockResolvedValueOnce(multiEvents);
    vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
      {
        baseUrl: "http://127.0.0.1:8788",
        token: "bearer_dummy_token",
        mode: "lan",
      },
    ]);
    const mockFetchMulti = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 400 });
    vi.stubGlobal("fetch", mockFetchMulti);

    await flushUsageEvents();

    // Batch rejected -> re-sent per event: the valid one is accepted, the poison pill is dropped, nothing wedges
    expect(mockFetchMulti).toHaveBeenCalledTimes(3);
    expect(usage.clearSentEvents).toHaveBeenCalledWith([multiEvents[0]]);
    expect(usage.clearSentEvents).toHaveBeenCalledWith([multiEvents[1]]);
  });

  it("isolation pass stops on a non-400 response or thrown fetch without resending cleared events", async () => {
    const evs: UsageEvent[] = [1, 2, 3].map((n) => ({
      type: "screen_view",
      screen: "status",
      timestamp: "2026-10-09T10:00:00.000Z",
      id: `evt_${n}`,
    }));
    for (const failure of [
      () => Promise.resolve({ ok: false, status: 503 }),
      () => Promise.reject(new Error("timeout")),
    ]) {
      vi.clearAllMocks();
      vi.mocked(usage.peekQueue).mockResolvedValueOnce(evs);
      vi.mocked(config.getConnectionTargets).mockResolvedValueOnce([
        { baseUrl: "http://127.0.0.1:8788", token: "t", mode: "lan" },
        { baseUrl: "https://remote.example", token: "t", mode: "remote" },
      ]);
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockImplementationOnce(failure);
      vi.stubGlobal("fetch", mockFetch);

      await flushUsageEvents();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(usage.clearSentEvents).toHaveBeenCalledTimes(1);
      expect(usage.clearSentEvents).toHaveBeenCalledWith([evs[0]]);
    }
  });
});
