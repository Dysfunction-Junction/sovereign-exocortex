import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueToken } from "./jwt.js";
import { setDatabase } from "./db-host.js";
import { ExocortexDatabase } from "@exocortex/core/db";
import { DEFAULT_WAKE_THRESHOLD_MS, type EventIn } from "@exocortex/core";
import { PreCognitiveHost, defaultPreCognitiveHost } from "./precognitive-host.js";

const TEST_SECRET = "test-gateway-jwt-secret-secure-precog-123";
const TEST_ENROLL_TOKEN = "test-gateway-enroll-token-secure-precog-456";

process.env.GATEWAY_JWT_SECRET = TEST_SECRET;
process.env.GATEWAY_ENROLL_TOKEN = TEST_ENROLL_TOKEN;
process.env.NODE_ENV = "test";

const { server } = await import("./server.js");

test("PreCognitiveHost unit test: per-device isolation, global threshold fallback for few samples, TTL decay, and clock skew", () => {
  let simTime = Date.now();
  const host = PreCognitiveHost.createIsolatedForTest(() => simTime);

  const initialStatus = host.getStatus("dev_A");
  assert.equal(initialStatus.wakeThresholdMs, DEFAULT_WAKE_THRESHOLD_MS);
  assert.equal(initialStatus.urgencyIntent, "CASUAL");
  assert.equal(initialStatus.calibrated, false);
  assert.equal(initialStatus.sampleCount, 0);
  assert.equal(initialStatus.source, "default");

  const memoryDb = new ExocortexDatabase({ path: ":memory:" });
  try {
    // Register two devices
    memoryDb.registerDevice({
      device_id: "dev_chatty",
      name: "Chatty Node",
      platform: "android",
      pubkey_spki: new Uint8Array(32),
      key_attested: 1,
      scopes: ["telemetry:write"],
      enrolled_at: simTime,
    });

    memoryDb.registerDevice({
      device_id: "dev_sparse",
      name: "Sparse Node",
      platform: "android",
      pubkey_spki: new Uint8Array(32),
      key_attested: 1,
      scopes: ["telemetry:write"],
      enrolled_at: simTime,
    });

    // Seed 20 historical wake delta events for dev_chatty and 3 events for dev_sparse
    const eventsChatty: EventIn[] = [];
    const eventsSparse: EventIn[] = [];
    for (let i = 0; i < 20; i++) {
      const tVibe = simTime - 1000000 + i * 10000;
      const delta = 600 + i * 20;
      eventsChatty.push({
        event_id: `evt_vibe_c_${i}`,
        kind: "vibration",
        ts_device: tVibe,
        schema_ver: 1 as const,
        payload: { event: "VIBRATION" },
      });
      eventsChatty.push({
        event_id: `evt_wake_c_${i}`,
        kind: "telemetry",
        ts_device: tVibe + delta,
        schema_ver: 1 as const,
        payload: { event: "SCREEN_ON", latency_ms: delta },
      });
    }

    for (let i = 0; i < 3; i++) {
      const tVibe = simTime - 500000 + i * 10000;
      const delta = 900;
      eventsSparse.push({
        event_id: `evt_vibe_s_${i}`,
        kind: "vibration",
        ts_device: tVibe,
        schema_ver: 1 as const,
        payload: { event: "VIBRATION" },
      });
      eventsSparse.push({
        event_id: `evt_wake_s_${i}`,
        kind: "telemetry",
        ts_device: tVibe + delta,
        schema_ver: 1 as const,
        payload: { event: "SCREEN_ON", latency_ms: delta },
      });
    }

    memoryDb.ingestBatch({ device_id: "dev_chatty", events: eventsChatty });
    memoryDb.ingestBatch({ device_id: "dev_sparse", events: eventsSparse });

    // Calibrate with minSamples = 10
    const calResult = host.calibrateFromDatabase(memoryDb, 10);
    assert.equal(calResult.calibrated, true);
    assert.equal(calResult.sampleCount, 23); // 20 chatty + 3 sparse

    // dev_chatty has >= 10 samples -> calibrated: true, source: "device", sampleCount: 20
    const statusChatty = host.getStatus("dev_chatty");
    assert.equal(statusChatty.calibrated, true);
    assert.equal(statusChatty.source, "device");
    assert.equal(statusChatty.sampleCount, 20);
    assert.ok(statusChatty.wakeThresholdMs <= 1000);

    // dev_sparse has 3 samples (< 10) -> falls through to global threshold:
    // calibrated: true, source: "global", sampleCount: 23 (global pool)
    const statusSparse = host.getStatus("dev_sparse");
    assert.equal(statusSparse.calibrated, true);
    assert.equal(statusSparse.source, "global");
    assert.equal(statusSparse.sampleCount, 23);
    assert.equal(statusSparse.wakeThresholdMs, calResult.wakeThresholdMs);

    // Test in-window live readiness & TTL decay using injectable clock
    const liveEvents: EventIn[] = [
      {
        event_id: "evt_live_vibe",
        kind: "wake",
        ts_device: simTime - 300,
        schema_ver: 1 as const,
        payload: {},
      },
      {
        event_id: "evt_live_screen",
        kind: "telemetry",
        ts_device: simTime - 100,
        schema_ver: 1 as const,
        payload: { event: "SCREEN_ON" },
      },
      {
        event_id: "evt_live_touch",
        kind: "telemetry",
        ts_device: simTime - 50,
        schema_ver: 1 as const,
        payload: { event: "TOUCH", touch_duration_ms: 150 },
      },
    ];
    const liveIngest = memoryDb.ingestBatch({ device_id: "dev_chatty", events: liveEvents });
    host.onEventsAppended(liveIngest.events, memoryDb);

    const liveStatus = host.getStatus("dev_chatty");
    assert.equal(liveStatus.urgencyIntent, "HIGH_URGENCY");
    assert.equal(liveStatus.wakeupLatencyMs, 200);
    assert.ok(liveStatus.hesitationScore > 0);

    // Advance clock past 60s TTL window -> readiness and hesitationScore decay to CASUAL / 0
    simTime += 65000;
    const expiredStatus = host.getStatus("dev_chatty");
    assert.equal(expiredStatus.urgencyIntent, "CASUAL");
    assert.equal(expiredStatus.wakeupLatencyMs, 0);
    assert.equal(expiredStatus.hesitationScore, 0);

    // Reset clock to match SQLite server timestamp for clock skew test
    simTime = Date.now();
    const futureEvents: EventIn[] = [
      {
        event_id: "evt_skew",
        kind: "vibration",
        ts_device: simTime + 30000,
        schema_ver: 1 as const,
        payload: {},
      },
    ];
    const skewIngest = memoryDb.ingestBatch({ device_id: "dev_chatty", events: futureEvents });
    host.onEventsAppended(skewIngest.events, memoryDb);
    assert.equal(host.getFutureSkewDropCount("dev_chatty"), 1);
    assert.equal(host.getFutureSkewDropCount("dev_sparse"), 0);
  } finally {
    memoryDb.close();
  }
});

