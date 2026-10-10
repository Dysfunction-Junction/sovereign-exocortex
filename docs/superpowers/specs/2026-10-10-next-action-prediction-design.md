# Next-Action Prediction Log and Probability Engine — Design

Date: 2026-10-10. Status: built; shadow only.

## Purpose
Log a ranked guess about what the user does next, score it against what actually happens, and keep the
misses (with the real action) so the probabilities can be checked and the guide improved. No tapping is
needed: the event log is the answer key. This is separate from Precision@surface, which asks whether
surfacing a proposal was wanted and stays tap-only; nothing here feeds it.

## Data
- `predictions` (append-only): device, sequence and time of the guess, horizon, coarse `context_key`,
  ranked `candidates` (probabilities), and a structured `context` snapshot: time (hour, weekday, weekend,
  daypart, timezone offset), app, device state (screen, mode, battery, charging, network, idle), ambient
  (temperature, humidity), coarse location (coordinates rounded to ~1 km), and `missing`, the expected
  signals that were not available. Signals never received are left out and named in `missing`, never guessed.
- `prediction_outcomes` (append-only, one per guess): `HIT` (top-1 matched), `MISS` (something else happened
  in the horizon; the real action, its rank among the candidates and the context at that moment are kept),
  `EXPIRED` (the next action came after the horizon; it is still recorded).

## Engine (`packages/core/src/prob-engine.ts`)
- Experts: hierarchical Dirichlet-multinomial predictors over the next action, conditioned on the current
  action plus one context feature (or two joint contexts), each backing off to the bigram then the unigram:
  `P(y|c) = (n(c,y) + alpha * P_parent(y)) / (n(c) + alpha)`. An OTHER class carries the mass of actions
  never seen, so every distribution sums to 1.
- Mixing: weights proportional to exp(-cumulative log loss) (exact Bayesian model averaging at eta = 1) with
  fixed-share smoothing for drift. An expert whose features are missing sits out and is charged the
  mixture's loss, so abstaining neither helps nor hurts it.
- Calibration: one temperature fitted by golden-section search on the engine's own recent predictions.
- Scoring: log loss and Brier (proper rules), top-1/top-3, ECE. Evaluation is prequential (predict, score,
  then learn). `compareLogLoss` gives a paired z-test against the frequency baseline (unigram + bigram).
- Deterministic: no randomness, clock or I/O. Daemon engine state is rebuilt from the event log per device
  after a restart; nothing about the model is persisted.

## Wiring
`apps/daemon/src/prediction-host.ts`, called from `POST /v3/events` after ingest, isolated in try/catch
(`EXOCORTEX_PREDICTIONS=0` turns it off; `PREDICTION_HORIZON_MS` sets the horizon, default 5 min). Guesses
stay open until the next screen view; they are not expired against the server clock because device clocks drift.

## Reporting
`npx tsx packages/core/src/prediction-report-cli.ts <db> [--days N] [--guide-by time.daypart] [--eval]`.
`--eval` replays the whole event log through the engine and the baseline and prints the paired gain.

## Known limits
- Today the phone sends only the foreground app, screen and touch mode, so most context experts sleep.
  Battery, network, location and ambient temperature need the phone app (and, for temperature, a home
  sensor or weather lookup) to report them. The tracker already accepts them (`battery_pct`, `charging`,
  `network`, `temp_c`, `place`, `lat`/`lon`).
- The action space is the app's own screens. The value grows when the phone reports richer actions.
- With little data the engine will not beat frequency counting; the report says so rather than hiding it.
