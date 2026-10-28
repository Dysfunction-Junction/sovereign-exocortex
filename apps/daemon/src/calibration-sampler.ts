import type { ExocortexDatabase } from "@exocortex/core/db";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_DAILY_CAP = 4;
const MAX_DAILY_CAP = 8;

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

export function calibrationDailyCap(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DAILY_CAP;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(0, Math.min(MAX_DAILY_CAP, parsed)) : DEFAULT_DAILY_CAP;
}

export class CalibrationSampler {
  private lastRunHour: string | null = null;

  constructor(
    private readonly nowMs: () => number = Date.now,
    private readonly env: NodeJS.ProcessEnv = process.env,
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

    const cap = calibrationDailyCap(this.env.CALIBRATION_DAILY_CAP);
    if (cap === 0) return 0;
    const [dayStart, dayEnd] = dayBounds(date);
    const raw = db.raw;
    const used = Number((raw.prepare(
      "SELECT COUNT(*) AS count FROM gate_decisions WHERE decision = 'SURFACE' AND reason LIKE 'calibration:%' AND ts >= ? AND ts < ?",
    ).get(dayStart, dayEnd) as { count: number }).count);
    const remaining = cap - used;
    if (remaining <= 0) return 0;

    const candidates = raw.prepare(`
      SELECT p.proposal_id, p.efe, g.mode
        FROM proposals p
        JOIN gate_decisions g ON g.proposal_id = p.proposal_id
       WHERE p.state = 'STAGED'
         AND p.shadow = 1
         AND p.expires_at > ?
         AND g.rowid = (
           SELECT latest.rowid FROM gate_decisions latest
            WHERE latest.proposal_id = p.proposal_id
            ORDER BY latest.ts DESC, latest.rowid DESC LIMIT 1
         )
         AND g.decision = 'QUEUE'
         AND NOT EXISTS (SELECT 1 FROM shadow_labels l WHERE l.proposal_id = p.proposal_id)
       ORDER BY p.efe ASC, p.created_seq DESC
       LIMIT ?
    `).all(now, remaining) as Array<{ proposal_id: string; efe: number; mode: string }>;

    let promoted = 0;
    for (const candidate of candidates) {
      db.withTransaction(() => {
        db.recordGateDecision({
          proposal_id: candidate.proposal_id,
          mode: candidate.mode,
          decision: "SURFACE",
          reason: "calibration: conservative queued sample",
          ts: now,
        });
        db.updateProposalState(candidate.proposal_id, "SURFACED");
      });
      promoted++;
    }
    return promoted;
  }
}

export function startCalibrationSampler(getDb: () => ExocortexDatabase): NodeJS.Timeout {
  const sampler = new CalibrationSampler();
  const tick = () => {
    try {
      sampler.run(getDb());
    } catch (error) {
      console.error("[calibration-sampler] promotion failed:", error instanceof Error ? error.message : error);
    }
  };
  tick();
  const timer = setInterval(tick, HOUR_MS);
  timer.unref();
  return timer;
}
