# Android foreground-app and sensor spec (2026-10-29)

This spec builds on `PREDICTOR_UPGRADE_SPEC_2026-10-29.md`: F4-F6, W3.6, W3.8, W4 and WP-A/WP7. It replaces WP-A and WP7 there.
- **Tags:** **[V]** means I read the code or ran a read-only query; **[I]** means inferred.
- **Branch:** `feat/forecast-cards`. WP1, WP3, WP4 and WP6 have landed (git log [V]). `--eval --gate` and `hazard.ts` do not exist yet [V]. Android paths are relative to `apps/mobile/android/app/src/main/java/com/pieces/android/companion/`.

**User decisions this session:**
1. Per-app foreground transitions go to the daemon and the predictor.
2. Environment and motion sensors are opt-in, one toggle per sensor, default OFF, and revocation takes effect immediately.

## 0. Facts this design depends on

| # | Fact | Tag |
|---|---|---|
| S1 | `PiecesAccessibilityService.isAllowed` (409-428) only gates *text capture*. It first applies the hard denylist `AccessibilityPlugin.isExcluded(pkg, label)`, then the user allowlist. | V |
| S2 | `UsageSummary.queue` reads `UsageStatsManager.queryEvents` under PACKAGE_USAGE_STATS. It gets package, event type and timestamp only, and never consults `isAllowed` or `isExcluded`. Its summary text and `transitions` include banking apps today (legacy route only). | V |
| S3 | `UsageSummary` lines 99-114 skip any transition touching the companion's own package and cap the list at 30 per window. The first `dwell_ms` depends on the window start. | V |
| S4 | `isExcluded` mixes three lists: privacy prefixes, *noise* prefixes (launcher, systemui, settings, gms) and label keywords. **There are no health apps** in any list. | V |
| S5 | `/v3/events` (server.ts 753-850) stores `payload` verbatim. Its limits: ≤100 events per POST, 1 MiB body, `event_id` ≤128 chars, plain-object payload, and one bad event fails the batch with 400. "telemetry-validation" (`world-model-host.validateSignals`) applies only to `WorldModelHost.ingestTelemetry`, not to `/v3/events`. | V |
| S6 | `dropKnownTelemetry` only content-dedupes `type:"system_telemetry"`. A reused `event_id` with a different payload raises `EventIdConflictError` (409). | V |
| S7 | `ContextTracker.update` (prediction-events.ts 101-143) reads top-level `package`, `temp_c`, `battery_pct`, `charging`, `network` and `screen_state` from **every** telemetry payload, and the last seq wins. | V |
| S8 | `resolveWithAction` uses `latency = max(0, actual.ts - made_at)` and resolves every open prediction with `made_seq < seq`. A late-arriving older action therefore resolves newer predictions with latency 0. | V |
| S9 | `ProbEngine.fromJSON` copies `logW` verbatim but matches experts by name. Adding experts would leave `logW` shorter than the experts list. Experts read only `spec.features` (prob-engine.ts 273), so extra keys in the feature map are ignored. | V |
| S10 | `precognitive-host.ts` 385-391 already builds a Markov model from `transitions` arrays **and** from single events with `event:"APP_TRANSITION"` and top-level `from`/`to`. It skips entries whose `from` or `to` is not a string. | V |
| S11 | Proximity, light and gravity/accel listeners are started in `PiecesAccessibilityService.onServiceConnected` (633) with **no consent gate**. `updateMotionState` has no callers. There is no play-services dependency. | V |
| S12 | Phone outbox: `BATCH_SIZE` is 50, `MAX_OUTBOX_EVENTS` is 500 and `MAX_BATCH_BYTES` is 256 KB. Every batch is also POSTed to `/mobile/usage-report`, and the outbox purges on legacy success. | V |
| S13 | Live DB: 315 `android.usage` events, 0 with `transitions` and 0 with hardware telemetry, out of 15,022 events in total. | V |

## A. Foreground transitions

