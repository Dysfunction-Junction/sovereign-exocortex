/**
 * @file graph-client.ts
 * Fail-soft client for the Pieces knowledge graph in Neo4j (loaded by apps/neo4j-import). Used by
 * memory.search to add graph matches next to the hot LocalLTM ones and the databank archive.
 *
 * Talks to the Neo4j Query API over HTTP (no driver dependency): Aura and Neo4j 5.19+ both serve it.
 * Fail-soft by contract: an unreachable DB, bad credentials or a slow link never throws and never delays
 * the local answer by more than `timeoutMs`. Hits are recalled data, so they are flagged `untrusted`.
 */

export interface GraphHit {
  kind: string;
  title: string;
  snippet: string;
  path: string;
  /** Number of edges touching the node: a cheap relevance hint (well-connected records matter more). */
  links: number;
  untrusted: true;
}

export type GraphResult =
  | { available: true; hits: GraphHit[] }
  | { available: false; reason: "unreachable" | "unauthorized" | "error" };

export interface GraphClientOptions {
  /** Full Query API URL, e.g. https://<id>.databases.neo4j.io/db/neo4j/query/v2 */
  queryUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_SNIPPET = 300;

/** Aura schema (loaded by the Pieces export): (:PiecesRecord:<Kind> {piecesId, kind, name, ref, created}). */
const CYPHER = `
MATCH (n:PiecesRecord)
WHERE toLower(coalesce(n.name, '')) CONTAINS toLower($q) OR toLower(coalesce(n.ref, '')) CONTAINS toLower($q)
RETURN coalesce(n.kind, [l IN labels(n) WHERE l <> 'PiecesRecord'][0], '') AS kind,
       coalesce(n.name, n.ref, '') AS title,
       coalesce(n.ref, '') AS snippet,
       coalesce(n.piecesId, '') AS path,
       COUNT { (n)--() } AS links
ORDER BY links DESC
LIMIT $k`;

export class GraphClient {
  private readonly queryUrl: string;
  private readonly auth: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GraphClientOptions) {
    this.queryUrl = opts.queryUrl;
    this.auth = "Basic " + Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Client from NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD (+ optional NEO4J_DATABASE, NEO4J_HTTP_URL),
   * or null when the graph is not configured. Bolt-style URIs map to the HTTP endpoint:
   * neo4j+s://h -> https://h, bolt://localhost:7687 -> http://localhost:7474.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): GraphClient | null {
    const uri = env.NEO4J_URI?.trim();
    const username = env.NEO4J_USERNAME?.trim();
    const password = env.NEO4J_PASSWORD;
    if (!uri || !username || !password) return null;
    const db = encodeURIComponent(env.NEO4J_DATABASE?.trim() || "neo4j");
    let base = env.NEO4J_HTTP_URL?.trim();
    if (!base) {
      const m = /^(neo4j|bolt)(\+s|\+ssc)?:\/\/([^/:]+)(?::\d+)?/i.exec(uri);
      if (!m) return null;
      base = m[2] ? `https://${m[3]}` : `http://${m[3]}:7474`;
    }
    try {
      new URL(base);
    } catch {
      return null;
    }
    return new GraphClient({ queryUrl: `${base.replace(/\/+$/, "")}/db/${db}/query/v2`, username, password });
  }

  async search(query: string, k = 5): Promise<GraphResult> {
    try {
      const res = await this.fetchImpl(this.queryUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: this.auth },
        body: JSON.stringify({ statement: CYPHER, parameters: { q: query, k } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 401 || res.status === 403) return { available: false, reason: "unauthorized" };
      if (!res.ok) return { available: false, reason: "error" };
      const body = (await res.json()) as { data?: { values?: unknown } };
      const rows = body?.data?.values;
      if (!Array.isArray(rows)) return { available: false, reason: "error" };
      const hits: GraphHit[] = [];
      for (const r of rows as unknown[][]) {
        if (!Array.isArray(r) || typeof r[1] !== "string") continue;
        hits.push({
          kind: String(r[0] || "Other"),
          title: String(r[1]).slice(0, MAX_SNIPPET),
          snippet: String(r[2] ?? "").slice(0, MAX_SNIPPET),
          path: String(r[3] ?? ""),
          links: typeof r[4] === "number" ? r[4] : 0,
          untrusted: true,
        });
      }
      return { available: true, hits };
    } catch {
      return { available: false, reason: "unreachable" };
    }
  }
}
