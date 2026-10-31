/**
 * @file parsers/health-connect.ts
 * Parser for Android Health Connect records (JSON and CSV exports).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TextInput } from "../databank.js";
import { parseTimestamp, type ParsedTemporal } from "./takeout-location.js";

export interface HealthConnectParserOptions {
  filePath?: string;
  device?: string;
}

export interface SleepSessionSummary {
  title?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  notes?: string;
  stages?: Array<{ stage: string; durationMinutes?: number }>;
}

export interface ExerciseSessionSummary {
  type: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes: number;
  calories?: number;
  distanceMeters?: number;
}

export interface DailyHealthBucket {
  dateStr: string;
  epochMs: number;
  temporal: ParsedTemporal;
  steps: number;
  sleepMinutes: number;
  sleepSessions: SleepSessionSummary[];
  exerciseSessions: ExerciseSessionSummary[];
  activeCalories: number;
  totalCalories: number;
  device?: string;
  notes: string[];
}

function getOrCreateBucket(
  buckets: Map<string, DailyHealthBucket>,
  dateStr: string,
  _timestampMs?: number,
  fallbackDevice?: string
): DailyHealthBucket {
  const existing = buckets.get(dateStr);
  if (existing) return existing;

  const { ms, temporal } = parseTimestamp(`${dateStr}T00:00:00Z`);
  const bucket: DailyHealthBucket = {
    dateStr,
    epochMs: ms,
    temporal,
    steps: 0,
    sleepMinutes: 0,
    sleepSessions: [],
    exerciseSessions: [],
    activeCalories: 0,
    totalCalories: 0,
    device: fallbackDevice,
    notes: [],
  };
  buckets.set(dateStr, bucket);
  return bucket;
}

function extractDateStr(val: string | number | undefined): { dateStr: string; ms: number } {
  const { ms, temporal } = parseTimestamp(val);
  return { dateStr: temporal.dateStr, ms };
}

function formatDuration(minutes: number): string {
  const hrs = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (hrs > 0) {
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }
  return `${mins}m`;
}

function formatDailySummary(bucket: DailyHealthBucket, options?: HealthConnectParserOptions): TextInput {
  const lines: string[] = [
    `Health Summary for ${bucket.dateStr}`,
    "--- Daily Metrics ---",
  ];

  if (bucket.steps > 0) {
    lines.push(`- Steps: ${bucket.steps.toLocaleString()} steps`);
  }

  if (bucket.sleepMinutes > 0 || bucket.sleepSessions.length > 0) {
    const sleepDur = formatDuration(bucket.sleepMinutes);
    lines.push(`- Sleep Duration: ${sleepDur} (${Math.round(bucket.sleepMinutes)} min)`);
    for (const session of bucket.sleepSessions) {
      const name = session.title || "Sleep session";
      const dur = formatDuration(session.durationMinutes);
      const stageStr = session.stages && session.stages.length > 0
        ? ` [${session.stages.map((s) => `${s.stage}: ${formatDuration(s.durationMinutes ?? 0)}`).join(", ")}]`
        : "";
      lines.push(`  * ${name}: ${dur}${stageStr}`);
    }
  }

  if (bucket.exerciseSessions.length > 0) {
    lines.push(`- Exercise (${bucket.exerciseSessions.length} session${bucket.exerciseSessions.length > 1 ? "s" : ""}):`);
    for (const ex of bucket.exerciseSessions) {
      const parts: string[] = [`${ex.type} (${formatDuration(ex.durationMinutes)})`];
      if (ex.calories && ex.calories > 0) parts.push(`${Math.round(ex.calories)} kcal`);
      if (ex.distanceMeters && ex.distanceMeters > 0) {
        parts.push(ex.distanceMeters >= 1000 ? `${(ex.distanceMeters / 1000).toFixed(2)} km` : `${Math.round(ex.distanceMeters)} m`);
      }
      lines.push(`  * ${parts.join(", ")}`);
    }
  }

  if (bucket.activeCalories > 0) {
    lines.push(`- Active Calories: ${Math.round(bucket.activeCalories)} kcal`);
  }
  if (bucket.totalCalories > 0 && bucket.totalCalories !== bucket.activeCalories) {
    lines.push(`- Total Calories: ${Math.round(bucket.totalCalories)} kcal`);
  }

  if (bucket.notes.length > 0) {
    lines.push(`- Notes: ${bucket.notes.join("; ")}`);
  }

  const text = lines.join("\n");
  const device = bucket.device ?? options?.device ?? "unknown";

  const tags = Array.from(
    new Set(
      [
        "health",
        "daily-summary",
        bucket.steps > 0 ? "steps" : null,
        bucket.sleepMinutes > 0 ? "sleep" : null,
        bucket.exerciseSessions.length > 0 ? "exercise" : null,
        device !== "unknown" ? device : null,
      ].filter((t): t is string => Boolean(t))
    )
  );

  const exerciseEntities = bucket.exerciseSessions.map((e) => e.type);
  const entities = Array.from(
    new Set([
      "Health Connect",
      "Daily Summary",
      bucket.steps > 0 ? "Steps" : null,
      bucket.sleepMinutes > 0 ? "Sleep" : null,
      ...exerciseEntities,
    ].filter((e): e is string => Boolean(e)))
  );

  return {
    kind: "note",
    source: "health-connect",
    title: `Health Summary for ${bucket.dateStr}`,
    text,
    path: options?.filePath ?? "",
    ts: bucket.epochMs,
    meta: {
      date: bucket.dateStr,
      steps: bucket.steps,
      sleep: {
        totalMinutes: bucket.sleepMinutes,
        sessions: bucket.sleepSessions,
      },
      exercise: bucket.exerciseSessions,
      activeCalories: bucket.activeCalories,
      totalCalories: bucket.totalCalories,
      device,
      tags,
      entities,
      temporal: bucket.temporal,
    },
  };
}

/** Parses Health Connect JSON record item into daily buckets */
function processJsonRecord(record: Record<string, unknown>, buckets: Map<string, DailyHealthBucket>, defaultDevice?: string): void {
  const recType = String(record.recordType ?? record.type ?? "").toLowerCase();
  const startTime = record.startTime ?? record.start_time ?? record.date ?? record.timestamp;
  const endTime = record.endTime ?? record.end_time;
  // For sleep sessions, if no explicit date is set, the day of waking up (endTime) is standardly used for daily metrics:
  const primaryTime = recType.includes("sleep") && !record.date && endTime ? endTime : (startTime ?? endTime);
  const { dateStr, ms } = extractDateStr(String(primaryTime ?? ""));
  const dev = String(record.device ?? record.deviceName ?? defaultDevice ?? "");

  const bucket = getOrCreateBucket(buckets, dateStr, ms, dev || undefined);
  if (dev && !bucket.device) bucket.device = dev;

  // 1. Steps
  if (recType.includes("step") || "count" in record || "steps" in record) {
    const count = Number(record.count ?? record.steps ?? record.value ?? 0);
    if (!isNaN(count) && count > 0) {
      bucket.steps += Math.round(count);
    }
  }

  // 2. Sleep
  if (recType.includes("sleep")) {
    let durMin = Number(record.durationMinutes ?? record.duration_minutes ?? record.minutes ?? 0);
    if ((!durMin || durMin === 0) && startTime && endTime) {
      const s = parseTimestamp(String(startTime)).ms;
      const e = parseTimestamp(String(endTime)).ms;
      durMin = Math.max(0, (e - s) / 60000);
    }
    const stages: Array<{ stage: string; durationMinutes?: number }> = [];
    if (Array.isArray(record.stages)) {
      for (const st of record.stages) {
        if (st && typeof st === "object") {
          const stageName = String((st as { stage?: string; type?: string }).stage ?? (st as { stage?: string; type?: string }).type ?? "STAGE");
          const stageDur = Number((st as { durationMinutes?: number; minutes?: number }).durationMinutes ?? (st as { durationMinutes?: number; minutes?: number }).minutes ?? 0);
          stages.push({ stage: stageName, durationMinutes: stageDur });
        }
      }
    }
    bucket.sleepMinutes += durMin;
    bucket.sleepSessions.push({
      title: record.title ? String(record.title) : undefined,
      startTime: startTime ? String(startTime) : undefined,
      endTime: endTime ? String(endTime) : undefined,
      durationMinutes: durMin,
      notes: record.notes ? String(record.notes) : undefined,
      stages: stages.length > 0 ? stages : undefined,
    });
  }

  // 3. Exercise
  if (recType.includes("exercise") || recType.includes("workout") || "exerciseType" in record || "activity" in record) {
    const rawType = String(record.exerciseType ?? record.activity ?? record.title ?? "Exercise");
    let durMin = Number(record.durationMinutes ?? record.duration_minutes ?? record.minutes ?? 0);
    if ((!durMin || durMin === 0) && startTime && endTime) {
      const s = parseTimestamp(String(startTime)).ms;
      const e = parseTimestamp(String(endTime)).ms;
      durMin = Math.max(0, (e - s) / 60000);
    }
    const calories = Number(record.calories ?? record.activeCalories ?? record.energyExpended ?? 0);
    const distanceMeters = Number(record.distanceMeters ?? record.distance ?? 0);
    bucket.exerciseSessions.push({
      type: rawType.toUpperCase(),
      title: record.title ? String(record.title) : undefined,
      startTime: startTime ? String(startTime) : undefined,
      endTime: endTime ? String(endTime) : undefined,
      durationMinutes: durMin,
      calories: calories > 0 ? calories : undefined,
      distanceMeters: distanceMeters > 0 ? distanceMeters : undefined,
    });
    if (calories > 0) bucket.activeCalories += calories;
  }

  // 4. Calories / Active Energy
  if (recType.includes("calorie") || recType.includes("energy")) {
    const cal = Number(record.calories ?? record.value ?? record.energy ?? 0);
    if (cal > 0) {
      if (recType.includes("active")) bucket.activeCalories += cal;
      else bucket.totalCalories += cal;
    }
  }
}

