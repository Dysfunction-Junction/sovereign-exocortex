import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphEdge, GraphEntity, LivingLifeGraph } from "./life-graph.js";

export interface GraphExport {
  entities: GraphEntity[];
  edges: GraphEdge[];
}

function cypherString(value: string): string {
  return JSON.stringify(value).replace(/\\u([0-9a-f]{4})/giu, "\\u$1");
}

function cypherValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return cypherString(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return String(value);
  return cypherString(JSON.stringify(value));
}

function propertyMap(entries: Array<[string, unknown]>): string {
  return `{ ${entries.map(([key, value]) => `${key}: ${cypherValue(value)}`).join(", ")} }`;
}

/** Serialize a graph snapshot as idempotent Neo4j MERGE statements. */
export function graphToCypher(graph: GraphExport): string {
  const statements = [
    "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;",
  ];
  for (const entity of graph.entities) {
    statements.push(
      `MERGE (n:Entity {id: ${cypherString(entity.id)}}) SET n += ${propertyMap([
        ["type", entity.type], ["name", entity.name], ["activation", entity.activation],
        ["lastActive", entity.lastActive], ["propertiesJson", entity.properties ?? {}],
      ])};`,
    );
  }
  for (const edge of graph.edges) {
    const rel = /^[A-Z][A-Z0-9_]*$/u.test(edge.relation) ? edge.relation : "RELATED";
    statements.push(
      `MATCH (a:Entity {id: ${cypherString(edge.sourceId)}}), (b:Entity {id: ${cypherString(edge.targetId)}}) ` +
      `MERGE (a)-[r:${rel} {id: ${cypherString(edge.id)}}]->(b) SET r += ${propertyMap([
        ["weight", edge.weight], ["observedCount", edge.observedCount],
        ["lastObserved", edge.lastObserved], ["halfLifeDays", edge.halfLifeDays ?? null],
      ])};`,
    );
  }
  return `${statements.join("\n")}\n`;
}

export function exportLivingLifeGraph(graph: LivingLifeGraph): GraphExport {
  return graph.snapshot();
}

async function main(args: string[]): Promise<void> {
  if (args.length < 2 || args.length > 4 || args[0] !== "--input" || (args.length === 4 && args[2] !== "--out")) {
    throw new Error("usage: tsx export-graph.ts --input <graph-snapshot.json> [--out <prefix>]");
  }
  const input = resolve(args[1]);
  const graph = JSON.parse(await readFile(input, "utf8")) as GraphExport;
  if (!Array.isArray(graph.entities) || !Array.isArray(graph.edges)) {
    throw new Error("input must contain entities and edges arrays");
  }
  const prefixIndex = args.indexOf("--out");
  const prefix = prefixIndex >= 0 ? resolve(args[prefixIndex + 1]) : input.replace(/\.json$/iu, "");
  await writeFile(`${prefix}.graph.json`, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await writeFile(`${prefix}.cypher`, graphToCypher(graph), "utf8");
  console.log(`Exported ${graph.entities.length} entities and ${graph.edges.length} edges to ${prefix}.{graph.json,cypher}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
