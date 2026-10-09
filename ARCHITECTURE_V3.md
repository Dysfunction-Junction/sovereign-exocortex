# Sovereign Exocortex: Architecture & Schema v3

Oct 9, 2026 · @Michael Joseph Gabriel Hebert

## Goals and design rules

v3 keeps the v2 pipeline but makes it observable, gated and honest: nothing acts until shadow-mode data says it should.

**Goals**

- Predict the next useful action from phone and PC signals and stage it without interrupting.
- Log every proposal with its inputs, gate decision and outcome, so it can be audited and replayed.
- Require a verified human approval for any state change, scaled by risk tier.

**Non-goals:** self-patching production code, cloud-hosted state, multi-user support.

**Design rules**

1. **Shadow first.** `SHADOW=1` is the default. Actuation is a capability granted per risk tier, never a build flag.
2. **One append-only event log is the source of truth.** The life graph, beliefs and caches are projections that can be rebuilt from it.
3. **Deterministic core.** Models propose; a typed policy engine decides. No LLM sits in the gate or approval path.
4. **Capabilities, not trust.** Every device and agent holds scoped, revocable grants.
5. **Honest naming.** A component named for a method must implement it, or be renamed (for example "heuristic scorer").

## System topology

&#91;embedded content: system topology · 3 zones, 9 boxes\]

Events travel up in batches over HTTPS and the tailnet; proposals come back down as a WebSocket push. Dashed outlines mark hosts that are never trusted with state. "Policy + exec" runs actions through the existing agent mesh and triad.

## Event pipeline

&#91;embedded content: event pipeline · 8 steps, 1 feedback loop\]

Each step reads only from the log or the step before it, so any projection can be rebuilt by replaying events. In shadow mode the pipeline runs up to Execute, which is blocked and logged instead; the label step still runs from your taps and observed behaviour.

## World model: a real generative model

Replace the hardcoded scores with a small discrete generative model, learned from the event log. Today `active-inference.ts` computes `-ln(prior)` for a match or mismatch and returns constants for expected free energy. With about six hidden factors of at most five states each, exact inference is a few matrix multiplies and runs in microseconds.

**Model per hidden factor** (for example `user_mode`, `link_health`, `repo_health`):

- **A** = P(observation | state), the likelihood
- **B(a)** = P(next state | state, action), the transitions
- **C** = preferred observations, as log-probabilities (replaces the hardcoded invariants)
- **D** = prior over the initial state

Belief update from observation o with previous action a:

```latex
q(s_t) \propto A[o_t,\cdot] \odot \big(B[a_{t-1}]\, q(s_{t-1})\big)
```

Surprisal of an observation is `-ln` of its predicted probability under the current belief, so it rises and falls with context instead of being fixed per invariant. Expected free energy for a policy π is the sum of a risk term and an ambiguity term. Lower is better:

```latex
G(\pi)=\sum_{\tau}\Big[\underbrace{D_{KL}\big(q(o_\tau\mid\pi)\,\|\,p(o)\big)}_{\text{risk}}+\underbrace{\mathbb{E}_{q(s_\tau)}\big[H[P(o\mid s)]\big]}_{\text{ambiguity}}\Big]
```

Risk comes from C (how far predicted outcomes sit from what you want). Ambiguity comes from A (how uninformative the sensors are). Pragmatic and epistemic policies fall out of the same score instead of being typed in as two constants.

**Learning.** A and B are Dirichlet count tables stored in `model_params`. Each logged event increments counts, and the model can be replayed from the log at any time.

**Honesty test.** The model must beat a dumb baseline ("same action as this hour yesterday") on precision@surface in shadow mode. If it doesn't, rename it "heuristic scorer" and ship the baseline.

**Wake delta.** Replace the fixed `Δt < 4000 ms` with a quantile (start at p20) of your own logged wake-to-touch deltas, recomputed weekly.

## Morphogenetic engine v2: patches, not splices

The engine produces a reviewed patch on a branch and never changes a running system. Merging is a human action (tier T4). The current file already has no splice step, so v2 formalizes that and closes the gaps found in review.

**Gates, in order. A candidate must pass all of them:**

