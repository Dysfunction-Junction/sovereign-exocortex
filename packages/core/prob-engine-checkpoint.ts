/**
 * @file prob-engine-checkpoint.ts
 * Persistence and state serialization for ProbEngine.
 *
 * Stores serialized ProbEngine states in the SQLite table `prob_engine_checkpoints`
 * to replace large history re-scans on hydrate with O(1) state loads.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ExocortexDatabase } from "./db.js";
import { ProbEngine, type EngineOptions, type SerializedProbEngineState } from "./prob-engine.js";

export const CHECKPOINT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prob_engine_checkpoints (
  device_id     TEXT PRIMARY KEY,
  last_seq      INTEGER NOT NULL,
  last_screen   TEXT,
  last_features TEXT NOT NULL,
  engine_json   TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
`;

export function ensureCheckpointTable(raw: DatabaseSync): void {
  raw.exec(CHECKPOINT_SCHEMA_SQL);
}

export function serializeProbEngine(engine: ProbEngine): string {
  return JSON.stringify(engine.toJSON());
}

export function saveProbEngineCheckpoint(
  db: ExocortexDatabase | { raw: DatabaseSync },
  deviceId: string,
  seq: number,
  screen: string | undefined,
  features: Record<string, string>,
  engine: ProbEngine,
): void {
  db.raw.prepare(`
    INSERT INTO prob_engine_checkpoints (device_id, last_seq, last_screen, last_features, engine_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      last_seq = excluded.last_seq,
      last_screen = excluded.last_screen,
      last_features = excluded.last_features,
      engine_json = excluded.engine_json,
      updated_at = excluded.updated_at
  `).run(
    deviceId,
    seq,
    screen ?? null,
    JSON.stringify(features),
    serializeProbEngine(engine),
    Date.now(),
  );
}

export interface ProbEngineCheckpointRow {
  device_id: string;
  last_seq: number;
  last_screen: string | null;
  last_features: string;
  engine_json: string;
  updated_at: number;
}

export function loadProbEngineCheckpoint(
  db: ExocortexDatabase | { raw: DatabaseSync },
  deviceId: string,
): ProbEngineCheckpointRow | null {
  try {
    const row = db.raw
      .prepare(`SELECT device_id, last_seq, last_screen, last_features, engine_json, updated_at FROM prob_engine_checkpoints WHERE device_id = ?`)
      .get(deviceId) as ProbEngineCheckpointRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}
