# Spec: on-device Gemma summarizer for typed text (A5) and speech sessions (2026-10-30)

Author: planner (Claude). Implementer: another model. Do not change this spec; raise questions in the PR.
Repo: `C:\Users\micha\projects\sovereign-exocortex`. Android root: `apps/mobile/android/app`. Package: `com.pieces.android.companion` (`src/main/java/com/pieces/android/companion`).
Builds on `docs/ANDROID_SENSITIVE_CAPTURE_DESIGN_2026-10-29.md` section 4 (A5) and `docs/SPEC_SPEECH_SESSION_SUMMARIES_2026-10-29.md` section 2. Where this spec and those disagree, this spec wins; section 11 lists every override.

Tags: **[V]** verified in the repo or on the phone today. **[W]** from a web source (links in section 13), not run here. **[I]** inferred, must be confirmed by a spike. **[U]** unknown.

## 0. Decisions already made (user, 2026-10-30)

| ID | Decision |
|---|---|
| D1 (final) | The summarizer is a **bundled Gemma model**. Gemini Nano is background-blocked (`30-BACKGROUND_USE_BLOCKED`, spike 2026-10-29 21:34, `docs/SPEECH_API_SPIKE_RESULTS_2026-10-29.md`). Applies to typed text and speech. |
| Rule | Summarize on the phone, keep only the summary, delete the raw input. No audio or text backup, no cloud, no PC copy. Unchanged. |
| Pocket gate | Skipped by the user. Do not touch `MicWindowSampler` gates in this work. |
| WP-A, WP8 | Approved (foreground transitions; opt-in typing cadence). Separate specs, not in this one. |

## 1. Scope

In scope: the `Summarizer` seam, everything A5 needs that does **not** need a model (policy, buffer, kill switch, guard, store, UI), the Gemma runtime, model provisioning, phone go/no-go spikes, and the hook speech sessions will use.

Out of scope: WP-A, WP8, the pocket gate, anything in `apps/daemon` (summaries never leave the phone), any server or network call. **Speech transcription is blocked** (section 10, decision Q1) and Part 2 of the speech spec does not start until Q1 is answered.

## 2. Facts that change the plan

1. **MediaPipe LLM Inference is deprecated on Android** [W]. Google's replacement is **LiteRT-LM**: artifact `com.google.ai.edge.litertlm:litertlm-android`, model format `.litertlm`, not `.task`. Use LiteRT-LM. Do not add `com.google.mediapipe:tasks-genai`. The existing `com.google.mediapipe:tasks-text:0.10.35` (embedder, `build.gradle:98`) is a different artifact and stays.
2. LiteRT-LM version: recent migrations use 0.17.1 to 0.18.0, below 1.0, and they pair it with Kotlin 2.4 [W]. Pin the exact version that resolves; record it in the PR. Pre-1.0 means API churn, so wrap it behind one class (`GemmaEngine`, section 5).
3. The project is **Java only**: no Kotlin plugin in `apps/mobile/android/build.gradle` (AGP 8.13.0, Gradle 8.14.3) [V]. The LiteRT-LM Kotlin API may be coroutine-based and awkward from Java [I]. Spike S5-6 decides: call it from Java directly, or add one tiny Kotlin shim module. Do not convert the app to Kotlin.
4. Gemma 3 1B IT int4 is about **584 MB** as `.litertlm` [W]. Models over 1 GB should not ship in an APK [W]; this one is borderline. **Do not bundle it in the APK.** Provision it as a file (section 6). The Gemma license is gated on Hugging Face and needs the user's acceptance; the implementer must not download it.
5. Phone: SM-S948U1, SoC `SM8850`, 15.4 GB RAM, 581 GB free storage [V]. CPU backend is the default; GPU/NPU is optional and only after the CPU path works [I]. A reported fp16 problem on the GPU backend concerns the 270M model, not 1B [W].
6. `android:allowBackup="false"` [V], so the model file and the summary database are not backed up. Keep it that way.
7. Gemma 3 1B is **text only**. It cannot transcribe audio. Speech needs a separate transcriber (Q1).
8. A quality limit by construction: a 1B model's summaries can only be judged on the phone, with synthetic text. The guard catches echoed digits, names and quotes, not paraphrased sensitive meaning (design doc 4.6). The consent copy already discloses this class of risk; do not claim more.

