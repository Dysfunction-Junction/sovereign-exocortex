/**
 * @file curation-artifacts.ts
 * Canonical curation artifacts for the World-Model Store (PLAN_WORLD_MODEL_STORE_2026-10-31 §4.2).
 *
 * Extracts the three immutable artifacts from a Neo4j inventory export:
 *   1. Vocabulary (`application/vnd.exocortex.vocabulary+json`):
 *      Every `vocab = true` topic with `id`, `name`, `aliases`, `generic`, and deterministic `topic_num`
 *      assigned once in sorted slug (`id`) codepoint order (and appended at `next_topic_num` on later versions).
 *   2. Rule links (`application/vnd.exocortex.rule-links+json`):
 *      `entity-rule` and `path-rule` `HAS_TOPIC` links, each with its `rule_source`.
 *   3. File tree (`application/vnd.exocortex.file-tree+json`):
 *      `File` and `Folder` nodes and `CONTAINS` edges (stored in `artifacts`, not loaded into the live graph).
 */

export const VOCABULARY_MEDIA_TYPE = "application/vnd.exocortex.vocabulary+json";
export const RULE_LINKS_MEDIA_TYPE = "application/vnd.exocortex.rule-links+json";
export const FILE_TREE_MEDIA_TYPE = "application/vnd.exocortex.file-tree+json";
export const PIECES_GRAPH_MEDIA_TYPE = "application/vnd.exocortex.pieces-graph+json";
export const MAX_PIECES_GRAPH_BYTES = 20 * 1024 * 1024;
export const MAX_PIECES_NAME_CHARS = 512;
export const MAX_PIECES_REF_CHARS = 2048;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function firstNonEmptyString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string") {
      const trimmed = c.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return "";
}

export interface VocabularyTopicEntry {
  id: string;
  name: string;
  aliases: string[];
  generic: boolean;
  topic_num: number;
}

export interface VocabularyArtifact {
  version: 1;
  next_topic_num?: number;
  topics: VocabularyTopicEntry[];
}

export interface RuleLinkEntry {
  source_id: string;
  target_id: string;
  rule_source: string;
  weight: number;
}

export interface RuleLinksArtifact {
  version: 1;
  rule_source: "entity-rule" | "path-rule";
  links: RuleLinkEntry[];
}

export interface FileTreeNodeEntry {
  id: string;
  kind: "File" | "Folder";
  name: string;
  path: string;
  source: string;
}

export interface FileTreeEdgeEntry {
  source_id: string;
  target_id: string;
}

export interface FileTreeArtifact {
  version: 1;
  nodes: FileTreeNodeEntry[];
  contains: FileTreeEdgeEntry[];
}

export interface RawNeo4jExportNode {
  eid: string;
  labels: string[];
  props: Record<string, unknown>;
}

export interface RawNeo4jExportRelationship {
  eid: string;
  start: string;
  end: string;
  type: string;
  props: Record<string, unknown>;
}

export interface RawNeo4jExport {
  nodes: RawNeo4jExportNode[];
  relationships?: RawNeo4jExportRelationship[];
  rels?: RawNeo4jExportRelationship[];
}

/**
 * Build the canonical vocabulary artifact from exported Neo4j nodes.
 * If `previous` is provided, existing `id -> topic_num` assignments are preserved and new topics
 * are appended starting at `max(previous.next_topic_num, max(topic_num) + 1)` in sorted codepoint `id` order (§4.2).
 */
export function buildVocabularyArtifact(
  raw: RawNeo4jExport,
  previous?: VocabularyArtifact,
): VocabularyArtifact {
  const prevById = new Map<string, number>();
  let nextNum = previous?.next_topic_num ?? 0;
  if (previous) {
    for (const t of previous.topics) {
      prevById.set(t.id, t.topic_num);
      if (t.topic_num >= nextNum) nextNum = t.topic_num + 1;
    }
  }

  const byId = new Map<string, Omit<VocabularyTopicEntry, "topic_num">>();
  for (const node of raw.nodes) {
    if (!node.labels.includes("Topic")) continue;
    if (node.props.vocab !== true) continue;
    const id = typeof node.props.id === "string" ? node.props.id.trim() : "";
    if (!id) continue;
    const name = typeof node.props.name === "string" && node.props.name.trim() ? node.props.name.trim() : id;
    const aliases = Array.isArray(node.props.aliases)
      ? node.props.aliases.filter((a): a is string => typeof a === "string").sort(cmp)
      : [];
    const generic = node.props.generic === true;
    byId.set(id, { id, name, aliases, generic });
  }

  const sortedIds = [...byId.keys()].sort(cmp);
  const topics: VocabularyTopicEntry[] = [];
  for (const id of sortedIds) {
    const base = byId.get(id)!;
    const existingNum = prevById.get(id);
    const topic_num = existingNum !== undefined ? existingNum : nextNum++;
    topics.push({ ...base, topic_num });
  }
  return { version: 1, next_topic_num: nextNum, topics };
}

