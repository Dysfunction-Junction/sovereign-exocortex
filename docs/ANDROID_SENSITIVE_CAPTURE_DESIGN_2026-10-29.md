# Android sensitive-capture design: A3 mic, A4 Wi-Fi places, A5 typed-text summarizer (2026-10-29)

This design builds on `ANDROID_SENSOR_SPEC_2026-10-29.md` §0 and §A-D, and implements the user's decisions in **§E/E2 exactly**.

- **Tags.** **[V]** means read in the repo at `7d7fcf0` or seen in read-only adb output. **[W]** means read in current Google docs (see Sources). **[I]** means inferred, and each one names its check.
- **Paths.** Android paths are relative to `apps/mobile/android/app/src/main/java/com/pieces/android/companion/`.
- **Android versions.** The docs I read cover Android 14/15. **I could not confirm any Android 16/17-specific mic, Wi-Fi or AICore change.** The app targets SDK 36 [V], so target-37 behavior changes do not apply yet.

## 0. Facts

| # | Fact | Tag |
|---|---|---|
| F1 | SM-S948U1, SDK 37, patch 2026-10-05. Google AICore `prod_aicore_20260917`; Samsung AICore `3.0.02.18`. Companion targets SDK 36 and holds `aicore.service.BIND_SERVICE` and `USE_BIOMETRIC`. | V |
| F2 | Companion appops: `RECORD_AUDIO`, `FINE_LOCATION`, `COARSE_LOCATION` and `NEARBY_WIFI_DEVICES` are all `ignore`. The manifest has no RECORD_AUDIO, location or `ACCESS_WIFI_STATE`. | V |
| F3 | **ML Kit GenAI inference runs only when the app is the top foreground app.** A foreground service gets `BACKGROUND_USE_BLOCKED`. Other limits: per-app `BUSY` quota, daily `PER_APP_BATTERY_USE_QUOTA_EXCEEDED`, a context of about 4000 tokens. The S26 Ultra is listed for nano-v3 custom prompts. The `NativeTelemetrySync` header comment says the same. | W, V |
| F4 | `build.gradle` pins `genai-prompt:1.0.0-beta1`; the current version is `beta4`. | V, W |
| F5 | On Android 14+, a `microphone` FGS started from the background throws `SecurityException`. The docs list no accessibility exemption. | W |
| F6 | AOSP binds accessibility services with `BIND_INCLUDE_CAPABILITIES` and `BIND_FOREGROUND_SERVICE_WHILE_AWAKE`, which plausibly grants while-in-use mic and location capability with the screen on. | W (flags), I (effect) |
| F7 | `classifyState` returns `handheld` whenever `isInteractive`, before any pocket test (NativeHardwareTelemetry 580-582). near = `prox<maxRange` (binary); dark = `lux<5`. | V |
| F8 | The default `TYPE_PROXIMITY` is Samsung's virtual "Palm Proximity Sensor". The physical one needs `com.samsung.permission.SSENSOR`. The light sensor is STK33F15. | V |
| F9 | The call recorder holding the mic is `com.catalinagroup.callrecorder.sgs` 2.2.289 (RECORD_AUDIO and CAPTURE_AUDIO_OUTPUT granted). `com.cube.arc.saf` 1.15.1 (the id named in E2) shows no RECORD_AUDIO. | V |
| F10 | Enabled accessibility services: Cube/catalinagroup `AnyCallListenerService` (×2), Hermes bridge, Tasker, `com.registry.coach`, `com.secondguess.app`, and the companion. | V |
| F11 | Wi-Fi: `wifi_scan_throttle_enabled=true` (6 foreground scans already throttled), `wifi_scan_always_enabled=1`, `location_mode=3`. | V |
| F12 | `getScanResults()` and `startScan()` need `ACCESS_FINE_LOCATION` on API 33+. `NEARBY_WIFI_DEVICES` does not cover them. | W |
| F13 | `onAccessibilityEvent` calls `getSource()` first. It then runs `extractText` on every non-click event from allowlisted apps and pushes the result (90-174). `extractText` reads `getText()` of **every node, editable fields included**, and skips only password fields (443-481). `typeWindowContentChanged` is subscribed. So **typed field contents already leave the phone today** when screen context is on. | V (code), I (that content-change fires while typing) |
| F14 | `EXCLUDED_PREFIXES` excludes email (Gmail, Outlook, Samsung Email), SMS, social, Messenger and Discord. **E2: email and SMS are NOT excluded for typed text.** | V |
| F15 | Installed: WhatsApp, Telegram, Samsung Health, Google Fit. Not installed: Signal, dating apps. IMEs are Gboard (default) and Honeyboard, both noise-excluded. | V |
| F16 | `accessibility_button_targets=null`. The volume-key shortcut targets ReduceBrightColors. | V |
| F17 | `ApprovalKeyPlugin` already does Keystore + `BiometricPrompt` + `CryptoObject`. `allowBackup=false`. No crash reporter dependency. | V |
| F18 | On the phone, `buildV3Body` quarantines unknown types (`V3_TYPES`, line 1240). On the daemon, `/v3/events` stores payloads verbatim. ContextTracker reads top-level `package`, `network`, `screen_state`, `temp_c` and similar from every payload (S7), so **new payloads must not use those names at top level**. | V |

