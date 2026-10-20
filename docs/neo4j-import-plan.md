# Plan: Load a Pieces export into Neo4j (handoff for a local model)

Audience: a small local model (Qwen etc.) doing this with no prior context. Follow the steps in order. Do not skip verification. Do not invent fields: every field name below was read from the real export.

## 0. Rules (read first)

1. NEVER print, log, or commit a password. Only the `.env` file holds it. `.env` is already in `.gitignore`.
2. Do not read files outside the repo and the export folder.
3. Do not change the schema in section 3 without being told to.
4. If a step fails, report the exact first error line. Do not guess a fix more than twice.
5. Commit nothing unless asked.

## 1. Goal

Turn the Pieces export folder into a graph in Neo4j so you can query it (people, tags, websites, summaries, how they link).

Export location (Windows example): `%LOCALAPPDATA%/Pieces-Exports/<export-folder>`
Repo: `sovereign-exocortex`, importer lives in `apps/neo4j-import/`.

## 2. Architecture

```
Pieces export folder                     Node script (apps/neo4j-import)            Neo4j
-----------------------                  --------------------------------           -----
data/<kind>/<hash>.json   --- pass 1 --> UNWIND batches, MERGE (:Doc {hash})  --->  nodes
link-map.json (hash->md)  --- pass 1 --> sets n.path on each node
relationships.jsonl       --- pass 2 --> MERGE (:Doc {path})-[:REL]->(:Doc {path})  edges
```

Two passes, idempotent (MERGE everywhere), so re-running is safe.
Target DB: either Neo4j Aura (cloud, free tier) or Neo4j Desktop (local, free; installer is in Downloads, URI `bolt://localhost:7687`). Local is preferred if the model runs locally anyway.

### Real export layout (verified)

| Path | Contents |
|---|---|
| `data/anchors` (106), `annotations` (5243), `persons` (1), `pipelines` (10), `ranges` (104), `sources` (33), `summaries` (123), `tags` (642), `websites` (1399) | one JSON file per record, filename = `<sha256hash>.json` |
| `link-map.json` | `{ "<hash>": "markdown/<kind>/<hash>.md", ... }` |
| `relationships.jsonl` | one JSON per line: `{"Source":"<md path>","Target":"<md path>","Relation":"summaries"}` |
| `timeline/records.jsonl` | `{"type","id","path","title","created","updated","time_basis"}` (NOT imported in v1) |
| `markdown/`, `workstream_summaries/` | rendered markdown (Targets in relationships often point here; they have no JSON) |

Gotchas found in the data:
- Relationships reference **markdown paths, not hashes**. Match edges on `path`.
- Many Targets (e.g. `workstream_summaries/timeline/...md`) have no JSON record, so they become stub nodes with only `path`.
- JSON records contain nested objects (e.g. `access`, `schema`, `summaries.indices`). Neo4j properties cannot be maps, so nested values are stored as one JSON string in `raw`.
- `created` is `{ "readable": "16 days ago", "value": "2026-09-25T17:27:37Z" }`; keep only `value`.

## 3. Graph schema

Nodes
- Every node has label `:Doc`.
- Plus one kind label from its folder: `:Anchors :Annotations :Persons :Pipelines :Ranges :Sources :Summaries :Tags :Websites`.
- Properties: `hash` (unique key for JSON-backed nodes), `path` (markdown path, may be null for nodes with no markdown), all scalar top-level JSON fields (`id`, `category`, `source`, `interactions`, ...), `created`/`updated` as ISO strings, `raw` (JSON string of everything non-scalar).
- Stub nodes (from edges only): `:Doc {path}` with no `hash`.

Relationships
- `(:Doc)-[:<RELATION>]->(:Doc)` where `<RELATION>` = uppercased, non-alphanumeric to `_`, from the `Relation` field (e.g. `SUMMARIES`).

Indexes (created by the script)
- `doc_hash` on `:Doc(hash)`, `doc_path` on `:Doc(path)`.

Out of scope for v1: timeline events, embeddings, markdown body text.

## 4. Setup steps

1. Choose a database.
   - Local: install Neo4j Desktop, create a DBMS, set a password, start it. URI = `bolt://localhost:7687`, user `neo4j`.
   - Aura: use the URI/user/password from the Aura credentials file the user downloaded.
2. In `apps/neo4j-import/` copy `.env.example` to `.env` and fill:
   ```
   NEO4J_URI=bolt://localhost:7687
   NEO4J_USERNAME=neo4j
   NEO4J_PASSWORD=<ask the user, never print it>
   NEO4J_DATABASE=neo4j
   EXPORT_ROOT=C:/Users/<Username>/AppData/Local/Pieces-Exports/<export-folder>
   ```
3. `npm install` (only dependency: `neo4j-driver`).
4. `node --env-file=.env src/import.js`
5. Run the verification queries in section 6.

Time: install 1 minute; import of ~7,600 nodes plus ~relationships.jsonl lines (about 1.8 MB) should take 1 to 3 minutes.

## 5. Code

### `apps/neo4j-import/package.json`
```json
{
  "name": "neo4j-import",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": { "import": "node src/import.js" },
  "dependencies": { "neo4j-driver": "^5.28.0" }
}
```

### `apps/neo4j-import/src/import.js`
```js
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
```

This file already exists on disk; do not rewrite it unless it is missing.

## 6. Verification (run in Neo4j Browser)

```cypher
// 1. node counts per kind; expect anchors 106, annotations 5243, persons 1, pipelines 10, ranges 104, sources 33, summaries 123, tags 642, websites 1399
MATCH (n:Doc) UNWIND labels(n) AS l WITH l, count(*) AS c WHERE l <> 'Doc' RETURN l, c ORDER BY c DESC;

// 2. relationship counts by type
MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c ORDER BY c DESC;

// 3. stub nodes (edge targets with no JSON record); expected to be non-zero
MATCH (n:Doc) WHERE n.hash IS NULL RETURN count(n);

// 4. connectivity sanity
MATCH (a:Doc)-[r]->(b:Doc) RETURN a.path, type(r), b.path LIMIT 5;

// 5. duplicate check; expect zero rows
MATCH (n:Doc) WHERE n.path IS NOT NULL WITH n.path AS p, count(*) AS c WHERE c > 1 RETURN p, c LIMIT 5;
```

Success = query 1 counts match, query 2 non-empty, query 5 empty.

## 7. Known issues and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `Neo.ClientError.Security.Unauthorized` | wrong user/password | re-check `.env`; do not print it |
| `Property values can only be of primitive types` | a nested value reached props | add that key to the `rest` branch in `flatten` |
| `ECONNREFUSED` | local DBMS not started | start it in Neo4j Desktop |
| Edge count lower than lines in `relationships.jsonl` | duplicate lines merge into one edge | expected |
| Two nodes with same `path` | node created via edge before its JSON record was loaded | impossible in this order (nodes first); if seen, re-run |
| Very slow | batch too small or no indexes | confirm indexes exist (`SHOW INDEXES`) |

## 8. v2 ideas (do not start unless asked)

1. Import `timeline/records.jsonl` as `:Event` nodes linked by `path`.
2. Load markdown bodies into a `text` property for full-text search (`CREATE FULLTEXT INDEX`).
3. Embeddings and a vector index on summaries.
4. Add a `verify.js` that runs the section 6 queries and prints pass/fail.

## 9. Definition of done

- `node --env-file=.env src/import.js` prints `done` with no error.
- Section 6 queries pass.
- No password appears in any file tracked by git (`git status` shows `.env` untracked/ignored).