/**
 * Extract entity-rule and path-rule `HAS_TOPIC` links from a Neo4j export.
 * Includes the 1 Project->Topic entity-rule link whose `source` property was overwritten by
 * `oakridge-system-index-2026-10-26` (documented in P0-G3).
 */
export function buildRuleLinksArtifacts(raw: RawNeo4jExport): {
  entityRules: RuleLinksArtifact;
  pathRules: RuleLinksArtifact;
} {
  const nodeByEid = new Map<string, RawNeo4jExportNode>();
  for (const n of raw.nodes) nodeByEid.set(n.eid, n);

  const rels = raw.relationships ?? raw.rels ?? [];
  const entityMap = new Map<string, RuleLinkEntry>();
  const pathMap = new Map<string, RuleLinkEntry>();

  for (const r of rels) {
    if (r.type !== "HAS_TOPIC") continue;
    const srcNode = nodeByEid.get(r.start);
    const tgtNode = nodeByEid.get(r.end);
    if (!srcNode || !tgtNode) continue;
    const source_id = typeof srcNode.props.id === "string" ? srcNode.props.id : (typeof srcNode.props.path === "string" ? srcNode.props.path : "");
    const target_id = typeof tgtNode.props.id === "string" ? tgtNode.props.id : "";
    if (!source_id || !target_id) continue;
    const weight = typeof r.props.weight === "number" && Number.isFinite(r.props.weight) ? r.props.weight : 0.85;
    const rawSource = typeof r.props.source === "string" ? r.props.source : "";

    const isProjectEntityRule =
      rawSource === "oakridge-system-index-2026-10-26" &&
      (srcNode.labels.includes("Project") || srcNode.props.type === "PROJECT");

    if (rawSource.startsWith("entity-rule") || isProjectEntityRule) {
      const key = `${source_id}->${target_id}`;
      entityMap.set(key, {
        source_id,
        target_id,
        rule_source: rawSource || "entity-rule-2026-10-25",
        weight,
      });
    } else if (rawSource.startsWith("path-rule")) {
      const key = `${source_id}->${target_id}`;
      pathMap.set(key, {
        source_id,
        target_id,
        rule_source: rawSource,
        weight,
      });
    }
  }

  const sortLinks = (entries: Iterable<RuleLinkEntry>): RuleLinkEntry[] =>
    [...entries].sort((a, b) => cmp(a.source_id, b.source_id) || cmp(a.target_id, b.target_id) || cmp(a.rule_source, b.rule_source));

  return {
    entityRules: { version: 1, rule_source: "entity-rule", links: sortLinks(entityMap.values()) },
    pathRules: { version: 1, rule_source: "path-rule", links: sortLinks(pathMap.values()) },
  };
}

/**
 * Extract the File/Folder tree artifact (`CONTAINS` edges) from a Neo4j export.
 */
export function buildFileTreeArtifact(raw: RawNeo4jExport): FileTreeArtifact {
  const nodeByEid = new Map<string, RawNeo4jExportNode>();
  const nodesById = new Map<string, FileTreeNodeEntry>();

  for (const n of raw.nodes) {
    nodeByEid.set(n.eid, n);
    const isFile = n.labels.includes("File");
    const isFolder = n.labels.includes("Folder");
    if (!isFile && !isFolder) continue;
    const path = typeof n.props.path === "string" ? n.props.path : "";
    const id = typeof n.props.id === "string" ? n.props.id : path;
    if (!id) continue;
    const name = typeof n.props.name === "string" ? n.props.name : id;
    const source = typeof n.props.source === "string" ? n.props.source : "";
    nodesById.set(id, {
      id,
      kind: isFile ? "File" : "Folder",
      name,
      path,
      source,
    });
  }

  const rels = raw.relationships ?? raw.rels ?? [];
  const edgeMap = new Map<string, FileTreeEdgeEntry>();
  for (const r of rels) {
    if (r.type !== "CONTAINS") continue;
    const srcNode = nodeByEid.get(r.start);
    const tgtNode = nodeByEid.get(r.end);
    if (!srcNode || !tgtNode) continue;
    const source_id = typeof srcNode.props.id === "string" ? srcNode.props.id : (typeof srcNode.props.path === "string" ? srcNode.props.path : "");
    const target_id = typeof tgtNode.props.id === "string" ? tgtNode.props.id : (typeof tgtNode.props.path === "string" ? tgtNode.props.path : "");
    if (!source_id || !target_id) continue;
    const validSource = nodesById.has(source_id) || srcNode.labels.includes("Project") || srcNode.props.type === "PROJECT";
    if (!validSource || !nodesById.has(target_id)) continue;
    edgeMap.set(`${source_id}->${target_id}`, { source_id, target_id });
  }

  return {
    version: 1,
    nodes: [...nodesById.values()].sort((a, b) => cmp(a.id, b.id)),
    contains: [...edgeMap.values()].sort((a, b) => cmp(a.source_id, b.source_id) || cmp(a.target_id, b.target_id)),
  };
}

