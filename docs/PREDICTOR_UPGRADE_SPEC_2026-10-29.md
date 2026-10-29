# Predictor upgrade spec (2026-10-29)

Branch `feat/forecast-cards`. Tags: **[V]** = VERIFIED (I read the code or ran a read-only query), **[I]** = INFERRED. Live DB figures come from read-only `node:sqlite` queries against `%LOCALAPPDATA%\exocortex.db` on 2026-10-29.

## 0. Findings that change the brief

| # | Finding | Tag |
|---|---|---|
| F1 | The ledger holds 471 predictions: 153 HIT, 107 MISS, 208 EXPIRED, 3 open. All 208 EXPIRED rows have a non-null `actual` and an exact `latency_ms` (300,606 to 121,222,931 ms). They are **not censored**. The time to the next action is observed for 468 rows. Only open rows and `expireStale` rows (NULL actual; none exist today) are right-censored. | V |
| F2 | The headline "58.8% top-1" (153/260) leaves out 44% of guesses. It is top-1 *conditional on the next action falling within 5 min*. | V |
| F3 | Actuals are companion-app screens: status 107, setup 104, recent 26, ask 17, review 5, Uncategorized 1. In practice the predictor forecasts navigation inside its own app. | V |
| F4 | `buildUsageV3Body` (`NativeTelemetrySync.java` ~1149-1185) forwards only `package=android.usage` summaries to `/v3/events`. It also drops the `transitions` array that `queueAppTransitions` attaches (~694-723). Screen captures, notifications, clipboard and hardware telemetry stay on the "legacy route only" (code comment). That route's target is presumably the Pieces proxy :8787 [I]. | V |
| F5 | Every one of the 471 prediction contexts lists `device.screen_state`, `device.battery_pct`, `device.network`, `ambient.temp_c` and `location` as `missing`. The features actually present are time, the companion app, `device.mode`, and `triage` on 62 rows. | V |
| F6 | `NativeHardwareTelemetry.updateMotionState` has no callers, so motion is always `"unknown"`. `ACTIVITY_RECOGNITION`, `READ_CALENDAR` and `READ_CALL_LOG` are declared in the manifest, but no code reads them. | V |
| F7 | The `events` table holds 4,898 telemetry rows but only 4,605 distinct (text, ts_device) pairs. About 293 duplicates predate `telemetry-dedupe.ts`. | V |
| F8 | Gate window (14 d), from `shadow-report-cli` run read-only on 2026-10-29: 12 surfaced, **0 tap labels** of the 50 required. The 8 wanted/not_wanted labels are all `inferred`. The 4 forecast cards have no labels yet. The verdict is `insufficient_data`. | V |
| F9 | Forecast cards already use a weighted draw without replacement and log `selection_prob`, `pool_size` and `draw_index` (`forecast-cards.ts` ~94-110). They do not log the pool itself. | V |
| F10 | A persistence and commonest baseline precedent exists in `packages/world-model/comms-ladder.ts` (~10, 144). Reuse that naming. | V |

## W1 Gate fixes (size S, about 0.5 day)

**Goal.** The gate can never pass without a comparator, and pass/fail is judged only on real gate proposals. The breaker is never loosened.

**Current behaviour [V].** `computeShadowMetrics` (`packages/core/shadow-metrics.ts` 193-199) sets `verdict = "pass"` when `baselineGap === null`. Precision includes every row whose reason starts with `calibration:`. Two sources produce such rows: forecast cards (`"calibration: forecast card"`) and `calibration-sampler.ts:78` (`"calibration: conservative queued sample"`). `precisionGateOnly` (171-173, 214) is computed but never used. `breakerTripped = verdict === "fail"`, and `db.isCircuitBreakerTripped` (db.ts 1010) and the approve route (server.ts ~2183) consume it.

**Change** (`shadow-metrics.ts`):
1. Add `ShadowVerdict` value `"no_baseline"`, mapped to `AutomatedVerdict` `"NO_BASELINE"`.
   - Why not reuse `insufficient_data`: the labels are sufficient, but the comparator is missing. The two need different fixes (collect taps vs supply or derive a baseline), and the runbook (line 33) already requires "positive gap over the measured baseline".
