/**
 * @file triage-labels.ts
 * Ground truth for the local triage models: backfill verdicts from several models over the
 * stored telemetry, collect blind human labels (urgent / routine / noise), and score each model.
 *
 * Labels are blind on purpose: the labeler sees the event text only, never what any model said.
 * Both tables are insert-only. triage_results is shared with TriageHost; a label can be changed by
 * appending a newer one (the latest wins when scoring).
 */

import type { ExocortexDatabase } from "@exocortex/core/db";
import {
  TRIAGE_CATEGORIES,
  TRIAGE_SCHEMA_SQL,
  TriageHost,
  triageTextOf,
  type TriageCategory,
  type TriageHostOptions,
} from "./triage-host.js";

export const LABEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS triage_labels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq  INTEGER NOT NULL,
  label      TEXT NOT NULL CHECK (label IN ('urgent','routine','noise')),
  labeled_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS triage_labels_event ON triage_labels(event_seq);
CREATE TRIGGER IF NOT EXISTS triage_labels_no_update BEFORE UPDATE ON triage_labels
  BEGIN SELECT RAISE(ABORT, 'triage labels are append-only'); END;
CREATE TRIGGER IF NOT EXISTS triage_labels_no_delete BEFORE DELETE ON triage_labels
  BEGIN SELECT RAISE(ABORT, 'triage labels are append-only'); END;
