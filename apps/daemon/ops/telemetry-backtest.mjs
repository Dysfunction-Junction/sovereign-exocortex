// Aggregate-only local telemetry replay. Usage: node apps/daemon/ops/telemetry-backtest.mjs [db-path]
// The database is opened read-only. Package names, screen names, and telemetry text never leave memory.
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2] ?? `${process.env.LOCALAPPDATA ?? process.env.HOME}/exocortex.db`;
const db = new DatabaseSync(dbPath, { readOnly: true });
const events = db.prepare("SELECT seq, device_id, ts_device, kind, payload FROM events WHERE kind IN ('touch','telemetry') ORDER BY ts_device, seq").all();
const sources = { sms: 0, notification: 0, passiveCapture: 0, other: 0 };
const capturesByDevice = new Map();
const screensByDevice = new Map();

function append(map, deviceId, event) {
  if (!map.has(deviceId)) map.set(deviceId, []);
  map.get(deviceId).push(event);
}

for (const row of events) {
  let payload;
  try { payload = JSON.parse(row.payload); } catch { continue; }
  if (payload.type === "screen_view" && typeof payload.screen === "string" && payload.screen) {
    append(screensByDevice, row.device_id, { seq: row.seq, ts: row.ts_device, label: payload.screen });
  }
  if (payload.type !== "system_telemetry" || typeof payload.telemetry !== "string") continue;
  const text = payload.telemetry;
  if (text.startsWith("SMS ")) { sources.sms++; continue; }
  if (text.startsWith("Notification from ")) { sources.notification++; continue; }
  if (!text.startsWith("Package: ") || typeof payload.package !== "string" || !payload.package) { sources.other++; continue; }
  sources.passiveCapture++;
  append(capturesByDevice, row.device_id, { seq: row.seq, ts: row.ts_device, label: payload.package });
}

function evaluate(sequences) {
  const scores = Object.fromEntries(["frequency", "persistence", "transition"].map((method) => [method, { n: 0, top1: 0, top3: 0, unseen: 0 }]));
  let trainCount = 0;
  let testCount = 0;
  let uniqueLabels = new Set();
  const allEvents = [...sequences.values()].flat();
  for (const sequence of sequences.values()) {
    sequence.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    for (const event of sequence) uniqueLabels.add(event.label);
    if (sequence.length < 2) continue;
    const cut = Math.max(1, Math.floor(sequence.length * 0.8));
    const history = sequence.slice(0, cut);
    trainCount += history.length;
    const counts = new Map();
    const transitions = new Map();
    const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    const rank = (map) => [...map.keys()].sort((a, b) => map.get(b) - map.get(a));
    for (const event of history) increment(counts, event.label);
    for (let i = 1; i < history.length; i++) {
      if (!transitions.has(history[i - 1].label)) transitions.set(history[i - 1].label, new Map());
      increment(transitions.get(history[i - 1].label), history[i].label);
    }
    for (let i = cut; i < sequence.length; i++) {
      const actual = sequence[i].label;
      const previous = sequence[i - 1].label;
      const transitionCounts = transitions.get(previous);
      const predictions = {
        frequency: rank(counts),
        persistence: [previous],
        transition: transitionCounts?.size ? rank(transitionCounts) : rank(counts),
      };
      testCount++;
      for (const [method, candidates] of Object.entries(predictions)) {
        const score = scores[method];
        score.n++;
        if (!counts.has(actual)) score.unseen++;
        if (candidates[0] === actual) score.top1++;
        if (candidates.slice(0, 3).includes(actual)) score.top3++;
      }
      increment(counts, actual);
      if (!transitions.has(previous)) transitions.set(previous, new Map());
      increment(transitions.get(previous), actual);
    }
  }
  for (const score of Object.values(scores)) {
    score.top1 = score.n ? Number((score.top1 / score.n).toFixed(4)) : null;
    score.top3 = score.n ? Number((score.top3 / score.n).toFixed(4)) : null;
    score.unseenRate = score.n ? Number((score.unseen / score.n).toFixed(4)) : null;
    delete score.unseen;
  }
  const times = allEvents.map((event) => event.ts).filter(Number.isFinite);
  return {
    devices: sequences.size,
    range: times.length ? [new Date(Math.min(...times)).toISOString(), new Date(Math.max(...times)).toISOString()] : null,
    trainEvents: trainCount,
    testEvents: testCount,
    distinctLabels: uniqueLabels.size,
    scores,
  };
}

const totalScreenViews = [...screensByDevice.values()].reduce((sum, rows) => sum + rows.length, 0);
console.log(JSON.stringify({
  telemetryEventSources: sources,
  passiveAppCapture: { events: sources.passiveCapture, ...evaluate(capturesByDevice) },
  companionAppScreenViews: { events: totalScreenViews, ...evaluate(screensByDevice) },
  notes: [
    "Both replays use a per-device chronological 80/20 split and report aggregate metrics only.",
    "Passive captures are accessibility snapshots, not complete foreground-app transitions; SMS and notification events are excluded from app prediction.",
    "The recorded screen field on passive captures is a generic background marker, so package is the only app-context target.",
  ],
}, null, 2));
db.close();
