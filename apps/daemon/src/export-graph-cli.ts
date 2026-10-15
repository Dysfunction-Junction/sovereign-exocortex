import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { exportLivingLifeGraph, graphToCypher, linkEventToGraph } from "@exocortex/world-model";
import { WorldModelHost } from "./world-model-host.js";

interface EventRow {
  event_id: string; device_id: string; kind: string; ts_device: number; ts_server: number; payload: string;
}

function eventRows(db: DatabaseSync, filter: { kind?: string; limit?: number } = {}): EventRow[] {
  const where = filter.kind ? " WHERE kind = ?" : "";
  const limit = filter.limit === undefined ? "" : " LIMIT ?";
  const params: (string | number)[] = [];
  if (filter.kind) params.push(filter.kind);
  if (filter.limit !== undefined) params.push(filter.limit);
  return db.prepare(`SELECT event_id, device_id, kind, ts_device, ts_server, payload FROM events${where} ORDER BY seq ASC${limit}`)
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
  const prefix = resolve(args[1] ?? join(process.cwd(), `life-graph-export-${new Date().toISOString().replace(/[:.]/gu, "-")}`));
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const host = WorldModelHost.createIsolatedForTest();
    const dbView = {
      listEvents: (filter?: { kind?: string; limit?: number }) => eventRows(raw, filter),
    } as unknown as ExocortexDatabase;
    host.seedCommsFromPastEvents(dbView);
    host.seedFromPastEvents(dbView);
    for (const event of eventRows(raw, { limit: 1000 })) {
      try {
        const autoCreate = host.lifeGraph.entityCount < 20_000;
        linkEventToGraph({
          event_id: event.event_id,
          kind: event.kind,
          ts_device: event.ts_device,
          ts_server: event.ts_server,
          payload: event.payload,
        }, host.lifeGraph, { autoCreate, createMissingTopics: autoCreate });
      } catch {
        // Match daemon replay behavior: malformed legacy events do not block graph export.
      }
    }
    const graph = exportLivingLifeGraph(host.lifeGraph);
    await writeFile(`${prefix}.graph.json`, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await writeFile(`${prefix}.cypher`, graphToCypher(graph), "utf8");
    console.log(`Exported ${graph.entities.length} entities and ${graph.edges.length} edges from ${dbPath}`);
    console.log(`Wrote ${prefix}.graph.json and ${prefix}.cypher`);
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