2. Compute `gateDecided`, `gateWanted` and the Wilson bound on the gate-only rows (exclude `calibration:%`).
3. Breaker first, with the kill-switch invariant kept. Use `trips(w, d) = d >= minLabels && !(w >= threshold*d - 1e-9)`, the existing count comparison and not a float `<`. Then `breakerTripped = trips(allWanted, allDecided) || trips(gateWanted, gateDecided)`. The first clause is exactly today's rule, so the breaker is never looser.
4. Verdict, in this order:
   - `fail` if `breakerTripped`, so the verdict never contradicts the breaker;
   - `insufficient_data` if `gateDecided < minLabels`;
   - `no_baseline` if `baselinePrecision` is undefined;
   - `heuristic_scorer` if the gate gap is ≤ 0;
   - otherwise `pass`.
   - `no_baseline`, `insufficient_data` and `heuristic_scorer` never trip the breaker.
5. Report calibration separately: `calibration.forecastCards` and `calibration.queuedSamples`, each as `{surfaced, wanted, notWanted, precision}`. Keep `precision` (all rows) as a diagnostic. Add `precisionGate` and a `verdictBasis: "gate_only"` field. Keep `precisionGateOnly` as a deprecated alias for one release.
6. `shadow-report-cli.ts`: `EXIT.no_baseline = 5`; update the header comment. `formatShadowReport` prints gate, all-rows and per-calibration-source lines.
7. Runbook (`docs/SHADOW_EVALUATION_RUNBOOK.md` "Interpretation"): add `no_baseline` → unmet (exit 5). State that forecast cards and queued samples are reported separately and are excluded from the verdict but included in the breaker.

`SHADOW=1`, `effective_shadow` and the 423 approve clamp are untouched. `server.ts` passes the metrics object through unchanged. Mobile types `automated_verdict` as `string` (api.ts:502) [V].

**Tests to change** [V]:
- `shadow-metrics.test.ts:48-57`: no baseline → now expects `no_baseline`. Add a case with `baselinePrecision: 0.5` → `pass`.
- `:60-69`: keep it, and assert that the verdict uses gate-only rows.
- `packages/core/db.test.ts:511-512`: expects `pass`/`SUFFICIENT_DATA_PASS` with no baseline. Pass `baselinePrecision`, or expect `NO_BASELINE`.

**New tests:**
- Calibration `not_wanted` rows push all-rows precision below threshold while the gate passes → breaker trips, verdict is not `pass`.
- Gate fails while calibration is perfect → `fail`.
- CLI exit code 5.
- `v3-shadow.test.ts` assertions (`INSUFFICIENT_DATA`, `BREAKER_TRIPPED_PRECISION_LOW`) must still hold.

**Risk.** A same-hour-yesterday auto-baseline (`computeSameHourYesterdayBaseline`) may make `no_baseline` rare when a `db` is passed. That is correct, not a bug.

## W2 Merge, never delete

**Recommendation on "example(2)".** Do not put the tally in names. A suffix changes the identity string, so joins, `prediction_id`-style keys, sha256 identity and exact-match lookups all break, and a renamed record looks like a new one. Keep the key clean and store `occurrence_count`, `first_seen`, `last_seen` and `merged_from` on one canonical record. Derive the label at render time: `display = count > 1 ? \`${name} (×${count})\` : name`.

### W2a Dataset generator (`C:\Users\micha\projects\generate_exocoder_dataset.py`) — size M, about 1 day

**Facts [V].**
- 9,173 rows; 4,086 unique snippets, identical after whitespace normalisation.
- 4,086 unique (snippet, graph) pairs, so the graph is deterministic per snippet and merging loses nothing.
- Rows have only `code_snippet` and `graph_json`.
- `chunk_python_file` emits both the class chunk and each method chunk.

**Change.**
- Collect chunks in memory keyed by `id = sha256(normalize(snippet))`, then write once. `normalize` means: CRLF→LF, strip trailing whitespace per line, dedent and strip. The emitted code is not reformatted.
- Output row: `id, code_snippet, graph_json, occurrence_count, first_seen, last_seen, provenance[], chunk_kind, parent_id, group_id, split, display_name`.
  - `provenance[]` entries: `{repo, rel_path, commit, chunk_name, line_start, line_end}`. Add every occurrence; none is dropped.
  - `commit` comes from `git -C <root> rev-parse HEAD`, or null.
  - `first_seen` and `last_seen` come from file mtime, ISO.
  - `parent_id` is the class chunk id for method chunks.
