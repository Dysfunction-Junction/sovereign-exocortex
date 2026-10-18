import type { GraphEntity, GraphEdge, GraphExport } from "@exocortex/world-model";
import type { WorldModelHost } from "./world-model-host.js";

export interface Neo4jSyncOptions {
  url?: string;
  user?: string;
  password?: string;
  database?: string;
  batchSize?: number;
}

export interface Neo4jSyncStatus {
  enabled: boolean;
  connected: boolean;
  lastSyncAt: string | null;
  nodeCount: number;
  edgeCount: number;
  lastError: string | null;
}

export interface GraphHub {
  id: string;
  label: string;
  type: string;
  degree: number;
}

export interface StaleEntity {
  id: string;
  label: string;
  type: string;
  lastActive: number | null;
}

export interface TypeDistribution {
  type: string;
  count: number;
}

export interface EdgeDistribution {
  relType: string;
  count: number;
}

export interface GraphAnalyticsResult {
  nodeCount: number;
  edgeCount: number;
  hubs: GraphHub[];
  staleEntities: StaleEntity[];
  typeDistribution: TypeDistribution[];
  edgeDistribution: EdgeDistribution[];
  analyzedAt: string;
}

export interface GraphQueryResult {
  mode: "nl" | "cypher";
  cypher: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  matchedEntityIds: string[];
}

const ALLOWED_LABELS: Record<string, string> = {
  PERSON: "Person",
  PROJECT: "Project",
  DEVICE: "Device",
  GOAL: "Goal",
  TOPIC: "Topic",
  CONTEXT_STATE: "ContextState",
  FILE: "File",
  CODE_MODULE: "CodeModule",
  LOCATION: "Location",
  ROUTINE: "Routine",
};

export function labelForType(type: unknown): string {
  if (typeof type !== "string") return "Generic";
  const upper = type.trim().toUpperCase();
  if (ALLOWED_LABELS[upper]) {
    return ALLOWED_LABELS[upper];
  }
  // Sanitize non-allowlisted types: alphanumeric + underscores only, max 48 chars
  const sanitized = type.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
  if (!sanitized) return "Generic";
  // Cypher identifiers must start with an ASCII letter
  return /^[A-Za-z]/.test(sanitized) ? sanitized : `Type_${sanitized}`;
}

export function safeRelType(rel: unknown): string {
  if (typeof rel !== "string") return "RELATED";
  const trimmed = rel.trim();
  return /^[A-Z][A-Z0-9_]{0,48}$/u.test(trimmed) ? trimmed : "RELATED";
}

export class GraphQueryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphQueryRejectedError";
  }
}

function sanitizeForScan(q: string): string {
  return q
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
}

const FORBIDDEN_CYPHER = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|ALTER|LOAD|CALL|FOREACH|TERMINATE|GRANT|DENY|REVOKE|START|STOP|USE)\b/i;
const ALLOWED_CYPHER_PREFIX = /^\s*(MATCH|RETURN|WITH|UNWIND|EXPLAIN|PROFILE)\b/i;

export class Neo4jSyncService {
  private readonly url: string;
  private readonly user: string;
  private readonly pass: string;
  private readonly database: string;
  private readonly batchSize: number;

  private connected = false;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private cachedNodeCount = 0;
  private cachedEdgeCount = 0;
  private autoSyncAttached = false;
  private cachedAnalytics: { data: GraphAnalyticsResult; expiresAt: number } | null = null;

