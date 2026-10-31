/**
 * @file parsers/takeout-location.ts
 * Parser for Google Takeout Semantic Location History (Records.json and Semantic Location History).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TextInput } from "../databank.js";

export interface TakeoutParserOptions {
  filePath?: string;
  device?: string;
}

export interface TakeoutPlaceLocation {
  latitudeE7?: number;
  longitudeE7?: number;
  placeId?: string;
  address?: string;
  name?: string;
  semanticType?: string;
  locationConfidence?: number;
}

export interface TakeoutDuration {
  startTimestamp?: string | number;
  endTimestamp?: string | number;
}

export interface TakeoutPlaceVisit {
  location?: TakeoutPlaceLocation;
  duration?: TakeoutDuration;
  placeConfidence?: string | number;
  centerLatE7?: number;
  centerLngE7?: number;
  childVisits?: TakeoutPlaceVisit[];
}

export interface TakeoutActivitySegment {
  startLocation?: { latitudeE7?: number; longitudeE7?: number };
  endLocation?: { latitudeE7?: number; longitudeE7?: number };
  duration?: TakeoutDuration;
  distance?: number | string;
  activityType?: string;
  activities?: Array<{ activityType?: string; probability?: number }>;
  confidence?: string | number;
}

export interface TakeoutTimelineObject {
  placeVisit?: TakeoutPlaceVisit;
  activitySegment?: TakeoutActivitySegment;
}

export interface TakeoutLocationRecord {
  timestamp?: string | number;
  timestampMs?: string | number;
  latitudeE7?: number;
  longitudeE7?: number;
  accuracy?: number;
  source?: string;
  deviceTag?: number | string;
}

export interface ParsedTemporal {
  year: number;
  month: number;
  dateStr: string;
  isoTimestamp: string;
}

export function parseTimestamp(ts: string | number | undefined, fallback?: number): { ms: number; temporal: ParsedTemporal } {
  let ms = fallback ?? Date.now();
  if (typeof ts === "number") {
    ms = ts < 1e11 ? ts * 1000 : ts;
  } else if (typeof ts === "string") {
    const num = Number(ts);
    if (!isNaN(num) && /^\d+$/.test(ts.trim())) {
      ms = num < 1e11 ? num * 1000 : num;
    } else {
      const parsed = Date.parse(ts);
      if (!isNaN(parsed)) ms = parsed;
    }
  }

  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const dateStr = d.toISOString().slice(0, 10);
  const isoTimestamp = d.toISOString();

  return {
    ms,
    temporal: { year, month, dateStr, isoTimestamp },
  };
}

export function e7ToDegrees(e7: number | undefined): number | undefined {
  if (typeof e7 !== "number" || isNaN(e7)) return undefined;
  return Number((e7 / 1e7).toFixed(7));
}

function formatActivityType(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Parses a placeVisit into a Databank TextInput */
export function parsePlaceVisit(
  visit: TakeoutPlaceVisit,
  options?: TakeoutParserOptions
): TextInput[] {
  const items: TextInput[] = [];
  const loc = visit.location ?? {};
  const name = loc.name?.trim() || "";
  const address = loc.address?.trim() || "";
  const placeId = loc.placeId || "";
  const semanticType = loc.semanticType || "";

  const lat = e7ToDegrees(loc.latitudeE7 ?? visit.centerLatE7);
  const lng = e7ToDegrees(loc.longitudeE7 ?? visit.centerLngE7);

  const start = parseTimestamp(visit.duration?.startTimestamp);
  const end = parseTimestamp(visit.duration?.endTimestamp, start.ms);
  const durationMs = Math.max(0, end.ms - start.ms);
  const durationMin = Math.round(durationMs / 60000);
  const placeConfidence = visit.placeConfidence ?? "UNKNOWN";

  const placeName = name || address || "Unknown Location";
  const title = `Visit: ${placeName}`;

  const textLines: string[] = [
    `Location visit: ${placeName}`,
    address && address !== name ? `Address: ${address}` : null,
    lat !== undefined && lng !== undefined ? `Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}` : null,
    `Duration: ${start.temporal.isoTimestamp} to ${end.temporal.isoTimestamp} (${durationMin} min)`,
    placeConfidence ? `Confidence: ${placeConfidence}` : null,
    semanticType ? `Semantic Type: ${semanticType}` : null,
  ].filter((l): l is string => Boolean(l));

  const text = textLines.join("\n");
  const device = options?.device ?? "unknown";

  const tags = Array.from(
    new Set(
      ["location", "visit", name, address, "google-takeout", device !== "unknown" ? device : null]
        .filter((t): t is string => Boolean(t))
    )
  );

  const entities = Array.from(
    new Set([name, address, semanticType].filter((e): e is string => Boolean(e)))
  );

  items.push({
    kind: "event",
    source: "google-takeout-location",
    title,
    text,
    path: options?.filePath ?? "",
    ts: start.ms,
    meta: {
      eventType: "placeVisit",
      location: {
        name,
        address,
        latitude: lat,
        longitude: lng,
        placeId,
        semanticType,
      },
      coordinates: lat !== undefined && lng !== undefined ? [lat, lng] : null,
      duration: {
        startTimestamp: start.temporal.isoTimestamp,
        endTimestamp: end.temporal.isoTimestamp,
        durationMs,
      },
      placeConfidence,
      device,
      tags,
      entities,
      temporal: start.temporal,
    },
  });

  if (Array.isArray(visit.childVisits)) {
    for (const child of visit.childVisits) {
      items.push(...parsePlaceVisit(child, options));
    }
  }

  return items;
}