export interface PiecesGraphNodeEntry {
  id: string;
  kind: string;
  name: string;
  ref: string;
  path: string;
  created: string;
  links: number;
}

export interface PiecesGraphEdgeEntry {
  type: string;
  source_id: string;
  target_id: string;
}

export interface PiecesGraphArtifact {
  version: 1;
  nodes: PiecesGraphNodeEntry[];
  relationships: PiecesGraphEdgeEntry[];
}

/**
 * Extract the Pieces knowledge-graph artifact (`PiecesRecord` / `Doc` nodes and their edges)
 * for local `@exocortex/memory` `GraphClient` recall (PLAN_WORLD_MODEL_STORE_2026-10-31 §8).
 *
 * - `links` counts distinct incident relationships in the export (matching Cypher `COUNT { (n)--() }`,
 *   including edges to non-Pieces nodes and counting self-loops once).
 * - `name` and `ref` are bounded at build time (`MAX_PIECES_NAME_CHARS`, `MAX_PIECES_REF_CHARS`)
 *   so full page bodies cannot push the artifact past the 20 MB SQLite threshold.
 */
export function buildPiecesGraphArtifact(raw: RawNeo4jExport): PiecesGraphArtifact {
  const rels = raw.relationships ?? raw.rels ?? [];
  const incidentRelIdsByEid = new Map<string, Set<string>>();
  for (let idx = 0; idx < rels.length; idx++) {
    const r = rels[idx];
    const relKey = firstNonEmptyString(r.eid) || `rel_${idx}`;
    let sSet = incidentRelIdsByEid.get(r.start);
    if (!sSet) {
      sSet = new Set<string>();
      incidentRelIdsByEid.set(r.start, sSet);
    }
    sSet.add(relKey);
    let eSet = incidentRelIdsByEid.get(r.end);
    if (!eSet) {
      eSet = new Set<string>();
      incidentRelIdsByEid.set(r.end, eSet);
    }
    eSet.add(relKey);
  }

  const piecesIdByEid = new Map<string, string>();
  const nodesById = new Map<string, PiecesGraphNodeEntry>();

  // Sort input nodes deterministically by eid first so collision disambiguation is order-independent.
  const candidateNodes = raw.nodes
    .filter((n) => n.labels.includes("PiecesRecord") || n.labels.includes("Doc"))
    .sort((a, b) => cmp(a.eid, b.eid));

  for (const n of candidateNodes) {
    const p = n.props ?? {};
    const baseId = firstNonEmptyString(p.piecesId, p.id, p.hash, p.path, n.eid);
    if (!baseId) continue;

    let id = baseId;
    if (nodesById.has(id)) {
      id = `${baseId}#${n.eid}`;
    }

    const sortedSecondaryLabels = n.labels
      .filter((l) => l !== "PiecesRecord" && l !== "Doc")
      .sort(cmp);
    const kind =
      firstNonEmptyString(p.kind) ||
      sortedSecondaryLabels[0] ||
      firstNonEmptyString(p.type) ||
      "Other";

    const path = firstNonEmptyString(p.piecesId, p.path, p.id);
    const name = firstNonEmptyString(p.name, p.pageTitle, p.text, p.readable, p.url, p.path, p.piecesId, p.id).slice(
      0,
      MAX_PIECES_NAME_CHARS,
    );
    const ref = firstNonEmptyString(p.ref, p.text, p.readable, p.url, p.category).slice(0, MAX_PIECES_REF_CHARS);
    const created = firstNonEmptyString(p.created);
    const links = incidentRelIdsByEid.get(n.eid)?.size ?? 0;

    piecesIdByEid.set(n.eid, id);
    nodesById.set(id, { id, kind, name, ref, path, created, links });
  }

  const edgeMap = new Map<string, PiecesGraphEdgeEntry>();
  for (const r of rels) {
    const source_id = piecesIdByEid.get(r.start);
    const target_id = piecesIdByEid.get(r.end);
    if (!source_id || !target_id) continue;
    const type = firstNonEmptyString(r.type) || "RELATED";
    const edgeKey = JSON.stringify([source_id, type, target_id]);
    edgeMap.set(edgeKey, { type, source_id, target_id });
  }

  return {
    version: 1,
    nodes: [...nodesById.values()].sort((a, b) => cmp(a.id, b.id)),
    relationships: [...edgeMap.values()].sort(
      (a, b) => cmp(a.source_id, b.source_id) || cmp(a.type, b.type) || cmp(a.target_id, b.target_id),
    ),
  };
}
