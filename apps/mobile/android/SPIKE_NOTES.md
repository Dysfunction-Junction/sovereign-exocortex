# A5-2 LiteRT-LM integration (2026-10-31)

Status: implementation builds; **NO-GO pending model SHA-256 and physical-device measurements**.
The user supplied `ModelSpec.EXPECTED_SIZE = 584417280` for
`litert-community/Gemma3-1B-IT/gemma3-1b-it-int4.litertlm`. `EXPECTED_SHA256` remains empty
until the licensed file is downloaded and hashed by the user. No model was downloaded.
Per the user's updated instructions, offline unit tests inject synthetic model specs and
verify that empty or invalid hashes disable provisioning and loading. They do not require
the real model or fabricate its pin. The bridge resolves its model path only after load
verification, so constructing an unconfigured summarizer does not throw for the missing pin.

## Pinned API evidence

Inspected the Google Maven 0.18.0 AAR (including `classes.jar` using `javap`, manifest,
and arm64 ELF), its POM, and the upstream `v0.18.0` sources:

- [Engine.kt](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/kotlin/java/com/google/ai/edge/litertlm/Engine.kt)
- [Config.kt](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/kotlin/java/com/google/ai/edge/litertlm/Config.kt)
- [Conversation.kt](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/kotlin/java/com/google/ai/edge/litertlm/Conversation.kt)
- [Message.kt](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/kotlin/java/com/google/ai/edge/litertlm/Message.kt)

AAR SHA-256: `706cbb8a87739b2818111bf3a19a78b8f7781586d10f80adf3415581fab7595f`.
The sources JAR is not published at Google Maven (404); source review used the pinned tag.

Actual calls confined to `LiteRtBridge.kt`:

```text
Engine(EngineConfig(modelPath, Backend.CPU(), maxNumTokens = 1024, cacheDir = ...))
Engine.initialize(): Unit
Engine.createConversation(ConversationConfig): Conversation
ConversationConfig(samplerConfig = SamplerConfig(topK, topP, temperature, seed),
                   automaticToolCalling = false, maxOutputToken = 64)
Conversation.sendMessage(String): Message
Message.toString(): String  // contents only, not a diagnostic object dump
Conversation.cancelProcess(): Unit
Conversation.close(): Unit
Engine.close(): Unit
Engine.setNativeMinLogSeverity(LogSeverity.INFINITY)
```

`Backend.CPU` is constructed, and `maxOutputToken` is singular. Each generation creates
and closes a new conversation. Cancellation is the library's cross-thread escape hatch;
init, generation, conversation disposal, and engine disposal stay on `litertlm-owner`.
The AAR metadata is `mv=[2,4,0]`; its POM pins kotlin-reflect 2.4.0, Gson 2.14.0, and
coroutines-android 1.11.0. Kotlin Gradle plugin 2.4.0 compiles the bridge successfully
with JVM 21. Gradle 8.14.3 is supported but emits a future-deprecation warning.

## Implementation boundaries

- The production capture pipeline stays model-free; enabling the engine in production is A5-3.
- Supply `filesDir`, `getExternalFilesDir(null)/models/staging`, and a reliable
  engine-initialized predicate to `ModelProvisioner`. Call `cleanup()` at startup before
  engine creation. Load verification also cleans stale artifacts before an uninitialized load.
  Release an existing engine and wait for UNINIT before importing; active engines refuse import.
- The provision lock combines a process-wide reentrant lock and an OS file lock. The lock
  file persists, while the kernel releases its lock on process death; no stale sentinel blocks imports.
- Copying hashes the same 1 MiB buffer that is written, fsyncs, atomically installs the
  read-only model, purges staging, then atomically writes the manifest. No sidecar means no load.
- Every load checks sidecar pin, size, and mtime. A fresh provisioner rehashes, including after
  reboot or app upgrade (Android restarts the app process). Subsequent unchanged loads reuse
  the process-local verification. Keep one provisioner per engine lifecycle.
- Prompt admission conservatively bounds UTF-8 bytes to 832, reserving 64 output tokens and
  128 framing tokens within 1024 total. This can reject text that would tokenize more compactly;
  it never truncates. Native context limits remain enabled.
- A 100 ms monitor samples process PSS and thermal status and releases on budget violation.
  Sampling is a protective mechanism, not proof that peak PSS stays below 1.8 GB.
  The hardware measurement gate is still mandatory.
- Timeout waits are capped at 30 seconds, followed by up to two seconds of cancellation grace.
  An actual task-exit latch distinguishes native completion from a cancelled Future. A wedged
  backend never reinitializes; queued disposal runs only if the owner thread eventually returns.
- Kill-switch shutdown calls terminal `close()` without waiting for the inference lock. Existing
  gate/generation checks still prevent late output from being stored.

## Validation

- Baseline JVM tests passed before changes.
- `gradlew.bat testDebugUnitTest --offline`: synthetic provisioning fixtures require no real model;
  all 144 tests pass with the production SHA-256 unset.
- Lifecycle tests cover owner-thread confinement, lazy init, partial-init failure, invalid
  manifests, available-memory refusal, PSS release, thermal backoff, low power, idle release,
  contention, cancellation, wedging, terminal close, and the queue shutdown integration.
- Provisioning tests cover a multi-chunk valid import, four tamper variants, restart rehash,
  sidecar removal, concurrent import, active engines, noncanonical paths, and stale cleanup.
- `NoNetworkInvariantTest` scans actual pipeline Java/Kotlin sources and compiled nested
  classes, plus future `typedtext/llm` and `typedtext/provision` paths. It rejects the specified
  networking references and reflective/process escape APIs. This is a scoped static invariant;
  it cannot prove native dependency behavior. Runtime UID traffic measurements remain pending.
- `gradlew.bat --write-verification-metadata sha256 help :app:assembleDebug :app:bundleRelease`
  passed. Verification metadata includes the AAR, compiler, and resolved transitive artifacts.
  Normal test builds also enforce verification without regenerating metadata.
- Merged debug manifest permission comparison: no additions or removals. The app already
  declares INTERNET for other features; the new AAR declares no permissions.
- Debug APK contains only arm64-v8a native libraries and no `.litertlm` assets.
  Its LiteRT-LM PT_LOAD alignments are all `0x4000`; `zipalign -P 16 -c 4` passed.
- Release bundle built; no `SpikeActivity` references in its manifest or dex files.
  R8 keep rules protect the LiteRT-LM/JNI package; release minimization remains disabled
  by the existing app configuration, so an R8-minimized hardware run is not claimed.
- No ADB device is attached. S5-6 through S5-11, 0.17.1 regression comparison, native
  logging/canary sweep, runtime traffic, memory peaks, thermal/latency/battery measurements,
  and the synthetic debug activity/corpus harness remain unexecuted or unimplemented.
  No hardware GO decision is claimed by these JVM and packaging checks.
