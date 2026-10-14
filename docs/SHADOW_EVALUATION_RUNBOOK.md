# Shadow evaluation runbook

Shadow calibration measures whether surfaced proposals are useful before any tier is allowed to act. Keep `SHADOW=1` throughout collection.

## Collect representative data

1. Start the daemon with `EXOCORTEX_SHADOW_RECORD=1` (the default) and `SHADOW=1`.
2. Use the phone and daemon normally. The mobile app queues `link_health` transition observations when event uploads first succeed, fail across every configured target, or recover; the daemon evaluates them after they reach `/v3/events`. A failed upload stays queued until recovery, so its down observation is delivered with a later successful batch. A test-runner or repository-health producer is still needed for `repo_health` observations (`tests_pass`, `tests_fail`, `clean_checkout`, `uncommitted_edits`). Foreground-app telemetry alone does not create proposals.
3. To record the real test-suite result, set `EXOCORTEX_OBSERVATION_TOKEN` to an enrolled device JWT with `telemetry:write` and run `pnpm exo test`. Reporting is best-effort and does not alter the test result or exit code.
4. On each surfaced proposal, use the app's approve or dismiss action when the proposal is useful or unwanted. These are direct labels (`wanted` and `not_wanted`); inferred labels do not count toward precision.
5. Collect across a representative 14-day period. Do not change the decision threshold to make a run pass.

## Review metrics

The daemon endpoint returns the current 14-day evaluation and breaker state. Supply the independently measured same-hour-yesterday baseline precision so the report can calculate a baseline gap:

```powershell
$env:EXOCORTEX_ADMIN_TOKEN = "<admin device JWT>"
$baselinePrecision = 0.0 # replace with measured baseline precision (0..1)
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:EXOCORTEX_ADMIN_TOKEN" } `
  "http://127.0.0.1:8788/v3/shadow/metrics?days=14&threshold=0.90&min_labels=50&baseline_precision=$baselinePrecision"
```

For direct database analysis, use the core read-only report CLI with the daemon database path (`EXOCORTEX_DB_PATH`, or `%LOCALAPPDATA%\exocortex.db`):

```powershell
$baselinePrecision = 0.0 # replace with measured baseline precision (0..1)
pnpm exec tsx packages/core/src/shadow-report-cli.ts "$env:LOCALAPPDATA\exocortex.db" --days 14 --baseline $baselinePrecision
```

The release gate is at least 50 direct tap labels, Precision@surface at least 0.90, and a positive gap over the measured baseline; inferred labels are reported separately. Without a supplied baseline, the report shows the gap as unavailable. Insufficient data is not a pass. Keep shadow mode enabled until the gate is met and reviewed.

## Interpretation

- `wanted` and `not_wanted` tap labels determine Precision@surface.
- `already_did` and `ignored` are inferred outcomes and are useful for coverage and focus-regret analysis, but do not count as direct precision labels.
- `insufficient_data`, `heuristic_scorer`, and breaker failures all mean the rollout gate is unmet.
- Record the date range, tap count, precision, Wilson lower bound, baseline gap, and focus regret with each review so later runs can be compared.