- **Group-aware split.** Union-find over:
  - the same `id`;
  - method↔containing class (`parent_id`);
  - the same `(rel_path, chunk_name)`, only across declared fork pairs (`autonomous-triad` ↔ `autonomous-triad-v34`). A bare `rel_path` would merge every `main.py`/`utils.py` into one giant group.
- `split = "test"` if `int(sha256(group_id)[:8],16) % 10 < 2`, else `"train"`.
- `occurrence_count` is metadata only. It must not be a default sample weight, because that would reintroduce the duplication bias.
- Print a summary: rows in, unique out, merged, groups, and train/test counts.

**Acceptance.**
- Re-running on the same tree gives byte-identical output.
- Unique ids = distinct normalised hashes on this run, and the sum of `occurrence_count` = chunks the v1 path emits on this run. On the tree that produced today's JSONL, those were 4,086 and 9,173 [V].
- No `group_id` appears in both splits.
- Print the group-size distribution; the largest group must be < 5% of unique rows.
- Every input occurrence appears in exactly one `provenance` entry.

### W2b Event/telemetry tally — size M, about 1 day

**What may and may not change [V].**
- `events` is hash-chained (`prev_hash`/`hash`, unique `prev_hash`). Triggers abort UPDATE and DELETE.
- `predictions` and `prediction_outcomes` are append-only by trigger. `logPrediction` uses `INSERT OR IGNORE` on `prediction_id = device+made_seq`, so duplicates cannot occur there.
- `dropKnownTelemetry` currently drops a re-sent `system_telemetry` duplicate (same device, ts_device, text) **before** append. Its new event_id and its arrival time are lost.
- Merged: only telemetry duplicates, recorded in a mutable side table that is not part of the chain.
- Append-only, never touched: `events`, `predictions`, `prediction_outcomes`, `gate_decisions`, `shadow_labels`.

**Schema** (created by `ensureTelemetryTally(raw)` in `telemetry-dedupe.ts`, following the existing `ensurePredictionTables` and `CREATE INDEX IF NOT EXISTS` pattern [V]; there is no `user_version` migration system, and `db.ts` uses `CREATE … IF NOT EXISTS` plus `PRAGMA table_info` guards [V]):

```sql
CREATE TABLE IF NOT EXISTS telemetry_tally (
  dedupe_key        TEXT PRIMARY KEY,               -- hex sha256(device_id|ts_device|telemetry)
  device_id         TEXT NOT NULL,
  canonical_seq     INTEGER NOT NULL REFERENCES events(seq),
  occurrence_count  INTEGER NOT NULL CHECK (occurrence_count >= 1),
  first_seen_server INTEGER NOT NULL,
  last_seen_server  INTEGER NOT NULL,
  merged_event_ids  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(merged_event_ids)) -- capped at 100; count is authoritative
) STRICT;
CREATE TABLE IF NOT EXISTS telemetry_tally_members (   -- historical in-log duplicates only
  seq        INTEGER PRIMARY KEY REFERENCES events(seq),
  dedupe_key TEXT NOT NULL REFERENCES telemetry_tally(dedupe_key)
) STRICT;
CREATE VIEW IF NOT EXISTS events_canonical AS
  SELECT e.* FROM events e
   WHERE NOT EXISTS (SELECT 1 FROM telemetry_tally_members m JOIN telemetry_tally t USING (dedupe_key)
                      WHERE m.seq = e.seq AND m.seq <> t.canonical_seq);
```