**A1. Why it "bypassed accessibility".**
- The allowlist exists to stop *screen text* leaking (S1).
- UsageStats events carry no content (S2), so no rule was ever written for them.
- A package name is still sensitive: "opened Chase at 02:10" says something.

**A2. Redaction rule (on the phone, before the outbox).**
- **Privacy exclusion.** Split `isExcluded` and add `static boolean isPrivacyExcluded(String pkg, String label)`. It checks `EXCLUDED_PREFIXES` plus `EXCLUDED_LABEL_KEYWORDS`. Keep `isExcluded` as `isPrivacyExcluded || noise`; the capture path is unchanged.
  - A privacy-excluded app is recorded as `category:"excluded"`, with no package and no label.
  - This applies to **both ends**: `from` is redacted the same way.
- **Noise prefixes** are not redacted. They map to a category: launchers → `home`, everything else → `system`. The home screen is a high-value state.
- **The allowlist is not required.**
- **Health gap (S4).** Add health and medical prefixes and keywords using the file's own convention: real ids only, checked with `adb shell pm list packages`. Examples: `com.sec.android.app.shealth`, `com.google.android.apps.fitness`, and keywords `"health"`, `"pharmacy"`, `"therapy"`, `"clinic"`, `"mychart"`. **The exact list is a user decision.**
- **Legacy route.** Apply the same redaction to the legacy summary text and its `transitions`.

**A3. Event shape.** There is one event per foreground *arrival*, not one array per window.
- **Why one per arrival:** `actionOf` returns one action per event in timestamp order, and `precognitive-host` already accepts this form unchanged (S10). This deviates from the brief's "store the array" wording.

```json
{ "event_id": "fg-<ts>-<sha1(pkg|'x')[0:8]>", "kind": "telemetry", "ts_device": <arrival ms>, "schema_ver": 1,
  "payload": { "type": "app_foreground", "event": "APP_TRANSITION",
    "to": "com.spotify.music", "category": "Audio", "app_label": "Spotify",      // all 3 omitted when excluded
    "from": "com.android.chrome", "from_category": "Uncategorized",               // from omitted when excluded/unknown
    "excluded": false, "dwell_prev_ms": 41200, "src": "usage_stats" } }
```

- **Category.** `category` comes from `categoryLabel(ApplicationInfo.category)`; make it package-visible. If excluded: `category:"excluded"`, `excluded:true`, and no `to`, `app_label` or `from`.
- **No collision with the tracker (S7).** There is no top-level `package`, so the event does not clobber other context. ContextTracker gets an explicit branch instead (WP-S1).
- **Deterministic and idempotent (S3, S6).**
  - Persist `last_arrival_ts`, `last_pkg` and `last_arrival_pkg_ts` in `usage_summary` prefs.
  - Query `(last_arrival_ts, now]` strictly, so a re-query never re-emits or alters an event.
  - The companion's own package *is* emitted as an arrival.
- **Screen sessions.** Also emit `type:"screen_session"` events (`state: interactive|non_interactive|keyguard_shown|keyguard_hidden`) from `UsageEvents` types 15-18. These need API 28+ [I]; guard them for minSdk 26.
  - This gives W3.5 its session boundaries without a broadcast receiver. That holds only if Samsung populates these types [I, device-only].
- **Cadence.**
  - `queueArrivalsIfDue` runs with a 60 s minimum gap. It hooks into the accessibility `periodicSyncRunnable` (5 min [V]), `TelemetrySyncJobService.onStartJob`, and app resume.
  - The 15-minute summary stays as it is.
- **Batching and limits.**
  - The emitter caps output at 500 arrivals per call (oldest dropped and counted).
  - `buildUsageV3Body` becomes `buildV3Body`:
    - it forwards `android.usage`, `app_foreground`, `screen_session`, `sensor_window`, `sensor_caps` and `sensor_consent`;
    - it validates each event against S5 on the phone, quarantining any that fail;
    - it chunks to ≤100 events and ≤256 KB.
  - The new types are **v3-only**: they are dropped from the legacy `/mobile/usage-report` body. A v3 2xx counts as delivered for them, and a batch containing only these types skips the legacy POST.

