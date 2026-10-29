# Spec: pocket-gate fix and speech-session recording (2026-10-29)

Author: planner (Claude). Implementer: another model. Do not change this spec; raise questions in the PR.
Repo: `C:\Users\micha\projects\sovereign-exocortex`. Builds on `docs/ANDROID_SENSITIVE_CAPTURE_DESIGN_2026-10-29.md` section 2 (A3).

## 0. What changes, and what it overrides

A3 today: 5 s of audio every 2 min, held in RAM, one boolean, then zeroed. **No audio is stored or sent.**
The user has now decided (2026-10-29): when speech is detected, **keep recording until 1 minute of silence, store it on the phone for the day, then back it up to the user's own cloud storage (Google Drive first).**

This **reverses design rule "no audio saved"**. So:
- It is a **new consent key `speech_recording`**, separate from `mic_speech`. Default OFF. `mic_speech` keeps its counts-only behavior.
- `speech_recording` ON requires `mic_speech` ON and master ON. Master OFF or `mic_speech` OFF forces it OFF.
- Audio **never** goes through `queueV3Event`, the daemon, logs, Intents or Capacitor events. Only a count and duration enter `mic_window` (new allowlisted keys, see 3.6).
- Consent copy must say plainly: "Records audio when speech is heard and stores it on this phone for a day, then uploads it to your Google Drive. Other people nearby may be recorded." Put the copy in `sensorConsent.ts` with the user-facing warning that recording other people may need their consent where you live.
- Update section 2 and section 5 of the design doc to match. Update the A3 acceptance table.

## 1. Part 1: fix the pocket gate (do this first, ship as its own PR)

Problem (S3-3 failed): the phone sat in a pocket, screen on, for 10-15 min and the mic still recorded at 15:43:49. The `unknown` result is also intermittent.
Current gate: `pocketGate(near, dark, known)` returns `pocket` only if near AND dark, with a 300 ms wait for the first proximity and light values. Code: `MicWindowSampler.AndroidGates.pocket()`, `NativeHardwareTelemetry.pocketGate/isNear/isDark`.

Suspected causes (confirm, do not assume):
1. Samsung's default proximity sensor is a virtual "palm" sensor that may not fire in a pocket or may not report within 300 ms (reports on change).
2. A lit screen raises the lux reading above 5, so "dark" fails.
3. "Known" is false when either value is late, which gives `unknown`; but a late value also hides a real near reading.

Steps:
1. A debug-only log is already in the working tree on branch `fix/mic-pocket-gate` (tag `PocketGate`: prox, max range, lux). Keep it (guarded by FLAG_DEBUGGABLE, numbers only). Commit it.
2. Collect readings from the S26 Ultra over adb (`adb logcat -s PocketGate`), in two situations the user will provide: pocket with screen on (about 6 min) and hand-held (about 6 min). Do not touch phone settings. Ask the user before each test.
3. From the data, choose a rule that **fails closed**: a sample is allowed only when readings are known AND clearly "in hand/open". Prefer, in order: (a) proximity far reading latched from a longer wait (up to 1 s) plus lux above a threshold that survives screen glow; (b) add the physical proximity sensor via the `com.samsung.permission.SSENSOR` permission only if the user approves; (c) add a motion-still check (accelerometer, already consented via `motion`) as a secondary signal. Unknown means skip.
4. Keep `pocketGate` pure and JVM-tested. Add vectors built from the real readings (pocket, hand, screen glow, late/missing values).
5. Acceptance: with the phone in a pocket and screen on for 10 min, `mic_window` shows `samples=0` and `skipped.pocket + skipped.unknown` equals the tick count, and `dumpsys audio` shows no companion MIC session. Re-run hand-held: samples occur.

## 2. Part 2: speech-session recording (separate PR, after Part 1 is merged)

### 2.1 Behavior

State machine in `MicWindowSampler.Core`:
- **IDLE:** current 2-minute tick with all gates (perm, screen on, not in call, pocket gate, mic not busy). Capture 5 s, ask VAD.
- Speech found: enter **RECORDING**. Keep capturing contiguous audio (no gap) and write it to the session file.
- Stay in RECORDING while speech was heard within the last **60 s**. Check VAD on 5 s chunks (reuse `SpeechVad`). A chunk with no speech does not end the session; 60 s of consecutive non-speech chunks does.
- End session: stop the mic, finalize the file, return to IDLE. Hard caps: **30 min per session**, **2 h of audio per day** (then back to counts-only until midnight). Make both constants.
- **Gates during RECORDING:** screen off, call start, mic taken by another app, consent off, low battery (below 15 percent and not charging), storage under 500 MB free: stop immediately and finalize what exists. The pocket gate applies to **starting** a session only (user chose to keep it as a gate; if the phone moves into a pocket mid-session, check it each chunk and end the session on `pocket`; unknown mid-session does not end it).
- Silenced capture (zeros): end the session, delete the file if it contains only zeros, count `silenced`.

### 2.2 Audio format and files

- 16 kHz mono PCM16 from the existing `AudioRecord`. Write WAV chunks incrementally (header patched on finalize) so a crash loses little. Encode to AAC/Opus only if time allows; not required.
- Files in app-private storage: `files/speech/YYYY-MM-DD/session-<epochMs>.wav.enc`. **Not** in external storage, not in `cache/`.
- Encrypt each file with its own random AES-256-GCM key, wrapped by an Android Keystore key (non-exportable). Streaming encryption in segments. Unwrapping for playback needs a fresh fingerprint (same pattern as the A5 audit store: biometric-bound key, `setUserAuthenticationRequired(true)`, no PIN fallback). Upload (2.4) needs no fingerprint: use a separate Keystore key without auth-required for the upload wrap, or encrypt to the cloud with a key derived for the upload only. Decide in the PR and justify.
- Zero every PCM buffer after writing (keep the existing `finally` pattern and tests).
- Index of sessions in a small encrypted metadata store: `{id, startMs, endMs, bytes, state: local|uploading|uploaded|failed, driveFileId?}`. No transcript, no app names.