test("PreCognitiveHost HTTP endpoints integration test", async () => {
  defaultPreCognitiveHost.resetForTest();
  const memoryDb = new ExocortexDatabase({ path: ":memory:" });
  setDatabase(memoryDb);

  const { publicKey: userPub } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const userDer = userPub.export({ format: "der", type: "spki" });

  memoryDb.registerDevice({
    device_id: "dev_precog_user",
    name: "PreCog Phone Node",
    platform: "android",
    pubkey_spki: Buffer.from(userDer),
    key_attested: 1,
    scopes: ["telemetry:write"],
    enrolled_at: Date.now(),
  });

  const { publicKey: adminPub } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const adminDer = adminPub.export({ format: "der", type: "spki" });

  memoryDb.registerDevice({
    device_id: "dev_precog_admin",
    name: "PreCog Admin Node",
    platform: "android",
    pubkey_spki: Buffer.from(adminDer),
    key_attested: 1,
    scopes: ["telemetry:write", "admin:write", "admin:read"],
    enrolled_at: Date.now(),
  });

  const userToken = issueToken("dev_precog_user", TEST_SECRET);
  const userHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${userToken}`,
  };

  const adminToken = issueToken("dev_precog_admin", TEST_SECRET);
  const adminHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${adminToken}`,
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /v3/precognitive/status
    const statusRes = await fetch(`${baseUrl}/v3/precognitive/status`, {
      method: "GET",
      headers: userHeaders,
    });
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.ok, true);
    assert.equal(statusData.status.deviceId, "dev_precog_user");
    assert.equal(statusData.status.source, "default");
    assert.equal(statusData.status.wakeThresholdMs, DEFAULT_WAKE_THRESHOLD_MS);

    // 2. Scope enforcement: Non-admin device cannot call /v3/precognitive/calibrate (403 Forbidden)
    const unauthCalRes = await fetch(`${baseUrl}/v3/precognitive/calibrate`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({ min_samples: 10 }),
    });
    assert.equal(unauthCalRes.status, 403);

    // Invalid min_samples bounds (< 5 or > 5000) returns 400 Bad Request
    const badCalRes = await fetch(`${baseUrl}/v3/precognitive/calibrate`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ min_samples: 2 }),
    });
    assert.equal(badCalRes.status, 400);

    // Admin calibration on empty DB succeeds with calibrated: false
    const calRes = await fetch(`${baseUrl}/v3/precognitive/calibrate`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ min_samples: 5 }),
    });
    assert.equal(calRes.status, 200);
    const calData = await calRes.json();
    assert.equal(calData.ok, true);
    assert.equal(calData.result.calibrated, false);

    // 3. POST /v3/precognitive/telemetry validation: timestamp skew & dwell bounds
    const tNow = Date.now();
    const staleRes = await fetch(`${baseUrl}/v3/precognitive/telemetry`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        vibration: true,
        timestamp: tNow - 100000, // Stale (> 60s) -> 400 Bad Request
      }),
    });
    assert.equal(staleRes.status, 400);

    const badDwellRes = await fetch(`${baseUrl}/v3/precognitive/telemetry`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        touch_duration_ms: -50, // Negative dwell -> 400 Bad Request
      }),
    });
    assert.equal(badDwellRes.status, 400);

    // Valid real-time probe
    const telRes1 = await fetch(`${baseUrl}/v3/precognitive/telemetry`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        vibration: true,
        timestamp: tNow,
      }),
    });
    assert.equal(telRes1.status, 200);

    const telRes2 = await fetch(`${baseUrl}/v3/precognitive/telemetry`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        screen_state: "SCREEN_ON",
        timestamp: tNow + 80,
        touch_duration_ms: 180,
      }),
    });
    assert.equal(telRes2.status, 200);
    const telData2 = await telRes2.json();
    assert.equal(telData2.ok, true);
    assert.equal(telData2.status.urgencyIntent, "HIGH_URGENCY");
    assert.equal(telData2.status.wakeupLatencyMs, 80);

    // 4. Ingest wake events via POST /v3/events and verify auto hook updates status
    const tBatch = Date.now();
    const tStart = tBatch - 32000;
    const eventsBatch = [];
    for (let i = 0; i < 15; i++) {
      const delta = 600 + i * 20;
      const tEv = tStart + i * 2000;
      eventsBatch.push({
        event_id: `evt_precog_vibe_${i}`,
        stream: "sovereign",
        kind: "vibration",
        payload: { event: "VIBRATION" },
        ts_device: tEv,
      });
      eventsBatch.push({
        event_id: `evt_precog_wake_${i}`,
        stream: "sovereign",
        kind: "telemetry",
        payload: { event: "SCREEN_ON", latency_ms: delta },
        ts_device: tEv + delta,
      });
    }

    const batchRes = await fetch(`${baseUrl}/v3/events`, {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        device_id: "dev_precog_user",
        events: eventsBatch,
      }),
    });
    assert.equal(batchRes.status, 200);

    // Verify auto hook updated live readiness status for dev_precog_user using default 4000ms threshold
    const postIngestStatusRes = await fetch(`${baseUrl}/v3/precognitive/status`, {
      method: "GET",
      headers: userHeaders,
    });
    assert.equal(postIngestStatusRes.status, 200);
    const postIngestStatusData = await postIngestStatusRes.json();
    assert.equal(postIngestStatusData.ok, true);
    assert.equal(postIngestStatusData.status.deviceId, "dev_precog_user");
    assert.equal(postIngestStatusData.status.urgencyIntent, "HIGH_URGENCY");
    assert.equal(postIngestStatusData.status.wakeupLatencyMs, 600 + 14 * 20);
    assert.equal(postIngestStatusData.status.source, "default");
    assert.equal(postIngestStatusData.status.calibrated, false);

    // 5. Now calibrate with min_samples = 10 as admin -> should calibrate successfully
    const calRes2 = await fetch(`${baseUrl}/v3/precognitive/calibrate`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ min_samples: 10 }),
    });
    assert.equal(calRes2.status, 200);
    const calData2 = await calRes2.json();
    assert.equal(calData2.ok, true);
    assert.equal(calData2.result.calibrated, true);
    assert.ok(calData2.result.wakeThresholdMs <= 1000);
    assert.ok(calData2.result.wakeThresholdMs >= 500);

    // Query status again -> calibrated is now true and source is "device"
    const postCalStatusRes = await fetch(`${baseUrl}/v3/precognitive/status`, {
      method: "GET",
      headers: userHeaders,
    });
    assert.equal(postCalStatusRes.status, 200);
    const postCalStatusData = await postCalStatusRes.json();
    assert.equal(postCalStatusData.ok, true);
    assert.equal(postCalStatusData.status.calibrated, true);
    assert.equal(postCalStatusData.status.source, "device");
    assert.ok(postCalStatusData.status.wakeThresholdMs <= 1000);

    // Verify GET /v3/precognitive/pre-warmed returns 200
    const preWarmedRes = await fetch(`${baseUrl}/v3/precognitive/pre-warmed`, {
      method: "GET",
      headers: userHeaders,
    });
    assert.equal(preWarmedRes.status, 200);
    const preWarmedData = await preWarmedRes.json();
    assert.equal(preWarmedData.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    memoryDb.close();
    defaultPreCognitiveHost.resetForTest();
  }
});