**Headline.** A5 collides with F3. Typing happens in other apps, so the companion is never on top at that moment, and Nano will most likely refuse every real call. Under the user's own rule (unavailable → drop raw text), A5 would store nothing. A5's summarizer is therefore gated on spike S5-1 and decision D1 (§5.6); everything else in A5 can still be built. Mic and Wi-Fi reads probably work only *because* they run inside the bound accessibility service (F6), so the design keeps them in-process with no FGS.

## 1. Shared package SH (lands first)

SH exclusively owns every file that A3, A4 and A5 would otherwise collide on.

| File | Change |
|---|---|
| `AndroidManifest.xml` | Add `RECORD_AUDIO`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `ACCESS_WIFI_STATE`, and `<service .TypedTextTileService permission=BIND_QUICK_SETTINGS_TILE>`. Do **not** add `CHANGE_WIFI_STATE`, `NEARBY_WIFI_DEVICES` or `FOREGROUND_SERVICE_MICROPHONE`. |
| `MainActivity.java` | Register the `PlaceLabel` and `TypedText` plugins (stubs). |
| `SensorCapabilities.java` | Add `mic_speech`, `places` and `typing_rhythm` to `ALL_KEYS`, not to `SENSOR_KEYS`. `typed_text` is not a sensor key. |
| `SensorConsentPlugin.java` | Purge prefixes: `mw-`, `pw-`, `pe-`, `tw-`. `getState` adds `micPermission`, `fineLocation`, `backgroundLocation` and `typedText`. Master OFF forces `typed_text` OFF; master ON never enables it. |
| `NativeTelemetrySync.java` | Add `mic_window`, `place_window`, `place_event` and `typing_window` to `V3_TYPES`, with a **per-type payload key allowlist**: any other key quarantines the event. |
| `NativeHardwareTelemetry.java` | Extract pure `isNear`/`isDark` from `classifyState` (no behavior change). Add pure `pocketGate(near, dark, known)` → `ok`/`pocket`/`unknown`. |
| `PiecesAccessibilityService.java` | The first line of `onAccessibilityEvent`, before `getSource`, becomes `if (TypedTextCapture.intercept(this, event)) return;`. Add `start`/`stop` hooks for `MicWindowSampler`, `PlaceSampler` and `TypedTextCapture`. **`extractText` skips `isEditable()` nodes** (closes F13). |
| Stubs: `MicWindowSampler`, `PlaceSampler`, `TypedTextCapture`, `TypedTextTileService`, and the two plugins | Signatures only. The owning package takes them over. |
| `src/lib/sensorConsent.ts` + test, `Setup.tsx`, `App.tsx` | New keys and copy (§6). Mic, precise-location and "all the time" permission buttons. A typed-text section in Setup with the on/off switch and the preferred-control picker; it calls the `typedText.ts` API owned by A5. A `/typed-text` route. |
| `apps/daemon/src/v3-sensitive-signals.test.ts` (new), `package.json` test list | Round-trip each new type through `server.ts` and deep-equal it on GET. |