`;

export function ensureTables(db: ExocortexDatabase): void {
  db.raw.exec(TRIAGE_SCHEMA_SQL);
  db.raw.exec(LABEL_SCHEMA_SQL);
}

type Row = Record<string, unknown>;

export interface TriageEvent {
  seq: number;
  deviceId: string;
  text: string;
}

/**
 * The phone can send the same message more than once (it re-pulls its last 30 days on some app
 * starts and gives every queued event a fresh random id), so the event log may hold one message
 * several times. Evaluation treats a message as one item: identified by device, message time and text.
 */
const messageKey = (deviceId: string, ts: number, text: string): string => `${deviceId}|${ts}|${text}`;

interface TriageableRow extends TriageEvent {
  key: string;
}

function allTriageableRows(db: ExocortexDatabase): TriageableRow[] {
  const rows = db.raw.prepare("SELECT seq, device_id, ts_device, kind, payload FROM events WHERE kind = 'telemetry' ORDER BY seq").all() as Row[];
  const out: TriageableRow[] = [];
  for (const r of rows) {
    const text = triageTextOf({ kind: String(r.kind), payload: r.payload as never });
    if (text) {
      const deviceId = String(r.device_id);
      out.push({ seq: Number(r.seq), deviceId, text, key: messageKey(deviceId, Number(r.ts_device), text) });
    }
  }
  return out;
}

/** Every distinct message that has triageable text, oldest first (the first stored copy represents it). */
export function triageableEvents(db: ExocortexDatabase): TriageEvent[] {
  const seen = new Set<string>();
  const out: TriageEvent[] = [];
  for (const r of allTriageableRows(db)) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push({ seq: r.seq, deviceId: r.deviceId, text: r.text });
  }
  return out;
}

/** Maps every stored copy of a message to the seq that represents it. */
function canonicalSeqs(db: ExocortexDatabase): Map<number, number> {
  const first = new Map<string, number>();
  const map = new Map<number, number>();
  for (const r of allTriageableRows(db)) {
    if (!first.has(r.key)) first.set(r.key, r.seq);
    map.set(r.seq, first.get(r.key)!);
  }
  return map;
}

/** Latest label per distinct message, whichever stored copy it was given on. */
export function latestLabels(db: ExocortexDatabase): Map<number, TriageCategory> {
  const canon = canonicalSeqs(db);
  const out = new Map<number, TriageCategory>();
  for (const r of db.raw.prepare("SELECT event_seq, label FROM triage_labels ORDER BY id").all() as Row[]) {
    const c = canon.get(Number(r.event_seq));
    if (c !== undefined) out.set(c, r.label as TriageCategory);
  }
  return out;
}

export interface BackfillOptions {
  models: string[];
  host?: Omit<TriageHostOptions, "model">;
  onProgress?: (p: { model: string; done: number; total: number; failed: number }) => void;
}

/**
 * Runs each model over every event that does not yet have a verdict from it. One model at a time,
 * so the CPU-only box never swaps models mid-pass. Safe to re-run: finished (event, model) pairs
 * are skipped and a killed run resumes where it stopped.
 */
export async function backfill(db: ExocortexDatabase, opts: BackfillOptions): Promise<Record<string, { ran: number; failed: number; skipped: number }>> {
  ensureTables(db);
  const events = triageableEvents(db);
  const summary: Record<string, { ran: number; failed: number; skipped: number }> = {};
  for (const model of opts.models) {
    const host = new TriageHost({ ...opts.host, model, enabled: true, timeoutMs: opts.host?.timeoutMs ?? 120_000 });
    const have = new Set(
      (db.raw.prepare("SELECT event_seq FROM triage_results WHERE model = ?").all(model) as Row[]).map((r) => Number(r.event_seq)),
    );
    const s = (summary[model] = { ran: 0, failed: 0, skipped: 0 });
    let done = 0;
    for (const ev of events) {
      done++;
      if (have.has(ev.seq)) {
        s.skipped++;
        continue;
      }
      const v = await host.run({ db, seq: ev.seq, deviceId: ev.deviceId, text: ev.text });
      if (v) s.ran++;
      else s.failed++;
      opts.onProgress?.({ model, done, total: events.length, failed: s.failed });
    }
  }
  return summary;
}

export interface LabelCandidate {
  seq: number;
  text: string;
  /** True when the models disagree on this event (the most informative ones to label). */
  disagree: boolean;
}

function verdictsBySeq(db: ExocortexDatabase, models: string[]): Map<number, Map<string, TriageCategory>> {
  const rows = db.raw
    .prepare(`SELECT event_seq, model, category FROM triage_results WHERE model IN (${models.map(() => "?").join(",")})`)
    .all(...models) as Row[];
  const by = new Map<number, Map<string, TriageCategory>>();
  for (const r of rows) {
    const m = by.get(Number(r.event_seq)) ?? new Map<string, TriageCategory>();
    m.set(String(r.model), r.category as TriageCategory);
    by.set(Number(r.event_seq), m);
  }
  return by;
}

/** Representative seqs of messages that already have a label. */
export function labeledSeqs(db: ExocortexDatabase): Set<number> {
  return new Set(latestLabels(db).keys());
}

/**
 * Unlabeled events that every model has a verdict for. Disagreements come first; with
 * `includeAgreements` the rest follow (useful for estimating how often both are wrong together).
 * With `includeUnscored` events that some model has not scored yet are included too, so labeling
 * can start before (or while) the models run.
 * The result carries no model output, so the labeler stays blind.
 */
export function nextToLabel(
  db: ExocortexDatabase,
  models: string[],
  includeAgreements = false,
  includeUnscored = false,
): LabelCandidate[] {
  ensureTables(db);
  const verdicts = verdictsBySeq(db, models);
  const done = labeledSeqs(db);
  const out: LabelCandidate[] = [];
  for (const ev of triageableEvents(db)) {
    if (done.has(ev.seq)) continue;
    const v = verdicts.get(ev.seq);
    if (!v || v.size < models.length) {
      // Labels do not depend on model output, so events no model has scored yet can be labeled now.
      if (includeUnscored) out.push({ seq: ev.seq, text: ev.text, disagree: false });
      continue;
    }
    const disagree = new Set(v.values()).size > 1;
    if (disagree || includeAgreements) out.push({ seq: ev.seq, text: ev.text, disagree });
  }
  return out.sort((a, b) => Number(b.disagree) - Number(a.disagree) || a.seq - b.seq);
}

export function addLabel(db: ExocortexDatabase, seq: number, label: TriageCategory, now = Date.now()): void {
  if (!TRIAGE_CATEGORIES.includes(label)) throw new Error(`invalid label: ${label}`);
  ensureTables(db);
  db.raw.prepare("INSERT INTO triage_labels (event_seq, label, labeled_at) VALUES (?, ?, ?)").run(seq, label, now);
}

/** Coarse event type, so one easy class (or one rare class) cannot hide behind the overall number. */
export type EventType = "voicemail" | "sms-inbound" | "other";

export function eventTypeOf(text: string): EventType {
  const t = text.replace(/^[^:]*:s*/, ""); // drop the "Messages: " app prefix
  if (t.startsWith("SMS inbound") && /voicemail/i.test(t)) return "voicemail";
  if (t.startsWith("SMS inbound")) return "sms-inbound";
  return "other";
}

export interface ModelScore {
  model: string;
  n: number;
  correct: number;
  accuracy: number;
  /** Of the events you labeled urgent, how many the model also called urgent (missing one is the costly error). */
  urgentRecall: number | null;
  /** Of the events the model called urgent, how many you labeled urgent. */
  urgentPrecision: number | null;
  /** Per event type: labeled count, correct, and how many you labeled urgent. */
  byType: Record<EventType, { n: number; correct: number; urgent: number }>;
  /** confusion[actual][predicted] */
  confusion: Record<TriageCategory, Record<TriageCategory, number>>;
}

export interface ScoreReport {
  labeled: number;
  labelCounts: Record<TriageCategory, number>;
  models: ModelScore[];
}

const blankConfusion = (): ModelScore["confusion"] => ({
  urgent: { urgent: 0, routine: 0, noise: 0 },
  routine: { urgent: 0, routine: 0, noise: 0 },
  noise: { urgent: 0, routine: 0, noise: 0 },
});

/** Scores each model on the events it has a verdict for and you have labeled (latest label wins). */
export function score(db: ExocortexDatabase, models: string[]): ScoreReport {
  ensureTables(db);
  const labels = latestLabels(db);
  // Only events triage would actually run on (own outgoing messages are excluded).
  const typeOf = new Map(triageableEvents(db).map((e) => [e.seq, eventTypeOf(e.text)] as const));
  for (const seq of [...labels.keys()]) if (!typeOf.has(seq)) labels.delete(seq);
  const labelCounts: Record<TriageCategory, number> = { urgent: 0, routine: 0, noise: 0 };
  for (const l of labels.values()) labelCounts[l]++;

  const verdicts = verdictsBySeq(db, models);
  const report: ScoreReport = { labeled: labels.size, labelCounts, models: [] };
  for (const model of models) {
    const confusion = blankConfusion();
    const byType: ModelScore["byType"] = {
      voicemail: { n: 0, correct: 0, urgent: 0 },
      "sms-inbound": { n: 0, correct: 0, urgent: 0 },
      other: { n: 0, correct: 0, urgent: 0 },
    };
    let n = 0;
    let correct = 0;
    for (const [seq, actual] of labels) {
      const type = typeOf.get(seq);
      if (!type) continue;
      const predicted = verdicts.get(seq)?.get(model);
      if (!predicted) continue;
      n++;
      byType[type].n++;
      if (predicted === actual) {
        correct++;
        byType[type].correct++;
      }
      if (actual === "urgent") byType[type].urgent++;
      confusion[actual][predicted]++;
    }
    const urgentActual = confusion.urgent.urgent + confusion.urgent.routine + confusion.urgent.noise;
    const urgentPred = confusion.urgent.urgent + confusion.routine.urgent + confusion.noise.urgent;
    report.models.push({
      model,
      n,
      correct,
      accuracy: n ? correct / n : 0,
      urgentRecall: urgentActual ? confusion.urgent.urgent / urgentActual : null,
      urgentPrecision: urgentPred ? confusion.urgent.urgent / urgentPred : null,
      byType,
      confusion,
    });
  }
  return report;
}

export function formatReport(r: ScoreReport): string {
  const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
  const lines = [
    `Labeled events: ${r.labeled}  (urgent ${r.labelCounts.urgent}, routine ${r.labelCounts.routine}, noise ${r.labelCounts.noise})`,
    "",
  ];
  for (const m of r.models) {
    lines.push(
      `${m.model}: accuracy ${m.correct}/${m.n} (${pct(m.n ? m.accuracy : null)}), urgent recall ${pct(m.urgentRecall)}, urgent precision ${pct(m.urgentPrecision)}`,
    );
    for (const t of Object.keys(m.byType) as EventType[]) {
      const b = m.byType[t];
      if (b.n) lines.push(`  ${t.padEnd(12)} ${b.correct}/${b.n} correct (${pct(b.correct / b.n)}), ${b.urgent} labeled urgent`);
    }
    lines.push("  actual \\ predicted   urgent routine  noise");
    for (const a of TRIAGE_CATEGORIES) {
      lines.push(`  ${a.padEnd(18)}  ${String(m.confusion[a].urgent).padStart(6)} ${String(m.confusion[a].routine).padStart(7)} ${String(m.confusion[a].noise).padStart(6)}`);
    }
    lines.push("");
  }
  if (r.labeled < 30) lines.push(`Only ${r.labeled} labels: treat this as a hint, not a verdict (aim for 30+ including disagreements).`);
  return lines.join("\n");
}