**A4. Daemon.**
- **Ingest.** No change, because ingest already stores payloads verbatim (S5). A round-trip test proves it (WP-S3).
- **Two prediction streams.** Without them, ordering corrupts the ledger (S8):
  - Arrivals reach the daemon up to 5 min late, while companion `screen_view`s arrive live.
  - Add `context.stream: "screen" | "app"`. Legacy rows without it count as `"screen"`.
  - `resolveWithAction(raw, device, actual, stream?)` gains the filter `COALESCE(json_extract(p.context,'$.stream'),'screen') = ?`. This is a JSON filter only, with no schema change.
  - `PredictionHost` keeps one `DeviceState` per (device, stream). The 471-row screen ledger stays comparable.
- **Late-event rule** (in core, so `--eval` replays exactly what the host did): `isLate(ev, state) = ev.ts_device < state.lastActionTs`.
  - A late action updates ContextTracker and `UsageBaseline` only. It makes no prediction, no resolution and no `engine.observe`.
  - It increments `late_skipped` in `context.model` on the next logged row.
- **`actionOf`** (core `action-of.ts`) for `app_foreground`:
  - `excluded` → `cat:excluded`
  - noise → `cat:home` or `cat:system`
  - otherwise `pkg:<to>` when that package has ≥5 arrivals in the trailing 14 d, counted in `PassiveActionState` (pre-registered k=5), and `cat:<category>` otherwise.
  - The returned label is logged as `label_rule:"k5"`.
  - The existing expert backoff handles sparsity; no new experts are added.
- **`precognitive-host`.** Skip `excluded` events; this already happens implicitly because they carry no `to` (S10). Forwarding turns on speculative pre-staging for real packages. Arrivals must be its **only** v3 carrier, because the summary's `transitions` stays legacy-only, so the Markov model does not double-count.

## B. Sensors

**B1. Capability probe.**
- `SensorCapabilities.probe(ctx)` sends `sensor_caps` (schema_ver 1) when the app starts and whenever a toggle changes. The id is `caps-<sha1(json)[0:12]>`, so identical capabilities produce the same id.
- Per sensor key it reports: `present`, `power_ma` (`Sensor.getPower()`), `fifo_max`, `wakeup` and `min_delay_us`. It also reports `perm_activity_recognition` and `toggles`.
- Availability is never assumed. Everything in the table below is **[I] until the probe reports it**.

| Key | Android source | S26U-class [I] | Permission | Collection (low-drain) | Window aggregate sent | Candidate feature |
|---|---|---|---|---|---|---|
| motion | TYPE_ACCELEROMETER | yes | none | 5 Hz, `maxReportLatencyUs` 60 s (hardware FIFO) | `energy_rms`, `energy_class` still/light/moderate/vigorous | `motion_energy` |
| rotation | TYPE_GYROSCOPE (+gravity) | yes | none | 10 s burst/min at 25 Hz | `orient` flat_up/flat_down/upright/tilted/mixed, `rot_class` | `orient` |
| steps | TYPE_STEP_COUNTER (+DETECTOR) | yes | ACTIVITY_RECOGNITION (API 29+) [I] | non-wakeup, read delta at window close | `delta`, `cadence_spm` | `steps` 0/1-50/51-300/>300 |
| sig_motion | TYPE_SIGNIFICANT_MOTION | yes | none | one-shot trigger, re-armed | `fired` | `sig_motion` |
| activity | on-device heuristic (energy+steps+sig_motion); GMS Transition API optional later | n/a | ACTIVITY_RECOGNITION | derived | `state` still/walking/running/vehicle/unknown, `conf`, `src:"heuristic"` | feeds existing `motion` |
| pressure | TYPE_PRESSURE | likely [I] | none | 1 Hz, 60 s FIFO batching | `delta_hpa`, `trend` rising/falling/steady (**no absolute hPa**) | `pressure_trend` |
| light | TYPE_LIGHT (existing) | yes | none | on-change | `bucket` dark/dim/indoor/bright/sun | `light` |
| proximity | TYPE_PROXIMITY (existing) | yes (may be virtual) | none | on-change | `near_frac` | `near` |
| ambient_temp | TYPE_AMBIENT_TEMPERATURE | **unlikely** [I] | none | on-change | `c` | existing `temp` |
| battery | battery broadcast (existing `collectBattery`) | yes | none | snapshot at window close | `pct`, `plugged`, `batt_temp_c` | existing `battery`, `charging` |
| magnetometer | TYPE_MAGNETIC_FIELD | yes | none | **not collected** (indoor-position fingerprint) | — | — |

