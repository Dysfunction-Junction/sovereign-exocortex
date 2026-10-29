# Android sensitive-capture design: A3 mic, A4 Wi-Fi places, A5 typed-text summarizer (2026-10-29)

This document builds on `ANDROID_SENSOR_SPEC_2026-10-29.md` (sections 0, A-D) and implements the user decisions in **E and E2 exactly as recorded there**.
- **Tags.** **[V]** = verified, either read in the repo at `7d7fcf0` or seen in read-only adb output. **[W]** = read in current Google docs (see Sources). **[I]** = inferred; each one says what to check.
- **Paths.** Android paths are relative to `apps/mobile/android/app/src/main/java/com/pieces/android/companion/`.
- **Android versions.** The docs I read cover Android 14 and 15. **I could not confirm any Android 16 or 17 specific change** for the mic, Wi-Fi or AICore. The app targets SDK 36 [V], so any target-37 changes do not apply yet.

## 0. Facts this design depends on

| # | Fact | Tag |
|---|---|---|
| F1 | Phone facts: SM-S948U1, SDK 37, security patch 2026-10-05. Google AICore `prod_aicore_20260917` (updated 2026-10-09). Samsung AICore `3.0.02.18`. The companion targets SDK 36 and holds `aicore.service.BIND_SERVICE` and `USE_BIOMETRIC`. | V |
| F2 | The companion has no mic or location access: appops shows `RECORD_AUDIO: ignore`, `FINE_LOCATION: ignore`, `COARSE_LOCATION: ignore`, `NEARBY_WIFI_DEVICES: ignore`. The manifest declares no RECORD_AUDIO, location or `ACCESS_WIFI_STATE`. | V |
| F3 | **ML Kit GenAI inference runs only when the app is the top foreground app.** A foreground service gets `BACKGROUND_USE_BLOCKED`. There is a per-app quota (`BUSY`), a daily battery quota (`PER_APP_BATTERY_USE_QUOTA_EXCEEDED`), and a context limit of about 4000 tokens. The S26 Ultra is listed for nano-v3 custom prompts. The `NativeTelemetrySync` header comment says the same about the foreground rule. | W + V |
| F4 | `build.gradle` pins `genai-prompt:1.0.0-beta1`. The docs show `1.0.0-beta4`. | V / W |
| F5 | Since Android 14, a `microphone` FGS started from the background throws `SecurityException`. The docs list **no** accessibility-service exemption. | W |
| F6 | AOSP binds accessibility services with `BIND_INCLUDE_CAPABILITIES` (plus `BIND_FOREGROUND_SERVICE_WHILE_AWAKE`). That plausibly gives the service process while-in-use mic and location capability while the screen is on. | W (source flags) / I (effect) |
| F7 | `classifyState` returns `handheld` whenever `isInteractive` is true, before any pocket test (NativeHardwareTelemetry 580-582). Its near/dark predicates are `proxVal<maxRange` (binary sensor) and `lux<5`. | V |
| F8 | The default `TYPE_PROXIMITY` is Samsung's "Palm Proximity Sensor" (virtual). The physical one needs `com.samsung.permission.SSENSOR`. The light sensor is STK33F15. | V |
| F9 | Cube ACR's recorder is `com.catalinagroup.callrecorder.sgs` 2.2.289. It holds `RECORD_AUDIO` and `CAPTURE_AUDIO_OUTPUT`, and its `AnyCallListenerService` accessibility service is enabled. `com.cube.arc.saf` 1.15.1 (the id named in E2) shows no RECORD_AUDIO. | V |
| F10 | Wi-Fi: `wifi_scan_throttle_enabled=true` with 6 foreground-app scans throttled. `wifi_scan_always_enabled=1`. `location_mode=3`. | V |
| F11 | `getScanResults()` and `startScan()` need `ACCESS_FINE_LOCATION` even on API 33+. `NEARBY_WIFI_DEVICES` does not cover them. | W |
| F12 | `onAccessibilityEvent` calls `event.getSource()` first, then runs `extractText` on every non-click event from allowlisted apps and pushes the result (lines 90-174). The a11y config lacks `typeViewTextChanged` and any `isAccessibilityTool`. | V |
| F13 | The current `EXCLUDED_PREFIXES` already exclude email (Gmail, Outlook, Samsung Email), SMS (Google/Samsung Messages), social apps, Messenger and Discord. **E2 says email and SMS must NOT be excluded for typed text.** | V |
| F14 | Installed apps relevant to exclusions: WhatsApp, Telegram, Samsung Health and Google Fit. Signal and dating apps are not installed. The IMEs are Gboard (default) and Honeyboard, both noise-excluded. | V |
| F15 | `accessibility_button_targets=null`. The volume-key shortcut targets ReduceBrightColors. | V |
| F16 | `ApprovalKeyPlugin` already implements Keystore + `BiometricPrompt` + `CryptoObject`. `allowBackup=false`. There is no crash reporter in `build.gradle`. | V |
| F17 | On the phone, `buildV3Body` quarantines unknown `type`s (`V3_TYPES`, NativeTelemetrySync 1240). On the daemon, `/v3/events` stores payloads verbatim (S5). ContextTracker reads top-level `package`, `network`, `screen_state`, `temp_c` and similar fields from every payload (S7), so **new payloads must never use those names at top level**. | V |