**SH acceptance.**
- `V3BodyTest` passes all four new types. It quarantines a `place_window` carrying `ssid`, `bssid` or `text`, and a `typing_window` carrying `text`.
- `pocketGate` returns `pocket` for near+dark and `unknown` for missing readings. Existing `classifyState` vectors are unchanged.
- An `extractText` fixture with an editable node yields no text from that node.
- Master off ⇒ `typed_text` false.

## 2. A3 Mic speech-present

**Owns:** `MicWindowSampler.java`, `SpeechVad.java`, `MicWindowSamplerTest`, `SpeechVadTest`.

**Tick (120 s, own HandlerThread).** Gates run in order. The first one that fails skips the tick and increments its counter.

| Gate | Skip reason |
|---|---|
| `mic_speech` consented and `RECORD_AUDIO` granted | `perm` |
| `PowerManager.isInteractive()` | `screen_off` |
| `AudioManager.getMode()` is not `IN_CALL` or `IN_COMMUNICATION` (call detection without the mic; existing `collectAudio` logic [V]). The tick also counts toward `call_frac`. | `in_call` |
| Pocket gate: register proximity and light for about 300 ms, take the first values, unregister, then `pocketGate`. Values are gate-only and never emitted. This does not use `classifyState` (F7) and does not depend on the proximity/light toggles. | `pocket` / `unknown` |
| `getActiveRecordingConfigurations()` shows no other non-HOTWORD client | `mic_busy` |

When every gate passes, record 5 s of `AudioRecord(MIC, 16 kHz, mono, PCM16)` and feed the frames to the VAD while streaming. `Arrays.fill(buf, 0)` runs in `finally`.
- If `AudioRecordingConfiguration.isClientSilenced()` is true or the buffer is all zeros, record `silenced`, never "no speech". The privacy mic toggle and concurrent-capture silencing both yield zeros [I].
- Nothing but counts is logged, written or sent.

**VAD: pure-Java `ezc-1`.**
- **Frame rule (30 ms frames).** A frame is speech-like when all three hold:
  - energy is ≥ 9 dB above the sample's 10th-percentile frame;
  - ZCR is between 0.02 and 0.25;
  - ≥ 55% of the energy is in 300-3400 Hz (Goertzel).
- **Sample rule.** A sample counts as speech when ≥ 20% of frames are speech-like and there are ≥ 3 runs of ≥ 90 ms (syllabic modulation).
- **Why this one.** No native code, no model, no network. It is deterministic and JVM-testable, and costs well under 1 ms per frame [I].
- **Rejected.** WebRTC VAD needs JNI, so it can't be unit-tested here. Silero needs ONNX Runtime for one bit of output.
- **Weakness.** TV and music with vocals count as speech [I]. A `Vad` interface plus the `vad` version string allow a later swap.

**Event.** One `mic_window` per 5-min grid window, sent only if at least one tick ran. `event_id "mw-<window_end>"`, `ts_device = window_end`.

```json
{ "type":"mic_window","window_start":0,"window_end":0,"dur_ms":300000,"vad":"ezc-1","sample_ms":5000,"period_ms":120000,
  "samples":2,"speech_samples":1,"speech_frac":0.5,"call_frac":0.0,
  "skipped":{"screen_off":0,"pocket":0,"unknown":0,"in_call":0,"mic_busy":0,"silenced":0,"perm":0} }
```

`speech_frac` is omitted when `samples=0`, so "didn't listen" is distinguishable from "no speech".

**Permissions and restrictions.**
- RECORD_AUDIO is requested from Setup via the existing DevicePermissions pattern [V]. A one-time grant lapses once the app is backgrounded and then reads as `perm` [I].
- There is no FGS, because a mic FGS cannot be started from the background (F5). In-service capture relies on F6 (S3-1).
- **Fallback if S3-1 fails** (user decision): a `microphone`-type FGS started from Setup while the activity is visible. That is allowed (F5), but it shows a persistent notification.
- The green mic indicator appears for every capture.

**Battery** [I]. 5/120 s is a 4.2% duty cycle. About 4 h of screen-on time gives about 120 captures, roughly 600 s of mic per day. At 20-40 mA while capturing that is about 3-7 mAh/day, under 0.15% of the battery.

**Revocation** follows the sensor pattern, all on the main looper: write the pref, `applyConsent` (stops any in-flight `AudioRecord` and zeros the buffer), purge `mw-`, queue `sensor_consent`.