test("PreCognitiveHost records SUGGESTION_DECISION events and exposes suggestionMetrics in status", () => {
  const host = PreCognitiveHost.createIsolatedForTest(() => 100_000);
  const fakeDb = {} as any;

  const events = [
    {
      seq: 1,
      event_id: "ev1",
      device_id: "phone-1",
      kind: "telemetry",
      schema_ver: 1,
      prev_hash: new Uint8Array(32),
      hash: new Uint8Array(32),
      ts_server: 100_000,
      ts_device: 100_000,
      payload: JSON.stringify({
        event: "SUGGESTION_DECISION",
        decision: "ACCEPTED",
        suggestion_type: "open_url",
        action: "open_url",
        dwell_ms: 1200,
      }),
    },
    {
      seq: 2,
      event_id: "ev2",
      device_id: "phone-1",
      kind: "telemetry",
      schema_ver: 1,
      prev_hash: new Uint8Array(32),
      hash: new Uint8Array(32),
      ts_server: 100_000,
      ts_device: 100_000,
      payload: JSON.stringify({
        event: "SUGGESTION_DECISION",
        decision: "IGNORED",
        suggestion_type: "view_map",
        action: "view_map",
        dwell_ms: 3600,
      }),
    },
  ];

  host.onEventsAppended(events, fakeDb);
  const status = host.getStatus("phone-1");
  assert.ok(status.suggestionMetrics);
  assert.equal(status.suggestionMetrics.sampleCount, 2);
  assert.equal(status.suggestionMetrics.acceptedCount, 1);
  assert.equal(status.suggestionMetrics.ignoredCount, 1);
  assert.equal(status.suggestionMetrics.acceptanceRate, 0.5);
  assert.equal(status.suggestionMetrics.meanAcceptedDwellMs, 1200);
  assert.equal(status.suggestionMetrics.meanIgnoredDwellMs, 3600);

  // Re-delivering the exact same events with identical event_ids must not double count
  host.onEventsAppended(events, fakeDb);
  const reStatus = host.getStatus("phone-1");
  assert.equal(reStatus.suggestionMetrics?.sampleCount, 2);
});