## 3. Work order and PR split

One PR per row. Row N+1 does not start before row N is merged and green.

| PR | Branch | Content | Needs model? | Needs user? |
|---|---|---|---|---|
| A5-1 | `feat/a5-typed-text-core` | Section 4: policy, buffer, gate, guard, store, `Summarizer` interface, `FakeSummarizer`, capture wiring, tile, plugin, TS lib, audit screen, JVM and vitest tests | No | No |
| A5-2 | `spike/gemma-litertlm` | Section 7 spikes S5-6 to S5-10. Debug-only code. Output: `docs/GEMMA_SPIKE_RESULTS_<date>.md` with the go/no-go table | Yes | Yes (model file, phone) |
| A5-3 | `feat/a5-gemma-summarizer` | Section 5 and 6: `GemmaEngine`, `BundledSummarizer`, provisioning, wiring. **Only if A5-2 says GO** | Yes | Yes |
| SP-2 | `feat/speech-session-summaries` | Speech spec Part 2 on top of the A5 store and `BundledSummarizer` | Yes | Q1 |

A5-1 must make the feature **inert without a model**: with `FakeSummarizer` absent in release, `typed_text` can be switched on but every flush ends as `dropped:summarizer_unavailable`. Nothing is stored.

## 4. A5-1: the model-free core (exact files)

All new classes are package-private unless noted. JVM tests live in `src/test/java/com/pieces/android/companion/` and follow the fake-injection style of `MicWindowSamplerTest.java`.

### 4.1 Interfaces (new file `Summarizer.java`)

```java
interface Summarizer {
    /** Blocking, called on the worker thread only. Returns raw model text, or throws SummarizerException. */
    String summarize(String prompt, long timeoutMs) throws SummarizerException;
    /** Cheap, non-blocking. False means every flush is dropped with reason summarizer_unavailable. */
    boolean isReady();
    /** Free native memory. Safe to call repeatedly. */
    void release();
}
final class SummarizerException extends Exception {
    enum Reason { UNAVAILABLE, BUSY, TIMEOUT, BLOCKED, OOM, THERMAL, FAILED }
    final Reason reason;
}
```

`FakeSummarizer` lives in `src/test` only. No test double ships in `main`.

### 4.2 `TypedTextGate.java` (kill switch state)

- `static volatile boolean on;` `static volatile int generation;` plus the pref `typed_text` in `sensor_consent_prefs` (already used by `SensorCapabilities.KEY_TYPED_TEXT`, `SensorConsentPlugin.isTypedTextOn`).
- `static void turnOff(Context)`, in this exact order, in one call: (1) `on = false`; (2) `TypedTextCapture.removeTextEvents(service)`, i.e. `setServiceInfo` without `typeViewTextChanged` unless `typing_rhythm` is on; (3) `TypedTextBuffer.clearAll()` (zero-fill); (4) `generation++`; (5) `TypedTextSummaryQueue.clear()` (zero-fill); (6) `GemmaEngine.release()` if present; (7) commit the pref with `commit()`, not `apply()`.
- Any result produced by a worker whose captured `generation` differs from the current one is discarded before the guard runs.
- Master switch off forces `typed_text` off through `SensorConsentPlugin` (already specified in design doc section 1; keep).

### 4.3 `TypedTextPolicy.java` (pure, JVM-tested)

`static boolean excluded(String pkg, String label)` and `static boolean fieldSkipped(FieldInfo f)`.