| A3 acceptance (JVM; fakes for `AudioSource`, `Clock`, `Gates`, `Env`, `Log`) |
|---|
| `SpeechVad`: silence, white noise and a 1 kHz sine → false. A 4 Hz AM-modulated harmonic at f0=150 Hz → true. |
| Each failing gate → 0 `AudioSource.start` calls and the right skip counter. `in_call` → `call_frac` > 0. |
| All-zero buffer → `silenced`, not `speech_samples=0`. The buffer is all zeros after every sample, including when `read` throws. |
| Toggle off mid-capture → `stop()` is called before `applyConsent` returns. The payload's keys are within the allowlist. `Log` never receives samples. |

| A3 phone-only spike (with consent, debug APK) |
|---|
| S3-1: grant RECORD_AUDIO, put another app on top with the screen on, and check `dumpsys audio` RecordActivityMonitor shows the companion `not silenced` (plus logcat counts). |
| S3-2: during a recorded call, the `in_call` skip fires and Cube's recording is intact. With Cube idle, there is no `mic_busy`. |
| S3-3: proximity and light deliver a first value within 300 ms. The virtual palm-proximity sensor (F8) reads near in a pocket. |
| S3-4: with the mic privacy toggle off, the result is `silenced`. S3-5: run 24 h, then check `dumpsys batterystats`. |

## 3. A4 Wi-Fi place recognition

**Owns:** `PlaceSampler.java`, `PlaceModel.java` (pure), `PlaceHasher.java`, the `PlaceLabel` plugin, `src/lib/places.ts` + test, `PlaceModelTest`, `PlaceHasherTest`.

**Inputs.** No GPS, no `startScan`, and SSIDs are never stored.
- **Connected network.** `registerNetworkCallback` with `NetworkCallback(FLAG_INCLUDE_LOCATION_INFO)` (API 31+), then read `(WifiInfo) getTransportInfo()` → BSSID [I]. `getConnectionInfo` is the deprecated fallback.
  - **Placeholder trap.** Without location access the platform returns `<unknown ssid>` / `02:00:00:00:00:00` [I]. Treat these, and any locally administered BSSID (first-octet bit 0x02: hotspots, randomized), as absent. Hashing them would merge every place into one.
- **Fingerprint.** Read the cached `getScanResults()` passively; it is fed by system scans (F11) [I].
  - Keep results ≤ 3 min old.
  - Drop locally administered BSSIDs.
  - Keep the top 10 by RSSI, with RSSI bucketed to 10 dB.
- **Permissions.**
  - Precise `ACCESS_FINE_LOCATION` (F12).
  - `ACCESS_BACKGROUND_LOCATION` ("Allow all the time", granted in Settings) is probably needed unless F6 covers location (S4-1).
  - `NEARBY_WIFI_DEVICES` is not needed.

**Hashing and salt scope.**
- `id = base32(HMAC-SHA256(K, "bssid:"+bssid))[0:16]`.
- **K** is a per-install, non-exportable Keystore HMAC key created at first consent. It is never in prefs or backup.
- **Scope.** Ids are stable on this install, differ on any other device or after a reinstall, and cannot be reversed from public BSSID databases without K.
- **"Forget places"** deletes the model and K (crypto-shred). Hashed fingerprints never leave the phone.

**Clustering (`PlaceModel`).**
- **Places.** A place is a weighted set of BSSID hashes plus any connected-network hashes.
- **Matching.** A connected-hash match counts as a match; otherwise weighted Jaccard ≥ 0.35.
- **Creation.** A new place is created after 2 consecutive 5-min ticks with no match and usable input (connected, or ≥ 3 APs).
- **Upkeep.** Weights use an EMA. APs unseen for 30 days are dropped.
- **Ids are random** (`pl_` + 8 base32 characters), not hash-derived.
- **Hysteresis.** Arrive after 2 matching ticks. Depart after 2 non-matching ticks or 15 min with no input.
- **No input ⇒ `unknown`**, which reads as "unknown place" (E2).
- **Labeling.** Setup shows "You are at `pl_x` (dwell 2 h 10 m)" with Home / Work / Other / Clear buttons. No SSID is ever shown.

