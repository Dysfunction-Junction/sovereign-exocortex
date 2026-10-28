# Sovereign Exocortex — Finish Line Plan

> Point-in-time snapshot of the Claude Docs plan (rev 20, 2026-10-28). Status overrides since then: PR #18 and PR #19 are open and validated, not yet merged; rows 3.1-3.2 are verified on the PC (triage :8080, embeddings :8081, vision :8082 healthy; vision about 13 s warm on CPU). Ollama must stay up until `packages/triad` (advisor/intent engine) and the home proxy `/mobile/ask` fallback move to llama.cpp. If this file and the code disagree, the code wins.

Oct 28, 2026 · @Michael Joseph Gabriel Hebert

The exocortex is done when one risk tier leaves shadow mode on real data, with the ingestion bus, deterministic gate and inference layer closed. That takes 20 actions across five phases; Phase 0 and the label clock can start today.

## Where it stands

On `main` (commit `e8afbdd`), the device ingest path and the approval gate are solid. Channel ingestion, inference coordination and live rollout are the open work.

| Area | Built and verified | Still open |
| --- | --- | --- |
| Ingestion bus | `POST /v3/events`: scoped auth, device binding, idempotent `event_id`, dedupe, hash-chained `ingestBatch` | Gmail/Notion/Obsidian content skips the log (audit event only); post-ingest hooks run synchronously inside the request |
| Deterministic gate | `/network/delegate` is admin-only, refuses `approve`/`reject` (403), shadow-blocks `hermes-api` and mutating mesh actions (423) | No per-action capability map for the other 6 nodes; morphogenetic sandbox gates incomplete |
| Inference | Triage on CPU llama.cpp (Qwen3 1.7B, :8080) with a watchdog; embeddings (`nomic-embed-text`) and vision (`llava`) on Ollama (:11434) | Two runtimes, no coordinator; the triage model file lives inside Ollama's blob store |
| Shadow rollout | Recorder, tap labels, inferred outcomes, shadow evaluator, prediction log | No tier has left shadow; live label count not checked (needs the running daemon) |
| Tests | Workspace typecheck clean; 1,756 tests pass on Node 24 | 2 environment-dependent failures after PR #18 (Obsidian vault, Git 2.43) |
| CI | — | No GitHub Actions workflow; nothing runs on PRs |

## Finish line

Done means all six of these hold at once, checked by evidence rather than a status report.

1. **Shadow gate passed for one tier:** Precision@surface ≥ 0.90 over 14 consecutive days, ≥ 50 direct tap labels, and a positive gap over the frequency baseline (`docs/SHADOW_EVALUATION_RUNBOOK.md`).
2. **Real hardware approval:** the phone-to-execution path completes with a real action, not only `diagnostic_probe` (`docs/DEVICE_TEST_RUNBOOK.md`).
3. **Fully replayable:** wiping every projection and replaying the event log rebuilds the life graph, beliefs and channel entities identically.
4. **Nothing acts outside the gate:** every delegate node and action resolves through a default-deny capability map; routine actions run as scripted handlers, not LLM output.
5. **One owner for local models:** a single coordinator schedules triage, embeddings and vision, and survives a reboot without manual steps.
6. **CI green on every PR:** typecheck plus all TypeScript and Python suites on Node 24.

## Roadmap

&#91;embedded content: roadmap · 5 phases, 1 gate\]

Build work runs Phase 0 through 3 in order. The 14-day label clock runs underneath from today, so it is not waiting on the build. Both must clear the shadow gate before T0 goes live.

## Who builds what

Antigravity and Sonnet do the building. Opus works as an advisor: it designs Phase 1's schema and reviews the security-sensitive PRs, and does none of the bulk coding. Calling it only at those checkpoints keeps its token use small and puts the costly model where a mistake can't be undone.