**Code.**
- `dropKnownTelemetry` keeps its filter behaviour. It also returns `pending: {key, event_id, ts_device, text}[]` for every skipped event. Change its lookup to `SELECT seq` instead of `SELECT 1`.
- New `recordTelemetryDuplicates(db, deviceId, pending, nowMs)` runs **after** `db.ingestBatch`. That is when in-batch canonicals have a seq. It resolves the canonical seq with the same `(device_id, ts_device, telemetry)` lookup, then UPSERTs. A tally row exists only once a duplicate arrives. It inserts `occurrence_count = 2` (canonical plus one), then increments; it sets `last_seen_server = now` and appends the event_id.
- WP3's one bounded `server.ts` edit: a single call after line ~816, inside a try/catch that logs and never fails ingest.
- New `apps/daemon/src/telemetry-tally-backfill-cli.ts` (`--dry-run` by default): `GROUP BY device_id, ts_device, json_extract(payload,'$.telemetry') HAVING COUNT(*) > 1`. Canonical = `MIN(seq)`. It inserts tally and member rows and is idempotent. The user runs it; agents do not run it against the live DB.
- Readers that want de-duplicated history (`prediction-report-cli --eval`, triage backfill) read `events_canonical`. Hash verification keeps reading `events`.

**Acceptance.**
- Ingesting the same SMS three times stores 1 event and gives `occurrence_count = 3` with 2 merged ids.
- Backfill on a fixture with 3 copies gives 1 canonical, 2 members, and a view count of 1.
- `db.verifyEventChain()` (db.ts:653) still passes.
- No UPDATE or DELETE touches `events`.

**Risk.** Some apps legitimately send the same text twice at the same `ts_device` (for example, two identical SMS within one ms). These are already dropped today [V], and they are now at least counted.

## W3 Prediction engine upgrades (proportionate to about 470 rows)

Temperature scaling already exists (`prob-engine.ts` 20, 230-336) [V]. It is dropped from scope.

| Item | Change | Files | Size |
|---|---|---|---|
| 3.1 Average-usage and persistence baselines, pre-registered | New `UsageBaseline` (`packages/core/usage-baseline.ts`). The prediction host feeds it at the same point as `engine.observe`: after resolving and before the next guess. Its distributions are logged in `predictions.context.baselines = {avg_usage:{cands,other,n,cell,cold_start}, persistence:{cands,other,repeat_rate}}`. This is JSON, so no ALTER and no conflict with the append-only triggers [V]. | usage-baseline.ts (new), prediction-host.ts, index.ts | M |
| 3.2 Reports use logged baselines | `computePredictionReport`: replace the post-hoc `baselineTop1` (prediction-log.ts 441-445) with top-1 and log loss of the logged `avg_usage` and `persistence` on rows that have them. Rows without them are shown as "legacy (post-hoc)". Add an `unconditional` block that scores all HIT, MISS and EXPIRED-with-actual rows against `actual` (F1, F2). | prediction-log.ts | S |
| 3.3 Wilson CI per calibration bin | Add `lo95` and `hi95` to `CalibrationBin`. Print `n` and the interval. | prediction-log.ts | S |
| 3.4 Passive events in `--eval` | `buildActionExamples(events, actionOf)` in prediction-events.ts. `--eval` replays screen_view plus passive actions through the same `actionOf` as the host. Move `actionOf` and `passiveCapturePackage` to core so the CLI can import them. Read `events_canonical` when it exists. | prediction-events.ts, prediction-report-cli.ts, prediction-host.ts (re-export) | M |
| 3.5 Hazard P(next action within h) | `packages/core/hazard.ts`: discrete-time hazard on intervals [0,1), [1,5), [5,15), [15,60), [60,∞) min. Cell = daypart × previous action, backing off to daypart, then global, when the cell n < 15. Beta(1,1) smoothing. `P(≤h) = 1-∏(1-λ_k)`. Inputs: `latency_ms` from HIT, MISS and EXPIRED-with-actual rows as events; open and NULL-actual rows censored at `min(now, made_at+horizon) - made_at`. Scored prequentially with Brier per h ∈ {1,5,15,60} against a no-context (global KM) baseline. Report-only, no live logging yet. | hazard.ts (new), prediction-report-cli.ts | M |
| 3.6 Package-level target | `actionOf` returns `pkg:<package>` with `cat:<category>` as backoff, using the existing expert backoff and not new experts. **Blocked on W4 WP-A**: no per-app events reach the daemon today (F4). | prediction-host.ts, play-categories.ts | S after WP-A |
| 3.7 Pool logging for forecast cards | Log on every card: `run_id`, `draws_in_run` (= `min(remaining, pool.length)`), and the full pre-draw `pool:[{prediction_id, weight}]` (≤200 entries) in `actionPayload`. With those, the exact successive-sampling inclusion probability can be computed offline. A runtime Monte Carlo `inclusion_prob` is optional. Bump `SAMPLER_VERSION` to 2. | forecast-cards.ts | S |
| 3.8 Eval gate | `prediction-report-cli --eval --gate`. Compare the candidate engine config to the default `ProbEngine` and to `UsageBaseline` on the same prequential replay. Exit 6 if the paired log-loss gain vs default is below 0 with z < -1, or if the engine is worse than average-usage with z < -1. Exit 0 otherwise. Exit 3 is unchanged below 30 examples. | prediction-report-cli.ts | S |