/** Parses an activitySegment into a Databank TextInput */
export function parseActivitySegment(
  segment: TakeoutActivitySegment,
  options?: TakeoutParserOptions
): TextInput[] {
  const rawType = segment.activityType || segment.activities?.[0]?.activityType || "TRANSIT";
  const activityType = rawType.toUpperCase();
  const readableActivity = formatActivityType(activityType);

  const distanceMeters =
    typeof segment.distance === "number"
      ? segment.distance
      : Number(segment.distance) || 0;

  const start = parseTimestamp(segment.duration?.startTimestamp);
  const end = parseTimestamp(segment.duration?.endTimestamp, start.ms);
  const durationMs = Math.max(0, end.ms - start.ms);
  const durationMin = Math.round(durationMs / 60000);

  const startLat = e7ToDegrees(segment.startLocation?.latitudeE7);
  const startLng = e7ToDegrees(segment.startLocation?.longitudeE7);
  const endLat = e7ToDegrees(segment.endLocation?.latitudeE7);
  const endLng = e7ToDegrees(segment.endLocation?.longitudeE7);

  const title = `Activity: ${readableActivity}`;

  const textLines: string[] = [
    `Activity: ${readableActivity}`,
    distanceMeters > 0
      ? `Distance: ${distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(2)} km` : `${Math.round(distanceMeters)} m`}`
      : null,
    `Duration: ${start.temporal.isoTimestamp} to ${end.temporal.isoTimestamp} (${durationMin} min)`,
    startLat !== undefined && startLng !== undefined && endLat !== undefined && endLng !== undefined
      ? `Route: from [${startLat.toFixed(6)}, ${startLng.toFixed(6)}] to [${endLat.toFixed(6)}, ${endLng.toFixed(6)}]`
      : null,
    segment.confidence ? `Confidence: ${segment.confidence}` : null,
  ].filter((l): l is string => Boolean(l));

  const text = textLines.join("\n");
  const device = options?.device ?? "unknown";

  const tags = Array.from(
    new Set(
      ["location", "activity", activityType.toLowerCase(), "google-takeout", device !== "unknown" ? device : null]
        .filter((t): t is string => Boolean(t))
    )
  );

  const entities = [readableActivity];

  return [
    {
      kind: "event",
      source: "google-takeout-location",
      title,
      text,
      path: options?.filePath ?? "",
      ts: start.ms,
      meta: {
        eventType: "activitySegment",
        activityType,
        distanceMeters,
        duration: {
          startTimestamp: start.temporal.isoTimestamp,
          endTimestamp: end.temporal.isoTimestamp,
          durationMs,
        },
        startLocation: startLat !== undefined && startLng !== undefined ? [startLat, startLng] : null,
        endLocation: endLat !== undefined && endLng !== undefined ? [endLat, endLng] : null,
        confidence: segment.confidence,
        device,
        tags,
        entities,
        temporal: start.temporal,
      },
    },
  ];
}

/** Parses a raw Location History record (Records.json) into a Databank TextInput */
export function parseRawLocationRecord(
  rec: TakeoutLocationRecord,
  options?: TakeoutParserOptions
): TextInput | null {
  const lat = e7ToDegrees(rec.latitudeE7);
  const lng = e7ToDegrees(rec.longitudeE7);
  if (lat === undefined || lng === undefined) return null;

  const tsVal = rec.timestamp ?? rec.timestampMs;
  const time = parseTimestamp(tsVal);
  const accuracy = typeof rec.accuracy === "number" ? rec.accuracy : undefined;
  const source = rec.source || "GPS";
  const device = options?.device ?? (rec.deviceTag ? String(rec.deviceTag) : "unknown");

  const title = `Location Ping at ${time.temporal.dateStr}`;
  const text = [
    `Location Ping: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    `Timestamp: ${time.temporal.isoTimestamp}`,
    accuracy !== undefined ? `Accuracy: ${accuracy}m` : null,
    `Source: ${source}`,
  ]
    .filter((l): l is string => Boolean(l))
    .join("\n");

  const tags = Array.from(
    new Set(["location", "ping", "google-takeout", device !== "unknown" ? device : null].filter(Boolean))
  );

  return {
    kind: "event",
    source: "google-takeout-location",
    title,
    text,
    path: options?.filePath ?? "",
    ts: time.ms,
    meta: {
      eventType: "rawPing",
      coordinates: [lat, lng],
      accuracy,
      source,
      device,
      tags,
      entities: ["Location Ping"],
      temporal: time.temporal,
    },
  };
}