**B2. Sampler host.**
- New `SensorWindowSampler` runs inside the accessibility service: start it from `onServiceConnected` and stop it in `onDestroy`.
- Windows are aligned to the wall-clock 5-minute grid.
- Only toggled-on sensors are registered. `NativeHardwareTelemetry.initSensors` must also respect the toggles. This is a behavior change: today prox, light and gravity run unconditionally (S11).
- **Background delivery risk.** Android 9+ withholds sensor events from background apps [I]. Whether a bound accessibility service is exempt is [I] and can only be checked on the phone.
  - Fallback: a foreground service of type `health`, which needs ACTIVITY_RECOGNITION and shows a persistent notification [I].
- **Drain budget:** under 1%/day. Measure it with `adb shell dumpsys batterystats` and `dumpsys sensorservice` (device-only).

**B3. Event.**
- `type:"sensor_window"`, schema_ver 1, `event_id: "sw-<window_end>"`.
- **`ts_device = window_end`.** A window stamped with its start would leak the future into predictions made mid-window.
- Payload: `{type, window_start, window_end, dur_ms, sensors:{<key>:{...aggregate}}}`. Only sensors that were on and present appear in it.
- **Raw streams never leave the phone.**
- **Storage:** existing `events` with `kind=telemetry`, inserts only. No new tables and no change to the hash chain or append-only tables.

**B4. Into the predictor.**
- **`PredictionContext`** (prediction-log.ts) gains `sensors?: { window_end, motion_energy?, orient?, steps_delta?, sig_motion?, pressure_trend?, light?, near_frac?, activity? }` and `stream`.
- **`ContextTracker`** gets an explicit `sensor_window` branch.
  - Accept a window only if its `window_end` is greater than the stored one, so a late older window never overwrites a newer one.
  - TTL is 10 min.
  - `activity` feeds `ctx.motion` (`updateMotionState` is finally used). `battery` feeds `device.battery_pct`/`charging` and `battery_micro.temp_c`, **never** `ambient.temp_c`.
  - `sensor_caps` is tracked per device. `missing` lists `sensors.<key>` only when the sensor is present, toggled on and stale. `EXPECTED_CONTEXT_FIELDS` is unchanged.
- **`contextFeatures`** emits the candidate keys from the table. New `CANDIDATE_FEATURE_NAMES` and `candidateExperts()` (`cur+<f>`) stay **out of** `FEATURE_NAMES`/`DEFAULT_EXPERTS`, so live behavior and checkpoints are unchanged (S9).
- **Feature admission** (pre-registered; requires W3.8 `--gate` and `--candidate <f>` from WP5):
  - A feature is promoted only after ≥4 weeks of data **and** ≥300 app-stream examples where it is present.
  - The replay `DEFAULT_EXPERTS + cur+f` vs `DEFAULT_EXPERTS` must show a paired log-loss gain with z ≥ 2.6. That is Bonferroni-corrected for about 9 candidates, one-sided α = 0.05.
  - Features are evaluated one at a time and re-checked every quarter; a feature that fails is demoted.
  - Before the first promotion, `fromJSON` must map `logW` by expert name and reset any unmatched weight to the uniform prior.
  - Everything is logged from day one.

## C. Privacy and safety