**Average-usage baseline spec** (coordinator request, applies to both W3 and W5):
- **Definition.** The user's own running usage share per action: `share(a) = count(a in window)/n`.
- **Window.** A trailing 14 days, time-based. At about 25 predictions/day [V: 471 over about 18.8 days], that is roughly 350 actions. Pick time over count so the baseline means "a normal fortnight" whatever the activity level.
- **Cells.** By daypart (`night`, `morning`, `afternoon`, `evening`, from `daypartOf` [V]). Back off to the overall window when the daypart cell has n < 30, and log `cell: "daypart"|"overall"`.
- **Update.** Increment on every resolved action. Expire entries older than 14 d lazily on each update (deque of `{ts, action, daypart}`).
- **Smoothing.** Additive α = 0.5 over the actions seen in the window plus `OTHER`.
- **Cold start.** With overall n < 10, return uniform over seen actions plus `OTHER` and set `cold_start: true`. These rows are excluded from baseline comparisons.
- **Persistence.** `P(last action) = r`, where `r` is the smoothed repeat rate `(repeats+1)/(n+2)` in the window. The remaining `1-r` is distributed by average usage. With the companion app's navigation, `r` may be near 0; that is fine.
- **Restart.** `hydrate` already replays events (prediction-host.ts 196-277) [V]. Feed `UsageBaseline` in that replay, limited to the last 14 d. No checkpoint schema change is needed.

**Acceptance.**
- Every new prediction row has `context.baselines`.
- A unit test shows that the baseline used for prediction k saw only actions < k (pre-registration).
- Report output shows the engine against `avg_usage` and `persistence` on identical rows.
- Hazard tests: Kaplan-Meier with censoring matches a hand-computed fixture.
- An offline exact inclusion probability computed from the logged pool, weights and `draws_in_run` matches enumeration on a 4-item, 2-draw fixture.

**Risks.**
- About 470 rows give wide intervals. Report CIs and do not tune on the live ledger.
- The hazard target can be dominated by app-session gaps until the screen on/off events from WP-A exist.

## W4 Ingestion audit — "are we logging ALL device telemetry from built-in sensors?"

**No.** Much is *collected* on the phone, but very little reaches the daemon, and the predictor uses almost none of it (F4-F6). The predictor sees time-of-day, the companion app's own screens, `device.mode`, and sometimes `triage`.