**Events.**
- `place_window`: `event_id "pw-<window_end>"`, `ts_device = window_end`. Payload `{type, window_start, window_end, place_id|"unknown", label: home|work|other|unlabeled|unknown, dwell_ms, conf, src: wifi_connected|wifi_scan|none}`.
- `place_event`: `event_id "pe-<ts>-<place_id>"`. Payload `{type, event: arrive|depart, place_id, label, ts}`.
- **The daemon gets only place id, label and dwell.** No hashes, AP counts, RSSI, coordinates or trail.
- A ContextTracker branch for `place` and `mic_window` is follow-up work for the S1 owner, after S1 lands.

| A4 acceptance (JVM; fakes for `WifiSource`, `Mac`, `Clock`) |
|---|
| Placeholder SSID/BSSID and locally administered BSSIDs → no fingerprint entries → `unknown`. |
| The same scan sequence and seed → the same place ids. Creating, arriving and departing each need 2 ticks. Disjoint fingerprints → 2 places. 80% overlap → a match. |
| The hasher is deterministic for a given key and differs across keys. The serialized events contain no non-allowlisted key and no MAC-shaped string. |
| Revocation purges `pw-` and `pe-`. "Forget places" removes the model and the key alias. |

| A4 phone-only spike |
|---|
| S4-1: is the BSSID readable from the service with another app on top, with precise location only and then with background location? |
| S4-2: scan-cache age with the screen on and off (`dumpsys wifi`). S4-4: the companion triggers no `startScan` (throttle counters unchanged). |
| S4-3: 3 days covering home, work and one other place, checking place stability and the `unknown` rate. |

## 4. A5 Typed-text on-device summarizer

**Owns:**
- Android: `TypedTextCapture.java`, `TypedTextPolicy.java`, `TypedTextBuffer.java`, `NanoSummarizer.java`, `SummaryGuard.java`, `SummaryStore.java`, `TypedTextTileService.java`, the `TypedText` plugin, and `res/xml/accessibility_service_config.xml`.
- Build: the `genai-prompt` bump in `build.gradle`.
- Mobile: `src/lib/typedText.ts` + test, `src/pages/TypedTextAudit.tsx`.
- JVM tests matching the Android classes.

**4.1 Pipeline.**
1. **Event delivery is controlled at the OS level.** The static XML adds only `flagRequestAccessibilityButton`. `TypedTextCapture` adds `typeViewTextChanged` at runtime via `setServiceInfo()` only while `typed_text` **or** `typing_rhythm` is on, and removes it immediately when both are off. With both off, no text events are parceled into the process at all [I, S5-3].
2. `intercept` consumes (returns true for) every `TYPE_VIEW_TEXT_CHANGED`. **Window-state and content-change events always return false**: A5 only observes them to trigger flushes, and the existing capture path keeps them.
3. Gate order, checked before any `getSource()`, `getText()` or `getBeforeText()` call:
   - If `typed_text` and `typing_rhythm` are both off, return.
   - If the keyguard is locked, drop.
   - `TypedTextPolicy.excluded(pkg, label)` → drop.
   - If only `typing_rhythm` is on, read `getAddedCount`/`getRemovedCount` only, never the text.
4. **`TypedTextPolicy` has its own list (E2) and does not reuse `isPrivacyExcluded`** (F14). It covers:
   - finance, password and authenticator prefixes and keywords;
   - health/medical: Samsung Health, Google Fit, Health Monitor, plus the keywords "health", "pharmacy", "therapy", "clinic", "mychart";
   - `com.whatsapp`, `org.telegram.messenger`, `org.thoughtcrime.securesms`;
   - dating/adult keywords ("dating", "tinder", "bumble", "hinge", "grindr", "adult");
   - all noise prefixes (IMEs).
   - Email and SMS are allowed.
   - **Open question for the user:** Messenger, Discord, social apps and the dialer are not named in E2. They stay excluded by default.
5. **Field check.** Skip a field when any of these holds:
   - `isPassword()` or a password variation [V 447-457];
   - class `NUMBER`, `PHONE` or `DATETIME`;
   - variation `EMAIL_ADDRESS`, `URI`, `PERSON_NAME` or `POSTAL_ADDRESS`;
   - hint matching `code|otp|pin|card|cvv|ssn|account`.
