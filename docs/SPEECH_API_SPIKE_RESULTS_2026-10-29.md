# Synthetic speech and Nano spike — 2026-10-29

S3-11 / S5-1, run once per API at 21:34:48 CDT from the accessibility service's debug-only shell trigger. User confirmed readiness. `dumpsys window` showed Wyze (`com.hualai`) on top before and after; `dumpsys power` showed Awake before the trigger. No microphone was opened by the spike, no real text was read, and all model output was discarded.

## Results

| API | SDK / status | Exact error | Elapsed |
|---|---|---|---|
| Gemini Nano prompt | `genai-prompt:1.0.0-beta1`, status 3 = AVAILABLE | `AICore failed with error type 2-INFERENCE_ERROR and error code 30-BACKGROUND_USE_BLOCKED: Inference failed.` | 250 ms |
| ML Kit advanced speech | `genai-speech-recognition:1.0.0-alpha1`, status 1 = DOWNLOADABLE | `Speech recognition engine is closed due to internal error: ERROR_TYPE_SODA` | 168 ms |

Status constants were verified with `javap` on the resolved `genai-common:1.0.0-beta3` AAR. The speech model was not ready and no download was requested; its error does not establish whether prepared speech recognition can run in the background. No platform recognizer fallback was attempted. The Nano error is a direct confirmation of the background inference restriction for the tested SDK/device state.

Prompt input: fixed synthetic sentence about planning a walk. Speech input: one second of generated silence, raw 16 kHz mono PCM16, supplied through an in-memory pipe (no file). Silence would not establish transcription quality even if accepted.

Per-call charge counter before and after: **2,005,000 µAh**, unchanged for each API. Battery level was 40% before and after; reported temperature was 29.5°C before and 29.4°C after. These brief, concurrent-device measurements do not isolate energy use by the spike.

## Disposition

Stopped after the one-shot calls. Part 2 is blocked on the user choosing a fallback for Nano; no bundled-model substitution, deferred-input storage, real audio capture, or session-summary implementation was added. Pocket work stays parked with the original 300 ms gate. Debug log commit `6b14675` is pushed; spike changes and this report are not yet committed. No PR opened.

## Sources

- https://developers.google.com/ml-kit/genai/speech-recognition/android — advanced-mode supported devices and audio input.
- https://developers.google.com/ml-kit/genai/prompt/android/get-started — prompt API.
- https://developers.google.com/ml-kit/genai — foreground inference restrictions.