1. **Path jail.** Resolve the target and require it inside the worktree. Allow only listed paths. Deny `tests/`, CI config, lockfiles, secrets and the engine itself.
2. **Size and no-op.** Reject an unchanged file. Cap the diff at 200 lines and 3 files.
3. **Static checks.** `tsc --noEmit` or `py_compile`, plus lint.
4. **Reproduction test.** A new test that reproduces the friction event must fail on the base commit and pass on the candidate.
5. **Full suite.** Run all tests, with test-file hashes unchanged from the base.
6. **Execution sandbox.** Run in a separate low-privilege process or container with no network, a scrubbed environment, and CPU, memory and time limits.
7. **Diff scan.** Secret scan plus a versioned rules file (semgrep or AST). This replaces the substring check on `deprecated_root_api,banned_proxy`.

**Output:** branch `morpho/<id>`, the patch, and a gate report, all recorded in `mutations` with the friction event, base commit, strategy (model id and prompt hash) and diff hash. You review the branch and merge it yourself.

## Data schema

One SQLite database in WAL mode on the PC. `events` is append-only and hash-chained; every other table is either a decision record or a rebuildable projection.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE devices (
  device_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('android','windows','linux')),
  pubkey_spki  BLOB NOT NULL,            -- ECDSA P-256, from Android Keystore
  key_attested INTEGER NOT NULL DEFAULT 0, -- key attestation chain verified at enrollment
  scopes       TEXT NOT NULL CHECK (json_valid(scopes)),
  enrolled_at  INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT;

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,         -- client UUID, makes ingest idempotent
  device_id  TEXT NOT NULL REFERENCES devices(device_id),
  kind       TEXT NOT NULL,                -- telemetry | observation | wake | touch | action | label
  ts_device  INTEGER NOT NULL,
  ts_server  INTEGER NOT NULL,
  schema_ver INTEGER NOT NULL DEFAULT 1,
  payload    TEXT NOT NULL CHECK (json_valid(payload)),
  prev_hash  BLOB NOT NULL,
  hash       BLOB NOT NULL                 -- sha256(prev_hash || canonical(row))
) STRICT;
CREATE INDEX events_kind_ts ON events(kind, ts_server);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE invariants (
  invariant_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE model_params (        -- Dirichlet counts for A, B, C, D per factor
  factor     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('A','B','C','D')),
  version    INTEGER NOT NULL,
  counts     TEXT NOT NULL CHECK (json_valid(counts)),
  as_of_seq  INTEGER NOT NULL REFERENCES events(seq),
  PRIMARY KEY (factor, kind, version)
) STRICT;

CREATE TABLE belief_snapshots (    -- projection, rebuildable from events
  as_of_seq  INTEGER PRIMARY KEY REFERENCES events(seq),
  mode       TEXT NOT NULL CHECK (mode IN ('DEEP_FOCUS','HIGH_VELOCITY','EXPLORATORY','MAINTENANCE','REST')),
  q          TEXT NOT NULL CHECK (json_valid(q)),
  surprisal  REAL NOT NULL
) STRICT;

CREATE TABLE proposals (
  proposal_id    TEXT PRIMARY KEY,
  created_seq    INTEGER NOT NULL REFERENCES events(seq),
  invariant_id   TEXT REFERENCES invariants(invariant_id),
  policy_type    TEXT NOT NULL CHECK (policy_type IN ('PRAGMATIC','EPISTEMIC')),
  tier           INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 4),
  summary        TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (json_valid(action)),
  action_hash    BLOB NOT NULL,       -- what the approval signature binds to
  efe            REAL NOT NULL,
  risk_term      REAL NOT NULL,
  ambiguity_term REAL NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('DRAFT','GATED','SUPPRESSED','STAGED','SURFACED',
                   'APPROVED','REJECTED','EXPIRED','EXECUTING','SUCCEEDED','FAILED')),
  shadow         INTEGER NOT NULL DEFAULT 1,
  expires_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX proposals_state ON proposals(state, expires_at);

CREATE TABLE gate_decisions (
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  mode        TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('SUPPRESS','QUEUE','SURFACE','AUTO_DRY_RUN')),
  reason      TEXT NOT NULL,
  ts          INTEGER NOT NULL
) STRICT;

