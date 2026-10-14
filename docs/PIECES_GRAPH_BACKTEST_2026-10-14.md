# Pieces-only chronological backtest

**Run date:** 2026-10-14
**Source:** Local Neo4j Pieces import; queries used read access only.

## Task and method

This evaluates the task the Pieces export can support on its own: predict the class, document type, and linked tag topic of the next-created Pieces document. It does not claim to predict the user's next real-world action.

The replay orders documents by their `created` timestamp, holds out the last 20% of distinct timestamp buckets, and updates history only after scoring every document at a timestamp. That avoids using same-timestamp records as one another's history. The comparisons are:

- **Global:** most common labels among all earlier documents.
- **Recent:** most common labels from the immediately preceding timestamp bucket.
- **Graph neighbors:** most common labels among earlier documents adjacent to documents in that preceding bucket.

The script uses class/type metadata and linked Tags-node text; it does not use document body text. It prints aggregate metrics only.

## Data

- 7,662 documents, across 7,645 distinct creation timestamps (17 additional documents share a timestamp with another document).
- Timestamp range: 2026-08-10 through 2026-10-13.
- Test set: 1,534 documents.
- Only 86 test documents had linked topic tags, so topic results have low sample coverage.

## Results

### Next artifact class

| Method | Top-1 | Top-3 | Candidate coverage |
| --- | ---: | ---: | ---: |
| Global frequency | 50.13% | 91.20% | 100% |
| Recent timestamp bucket | **74.84%** | 74.84% | 100% |
| Graph neighbors | 0.20% | 1.56% | 41.53% |

### Next document type

When a node has no `type`, its imported source label is used as the fallback class.

| Method | Top-1 | Top-3 | Candidate coverage |
| --- | ---: | ---: | ---: |
| Global frequency | 32.92% | 73.99% | 100% |
| Recent timestamp bucket | **67.73%** | 67.73% | 100% |
| Graph neighbors | 0.13% | 0.13% | 41.53% |

### Linked topic tags

Scored only for test documents with at least one linked tag (`n = 86`). Hit@3 is the share of those documents with at least one true tag among the three highest-ranked predictions.

| Method | Hit@3 | Precision@3 | Recall@3 | Candidate coverage |
| --- | ---: | ---: | ---: | ---: |
| Global frequency | 24.42% | 9.30% | 3.86% | 100% |
| Recent timestamp bucket | **45.35%** | **75.21%** | 14.15% | 45.35% |
| Graph neighbors | 0% | n/a | 0% | 0% |

## Interpretation and limits

In this export, the recent-document baseline is a much stronger predictor of the next saved document's class/type than the global frequency baseline. The graph-neighbor vote did not help these targets and often had no candidates. For topic tags, the recent method had the best measured hit and precision, but only 86 test items had tags; the result is preliminary.

The graph import has no timestamps on relationships. Although neighbor documents were filtered to timestamps before the prediction point, the relation itself may have been added later. Therefore graph-neighbor scores are exploratory and cannot establish a leakage-free historical graph lift. Also, the sequence is the creation order of Pieces artifacts, not a ground-truth sequence of user actions.

## Reproduction

From `apps/neo4j-import`, run:

```powershell
node --env-file=.env src/graph-backtest.js
```

The script sets the Neo4j session to read-only and reports no document text, tag values, or identifiers.
