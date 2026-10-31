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

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
    if (!nodesById.has(source_id) || !nodesById.has(target_id)) continue;
    edgeMap.set(`${source_id}->${target_id}`, { source_id, target_id });
  }

  return {
    version: 1,
    nodes: [...nodesById.values()].sort((a, b) => cmp(a.id, b.id)),
    contains: [...edgeMap.values()].sort((a, b) => cmp(a.source_id, b.source_id) || cmp(a.target_id, b.target_id)),
  };
}
