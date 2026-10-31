import { describe, it, expect } from "vitest";
import { LivingLifeGraph } from "./life-graph.js";
import {
  InMemoryGraphStore,
  VocabularyIndex,
  computeDecayedActivation,
  computeDecayedEdgeWeight,
} from "./graph-store.js";
import type { RuleLinksArtifact, VocabularyArtifact } from "./curation-artifacts.js";

const SAMPLE_VOCAB: VocabularyArtifact = {
  version: 1,
  next_topic_num: 3,
  topics: [
    { id: "topic_ai", name: "Artificial Intelligence", aliases: ["llm", "genai"], generic: false, topic_num: 0 },
    { id: "topic_code", name: "Code", aliases: ["programming"], generic: true, topic_num: 1 },
    { id: "topic_unreferenced", name: "Unreferenced Topic", aliases: ["unused"], generic: false, topic_num: 2 },
  ],
};

const SAMPLE_ENTITY_RULES: RuleLinksArtifact = {
  version: 1,
  rule_source: "entity-rule",
  links: [
    {
      source_id: "project_sovereign_exocortex",
      target_id: "topic_ai",
      rule_source: "entity-rule-2026-10-25",
      weight: 0.92,
    },
    {
      source_id: "project_sovereign_exocortex",
      target_id: "topic_code",
      rule_source: "entity-rule-2026-10-25",
      weight: 0.85,
    },
  ],
};