| Signal | Captured? (where) | Stored in daemon? | Used by predictor? | Permission | Battery/privacy cost | Value hypothesis |
|---|---|---|---|---|---|---|
| Foreground app / UsageStats | Yes: `UsageSummary.queryEvents` → `queueAppTransitions` with a per-transition array [V] | Text summary only; `transitions` dropped (F4) [V] | No: package is always `android.usage` [V] | PACKAGE_USAGE_STATS (declared; granted [I], since summaries arrive) | Low / Med | **Highest**: this is the real next-app target |
| Accessibility screen text | Yes, opt-in toggle, lock screen and `isPassword` excluded [V] | No (legacy route) [V/I] | No | Accessibility | Med / **High** (text) | Med; keep it off the predictor |
| Screen on/off, unlock | Only a `pm.isInteractive` snapshot inside hardware telemetry; no SCREEN_ON/OFF/USER_PRESENT receiver [V] | No (471/471 missing) [V] | No | None | ~0 / Low | High: session boundaries for the hazard model |
| Notifications | `NotificationCaptureService` [V] | No (legacy route) [I] | No | Notification listener | Low / High | Med (trigger → app open) |
| SMS metadata | `SmsPlugin` [V] | Yes, ~4.6k events [V] | No: excluded in `passiveCapturePackage` [V] | READ_SMS | Low / High | Low-Med |
| Call log | Permission only; no reader [V]. History via `comms-backfill` as kind `past` [V] | Past only | No (past kind ignored) [V] | READ_CALL_LOG | Low / High | Med |
| Calendar | Permission only; no reader [V] | No | No | READ_CALENDAR | Low / Med | Med-High (busy/free) |
| Battery/charging | `NativeHardwareTelemetry` battery_micro [V] | No (missing) [V] | Feature exists, never fed | None | ~0 / Low | Med (charging ≈ home/desk) |
| Wi-Fi/network transport | Transport and metered only, no SSID [V] | No [V] | Feature exists, never fed | ACCESS_NETWORK_STATE | ~0 / Low | Med |
| Bluetooth / car audio | Audio route incl. `car_audio_connected` [V]; no BT connect events | No | No | (BLUETOOTH_CONNECT for events) | Low / Low | High for "driving" |
| Coarse location / geofence | None; no permission [V] | No | Feature exists (`place`) | ACCESS_COARSE/BACKGROUND_LOCATION | Med / **High** | High, but defer |
| Activity recognition / steps | Permission declared; `updateMotionState` never called (F6) [V] | No | Feature exists, always unknown | ACTIVITY_RECOGNITION | Low / Low | Med |
| Accelerometer, proximity, light | Yes, for `physical_state` [V] | No | Feature exists, never fed | None | Low-Med / Low | Med |
| DND / interruption filter | Yes [V]; ringer mode no | No | Cognitive gate reads it if present [V] | Notification-policy access | ~0 / Low | Med (interruptibility) |
| Audio route / media playing | Yes (`music_active`, output) [V] | No | `audio_mode` feature, never fed | None | ~0 / Low | Med |
| Clipboard | Yes; sensitive flag honoured, email/phone hashed [V] | No (legacy route) [I] | No | Accessibility | ~0 / High | Low |
| PC window focus / idle / input rate | No: desktop is a Tauri shell; no GetForegroundWindow/GetLastInputInfo [V] | No | No | None (Win32) | Low / Med | High for the PC half of the day |
| Shell / IDE events | Partial: `repo_health`/test observations via `pnpm exo test` [V]; Pieces workstream as `past` [V] | Partial | No | None | Low / Med | Med |
| Home Assistant presence | Not ingested by the daemon [I] (HA lives in bear-house-classic) | No | No | HA token | ~0 / Med | Med (home/away) |
| Typing cadence | No: accessibility config lacks `typeViewTextChanged` [V] | No | No | Accessibility | Med / High | Unproven (W5) |

**Top 5 missing sources, ranked by value/cost:**
1. Per-transition foreground-app events on `/v3/events`. The permission is already granted, and this fixes the target.
2. Forwarding the hardware snapshot that is already collected (interactive, battery/charging, transport, audio/car, DND) on the v3 route, attached to each transition.
3. SCREEN_ON/OFF and USER_PRESENT receivers. No permission is needed, and they give the hazard model its session boundaries.
4. PC foreground process (exe name only, no titles) plus idle seconds, as 30 s aggregates.
5. Activity-recognition transitions: wire `updateMotionState`; the permission is already declared, and it may need Play Services [I].

Calendar busy/free is #6. Location stays deferred until a named-places opt-in exists.

## W5 Typing-cadence affect signal — evidence is too weak to build; log only

**Evidence** (web-search summaries, not full-paper reads):
- Within-person effects are weak. JMIR 2022: within-subject β = -0.4, 95% CI -5.6 to 4.9. CMU 2018 and medRxiv 2025 found stress responses highly individual.
- BiAffect links typing to clinical mood (variability, accuracy) with strong diurnal and age effects. The 2024 backspace-rate group difference was not significant (P = .11).
- There is no meta-analysis. "Stress vs excitement" from typing is not supported. **Too weak to build; log only.**

