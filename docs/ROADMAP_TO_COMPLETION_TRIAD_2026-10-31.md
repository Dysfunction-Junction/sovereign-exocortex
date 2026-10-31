# Master Completion Roadmap: Sovereign Exocortex On-Device Intelligence (A5 & SP-2)

**Author:** Advisory Council (Claude / Chief Architect via Autonomous Triad)  
**Implementers:** Codex (Algorithmic / JNI / Core) & Antigravity (Executive Engine, Build/Test, Context Ingestion)  
**Target:** `C:\Users\micha\projects\sovereign-exocortex`  
**Reference Specs:**  
- [`docs/SPEC_GEMMA_SUMMARIZER_2026-10-30.md`](file:///C:/Users/micha/projects/sovereign-exocortex/docs/SPEC_GEMMA_SUMMARIZER_2026-10-30.md)  
- [`docs/SPEC_GEMMA_LITERTLM_SPIKE_2026-10-31.md`](file:///C:/Users/micha/projects/sovereign-exocortex/docs/SPEC_GEMMA_LITERTLM_SPIKE_2026-10-31.md)  

---

## 0. Non-Negotiable Invariants & Flags Before Work Starts

1. **Speech Session Definition:** Android 14+ requires a foreground service of type `microphone`, displays the system mic indicator, and blocks background capture. Call audio is not capturable. Speech capture is strictly user-initiated, visible capture (e.g., Quick Settings tile / in-app memo button). Never ambient.
2. **Mechanically Enforced Zero-Text Telemetry:** A policy document is not sufficient. An automated canary test must type/speak a synthetic unique string and verify zero hits in logcat, bugreports, SQLite DBs, WAL files, daemon payloads, the artifacts table, and the world-model graph endpoints.
3. **Untrusted Gemma Input:** Raw typed and spoken text can contain adversarial prompt injection. The summarizer has zero tools, zero network egress, and output is strictly schema-validated.
4. **Frozen Pass/Fail Gates:** Numeric thresholds, measurement methods, and pre-declared fallback ladders are frozen in code before spikes execute.
5. **Serialized Device Runs:** A5-2 thermal/battery benchmarks and SP-2 speech evaluations share the Samsung Galaxy S26 Ultra (`SM-S948U1`). They must run sequentially, never concurrently.

---

## 1. Milestone M1: PR A5-2 Hardware Spike (`spike/gemma-litertlm`)

**Branch:** `spike/gemma-litertlm` (throwaway branch; findings inform M2).  
**Hardware:** Samsung Galaxy S26 Ultra (`SM-S948U1`, SoC `SM8850`, 15.4 GB RAM).  

### Quantitative Hard Gates (G1–G8):
| Gate | Metric | Target Threshold | Method |
|---|---|---|---|
| **G1 Integrity** | Tamper rejection & valid file acceptance | 4/4 rejected, 1/1 accepted | `ModelProvisionerTest` |
| **G2 Init** | Cold init latency p95 | $\le 10$ s | 10 cold runs |
| **G3 Memory** | Peak process PSS during inference | $\le 1.8$ GB | `dumpsys meminfo` under pressure |
| **G3b Leak** | Retained PSS after release (10 cycles) | $\le \text{baseline} + 100$ MB | `dumpsys meminfo` post-release |
| **G4 Latency** | 256-tok in / 64-tok out p95 | $\le 20$ s (0 timeouts at 30s) | 60 nominal runs |
| **G5 Stability** | Crashes / ANRs / LMKD kills / Wedged | **0** | 200 inferences + 20 init cycles |
| **G6 Thermal** | Tok/s degradation; peak thermal status | $\le 40\%$ drop; never $\ge \text{SEVERE}$ | 100 sustained runs |
| **G7 Privacy** | Post-guard L0–L2 canary leaks; network egress | **0 leaks**; $\approx 0$ bytes egress | Synthetic canary corpus + airplane mode |
| **G8 Utility** | Harmless prompt parse & schema pass rate | $\ge 90\%$ | Synthetic H-class set |

**Pre-Declared Fallback Ladder:**  
If CPU Gemma 3 1B IT int4 fails hard gates:  
1. Trial isolated process `android:process=":llm"` (contained bound service).  
2. Evaluate smaller Gemma 3 variant (e.g., 270M).  
3. Extractive non-LLM summarizer.  

**Exit Deliverable:** `docs/SPIKE_RESULTS_2026-10-31.md` with measured numbers and signed-off GO / CONDITIONAL / NO-GO decision reviewed by Claude.

---

## 2. Milestone M2: PR A5-3 Production Gemma Integration

**Branch:** `feat/a5-gemma-summarizer` (fresh branch re-implementing clean code based on M1 findings).  
**Components:** `BundledSummarizer`, `ModelProvisioner`, `LiteRtEngine`, wiring into `TypedTextSummaryQueue`.

1. **Production ModelProvisioner:**
   - Model delivered via sideload staging (`getExternalFilesDir("models/staging")`).
   - Hash checked against compile-time pin in APK.
   - Streamed write, `fsync`, atomic rename, read-only chmod, and purge of staging file.
   - Resumable; corrupt models are deleted immediately.
2. **Production LiteRtEngine:**
   - Single-flight mutex: one inference at a time on memory-bound model.
   - Explicit lifecycle: lazy background load, 60s idle unload, and `onTrimMemory` release.
   - Hard input token cap (1024), output cap (64), 30s wall-clock deadline.
   - Never cancel from a path leaving native state corrupt; cooperative cancel + engine reset.
3. **BundledSummarizer:**
   - Wraps input in delimiters, declaring text as data rather than system instructions.
   - Schema validation via `SummaryGuard` (intent, topic vocabulary, entity types, length cap, digit/quote/name echo stripping).
4. **Queue Scheduling & Privacy Cleanliness:**
   - Bounded queue (4 items). Raw text deleted immediately upon commit or fail TTL.
   - `TypedTextGate.turnOff()` executes under synchronous `COMMIT_LOCK`, invalidating pending commits and calling terminal `close()`.
5. **Production Build & Battery Verification:**
   - R8 release build with JNI keep rules for `arm64-v8a` only.
   - Backup exclusion: `allowBackup="false"` with `models/` explicitly excluded.
   - S5-11 Battery test: 24h on vs 24h off ($< 3\%$ battery per day budget).

**Exit Deliverable:** Full test suite green ($\ge 123$ Android + $\ge 284$ Vitest tests), release build on SM-S948U1, battery attribution verified.

---

## 3. Milestone M3: PR SP-2 Speech Session Summaries

**Branch:** `feat/speech-session-summaries`  
**Components:** Audio capture foreground service, streaming recognizer, rolling summarizer, `speech_session` DB table, biometric audit UI.

1. **Q1 Speech Recognizer Evaluation (3-Way Comparison on SM-S948U1):**
   - **Option A:** Android on-device `SpeechRecognizer.createOnDeviceSpeechRecognizer` (offline check, restart-gap word loss measurement).
   - **Option B:** `sherpa-onnx` streaming zipformer int8 (natively streaming, continuous).
   - **Option C:** `whisper.cpp` (whisper-tiny / base int8, chunk-and-overlap boundary handling).
   - *Selection Criteria:* Word Error Rate (WER), Real-Time Factor (RTF), battery consumption per audio-minute, and zero network egress.
2. **Pipeline Invariants:**
   - Raw audio held strictly in RAM ring buffer. **Zero raw audio bytes written to disk.** Verified via pre/post filesystem diff.
   - Streaming transcript buffered in memory; summarized incrementally in rolling $N$-minute chunks to maintain bounded context and RAM.
   - Transcript deleted immediately upon note commitment.
3. **Encrypted Storage (`speech_session` table):**
   - Stored in `typed_summaries.db` under the existing AES-256-GCM / biometric RSA-OAEP KEK architecture.
   - Columns: `id, start_time, end_time, duration, ct (encrypted JSON), app_category, topic_ids`. **Zero raw transcript column.**
4. **Kill Switch & Consent:**
   - `TypedTextGate.turnOff()` also terminates active speech capture and zero-fills audio and transcript buffers.
   - Persistent foreground notification + in-app disclosure.

**Exit Deliverable:** $\ge 30$-minute uninterrupted speech session completes within memory budget; zero audio/transcript on disk; biometric audit screen displays decrypted speech session notes.

---

## 4. Milestone M4: World Model & Daemon Convergence

**Branch:** `feat/world-model-signal-convergence`  
**Components:** Android V3 event emitter, daemon receiver, world-model store topic edges.  
**Depends on:** Phase 3 of [`docs/PLAN_WORLD_MODEL_STORE_2026-10-31.md`](PLAN_WORLD_MODEL_STORE_2026-10-31.md), which provides the vocabulary artifact (`topic_num`, `vocab_sha256`) and the `GraphStore` port. Neo4j is being retired.

1. **Passive Signal Contract (Zero-Text Telemetry):**
   - Event payload:
     ```json
     {
       "event_type": "summary_generated",
       "session_id": "uuid",
       "ts_bucket": 1730386800000,
       "duration_bucket": 60,
       "app_category": "notes",
       "topic_ids": [412, 1089],
       "vocab_sha256": "<sha256 of the vocabulary artifact>",
       "summarizer_version": "gemma3-1b-it4-v1",
       "source": "typed"
     }
     ```
2. **Closed Vocabulary Mapping:**
   - Free-form summary strings **never** flow into the daemon or the world-model store.
   - Summary is mapped on-device to the existing 8,157-topic vocabulary using cosine similarity against topic embeddings.
   - `topic_ids` are `topic_num` values from the vocabulary artifact. The payload carries `vocab_sha256`, and the daemon rejects ids from any other vocabulary version.
   - The on-device embedding table is keyed by `topic_num` and carries the same `vocab_sha256`.
   - Topics below confidence threshold are omitted; maximum 5 topics per event.
3. **No Content-Derived Hashes:** Plain hashes of user text are vulnerable to dictionary attacks; only random UUIDs and closed topic IDs are emitted. `vocab_sha256` is the only hash allowed: it hashes the public vocabulary artifact, never user content, and must be added to the daemon payload allowlist with a test that rejects a mismatched vocabulary version.
4. **World-Model Store Schema:**
   - `ABOUT` edges in the world-model store, projected from the M4 event to the topic.
   - Zero free-text properties. A test over a `GraphStore` port snapshot fails if any property on new entities exceeds allowlisted string lengths.
5. **Shadow Window:** Emitted events run in shadow mode for 7 days before feeding proactive suggestions.

---

## 5. Autonomous Triad Execution Protocol

| Milestone | Claude (Chief Architect) | Codex (Implementer) | Antigravity (Executive Engine) |
|---|---|---|---|
| **M1: A5-2 Spike** | Invariants, gate criteria, diff review | LiteRT-LM bridge, JNI interop, benchmark harness | Workspace orchestration, device runs, test self-healing |
| **M2: A5-3 Production** | Production schema, blocking diff review | Engine, ModelProvisioner, queue integration | Compiler verification, R8 release builds, battery runs |
| **M3: SP-2 Speech** | Q1 eval protocol, legal consent invariants | Audio buffer, recognizer adapter, rolling worker | Audio fixtures, device benchmark runs, UI testing |
| **M4: Convergence** | Payload schema, closed vocab contract | Emitter & mapper implementation | Daemon/world-model test suites, canary verification, git sync |

### Process Guardrails:
- Claude's pre-commit review is a **blocking gate** for any code touching text capture, storage, or telemetry.
- Self-healing loops in Antigravity or Codex are strictly forbidden from relaxing thresholds, modifying test assertions, or altering the evaluation corpus.
- Full pushed git history is audited for credentials before every push.

---

## 6. Definition of Done (Project Finalization)

1. [ ] **A5-2 Spike Completed:** `docs/SPIKE_RESULTS_2026-10-31.md` recorded with all 8 hard gates measured on SM-S948U1 and approved by Claude.
2. [ ] **A5-3 Production Deployed:** Release APK running on device summarizes typed text offline with verified SHA-256; battery impact $< 3\%$/day.
3. [ ] **SP-2 Speech Completed:** Recognizer chosen via data (WER, RTF, battery); $\ge 30$-minute session finishes within budget; zero audio or transcript on disk.
4. [ ] **Automated Canary Test Passing:** Synthetic unique canary string typed and spoken; verified 0 hits across logcat, bugreport, SQLite WAL, daemon logs, the artifacts table and the world-model graph endpoints.
5. [ ] **Network-Deny Verified:** Airplane mode verified; zero socket egress during summarization and transcription.
6. [ ] **Kill-Switch Verified:** 7-step kill switch stops capture, wipes RAM buffers, and zero-fills active KEKs.
7. [ ] **Prompt-Injection Resilient:** Adversarial prompts produce zero tool execution, zero data leakage, and valid JSON or safe rejection.
8. [ ] **Daemon & Graph Clean:** Payload allowlist strictly enforced; the world-model store contains zero free-text properties, tested over a port snapshot.
9. [ ] **Green Test Suites:** $\ge 123$ Android unit tests, $\ge 284$ Vitest tests, and daemon tests green with 0 TypeScript errors.
10. [ ] **Documentation Complete:** Final handoff, runbooks, and memory index updated.
