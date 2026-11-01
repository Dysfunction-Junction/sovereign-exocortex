/**
 * @file parsers/fi-history.ts
 * Parser for Google Fi call and text detail records (FiHistory CSV exports).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TextInput } from "../databank.js";
import { parseTimestamp, type ParsedTemporal } from "./takeout-location.js";
import { parseCsvRows } from "./contacts.js";

export interface FiHistoryParserOptions {
  filePath?: string;
  contactMap?: Record<string, string>;
  groupBy?: "month" | "day" | "record";
}

export interface FiRecord {
  date: string;
  time: string;
  rawPhone: string;
  normPhone: string;
  contactName?: string;
  participants: string[];
  type: string;
  isCall: boolean;
  isText: boolean;
  durationStr?: string;
  durationSec?: number;
  rate?: string;
  cost?: string;
  timestamp: number;
  temporal: ParsedTemporal;
  yearMonth: string;
}

export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "").trim();
  if (!digits) return "";
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

export function formatDurationSec(sec: number): string {
  if (sec <= 0) return "0s";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

export function parseFiDuration(rawDur: string | undefined): { durationStr: string; durationSec: number } | undefined {
  if (!rawDur || !rawDur.trim()) return undefined;
  const s = rawDur.trim();

  if (s.includes(":")) {
    const parts = s.split(":").map(Number);
    let sec = 0;
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      sec = parts[0] * 60 + parts[1];
    } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
      sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return { durationStr: formatDurationSec(sec), durationSec: sec };
  }

  const num = Number(s);
  if (!isNaN(num) && num > 0) {
    const sec = Math.round(num * 3600);
    return { durationStr: formatDurationSec(sec), durationSec: sec };
  }

  return undefined;
}

export function parseFiDateTime(dateRaw: string, timeRaw: string): { ms: number; temporal: ParsedTemporal; yearMonth: string } {
  const cleanDate = (dateRaw || "").replace(/[\u00a0\u00c2]/g, " ").replace(/\s+/g, " ").trim();
  const cleanTime = (timeRaw || "").replace(/[\u00a0\u00c2]/g, " ").replace(/\s+/g, " ").trim();

  let parsedMs = Date.parse(`${cleanDate} ${cleanTime}`);
  if (isNaN(parsedMs)) {
    parsedMs = Date.parse(cleanDate);
  }
  if (isNaN(parsedMs)) {
    parsedMs = Date.now();
  }

  const { ms, temporal } = parseTimestamp(parsedMs);
  const mm = String(temporal.month).padStart(2, "0");
  const yearMonth = `${temporal.year}-${mm}`;
  return { ms, temporal, yearMonth };
}

/** Parses raw CSV text of Google Fi History */
export function parseFiRows(csvContent: string, options?: FiHistoryParserOptions): FiRecord[] {
  const rows = parseCsvRows(csvContent);
  if (rows.length < 2) return [];

  const rawHeader = rows[0];
  const header = rawHeader.map((h) => h.toLowerCase().trim().replace(/^\ufeff/, ""));

  const dateIdx = header.findIndex((h) => h.startsWith("date"));
  const timeIdx = header.findIndex((h) => h.startsWith("time"));
  const phoneIdx = header.findIndex((h) => h.includes("phone"));
  const typeIdx = header.findIndex((h) => h === "type");
  const durIdx = header.findIndex((h) => h.startsWith("dur"));
  const rateIdx = header.findIndex((h) => h.startsWith("rate"));
  const costIdx = header.findIndex((h) => h.startsWith("cost"));

  if (dateIdx === -1 && typeIdx === -1) return [];

  const records: FiRecord[] = [];
  const seenSignatures = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const dateRaw = dateIdx !== -1 ? row[dateIdx] || "" : "";
    const timeRaw = timeIdx !== -1 ? row[timeIdx] || "" : "";
    const phoneRaw = phoneIdx !== -1 ? row[phoneIdx] || "" : "";
    const typeRaw = typeIdx !== -1 ? row[typeIdx] || "" : "";
    const durRaw = durIdx !== -1 ? row[durIdx] || "" : "";
    const rateRaw = rateIdx !== -1 ? row[rateIdx] || "" : "";
    const costRaw = costIdx !== -1 ? row[costIdx] || "" : "";

    if (!phoneRaw.trim() && !typeRaw.trim()) continue;

    const { ms: timestamp, temporal, yearMonth } = parseFiDateTime(dateRaw, timeRaw);
    const durParsed = parseFiDuration(durRaw);

    const rawParts = phoneRaw.split(",").map((p) => p.trim()).filter(Boolean);
    const participants: string[] = [];
    let normPhone = "";
    let contactName: string | undefined;

    for (const p of rawParts) {
      const np = normalizePhoneNumber(p);
      if (np) {
        participants.push(np);
        if (!normPhone) normPhone = np;
        if (!contactName && options?.contactMap?.[np]) {
          contactName = options.contactMap[np];
        }
      } else {
        participants.push(p);
        if (!contactName) contactName = p;
      }
    }

    const typeLower = typeRaw.toLowerCase();
    const isCall = typeLower.includes("call");
    const isText = typeLower.includes("text");

    const sig = `${dateRaw}|${timeRaw}|${typeRaw}|${normPhone || phoneRaw}|${durParsed?.durationSec ?? ""}`;
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);

    records.push({
      date: dateRaw,
      time: timeRaw,
      rawPhone: phoneRaw,
      normPhone,
      contactName,
      participants,
      type: typeRaw,
      isCall,
      isText,
      durationStr: durParsed?.durationStr,
      durationSec: durParsed?.durationSec,
      rate: rateRaw || undefined,
      cost: costRaw || undefined,
      timestamp,
      temporal,
      yearMonth,
    });
  }

  return records;
}

