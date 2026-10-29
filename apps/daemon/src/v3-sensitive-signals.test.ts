import test from "node:test";
import assert from "node:assert/strict";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import type { EventIn } from "@exocortex/core";

const TEST_SECRET = "test-gateway-jwt-secret-sensitive-signals-123";
process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.GATEWAY_ENROLL_TOKEN = "test-gateway-enroll-token-sensitive-signals-456";
process.env.DEVICE_REGISTRY_PATH = "none";
process.env.NODE_ENV = "test";

const { server, ingestConsumerForDatabase } = await import("./server.js");

const T0 = Date.UTC(2026, 9, 29, 15, 0, 0);
const DEVICE = "dev_sensitive";
const WINDOW = 300_000;

type Draft = Omit<EventIn, "event_id" | "schema_ver">;
const tel = (ts: number, payload: Record<string, unknown>): Draft => ({ kind: "telemetry", ts_device: ts, payload });

const micWindow = tel(T0 + WINDOW, {
  type: "mic_window", window_start: T0, window_end: T0 + WINDOW, dur_ms: WINDOW, vad: "ezc-1", sample_ms: 5000, period_ms: 120000,
  samples: 2, speech_samples: 1, speech_frac: 0.5, call_frac: 0,
  skipped: { screen_off: 0, pocket: 0, unknown: 0, in_call: 0, mic_busy: 0, silenced: 0, perm: 0 },
});
const placeWindow = tel(T0 + WINDOW, {
  type: "place_window", window_start: T0, window_end: T0 + WINDOW, place_id: "pl_8f2a", label: "home", dwell_ms: WINDOW, conf: 0.9, src: "wifi_connected",
});
const placeEvent = tel(T0 + 10, { type: "place_event", event: "arrive", place_id: "pl_8f2a", label: "home", ts: T0 + 10 });
const typingWindow = tel(T0 + WINDOW, {
  type: "typing_window", window_start: T0, window_end: T0 + WINDOW, dur_ms: WINDOW, events: 40, chars_added: 120, chars_deleted: 8, bursts: 3, active_ms: 41000, median_gap_ms: 180,
});

test("mic_window, place_window, place_event and typing_window round-trip through /v3/events unchanged", async () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  db.registerDevice({
    device_id: DEVICE, name: DEVICE, platform: "android", pubkey_spki: new Uint8Array([1]),
    key_attested: 0, scopes: ["telemetry:write"], enrolled_at: T0, revoked_at: null,
  });
  setDatabase(db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${issueToken(DEVICE, TEST_SECRET)}` };

  try {
    const events = [micWindow, placeWindow, placeEvent, typingWindow].map((d, i) => ({ ...d, event_id: `sens-${i}`, schema_ver: 1 }));
    const res = await fetch(`${baseUrl}/v3/events`, { method: "POST", headers, body: JSON.stringify({ device_id: DEVICE, events }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.insertedCount, events.length);
    await ingestConsumerForDatabase(db).idle();

    const got = await (await fetch(`${baseUrl}/v3/events?limit=100&sinceSeq=0`, { headers })).json();
    assert.equal(got.events.length, events.length);
    got.events.forEach((e: { payload: unknown; event_id: string }, i: number) => {
      assert.equal(e.event_id, events[i].event_id);
      assert.deepEqual(e.payload, events[i].payload);
    });

    // The phone's allowlist quarantines content keys before they are ever sent; none of the stored rows carry any.
    const stored = JSON.stringify(got.events);
    for (const banned of ["ssid", "bssid", '"text"', '"summary"']) assert.ok(!stored.includes(banned), `stored rows must not contain ${banned}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setDatabase(null);
  }
});