/**
 * Parses Google Takeout Location content (JSON object or string).
 * Handles:
 * - Semantic Location History ({ timelineObjects: [...] })
 * - Direct array of timelineObjects
 * - Records.json ({ locations: [...] })
 */
export function parseTakeoutLocation(
  content: string | Record<string, unknown> | Array<unknown>,
  options?: TakeoutParserOptions
): TextInput[] {
  let data: unknown = content;
  if (typeof content === "string") {
    try {
      data = JSON.parse(content);
    } catch (err) {
      throw new Error(`Failed to parse Takeout Location JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!data || typeof data !== "object") return [];

  const items: TextInput[] = [];

  // Check for timelineObjects
  let timelineObjects: unknown[] = [];
  if (Array.isArray(data)) {
    timelineObjects = data;
  } else if ("timelineObjects" in data && Array.isArray((data as { timelineObjects: unknown[] }).timelineObjects)) {
    timelineObjects = (data as { timelineObjects: unknown[] }).timelineObjects;
  }

  if (timelineObjects.length > 0) {
    for (const obj of timelineObjects) {
      if (!obj || typeof obj !== "object") continue;
      const tObj = obj as TakeoutTimelineObject;
      if (tObj.placeVisit) {
        items.push(...parsePlaceVisit(tObj.placeVisit, options));
      } else if (tObj.activitySegment) {
        items.push(...parseActivitySegment(tObj.activitySegment, options));
      }
    }
    return items;
  }

  // Check for Records.json { locations: [...] }
  if ("locations" in data && Array.isArray((data as { locations: unknown[] }).locations)) {
    for (const loc of (data as { locations: unknown[] }).locations) {
      if (loc && typeof loc === "object") {
        const item = parseRawLocationRecord(loc as TakeoutLocationRecord, options);
        if (item) items.push(item);
      }
    }
    return items;
  }

  return items;
}

async function walkTakeoutDir(
  dir: string,
  items: TextInput[],
  options?: TakeoutParserOptions
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkTakeoutDir(full, items, options);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".json")) {
      try {
        const raw = await readFile(full, "utf8");
        items.push(...parseTakeoutLocation(raw, { ...options, filePath: full }));
      } catch {
        // ignore unparseable files in batch walk
      }
    }
  }
}

/**
 * Parses a Google Takeout Location file or directory recursively.
 */
export async function parseTakeoutLocationPath(
  targetPath: string,
  options?: TakeoutParserOptions
): Promise<TextInput[]> {
  const s = await stat(targetPath);
  if (s.isDirectory()) {
    const items: TextInput[] = [];
    await walkTakeoutDir(targetPath, items, options);
    return items;
  } else {
    const raw = await readFile(targetPath, "utf8");
    return parseTakeoutLocation(raw, { ...options, filePath: targetPath });
  }
}