  constructor(options: Neo4jSyncOptions = {}) {
    this.url = options.url || process.env.NEO4J_URL || "http://127.0.0.1:7474";
    this.user = options.user || process.env.NEO4J_USER || "neo4j";
    this.pass = options.password || process.env.NEO4J_PASSWORD || "codecode";
    this.database = options.database || process.env.NEO4J_DATABASE || "neo4j";
    this.batchSize = options.batchSize || 100;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString("base64")}`;
  }

  private endpointUrl(): string {
    return `${this.url.replace(/\/$/, "")}/db/${encodeURIComponent(this.database)}/tx/commit`;
  }

  /**
   * Execute Cypher statements against the Neo4j transactional HTTP endpoint.
   */
  public async executeCypher(
    statements: Array<{ statement: string; parameters?: Record<string, unknown> }>,
  ): Promise<any> {
    if (statements.length === 0) return { results: [], errors: [] };

    const res = await fetch(this.endpointUrl(), {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ statements }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Neo4j HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { results?: any[]; errors?: Array<{ message: string }> };
    if (data.errors && data.errors.length > 0) {
      throw new Error(`Neo4j Cypher error: ${data.errors.map((e) => e.message).join("; ")}`);
    }

    return data;
  }

  /**
   * Check connection and refresh server counts.
   */
  public async checkHealth(): Promise<boolean> {
    try {
      const data = await this.executeCypher([
        { statement: "MATCH (n:Entity) RETURN count(n) AS nodeCount" },
        { statement: "MATCH ()-[r]->() RETURN count(r) AS edgeCount" },
      ]);
      const nodeCount = data.results?.[0]?.data?.[0]?.row?.[0] ?? 0;
      const edgeCount = data.results?.[1]?.data?.[0]?.row?.[0] ?? 0;
      this.connected = true;
      this.cachedNodeCount = Number(nodeCount);
      this.cachedEdgeCount = Number(edgeCount);
      this.lastError = null;
      return true;
    } catch (err) {
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /**
   * Ensure necessary constraints and indexes exist.
   */
  public async initSchema(): Promise<void> {
    await this.executeCypher([
      { statement: "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;" },
      { statement: "CREATE INDEX entity_type IF NOT EXISTS FOR (n:Entity) ON (n.type);" },
    ]);
  }

  /**
   * Perform an idempotent full graph sync.
   */
  public async syncGraph(graph: GraphExport): Promise<{ entities: number; edges: number }> {
    await this.initSchema();

    // 1. Upsert entities in chunks
    for (let i = 0; i < graph.entities.length; i += this.batchSize) {
      const chunk = graph.entities.slice(i, i + this.batchSize);
      const statements = chunk.map((entity) => {
        const secLabel = labelForType(entity.type);
        return {
          statement: `
            MERGE (n:Entity {id: $id})
            SET n:${secLabel}, n += {
              name: $name,
              type: $type,
              activation: $activation,
              lastActive: $lastActive,
              propertiesJson: $propertiesJson
            }
          `,
          parameters: {
            id: entity.id,
            name: entity.name,
            type: entity.type,
            activation: entity.activation,
            lastActive: entity.lastActive,
            propertiesJson: JSON.stringify(entity.properties ?? {}),
          },
        };
      });
      await this.executeCypher(statements);
    }

    // 2. Upsert edges in chunks
    for (let i = 0; i < graph.edges.length; i += this.batchSize) {
      const chunk = graph.edges.slice(i, i + this.batchSize);
      const statements = chunk.map((edge) => {
        const rel = safeRelType(edge.relation);
        return {
          statement: `
            MATCH (a:Entity {id: $sourceId}), (b:Entity {id: $targetId})
            MERGE (a)-[r:${rel} {id: $id}]->(b)
            SET r += {
              weight: $weight,
              observedCount: $observedCount,
              lastObserved: $lastObserved,
              halfLifeDays: $halfLifeDays
            }
          `,
          parameters: {
            id: edge.id,
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            weight: edge.weight,
            observedCount: edge.observedCount,
            lastObserved: edge.lastObserved,
            halfLifeDays: edge.halfLifeDays ?? null,
          },
        };
      });
      await this.executeCypher(statements);
    }

    this.lastSyncAt = new Date().toISOString();
    this.cachedNodeCount = graph.entities.length;
    this.cachedEdgeCount = graph.edges.length;
    this.connected = true;
    this.lastError = null;

    return { entities: graph.entities.length, edges: graph.edges.length };
  }

  /**
   * Upsert a subset of entities and edges (e.g. from an incremental pulse).
   */
  public async syncPulse(entities: GraphEntity[], edges: GraphEdge[]): Promise<void> {
    if (entities.length === 0 && edges.length === 0) return;

    const statements: Array<{ statement: string; parameters: Record<string, unknown> }> = [];

    for (const entity of entities) {
      const secLabel = labelForType(entity.type);
      statements.push({
        statement: `
          MERGE (n:Entity {id: $id})
          SET n:${secLabel}, n += {
            name: $name,
            type: $type,
            activation: $activation,
            lastActive: $lastActive,
            propertiesJson: $propertiesJson
          }
        `,
        parameters: {
          id: entity.id,
          name: entity.name,
          type: entity.type,
          activation: entity.activation,
          lastActive: entity.lastActive,
          propertiesJson: JSON.stringify(entity.properties ?? {}),
        },
      });
    }

    for (const edge of edges) {
      const rel = safeRelType(edge.relation);
      statements.push({
        statement: `
          MATCH (a:Entity {id: $sourceId}), (b:Entity {id: $targetId})
          MERGE (a)-[r:${rel} {id: $id}]->(b)
          SET r += {
            weight: $weight,
            observedCount: $observedCount,
            lastObserved: $lastObserved,
            halfLifeDays: $halfLifeDays
          }
        `,
        parameters: {
          id: edge.id,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          weight: edge.weight,
          observedCount: edge.observedCount,
          lastObserved: edge.lastObserved,
          halfLifeDays: edge.halfLifeDays ?? null,
        },
      });
    }

    for (let i = 0; i < statements.length; i += this.batchSize) {
      const chunk = statements.slice(i, i + this.batchSize);
      await this.executeCypher(chunk);
    }

    this.lastSyncAt = new Date().toISOString();
  }

  private pendingEntities = new Map<string, GraphEntity>();
  private pendingEdges = new Map<string, GraphEdge>();
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Hook into WorldModelHost to automatically sync live pulses and updates.
   */
  public attachToHost(host: WorldModelHost): () => void {
    if (this.autoSyncAttached) return () => {};
    this.autoSyncAttached = true;

    // Run initial background sync
    void (async () => {
      const healthy = await this.checkHealth();
      if (healthy) {
        try {
          const snapshot = host.lifeGraph.snapshot();
          await this.syncGraph(snapshot);
          console.log(`[neo4j-sync] initial sync completed: ${snapshot.entities.length} entities, ${snapshot.edges.length} edges`);
        } catch (err) {
          console.warn("[neo4j-sync] initial sync warning:", err);
        }
      }
    })();

    // Listen to graph mutations
    const unsubscribe = host.onGraphUpdated((ctx) => {
      if (ctx.subgraph) {
        for (const ent of ctx.subgraph.entities) {
          this.pendingEntities.set(ent.id, ent);
        }
        for (const edge of ctx.subgraph.edges) {
          this.pendingEdges.set(edge.id, edge);
        }

        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flushPending();
          }, 1500);
        }
      }
    });

    return () => {
      unsubscribe();
      this.autoSyncAttached = false;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
    };
  }

  private async flushPending(): Promise<void> {
    if (this.pendingEntities.size === 0 && this.pendingEdges.size === 0) return;

    const entities = Array.from(this.pendingEntities.values());
    const edges = Array.from(this.pendingEdges.values());
    this.pendingEntities.clear();
    this.pendingEdges.clear();

    try {
      await this.syncPulse(entities, edges);
    } catch (err) {
      console.warn("[neo4j-sync] background pulse sync warning:", err);
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  public getStatus(): Neo4jSyncStatus {
    return {
      enabled: Boolean(this.url),
      connected: this.connected,
      lastSyncAt: this.lastSyncAt,
      nodeCount: this.cachedNodeCount,
      edgeCount: this.cachedEdgeCount,
      lastError: this.lastError,
    };
  }

  /**
   * Run graph analytics over Neo4j: hub centrality, stale/neglected entities, and cluster distributions.
   * Cached for 30 seconds to minimize full-graph scan overhead.
   */
  public async getGraphAnalytics(): Promise<GraphAnalyticsResult> {
    const now = Date.now();
    if (this.cachedAnalytics && this.cachedAnalytics.expiresAt > now) {
      return this.cachedAnalytics.data;
    }

    const data = await this.executeCypher([
      { statement: "MATCH (n:Entity) RETURN count(n) AS nodeCount" },
      { statement: "MATCH ()-[r]->() RETURN count(r) AS edgeCount" },
      {
        statement:
          "MATCH (n:Entity)-[r]-(m) RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, count(r) AS degree ORDER BY degree DESC LIMIT 10",
      },
      {
        statement:
          "MATCH (n:Entity) WHERE n.lastActive IS NOT NULL RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, n.lastActive AS lastActive ORDER BY n.lastActive ASC LIMIT 10",
      },
      {
        statement:
          "MATCH (n:Entity) RETURN n.type AS type, count(n) AS count ORDER BY count DESC LIMIT 15",
      },
      {
        statement:
          "MATCH ()-[r]->() RETURN type(r) AS relType, count(r) AS count ORDER BY count DESC LIMIT 15",
      },
    ]);

    const nodeCount = Number(data.results?.[0]?.data?.[0]?.row?.[0] ?? 0);
    const edgeCount = Number(data.results?.[1]?.data?.[0]?.row?.[0] ?? 0);

    const hubs: GraphHub[] = (data.results?.[2]?.data ?? []).map((d: any) => ({
      id: String(d.row?.[0] ?? ""),
      label: String(d.row?.[1] ?? d.row?.[0] ?? ""),
      type: String(d.row?.[2] ?? "UNKNOWN"),
      degree: Number(d.row?.[3] ?? 0),
    }));

    const staleEntities: StaleEntity[] = (data.results?.[3]?.data ?? []).map((d: any) => ({
      id: String(d.row?.[0] ?? ""),
      label: String(d.row?.[1] ?? d.row?.[0] ?? ""),
      type: String(d.row?.[2] ?? "UNKNOWN"),
      lastActive: typeof d.row?.[3] === "number" ? d.row[3] : null,
    }));

    const typeDistribution: TypeDistribution[] = (data.results?.[4]?.data ?? []).map((d: any) => ({
      type: String(d.row?.[0] ?? "UNKNOWN"),
      count: Number(d.row?.[1] ?? 0),
    }));

    const edgeDistribution: EdgeDistribution[] = (data.results?.[5]?.data ?? []).map((d: any) => ({
      relType: String(d.row?.[0] ?? "RELATED"),
      count: Number(d.row?.[1] ?? 0),
    }));

    const result: GraphAnalyticsResult = {
      nodeCount,
      edgeCount,
      hubs,
      staleEntities,
      typeDistribution,
      edgeDistribution,
      analyzedAt: new Date(now).toISOString(),
    };

    this.cachedAnalytics = { data: result, expiresAt: now + 30_000 };
    return result;
  }

  /**
   * Execute a Natural Language or direct Cypher query against the living graph.
   * Direct Cypher queries are strictly validated to prevent data mutations.
   */
  public async queryLivingGraph(query: string, mode: "nl" | "cypher" = "nl"): Promise<GraphQueryResult> {
    const raw = query.trim();
    if (!raw) {
      return { mode, cypher: "", columns: [], rows: [], matchedEntityIds: [] };
    }

    let statement = "";
    let params: Record<string, unknown> = {};

    if (mode === "cypher") {
      const sanitized = sanitizeForScan(raw);
      if (FORBIDDEN_CYPHER.test(sanitized)) {
        throw new GraphQueryRejectedError("Forbidden operation in read-only Living Brain query");
      }
      if (!ALLOWED_CYPHER_PREFIX.test(sanitized)) {
        throw new GraphQueryRejectedError("Living Brain queries must begin with MATCH, RETURN, WITH, UNWIND, EXPLAIN, or PROFILE");
      }
      statement = raw;
    } else {
      const lower = raw.toLowerCase();
      if (lower.includes("project")) {
        statement =
          "MATCH (n:Project) OPTIONAL MATCH (n)-[r]-(m:Entity) RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, count(r) AS degree ORDER BY degree DESC LIMIT 25";
      } else if (lower.includes("person") || lower.includes("people")) {
        statement =
          "MATCH (n:Person) OPTIONAL MATCH (n)-[r]-(m:Entity) RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, count(r) AS degree ORDER BY degree DESC LIMIT 25";
      } else if (lower.includes("device") || lower.includes("hardware") || lower.includes("phone")) {
        statement =
          "MATCH (n:Device) OPTIONAL MATCH (n)-[r]-(m:Entity) RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, count(r) AS degree ORDER BY degree DESC LIMIT 25";
      } else if (lower.includes("topic")) {
        statement =
          "MATCH (n:Topic) OPTIONAL MATCH (n)-[r]-(m:Entity) RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, count(r) AS degree ORDER BY degree DESC LIMIT 25";
      } else if (lower.includes("stale") || lower.includes("neglected") || lower.includes("idle")) {
        statement =
          "MATCH (n:Entity) WHERE n.lastActive IS NOT NULL RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, n.lastActive AS lastActive ORDER BY n.lastActive ASC LIMIT 25";
      } else {
        statement =
          "MATCH (n:Entity) WHERE toLower(coalesce(n.name, '')) CONTAINS toLower($q) OR toLower(n.id) CONTAINS toLower($q) OR toLower(n.type) CONTAINS toLower($q) OPTIONAL MATCH (n)-[r]-(m:Entity) RETURN n.id AS id, coalesce(n.name, n.id) AS label, n.type AS type, count(r) AS degree ORDER BY degree DESC LIMIT 25";
        params = { q: raw };
      }
    }

    const data = await this.executeCypher([{ statement, parameters: params }]);
    const columns: string[] = data.results?.[0]?.columns ?? [];
    const rawRows = (data.results?.[0]?.data ?? []).slice(0, 200);
    const rows: Array<Record<string, unknown>> = rawRows.map((d: any) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        obj[col] = d.row?.[idx];
      });
      return obj;
    });

    const matchedEntityIds: string[] = rows
      .map((r) => (typeof r.id === "string" ? r.id : ""))
      .filter(Boolean);

    return {
      mode,
      cypher: statement,
      columns,
      rows,
      matchedEntityIds,
    };
  }
}

export const defaultNeo4jSyncService = new Neo4jSyncService();