| Work | Builder | Opus advisor checkpoint |
| --- | --- | --- |
| Phase 0 (0.1–0.8), revoke the 2 unknown devices | Antigravity | None |
| 4.0 daily review screen | Antigravity | None |
| 1.1 channel event schema + the email-body decision | Opus designs | The design is the deliverable; builders start from it |
| 1.2–1.6 ingestion build | Antigravity, from the Opus spec | Review the replay test and the PR before merge |
| 2.1–2.2 delegate capability map | Sonnet | Review default-deny and the scope table before merge |
| 2.3–2.5 scripted executors, morphogenetic flag, kill-switch drill | Antigravity | Review the 2.5 kill-switch test |
| Phase 3 inference | Antigravity | None |
| Phase 4 checks and evaluation | You, with Sonnet for status checks | None |

**Handoff rules for any builder:**

1. Give it this doc's link and one row number. One row per session, one PR per row, the row number in the PR title.
2. It must meet the row's "Done when" and run `pnpm typecheck` plus the changed package's tests on Node 24 before opening the PR.
3. It sets that row's Status: In progress at start, Done after merge, Blocked with a one-line reason.

**Escalate to Opus when a change:**

- touches the event schema, the event log, or anything replay depends on
- touches approval, delegate, attestation or `SHADOW` code
- can't be undone once merged or deployed
- fails the same test twice with no clear cause

**Advisor prompt (paste into an Opus session):**

```text
Act as advisor on sovereign-exocortex. Review PR #<n> against row <x.y> of the Finish Line Plan (<doc link>).
Check: meets the row's Done-when; no route acts outside the gate; nothing written to the event log that can't be replayed or must later be deleted.
Reply with: approve, or a numbered list of blocking fixes. Do not rewrite the PR.
```

## Phase 0 — Hygiene and CI

One evening of small fixes, so every later change is tested automatically. CI comes first because it guards every PR that follows.

