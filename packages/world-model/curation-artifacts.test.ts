import { describe, it, expect } from "vitest";
import {
  buildVocabularyArtifact,
  buildRuleLinksArtifacts,
  buildFileTreeArtifact,
  buildPiecesGraphArtifact,
  type RawNeo4jExport,
} from "./curation-artifacts.js";

const SAMPLE_EXPORT: RawNeo4jExport = {
  nodes: [
    {
      eid: "n1",
      labels: ["Entity", "Topic"],
      props: { id: "topic_zebra", name: "Zebra", aliases: ["z"], generic: false, vocab: true },
    },
    {
      eid: "n2",
      labels: ["Entity", "Topic"],
      props: { id: "topic_alpha", name: "Alpha", aliases: [], generic: true, vocab: true },
    },
    {
      eid: "n3",
      labels: ["Entity", "Topic"],
      props: { id: "topic_non_vocab", name: "NonVocab", vocab: false },
    },
    {
      eid: "n4",
      labels: ["Entity", "Project"],
      props: { id: "project_sovereign_exocortex", name: "Sovereign Exocortex", type: "PROJECT" },
    },
    {
      eid: "n5",
      labels: ["Folder"],
      props: { id: "folder_packages", name: "packages", path: "packages", source: "repo-inventory-2026-10-24" },
    },
    {
      eid: "n6",
      labels: ["File"],
      props: { id: "file_db_ts", name: "db.ts", path: "packages/core/db.ts", source: "repo-inventory-2026-10-24" },
    },
  ],
  relationships: [
    {
      eid: "r1",
      start: "n4",
      end: "n2",
      type: "HAS_TOPIC",
      props: { source: "entity-rule-2026-10-25", weight: 0.9 },
    },
    {
      eid: "r2",
      start: "n6",
      end: "n1",
      type: "HAS_TOPIC",
      props: { source: "path-rule-2026-10-24", weight: 0.8 },
    },
    {
      eid: "r3",
      start: "n5",
      end: "n6",
      type: "CONTAINS",
      props: {},
    },
  ],
};

describe("curation-artifacts (section 4.2)", () => {
  it("assigns topic_num in sorted slug order and appends new topics at max + 1 without reusing numbers", () => {
    const v1 = buildVocabularyArtifact(SAMPLE_EXPORT);
    expect(v1.topics).toEqual([
      { id: "topic_alpha", name: "Alpha", aliases: [], generic: true, topic_num: 0 },
      { id: "topic_zebra", name: "Zebra", aliases: ["z"], generic: false, topic_num: 1 },
    ]);
    expect(v1.next_topic_num).toBe(2);

    // Even if topic_zebra (topic_num 1) is dropped in v2, topic_beta gets 2, never reusing 1.
    const expanded: RawNeo4jExport = {
      nodes: [
        SAMPLE_EXPORT.nodes[1],
        {
          eid: "n7",
          labels: ["Entity", "Topic"],
          props: { id: "topic_beta", name: "Beta", aliases: [], generic: false, vocab: true },
        },
      ],
    };
    const v2 = buildVocabularyArtifact(expanded, v1);
    expect(v2.topics).toEqual([
      { id: "topic_alpha", name: "Alpha", aliases: [], generic: true, topic_num: 0 },
      { id: "topic_beta", name: "Beta", aliases: [], generic: false, topic_num: 2 },
    ]);
    expect(v2.next_topic_num).toBe(3);
  });

  it("extracts entity-rule and path-rule HAS_TOPIC links and File/Folder CONTAINS tree", () => {
    const rules = buildRuleLinksArtifacts(SAMPLE_EXPORT);
    expect(rules.entityRules.links).toEqual([
      { source_id: "project_sovereign_exocortex", target_id: "topic_alpha", rule_source: "entity-rule-2026-10-25", weight: 0.9 },
    ]);
    expect(rules.pathRules.links).toEqual([
      { source_id: "file_db_ts", target_id: "topic_zebra", rule_source: "path-rule-2026-10-24", weight: 0.8 },
    ]);

    const tree = buildFileTreeArtifact(SAMPLE_EXPORT);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.contains).toEqual([{ source_id: "folder_packages", target_id: "file_db_ts" }]);
  });

  it("extracts PiecesRecord and Doc nodes with link degrees and relationships (section 8)", () => {
    const piecesExport: RawNeo4jExport = {
      nodes: [
        {
          eid: "d1",
          labels: ["Doc", "Summaries"],
          props: { id: "sum_1", name: "Phase 5 Summary", path: "summaries/1.json", created: "2026-10-01T00:00:00Z" },
        },
        {
          eid: "d2",
          labels: ["PiecesRecord", "Tags"],
          props: { piecesId: "tag_1", text: "neo4j-retirement" },
        },
      ],
      relationships: [
        { eid: "pr1", start: "d1", end: "d2", type: "TAGS", props: {} },
      ],
    };
    const artifact = buildPiecesGraphArtifact(piecesExport);
    expect(artifact.nodes).toEqual([
      {
        id: "sum_1",
        kind: "Summaries",
        name: "Phase 5 Summary",
        ref: "",
        path: "summaries/1.json",
        created: "2026-10-01T00:00:00Z",
        links: 1,
      },
      {
        id: "tag_1",
        kind: "Tags",
        name: "neo4j-retirement",
        ref: "neo4j-retirement",
        path: "tag_1",
        created: "",
        links: 1,
      },
    ]);
    expect(artifact.relationships).toEqual([
      { type: "TAGS", source_id: "sum_1", target_id: "tag_1" },
    ]);
  });

  it("handles empty-string fallthrough, non-string props, colon IDs, self-loops, ID collisions, and shuffled label order deterministically", () => {
    const expA: RawNeo4jExport = {
      nodes: [
        {
          eid: "e1",
          labels: ["Doc", "Websites", "Annotations"],
          props: {
            id: "https://example.com:8080/a",
            name: "   ",
            pageTitle: { nested: true },
            text: "Fallback Text Title",
            url: "https://example.com:8080/a",
          },
        },
        {
          eid: "e2",
          labels: ["PiecesRecord", "Tags"],
          props: {
            piecesId: "https://example.com:8080/a",
            text: "Colliding ID node",
          },
        },
      ],
      relationships: [
        { eid: "r_self", start: "e1", end: "e1", type: "SELF_REF", props: {} },
        { eid: "r_col", start: "e1", end: "e2", type: "TAGS:CUSTOM", props: {} },
      ],
    };

    const expB: RawNeo4jExport = {
      nodes: [
        expA.nodes[1],
        {
          ...expA.nodes[0],
          labels: ["Annotations", "Doc", "Websites"],
        },
      ],
      relationships: [...(expA.relationships ?? [])].reverse(),
    };

    const artA = buildPiecesGraphArtifact(expA);
    const artB = buildPiecesGraphArtifact(expB);
    expect(artA).toEqual(artB);
    expect(artA.nodes).toHaveLength(2);
    // e1 gets base id; e2 disambiguates with #e2 instead of overwriting e1
    expect(artA.nodes[0].id).toBe("https://example.com:8080/a");
    expect(artA.nodes[0].kind).toBe("Annotations");
    expect(artA.nodes[0].name).toBe("Fallback Text Title");
    // Self-loop counts once + 1 edge to e2 = 2
    expect(artA.nodes[0].links).toBe(2);
    expect(artA.nodes[1].id).toBe("https://example.com:8080/a#e2");
    expect(artA.relationships).toHaveLength(2);
  });
});