/** Parses CSV text into rows of columns */
function parseCsvRows(csv: string): string[][] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const rows: string[][] = [];

  for (const line of lines) {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === "," && !inQuotes) {
        fields.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur.trim());
    rows.push(fields);
  }
  return rows;
}

/** Parses CSV formatted Health Connect export */
function parseHealthCsv(csv: string, buckets: Map<string, DailyHealthBucket>, defaultDevice?: string): void {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return;

  const header = rows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const dateIdx = header.findIndex((h) => h.includes("date") || h.includes("time") || h === "day");
  if (dateIdx === -1) return;

  const stepsIdx = header.findIndex((h) => h.includes("step"));
  const sleepIdx = header.findIndex((h) => h.includes("sleep"));
  const exerciseIdx = header.findIndex((h) => h.includes("exercise") || h.includes("workout") || h.includes("activity"));
  const caloriesIdx = header.findIndex((h) => h.includes("calorie") || h.includes("energy") || h.includes("kcal"));
  const typeIdx = header.findIndex((h) => h === "type" || h === "recordtype");
  const valueIdx = header.findIndex((h) => h === "value" || h === "count" || h === "amount");
  const deviceIdx = header.findIndex((h) => h.includes("device") || h.includes("model"));

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawDate = row[dateIdx];
    if (!rawDate) continue;

    const { dateStr, ms } = extractDateStr(rawDate);
    const rowDevice = deviceIdx !== -1 && row[deviceIdx] ? row[deviceIdx] : defaultDevice;
    const bucket = getOrCreateBucket(buckets, dateStr, ms, rowDevice);

    // If row-based type/value format:
    if (typeIdx !== -1 && valueIdx !== -1) {
      const type = (row[typeIdx] || "").toLowerCase();
      const val = row[valueIdx] || "";
      const numVal = Number(val.replace(/[^0-9.]/g, ""));

      if (type.includes("step")) {
        if (!isNaN(numVal)) bucket.steps += Math.round(numVal);
      } else if (type.includes("sleep")) {
        const sleepMin = val.includes("h") ? numVal * 60 : numVal;
        bucket.sleepMinutes += sleepMin;
        bucket.sleepSessions.push({ durationMinutes: sleepMin });
      } else if (type.includes("exercise") || type.includes("workout")) {
        bucket.exerciseSessions.push({
          type: (row[valueIdx] || "Workout").toUpperCase(),
          durationMinutes: 30, // fallback
        });
      }
      continue;
    }

    // Wide column format:
    if (stepsIdx !== -1 && row[stepsIdx]) {
      const st = Number(row[stepsIdx].replace(/[^0-9.]/g, ""));
      if (!isNaN(st)) bucket.steps += Math.round(st);
    }

    if (sleepIdx !== -1 && row[sleepIdx]) {
      const rawSleep = row[sleepIdx];
      let sleepMin = Number(rawSleep.replace(/[^0-9.]/g, ""));
      // if sleep is formatted as hours e.g. "7.5"
      if (sleepMin < 24 && !rawSleep.toLowerCase().includes("m")) {
        sleepMin = sleepMin * 60;
      }
      if (!isNaN(sleepMin) && sleepMin > 0) {
        bucket.sleepMinutes += sleepMin;
        bucket.sleepSessions.push({ durationMinutes: sleepMin });
      }
    }

    if (exerciseIdx !== -1 && row[exerciseIdx]) {
      const exVal = row[exerciseIdx];
      bucket.exerciseSessions.push({
        type: exVal.toUpperCase(),
        durationMinutes: 30,
      });
    }

    if (caloriesIdx !== -1 && row[caloriesIdx]) {
      const cal = Number(row[caloriesIdx].replace(/[^0-9.]/g, ""));
      if (!isNaN(cal)) bucket.activeCalories += cal;
    }
  }
}