test("PreCognitiveHost speculative action pre-warming: Markov transitions and clipboard intent", () => {
  let currentNow = 200_000;
  const now = currentNow;
  const host = PreCognitiveHost.createIsolatedForTest(() => currentNow);
  const fakeDb = {} as any;

  // 1. Train Markov transitions: Chrome -> Maps (twice), then transition Slack -> Chrome
  const transitionEvents = [
    {
      seq: 1,
      event_id: "evt_t1",
      device_id: "phone-precog-1",
      kind: "telemetry",
      schema_ver: 1,
      prev_hash: new Uint8Array(32),
      hash: new Uint8Array(32),
      ts_server: now,
      ts_device: now,
      payload: JSON.stringify({
        appTransitions: [
          { from: "com.android.chrome", to: "com.google.android.apps.maps", timestamp: now - 10000 },
          { from: "com.android.chrome", to: "com.google.android.apps.maps", timestamp: now - 8000 },
          { from: "com.slack", to: "com.android.chrome", timestamp: now - 1000 },
        ],
      }),
    },
  ];

  host.onEventsAppended(transitionEvents, fakeDb);

  const statusAfterTransition = host.getStatus("phone-precog-1");
  assert.equal(statusAfterTransition.isPreStaged, true);
  assert.ok(statusAfterTransition.preStagedProposalId?.startsWith("prop_precog_phone-precog-1_"));
  assert.ok(statusAfterTransition.preWarmedAction);
  assert.equal(statusAfterTransition.preWarmedAction.targetApp, "com.google.android.apps.maps");
  assert.ok(statusAfterTransition.preWarmedAction.probability >= 0.35);

  const preWarmed = host.getPreWarmedProposal("phone-precog-1");
  assert.ok(preWarmed);
  assert.equal(preWarmed.targetApp, "com.google.android.apps.maps");

  // 2. Clipboard Intent Pre-Warming
  const clipboardEvents = [
    {
      seq: 2,
      event_id: "evt_clip_1",
      device_id: "phone-precog-1",
      kind: "telemetry",
      schema_ver: 1,
      prev_hash: new Uint8Array(32),
      hash: new Uint8Array(32),
      ts_server: now,
      ts_device: now,
      payload: JSON.stringify({
        clipboardIntent: {
          entity_type: "TRACKING_NUMBER",
          value: "1Z9999999999999999",
        },
      }),
    },
  ];

  host.onEventsAppended(clipboardEvents, fakeDb);

  const statusAfterClipboard = host.getStatus("phone-precog-1");
  assert.equal(statusAfterClipboard.isPreStaged, true);
  assert.ok(statusAfterClipboard.preStagedProposalId?.startsWith("prop_intent_phone-precog-1_"));
  assert.ok(statusAfterClipboard.preWarmedAction);
  assert.equal(statusAfterClipboard.preWarmedAction.targetApp, "companion");
  // Privacy invariant: raw clipboard snippet/value is NEVER included in action or status
  assert.equal(statusAfterClipboard.preWarmedAction.action, "Process clipboard TRACKING_NUMBER");
  assert.equal(statusAfterClipboard.preWarmedAction.action.includes("1Z9999999999999999"), false);

  // 3. Device isolation: phone-precog-2 must not inherit phone-precog-1's pre-warmed state
  const statusDev2 = host.getStatus("phone-precog-2");
  assert.equal(statusDev2.isPreStaged, false);
  assert.equal(statusDev2.preWarmedAction, undefined);

  // 4. Expiry: advance time past RECENCY_WINDOW_MS (60,000ms)
  currentNow += 65_000;
  const expiredProposal = host.getPreWarmedProposal("phone-precog-1");
  assert.equal(expiredProposal, null);

  const statusAfterExpiry = host.getStatus("phone-precog-1");
  assert.equal(statusAfterExpiry.isPreStaged, false);
  assert.equal(statusAfterExpiry.preStagedProposalId, undefined);
  assert.equal(statusAfterExpiry.preWarmedAction, undefined);
});