/** Formats grouped Fi records into a Databank conversation TextInput */
function formatFiGroup(
  groupKey: string,
  records: FiRecord[],
  options?: FiHistoryParserOptions
): TextInput {
  records.sort((a, b) => a.timestamp - b.timestamp);

  const first = records[0];
  const last = records[records.length - 1];

  const primaryPhone = records.find((r) => r.normPhone)?.normPhone || first.rawPhone;
  const contact = records.find((r) => r.contactName)?.contactName || primaryPhone || "Unknown";
  const contactLabel = contact !== primaryPhone && primaryPhone ? `${contact} (${primaryPhone})` : contact;

  const allParticipants = Array.from(new Set(records.flatMap((r) => r.participants)));
  let textCount = 0;
  let callCount = 0;
  let totalDurSec = 0;

  for (const r of records) {
    if (r.isText) textCount++;
    if (r.isCall) {
      callCount++;
      if (r.durationSec) totalDurSec += r.durationSec;
    }
  }

  const lines: string[] = [
    `Google Fi Communication History with ${contactLabel}`,
    `Period: ${first.yearMonth}`,
    `Summary: ${records.length} total events (${textCount} texts, ${callCount} calls)`,
  ];

  if (callCount > 0) {
    lines.push(`Total Call Duration: ${formatDurationSec(totalDurSec)}`);
  }
  lines.push("", "Timeline:");

  for (const r of records) {
    const durInfo = r.durationStr ? ` (Duration: ${r.durationStr})` : "";
    const cleanD = r.date.replace(/[\u00a0\u00c2]/g, " ").replace(/\s+/g, " ").trim();
    const cleanT = r.time.replace(/[\u00a0\u00c2]/g, " ").replace(/\s+/g, " ").trim();
    lines.push(`- ${cleanD} ${cleanT} | ${r.type}${durInfo}`);
  }

  const tags = Array.from(
    new Set(
      ["google-fi", "cdr", "telecom", "calls", "sms", contact, first.yearMonth].filter(
        (t): t is string => Boolean(t)
      )
    )
  );

  const entities = Array.from(
    new Set([contact, ...allParticipants].filter((e): e is string => Boolean(e)))
  );

  return {
    kind: "conversation",
    source: "google-fi",
    title: `Google Fi History: ${contactLabel} (${first.yearMonth})`,
    text: lines.join("\n"),
    path: options?.filePath ?? "",
    ts: first.timestamp,
    meta: {
      contact,
      phoneNumber: primaryPhone,
      participants: allParticipants,
      period: first.yearMonth,
      eventCount: records.length,
      textCount,
      callCount,
      totalDurationSec: totalDurSec,
      tags,
      entities,
      temporal: first.temporal,
      lastTimestamp: last.timestamp,
    },
  };
}

