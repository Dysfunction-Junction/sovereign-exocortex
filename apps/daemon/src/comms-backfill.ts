/**
 * @file comms-backfill.ts
 * Replays a Google Fi call/text history into the event log as PAST events (kind "past"), joined to a Google
 * Contacts export so phone numbers become stable person ids.
 *
 * Privacy: raw phone numbers never reach the log. Known contacts become `person_<name>`; unknown numbers become
 * `anon_<hmac>` using a local secret salt. Contact notes, addresses, emails, birthdays and photos are never read.
 * Automated senders (short codes, hash-like ids) are counted and skipped.
 *
 * Idempotent: event_id is derived from the row contents plus an occurrence counter, so re-running inserts nothing.
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExocortexDatabase } from "@exocortex/core/db";
import { PAST_KIND } from "./pieces-backfill.js";

export const COMMS_DEVICE_ID = "comms-backfill";

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** Digits only, US country code dropped. Returns null for anything that is not a 10-digit number. */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  const n = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return n.length === 10 ? n : null;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export interface Person {
  id: string;
  labels: string[];
}

const NOISE_LABELS = /^(imported on|\* mycontacts)/i;

/** number -> person. Reads only name, organization, labels and phone columns. */
export function loadContacts(csv: string): Map<string, Person> {
  const rows = parseCsv(csv);
  const head = rows[0] ?? [];
  const col = (name: string) => head.indexOf(name);
  const iFirst = col("First Name");
  const iLast = col("Last Name");
  const iOrg = col("Organization Name");
  const iLabels = col("Labels");
  const phoneCols = head.map((h, i) => (/^Phone \d+ - Value$/.test(h) ? i : -1)).filter((i) => i >= 0);

  const byNumber = new Map<string, Person>();
  const usedIds = new Set<string>();
  for (const r of rows.slice(1)) {
    const name = [r[iFirst], r[iLast]].map((x) => x?.trim()).filter(Boolean).join(" ") || r[iOrg]?.trim() || "";
    const base = slug(name);
    if (!base) continue;
    const numbers = new Set<string>();
    for (const i of phoneCols) {
      for (const part of (r[i] ?? "").split(":::")) {
        const n = normalizePhone(part);
        if (n) numbers.add(n);
      }
    }
    if (numbers.size === 0) continue;
    let id = `person_${base}`;
    for (let k = 2; usedIds.has(id); k++) id = `person_${base}_${k}`;
    usedIds.add(id);
    const labels = (r[iLabels] ?? "")
      .split(":::")
      .map((l) => l.trim())
      .filter((l) => l && !NOISE_LABELS.test(l))
      .map((l) => l.replace(/^\*\s*/, "").toLowerCase());
    const person: Person = { id, labels: [...new Set(labels)] };
    for (const n of numbers) if (!byNumber.has(n)) byNumber.set(n, person);
  }
  return byNumber;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Newer Google exports put a narrow no-break space (U+202F) before AM/PM; treat all such spaces as plain spaces. */
const plainSpaces = (s: string): string => s.replace(/[\u00A0\u2007\u2009\u202F]/g, " ").trim();

function parseWhen(date: string, time: string, offsetMin: number): number | null {
  const d = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(plainSpaces(date));
  const t = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(plainSpaces(time));
  if (!d || !t) return null;
  const month = MONTHS.indexOf(d[1]!);
  if (month < 0) return null;
  let h = Number(t[1]) % 12;
  if (t[3] === "PM") h += 12;
  return Date.UTC(Number(d[3]), month, Number(d[2]), h, Number(t[2])) - offsetMin * 60_000;
}

const parseDuration = (s: string): number => {
  const p = s.split(":").map(Number);
  return p.length && p.every(Number.isFinite) ? p.reduce((a, b) => a * 60 + b, 0) : 0;
};

const TYPES: Record<string, { type: "call" | "text"; direction: "in" | "out" | "missed" }> = {
  "incoming call": { type: "call", direction: "in" },
  "outgoing call": { type: "call", direction: "out" },
  "missed call": { type: "call", direction: "missed" },
  "received text": { type: "text", direction: "in" },
  "sent text": { type: "text", direction: "out" },
};

export interface CommsResult {
  rows: number;
  inserted: number;
  duplicate: number;
  automated: number;
  unknownDuplicates: number;
  malformed: number;
  matchedToContact: number;
  anonymous: number;
}

interface Ev {
  id: string;
  ts: number;
  payload: Record<string, unknown>;
}

export function backfillComms(db: ExocortexDatabase, fiCsv: string, contactsCsv: string, salt: string): CommsResult {
  if (salt.length < 16) throw new Error("salt must be at least 16 characters");
  const contacts = loadContacts(contactsCsv);
  const rows = parseCsv(fiCsv);
  const head = rows[0] ?? [];
  const off = /\(([+-])(\d{2}):(\d{2})\)/.exec(head[0] ?? "");
  const offsetMin = off ? (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : 0;

  const anon = (n: string) => `anon_${createHmac("sha256", salt).update(n).digest("hex").slice(0, 12)}`;
  const result: CommsResult = {
    rows: Math.max(0, rows.length - 1),
    inserted: 0,
    duplicate: 0,
    automated: 0,
    unknownDuplicates: 0,
    malformed: 0,
    matchedToContact: 0,
    anonymous: 0,
  };

  // Calls that carry a number; an "Unknown" call with the same minute/type/duration is the carrier's twin row.
  const numberedCalls = new Set<string>();
  for (const r of rows.slice(1)) {
    const t = TYPES[(r[3] ?? "").toLowerCase()];
    if (t?.type === "call" && r[2] !== "Unknown") numberedCalls.add([r[0], r[1], r[3], r[4]].join("|"));
  }

  const events: Ev[] = [];
  const seen = new Map<string, number>();
  for (const r of rows.slice(1)) {
    const t = TYPES[(r[3] ?? "").toLowerCase()];
    const ts = parseWhen(r[0] ?? "", r[1] ?? "", offsetMin);
    if (!t || ts === null) {
      result.malformed++;
      continue;
    }
    const raw = (r[2] ?? "").trim();
    if (raw === "Unknown" && t.type === "call" && numberedCalls.has([r[0], r[1], r[3], r[4]].join("|"))) {
      result.unknownDuplicates++;
      continue;
    }
    const parts = raw === "Unknown" || raw === "" ? [] : raw.split(",").map((x) => x.trim());
    const isAutomated = parts.some((p) => /^[0-9a-f]{32}$/i.test(p) || (/^\d+$/.test(p) && p.length < 10 && p !== "911"));
    if (isAutomated) {
      result.automated++;
      continue;
    }
    const people = parts.length
      ? parts.map((p) => {
          const n = normalizePhone(p);
          const known = n ? contacts.get(n) : undefined;
          if (known) result.matchedToContact++;
          else result.anonymous++;
          return known ? { id: known.id, labels: known.labels } : { id: n ? anon(n) : "anon_unparsed", labels: [] as string[] };
        })
      : [{ id: "anon_unknown", labels: [] as string[] }];

    const key = [r[0], r[1], raw, r[3], r[4]].join("|");
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    const local = new Date(ts + offsetMin * 60_000);
    events.push({
      id: `comms:${createHash("sha256").update(`${key}#${nth}`).digest("hex").slice(0, 32)}`,
      ts,
      payload: {
        origin: "comms-backfill",
        past: true,
        type: t.type,
        direction: t.direction,
        duration_s: t.type === "call" ? parseDuration(r[4] ?? "") : null,
        people: people.map((p) => p.id),
        labels: [...new Set(people.flatMap((p) => p.labels))].sort(),
        group: people.length > 1,
        local_hour: local.getUTCHours(),
        local_dow: local.getUTCDay(),
      },
    });
  }

  events.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  if (!db.getDevice(COMMS_DEVICE_ID)) {
    db.registerDevice({
      device_id: COMMS_DEVICE_ID,
      name: "Fi call/text backfill (past events only)",
      platform: "windows",
      pubkey_spki: new Uint8Array(0),
      key_attested: 0,
      scopes: ["past:write"],
      enrolled_at: Date.now(),
    });
  }
  db.withTransaction(() => {
    for (const e of events) {
      const { status } = db.ingestEvent(COMMS_DEVICE_ID, {
        event_id: e.id,
        kind: PAST_KIND,
        schema_ver: 1,
        ts_device: e.ts,
        payload: e.payload,
      });
      if (status === "inserted") result.inserted++;
      else result.duplicate++;
    }
  });
  return result;
}

export const readText = (p: string): string => readFileSync(p, "utf8").replace(/^﻿/, "");