6. **`TypedTextBuffer`** keeps one in-memory `char[]` per (pkg, windowId, view id), holding the latest full text, ≤ 4000 chars (about 1000 tokens, F3). It flushes on 8 s idle, on focus or window change, or at 2 min.
7. **Flush.**
   - (a) Emit `typing_window` W5 counts (no words) as `tw-<window_end>` when `typing_rhythm` is on.
   - (b) Run Summarizer → `SummaryGuard` → `SummaryStore`.
   - (c) `Arrays.fill` the buffer.
   - **Honest limit:** event text and the ML Kit request are immutable `String`s that sit on the heap until GC. Keep them short-lived and never copy them.

**4.2 Hard rules.**
- Raw text exists only in the buffer and during the summarizer call.
- Catch blocks log the exception class only (the existing pattern [V]).
- Text never goes to prefs, SQLite, files, Intents, Bundles or Capacitor events.
- Summaries never go to `queueV3Event`.
- **When Nano is unavailable or fails, drop.** That covers `UNAVAILABLE`, `BACKGROUND_USE_BLOCKED`, `BUSY`, quota, a timeout over 10 s, or a guard reject. Only a reason counter is kept. Nothing is queued or retried.
- **Prompt.** Ask for JSON `{intent: enum, topics: ≤3 from a fixed list of about 30, entity_types: ⊆[person, place, org, date, money, product], summary: ≤20 words}` with the instruction "no names, numbers, addresses, emails or quotes".
- **`SummaryGuard`** runs while the input is still in memory, following `OnDeviceTriagePlugin`'s `VALID_CATEGORIES` pattern [V]. It keeps the enums but drops the summary text if:
  - the JSON or an enum is invalid;
  - the summary is over 160 chars;
  - it contains a run of 3+ digits, an email, a URL or a phone number;
  - it contains a capitalized input token that is not sentence-initial;
  - it copies a 4-word span verbatim from the input.

**4.3 Encrypted store.**
- `typed_summaries.db` runs with `PRAGMA secure_delete=ON`.
- Each row is `(id, created_at, expires_at=+7 d, app_category, wrapped_key, iv, ct)`. Times are plaintext, so the purge never decrypts.
- **Writing.** Each row gets its own AES-256-GCM key, wrapped with a Keystore **RSA-OAEP public key**, so the service encrypts without authentication.
- **Reading.** The private key is `AUTH_BIOMETRIC_STRONG` only (no device credential) and `setInvalidatedByBiometricEnrollment(true)`. It is used **per use through a `CryptoObject`** to unwrap a single per-day key-encryption key: one prompt per day of records. A timeout-based key would be opened by any strong-biometric unlock, including the lock screen [I], so it is not used. The pattern is in `ApprovalKeyPlugin` [V].
- **Purge.** On insert, at service connect and in a daily JobScheduler job: delete expired rows, then VACUUM. "Delete all" removes the rows and the key pair.
- **Audit screen (`TypedTextAudit.tsx`)** sets `FLAG_SECURE` while open. It lists date, app category, intent, topics and summary, with delete-one and delete-all, and shows the drop counters so failures are visible.

**4.4 FLAG_SECURE, clipboard and IME.**
- `FLAG_SECURE` blocks screenshots, not accessibility nodes [I].
- Android 14+ hides `accessibilityDataSensitive` views from services that are not `isAccessibilityTool` [I]. **Never set `isAccessibilityTool`.**
- A5 never reads the clipboard.
- Text is read from the focused field's node, never from the keyboard (IMEs are excluded, F15).
- Incognito fields are not reliably detectable [I]. This is disclosed in the consent copy.

**4.5 Kill switch.**
- **Mechanism.** `TypedTextGate` is a volatile flag plus a pref, independent of the sensor master except that master OFF forces it off.
- **Turning it off**, in one call:
  1. flag = false;
  2. `setServiceInfo` without `typeViewTextChanged` (unless `typing_rhythm` is on);
  3. clear every buffer;
  4. bump a generation counter so any in-flight Nano result is discarded;
  5. commit the pref.
- **Controls** (all work; the user picks the one Setup promotes):
  - **Accessibility button.** `registerAccessibilityButtonCallback(onClicked → toggle)`. The user must assign the button (F16).
  - **Quick Settings tile.** `TypedTextTileService` with state ACTIVE/INACTIVE; Setup can offer `requestAddTileService` (API 33+).
  - **In-app switch** in Setup.