/** Groups records by month or day or record into Databank TextInputs */
export function groupFiRecords(
  records: FiRecord[],
  options?: FiHistoryParserOptions
): TextInput[] {
  if (records.length === 0) return [];
  const groupBy = options?.groupBy ?? "month";

  if (groupBy === "record") {
    return records.map((r) => {
      const dur = r.durationStr ? ` (Duration: ${r.durationStr})` : "";
      const contact = r.contactName || r.normPhone || r.rawPhone;
      return {
        kind: "conversation",
        source: "google-fi",
        title: `Google Fi: ${r.type} with ${contact}`,
        text: `${r.date} ${r.time} - ${r.type} with ${contact}${dur}`,
        path: options?.filePath ?? "",
        ts: r.timestamp,
        meta: {
          contact,
          phoneNumber: r.normPhone || r.rawPhone,
          type: r.type,
          durationSec: r.durationSec,
          tags: ["google-fi", "cdr", contact, r.type],
          temporal: r.temporal,
        },
      };
    });
  }

  const groups = new Map<string, FiRecord[]>();

  for (const r of records) {
    const contactKey = r.normPhone || r.contactName || r.rawPhone || "Unknown";
    const groupKey = groupBy === "day" ? `${contactKey}:${r.temporal.dateStr}` : `${contactKey}:${r.yearMonth}`;
    const list = groups.get(groupKey);
    if (list) {
      list.push(r);
    } else {
      groups.set(groupKey, [r]);
    }
  }

  const items: TextInput[] = [];
  for (const [key, recs] of groups.entries()) {
    items.push(formatFiGroup(key, recs, options));
  }

  return items;
}

/** Parses Google Fi History CSV content into Databank TextInputs */
export function parseFiHistory(
  content: string,
  options?: FiHistoryParserOptions
): TextInput[] {
  const records = parseFiRows(content, options);
  return groupFiRecords(records, options);
}

async function walkFiDir(
  dir: string,
  records: FiRecord[],
  seenSignatures: Set<string>,
  options?: FiHistoryParserOptions
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkFiDir(full, records, seenSignatures, options);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".csv") && e.name.toLowerCase().includes("fihistory")) {
      try {
        const raw = await readFile(full, "utf8");
        const parsed = parseFiRows(raw, { ...options, filePath: full });
        for (const r of parsed) {
          const sig = `${r.date}|${r.time}|${r.type}|${r.normPhone || r.rawPhone}|${r.durationSec ?? ""}`;
          if (!seenSignatures.has(sig)) {
            seenSignatures.add(sig);
            records.push(r);
          }
        }
      } catch {
        // ignore unparseable files
      }
    }
  }
}

/** Parses a file or directory of Google Fi History CSV files */
export async function parseFiHistoryPath(
  filePathOrDir: string,
  options?: FiHistoryParserOptions
): Promise<TextInput[]> {
  const s = await stat(filePathOrDir);
  if (s.isDirectory()) {
    const allRecords: FiRecord[] = [];
    const seenSignatures = new Set<string>();
    await walkFiDir(filePathOrDir, allRecords, seenSignatures, options);
    return groupFiRecords(allRecords, options);
  }
  const raw = await readFile(filePathOrDir, "utf8");
  return parseFiHistory(raw, { ...options, filePath: filePathOrDir });
}
