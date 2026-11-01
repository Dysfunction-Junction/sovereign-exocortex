# Android capture handoff — 2026-10-29

- Main was at `0ffa7c1`; an existing untracked `.claude/` directory was left alone.
- The speech-session spec rev 2 supersedes the earlier Gemma choice: use onboard Gemini Nano and perform the required foreground/background spike before Part 2; stop and ask the user for a fallback if blocked. Messenger, Discord, social apps and the dialer remain excluded from typed-text capture.
- The daemon received mic and place windows. Places reported `wifi_connected`. Earlier mic windows had `unknown` pocket-gate skips; later windows had valid samples. The user confirmed the phone was pocketed for 10–15 minutes; audio diagnostics showed a five-second recording at 15:43:49 and the 15:40–15:45 window had zero pocket skips. S3-3 failed. Investigate the gate and sensor behavior before changing it; background capture with another app on top remains unverified.
- On `fix/mic-pocket-gate`, a debug-only numeric log was already present. Pocket and hand-held readings with the 300 ms gate all missed proximity; lux overlapped, and Samsung's `SSENSOR` is signature/privileged. See the design's phone results. The working tree now extends the wait to one second, but that APK has not been installed and the user deferred the repeat phone measurements. This is not a verified fix. Android JVM tests and build passed; mobile and daemon typechecks and the daemon sensitive-signal test passed. The full Vitest run stalled both inside and outside the sandbox and was stopped. No PR or merge was completed.
- A5 is still a stub. Part 2 of the speech spec is blocked until the pocket fix and the required inference spike; share A5's guard and store rather than creating a second one.
- Do not uninstall or clear app data, change phone permissions or switches, or commit phone backups. Preserve the user's untracked files.

## Revised spike work

- User parked the pocket gate. The experimental one-second wait was reverted to 300 ms; only the pre-existing debug log was committed and pushed as `6b14675` on `fix/mic-pocket-gate`. This supersedes the earlier uninstalled one-second-build note above.
- A debug-only synthetic spike was built and installed with `adb install -r -d`. It registers a shell-permission-protected one-shot receiver from the accessibility service. Its text prompt is fixed and its PCM input is generated silence through a pipe; it never opens the microphone or reads accessibility text.
- The installed service logged `SpeechApiSpike: READY synthetic_only one_shot`. Neither API has been triggered yet: waiting for the user to open another app with the screen on and confirm readiness. The spike records exact errors, latency and per-call charge counters, discarding output. A silence-only success would not establish transcription quality.
- Current Google guide: https://developers.google.com/ml-kit/genai/speech-recognition/android lists the S26 family for advanced speech recognition. SDK `1.0.0-alpha1` Java signatures were verified from the downloaded AAR. No fallback, Part 2 implementation, PR or merge has been performed.

## Spike completed

- At 21:34:48 CDT, with Wyze on top and screen awake, Nano returned `30-BACKGROUND_USE_BLOCKED` in 250 ms. Advanced speech reported DOWNLOADABLE, then `ERROR_TYPE_SODA` in 168 ms. Its model was not ready; speech background support remains unverified. Per-call charge counter stayed at 2,005,000 µAh. See `SPEECH_API_SPIKE_RESULTS_2026-10-29.md` for exact errors, method and limits.
- Stopped per the spec. Await the user's fallback choice; do not continue Part 2 or retain inputs. The earlier pending-trigger note is superseded by these results. The trigger was one-shot and unregistered itself.
