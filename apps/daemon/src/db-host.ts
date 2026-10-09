/**
 * @file db-host.ts
 * Host SQLite Event Store instance for exocortexd daemon (Architecture & Schema v3).
 */

import { ExocortexDatabase } from "@exocortex/core/db";
import { join } from "node:path";
import { homedir } from "node:os";

export class DbNotInitializedError extends Error {
  constructor(message = "Database has not been initialized") {
    super(message);
    this.name = "DbNotInitializedError";
  }
}

export function getDefaultDbPath(): string {
  if (process.env.EXOCORTEX_DB_PATH) {
    return process.env.EXOCORTEX_DB_PATH;
  }
  const appData = process.env.LOCALAPPDATA || join(homedir(), ".exocortex");
  return join(appData, "exocortex.db");
}

let dbInstance: ExocortexDatabase | null = null;

export function getDatabase(): ExocortexDatabase {
  if (!dbInstance) {
    dbInstance = new ExocortexDatabase({ path: getDefaultDbPath() });
  }
  return dbInstance;
}

export function hasDatabase(): boolean {
  return dbInstance !== null;
}


export function setDatabase(db: ExocortexDatabase | null): void {
  if (dbInstance && dbInstance !== db) {
    try {
      dbInstance.close();
    } catch {
      // Ignore closing error
    }
  }
  dbInstance = db;
}