`excluded` is true when any holds (case-insensitive; match `pkg` by exact or prefix, `label` by substring):

| Group | Rule |
|---|---|
| Messaging | exact `com.whatsapp`, `org.telegram.messenger`, `org.thoughtcrime.securesms`; and per the user's 2026-10-29 decision Messenger (`com.facebook.orca`), Discord (`com.discord`), social apps (Facebook `com.facebook.katana`, Instagram `com.instagram.android` and `com.instagram.barcelona`, Snapchat `com.snapchat.android`, Reddit `com.reddit.frontpage`, X/Twitter `com.twitter.android`, TikTok `com.zhiliaoapp.musically`), the dialer (`com.samsung.android.dialer`, `com.google.android.dialer`, `com.android.dialer`) |
| Finance | pkg or label contains `bank`, `wallet`, `pay`, `venmo`, `cashapp`, `paypal`, `crypto`, `coinbase`, `invest`, `credit`, `transunion`, `creditkarma` |
| Secrets | pkg or label contains `password`, `authenticator`, `2fa`, `otp`, `keepass`, `bitwarden`, `1password`, `lastpass`, `vault` |
| Health | `com.sec.android.app.shealth`, `com.google.android.apps.fitness`; pkg or label contains `health`, `pharmacy`, `therapy`, `clinic`, `mychart`, `medic` |
| Dating/adult | contains `dating`, `tinder`, `bumble`, `hinge`, `grindr`, `adult`, `lovense` |
| IME / system noise | any pkg that is an input method (reuse the noise-prefix list in `PiecesAccessibilityService`; do not reuse `isPrivacyExcluded`, finding F14) |
| Self | `com.pieces.android.companion`, `com.hermesandroid.bridge` |

Allowed explicitly (test it): `com.google.android.gm`, `com.google.android.apps.messaging`, `com.microsoft.office.outlook`, Chrome, Google Docs, Samsung Notes, Obsidian (`md.obsidian`).

`fieldSkipped` is true when any holds: `isPassword()`; input type class `NUMBER`, `PHONE` or `DATETIME`; variation `EMAIL_ADDRESS`, `URI`, `PERSON_NAME`, `POSTAL_ADDRESS`, or any password variation; hint text matches `(?i)code|otp|pin|card|cvv|ssn|account|passcode|routing|iban`. `FieldInfo` is a plain value object (class name, inputType int, isPassword, hint) so the test needs no Android framework.

### 4.4 `TypedTextBuffer.java`

- One `char[4000]` per key `(pkg, windowId, viewId)`; holds the **latest full text** of the field (events carry full text, so overwrite, do not append). Longer text is cut to its **last** 4000 chars.
- Max 8 live buffers; the 9th evicts the least-recently-updated (zero-filled, dropped, counter `evicted`).
- Flush triggers: 8 000 ms idle (exact; test with fake `Clock`), window change, focus change, 120 000 ms since first change.
- Flush hands the text to `TypedTextSummaryQueue` as a `char[]` copy, then zero-fills the buffer (`Arrays.fill(buf, '\0')`) in `finally`, also when the copy or enqueue throws.
- Honest limit (keep in the PR description): `AccessibilityEvent.getText()` and any `String` built from it sit on the heap until GC. Never log them, never put them in Intents, Bundles, prefs, files or Capacitor events. Catch blocks log `e.getClass().getSimpleName()` only.

### 4.5 `TypedTextSummaryQueue.java` (new, bounded)