describe("GraphStore & VocabularyIndex (section 5.1 & 5.2)", () => {
  it("loads vocabulary as a lookup index and materializes only referenced topics into LivingLifeGraph", () => {
    const graph = new LivingLifeGraph();
    graph.addEntity({
      id: "project_sovereign_exocortex",
      type: "PROJECT",
      name: "Sovereign Exocortex",
      lastActive: 1_700_000_000_000,
    });

    const store = new InMemoryGraphStore({ graph, now: () => 1_700_086_400_000 });
    store.applyCurationArtifacts(SAMPLE_VOCAB, SAMPLE_ENTITY_RULES, "2026-10-31T00:00:00.000Z");

    const status = store.status();
    expect(status.vocabularyCount).toBe(3);
    expect(status.entityRuleLinkCount).toBe(2);
    // Only project_sovereign_exocortex + 2 referenced topics (topic_ai, topic_code) are graph nodes;
    // topic_unreferenced remains in the lookup index only.
    expect(status.nodeCount).toBe(3);
    expect(graph.getEntity("topic_unreferenced")).toBeUndefined();
    expect(store.vocabIndex.getByTopicNum(2)?.id).toBe("topic_unreferenced");
    expect(store.vocabIndex.resolve("genai")?.id).toBe("topic_ai");
  });

  it("excludes generic = true topics from spreading activation", () => {
    const graph = new LivingLifeGraph();
    graph.addEntity({ id: "project_sovereign_exocortex", type: "PROJECT", name: "Sovereign Exocortex", lastActive: 0 });
    graph.addEntity({ id: "doc_1", type: "DOC", name: "Design Doc", lastActive: 0 });
    graph.addEntity({ id: "doc_2", type: "DOC", name: "Generic Doc", lastActive: 0 });

    const store = new InMemoryGraphStore({ graph });
    store.applyCurationArtifacts(SAMPLE_VOCAB, SAMPLE_ENTITY_RULES);

    // Connect topic_ai (generic: false) -> doc_1 and topic_code (generic: true) -> doc_2
    graph.addEdge("topic_ai", "doc_1", "REFERENCES", 0.9, 30, 0);
    graph.addEdge("topic_code", "doc_2", "REFERENCES", 0.9, 30, 0);

    const activated = graph.spreadActivation(["project_sovereign_exocortex"], 1.0, 0.8, 3);
    expect(activated.has("topic_ai")).toBe(true);
    expect(activated.has("doc_1")).toBe(true);
    expect(activated.has("topic_code")).toBe(false);
    expect(activated.has("doc_2")).toBe(false);

    // Generic seed itself is also excluded
    const fromGeneric = graph.spreadActivation(["topic_code"], 1.0, 0.8, 3);
    expect(fromGeneric.size).toBe(0);
  });

  it("supports analytics, search, byType, stale, neighbors, and queryNaturalLanguage without mutating stored weights", () => {
    const t0 = Date.UTC(2026, 9, 1);
    const tNow = t0 + 14 * 86_400_000; // 14 days later (2 entity half-lives)
    const graph = new LivingLifeGraph();
    graph.addEntity({ id: "person_operator", type: "PERSON", name: "Operator", activation: 1.0, lastActive: t0 });
    graph.addEntity({ id: "project_sovereign_exocortex", type: "PROJECT", name: "Sovereign Exocortex", activation: 1.0, lastActive: t0 + 7 * 86_400_000 });
    graph.addEdge("person_operator", "project_sovereign_exocortex", "WORKS_ON", 0.8, 14, t0);

    const store = new InMemoryGraphStore({ graph, now: () => tNow });
    store.applyCurationArtifacts(SAMPLE_VOCAB, SAMPLE_ENTITY_RULES);

    const analytics = store.analytics(tNow);
    expect(analytics.nodeCount).toBe(4);
    expect(analytics.edgeCount).toBe(3);
    expect(analytics.hubs[0].id).toBe("project_sovereign_exocortex");
    expect(analytics.hubs[0].degree).toBe(3);

    const byProject = store.byType("PROJECT", 10);
    expect(byProject.map((r) => r.id)).toEqual(["project_sovereign_exocortex"]);

    const searchAlias = store.search("llm", 10);
    expect(searchAlias.map((r) => r.id)).toEqual(["topic_ai"]);

    const stale = store.stale(2);
    expect(stale).toHaveLength(2);
    expect(stale[0].lastActive).toBeLessThanOrEqual(stale[1].lastActive!);

    const hood = store.neighbors("person_operator", 2, 10, tNow);
    expect(hood.entities.map((e) => e.id).sort()).toEqual([
      "person_operator",
      "project_sovereign_exocortex",
      "topic_ai",
      "topic_code",
    ]);

    // Read-time decay in neighbors() must reflect 14 days elapsed (~0.25 activation for person_operator)
    const opDecayed = hood.entities.find((e) => e.id === "person_operator")!;
    expect(opDecayed.activation).toBeCloseTo(0.25, 2);
    // Stored entity activation in graph must remain unmutated at 1.0
    expect(graph.getEntity("person_operator")!.activation).toBe(1.0);
    expect(computeDecayedEdgeWeight(graph.getEdge("person_operator:WORKS_ON:project_sovereign_exocortex")!, tNow)).toBeCloseTo(0.4, 2);
    expect(computeDecayedActivation(graph.getEntity("person_operator")!, tNow)).toBeCloseTo(0.25, 2);

    const nlProjects = store.queryNaturalLanguage("show active projects");
    expect(nlProjects.matchedEntityIds).toEqual(["project_sovereign_exocortex"]);

    // Re-importing vocabulary alone must not reset entityRuleLinkCount
    store.applyCurationArtifacts(SAMPLE_VOCAB, null);
    expect(store.status().entityRuleLinkCount).toBe(2);
  });

  it("repairs topic metadata when rules load before vocabulary", () => {
    const graph = new LivingLifeGraph();
    graph.addEntity({ id: "project_sovereign_exocortex", type: "PROJECT", name: "Sovereign Exocortex", lastActive: 0 });
    const store = new InMemoryGraphStore({ graph });
    store.applyCurationArtifacts(null, SAMPLE_ENTITY_RULES);
    store.applyCurationArtifacts(SAMPLE_VOCAB, null);
    expect(graph.getEntity("topic_code")?.properties?.generic).toBe(true);
    expect(graph.getEntity("topic_ai")?.name).toBe("Artificial Intelligence");
  });
});