test("PreCognitiveHost: supports native Android transitions & clipboard_intent keys and survives undefined event_id", () => {
  const now = 300_000;
  const host = PreCognitiveHost.createIsolatedForTest(() => now);
  const fakeDb = {} as any;

  // 1. Android NativeTelemetrySync format: event "APP_TRANSITIONS" with "transitions" array
  const nativeEvents = [
    {
      seq: 1,
      device_id: "phone-android-native",
      kind: "telemetry",
      schema_ver: 1,
      prev_hash: new Uint8Array(32),
      hash: new Uint8Array(32),
      ts_server: now,
      ts_device: now,
      // NOTE: event_id is intentionally omitted / undefined
      payload: JSON.stringify({
        event: "APP_TRANSITIONS",
        appTransitions: {}, // non-array object must not shadow valid transitions array
        transitions: [
          { from: "com.android.chrome", to: "com.google.android.apps.maps", dwell_ms: 12000 },
          { from: "com.android.chrome", to: "com.google.android.apps.maps", dwell_ms: 15000 },
          { from: "com.slack", to: "com.android.chrome", dwell_ms: 3000 },
        ],
      }),
    },
  ];

  // Must not throw even without event_id
  assert.doesNotThrow(() => {
    host.onEventsAppended(nativeEvents as any, fakeDb);
  });

  const status = host.getStatus("phone-android-native");
  assert.equal(status.isPreStaged, true);
  assert.ok(status.preWarmedAction);
  assert.equal(status.preWarmedAction.targetApp, "com.google.android.apps.maps");

  // 2. Android NativeTelemetrySync format: event "CLIPBOARD_INTENT" with "clipboard_intent" object
  const clipEvent = [
    {
      seq: 2,
      device_id: "phone-android-native",
      kind: "telemetry",
      schema_ver: 1,
      prev_hash: new Uint8Array(32),
      hash: new Uint8Array(32),
      ts_server: now,
      ts_device: now,
      // NOTE: event_id is undefined
      payload: JSON.stringify({
        event: "CLIPBOARD_INTENT",
        clipboard_intent: {
          entity_type: "url",
          value: "https://example.com/item",
        },
      }),
    },
  ];

  assert.doesNotThrow(() => {
    host.onEventsAppended(clipEvent as any, fakeDb);
  });

  const clipStatus = host.getStatus("phone-android-native");
  assert.equal(clipStatus.isPreStaged, true);
  assert.equal(clipStatus.preWarmedAction?.action, "Process clipboard URL");
});