| # | Action | Files | Done when | Est. | Status |
| --- | --- | --- | --- | --- | --- |
| 0.1 | Merge PR #18 (triage-label mock + README limits) | `apps/daemon/src/triage-labels.test.ts`, `README.md` | Merged; triage-labels 10/10 | 5 min | In progress |
| 0.2 | Add CI: Node 24, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, Python 3.10+ venv for triad | `.github/workflows/ci.yml` (new) | PR shows a green check | 1–2 h | Not started |
| 0.3 | Raise root `engines` to Node ≥ 24 to match `packages/mesh` | `package.json` | Node 22 warns on install | 5 min | Not started |
| 0.4 | Make the Obsidian lifecycle test build a temp vault | `apps/daemon/src/channels/obsidian-adapter.test.ts` | Passes on a machine with no vault | 20 min | Not started |
| 0.5 | Make `checkout_argv` work on Git < 2.44 (drop `--end-of-options`, validate the commit as a hex SHA instead) | `packages/triad/triad/bench/docker_harness.py` | Test passes on Git 2.43 | 20 min | Not started |
| 0.6 | Tag `person:` entities with their source channel; purge by tag on disconnect | `channels/gmail-adapter.ts`, `channels/channel-manager.ts` | Gmail disconnect leaves 0 Gmail-created entities | 1 h | Not started |
| 0.7 | Clear mobile lint warnings: use-before-init callbacks, `setState` in effect, `Date.now` in render | `apps/mobile/src/pages/Setup.tsx`, `LivingBrain.tsx` | `oxlint` clean | 1 h | Not started |
| 0.8 | Remove two more stale README notes: root `pnpm start` and the Tauri dev loop are both already fixed (pushed to PR #18) | `README.md` | Quick start matches the code | 5 min | Not started |

Already fixed on `main`, no action needed: the `/network/delegate` approval bypass, the `loggedAt`/`createdAt` archive mismatch, cold-start hydration (retried when the shadow recorder attaches), the root start script and `tauri.conf.json`.

## Phase 1 — Ingestion bus

Every signal, from the phone or a channel, enters through the event log, and everything downstream is a projection rebuilt from it. This closes your gap 2, and the later phases depend on it.

| # | Action | Files | Done when | Est. | Status |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Define channel event kinds (`channel.document.upserted`, `channel.entity.upserted`, `channel.disconnected`). Payload holds a content hash plus a databank blob reference, not raw bodies (see Risks) | `packages/core` event types, `channels/types.ts` | Schema and validation tests pass | 2 h | Not started |
| 1.2 | Adapters emit those events through `db.ingestBatch`; delete the direct `graph.addEntity` / `addEdge` calls | `channels/channel-manager.ts` (lines \~90–170) | No graph writes left in `channels/` | 3 h | Not started |
| 1.3 | World-model host projects channel events into the life graph | `world-model-host.ts` `onEventsAppended` | Graph is identical live or replayed | 2 h | Not started |
| 1.4 | Async consumer: post-ingest hooks read by a persisted `seq` cursor in a worker loop, off the request path | `server.ts` (\~760–790), new `ingest-consumer.ts` | `POST /v3/events` returns before hooks run; restart resumes from the cursor | 4 h | Not started |
| 1.5 | Replay test: wipe projections, replay the log, assert graph and beliefs match | new `replay.integration.test.ts` | Passes in CI | 2 h | Not started |
| 1.6 | One-time re-sync of existing channel data as events | `channel-manager.ts` resync | Entity counts match before and after | 1 h | Not started |

## Phase 2 — Deterministic gate

Models propose and typed code decides. This phase replaces the admin-only stopgap with an explicit map and gives routine actions scripted executors, closing your gap 3.

| # | Action | Files | Done when | Est. | Status |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Capability map: node × action → required scope, risk tier (T0–T4), shadow behavior; default deny | new `apps/daemon/src/delegate-capabilities.ts`, `network.ts` | Unknown action returns 403; a table test covers all 8 nodes | 3 h | Not started |
| 2.2 | Route `/network/delegate` through the map, then drop the admin-only stopgap | `server.ts` (\~2010) | Scoped non-admin devices reach only mapped T0 actions | 1 h | Not started |
| 2.3 | Scripted executors for every T0/T1 action (no LLM generation in the execute step) | `packages/mesh/playbooks.ts`, `playbook-tools.ts` | Each T0 action has a handler and a test | 4 h | Not started |
| 2.4 | Morphogenetic engine: flag defaults off, or add the missing gates (no-network container, diff-size cap, static and security scan, reproduction test) | `packages/triad/triad/morphogenetic.py` | Off by default, or every gate tested | 1 h / 2 days | Not started |
| 2.5 | Kill-switch drill: flipping `SHADOW=1` at runtime blocks every actuating route | `server.ts`, new test | Test proves no route acts with `SHADOW=1` | 1 h | Not started |

## Phase 3 — Inference

Put all local models under one runtime with one scheduler, before GPU layers are switched on. Recommendation: consolidate on llama.cpp, which already has the watchdog, and retire Ollama from the hot path. This closes your gap 1.

| # | Action | Files | Done when | Est. | Status |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Copy the Qwen3 GGUF to a dedicated models folder and repoint the keepalive | `apps/daemon/ops/ensure-llama-server.ps1` | Removing `qwen3:1.7b` from Ollama no longer breaks triage | 30 min | In progress |
| 3.2 | Serve embeddings and vision from llama.cpp (an embedding server for `nomic-embed-text`, a multimodal projector for vision) under the same supervisor | `packages/memory/embeddings.ts`, `vision-adapter.ts`, ops scripts | Ollama can be stopped with no feature loss | 4 h | In progress |
| 3.3 | Inference broker: one queue, priority triage > embed > vision, concurrency 1 on CPU, per-model memory budget when GPU layers are on | new `apps/daemon/src/inference-broker.ts` | Triage p95 latency holds while embeddings backfill | 4 h | Not started |
| 3.4 | Settle 1.7B vs 4B from collected triage labels. Proposed rule: switch only if urgent recall rises ≥ 10 points at < 5 s mean latency | `triage-label-cli.ts` | Decision recorded with N ≥ 100 labels | 1 h | Not started |

**3.1–3.2 in [PR #19](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/19):** one `llama-server` per role (triage `:8080`, embeddings `:8081`, vision `:8082`), with a watchdog that matches each process by port, plus a one-time script that copies the Ollama models into `llama.cpp\models`. Tests pass on Node 24. Before merging, the PowerShell scripts still need a parse check and a first run on the PC.

## Phase 4 — Leave shadow mode

The 14-day label clock is the longest pole, so 4.1 should start today, in parallel with Phases 0–3. Tiers go live one at a time, lowest risk first.

| # | Action | Files | Done when | Est. | Status |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Confirm labels are accruing: daemon up with `SHADOW=1`, phone enrolled, evaluator shows new rows daily | `packages/core/shadow-report-cli.ts` | Report shows labels from the last 24 h | 30 min | Blocked |
| 4.2 | Collect ≥ 50 direct taps over 14 days (about 4 a day) | Mobile quiet notifications | Count ≥ 50 | 14 days | Not started |
| 4.3 | Run the device runbook with a real T0 action, not only `diagnostic_probe` | `docs/DEVICE_TEST_RUNBOOK.md` | Biometric approval executes and the outcome is logged | 1 h | Not started |
| 4.4 | Evaluate: Precision@surface ≥ 0.90 and a positive baseline gap | `docs/SHADOW_EVALUATION_RUNBOOK.md` | Report saved with the decision | 30 min | Not started |
| 4.5 | Go live on T0 only; rollback is `SHADOW=1` | `server.ts` tier config | 7 days live with no unwanted action | 7 days | Not started |
| 4.6 | Repeat 4.2–4.5 for each higher tier | — | Each tier passes its own gate | per tier | Not started |

**Status check, Oct 28 (from your PC):** the daemon is up in shadow, but the label clock is effectively at zero.

- **Labels stalled.** 19 labels exist (first Oct 9, last Oct 23). The 14-day window has 0 direct taps; its 8 labels are all inferred, so Precision@surface is n/a.
- **Volume is the real blocker.** Only 8 proposals surfaced in 14 days, about 0.6 a day. Even tapping every one, reaching 50 direct labels takes about 12 weeks.
- **Fix (new step 4.0):** add a once-a-day review screen in the phone app that lists every shadow proposal, gated ones included, for one-tap labelling. That lifts labels to the proposal rate (27 so far), not the surfacing rate. Confirm with the runbook whether gated-proposal labels count toward the gate.
- **Phone link:** the S26 Ultra's newest event is Oct 27, 14:22. Check that quiet notifications are arriving.
- **Two unnamed devices** (`a4d55d96…`, `edd825ff…`) are still active with no recent events. Revoke them with `revoke-cli.ts` unless you know what they are.
- **Ollama is down.** Embeddings are silently falling back to keyword overlap and vision is off. That's another reason for step 3.2 (move everything to llama.cpp).
- **Triage data for 3.4 is accumulating:** 780 verdicts from `qwen3:4b`, 308 from `qwen3:1.7b`. The decision still needs your hand labels in `triage_labels`.

## Next level

The finish line gets you a system that works. These six turn it into one you trust and lean on daily. A code search on `main` found none of them built yet. Start with **explain every proposal**: it makes your taps more informative, which shortens Phase 4 itself.

| Upgrade | What it is | Why it matters | Builds on |
| --- | --- | --- | --- |
| Explain every proposal | Each surfaced proposal shows its why: the graph path that lit it up, its expected-free-energy score, and the baseline it beat. "Not wanted" taps get a one-tap reason (wrong time, wrong thing, already done) | Trust is the real gate out of shadow. Reasoned labels teach the model faster than yes/no | `policy-ranking.ts`, `POST /v3/shadow/labels` |
| One memory, one database | Move long-term memory out of JSONL token overlap into the same SQLite file with a vector extension; search blends vector match, graph neighbors and recency | One store, one backup, one replay. Retrieval quality jumps from keyword-ish to semantic-plus-context | `packages/memory`, `packages/core/db.ts`, life graph |
| Eval CI on your own life | Every model or config change replays the last 30 days of events and must not worsen log loss, Brier score or Precision@surface | Stops silent regressions like the triage mock break. Your backtests already exist; this makes them a merge gate | `docs/*_BACKTEST_*.md`, `prediction-log` |
| Commitment tracker | Pull promises out of what you send ("I'll call him tomorrow") as events with due dates; surface them as T0 reminders | This is the ADHD safety-net job the triage prompt names, with low risk and high daily value | Triage host, telemetry events, follow-up delivery |
| Voice capture lane | Push-to-talk on the phone becomes a transcribed note event, triaged like any other signal | Matches how you already work (voice-to-text) and removes typing friction | Mobile app, `POST /v3/events` |
| Encrypted event log + retention | Encrypt the SQLite event log at rest (the databank already is); per-channel retention rules | The log holds your whole life and is append-only, so it has to be locked down before it holds more | `packages/core/db.ts`, `packages/databank` |

Also worth an audit pass: the 8 sibling repos (`hermes-api`, `autonomous-triad`, `pieces-for-all`, and the rest). The gateway's safety depends on what they do with a delegated call, and this review covered only this repo.

## Risks and open questions

- **Append-only vs. deletable.** The event log is hash-chained and cannot drop a row. Putting raw Gmail or Notion bodies in it means they can never be purged. Plan 1.1 stores a hash plus a databank reference instead; confirm that before building.
- **GPU unknown.** Phase 3's budgets depend on what card the PC has, if any. Triage currently runs CPU-only by choice.
- **Label fatigue.** 50 taps in 14 days is about 4 a day. If taps lag, the clock stretches; one-tap reasons (Next level) help.
- **Sibling repos unaudited.** The delegate path forwards to 8 other checkouts; their handling of a delegated call was not reviewed.
- **Python in CI.** Triad tests need a venv with `packages/triad` and its dev dependencies; the workflow must set that up or the suite silently skips.
- **Open question:** is the daemon running in shadow on your PC today, and how many direct labels exist already? That sets the real Phase 4 start date.

## Evidence

Run on Oct 28, 2026 against `e8afbdd`, Node 24.22, in a clean Linux checkout. Workspace typecheck passed for all 12 projects (Python is skipped by design).

| Package | Passed | Failed | Cause of failures |
| --- | --- | --- | --- |
| `apps/daemon` | 264 | 7 | 6 stale triage-label mock (fixed in PR #18); 1 Obsidian test needs a real vault |
| `packages/triad` (Python) | 446 | 1 | `git checkout --end-of-options` rejected by Git 2.43 |
| `packages/mesh` | 326 | 0 | — (2 skipped) |
| `apps/mobile` | 233 | 0 | — |
| `packages/core` | 184 | 0 | — |
| `packages/world-model` | 129 | 0 | — |
| `packages/memory` | 116 | 0 | All 8 failures on Node 22 vanish on Node 24 |
| `packages/databank` | 58 | 0 | — |

Mobile `oxlint` printed warnings only (`Setup.tsx`, `LivingBrain.tsx`); the README's conditional-Hook error did not reproduce. Not run: native desktop and Android builds, real integrations, live shadow metrics.

## Sources

- [PR #18 — triage-labels mock + README limits](https://github.com/Dysfunction-Junction/sovereign-exocortex/pull/18)
- [README.md](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/README.md)
- [docs/ARCHITECTURE\_V3.md](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/docs/ARCHITECTURE_V3.md)
- [HERMES\_HANDOFF\_2026-10-27.md (llama.cpp triage keepalive)](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/HERMES_HANDOFF_2026-10-27.md)
- [apps/daemon/src/server.ts](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/apps/daemon/src/server.ts)
- [apps/daemon/src/network.ts](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/apps/daemon/src/network.ts)
- [apps/daemon/src/channels/channel-manager.ts](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/apps/daemon/src/channels/channel-manager.ts)
- [apps/daemon/src/triage-host.ts](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/apps/daemon/src/triage-host.ts)
- [apps/daemon/src/world-model-host.ts](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/apps/daemon/src/world-model-host.ts)
- [apps/daemon/src/mishmash-nodes.ts](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/apps/daemon/src/mishmash-nodes.ts)
- [packages/memory/embeddings.ts](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/packages/memory/embeddings.ts)
- [packages/triad/triad/server.py](https://github.com/Dysfunction-Junction/sovereign-exocortex/blob/main/packages/triad/triad/server.py)