/**
 * Parses Android Health Connect content (JSON or CSV string, or parsed JSON object/array).
 */
export function parseHealthConnect(
  content: string | Record<string, unknown> | Array<unknown>,
  options?: HealthConnectParserOptions
): TextInput[] {
  const buckets = new Map<string, DailyHealthBucket>();

  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const data = JSON.parse(trimmed);
        processJsonData(data, buckets, options?.device);
      } catch (err) {
        throw new Error(`Failed to parse Health Connect JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // CSV format
      parseHealthCsv(trimmed, buckets, options?.device);
    }
  } else {
    processJsonData(content, buckets, options?.device);
  }

  // Convert buckets to TextInput array sorted by date
  const sortedDates = Array.from(buckets.keys()).sort();
  const items: TextInput[] = [];
  for (const dateStr of sortedDates) {
    const b = buckets.get(dateStr);
    if (b) items.push(formatDailySummary(b, options));
  }

  return items;
}

function processJsonData(data: unknown, buckets: Map<string, DailyHealthBucket>, defaultDevice?: string): void {
  if (!data || typeof data !== "object") return;

  if (Array.isArray(data)) {
    for (const rec of data) {
      if (rec && typeof rec === "object") {
        processJsonRecord(rec as Record<string, unknown>, buckets, defaultDevice);
      }
    }
    return;
  }

  const obj = data as Record<string, unknown>;
  const dev = String(obj.device ?? obj.deviceName ?? defaultDevice ?? "");

  // Check { records: [...] }
  if (Array.isArray(obj.records)) {
    for (const rec of obj.records) {
      if (rec && typeof rec === "object") {
        processJsonRecord(rec as Record<string, unknown>, buckets, dev || defaultDevice);
      }
    }
    return;
  }

  // Check { steps: [...], sleep: [...], exercise: [...] }
  const categories = ["steps", "sleep", "exercise", "workouts"];
  let matchedCategory = false;
  for (const cat of categories) {
    if (Array.isArray(obj[cat])) {
      matchedCategory = true;
      for (const rec of obj[cat] as unknown[]) {
        if (rec && typeof rec === "object") {
          const recObj = { ...rec as Record<string, unknown>, type: (rec as Record<string, unknown>).type ?? cat };
          processJsonRecord(recObj, buckets, dev || defaultDevice);
        }
      }
    }
  }
  if (matchedCategory) return;

  // Single record or single daily summary object
  processJsonRecord(obj, buckets, dev || defaultDevice);
}

async function walkHealthDir(
  dir: string,
  items: TextInput[],
  options?: HealthConnectParserOptions
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkHealthDir(full, items, options);
    } else if (e.isFile() && (e.name.toLowerCase().endsWith(".json") || e.name.toLowerCase().endsWith(".csv"))) {
      try {
        const raw = await readFile(full, "utf8");
        items.push(...parseHealthConnect(raw, { ...options, filePath: full }));
      } catch {
        // skip unparseable files in batch walk
      }
    }
  }
}

/**
 * Parses Health Connect file or directory recursively.
 */
export async function parseHealthConnectPath(
  targetPath: string,
  options?: HealthConnectParserOptions
): Promise<TextInput[]> {
  const s = await stat(targetPath);
  if (s.isDirectory()) {
    const items: TextInput[] = [];
    await walkHealthDir(targetPath, items, options);
    return items;
  } else {
    const raw = await readFile(targetPath, "utf8");
    return parseHealthConnect(raw, { ...options, filePath: targetPath });
  }
}
