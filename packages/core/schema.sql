-- Sovereign Exocortex: Architecture & Schema v3
-- One SQLite database in WAL mode on the PC.
-- 'events' is append-only and hash-chained; every other table is either a decision record or a rebuildable projection.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('android','windows','linux')),
  pubkey_spki  BLOB NOT NULL,            -- ECDSA P-256, from Android Keystore
  key_attested INTEGER NOT NULL DEFAULT 0, -- key attestation chain verified at enrollment
  scopes       TEXT NOT NULL CHECK (json_valid(scopes)),
  enrolled_at  INTEGER NOT NULL,
  revoked_at   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS events (
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
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts_server);
CREATE UNIQUE INDEX IF NOT EXISTS events_prev_hash ON events(prev_hash);
CREATE INDEX IF NOT EXISTS events_device_seq ON events(device_id, seq);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS invariants (
  invariant_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE IF NOT EXISTS model_params (        -- Dirichlet counts for A, B, C, D per factor
  factor     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('A','B','C','D')),
  version    INTEGER NOT NULL,
  counts     TEXT NOT NULL CHECK (json_valid(counts)),
  as_of_seq  INTEGER NOT NULL REFERENCES events(seq),
  PRIMARY KEY (factor, kind, version)
) STRICT;

CREATE TABLE IF NOT EXISTS belief_snapshots (    -- projection, rebuildable from events
  as_of_seq  INTEGER PRIMARY KEY REFERENCES events(seq),
  mode       TEXT NOT NULL CHECK (mode IN ('DEEP_FOCUS','HIGH_VELOCITY','EXPLORATORY','MAINTENANCE','REST')),
  q          TEXT NOT NULL CHECK (json_valid(q)),
  surprisal  REAL NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS proposals (
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
CREATE INDEX IF NOT EXISTS proposals_state ON proposals(state, expires_at);

CREATE TABLE IF NOT EXISTS gate_decisions (
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  mode        TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('SUPPRESS','QUEUE','SURFACE','AUTO_DRY_RUN')),
  reason      TEXT NOT NULL,
  ts          INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS approvals (
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

CREATE TABLE IF NOT EXISTS executions (
  exec_id     TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(proposal_id),
  dry_run     INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  exit_code   INTEGER,
  result      TEXT CHECK (json_valid(result)),
  undo        TEXT CHECK (json_valid(undo))
) STRICT;

CREATE TABLE IF NOT EXISTS shadow_labels (       -- ground truth for calibration
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(proposal_id),
  label       TEXT NOT NULL CHECK (label IN ('wanted','not_wanted','already_did','ignored')),
  actual      TEXT CHECK (json_valid(actual)),
  latency_ms  INTEGER,
  ts          INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS device_push_tokens (
  device_id  TEXT PRIMARY KEY REFERENCES devices(device_id),
  token      TEXT NOT NULL,
  platform   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mutations (
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

CREATE TABLE IF NOT EXISTS prob_engine_checkpoints (
  device_id     TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL,
  last_screen   TEXT,
  last_features TEXT NOT NULL,
  engine_json   TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
