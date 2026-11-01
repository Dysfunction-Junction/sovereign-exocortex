# Spec: pocket-gate fix and speech-session summaries (2026-10-29, rev 2)

Author: planner (Claude). Implementer: another model. Do not change this spec; raise questions in the PR.
Repo: `C:\Users\micha\projects\sovereign-exocortex`. Builds on `docs/ANDROID_SENSITIVE_CAPTURE_DESIGN_2026-10-29.md` section 2 (A3) and section 4 (A5, the typed-text summarizer, whose store, guard, kill switch and audit screen this reuses).

Rev 2: the user decided speech follows **the same rule as typed text**: summarize on the phone, keep only the summary, delete the raw input. No audio backup, no Google Drive. (Rev 1 kept audio for a day and uploaded it; that is withdrawn.)

## 0. The rule

- Raw audio exists only in RAM (or, if streaming to the recognizer needs it, a short-lived encrypted temp file that is deleted in `finally`). It is never kept after the session ends, never uploaded, never sent to the PC.
- The transcript exists only in RAM during summarization and is zeroed and dropped immediately after. It is never stored, logged, shown or sent.
- Only a short summary survives: encrypted on the phone, 7-day retention, opened only with a fresh fingerprint, exactly like typed-text summaries (A5 `SummaryStore`, `SummaryGuard`, audit screen).
- If transcription or summarization fails, is unavailable, is blocked, or the guard rejects the output: **drop the session. Never fall back to keeping audio or text.**
- New consent key `speech_summaries`, default OFF, separate from `mic_speech` (which stays counts only). It requires master ON and `mic_speech` ON; master OFF or `mic_speech` OFF forces it OFF. Same kill switches as typed text (accessibility button, Quick Settings tile, in-app switch), checked before any audio is read.
- Consent copy (user-facing, in `sensorConsent.ts`): "When speech is heard, the phone listens until a minute of quiet, turns it into a short note on the phone, and deletes the audio and words. Notes stay on this phone, encrypted, for 7 days, and open only with your fingerprint. Other people nearby may be heard; recording them may need their consent where you live. You will see the mic indicator while it listens. Turn it off instantly with the Accessibility button or the Quick Settings tile."
- Update design doc sections 2, 4 and 5 to match this spec.

## 1. Part 1: fix the pocket gate (own PR, do first)

Problem (S3-3 failed): the phone sat in a pocket, screen on, 10-15 min, and the mic still recorded at 15:43:49. The `unknown` result is also intermittent.
Current gate: `pocketGate(near, dark, known)` returns `pocket` only if near AND dark, waiting 300 ms for first proximity and light values. Code: `MicWindowSampler.AndroidGates.pocket()`, `NativeHardwareTelemetry.pocketGate/isNear/isDark`.

Suspected causes (confirm, do not assume):
1. Samsung's default proximity sensor is a virtual "palm" sensor that may not fire in a pocket or report within 300 ms (reports on change).
2. A lit screen raises lux above 5, so "dark" fails.
3. A late value makes `known` false, giving `unknown`, and hides a real near reading.

Steps:
1. A debug-only log is already in the working tree on branch `fix/mic-pocket-gate` (tag `PocketGate`: prox, max range, lux; guarded by FLAG_DEBUGGABLE, numbers only). Keep it and commit it.
2. Collect readings over adb (`adb logcat -s PocketGate`) in two situations: pocket with screen on (about 6 min) and hand-held (about 6 min). Ask the user before each test. Do not touch phone settings.
3. Choose a rule that **fails closed**: a sample is allowed only when readings are known AND clearly "in hand/open". Prefer, in order: (a) latch proximity over a longer wait (up to 1 s) plus a lux threshold that survives screen glow; (b) the physical proximity sensor via `com.samsung.permission.SSENSOR` only if the user approves; (c) a motion-still check (accelerometer, `motion` consent) as a secondary signal. Unknown means skip.
4. Keep `pocketGate` pure and JVM-tested, with vectors from the real readings (pocket, hand, screen glow, late or missing values).
5. Acceptance: pocket plus screen on for 10 min gives `samples=0` and `skipped.pocket + skipped.unknown` equal to the tick count, and `dumpsys audio` shows no companion MIC session. Hand-held: samples occur.