- **Indicator.** The tile state, an ongoing low-importance notification "Typed-text summaries on" (POST_NOTIFICATIONS is granted [V]), and a toast on button toggles. The accessibility button itself cannot show state [I].

**4.6 Gemini Nano: honest assessment and decision D1.**
- Expect `BACKGROUND_USE_BLOCKED` whenever the typing app is on top (F3). **S5-1 confirms or refutes this first.**
- If it is confirmed, the user picks one option:
  - **(a)** drop: the default, compliant with E2, but summaries effectively never happen;
  - **(b)** hold raw text in RAM (≤10 min, ≤16 KB) and summarize when the companion is foregrounded, which stretches "transient";
  - **(c)** a bundled non-AICore model (Gemma via MediaPipe/LiteRT): not Nano, 0.5-1 GB, more battery [I];
  - **(d)** W5 only.
- The code sits behind a `Summarizer` interface, so D1 blocks nothing else.
- **D1 decided 2026-10-29: (c) bundled non-AICore model** (Gemma via MediaPipe/LiteRT). The `Summarizer` interface gets a `BundledSummarizer` implementation that runs in the accessibility service process, so it does not depend on the companion being foregrounded. Open for the build: model choice and size, battery cost, and a go/no-go phone test (S5-2) before A5 ships. S5-1 still runs to confirm the Nano limit.
- **Validation is weak by construction.** Quality can only be judged on the phone, using synthetic text the user types into a test note. The guard catches echoed digits, names and quotes, but not paraphrased sensitive meaning (for example "asked about a diagnosis").
- **What failure looks like:** generic or empty summaries, invented topics, high reject rates, `BUSY` or quota drops. All of these are visible as counters, never as silent junk.

| A5 acceptance (JVM; fakes for `A11yEventView` with read-counting accessors, `ServiceInfoSink`, `Summarizer`, `Crypto`, `Clock`, `Log`) |
|---|
| A `TEXT_CHANGED` event is consumed in every state; the legacy push sink gets 0 calls. Window and content events return false. |
| With both switches off: 0 `getSource`/`getText` calls, and `ServiceInfoSink` holds no `TYPE_VIEW_TEXT_CHANGED`. With rhythm-only: 0 `getText` calls. |
| The policy excludes WhatsApp, Telegram, Signal, Samsung Health and a "Bumble" label. It **allows** `com.google.android.gm` and `com.google.android.apps.messaging`. Password, number and OTP-hint fields are skipped. |
| The idle flush fires at exactly 8 s. The buffer is all zeros after flush and after a summarizer exception. |
| A summarizer throwing `BACKGROUND_USE_BLOCKED` → 0 inserts and the reason counter is incremented. |
| The guard rejects "Call Dana at 555-0134" and 4-word verbatim copies. It accepts "Planning a weekend trip". |
| The store purges expired rows, and rows contain no plaintext summary bytes. Delete-all removes the key alias. No `queueV3Event` payload carries `summary`, `text` or `topics`. |
| Vitest `typedText.test.ts`: toggle, preferred control, audit list and delete. |

| A5 phone-only spike |
|---|
| S5-1: `checkStatus` + `generateContent` from the service with Chrome on top, recording the error code. Repeat with the companion on top. |
| S5-2: 50 synthetic flushes, measuring latency and `BUSY`/quota behavior. |
| S5-3: `setServiceInfo` adds and removes text events live. The assigned accessibility button fires the callback rather than toggling the service (Samsung). The tile works. |
| S5-4: biometric unwrap works and survives a reboot. A new fingerprint enrollment invalidates the key. |
| S5-5: after a session, `adb logcat` and `run-as … ls databases shared_prefs files` show no raw text. |

## 5. Privacy and threat note

- **Mic.** The risk is a bug that keeps or sends audio. Mitigations:
  - the mic classes contain no file or network API (enforced in review);
  - the buffer is zeroed;
  - only counts leave the class;
  - the OS indicator makes every capture visible.
  - Speech + place reveals meetings. That is intended, and it stays on the LAN/Tailscale path to the user's daemon.
