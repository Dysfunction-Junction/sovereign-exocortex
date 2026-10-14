// Read-only chronological replay over the imported Pieces graph.
// Run from this directory with: node --env-file=.env src/graph-backtest.js
import neo4j from "neo4j-driver";

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE = "neo4j" } = process.env;
if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
  console.error("Set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD in .env");
  process.exit(1);
}

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD));
const session = driver.session({ database: NEO4J_DATABASE, defaultAccessMode: neo4j.session.READ });

const countBy = (items, keyOf) => {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const ranked = (counts) => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
const top = (counts, k = 3) => ranked(counts).slice(0, k);
const ratio = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;

function scoreClasses(entries, labelField = "classLabel") {
  let top1 = 0;
  let top3 = 0;
  let covered = 0;
  for (const { target, prediction } of entries) {
    if (prediction.length) covered++;
    if (prediction[0] === target[labelField]) top1++;
    if (prediction.slice(0, 3).includes(target[labelField])) top3++;
  }
  return { n: entries.length, top1: ratio(top1, entries.length), top3: ratio(top3, entries.length), candidateCoverage: ratio(covered, entries.length) };
}

function scoreTopics(entries) {
  let targetsWithTopics = 0;
  let hit = 0;
  let relevant = 0;
  let retrieved = 0;
  let relevantRetrieved = 0;
  let covered = 0;
  for (const { target, prediction } of entries) {
    if (!target.topics.size) continue;
    targetsWithTopics++;
    if (prediction.length) covered++;
    const predicted = new Set(prediction.slice(0, 3));
    const overlap = [...target.topics].filter((topic) => predicted.has(topic)).length;
    if (overlap) hit++;
    relevant += target.topics.size;
    retrieved += predicted.size;
    relevantRetrieved += overlap;
  }
  return {
    n: targetsWithTopics,
    hitAt3: ratio(hit, targetsWithTopics),
    precisionAt3: ratio(relevantRetrieved, retrieved),
    recallAt3: ratio(relevantRetrieved, relevant),
    candidateCoverage: ratio(covered, targetsWithTopics),
  };
}

try {
  const nodeResult = await session.run("MATCH (n:Doc) RETURN n.hash AS id, n.created AS created, n.type AS type, labels(n) AS labels");
  const edgeResult = await session.run("MATCH (a:Doc)-[]-(b:Doc) RETURN DISTINCT a.hash AS a, b.hash AS b");

  const nodes = new Map();
  for (const row of nodeResult.records) {
    const id = row.get("id");
    const created = row.get("created");
    if (typeof id !== "string" || typeof created !== "string" || !Number.isFinite(Date.parse(created))) continue;
    const labels = row.get("labels").filter((label) => label !== "Doc").sort();
    const type = row.get("type");
    nodes.set(id, {
      id,
      created,
      classLabel: labels.join("+") || "unknown",
      typeLabel: typeof type === "string" && type ? type : labels.join("+") || "unknown",
      topics: new Set(),
      neighbors: new Set(),
    });
  }

  const edges = edgeResult.records.map((row) => [row.get("a"), row.get("b")]);
  for (const [a, b] of edges) {
    if (!nodes.has(a) || !nodes.has(b)) continue;
    nodes.get(a).neighbors.add(b);
    nodes.get(b).neighbors.add(a);
  }

  // A topic is the text of a directly linked Tags node. Pull tag text only for scoring;
  // no document text, tag values, or identifiers are written to the report.
  const tagResult = await session.run(
    "MATCH (n:Doc) RETURN n.hash AS id, n.text AS text, n.category AS category, labels(n) AS labels",
  );
  const tagNodes = new Map();
  for (const row of tagResult.records) {
    if (!row.get("labels").includes("Tags")) continue;
    const raw = row.get("text") ?? row.get("category");
    if (typeof raw !== "string") continue;
    const topic = raw.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (topic.length > 0 && topic.length <= 128) tagNodes.set(row.get("id"), topic);
  }
  for (const [id, node] of nodes) {
    for (const neighbor of node.neighbors) {
      const topic = tagNodes.get(neighbor);
      if (topic) node.topics.add(topic);
    }
  }

  const bucketsByTime = new Map();
  for (const node of nodes.values()) {
    if (!bucketsByTime.has(node.created)) bucketsByTime.set(node.created, []);
    bucketsByTime.get(node.created).push(node);
  }
  const buckets = [...bucketsByTime.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (buckets.length < 2) throw new Error("Not enough distinct creation timestamps for chronological evaluation");
  const warmupBuckets = Math.max(1, Math.floor(buckets.length * 0.8));
  const history = [];
  const historyIds = new Set();
  const evaluations = { classLabel: { global: [], recent: [], graph: [] }, typeLabel: { global: [], recent: [], graph: [] }, topics: { global: [], recent: [], graph: [] } };
  let graphContextBuckets = 0;
  let testItems = 0;
  let testTopics = 0;

  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex++) {
    const [time, targets] = buckets[bucketIndex];
    if (bucketIndex >= warmupBuckets && history.length) {
      testItems += targets.length;
      testTopics += targets.filter((node) => node.topics.size > 0).length;
      const recent = buckets[bucketIndex - 1][1];
      const priorNeighbors = new Set();
      for (const current of recent) {
        for (const neighborId of current.neighbors) {
          const neighbor = nodes.get(neighborId);
          if (neighbor && neighbor.created < time && historyIds.has(neighborId)) priorNeighbors.add(neighborId);
        }
      }
      if (priorNeighbors.size) graphContextBuckets++;
      const related = [...priorNeighbors].map((id) => nodes.get(id));

      const globalClass = countBy(history, (node) => node.classLabel);
      const recentClass = countBy(recent, (node) => node.classLabel);
      const graphClass = countBy(related, (node) => node.classLabel);
      const globalType = countBy(history, (node) => node.typeLabel);
      const recentType = countBy(recent, (node) => node.typeLabel);
      const graphType = countBy(related, (node) => node.typeLabel);
      const globalTopic = countBy(history.flatMap((node) => [...node.topics]), (topic) => topic);
      const recentTopic = countBy(recent.flatMap((node) => [...node.topics]), (topic) => topic);
      const graphTopic = countBy(related.flatMap((node) => [...node.topics]), (topic) => topic);

      for (const target of targets) {
        evaluations.classLabel.global.push({ target, prediction: top(globalClass) });
        evaluations.classLabel.recent.push({ target, prediction: top(recentClass) });
        evaluations.classLabel.graph.push({ target, prediction: top(graphClass) });
        evaluations.typeLabel.global.push({ target, prediction: top(globalType) });
        evaluations.typeLabel.recent.push({ target, prediction: top(recentType) });
        evaluations.typeLabel.graph.push({ target, prediction: top(graphType) });
        evaluations.topics.global.push({ target, prediction: top(globalTopic) });
        evaluations.topics.recent.push({ target, prediction: top(recentTopic) });
        evaluations.topics.graph.push({ target, prediction: top(graphTopic) });
      }
    }
    // Update only after scoring the whole timestamp bucket to avoid same-time leakage.
    history.push(...targets);
    for (const node of targets) historyIds.add(node.id);
  }

  const report = {
    mode: "chronological expanding-window; first 80% of distinct creation timestamps warm-up; no same-timestamp items in history",
    data: {
      documents: nodes.size,
      distinctTimestampBuckets: buckets.length,
      timestampTies: nodes.size - buckets.length,
      range: [buckets[0][0], buckets.at(-1)[0]],
      testDocuments: testItems,
      testDocumentsWithTopics: testTopics,
      graphContextCoverageByTimestamp: ratio(graphContextBuckets, buckets.length - warmupBuckets),
    },
    artifactClass: Object.fromEntries(Object.entries(evaluations.classLabel).map(([method, entries]) => [method, scoreClasses(entries)])),
    documentType: Object.fromEntries(Object.entries(evaluations.typeLabel).map(([method, entries]) => [method, scoreClasses(entries, "typeLabel")])),
    topic: Object.fromEntries(Object.entries(evaluations.topics).map(([method, entries]) => [method, scoreTopics(entries)])),
    limitations: [
      "Relationship records have no creation timestamps; graph-neighbor scores are exploratory because a relation may have been added after its endpoint documents.",
      "This predicts the next saved Pieces document class/type/topic, not the next real-world user action.",
      "The backtest uses no document text; topic labels come from linked Tags nodes.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await session.close();
  await driver.close();
}