- Single worker thread named `typed-summary`, priority `THREAD_PRIORITY_BACKGROUND`.
- Capacity **4 pending flushes**, each at most 4000 chars, so at most 16 KB of raw text waits in RAM (the bound option (b) in the design doc used). A 5th enqueue drops the **oldest** (zero-filled, counter `dropped:queue_full`).
- Max age in queue **120 s**; older items are zero-filled and counted `dropped:stale`.
- Before running an item the worker checks, in order, and drops with the named reason: kill switch off or `generation` changed (`gate_off`); device locked (`locked`); battery < 15 % and not charging (`battery`); `PowerManager.getCurrentThermalStatus() >= THERMAL_STATUS_MODERATE` (`thermal`); `Summarizer.isReady()` false (`summarizer_unavailable`).
- Calls `Summarizer.summarize(prompt, 30_000)`; every `SummarizerException.Reason` maps 1:1 to a counter. **No retry, no re-queue.**
- `finally`: zero-fill the item's `char[]`, null the prompt `String` reference.

### 4.6 `SummaryPrompt.java` (pure)

```
static String build(String appCategory, char[] text)
```

The prompt template is the text in section 6.1, verbatim. `appCategory` is one of `email, messaging, notes, browser, docs, other`, derived from the package by `TypedTextPolicy.category(pkg)`; **the package name and app label are never put in the prompt or the record**.

### 4.7 `SummaryGuard.java` (pure; the exact algorithm is section 6.3)

`static GuardResult check(String modelOutput, char[] input)` returns either `Ok(Summary)` or `Reject(Reason)`. Runs while the input is still in memory. Pattern reference: `OnDeviceTriagePlugin.java` lines 46 and 211 to 232 (`VALID_CATEGORIES`, brace extraction, null on any problem) [V].

### 4.8 `SummaryStore.java` (encrypted, section 8)

### 4.9 Wiring

| File | Change (surgical) |
|---|---|
| `TypedTextCapture.java` | Replace the stub body. `intercept` consumes (returns true for) every `TYPE_VIEW_TEXT_CHANGED`; window-state and content-change events return false. Gate order before any `getSource()`/`getText()`/`getBeforeText()`: (1) `typed_text` and `typing_rhythm` both off, return false; (2) keyguard locked, drop; (3) `TypedTextPolicy.excluded`, drop; (4) only `typing_rhythm` on: read `getAddedCount`/`getRemovedCount` only, never text. Then field check, then buffer. `start/stop/onConsentChanged` add and remove `typeViewTextChanged` at runtime via `setServiceInfo` (`flagRequestAccessibilityButton` stays in the static XML; `typeViewTextChanged` is **not** added to `res/xml/accessibility_service_config.xml`). Never set `isAccessibilityTool`. Never read the clipboard. |
| `TypedTextTileService.java` | ACTIVE/INACTIVE tile bound to `TypedTextGate.on`; tap toggles; off goes through `TypedTextGate.turnOff`. Manifest entry already exists (`AndroidManifest.xml:66`) [V]. |
| `PiecesAccessibilityService.java` | No change except one call: in the accessibility-button callback path, `registerAccessibilityButtonCallback(...)` toggles the gate. The hook `TypedTextCapture.intercept` at line 93 and `start/stop` at lines 662 and 682 already exist [V]. |
| `TypedTextPlugin.java` | Methods, all resolve JSON, none returns raw text: `getCounters()`, `setPreferredControl({control})` (`button|tile|app`), `unlock({epoch})` (BiometricPrompt, section 8), `listNotes({epoch})`, `deleteNote({id})`, `deleteAll()`. `deleteAll` removes rows, the key alias and the epoch wraps. |
| `MainActivity.java`, `NativeTelemetrySync.java` | No change. Summaries never go to `queueV3Event`. A test asserts no V3 payload contains `summary`, `text`, `topics`, `intent`. |
| `src/lib/typedText.ts` + `typedText.test.ts` | Typed wrappers over the plugin; toggle, preferred control, list, delete. |
| `src/pages/TypedTextAudit.tsx`, route `/typed-text` | Sets `FLAG_SECURE` while open. Lists date, app category, intent, topics, summary; delete-one, delete-all; shows the drop counters; shows model state (`not installed`, `verifying`, `ready`, `failed`). |
| `src/lib/sensorConsent.ts` | The `TYPED_TEXT.copy` already says "bundled on-device model (decision D1)" [V]; update only the comment to say Gemma, not Nano. Add nothing else in A5-1. |