**Constraints.**
- **Android.** `TYPE_VIEW_TEXT_CHANGED` delivers the text in the event even if the code only reads `getAddedCount`/`getRemovedCount`, so it is a privacy-review item. `notificationTimeout="100"` [V] throttles delivery, so inter-key intervals under 100 ms cannot be measured. Glide typing and autocorrect insert many characters per event. Gboard exposes no keystroke API; only a custom IME would. Password fields must be excluded with the existing `isPassword` and inputType check [V, 447-457].
- **Windows.** A low-level keyboard hook (`WH_KEYBOARD_LL`) is keylogger-shaped and AV-flagged. Use counts only, never virtual-key codes.

**Minimal first step (logging only, opt-in, default off):**
- Per 5-min window, on device, compute: chars added, chars removed, deletion ratio, burst count and mean burst length (gap > 2 s splits a burst), and active typing seconds. No text, no key identities.
- **Baseline** (per the coordinator): the user's own rolling average **per daypart** (diurnal effect), over a trailing 14 d. Use the median and MAD per feature, recomputed nightly.
- **Robust z.** `(x-median)/(1.4826·MAD)`.
- **Cold start.** The state is `unknown` until there are ≥7 days and ≥20 windows in that daypart.
- **States.** `unknown | typical | above_usual | below_usual` (|z| > 1.5). These are never presented as emotions.
- **Use.** A soft, optional feature for `CognitiveModeGate`, only after the evaluation below.
- **Evaluation, pre-registered.** After ≥8 weeks, the feature must improve held-out prequential log loss for interruption acceptance or next-action with paired z > 2. Otherwise delete the feature and its data.

## W6 Blueprint corrections (`memory/project_exocoder_qwen_blueprint.md`; replacement text only, file not edited)

| Section | Stale text | Replacement |
|---|---|---|
| §2 (outside §5/§6) | "prevent the KV cache from ballooning by 4–8 GB" | "Qwen2.5-7B KV cache (28 layers × 4 KV heads × 128 dim, fp16) is about 56 KiB/token: about 0.23 GB at 4k, about 1.9 GB at 32k [arithmetic V, architecture I]. `-c 4096` is about RAM headroom and prompt latency." |
| §5.5 | "~7-12 tok/s … ~30-60 s" | "Latency = prefill + generation. CPU prefill is about 20-60 tok/s [I], so a 3k-token prompt is about 50-150 s before the first token; 300 tokens at 7-12 tok/s adds 25-45 s. Budget 1.5-3 min per attempt; measure with `llama-bench`." |
| §6 intro | "top-1 58.8% vs 41.2% baseline" | "58.8% top-1 on the 260 guesses resolved within 5 min; 208 (44%) resolved later and are excluded. The 41.2% baseline is post hoc (prediction-log.ts 441-445), not pre-registered." |
| §6 intro | "Passive app capture was a constant label" | "No per-app events reach the daemon: only `android.usage` summaries, and `transitions` is dropped (spec F4)." |
| §6 intro | "Gate count: 0 of 50" | Keep. Verified: 0 tap labels; all 8 decided labels are inferred. |
| §6.3 | "Add temperature/isotonic scaling" | "Temperature scaling exists (prob-engine.ts). Remaining: Wilson CI per calibration bin, ECE per release." |
| §6.5 | Fixed-50 Wilson peeking as the gate problem | "Actual defects: a missing baseline falls through to `pass`, and calibration cards count toward the verdict (spec W1). Confidence sequences are a later refinement." |
| §6 forecast-card paragraph | "picked highest-confidence-first and deterministically" | "Already a weighted random draw logging `selection_prob`. Missing: pool snapshot, `run_id`, `draws_in_run` (W3.7)." |
| §3.1 | "SHA-256 hash checking … eliminate exact duplicates" | "Merge, never delete: sha256(normalised snippet) → one row with `occurrence_count` and full provenance. Today: 9,173 rows / 4,086 unique (55.5% duplicates), nested class+method chunks, no source path. Group-aware split (W2a)." |

## Implementation plan (parallel work packages for Sonnet)