## 2. Part 2: speech-session summaries (own PR, after Part 1 merges and A5's store exists)

### 2.1 Prerequisite: shared A5 pieces

`SummaryStore`, `SummaryGuard`, the biometric-wrapped per-record encryption, the audit screen and the kill-switch plumbing belong to A5 (typed text) and are not built yet. Part 2 **reuses** them. If A5's store is not merged first, build the store and guard as a shared package (`SummaryStore`, `SummaryGuard`, `Summarizer` interface) in this PR, designed so A5 uses the same classes. Do not make a second store.

### 2.2 Session behavior (in `MicWindowSampler.Core`)

- **IDLE:** unchanged 2-minute tick with all gates (perm, screen on, not in call, pocket gate, mic not busy). Capture 5 s, ask `SpeechVad`.
- Speech found: enter **RECORDING**. Capture contiguous 5 s chunks into a RAM ring buffer (16 kHz mono PCM16, about 160 KB per 5 s).
- Stay in RECORDING while speech was heard within the last **60 s**. A non-speech chunk does not end it; 60 s of consecutive non-speech chunks does (speech at 59 s continues; none by 61 s ends it).
- Caps: **10 min of audio per session** (a session that hits the cap is summarized and a new one may start after the next gate pass) and **60 min of audio per day**; after the daily cap, counts-only until midnight. Constants.
- Mid-session stop (screen off, call start, mic taken by another app, consent off, kill switch, battery under 15 percent and not charging, `pocket` result, silenced capture): stop the mic immediately and **go to SUMMARIZE with what exists** (unless consent off or kill switch: then drop the buffer without summarizing). `unknown` pocket mid-session does not end it.
- Memory bound: RAM buffer is capped at the session cap (10 min is about 19 MB). Zero every buffer after use, including on exceptions (keep the `finally` pattern and its tests).

### 2.3 Transcribe, summarize, guard, store

Pipeline after a session ends, on a worker thread inside the service process (no foreground service):
1. **Transcribe on the phone.** Use the phone's built-in on-device Google/Gemini stack, behind an interface `Transcriber { transcribe(pcm, len, sampleRate) -> String? }`. **Decision (user, 2026-10-29): use the onboard Gemini; Android only, no cross-platform path.** In order: (a) ML Kit GenAI speech recognition (AICore) if the S26 Ultra supports it; (b) Android `SpeechRecognizer.createOnDeviceSpeechRecognizer` with `EXTRA_PREFER_OFFLINE`. Verify in current Google docs which APIs exist for this device before coding; do not guess. No network recognizer.
2. **Summarize** with the same `Summarizer` interface as typed text, using **Gemini Nano through ML Kit GenAI (AICore) `genai-prompt`**. This **reverses decision D1** (bundled Gemma); update `docs/ANDROID_SENSITIVE_CAPTURE_DESIGN_2026-10-29.md` section 4.6 and the memory note to say so. Input is the transcript; output is a short note: topic/intent/entity-type tags, a one or two sentence gist, duration bucket. No quotes, no names of people, no numbers, no addresses, no verbatim phrases.