## 5. A5-3: the Gemma runtime (exact)

### 5.1 Build

`app/build.gradle` dependencies: add `implementation 'com.google.ai.edge.litertlm:litertlm-android:<pinned>'`. The existing `abiFilters 'arm64-v8a'` stays. If S5-6 requires the Kotlin shim, it is a separate Gradle module `:litertlm-shim` with the Kotlin plugin applied **only there**, exposing a Java-callable blocking API `String generate(String prompt, int maxNewTokens, long timeoutMs)`. `noCompress 'tflite'` (line 37) is joined by `noCompress 'litertlm'` only if a model is ever put in assets; it is not (section 6).

### 5.2 `GemmaEngine.java` (the only class that imports LiteRT-LM)

- `ensureLoaded()`: loads `files/models/gemma3-1b-it-int4.litertlm` after the integrity check (section 6.2). Backend CPU, 4 threads [I; tune in S5-8]. Sampler: temperature 0.2, top-k 40, `maxNewTokens` 160, stop at the closing brace. Context limit 1536 tokens (prompt about 1000 plus output).
- **One Conversation per request**, closed in `finally` [W; the migrations do this].
- Resident policy: load on first item, release after **60 s** with an empty queue (`Handler` on the worker). Peak RSS target is a spike threshold (section 7).
- Never run on the main thread. Never run two inferences at once.
- Maps native errors to `SummarizerException.Reason`. Out-of-memory is `OOM`, never retried.

### 5.3 `BundledSummarizer implements Summarizer`

Thin: `isReady()` = model file verified and engine not in `failed` state; `summarize` = `GemmaEngine.generate`; `release` = `GemmaEngine.release`. Wired into `TypedTextSummaryQueue` through a static factory `Summarizers.create(Context)`.

## 6. Model, prompt, guard

### 6.1 Prompt (verbatim; the implementer may not paraphrase it)

```
You write privacy-safe notes. Read the text and answer with ONLY one JSON object, no other text:
{"intent":"<one of: plan, ask, tell, decide, remind, vent, other>",
 "topics":["<up to 3 from the list>"],
 "entity_types":["<any of: person, place, org, date, money, product>"],
 "summary":"<at most 20 words>"}
Topic list: planning, scheduling, shopping, travel, food, home, family, work_task, coding, writing, learning, entertainment, music, gaming, news, car, pets, weather, sports, event, gift, appointment, logistics, idea, question, update, other.
Rules for summary: describe what the text is about in general terms. Do NOT include names, numbers, addresses, emails, links, quotes or any exact phrase from the text.
App type: {appCategory}
Text:
"""
{text}
"""
```

Notes: the topic list deliberately has **no** health, finance, sex, religion, politics, legal or identity topic. If the model emits anything outside the list, the guard maps it to `other`; it never passes through.

### 6.2 Model file and integrity

- File: `Gemma3-1B-IT` int4 `.litertlm` from the `litert-community` Hugging Face repo [W]. The user downloads it (license acceptance), computes SHA-256, and sends the hash to the implementer; the hash is pinned in `GemmaModel.EXPECTED_SHA256` (constant, in the PR).
- Staging: `adb push <file> /sdcard/Android/data/com.pieces.android.companion/files/models/` (app-specific external dir, `getExternalFilesDir("models")`). The app copies it to `filesDir/models/` (internal), verifies SHA-256 while copying, then deletes the staged file. Mismatch: delete both, state `failed`, counter `model_hash_mismatch`. No network code anywhere in this path.
- The model file is not user data and may be replaced; the summary database is. Never co-locate them.

### 6.3 `SummaryGuard` algorithm (exact; implement in this order)

Input: `raw` (model output), `input` (the typed text).

