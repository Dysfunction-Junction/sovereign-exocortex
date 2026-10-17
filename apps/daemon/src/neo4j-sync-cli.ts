import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { linkEventToGraph } from "@exocortex/world-model";
import { WorldModelHost } from "./world-model-host.js";
import { defaultNeo4jSyncService } from "./neo4j-sync.js";

interface EventRow {
  event_id: string;
  device_id: string;
  kind: string;
  ts_device: number;
  ts_server: number;
  payload: string;
}

function eventRows(db: DatabaseSync, filter: { kind?: string; limit?: number } = {}): EventRow[] {
  const where = filter.kind ? " WHERE kind = ?" : "";
  const limit = filter.limit === undefined ? "" : " LIMIT ?";
  const params: (string | number)[] = [];
  if (filter.kind) params.push(filter.kind);
  if (filter.limit !== undefined) params.push(filter.limit);
  return db
    .prepare(`SELECT event_id, device_id, kind, ts_device, ts_server, payload FROM events${where} ORDER BY seq ASC${limit}`)
    .all(...params) as unknown as EventRow[];
}

function defaultDatabasePath(): string {
  if (process.env.EXOCORTEX_DB_PATH) return process.env.EXOCORTEX_DB_PATH;
  const appData = process.env.LOCALAPPDATA || join(homedir(), ".exocortex");
  return join(appData, "exocortex.db");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = resolve(args[0] ?? defaultDatabasePath());

  console.log(`Connecting to Neo4j...`);
  const healthy = await defaultNeo4jSyncService.checkHealth();
  if (!healthy) {
    const status = defaultNeo4jSyncService.getStatus();
    console.error(`Failed to connect to Neo4j: ${status.lastError}`);
    console.error(`Please verify Neo4j is running and credentials in .env are correct.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Neo4j connected successfully.`);

  console.log(`Loading events from ${dbPath}...`);
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const host = WorldModelHost.createIsolatedForTest();
    const dbView = {
      listEvents: (filter?: { kind?: string; limit?: number }) => eventRows(raw, filter),
    } as unknown as ExocortexDatabase;

    console.log(`Hydrating seeds (comms & past events)...`);
    host.seedCommsFromPastEvents(dbView);
    host.seedFromPastEvents(dbView);

    console.log(`Replaying events through LifeGraph linker...`);
    const allEvents = eventRows(raw);
    let linked = 0;
    for (const event of allEvents) {
      try {
        const autoCreate = host.lifeGraph.entityCount < 20_000;
        linkEventToGraph(
          {
            event_id: event.event_id,
            kind: event.kind,
            ts_device: event.ts_device,
            ts_server: event.ts_server,
            payload: event.payload,
          },
          host.lifeGraph,
          { autoCreate, createMissingTopics: autoCreate },
        );
        linked++;
      } catch {
        // match replay behavior
      }
    }
    console.log(`Linked ${linked}/${allEvents.length} events into in-memory Living Brain.`);

    const snapshot = host.lifeGraph.snapshot();
    console.log(`Syncing ${snapshot.entities.length} entities and ${snapshot.edges.length} relationships into Neo4j...`);

    const start = Date.now();
    const result = await defaultNeo4jSyncService.syncGraph(snapshot);
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    console.log(`✅ Neo4j Import Complete in ${duration}s!`);
    console.log(`  - Entities in Neo4j: ${result.entities}`);
    console.log(`  - Relationships in Neo4j: ${result.edges}`);
  } finally {
    raw.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
