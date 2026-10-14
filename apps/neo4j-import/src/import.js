// Loads a Pieces export into Neo4j. Usage: node --env-file=.env src/import.js
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import neo4j from "neo4j-driver";

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE = "neo4j", EXPORT_ROOT } = process.env;
if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD || !EXPORT_ROOT) {
  console.error("Set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, EXPORT_ROOT");
  process.exit(1);
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD));
const session = driver.session({ database: NEO4J_DATABASE });
const BATCH = 500;

const isScalar = (v) => ["string", "number", "boolean"].includes(typeof v);
// Neo4j properties must be scalars/arrays of scalars; keep those, JSON-encode the rest.
function flatten(doc) {
  const props = {}, rest = {};
  for (const [k, v] of Object.entries(doc)) {
    if (isScalar(v) || (Array.isArray(v) && v.every(isScalar))) props[k] = v;
    else if (k === "created" || k === "updated") props[k] = v?.value ?? JSON.stringify(v);
    else rest[k] = v;
  }
  props.raw = JSON.stringify(rest);
  return props;
}
const label = (dir) => dir.replace(/[^A-Za-z0-9]/g, "").replace(/^./, (c) => c.toUpperCase());
const relType = (r) => String(r).toUpperCase().replace(/[^A-Z0-9_]/g, "_") || "RELATED";

async function flush(cypher, rows) {
  if (rows.length) await session.run(cypher, { rows });
  rows.length = 0;
}

async function importNodes(linkMap) {
  const dataDir = path.join(EXPORT_ROOT, "data");
  for (const dir of fs.readdirSync(dataDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const lbl = label(dir.name);
    const cypher = `UNWIND $rows AS r MERGE (n:Doc {hash: r.hash}) SET n:${lbl}, n += r.props`;
    const rows = [];
    for (const f of fs.readdirSync(path.join(dataDir, dir.name)).filter((n) => n.endsWith(".json"))) {
      const hash = f.slice(0, -5);
      const doc = JSON.parse(fs.readFileSync(path.join(dataDir, dir.name, f), "utf8"));
      const props = flatten(doc);
      props.path = linkMap[hash] ?? null;
      rows.push({ hash, props });
      if (rows.length >= BATCH) await flush(cypher, rows);
    }
    await flush(cypher, rows);
    console.log(`nodes: ${lbl}`);
  }
}

async function importRelationships() {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(EXPORT_ROOT, "relationships.jsonl")) });
  const byType = new Map();
  const total = { n: 0 };
  const run = async (type) => {
    const rows = byType.get(type);
    await flush(
      `UNWIND $rows AS r MERGE (a:Doc {path: r.s}) MERGE (b:Doc {path: r.t}) MERGE (a)-[:${type}]->(b)`,
      rows,
    );
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { Source, Target, Relation } = JSON.parse(line);
    const type = relType(Relation);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push({ s: Source, t: Target });
    total.n++;
    if (byType.get(type).length >= BATCH) await run(type);
  }
  for (const type of byType.keys()) await run(type);
  console.log(`relationships: ${total.n}`);
}

try {
  await session.run("CREATE INDEX doc_hash IF NOT EXISTS FOR (n:Doc) ON (n.hash)");
  await session.run("CREATE INDEX doc_path IF NOT EXISTS FOR (n:Doc) ON (n.path)");
  const linkMap = JSON.parse(fs.readFileSync(path.join(EXPORT_ROOT, "link-map.json"), "utf8"));
  await importNodes(linkMap);
  await importRelationships();
  console.log("done");
} finally {
  await session.close();
  await driver.close();
}