- **Inference risks.**
  - Pressure deltas, steps and motion together reveal floors climbed, transport mode and commute timing. Joined with time of day they can identify home and work.
  - Mitigations:
    - no absolute pressure, no magnetometer, no GPS;
    - 5-minute aggregates, bucketed lux;
    - v3-only, so nothing goes to the Pieces legacy route, Mem0 or the cloud;
    - transport stays LAN/Tailscale to the user's own daemon.
- **On-device only:** raw samples, labels of excluded apps, and anything the toggles disable.
- **Retention.** `events` is append-only by trigger, so **stored windows cannot be deleted**. Revocation therefore means:
  1. unregister the sensor's listeners in the same main-looper turn;
  2. delete unsent events of that type from the phone outbox;
  3. send `sensor_consent {key, enabled:false}`, after which the daemon tracker ignores later windows for that key.
  - W5's "delete the data" promise is likewise impossible under these constraints.
  - **Separate user decision:** crypto-shred, meaning per-key encryption of `sensors` payloads with the key held outside the chain.
- **Kill switch.** A master "Sensors" toggle in Setup turns everything off at once, using the same steps. Daemon env `EXO_SENSOR_CONTEXT=0` makes ContextTracker ignore `sensor_window` (it stays stored). The SHADOW kill switch (`kill-switch-drill.test.ts`) covers actuation, not ingest [V].
- **Not included** (each needs a separate user decision, and none is recommended now):
  - mic noise-level bucket (needs RECORD_AUDIO and a permanent mic indicator);
  - named-place geofence (home/work/other only);
  - camera;
  - message or keystroke content (see W5).
- **Consent copy** (Setup, per toggle): "*Motion: how much the phone moved in each 5-minute window (a number, not a recording). Stays between your phone and your PC. Off stops collection immediately; data already sent stays in your log.*" Pressure adds: "*Changes in air pressure can reveal stairs, elevators and travel.*" App switches: "*Which app you opened and when. Banking, password, authenticator and health apps are recorded only as 'excluded'.*"

## D. Work packages (Sonnet)

| WP | Scope | Owns (exclusive) | Depends |
|---|---|---|---|
| S1 | Core context | `packages/core/prediction-events.ts` + test, `prediction-log.ts` + test (`sensors`, `stream`, `resolveWithAction` stream filter) | — |
| S2 | Core actions/engine | `packages/core/action-of.ts` + test (app_foreground, k=5, `isLate`), `prob-engine.ts` + test (candidates, `fromJSON` by name), `prob-engine-checkpoint.test.ts` | S1 |
| S3 | Daemon host (absorbs old WP7) | `apps/daemon/src/prediction-host.ts` + test, `precognitive-host.ts` + test, new `v3-device-signals.test.ts`, `apps/daemon/package.json` test list | S1, S2 |
| A1 | Android arrivals + transport | `UsageSummary.java`, `NativeTelemetrySync.java` (`queueV3Event(ctx, eventId, tsDevice, payload)`, `buildV3Body`, chunking, legacy filter), `AccessibilityPlugin.java` (`isPrivacyExcluded`, health, `categoryLabel` visibility), new tests `UsageArrivalsTest`, `V3BodyTest` | — |
| A2 | Android sensors | new `SensorWindowSampler.java`, `SensorCapabilities.java`, `SensorConsentPlugin.java` (`getState`, `setToggle{key,enabled}`, `setMaster{enabled}`), `NativeHardwareTelemetry.java`, `PiecesAccessibilityService.java` (hook only), `MainActivity.java` (register), new `SensorAggregateTest` | A1 |
| M | Mobile UI | `apps/mobile/src/pages/Setup.tsx`, new `src/lib/sensorConsent.ts` + test | A2 interface (above) |

**Acceptance.**
- **S1:**
  - A late older `sensor_window` does not overwrite a newer one.
  - `sensor_window` and `app_foreground` never set `ambient.temp_c` or clobber `app.package`.
  - Stream-filtered resolve leaves screen predictions open when an app action arrives.