| WP | Scope | Owns (exclusive) | Depends on |
|---|---|---|---|
| WP1 | W1 gate | `packages/core/shadow-metrics.ts`, `shadow-metrics.test.ts`, `shadow-report-cli.ts`, `packages/core/db.test.ts`, `docs/SHADOW_EVALUATION_RUNBOOK.md` | — |
| WP2 | W2a dataset | `C:\Users\micha\projects\generate_exocoder_dataset.py` | — |
| WP3 | W2b tally | `apps/daemon/src/telemetry-dedupe.ts` + test, new `telemetry-tally-backfill-cli.ts` | — |
| WP4 | W3.1-3.3 baselines and report. Also moves `actionOf` and `passiveCapturePackage` into a new core module (`packages/core/action-of.ts`) with `playCategories` injected; prediction-host re-exports them. | new `packages/core/usage-baseline.ts`, `action-of.ts` + tests, `prediction-log.ts` + test, `packages/core/index.ts`, `apps/daemon/src/prediction-host.ts` + test | — |
| WP5 | W3.4, 3.5, 3.8 eval and hazard | `prediction-events.ts` + test, `prediction-report-cli.ts`, new `hazard.ts` + test | WP4 |
| WP6 | W3.7 pool logging | `apps/daemon/src/forecast-cards.ts` + test | — |
| WP-A | W4 items 1-3 (Android). Acceptance: a daemon test shows `/v3/events` stores the new per-transition `package` and hardware fields unchanged, with no stripping by ingest or by `telemetry-validation`. | `NativeTelemetrySync.java`, new `ScreenStateReceiver.java`, `AndroidManifest.xml`, Android tests | User decision (privacy: package-only events bypass the accessibility `isAllowed()` list) |
| WP7 | W3.6 package target | `prediction-host.ts`, `play-categories.ts` (edit only after WP4 lands) | WP4, WP-A |
| WP8 | W5 logging-only | Android accessibility config and service | User opt-in decision; after WP-A |

Nobody edits `db.ts`. `server.ts` gets only WP3's single post-ingest call.

**Rules.** Every new daemon `*.test.ts` must be appended to the explicit list in the `apps/daemon/package.json` `test` script [V]. Do not run anything against the live DB or daemon.

**Verification commands.**
- Core (vitest [V]): `cd packages/core && npx tsc --noEmit && npx vitest run shadow-metrics.test.ts db.test.ts prediction-log.test.ts usage-baseline.test.ts hazard.test.ts prediction-events.test.ts`
- Daemon: `cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/telemetry-dedupe.test.ts src/prediction-host.test.ts src/forecast-cards.test.ts src/v3-shadow.test.ts src/kill-switch-drill.test.ts src/shadow-actuation.test.ts`, then `pnpm test` for the full list.
- Dataset: `python -I C:\Users\micha\projects\generate_exocoder_dataset.py --help`, then a run to a temp output; check the unique count of 4,086 and the occurrence sum of 9,173.
- Android: `cd apps/mobile/android && ./gradlew testDebugUnitTest`.

**Order.** WP1, WP2, WP3, WP4 and WP6 run in parallel. WP5 follows WP4. WP-A follows the user's sign-off, then WP7. WP8 is last and optional.

Sources (W5): [JMIR 2022 MS keystrokes](https://pmc.ncbi.nlm.nih.gov/articles/PMC9679948/) · [Lau, CMU 2018](https://apps.dtic.mil/sti/trecms/pdf/AD1167960.pdf) · [medRxiv 2025 "One does not fit all"](https://www.medrxiv.org/content/10.1101/2025.08.02.25332538v1.full.pdf) · [BiAffect pilot](https://www.sciencedirect.com/org/science/article/pii/S1438887118002790) · [BiAffect iOS, JAMIA 2020](https://pubmed.ncbi.nlm.nih.gov/32467973/) · [Backspace phenotypes, JMIR 2024](https://www.jmir.org/2024/1/e51269) · [Keystroke review](https://www.researchgate.net/publication/371653098_A_Review_on_Smartphone_Keystroke_Dynamics_as_a_Digital_Biomarker_for_Understanding_Neurocognitive_Functioning)
