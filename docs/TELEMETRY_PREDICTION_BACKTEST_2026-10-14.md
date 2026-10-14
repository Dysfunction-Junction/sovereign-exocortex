# Telemetry next-app and next-screen backtest

**Run date:** 2026-10-14
**Source:** Read-only replay of `%LOCALAPPDATA%\\exocortex.db`.

## Data split

The database has 4,575 `system_telemetry` events. Their payload prefixes identify 4,520 SMS backfill records, 55 passive app-screen captures, and no notification captures. SMS backfill is not a sequence of foreground app switches, so it was excluded from next-app prediction.

The 55 passive captures span 2026-10-12 through 2026-10-14 UTC, but all came from one device and one distinct app package. All three evaluated methods scored 100% top-1 on the final 11 captures because the target never changed. This is a constant-label result, not evidence that the model can predict app switches.

The database also has 116 `screen_view` events from the companion app, spanning two devices and four screen labels. These are separate from OS app captures. A per-device chronological split used the first 80% for history (92 events total) and scored the remaining 24 screen transitions.

## Companion-app screen results

| Method | Top-1 | Top-3 |
| --- | ---: | ---: |
| Most frequent screen in prior history | 41.67% | 87.50% |
| Repeat the current screen | 8.33% | 8.33% |
| Most common next screen after the current one | **58.33%** | 87.50% |

This small holdout suggests a screen-transition baseline may help predict which companion-app screen opens next. With only 24 test pairs, it is preliminary and does not measure which external app the user will use next.

## Conclusion

The saved passive telemetry is not yet sufficient for next-app forecasting: its captured-app target is constant in the available sample. The companion app's own screen navigation has enough variation for a small next-screen check, where a one-step transition model scored 58.3% top-1. More varied passive app captures are needed to evaluate next-app prediction; screen-view events should remain a separate target.

## Reproduction

From the repository root:

```powershell
node apps/daemon/ops/telemetry-backtest.mjs
```

The script opens the database read-only, prints aggregate counts and scores, and does not print app names, screen names, or captured text.