1. Extract the substring from the first `{` to the last `}`; none, reject `no_json`. Parse with `org.json.JSONObject`; exception, reject `bad_json`.
2. `intent` must be in {plan, ask, tell, decide, remind, vent, other}, else reject `bad_intent`.
3. `topics`: array, at most 3; each must be in the topic list, **else replaced by `other`**; de-duplicate. Empty becomes `["other"]`.
4. `entity_types`: keep only members of {person, place, org, date, money, product}; drop the rest silently.
5. `summary` checks (any failure sets `summary = ""` and counter `summary_stripped:<reason>`; the record is still stored with intent and topics):
   a. length > 160 chars or > 20 words: `too_long`;
   b. regex `\d{3,}`: `digits`; also any run of 3+ digits after removing spaces, dashes and dots;
   c. email `[\w.+-]+@[\w-]+\.[\w.-]+`: `email`;
   d. URL `(?i)(https?://|www\.)\S+` or a bare `\w+\.(com|net|org|io|app|dev|gov|edu)\b`: `url`;
   e. phone `\+?\d[\d\s().-]{6,}\d`: `phone`;
   f. quotes: contains `"` or a curly quote pair: `quote`;
   g. **capitalized-token echo**: tokenize `input` with `\p{L}[\p{L}\p{Nd}'’-]*`; let `C` = tokens whose first letter is uppercase and which are not the first token of a sentence (sentence start = start of text, or after `.`, `!`, `?`, newline); a token in the summary equal (case-sensitive) to a member of `C`, and not itself sentence-initial in the summary: `name_echo`;
   h. **4-gram echo**: lowercase both texts, tokenize on `\p{L}+`; any 4 consecutive summary words that appear consecutively in the input: `verbatim`.
6. If the whole guard throws: reject `guard_error` (fail closed; nothing stored).
7. The guard never calls the model again and never repairs text.

Tests required: "Call Dana at 555-0134" is stripped (`digits` and `name_echo`); a summary copying four input words is stripped; "Planning a weekend trip" passes; an out-of-list topic becomes `other`; unparseable output is rejected; the input array is untouched by the guard.

## 7. Phone spikes (A5-2) and go/no-go

Ask the user before each. Do not change phone settings. Use synthetic text only. Install with `adb install -r -d`; never uninstall or clear data. The device is `SM-S948U1`.

| ID | What | Method | Pass (GO) |
|---|---|---|---|
| S5-6 | Can Java call LiteRT-LM, or is the Kotlin shim needed? | Minimal debug class loads the model, one prompt | Output returned; decision recorded |
| S5-7 | Works from the accessibility service process, screen on and off, another app on top | Same call from `PiecesAccessibilityService` thread with Chrome on top, then screen off | Returns text in both; no `BACKGROUND_USE_BLOCKED` equivalent |
| S5-8 | Latency | 50 synthetic flushes, 100 to 1000 input tokens, CPU backend, 4 threads | p50 <= 8 s, p95 <= 20 s; 0 timeouts at the 30 s limit |
| S5-9 | Memory and thermal | Peak PSS during inference and 60 s after idle release (`dumpsys meminfo`) | Peak <= 1.8 GB; after release back within 150 MB of baseline; thermal status never above LIGHT in a 50-run batch |
| S5-10 | Quality and guard | 50 synthetic texts (20 harmless, 10 with names/numbers, 10 with sensitive meaning, 10 short) | JSON parse success >= 90 %; zero stored summaries containing any seeded name or number; seeded-sensitive texts reported honestly (paraphrase leaks are expected and must be listed, not hidden) |
| S5-11 | Battery | 24 h with feature on at normal use vs 24 h off, `dumpsys batterystats` | Attributable <= 3 % of battery per day. If higher, report; do not ship |

Also S5-1 to S5-5 from design doc 4.6 stay required for A5-1 (accessibility events live toggle, button/tile, biometric unwrap survives reboot, no raw text on disk via `run-as`).

