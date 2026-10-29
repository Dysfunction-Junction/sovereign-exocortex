import test from "node:test";
import assert from "node:assert/strict";
import { ExocortexDatabase } from "@exocortex/core/db";
import { ensurePredictionTables, logPrediction } from "@exocortex/core";
import { ForecastCardSampler, FORECAST_REASON } from "./forecast-cards.js";

const localTime = (hour: number) => new Date(2026, 9, 28, hour).getTime();
const rngOf = (...values: number[]) => { let i = 0; return () => values[i++ % values.length]; };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

function seed(db: ExocortexDatabase, seq: number, prob: number, resolved = true): string {
  const raw = db.raw;
  ensurePredictionTables(raw);
  const id = logPrediction(raw, {
    device_id: "dev_a",
    made_seq: seq,
    made_at: localTime(7) + seq,
    horizon_ms: 300_000,
    context_key: "status|morning",
    candidates: [{ value: `screen${seq}`, prob }, { value: "other", prob: 1 - prob }],
  })!;
  if (resolved) {
    raw.prepare("INSERT INTO prediction_outcomes (prediction_id, outcome, resolved_at) VALUES (?, 'EXPIRED', ?)").run(id, localTime(7) + seq + 1);
  }
  return id;
}

test("forecast cards: caps per day, skips weak and unresolved forecasts, never repeats", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  const env: NodeJS.ProcessEnv = { SHADOW: "1", FORECAST_CARD_DAILY_CAP: "2" };
  try {
    const strong = seed(db, 1, 0.9);
    const mid = seed(db, 2, 0.7);
    seed(db, 3, 0.6);
    seed(db, 4, 0.3);
    seed(db, 5, 0.95, false);

    // Pool is newest first: [0.6, 0.7, 0.9]; rng 0.99 lands in the last slot each draw -> 0.9 then 0.7.
    const sampler = new ForecastCardSampler(() => localTime(9), env, () => 0.99);
    assert.equal(sampler.run(db), 2);
    assert.equal(sampler.run(db), 0, "one run per local hour");
    assert.equal(new ForecastCardSampler(() => localTime(10), env).run(db), 0, "daily cap carries across hours");

    const rows = db.raw.prepare("SELECT proposal_id FROM gate_decisions WHERE reason = ? ORDER BY rowid").all(FORECAST_REASON) as Array<{ proposal_id: string }>;
    assert.deepEqual(rows.map((r) => r.proposal_id).sort(), [`forecast_${mid}`, `forecast_${strong}`].sort());
    const p = db.getProposal(`forecast_${strong}`)!;
    assert.equal(p.state, "SURFACED");
    assert.equal(p.tier, 0);
    assert.equal(p.shadow, 1);
    assert.equal(JSON.parse(p.action).prediction_id, strong);

    const next = new ForecastCardSampler(() => new Date(2026, 9, 29, 9).getTime(), env);
    assert.equal(next.run(db), 0, "forecasts older than 24h are not carded");
  } finally {
    db.close();
  }
});

test("forecast cards: off outside 08-21 and when SHADOW=0", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    seed(db, 1, 0.9);
    assert.equal(new ForecastCardSampler(() => localTime(22), { SHADOW: "1" }).run(db), 0);
    assert.equal(new ForecastCardSampler(() => localTime(9), { SHADOW: "0" }).run(db), 0);
    assert.equal(new ForecastCardSampler(() => localTime(9), { SHADOW: "1" }).run(db), 1);
  } finally {
    db.close();
  }
});

test("forecast cards: weighted draw without replacement logs hand-computed propensities", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    const high = seed(db, 1, 0.9);
    const mid = seed(db, 2, 0.6);
    const low = seed(db, 3, 0.5);
    // Pool (newest first) [low 0.5, mid 0.6, high 0.9], total 2.0.
    // Draw 0: 0.4 * 2.0 = 0.8 -> mid, p = 0.6 / 2.0. Draw 1: [0.5, 0.9], 0.1 * 1.4 = 0.14 -> low, p = 0.5 / 1.4.
    // Draw 2: [0.9] -> high, p = 1.
    const sampler = new ForecastCardSampler(() => localTime(9), { SHADOW: "1", FORECAST_CARD_DAILY_CAP: "3" }, rngOf(0.4, 0.1, 0));
    assert.equal(sampler.run(db), 3);
    const payload = (id: string) => JSON.parse(db.getProposal(`forecast_${id}`)!.action);
    const expected: Array<[string, number, number, number]> = [[mid, 0, 3, 0.3], [low, 1, 2, 0.5 / 1.4], [high, 2, 1, 1]];
    for (const [id, drawIndex, poolSize, prob] of expected) {
      const a = payload(id);
      assert.equal(a.prediction_id, id);
      assert.equal(a.draw_index, drawIndex);
      assert.equal(a.pool_size, poolSize);
      assert.equal(a.sampler_version, 1);
      near(a.selection_prob, prob);
      assert.ok(a.selection_prob > 0 && a.selection_prob <= 1);
    }
  } finally {
    db.close();
  }
});

test("forecast cards: a low-prob eligible forecast can be chosen over stronger ones", () => {
  const db = new ExocortexDatabase({ path: ":memory:" });
  try {
    seed(db, 1, 0.95);
    seed(db, 2, 0.9);
    const low = seed(db, 3, 0.5);
    const sampler = new ForecastCardSampler(() => localTime(9), { SHADOW: "1", FORECAST_CARD_DAILY_CAP: "1" }, () => 0);
    assert.equal(sampler.run(db), 1);
    const a = JSON.parse(db.getProposal(`forecast_${low}`)!.action);
    assert.equal(a.prediction_id, low);
    assert.equal(a.pool_size, 3);
    near(a.selection_prob, 0.5 / 2.35);
  } finally {
    db.close();
  }
});