- **S2:**
  - The k=5 cat→pkg switch fires at exactly the 5th arrival in 14 d.
  - `cat:excluded` is returned for excluded events.
  - `isLate` is true for older timestamps.
  - A checkpoint saved with N experts loads into N+1 without NaN.
- **S3:**
  - POSTing `app_foreground`, `sensor_window` and `sensor_caps` through `server.ts` returns them from `GET /v3/events` with deep-equal payloads.
  - `dropKnownTelemetry` skips none of them.
  - A 101-event batch returns 400.
  - App-stream predictions carry `stream:"app"`, and late arrivals produce 0 predictions.
  - Precognitive pre-stages nothing for excluded events.
- **A1:**
  - Redaction removes both the package and the label for a keyword-matched label.
  - Re-running a query over the same range produces byte-identical ids and payloads.
  - Chunks stay ≤100 events and ≤256 KB.
  - Invalid events are quarantined, not 400ed.
- **A2:**
  - Pure aggregation functions (energy class, orientation class, pressure trend, lux bucket) give fixed outputs for fixed input arrays.
  - Toggle off produces 0 registered listeners, checked with a fake `SensorManager` seam.

**Verification.**
- Core: `cd packages/core && npx tsc --noEmit && npx vitest run prediction-events.test.ts prediction-log.test.ts action-of.test.ts prob-engine.test.ts prob-engine-checkpoint.test.ts`
- Daemon: `cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/v3-device-signals.test.ts src/prediction-host.test.ts src/precognitive-host.test.ts src/v3-events.test.ts src/telemetry-dedupe.test.ts`, then `pnpm test`.
- Mobile: `cd apps/mobile && npx tsc --noEmit && npx vitest run src/lib/sensorConsent.test.ts`
- Android: `cd apps/mobile/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew testDebugUnitTest`. The `java` on PATH is 1.8 [V]; I did not run this build [I].
- No run touches the live DB or the daemon.

**Phone-only checks (not testable here):**
- whether background sensor delivery works under the accessibility service;
- what the probe actually reports on the S26 Ultra;
- whether Samsung emits UsageEvents types 15-18;
- step-counter permission behavior;
- battery drain;
- whether excluded apps really disappear from a live outbox (check with `adb logcat` and a GET on `/v3/events`).

The sign-off step: install the debug APK, toggle each sensor on and off, and confirm the `sensor_consent` and `sensor_window` rows over 24 h.

## E. User decisions on sensitive capture (2026-10-29, stated directly by the user in the main thread)

These supersede the "Not included" list in section C.

| Signal | Decision | Binding constraints |
|---|---|---|
| Camera | **NO** | Never collected. |
| Microphone | **YES, speech-present only** | One boolean/fraction per window (speech detected or not, plus window length). No audio stored, no transcripts, no loudness trail. Processed on the phone. |
| Location | **YES** (user said yes earlier; no further granularity stated) | Default until the user says otherwise: places learned on the phone (stable place ids, home/work/other, arrive/depart, dwell, speed class). No raw coordinate trail is stored or sent. |
| Typed text | **YES, opt-in, with a one-gesture accessibility-shortcut kill switch** | The user's wording: "typed text is never viewed or accessible. It is parsed by Gemini Nano on device, summarized essentially, but with enough contextual strength to be helpful." Implementation reading: raw text exists only transiently in memory inside the on-device summarizer and is never written to disk, logged, shown in any UI, sent off the phone, or placed in `events`. Only a short structured summary survives (topic/intent/entity-type tags, app category, length bucket), stored encrypted on the phone with a retention limit. Password/numeric fields and denylisted apps (`AccessibilityPlugin.isExcluded`, `isPrivacyExcluded`) are never read. Kill switch is enforced inside the service before any read. What portion of the summary reaches the PC is a design item for the E-design agent; default is coarse tags only, no free text. |

Design work for these three signals is packaged separately (A3 mic, A4 location, A5 typed-text summarizer) and starts only after the E design is reviewed. Packages S1-S3, A1, A2, M do not touch audio, location or text.