**GO** needs S5-6 to S5-10 passed and S5-11 within limit. **NO-GO**: stop and report the numbers to the user with three options: a smaller or different model (candidates to evaluate, unverified: Gemma 3 270M, a 3n variant), hold-in-RAM, or drop. No silent fallback.

## 8. `SummaryStore` (encrypted store), refining design doc 4.3

The design doc's "single per-day key-encryption key" is under-specified: the writer cannot hold an unwrapped key without authentication unless it keeps it in RAM [I]. Use this scheme.

- Database `typed_summaries.db` in `getDatabasePath`, `PRAGMA secure_delete=ON`, WAL off. Tables:
  - `epoch(id INTEGER PRIMARY KEY, created_at INTEGER, wrapped_kek BLOB, iv_free INTEGER)`;
  - `note(id TEXT PRIMARY KEY, epoch_id INTEGER, created_at INTEGER, expires_at INTEGER, app_category TEXT, source TEXT CHECK(source IN ('typed','speech')), iv BLOB, ct BLOB)`.
- Plaintext columns are only times, `app_category`, `source`. `intent`, `topics`, `entity_types`, `summary` are all inside `ct` (JSON). Purge never decrypts.
- **Epoch**: when the service first needs to write after start, it generates a fresh AES-256 `KEK` in RAM, wraps it with the Keystore **RSA-OAEP public key** (alias `exocortex_typed_summary_v1`; public-key encryption needs no authentication), stores `wrapped_kek` in `epoch`, and keeps `KEK` in a `byte[]` in RAM only. Each note is AES-256-GCM under `KEK` with a random 12-byte IV; AAD = `id || created_at`.
- `KEK` is zero-filled on `TypedTextGate.turnOff`, `onUnbind`, `onDestroy`, and 10 min after the last write. A new epoch starts on the next write. Process death also loses it; the stored `wrapped_kek` remains readable only with the fingerprint.
- Private key: `KeyGenParameterSpec` with `PURPOSE_DECRYPT`, `setUserAuthenticationRequired(true)`, `setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)` (per use, **no** timeout, **no** device credential), `setInvalidatedByBiometricEnrollment(true)`, digests SHA-256 with OAEP padding. Pitfall [I]: the Keystore OAEP default MGF1 digest is SHA-1; initialise `Cipher` with an explicit `OAEPParameterSpec("SHA-256","MGF1",MGF1ParameterSpec.SHA1,PSource.PSpecified.DEFAULT)` and test the round trip on the phone (S5-4).
- Reading: `TypedTextPlugin.unlock({epoch})` shows a `BiometricPrompt` with a `CryptoObject(cipher)` (pattern: `ApprovalKeyPlugin.java` lines 116 to 190 [V]), unwraps that epoch's `KEK` into RAM for the audit screen's lifetime, then zero-fills it when the screen closes. One prompt per epoch; usually one per day. State this in the audit UI.
- Retention: `expires_at = created_at + 7 d`. Purge on insert, at service connect, and in a daily `JobScheduler` job: delete expired notes, delete epochs with no notes, then `VACUUM`. `deleteAll()` deletes rows, epochs and the key alias.
- Fail closed: any crypto or DB exception drops the note and bumps `dropped:store_error`. Never fall back to plaintext.

Tests: rows contain no plaintext summary bytes (scan the raw DB file for a seeded word); expired rows purge; `deleteAll` removes the alias; tampered `ct` or `id` fails GCM; no `queueV3Event` payload carries `summary`/`text`/`topics`.

## 9. Counters and visibility

