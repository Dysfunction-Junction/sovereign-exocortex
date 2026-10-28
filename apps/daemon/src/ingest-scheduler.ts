import type { ExocortexDatabase } from "@exocortex/core/db";

const wakeHandlers = new WeakMap<ExocortexDatabase, () => void>();

export function registerIngestWakeHandler(db: ExocortexDatabase, wake: () => void): void {
  wakeHandlers.set(db, wake);
}

/** Returns true when the daemon's asynchronous event consumer owns projection work. */
export function scheduleIngestProcessing(db: ExocortexDatabase): boolean {
  const wake = wakeHandlers.get(db);
  if (!wake) return false;
  wake();
  return true;
}
