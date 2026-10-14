# Neo4j graph and next-action prediction evaluation

**Run date:** 2026-10-14
**Data:** Read-only replay of `%LOCALAPPDATA%\\exocortex.db` and inspection of the local Pieces graph in Neo4j.

## Result

The Pieces graph could not be fairly evaluated as an input to next-action prediction because the real event stream has no reliable key that links its activity records to graph nodes. No graph-augmented score is reported: assigning graph nodes by guesswork would make the comparison misleading.

The existing screen-view predictor was replayed against 114 consecutive screen-view pairs:

| Metric | Current engine | Frequency baseline |
| --- | ---: | ---: |
| Log loss (lower is better) | 1.0310 | 1.0238 |
| Brier score (lower is better) | 0.5373 | 0.5410 |
| Top-1 accuracy | 60.5% | 59.6% |
| Top-3 accuracy | 93.0% | 93.0% |
| Expected calibration error | 0.0762 | 0.0773 |

Paired log-loss gain was **-0.0072 nats** (SE 0.0198, z = -0.36), so the replay found no statistically reliable improvement over frequency counting. This evaluation is an offline replay, not a prospective live trial.

The separately recorded prediction log contains 59 scored outcomes (82 guesses total: 2 open, 21 expired). Its top-1 hit rate was 52.5% versus a 44.1% most-common-action baseline; top-3 hit rate was 91.5%. That log is smaller and is reported separately from the 114-pair prequential replay.

## Linkage check

- The event database contains 9,249 `past` activity records and 116 `screen_view` events.
- Activity records have a small set of coarse labels and 454 distinct `people` strings.
- The imported Pieces graph contains 7,662 `Doc` nodes and 7,534 relationships.
- Exact normalized matching of those 454 people strings against scalar and array strings on graph nodes found **0 matches**.
- Screen-view prediction contexts carry app, device, and time fields; they carry no Pieces document or entity identifier.
- The predictor currently uses the screen/action sequence and those event-derived contexts; it does not query Neo4j.

The zero-match result does not prove that the graph has no useful semantic context. It means the present records do not support a defensible event-to-node mapping for an out-of-sample graph ablation.

## What is needed for a graph comparison

Add a stable source identifier to activity/context events (for example, a Pieces document or entity ID), or produce a reviewed mapping table from each event to relevant graph node IDs. Then replay chronologically with the same held-out targets and compare:

1. the existing model;
2. the same model plus graph-derived features;
3. a graph-only retrieval/ranking model.

Fit any weights using only data before each prediction point. Report paired log loss, Brier score, top-1/top-3 accuracy, coverage (how many examples have a graph link), and uncertainty. Until linkage exists, keep Neo4j out of the prediction path.

## Reproduction

The screen replay is produced by `packages/core/src/prediction-report-cli.ts` with `--eval` against the local event database. The graph import is implemented in `apps/neo4j-import/src/import.js`. This report stores aggregate counts only; it contains no event payloads, names, tokens, or graph content.