## 1. Headline findings

1. **A5 conflicts with a platform rule (F3).** Typing happens in other apps, so the companion is never the top app at that moment. Gemini Nano will most likely return `BACKGROUND_USE_BLOCKED` for essentially every real event.
   - Under the user's own rule (Nano unavailable → drop, never queue raw text), A5 would then store nothing.
   - A5 is therefore **gated on spike S5-1** and on a **user decision D1** (section 5.6). Everything except the summarizer can still be built.
2. **Mic and location probably work only *because* the code runs inside the bound accessibility service (F6).** The design keeps capture in-process there and does not use an FGS, which cannot start from the background (F5). This is spike S3-1 / S4-1.
3. **Enabling `typeViewTextChanged` would send typed text down the existing screen-capture push (F12).** A5 must intercept those events first.

## 2. Shared package SH (lands first; owns every file A3/A4/A5 would otherwise collide on)

| Owns (exclusive) | Change |
|---|---|
| `AndroidManifest.xml` | Add `RECORD_AUDIO`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION` and `ACCESS_WIFI_STATE`. Add the `<service .TypedTextTileService permission=BIND_QUICK_SETTINGS_TILE>` declaration. **No** `CHANGE_WIFI_STATE`, `NEARBY_WIFI_DEVICES` or `FOREGROUND_SERVICE_MICROPHONE`. |
| `SensorCapabilities.java` | Keys `mic_speech`, `places` and `typing_rhythm` go into `ALL_KEYS` but **not** `SENSOR_KEYS`. `typed_text` is not a sensor key (section 5.5). |
| `SensorConsentPlugin.java` | Purge prefixes are `mw-` (mic), `pw-` and `pe-` (places), `tw-` (typing). `getState` adds `micPermission`, `fineLocation`, `backgroundLocation` and `typedText`. Master OFF also forces `typed_text` OFF; master ON never turns it on. |
| `NativeTelemetrySync.java` | Adds `mic_window`, `place_window`, `place_event` and `typing_window` to `V3_TYPES`. Adds a payload key allowlist per new type: any key outside it quarantines the event. |
| `NativeHardwareTelemetry.java` | Extract pure `isNear(prox,maxRange)` and `isDark(lux)` from `classifyState` without changing its behavior. Add a pure `pocketGate(isNear,isDark,known)` returning `ok`, `pocket` or `unknown`. |
| `PiecesAccessibilityService.java` | Hooks only. The first line of `onAccessibilityEvent` (before `getSource`) becomes `if (TypedTextCapture.intercept(this, event)) return;`. `onServiceConnected` and `onDestroy` call `MicWindowSampler`, `PlaceSampler` and `TypedTextCapture` `start`/`stop`. |
| Stub classes `MicWindowSampler`, `PlaceSampler`, `TypedTextCapture`, `TypedTextTileService` | Signatures only. Each package takes over its stub. |
| `apps/mobile/src/lib/sensorConsent.ts` + test, `Setup.tsx` | New keys and their copy (section 7). Permission buttons for mic, precise location and "Allow all the time". One link to the A5 audit screen. |
| `apps/daemon/src/v3-sensitive-signals.test.ts` (new) + `package.json` test list | Round-trip each new type through `server.ts`, deep-equal on `GET`. |

**SH acceptance:**
- `V3BodyTest` passes `mic_window`, `place_window`, `place_event` and `typing_window`, and quarantines a `place_window` that carries `ssid`, `bssid` or `text`.
- `pocketGate(true, true, true) == pocket`. Unknown readings give `unknown`.
- `classifyState` outputs are unchanged on the existing test vectors.
- Master off gives `typed_text=false`.

## 3. A3 Mic speech-present

**Owns:** `MicWindowSampler.java`, new `SpeechVad.java`, and tests `MicWindowSamplerTest` and `SpeechVadTest`.

**3.1 Schedule and gates.** The scheduler runs on a `HandlerThread` with a 120 s tick (main looper only for consent). Each tick evaluates the gates in this order, and the first failure skips the tick and counts the reason:
1. `mic_speech` is consented and `RECORD_AUDIO` is granted. Otherwise the reason is `perm`.
2. `PowerManager.isInteractive()`. Otherwise `screen_off`.
3. `AudioManager.getMode()` is not `IN_CALL` or `IN_COMMUNICATION`. Otherwise `in_call`, and the tick counts toward `call_frac`. This is how calls are detected without the mic; the logic already exists in `collectAudio` [V].
4. **Pocket gate.** Register proximity and light for about 300 ms, take the first value of each, unregister, then apply `pocketGate`. These readings are used only for the gate and are never emitted.
   - On-change sensors normally deliver their current value on registration [I, S3-3].
   - `unknown` and `pocket` both skip.
   - This deliberately does not use `classifyState`, because it returns `handheld` whenever the screen is on (F7).
   - It also does not make the mic depend on the proximity and light toggles.
5. `AudioManager.getActiveRecordingConfigurations()` shows no other active non-`HOTWORD` client. Otherwise `mic_busy`. Assistant `HOTWORD` and `VOICE_RECOGNITION` captures are visible in `RecordActivityMonitor` [V].

If every gate passes, the tick records 5 s of `AudioRecord(MIC, 16 kHz, mono, PCM16)`. The frames are fed to the VAD while recording, and the buffer is zeroed with `Arrays.fill(buf, 0)` in `finally`.
- If `AudioRecordingConfiguration.isClientSilenced()` is true (API 29+) or the buffer is all zeros, the reason is `silenced`, never "no speech". The privacy mic toggle and concurrent-capture silencing both produce zeros [I].
- **Nothing is written, logged or sent except the counts.**

**3.2 VAD choice: pure-Java `ezc-1`** (energy + zero-crossing + band ratio).
- 30 ms frames. A frame is speech-like when all three hold:
  - energy is ≥ 9 dB above the 10th-percentile frame energy of the sample;
  - ZCR is between 0.02 and 0.25;
  - ≥ 55% of the energy falls in the 300-3400 Hz band (Goertzel bins).
- A sample counts as speech when ≥ 20% of its frames are speech-like **and** there are ≥ 3 runs of ≥ 90 ms, which requires syllabic modulation.
- **Why this one:**
  - It needs no native library and no model download, and it never touches the network.
  - It is deterministic and testable on the JVM.
  - It costs well under 1 ms CPU per frame [I].
- **Rejected alternatives:**
  - WebRTC VAD (`android-vad`) needs JNI and cannot be unit-tested here.
  - Silero needs ONNX Runtime (MBs) for one yes/no answer.
- **Known weakness:** TV, podcasts and music with vocals read as speech [I]. The `Vad` interface plus the `vad` version string allow a later swap without breaking the event schema.

**3.3 Event.**
- One event per 5-minute grid window, sent only if ≥ 1 tick ran.
- `event_id = "mw-<window_end>"`, `ts_device = window_end`.

```json
{ "type":"mic_window", "window_start":0, "window_end":0, "dur_ms":300000, "vad":"ezc-1", "sample_ms":5000, "period_ms":120000,
  "samples":2, "speech_samples":1, "speech_frac":0.5, "call_frac":0.0,
  "skipped":{"screen_off":0,"pocket":0,"unknown":0,"in_call":0,"mic_busy":0,"silenced":0,"perm":0} }