**Blocking spike before any Part 2 code (S3-11 / S5-1):** Google documents that Gemini Nano and the on-device recognizer run only while the calling app is the top foreground app; a background caller gets `BACKGROUND_USE_BLOCKED`. Typing and speech both happen while other apps are on top. From the accessibility service, with another app on top and the screen on, call each API once with synthetic input and record the exact result, latency and battery. Possible outcomes:
- Works in the background: build Part 2 as written.
- Blocked: **stop and report to the user with the exact error. Do not silently fall back** to a bundled model, to holding audio or text until the app is opened, or to keeping audio. The user chooses the fallback. (The previously considered options were a bundled model or holding text in RAM until the app is foregrounded; neither is pre-approved now.)
3. **Guard** with `SummaryGuard` (reject output that echoes digits, capitalized proper-noun-like tokens, quoted strings or long verbatim n-grams from the transcript; reject too-long output). Rejected means dropped, counted.
4. **Store** the summary via `SummaryStore` (per-record AES-GCM key wrapped by a biometric-bound Keystore key, fingerprint to read, no PIN fallback, 7-day expiry). Record `{id, startMs, endMs, durationBucket, source: "speech"}` plus the summary text. No audio, no transcript, no app names.
5. **Always** zero the PCM and transcript buffers and delete any temp file in `finally`, whatever happened.

### 2.4 Events and counters

`mic_window` gets new allowlisted keys: `sessions` (count), `session_ms` (total listened), `summarized` (count stored), `dropped` (count rejected or failed). No summary text, no ids, no paths. Update `NativeTelemetrySync.V3_KEY_ALLOWLIST` and the daemon round-trip test. Summaries never go to `queueV3Event` or the PC.

### 2.5 UI

- `sensorConsent.ts`: consent key `speech_summaries` (like `typed_text`, not in SENSORS), setter, state field, copy above; master-off forces it off.
- Setup: a switch (disabled unless master and `mic_speech` are on) with the copy. Show the instant-off control choice already built for typed text.
- The existing `/typed-text` audit screen becomes the notes screen: list notes with a source label (typed or speech), fingerprint to open, "Delete all notes".

## 3. Tests (all required)

Android JVM, fakes in the style of `MicWindowSamplerTest`:
- Speech then silence: continues through chunks, ends after 60 s of non-speech; speech at 59 s continues, none by 61 s ends it.
- Per-session and per-day caps. Each mid-session stop reason ends the session and either summarizes or drops correctly.
- Pipeline fails closed: transcriber unavailable, throws, returns empty; summarizer throws or times out; guard rejects: all result in `dropped`, nothing stored, buffers zeroed, temp files deleted.
- No audio or transcript ever reaches the store, log, events or disk: assert on fakes (`Log` receives no samples or text; `SummaryStore` receives only the summary; no file writes outside the temp-file helper, and that helper is empty after each session).
- `mic_window` payload stays within the allowlist and has no text.
- Consent: master off, `mic_speech` off, kill switch each stop an in-flight session within the same main-looper turn.
Mobile vitest: `sensorConsent` (new key, forced-off rules, copy contains "deletes the audio and words"), Setup rendering.
Daemon: round-trip test with the new `mic_window` keys.
Phone checks (list in PR; the user runs them, ask first): S3-6 speak a test sentence, get one note of sensible length and no audio on disk; S3-7 61 s of silence ends it; S3-8 pocket start blocked; S3-10 `run-as ... ls files databases shared_prefs cache` shows no audio or text; S3-11 transcriber spike; S3-12 battery over a day.

## 4. Do not

- Do not keep raw audio or transcripts after a session, back them up, upload them or send them anywhere. No Drive, no cloud, no PC copy.
- Do not use external storage, MediaStore or a foreground service, and do not call any network recognizer.
- Do not enable `speech_summaries` by default or auto-enable it from other switches.
- Do not change phone permissions or switches, uninstall, or clear app data. Install with `adb install -r -d` only. Do not commit phone backups or tokens.

## 5. Process

Two PRs to `main`: (1) pocket gate; (2) speech-session summaries. For each: `cd apps/mobile && npx tsc --noEmit && npx vitest run`; `cd apps/mobile/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew --offline testDebugUnitTest`; `cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/v3-sensitive-signals.test.ts`. Wait for CI (`check`, `docker-isolation`), then merge. Report results honestly, including anything not verified on the phone.