test("PreCognitiveHost: app_foreground arrivals feed the Markov model and excluded arrivals pre-stage nothing", () => {
  const now = 300_000;
  const host = PreCognitiveHost.createIsolatedForTest(() => now);
  const fakeDb = {} as any;
  let seq = 0;
  const arrival = (payload: Record<string, unknown>) => ({
    seq: ++seq,
    event_id: `evt_fg_${seq}`,
    device_id: "phone-fg",
    kind: "telemetry",
    schema_ver: 1,
    prev_hash: new Uint8Array(32),
    hash: new Uint8Array(32),
    ts_server: now,
    ts_device: now - 100 + seq,
    payload: JSON.stringify({ type: "app_foreground", event: "APP_TRANSITION", src: "usage_stats", ...payload }),
  });

  // Excluded arrivals name no app (to and from are redacted), whatever else they carry.
  host.onEventsAppended([arrival({ category: "excluded", excluded: true, dwell_prev_ms: 500 })], fakeDb);
  host.onEventsAppended([arrival({ category: "excluded", excluded: true, from: "com.bank.app", to: "com.bank.app" })], fakeDb);
  assert.equal(host.getStatus("phone-fg").isPreStaged, false);
  assert.equal(host.getPreWarmedProposal("phone-fg"), null);
  assert.equal(host.getMarkovModel("phone-fg").getTotalTransitionsFrom("com.bank.app"), 0);

  // Real arrivals are the v3 carrier: a repeated chrome -> maps hop is learned, then chrome pre-stages maps.
  host.onEventsAppended([arrival({ from: "com.android.chrome", to: "com.google.android.apps.maps", category: "Maps", dwell_prev_ms: 4000 })], fakeDb);
  host.onEventsAppended([arrival({ from: "com.android.chrome", to: "com.google.android.apps.maps", category: "Maps", dwell_prev_ms: 5000 })], fakeDb);
  host.onEventsAppended([arrival({ from: "com.slack", to: "com.android.chrome", category: "Communication", dwell_prev_ms: 9000 })], fakeDb);
  assert.equal(host.getMarkovModel("phone-fg").getTransitionCount("com.android.chrome", "com.google.android.apps.maps"), 2);
  assert.equal(host.getPreWarmedProposal("phone-fg")?.targetApp, "com.google.android.apps.maps");

  // A later excluded arrival leaves the model and the pre-staged proposal untouched.
  const total = host.getMarkovModel("phone-fg").getTotalTransitionsFrom("com.android.chrome");
  host.onEventsAppended([arrival({ category: "excluded", excluded: true })], fakeDb);
  assert.equal(host.getMarkovModel("phone-fg").getTotalTransitionsFrom("com.android.chrome"), total);
});