```

`speech_frac` is omitted when `samples == 0`. This lets the daemon tell "no speech" apart from "didn't listen".

**3.4 Permissions and Android restrictions.**
- `RECORD_AUDIO` is requested from the Setup activity. The existing pattern is `devicePermissions.ts` and DevicePermissionsPlugin [V].
- A one-time ("Only this time") grant lapses when the app leaves the foreground, and is then treated as `perm` [I].
- No FGS: a mic FGS cannot be started from the background (F5). In-service capture relies on F6 [I, S3-1].
- **Fallback if S3-1 fails:** start a `foregroundServiceType="microphone"` FGS from Setup while the activity is visible. That is allowed (F5), but it shows a persistent notification and dies when the process is killed. This fallback is a user decision.
- The privacy indicator (green mic dot) will appear for each 5 s capture, about every 2 minutes. The consent copy says so.

**3.5 Battery.**
- Duty cycle: 5/120 = 4.2%.
- Captures per day: with about 4 h of screen-on time and the gates passing, about 120.
- Mic time per day: about 600 s.
- Drain: at 20-40 mA during capture [I], about 3-7 mAh/day, which is under 0.15% of a 5000 mAh pack. The scheduler adds negligible drain. Measure with `dumpsys batterystats`.

**3.6 Revocation.** Use the existing sensor pattern: on the main looper, write the pref, call `MicWindowSampler.applyConsent` (which stops any in-flight `AudioRecord` and zeroes the buffer), purge `mw-`, and queue `sensor_consent`.

**3.7 Acceptance (JVM, fake `AudioSource`, `Clock`, `Gates` and `Env` seams):**
- **`SpeechVad` fixtures:**
  - silence gives false;
  - white noise gives false;
  - a 1 kHz sine gives false;
  - a synthetic 4 Hz AM-modulated harmonic signal (f0 = 150 Hz) gives true.
- **Gates:** each one, when it fails, produces 0 `AudioSource.start` calls and the correct skip counter. `in_call` ticks increment `call_frac`.
- **Silencing:** an all-zero buffer gives `silenced`, not `speech_samples=0`.
- **Buffer hygiene:** after every sample, the source buffer handed to the fake is all zeros, including when `read` throws.
- **Revocation:** toggling off mid-capture produces a `stop()` call before `applyConsent` returns.
- **Payload keys** are a subset of the SH allowlist, and nothing above is logged (a fake `Log` seam receives no calls containing samples).

**3.8 Phone-only checks and spike (requires user consent, debug APK).**
- **S3-1 (mic capability):** grant RECORD_AUDIO and open another app with the screen on. Watch `adb logcat -s MicWindowSampler` (counts only) and `dumpsys audio` → `RecordActivityMonitor` for `pack:com.pieces.android.companion ... not silenced`.
- **S3-2 (Cube ACR contention):** during a recorded call, confirm the `in_call` skip fires and Cube's recording is intact. Then, with Cube idle, confirm no `mic_busy`.
- **S3-3 (pocket gate):** check both sensors return a first value within 300 ms, and that the virtual palm-proximity sensor (F8) reads "near" in a pocket.
- **S3-4 (privacy toggle):** with the mic quick-setting off, the result must be `silenced`.
- **S3-5 (drain):** run 24 h, then check `dumpsys batterystats`.

## 4. A4 Wi-Fi place recognition

**Owns:** `PlaceSampler.java`, new `PlaceModel.java` (pure clustering), new `PlaceHasher.java`, the `PlaceLabel` Capacitor plugin with `places.ts` and its test, and tests `PlaceModelTest` and `PlaceHasherTest`.

**4.1 Inputs. No GPS, no scans, no SSIDs ever stored.**
- **Connected network.** Use `ConnectivityManager.registerNetworkCallback` with `NetworkCallback(FLAG_INCLUDE_LOCATION_INFO)` (API 31+), then `(WifiInfo) caps.getTransportInfo()` to read the BSSID [W/I]. `getConnectionInfo` is a deprecated fallback.
  - **Redaction trap:** without location access the platform returns `<unknown ssid>` and `02:00:00:00:00:00` [I]. These placeholders and any locally administered BSSID (bit 0x02 of the first octet: hotspots, randomized) are treated as **absent**. Hashing them would merge every place into one.
- **Nearby fingerprint.** Read the cached `WifiManager.getScanResults()` passively. **Never call `startScan`** (throttled, F10). The system's own scans feed the cache [I].
  - Keep results at most 3 min old (`ScanResult.timestamp`).
  - Drop locally administered BSSIDs.
  - Keep the 10 strongest, with RSSI bucketed to 10 dB.
- **Permissions:**
  - `ACCESS_FINE_LOCATION` (precise) is needed for both inputs (F11).
  - `ACCESS_BACKGROUND_LOCATION` ("Allow all the time", granted in Settings) is likely needed for reads while the app is not visible, unless F6 grants foreground-location capability [I, S4-1].
  - Location services must be on (they are, F10).
  - `NEARBY_WIFI_DEVICES` is not needed.

**4.2 Hashing and salt scope.**
- `id = base32(HMAC-SHA256(K, "bssid:"+bssid))[0:16]`.
- `K` is a per-install, non-exportable Keystore HMAC key, generated on first consent. It never leaves the Keystore, so it is never in prefs or backups (`allowBackup=false`, F16).
- **Scope:**
  - Ids are stable on this install.
  - The same router hashes differently on any other device or reinstall.
  - Public BSSID databases cannot reverse an id without `K`.
- Uninstalling, or "Forget places", deletes `K`. All stored fingerprints then become unlinkable (crypto-shred).
- Hashed fingerprints stay **on the phone**.

**4.3 On-phone clustering (`PlaceModel`, pure).**
- A place is a weighted set of hashed BSSIDs plus optional connected-network hashes.
- **Match score:**
  - a connected-hash match scores 1.0;
  - otherwise use weighted Jaccard over the fingerprint, and a score ≥ 0.35 is a match.
- **New place:** created after 2 consecutive 5-min ticks with no match **and** a usable input (connected network or ≥ 3 APs).
- **Weights** are updated with exponential moving averages, and APs not seen in 30 days are dropped.
- **Ids** are random (`pl_` + 8 random base32 characters), not derived from hashes, so the daemon learns nothing joinable.
- **Arrive and depart** use hysteresis: 2 consecutive matching ticks to arrive, 2 non-matching or 15 min without input to depart.
- **No usable input gives `unknown`.** Uncovered places read as "unknown place", per E2.
- **Labeling:** Setup shows "You are at: place `pl_x` (dwell 2 h 10 m)" with Home, Work, Other and Clear. The user labels the place they are in now, no SSID is ever shown, and labels stay on the phone except for the label word itself.

**4.4 Events (through `queueV3Event`).**
- **`place_window`:**
  - `event_id "pw-<window_end>"`, `ts_device = window_end`;
  - payload `{type, window_start, window_end, place_id|"unknown", label: home|work|other|unlabeled|unknown, dwell_ms, conf, src: wifi_connected|wifi_scan|none}`.
- **`place_event`:** `event_id "pe-<ts>-<place_id>"`, payload `{type, event: arrive|depart, place_id, label, ts}`.
- **What the daemon gets:** a place id, label and dwell only. No hashes, no AP counts, no RSSI, no coordinates and no trail.
- A follow-up ContextTracker branch in `prediction-events.ts` for `place`, and `in_meeting` from `mic_window`, belongs to the S1 owner after S1 lands. It is not in A3, A4 or A5.

**4.5 Acceptance (JVM, fake `WifiSource`, fake `Mac`):**
- The placeholder SSID/BSSID and locally administered BSSIDs produce no fingerprint entries, giving `unknown`.
- The same scan sequence produces the same place ids for the same seed.
- 2 ticks are needed to create, arrive or depart.
- Two disjoint fingerprints produce two places; an 80%-overlap fingerprint matches the existing one.
- The hasher is deterministic under the same key and differs under a different key.
- The serialized `place_window` and `place_event` contain no key outside the allowlist, and no 12-hex-digit or `:`-separated MAC string.
- Revocation purges `pw-` and `pe-`; "Forget places" deletes the model and the key.

**4.6 Phone-only checks and spike.**
- **S4-1:** with precise location granted but *not* "all the time", is the BSSID readable from the service while another app is on top? Repeat with background location granted.
- **S4-2:** how old is the scan cache in practice with the screen on and off (`dumpsys wifi` scan timestamps)?
- **S4-3:** place stability over 3 days at home, work and one other place, and that the `unknown` rate is acceptable.
- **S4-4:** no `startScan` from the companion (`dumpsys wifi` throttle counters unchanged).

## 5. A5 Typed-text on-device summarizer

**Owns:**
- `TypedTextCapture.java`, new `TypedTextPolicy.java`, `TypedTextBuffer.java`, `NanoSummarizer.java`, `SummaryStore.java`, `TypedTextTileService.java` and the `TypedText` Capacitor plugin;
- `res/xml/accessibility_service_config.xml`;
- `apps/mobile/src/lib/typedText.ts` and its test, and `src/pages/TypedTextAudit.tsx`;
- the `genai-prompt` version bump in `build.gradle`;
- tests `TypedTextPolicyTest`, `TypedTextBufferTest`, `SummaryGuardTest`, `SummaryStoreTest` and `TypedTextCaptureTest`.

**5.1 Pipeline (hard ordering inside `intercept`).**
1. For an event type other than `TYPE_VIEW_TEXT_CHANGED` or focus/window changes relevant to flushing, return false (the existing path proceeds).
2. **`TYPE_VIEW_TEXT_CHANGED` always returns true (consumed)**, so typed text never reaches `extractText` or the push (F12).
3. **Kill switch:** read the `volatile boolean enabled`. If it is off, return before calling `getSource()`, `getText()` or `getBeforeText()`.
4. `KeyguardManager.isKeyguardLocked()` → drop.
5. `TypedTextPolicy.excluded(pkg, label)` → drop. The policy has its **own list**, per E2:
   - finance, password-manager and authenticator prefixes and keywords;
   - health/medical (Samsung Health, Google Fit, Health Monitor, and the "health", "pharmacy", "therapy", "clinic" and "mychart" keywords);
   - private messengers (`com.whatsapp`, `org.telegram.messenger`, `org.thoughtcrime.securesms`);
   - adult/dating keywords ("dating", "tinder", "bumble", "hinge", "grindr", "adult");
   - all noise prefixes, including the IMEs.
   - It must **not** reuse `isPrivacyExcluded`, which would wrongly exclude email and SMS (F13).
   - **Open user question:** Messenger, Discord, social apps and the dialer are currently privacy-excluded but are not named in E2. They stay excluded by default until the user says otherwise.
6. **Field check on the source node:**
   - skip `isPassword()` and the existing password `inputType` variations [V 447-457];
   - skip classes `NUMBER`, `PHONE` and `DATETIME`, and variations `EMAIL_ADDRESS`, `URI`, `PERSON_NAME` and `POSTAL_ADDRESS`;
   - skip any hint matching `code|otp|pin|card|cvv|ssn|account`.
7. **`TypedTextBuffer`:** one in-memory buffer per (pkg, windowId, view id), holding the latest full text (≤ 4000 chars, about 1000 tokens, under F3's limit).
   - Flush after 8 s idle, on focus or window change, or at 2 min.
   - It also counts W5 aggregates (added and removed counts from the event).
8. **Flush:**
   - (a) Compute the W5 `typing_window` counts. No words. These go to v3 as `tw-<window_end>`, gated by `typing_rhythm`.
   - (b) Call `NanoSummarizer` → `SummaryGuard` → `SummaryStore`.
   - (c) Wipe the buffer: `char[]` storage plus `Arrays.fill`, then drop references.
   - **Honest limit:** `AccessibilityEvent` text and the ML Kit request are Java `String`s that cannot be zeroed. They live on the heap until GC. Keep their lifetime short and never copy them elsewhere.

**5.2 Hard rules (each needs a test).**
- Raw text exists only in `TypedTextBuffer` and for the duration of the summarizer call.
- No `Log.*` with text: catch blocks log `getClass().getSimpleName()` only, which is the existing pattern [V]. Test it with a fake `Log` seam.
- Raw text is never written to SharedPreferences, SQLite, files, Bundles, Intents or Capacitor events.
- Summaries never go to `queueV3Event`. `typing_window` has no text keys, enforced by the SH allowlist.
- **Nano unavailable or failing** (`UNAVAILABLE`, `BACKGROUND_USE_BLOCKED`, `BUSY`, quota, timeout > 10 s, guard reject) → **drop**. Record a counter (`dropped_by_reason`) that the audit screen shows. There is no queueing and no retry with the raw text.
- **Prompt:**
  - Ask for JSON `{intent: enum[message, reply, search, note, form, compose_email, other], topics: ≤3 from a fixed list of about 30, entity_types: subset of [person, place, org, date, money, product], summary: ≤ 20 words}`.
  - Instruct it: "Do not include names, numbers, addresses, emails or quotes."
- **`SummaryGuard`** runs while the input is still in memory. It rejects the summary text (keeping only the enums) if:
  - the JSON does not parse or an enum is invalid;
  - the summary is over 160 characters;
  - it contains any run of 3 or more digits, an email, a URL or a phone pattern;
  - it contains any input token that is capitalized and not sentence-initial (a proper-noun proxy);
  - it contains any 4-word span copied verbatim from the input.
  - This follows `OnDeviceTriagePlugin`'s `VALID_CATEGORIES` hallucination guard [V].

**5.3 Encrypted store (`SummaryStore`).**
- The SQLite file `typed_summaries.db` is opened with `PRAGMA secure_delete=ON`.
- Each row is `(id, created_at, expires_at = created_at + 7 d, app_category, wrapped_key, iv, ct)`. Timestamps stay plaintext so the purge never needs to decrypt.
- **Encryption:**
  - each record gets a random AES-256-GCM key;
  - that key is wrapped with a Keystore **RSA-OAEP public key**, so the service can encrypt with no authentication;
  - the private key has `setUserAuthenticationParameters(30 s, AUTH_BIOMETRIC_STRONG)` and `setInvalidatedByBiometricEnrollment(true)`.
- Biometrics are therefore a **cryptographic** gate, not just a UI gate.
- **Purge** runs on every insert, on `onServiceConnected` and in a daily `JobScheduler` job: delete expired rows, then `VACUUM` daily.
- "Delete all" deletes the rows **and** the key pair (crypto-shred).
- **Audit screen (`TypedTextAudit.tsx`):**
  - `BiometricPrompt` first, then the plugin decrypts within the 30 s window.
  - It sets `FLAG_SECURE` on the activity window while open.
  - It lists date, app category, intent, topics and summary, with delete-one and delete-all buttons.
  - It shows drop counters, so failure is visible.

**5.4 FLAG_SECURE, clipboard and IME.**
- `FLAG_SECURE` blocks screenshots, not accessibility nodes [I]. Android 14+ `accessibilityDataSensitive` views are hidden from services that are not `isAccessibilityTool` [I].
  - **Do not** add `isAccessibilityTool`; keeping it off preserves that protection.
- A5 never reads the clipboard. The existing clipboard listener is screen-context and is unchanged.
- Text is read from the focused field's node, never from the keyboard. IMEs are noise-excluded (F14).
- Incognito browser fields are not reliably detectable [I]. This is a known gap and goes in the consent copy.

**5.5 Kill switch.**
- **State:** `TypedTextGate`, a single in-memory volatile flag mirrored to prefs. It is separate from the sensor master, but master OFF forces it off (SH).
- **Controls (all three always work; Setup lets the user choose which one to set up and promote):**
  - **Accessibility button:** `flagRequestAccessibilityButton` in the config, and `getAccessibilityButtonController().registerAccessibilityButtonCallback(onClicked → toggle)`. The user must assign the button in Settings (F15). Setup links there.
  - **Quick Settings tile:** `TypedTextTileService` with `Tile.STATE_ACTIVE`/`INACTIVE` and the label "Typed text". Setup offers `StatusBarManager.requestAddTileService` (API 33+).
  - **In-app switch** in Setup.
- **Turning it off:** in one call, set the flag false, clear every buffer, bump a generation counter so any in-flight Nano result is discarded, then commit the pref.
- **State indicator:** the tile state, a low-importance ongoing notification "Typed-text summaries on" while enabled (POST_NOTIFICATIONS is granted [V]), and a toast on button toggle. The accessibility button cannot show state [I].

**5.6 Gemini Nano: honest assessment and decision D1.**
- Expect `BACKGROUND_USE_BLOCKED` from the service whenever the typing app is on top (F3). **Spike S5-1 must confirm this first.**
- If it is confirmed, the user chooses one of:
  - **(a) Drop** (default; it complies with E2, but summaries effectively never occur);
  - **(b)** hold raw text in RAM, capped at 10 min and 16 KB, and summarize when the companion comes to the foreground. This stretches "transiently";
  - **(c)** a bundled on-device model not bound by AICore's rule, such as Gemma via MediaPipe or LiteRT. It is not Gemini Nano, adds 0.5-1 GB and costs battery [I];
  - **(d)** drop A5 summaries and keep only W5.
- **The code is summarizer-agnostic** (`Summarizer` interface), so D1 does not block the rest of A5.
- **Validation limits:**
  - Quality can be checked only on the phone with synthetic text the user types into a test note. Nothing real can be inspected off the phone.
  - The guard catches digit, name and quote echoes, but not paraphrased sensitive meaning (for example, "asked about a diagnosis").
  - **Failure looks like:** empty or generic summaries, invented topics, high guard-reject rates, `BUSY` or quota drops. All of these show up as drop counters, never as silent junk.

**5.7 Acceptance (JVM, fake `A11yEventView` with read-counting accessors, fake `Summarizer`, fake `Crypto`, fake `Clock`):**
- **Interception and kill switch:**
  - A `TEXT_CHANGED` event is consumed in every state, and the legacy push sink sees 0 calls.
  - With the kill switch off, the fake records **0** `getSource` or `getText` calls.
- **Exclusion policy:**
  - WhatsApp, Telegram, Signal, Samsung Health and a "Bumble" label are excluded.
  - `com.google.android.gm` and `com.google.android.apps.messaging` are **allowed**.
  - Password, number and OTP-hint fields are skipped.
- **Buffering:**
  - The idle flush fires at exactly 8 s.
  - After flush, and after summarizer failure, the buffer `char[]` is all zeros.
- **Unavailable summarizer:** with a summarizer throwing `BACKGROUND_USE_BLOCKED`, the store gets 0 inserts and the reason counter increments.
- **`SummaryGuard`:** it rejects "Call Dana at 555-0134" and a 4-word verbatim copy, and accepts "Planning a weekend trip".
- **Store:**
  - Expired rows are purged.
  - A row never contains plaintext summary bytes.
  - Delete-all removes the key alias.
- **No leakage to the PC:** no `queueV3Event` call carries `summary`, `text` or `topics`. Mobile vitest covers `typedText.ts` (toggle, preferred control, audit list/delete).

**5.8 Phone-only checks and spike.**
- **S5-1:** call `checkStatus` and `generateContent` from the service with Chrome on top, and record the error code. Repeat with the companion on top (expected to succeed).
- **S5-2:** latency, and `BUSY` and quota behavior, over 50 synthetic flushes.
- **S5-3:** assign the accessibility button and confirm the callback fires rather than toggling the service off (Samsung) [I]. Add the tile.
- **S5-4:** biometric unwrap works and survives a reboot. A new fingerprint enrollment invalidates the key.
- **S5-5:** check `adb logcat` and `run-as ... ls files/databases/shared_prefs` for any raw text after a session. The expected result is none.

## 6. Privacy and threat note

- **Mic.** The main risk is a bug that sends or keeps audio. Mitigations:
  - no file or network API in the mic classes (enforced in review);
  - the buffer is zeroed;
  - counts only;
  - the OS indicator makes every capture visible.
  - `speech_frac` together with places reveals meetings. That is the intended signal, and it stays on the LAN/Tailscale path to the user's own daemon.
- **Places.**
  - Hashed BSSIDs are linkable only with the on-phone key.
  - The daemon sees random ids plus labels and dwell. That still reveals home/work schedules (as in spec section C), so revocation and "Forget places" exist.
  - The stored log is append-only and cannot be deleted (spec section C).
- **Typed text.** This is the highest risk. Raw text sits in process memory during buffering. A heap dump or a compromised process could read it; debuggable builds make that easier, so **release builds only** for real use.
  - Summaries are encrypted under a biometric-bound key and never leave the phone.
  - A device thief with biometrics or the PIN fallback can read 7 days of summaries. Biometric-strong only, no device-credential fallback, limits this.
  - Other enabled accessibility services, including Cube's and Tasker's (F9), can already see the same text. This design adds no new exposure there.

## 7. Consent copy (Setup)

- **Mic (`mic_speech`):** "*Listens for 5 seconds every 2 minutes, only while your screen is on and the phone is not in a pocket, to tell whether someone is speaking (yes/no). No audio is saved or sent, and nothing is transcribed. Calls are detected from the phone's call state, not the mic. You will see the mic indicator each time it listens. Off stops it immediately; data already sent stays in your log.*"
- **Places (`places`):** "*Recognizes places you return to from nearby Wi-Fi, never GPS. Network names are never stored; networks are kept only as scrambled ids that work on this phone alone. Your PC receives only a place id, your label (home/work/other) and how long you stayed. Needs precise location permission to read Wi-Fi. Off stops it immediately; 'Forget places' erases what the phone learned.*"
- **Typing rhythm (`typing_rhythm`):** "*How much and how fast you type in each 5-minute window: counts only, never letters or words. Stays between your phone and your PC.*"
- **Typed-text summaries (`typed_text`):** "*Text you type in apps other than excluded ones (banking, passwords, authenticators, health, Signal, Telegram, WhatsApp, dating) is summarized on this phone by Gemini Nano into a short note. The text itself is never saved, shown or sent. Notes stay on this phone, encrypted, for 7 days, and only you can open them with your fingerprint or face. Email and text messages are included. Incognito browser tabs may not be detected. Turn it off instantly with the Accessibility button or the Quick Settings tile.*"

## 8. Order, merge hazards, commands

**Order:** SH, then A4 and A3 in parallel, then A5. A5's summarizer part waits for S5-1 and D1; its policy, buffer, kill switch, store and W5 can land before that.

**Merge hazards:**
- **Exclusive files.** These are owned only by SH: `AndroidManifest.xml`, `SensorCapabilities.ALL_KEYS`, `SensorConsentPlugin` purge map, `NativeTelemetrySync.V3_TYPES` and allowlist, `PiecesAccessibilityService` hooks, `sensorConsent.ts`, `Setup.tsx`. A5 alone owns the accessibility config.
- **Same `SensorConsent` prefs file.** The new keys must not change the `master` semantics.
- **`build.gradle`.** A5's `genai-prompt` beta1→beta4 bump may break `OnDeviceTriagePlugin` [I]. A5 must keep it compiling.
- **`--offline` build.** It fails if beta4 is not in the Gradle cache [I].
- **A1/A2 must not be in flight.** They touch `NativeTelemetrySync`, `SensorConsentPlugin` and `PiecesAccessibilityService`, and the spec says they have landed at `7d7fcf0` [V log].

**Commands** (not run here [I]):
- Android: `cd apps/mobile/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew --offline testDebugUnitTest` (filter with `--tests '*SpeechVad*'` and similar).
- Daemon: `cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/v3-sensitive-signals.test.ts src/v3-events.test.ts`.
- Mobile: `cd apps/mobile && npx tsc --noEmit && npx vitest run src/lib/sensorConsent.test.ts src/lib/places.test.ts src/lib/typedText.test.ts`.
- No run touches the live DB, the daemon process or the phone.

**Sign-off** (with consent): install the debug APK, run S3-1 to S3-5, S4-1 to S4-4 and S5-1 to S5-5, and over 24 h confirm `mic_window`, `place_window` and `typing_window` rows plus **zero** summary or text keys (`GET /v3/events`).

## Sources

- [ML Kit GenAI overview (foreground-only, quotas, devices)](https://developers.google.com/ml-kit/genai)
- [Prompt API get started (beta4, ~4000 tokens, errors)](https://developers.google.com/ml-kit/genai/prompt/android/get-started)
- [FGS background-start and while-in-use restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Wi-Fi permissions](https://developer.android.com/develop/connectivity/wifi/wifi-permissions)
- [AOSP AccessibilityServiceConnection (bind flags)](https://android.googlesource.com/platform/frameworks/base/+/master/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)