- **Places.**
  - Hashes are linkable only with the on-phone key.
  - The daemon sees random ids, labels and dwell. That still reveals home and work schedules, and the stored log is append-only (spec §C). Revocation and Forget places limit future exposure only.
- **Typed text** is the highest risk.
  - Raw text sits in process memory during buffering, and a heap dump or compromised process could read it. Use **release builds only** for real use.
  - Summaries are encrypted, open only with strong biometrics (no PIN fallback), and never leave the phone.
  - Someone holding the unlocked phone and the user's fingerprint can read up to 7 days of summaries.
  - Six other enabled accessibility services, including Cube, Tasker and Hermes (F10), can already see the same text. A5 adds no new exposure there.
- **SH closes an existing leak** (F13): editable-field text in today's screen-context push.

## 6. Consent copy (Setup)

- **Mic (`mic_speech`):** "*Listens for 5 seconds every 2 minutes, only while your screen is on and the phone is not in a pocket, to tell whether someone is speaking (yes/no). No audio is saved or sent and nothing is transcribed. Calls are detected from the phone's call state, not the mic. You will see the mic indicator each time. Off stops it immediately; data already sent stays in your log.*"
- **Places (`places`):** "*Recognizes places you return to from nearby Wi-Fi, never GPS. Network names are never stored; networks become scrambled ids that work on this phone only. Your PC receives only a place id, your label (home/work/other) and how long you stayed. Needs precise location permission to read Wi-Fi. Off stops it immediately; 'Forget places' erases what the phone learned.*"
- **Typing rhythm (`typing_rhythm`):** "*How much and how fast you type in each 5-minute window: counts only, never letters or words. Stays between your phone and your PC.*"
- **Typed-text summaries (`typed_text`):** "*Text you type, except in excluded apps (banking, passwords, authenticators, health, Signal, Telegram, WhatsApp, dating), is summarized on this phone by Gemini Nano into a short note. The text itself is never saved, shown or sent. Notes stay on this phone, encrypted, for 7 days, and open only with your fingerprint. Email and text messages are included. Incognito browser tabs may not be detected. Turn it off instantly with the Accessibility button or the Quick Settings tile.*"

## 7. Order, merge hazards, commands

**Order.** SH first. Then A4 and A3 in parallel. Then A5: its summarizer waits on S5-1 and D1, while its policy, buffer, kill switch, store and W5 can land earlier.

**Merge hazards.**
- **Exclusive shared files.** Only SH edits manifest, `MainActivity`, `ALL_KEYS`, purge map, `V3_TYPES`/allowlist, service hooks, `extractText`, `sensorConsent.ts`, `Setup.tsx`, `App.tsx`. Only A5 edits the accessibility config.
- **Consent prefs.** All new keys share the `sensor_consent_prefs` file, and `master` semantics must not change.
- **Gradle.** The beta1→beta4 bump can break `OnDeviceTriagePlugin` [I], and A5 must keep it compiling. `--offline` fails if beta4 is not cached [I].

**Commands** (not run here [I]):
- Android: `cd apps/mobile/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew --offline testDebugUnitTest`
- Daemon: `cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/v3-sensitive-signals.test.ts src/v3-events.test.ts`
- Mobile: `cd apps/mobile && npx tsc --noEmit && npx vitest run src/lib/sensorConsent.test.ts src/lib/places.test.ts src/lib/typedText.test.ts`

No run touches the live DB, the daemon process or the phone.

**Sign-off** (with consent): install the debug APK and run S3-1…S3-5, S4-1…S4-4 and S5-1…S5-5. Then confirm 24 h of `mic_window`, `place_window` and `typing_window` rows, and **zero** summary or text keys, via `GET /v3/events`.

## Sources

- [ML Kit GenAI overview (foreground-only, quotas, devices)](https://developers.google.com/ml-kit/genai)
- [Prompt API get started (beta4, ~4000 tokens, errors)](https://developers.google.com/ml-kit/genai/prompt/android/get-started)
- [FGS background-start and while-in-use restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Wi-Fi permissions](https://developer.android.com/develop/connectivity/wifi/wifi-permissions)
- [AOSP AccessibilityServiceConnection (bind flags)](https://android.googlesource.com/platform/frameworks/base/+/master/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)