CREATE TABLE approvals (
  approval_id    TEXT PRIMARY KEY,
  proposal_id    TEXT NOT NULL REFERENCES proposals(proposal_id),
  device_id      TEXT NOT NULL REFERENCES devices(device_id),
  nonce          TEXT NOT NULL UNIQUE,   -- single use
  decision       TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  signed_payload BLOB NOT NULL,
  signature      BLOB NOT NULL,
  verified       INTEGER NOT NULL,
  ts             INTEGER NOT NULL
) STRICT;

CREATE TABLE executions (
  exec_id     TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  dry_run     INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  exit_code   INTEGER,
  result      TEXT CHECK (json_valid(result)),
  undo        TEXT CHECK (json_valid(undo))
) STRICT;

CREATE TABLE shadow_labels (       -- ground truth for calibration
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(proposal_id),
  label       TEXT NOT NULL CHECK (label IN ('wanted','not_wanted','already_did','ignored')),
  actual      TEXT CHECK (json_valid(actual)),
  latency_ms  INTEGER,
  ts          INTEGER NOT NULL
) STRICT;

CREATE TABLE mutations (
  mutation_id    TEXT PRIMARY KEY,
  friction_seq   INTEGER NOT NULL REFERENCES events(seq),
  base_commit    TEXT NOT NULL,
  branch         TEXT NOT NULL,
  strategy       TEXT NOT NULL,          -- model id + prompt hash
  diff_hash      BLOB NOT NULL,
  gates          TEXT NOT NULL CHECK (json_valid(gates)),
  state          TEXT NOT NULL CHECK (state IN ('REJECTED','PASSED','MERGED','DISCARDED')),
  created_at     INTEGER NOT NULL
) STRICT;
```

**Wire types** (JSON over HTTPS, batched and idempotent on `event_id`):

```ts
type EventIn  = { event_id: string; kind: string; ts_device: number; schema_ver: 1; payload: object };
type IngestReq = { device_id: string; events: EventIn[] };           // POST /v3/events, JWT + device scope
type ProposalPush = { proposal_id: string; tier: 0|1|2|3|4; summary: string;
                      action_hash: string; nonce: string; expires_at: number };   // WS /v3/stream, daemon to phone
type ApprovalReq = { proposal_id: string; decision: 'approve'|'reject';
                     nonce: string; signature: string };               // signature over canonical(ProposalPush fields + decision)
```

## Shadow mode and rollout

Shadow mode runs the full pipeline live and blocks only the executor. The executor returns `ShadowSkipped`, Glass stays silent, and every would-be proposal is logged. You can tap "wanted" or "not wanted" on a quiet notification, which writes a `shadow_labels` row. Without a tap, the system infers `already_did` or `ignored` from what you actually did next.

**Metrics to calibrate (computed weekly from the log):**

| Metric | Definition | Use |
| --- | --- | --- |
| Precision@surface | wanted ÷ (wanted + not wanted) among surfaced | Is it worth interrupting you |
| Recall | your actions that were predicted in advance ÷ all your actions | Is it seeing the pattern |
| Focus regret | proposals surfaced during DEEP\_FOCUS | Mode gate quality; target 0 |
| Brier score | calibration of predicted confidence | Are the numbers trustworthy |
| Baseline gap | precision@surface minus the "same as yesterday" baseline | Does the model earn its complexity |
| Δt quantiles | wake-to-touch deltas | Replace the fixed 4000 ms |

**Rollout gates**

| Phase | Scope | Exit criterion |
| --- | --- | --- |
| 0. Harden | Path jail, no-op guard, observation validation, signed approvals | Tests for each pass; attestation verified end to end |
| 1. Shadow | Everything live, executor off, 7 to 14 days | Baseline gap above 0 and focus regret near 0 |
| 2. T0 and T1 | Read-only probes and reversible local actions run automatically, with a notice | 2 weeks, no unwanted action |
| 3. T2 and T3 | Signed one-tap approval | Precision@surface above 0.8 over 2 weeks |
| 4. Morphogenetic | Patch branches only, human merge | Stays at patch-only; no auto-merge phase |
