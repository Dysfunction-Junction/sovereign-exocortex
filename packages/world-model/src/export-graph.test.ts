import { describe, expect, it } from "vitest";
import { LivingLifeGraph } from "./life-graph.js";
import { exportLivingLifeGraph, graphToCypher } from "./export-graph.js";

describe("life graph export", () => {
  it("exports a detached JSON graph snapshot and idempotent Cypher", () => {
    const graph = new LivingLifeGraph();
    graph.addEntity({ id: "a'\\b", name: "Alpha", type: "PROJECT", properties: { tags: ["one", "two"] } });
    graph.addEntity({ id: "b", name: "Beta", type: "TOPIC" });
    graph.addEdge("a'\\b", "b", "DEPENDS_ON", 0.75);

    const snapshot = exportLivingLifeGraph(graph);
    expect(snapshot.entities).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
    snapshot.entities[0].properties!.tags = ["changed"];
    expect(graph.getEntity("a'\\b")?.properties?.tags).toEqual(["one", "two"]);

    const cypher = graphToCypher(exportLivingLifeGraph(graph));
    expect(cypher).toContain("MERGE (n:Entity {id: \"a'\\\\b\"})");
    expect(cypher).toContain("MERGE (a)-[r:DEPENDS_ON");
    expect(cypher).toContain("propertiesJson:");
  });

  it("uses a safe generic relationship type for invalid runtime input", () => {
    const invalid = {
      entities: [],
      edges: [{ id: "e", sourceId: "a", targetId: "b", relation: "X] DETACH DELETE n //", weight: 1, observedCount: 1, lastObserved: 1 }],
    } as never;
    expect(graphToCypher(invalid)).toContain("[r:RELATED");
    expect(graphToCypher(invalid)).not.toContain("DETACH DELETE");
  });
});