### 2.3 Retention

- Local files are kept for **the day** they were recorded and deleted after a verified upload, or after **48 h** at the latest if not uploaded (so a user who never connects Google loses nothing silently: show a banner in Setup "N recordings not backed up, deleted at <time>"). Make 48 h a constant; flag it in the PR for the user to confirm.
- "Delete all recordings" button in Setup: removes local files, metadata and (optionally, asked) Drive files this app created.
- Consent off: stop immediately, keep existing files until their normal expiry unless the user chooses "Delete now" in the same dialog.

### 2.4 Upload to Google Drive

- OAuth with the **user's own Google account** via Google Identity Services / Credential Manager, scope `https://www.googleapis.com/auth/drive.file` only (app-created files only). No broader scope. Do not ship any client secret in the repo; the OAuth client id for Android is public and goes in `build.gradle` or a resource, documented in the PR.
- Folder: create `Exocortex Speech` in the user's Drive on first upload. File names `session-<ISO>.wav.enc`.
- **Upload only when ALL are true:** Wi-Fi (unmetered network), charging, battery 80 percent or more. Use `WorkManager` with constraints `NetworkType.UNMETERED` + `setRequiresCharging(true)` and a battery check at run time (battery 80 percent or more; `setRequiresBatteryNotLow` is not enough). Retry with backoff. Resumable upload for large files. Mark `uploaded` only after Drive returns the file id and size matches; then delete the local file.
- The encrypted file is uploaded **as ciphertext**. Drive never sees plaintext. The user decrypts only on their own devices; ship a tiny documented decrypt step or desktop tool path (a Node script under `apps/cli`) only if the PR stays small; otherwise note it as follow-up. Tell the user in the PR that without it the Drive copies are not playable elsewhere. **Ask the user** which they prefer (encrypted-at-rest in Drive vs plaintext in Drive) before building; default encrypted.
- Provider is behind an interface `BackupProvider { upload(file, meta) ; delete(id) }` so another cloud can be added later. Only Drive is implemented.
- Token storage: refresh/ access tokens in the existing `SecureCredentialStore` pattern, never in prefs, logs or git.

### 2.5 Setup UI and consent

- `sensorConsent.ts`: new key `speech_recording` (consent key like `typed_text`, not in SENSORS), `setSpeechRecording`, state field `speechRecording`, copy per section 0.
- Setup: switch (disabled unless master and `mic_speech` are on), Google account connect/disconnect, backup status (`N waiting, last upload <time>`), storage used, "Delete all recordings".
- Playback: out of scope. Do not build a player. Only list sessions (time and length) in a `/recordings` page; playback is a follow-up needing the fingerprint unwrap.
- A visible indicator: a persistent low-priority notification is NOT used (no foreground service). Rely on Android's mic indicator. State this in the copy.

### 2.6 Events

`mic_window` allowlist gets: `sessions` (count), `session_ms` (total), `recorded_ms`. No file names, ids or paths. Update `NativeTelemetrySync.V3_KEY_ALLOWLIST` and the daemon round-trip test.

## 3. Tests (all required)

Android JVM, with fakes (same style as `MicWindowSamplerTest`):
- Speech then silence: session continues through chunks, ends after exactly 60 s of non-speech, file finalized.
- Speech resumes at 59 s: session continues. At 61 s: ended.
- 30 min and 2 h caps. Mid-session gates (screen off, call, mic busy, low battery, low storage, pocket, silenced, abort/consent off) each stop the session and finalize or delete the file correctly.
- Buffer zeroed after every chunk, including on exceptions. Files are encrypted: bytes on disk contain no WAV header magic.
- Retention: 48 h expiry, delete-after-upload, delete-all.
- Upload worker: runs only under Wi-Fi + charging + 80 percent; fails closed otherwise; resumes; marks uploaded only on size match; ciphertext only.
- Allowlist: no non-allowlisted key in `mic_window`.
Mobile vitest: `sensorConsent` (new key, master-off forces off, copy), Setup rendering of the new controls.
Phone checks (list in the PR, user runs them): S3-6 record a short spoken test sentence and confirm one session of the right length; S3-7 silence 61 s ends it; S3-8 pocket start blocked; S3-9 upload when charging on Wi-Fi at 80 percent+; S3-10 `run-as ... ls` shows only `.enc` files, no plaintext.

## 4. Do not

- Do not send audio, transcripts, file names or sizes to the daemon, logs or events.
- Do not use external storage, MediaStore or a foreground service.
- Do not request a Drive scope wider than `drive.file`.
- Do not change phone permissions or switches, uninstall, or clear app data. Install with `adb install -r -d` only. Do not commit phone backups or tokens.
- Do not enable `speech_recording` by default or auto-enable it from other switches.

## 5. Process

Two PRs to `main`: (1) pocket gate; (2) speech-session recording. For each: `cd apps/mobile && npx tsc --noEmit && npx vitest run`; `cd apps/mobile/android && JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew --offline testDebugUnitTest`; `cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/v3-sensitive-signals.test.ts`. Wait for CI (`check`, `docker-isolation`), then merge. Report results honestly, including anything not verified on the phone.
