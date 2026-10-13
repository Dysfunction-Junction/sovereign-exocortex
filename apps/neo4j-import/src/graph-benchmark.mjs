// Synthetic latency baseline for the current LivingLifeGraph implementation.
// Run with: node apps/neo4j-import/src/graph-benchmark.mjs [entity-count] [queries]
import { performance } from "node:perf_hooks";
import { LivingLifeGraph } from "../../../packages/world-model/src/life-graph.ts";

const entityCount = Number(process.argv[2] ?? 10_000);
const queryCount = Number(process.argv[3] ?? 500);
if (!Number.isSafeInteger(entityCount) || entityCount < 100 || !Number.isSafeInteger(queryCount) || queryCount < 1) {
  throw new Error("usage: node graph-benchmark.mjs [entity-count >= 100] [queries >= 1]");
}

const graph = new LivingLifeGraph();
const buildStart = performance.now();
for (let i = 0; i < entityCount; i++) {
  graph.addEntity({ id: `bench_${i}`, type: "PROJECT", name: `Synthetic ${i}` });
}
for (let i = 0; i < entityCount; i++) {
  for (let hop = 1; hop <= 5; hop++) {
    graph.addEdge(`bench_${i}`, `bench_${(i + hop * 37) % entityCount}`, "TRIGGERS", 0.6);
  }
}
const buildMs = performance.now() - buildStart;

const durations = [];
let resultEntities = 0;
let resultEdges = 0;
for (let i = 0; i < queryCount; i++) {
  const start = performance.now();
  const result = graph.queryContextSubgraph([`bench_${(i * 97) % entityCount}`], 3, 0.1);
  durations.push(performance.now() - start);
  resultEntities += result.entities.length;
  resultEdges += result.edges.length;
}
durations.sort((a, b) => a - b);
const percentile = (p) => durations[Math.min(durations.length - 1, Math.ceil(p * durations.length) - 1)];
console.log(JSON.stringify({
  backend: "LivingLifeGraph in-memory adjacency maps",
  entityCount,
  edgeCount: graph.edgeCount,
  queryCount,
  maxHops: 3,
  minWeight: 0.1,
  buildMs: Number(buildMs.toFixed(2)),
  queryMs: { p50: Number(percentile(0.5).toFixed(3)), p95: Number(percentile(0.95).toFixed(3)), max: Number(Math.max(...durations).toFixed(3)) },
  averageResultEntities: Number((resultEntities / queryCount).toFixed(1)),
  averageResultEdges: Number((resultEdges / queryCount).toFixed(1)),
}, null, 2));
