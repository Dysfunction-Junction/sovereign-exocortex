/**
 * @file schema.ts
 * SQLite schema for the databank index. See docs/DATABANK_ARCHITECTURE.md.
 */

import { ITEM_KINDS } from "./text.js";
import { SENSITIVITY_SQL } from "./sensitivity.js";

export const SCHEMA_VERSION = 3;

export const KINDS_SQL = ITEM_KINDS.map((k) => `'${k}'`).join(",");

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS items (
  item_id     TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN (${KINDS_SQL})),
  title       TEXT NOT NULL,
  path        TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  ts          INTEGER NOT NULL,
  blob_id     TEXT,
  meta        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
  tier        TEXT NOT NULL DEFAULT 'archived' CHECK (tier IN ('hot','archived')),
  sensitivity TEXT NOT NULL DEFAULT 'personal' CHECK (sensitivity IN (${SENSITIVITY_SQL})),
  ingested_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS items_kind_ts ON items(kind, ts);
CREATE INDEX IF NOT EXISTS items_source ON items(source);
CREATE INDEX IF NOT EXISTS items_blob ON items(blob_id);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id INTEGER PRIMARY KEY,
  item_id  TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  text     TEXT NOT NULL,
  UNIQUE (item_id, ord)
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='chunk_id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.chunk_id, old.text);
END;

CREATE TABLE IF NOT EXISTS vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL CHECK (dim > 0),
  scale    REAL NOT NULL,
  q8       BLOB NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS ingest_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  action    TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS ingest_log_no_update BEFORE UPDATE ON ingest_log
  BEGIN SELECT RAISE(ABORT, 'ingest_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ingest_log_no_delete BEFORE DELETE ON ingest_log
  BEGIN SELECT RAISE(ABORT, 'ingest_log is append-only'); END;
`;
