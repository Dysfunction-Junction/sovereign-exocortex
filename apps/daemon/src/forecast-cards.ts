import type { ExocortexDatabase } from "@exocortex/core/db";
import type { GateDecision, InferencePolicy, ProposalEnvelope } from "@exocortex/world-model";
import { ShadowRecorder } from "./shadow-recorder.js";

/**
 * Forecast cards: T0 shadow proposals built from the prediction ledger so the daily review screen has
 * something to label every day, not only when an anomaly fires. Each card names one logged forecast;
 * the proposal's action payload keeps the prediction_id, which marks that forecast as shown to the user.
 * The gate reason starts with "calibration:", so the cards count as calibration samples in shadow metrics.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_DAILY_CAP = 4;
const MAX_DAILY_CAP = 8;
const MIN_TOP_PROB = 0.5;
const SAMPLER_VERSION = 1;
export const FORECAST_REASON = "calibration: forecast card";
export const FORECAST_INVARIANT = "inv_forecast_card";

export function forecastDailyCap(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DAILY_CAP;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(0, Math.min(MAX_DAILY_CAP, parsed)) : DEFAULT_DAILY_CAP;
}

function localHourKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
}

function dayBounds(date: Date): [number, number] {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

interface ForecastRow {
  prediction_id: string;
  candidates: string;
  made_at: number;
}

export class ForecastCardSampler {
  private lastRunHour: string | null = null;

  constructor(
    private readonly nowMs: () => number = Date.now,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly rng: () => number = Math.random,
  ) {}

  run(db: ExocortexDatabase): number {
    if (this.env.SHADOW === "0") return 0;
    const now = this.nowMs();
    const date = new Date(now);
    const hour = date.getHours();
    if (hour < 8 || hour >= 21) return 0;
    const hourKey = localHourKey(date);
    if (this.lastRunHour === hourKey) return 0;
    this.lastRunHour = hourKey;

    const cap = forecastDailyCap(this.env.FORECAST_CARD_DAILY_CAP);
    if (cap === 0) return 0;
    const [dayStart, dayEnd] = dayBounds(date);
    const raw = db.raw;
    const used = Number((raw.prepare(
      "SELECT COUNT(*) AS count FROM gate_decisions WHERE decision = 'SURFACE' AND reason = ? AND ts >= ? AND ts < ?",
    ).get(FORECAST_REASON, dayStart, dayEnd) as { count: number }).count);
    const remaining = cap - used;
    if (remaining <= 0) return 0;

    // Only forecasts that have resolved or expired, so the card never races the live prediction.
    const rows = raw.prepare(`
      SELECT p.prediction_id, p.candidates, p.made_at
        FROM predictions p
        JOIN prediction_outcomes o ON o.prediction_id = p.prediction_id
       WHERE p.made_at > ?
         AND NOT EXISTS (SELECT 1 FROM proposals q WHERE q.proposal_id = 'forecast_' || p.prediction_id)
       ORDER BY p.made_at DESC
       LIMIT 200
    `).all(now - DAY_MS) as unknown as ForecastRow[];

    const pool = rows
      .map((row) => {
        const top = (JSON.parse(row.candidates) as Array<{ value: string; prob: number }>)[0];
        return { row, top, weight: top ? Math.max(top.prob, MIN_TOP_PROB) : 0 };
      })
      .filter((x) => x.top && x.top.prob >= MIN_TOP_PROB);

    // Weighted draw without replacement, weight = top prob (floored, so every eligible forecast has a chance).
    // A deterministic top-prob pick would bias Precision@surface and leave no propensities for off-policy
    // evaluation. selection_prob is the conditional probability at this draw step (weight / remaining weight);
    // the overall inclusion probability across all draws is larger and is not simply this value.
    const picks: Array<{ row: ForecastRow; top: { value: string; prob: number }; selectionProb: number; poolSize: number; drawIndex: number }> = [];
    const draws = Math.min(remaining, pool.length);
    for (let drawIndex = 0; drawIndex < draws; drawIndex++) {
      const total = pool.reduce((sum, x) => sum + x.weight, 0);
      const target = this.rng() * total;
      let index = pool.length - 1;
      let cumulative = 0;
      for (let i = 0; i < pool.length; i++) {
        cumulative += pool[i].weight;
        if (target < cumulative) { index = i; break; }
      }
      const [chosen] = pool.splice(index, 1);
      picks.push({ row: chosen.row, top: chosen.top, selectionProb: chosen.weight / total, poolSize: pool.length + 1, drawIndex });
    }

    const recorder = new ShadowRecorder(db, { nowMs: () => now, cooldownMs: 0, shadow: true });
    let created = 0;
    for (const { row, top, selectionProb, poolSize, drawIndex } of picks) {
      const id = `forecast_${row.prediction_id}`;
      const pct = Math.round(top.prob * 100);
      const title = `Forecast: you'd open "${top.value}" next (${pct}%)`;
      const policy: InferencePolicy = {
        id,
        type: "EPISTEMIC",
        title,
        description: "Would it have helped to have this prepared ahead of time?",
        targetEntityId: "forecast_card",
        invariantId: FORECAST_INVARIANT,
        expectedUtility: top.prob,
        informationGain: 1 - top.prob,
        expectedFreeEnergyScore: 1 - top.prob,
        estimatedRisk: 0,
        urgency: 0.1,
        actionPayload: {
          kind: "forecast_card",
          prediction_id: row.prediction_id,
          predicted: top.value,
          prob: top.prob,
          selection_prob: selectionProb,
          pool_size: poolSize,
          draw_index: drawIndex,
          sampler_version: SAMPLER_VERSION,
        },
      };
      const proposal: ProposalEnvelope = {
        id,
        candidateId: FORECAST_INVARIANT,
        summary: title,
        urgency: 0.1,
        confidence: top.prob,
        estimatedRisk: 0,
      };
      const gate: GateDecision = {
        action: "ALLOW_PROMPT",
        mode: "MAINTENANCE_SURFACING",
        reason: FORECAST_REASON,
        targetDelivery: "GLASS_MODAL",
        confidence: top.prob,
        evaluatedAt: now,
      };
      if (recorder.record(policy, proposal, gate, { forceShadow: true })) created++;
    }
    return created;
  }
}

export function startForecastCardSampler(getDb: () => ExocortexDatabase): NodeJS.Timeout {
  const sampler = new ForecastCardSampler();
  const tick = () => {
    try {
      sampler.run(getDb());
    } catch (error) {
      console.error("[forecast-cards] failed:", error instanceof Error ? error.message : error);
    }
  };
  tick();
  const timer = setInterval(tick, HOUR_MS);
  timer.unref();
  return timer;
}