`getCounters()` returns integers only: `captured`, `flushed`, `stored`, `dropped` with a map by reason: `gate_off, locked, battery, thermal, summarizer_unavailable, queue_full, stale, evicted, BUSY, TIMEOUT, BLOCKED, OOM, THERMAL, FAILED, store_error, guard_error`, plus `summary_stripped:<reason>` and `model_hash_mismatch`. Stored in a small prefs file `typed_text_counters`; no text, no package names. Shown on the audit screen so failures are visible, never silent.

## 10. Open decisions for the user (the implementer must not guess)

| ID | Question | Planner's recommendation |
|---|---|---|
| Q1 | **Speech transcription.** Gemma 3 1B cannot transcribe. Options: the on-device Google speech recognizer (background support unverified; the 10-29 spike got `ERROR_TYPE_SODA` because the model was not downloaded), a bundled small speech model such as Whisper-tiny or a Gemma variant with audio input (unverified), or drop speech. | Run one more spike: download the speech model, retest in the background, then decide. Do not start SP-2 before this. |
| Q2 | Provide the Gemma model file and its SHA-256 (Hugging Face login, license acceptance). | User action, 5 minutes, before A5-2. |
| Q3 | Battery limit in S5-11 (3 %/day proposed). | Accept 3 %. |

## 11. Overrides of earlier documents

1. Design doc 4.6 "Nano" and "D1 decided (c) Gemma via MediaPipe/LiteRT": the runtime is **LiteRT-LM**, not MediaPipe tasks-genai.
2. Design doc 4.2 "timeout over 10 s": for Gemma on CPU the limit is **30 s**.
3. Design doc 4.3 "single per-day KEK": replaced by the epoch scheme in section 8.
4. `ANDROID_SENSITIVE_CAPTURE_DESIGN` class name `NanoSummarizer.java`: the class is `BundledSummarizer.java`.
5. Speech spec 2.3 step 2 "Gemini Nano": the summarizer is the same `BundledSummarizer`; its transcriber is Q1.
6. Consent copy text stays as is; only code comments change.

## 12. Do not

- Do not bundle the model in the APK or `assets`, add any network download, or call any cloud model.
- Do not add `com.google.mediapipe:tasks-genai`. Do not remove `tasks-text` or `genai-prompt` (`OnDeviceTriagePlugin` still uses Nano for triage).
- Do not log, persist, broadcast or send raw text, transcripts, prompts or model output. Do not store the prompt.
- Do not retry a failed summarization or hold items past the limits in 4.5.
- Do not enable `typed_text` by default or from another switch. Do not touch phone settings, permissions or data; do not uninstall.
- Do not edit the pocket gate, `apps/daemon`, or the event schema. Do not push to `main`; open a draft PR per row.
- Do not mark a phone check passed unless it was run on the phone; say "not run" otherwise.

Process per PR:
- `cd apps/mobile && npx tsc --noEmit && npx vitest run`
- `cd apps/mobile/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew --offline testDebugUnitTest` (if a new dependency is not cached, `--offline` fails; report it, do not remove the flag silently)
- `cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/v3-sensitive-signals.test.ts`
- CI (`check`, `docker-isolation`) green before merge.

## 13. Sources

- [LLM Inference guide (Google AI Edge)](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference): Android implementation deprecated, replaced by LiteRT-LM.
- [LLM Inference guide for Android](https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/android): runtime model download advice, `tasks-genai` artifact.
- [litert-community/Gemma3-1B-IT](https://huggingface.co/litert-community/Gemma3-1B-IT/blob/main/README.md): model files and formats.
- [MediaPipe LLM Inference is maintenance-only: start on LiteRT-LM](https://dev.to/charleshartmann/mediapipe-llm-inference-is-maintenance-only-start-on-litert-lm-and-add-this-abi-check-48h2): artifact name, version 0.18.0, 584 MB `.litertlm`.
- [Migrate on-device LLM from MediaPipe tasks-genai to LiteRT-LM (switchify-android #2906)](https://github.com/switchifyapp/switchify-android/pull/2906): version 0.17.1, Kotlin 2.4, one conversation per request.
