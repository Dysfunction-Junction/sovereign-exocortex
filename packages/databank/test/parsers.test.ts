import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Databank, type Embedder } from "../databank.js";
import { DatabankKeys } from "../crypto.js";
import {
  parseTakeoutLocation,
  parseTakeoutLocationPath,
} from "../parsers/takeout-location.js";
import {
  parseJoinSms,
  parseJoinSmsPath,
} from "../parsers/join-sms.js";
import {
  parseHealthConnect,
  parseHealthConnectPath,
} from "../parsers/health-connect.js";

class SimpleEmbedder implements Embedder {
  readonly model = "mock-embedder";
  async embedQuery(text: string): Promise<number[] | null> {
    return new Array(64).fill(0.1);
  }
  async embedDocuments(texts: string[]): Promise<(number[] | null)[]> {
    return texts.map(() => new Array(64).fill(0.1));
  }
}

describe("Domain Parsers", () => {
  let root: string;
  let bank: Databank;
  const keys = new DatabankKeys(Buffer.alloc(32, 7));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dbk-parsers-"));
    Databank.provision(root, "test-vault");
    bank = Databank.open({ root, keys, embedder: new SimpleEmbedder(), skipVaultCheck: true });
  });

  afterEach(() => {
    bank.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("Google Takeout Location Parser", () => {
    it("parses placeVisit and activitySegment from Semantic Location History", async () => {
      const mockTakeout = {
        timelineObjects: [
          {
            placeVisit: {
              location: {
                latitudeE7: 374219999,
                longitudeE7: -1220840575,
                placeId: "ChIJ2eUgeAK6j4ARbn5u_wAGqWA",
                address: "1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA",
                name: "Googleplex",
                semanticType: "TYPE_WORK",
              },
              duration: {
                startTimestamp: "2023-05-15T16:30:00Z",
                endTimestamp: "2023-05-15T18:45:00Z",
              },
              placeConfidence: "HIGH_CONFIDENCE",
            },
          },
          {
            activitySegment: {
              startLocation: {
                latitudeE7: 374219999,
                longitudeE7: -1220840575,
              },
              endLocation: {
                latitudeE7: 374230000,
                longitudeE7: -1220850000,
              },
              duration: {
                startTimestamp: "2023-05-15T18:45:00Z",
                endTimestamp: "2023-05-15T19:15:00Z",
              },
              distance: 1850,
              activityType: "WALKING",
              confidence: "HIGH",
            },
          },
        ],
      };

      const items = parseTakeoutLocation(mockTakeout, { device: "SM-S26U" });
      assert.equal(items.length, 2);

      // 1. placeVisit verification
      const visit = items[0];
      assert.equal(visit.kind, "event");
      assert.equal(visit.source, "google-takeout-location");
      assert.equal(visit.title, "Visit: Googleplex");
      assert.ok(visit.text.includes("Location visit: Googleplex"));
      assert.ok(visit.text.includes("1600 Amphitheatre Pkwy"));
      assert.ok(visit.text.includes("37.422000, -122.084058"));

      const visitMeta = visit.meta as Record<string, unknown>;
      assert.equal(visitMeta.eventType, "placeVisit");
      assert.equal(visitMeta.device, "SM-S26U");
      assert.equal(visitMeta.placeConfidence, "HIGH_CONFIDENCE");
      assert.deepEqual(visitMeta.coordinates, [37.4219999, -122.0840575]);
      assert.ok(Array.isArray(visitMeta.tags));
      assert.ok((visitMeta.tags as string[]).includes("location"));
      assert.ok((visitMeta.tags as string[]).includes("visit"));
      assert.ok((visitMeta.tags as string[]).includes("Googleplex"));
      assert.ok((visitMeta.tags as string[]).includes("SM-S26U"));
      assert.deepEqual(visitMeta.temporal, {
        year: 2023,
        month: 5,
        dateStr: "2023-05-15",
        isoTimestamp: "2023-05-15T16:30:00.000Z",
      });

      // 2. activitySegment verification
      const activity = items[1];
      assert.equal(activity.kind, "event");
      assert.equal(activity.source, "google-takeout-location");
      assert.equal(activity.title, "Activity: Walking");
      assert.ok(activity.text.includes("Activity: Walking"));
      assert.ok(activity.text.includes("1.85 km"));

      const actMeta = activity.meta as Record<string, unknown>;
      assert.equal(actMeta.eventType, "activitySegment");
      assert.equal(actMeta.activityType, "WALKING");
      assert.equal(actMeta.distanceMeters, 1850);
      assert.equal(actMeta.device, "SM-S26U");
      assert.ok((actMeta.tags as string[]).includes("walking"));
      assert.ok((actMeta.tags as string[]).includes("activity"));

      // Ingest both items into Databank
      for (const item of items) {
        const res = await bank.ingestText(item);
        assert.ok(res.itemId);
      }

      // Verify search finds placeVisit
      const hits = await bank.search("Googleplex Amphitheatre", { kind: "event" });
      assert.ok(hits.length > 0);
      assert.equal(hits[0].title, "Visit: Googleplex");
    });

    it("parses raw location pings from Records.json", async () => {
      const mockRecords = {
        locations: [
          {
            timestamp: "2023-06-01T12:00:00Z",
            latitudeE7: 407128000,
            longitudeE7: -740060000,
            accuracy: 12,
            source: "WIFI",
          },
        ],
      };

      const items = parseTakeoutLocation(mockRecords, { device: "Note9" });
      assert.equal(items.length, 1);
      assert.equal(items[0].kind, "event");
      assert.equal(items[0].source, "google-takeout-location");
      assert.ok(items[0].text.includes("Location Ping: 40.712800, -74.006000"));
      assert.equal((items[0].meta as Record<string, unknown>).device, "Note9");
    });

    it("parses Takeout JSON files from disk", async () => {
      const filePath = join(root, "takeout-mock.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          timelineObjects: [
            {
              placeVisit: {
                location: { name: "Central Park", latitudeE7: 407850910, longitudeE7: -739682850 },
                duration: { startTimestamp: "2023-07-04T18:00:00Z", endTimestamp: "2023-07-04T20:00:00Z" },
              },
            },
          ],
        })
      );

      const items = await parseTakeoutLocationPath(filePath);
      assert.equal(items.length, 1);
      assert.equal(items[0].title, "Visit: Central Park");
      assert.equal(items[0].path, filePath);
    });
  });

  describe("Join SMS Parser", () => {
    it("parses Join SMS export and formats conversation transcript bubbles", async () => {
      const mockSmsExport = {
        device: "SM-S26U",
        messages: [
          {
            sender: "Alice",
            senderNumber: "+15551234567",
            recipient: "Me",
            recipientNumber: "+15559876543",
            body: "Are you free for lunch today?",
            date: 1684168200000, // 2023-05-15 16:30:00 UTC
            type: 1, // incoming
          },
          {
            sender: "Me",
            senderNumber: "+15559876543",
            recipient: "Alice",
            recipientNumber: "+15551234567",
            body: "Yes! Let's meet at 12:30 at the diner.",
            date: 1684168320000, // 2023-05-15 16:32:00 UTC
            type: 2, // outgoing
          },
        ],
      };

      const items = parseJoinSms(mockSmsExport);
      assert.equal(items.length, 1);

      const conv = items[0];
      assert.equal(conv.kind, "conversation");
      assert.equal(conv.source, "join-sms");
      assert.equal(conv.title, "SMS with Alice");
      assert.ok(conv.text.includes("SMS with Alice"));
      assert.ok(conv.text.includes("[2023-05-15 16:30:00 UTC] Alice: Are you free for lunch today?"));
      assert.ok(conv.text.includes("[2023-05-15 16:32:00 UTC] Me: Yes! Let's meet at 12:30 at the diner."));

      const meta = conv.meta as Record<string, unknown>;
      assert.equal(meta.contact, "Alice");
      assert.equal(meta.messageCount, 2);
      assert.equal(meta.device, "SM-S26U");
      assert.ok(Array.isArray(meta.tags));
      assert.ok((meta.tags as string[]).includes("sms"));
      assert.ok((meta.tags as string[]).includes("message"));
      assert.ok((meta.tags as string[]).includes("Alice"));
      assert.ok((meta.tags as string[]).includes("SM-S26U"));
      assert.ok(Array.isArray(meta.entities));
      assert.ok((meta.entities as string[]).includes("Alice"));
      assert.ok((meta.entities as string[]).includes("Me"));
      assert.deepEqual(meta.temporal, {
        year: 2023,
        month: 5,
        dateStr: "2023-05-15",
        isoTimestamp: "2023-05-15T16:30:00.000Z",
      });

      // Ingest and search
      const res = await bank.ingestText(conv);
      assert.ok(res.itemId);

      const hits = await bank.search("diner lunch", { kind: "conversation" });
      assert.ok(hits.length > 0);
      assert.equal(hits[0].title, "SMS with Alice");
    });

    it("parses individual messages when groupBy: 'message' is selected", () => {
      const single = {
        name: "Bob",
        address: "+15550001111",
        body: "Code is deployed.",
        date: "2023-08-10T10:00:00Z",
        type: 1,
        deviceName: "Note9",
      };

      const items = parseJoinSms(single, { groupBy: "message" });
      assert.equal(items.length, 1);
      assert.equal(items[0].kind, "conversation");
      assert.equal(items[0].title, "SMS with Bob");
      assert.ok(items[0].text.includes("Code is deployed."));
      assert.equal((items[0].meta as Record<string, unknown>).device, "Note9");
    });
  });

  describe("Android Health Connect Parser", () => {
    it("aggregates JSON records into daily summaries", async () => {
      const mockHealth = {
        device: "SM-S26U",
        records: [
          {
            recordType: "Steps",
            count: 4200,
            startTime: "2023-05-15T09:00:00Z",
            endTime: "2023-05-15T12:00:00Z",
          },
          {
            recordType: "Steps",
            count: 6232,
            startTime: "2023-05-15T13:00:00Z",
            endTime: "2023-05-15T21:00:00Z",
          },
          {
            recordType: "SleepSession",
            title: "Night Sleep",
            startTime: "2023-05-14T23:15:00Z",
            endTime: "2023-05-15T07:00:00Z",
            stages: [
              { stage: "DEEP", durationMinutes: 90 },
              { stage: "REM", durationMinutes: 120 },
              { stage: "LIGHT", durationMinutes: 255 },
            ],
          },
          {
            recordType: "ExerciseSession",
            exerciseType: "RUNNING",
            title: "Morning Trail Run",
            startTime: "2023-05-15T07:30:00Z",
            endTime: "2023-05-15T08:15:00Z",
            calories: 420,
            distanceMeters: 5200,
          },
        ],
      };

      const items = parseHealthConnect(mockHealth);
      assert.equal(items.length, 1);

      const summary = items[0];
      assert.equal(summary.kind, "note");
      assert.equal(summary.source, "health-connect");
      assert.equal(summary.title, "Health Summary for 2023-05-15");
      assert.ok(summary.text.includes("Steps: 10,432 steps"));
      assert.ok(summary.text.includes("Sleep Duration: 7h 45m"));
      assert.ok(summary.text.includes("RUNNING (45m), 420 kcal, 5.20 km"));

      const meta = summary.meta as Record<string, unknown>;
      assert.equal(meta.date, "2023-05-15");
      assert.equal(meta.steps, 10432);
      assert.equal(meta.device, "SM-S26U");
      assert.ok(Array.isArray(meta.tags));
      assert.ok((meta.tags as string[]).includes("health"));
      assert.ok((meta.tags as string[]).includes("daily-summary"));
      assert.ok((meta.tags as string[]).includes("steps"));
      assert.ok((meta.tags as string[]).includes("sleep"));
      assert.ok((meta.tags as string[]).includes("exercise"));
      assert.ok((meta.tags as string[]).includes("SM-S26U"));

      const entities = meta.entities as string[];
      assert.ok(entities.includes("Health Connect"));
      assert.ok(entities.includes("Steps"));
      assert.ok(entities.includes("Sleep"));
      assert.ok(entities.includes("RUNNING"));

      assert.deepEqual(meta.temporal, {
        year: 2023,
        month: 5,
        dateStr: "2023-05-15",
        isoTimestamp: "2023-05-15T00:00:00.000Z",
      });

      // Ingest and search
      const res = await bank.ingestText(summary);
      assert.ok(res.itemId);

      const hits = await bank.search("Trail Run 10432 steps", { kind: "note" });
      assert.ok(hits.length > 0);
      assert.equal(hits[0].title, "Health Summary for 2023-05-15");
    });

    it("parses CSV export from Health Connect", async () => {
      const csv = `Date,Steps,Sleep Duration,Exercise,Calories,Device
2023-06-20,8540,7.2,Cycling 40m,350,Note9
2023-06-21,11200,8.0,Walking 30m,220,Note9`;

      const items = parseHealthConnect(csv);
      assert.equal(items.length, 2);

      assert.equal(items[0].title, "Health Summary for 2023-06-20");
      assert.equal((items[0].meta as Record<string, unknown>).steps, 8540);
      assert.equal((items[0].meta as Record<string, unknown>).device, "Note9");

      assert.equal(items[1].title, "Health Summary for 2023-06-21");
      assert.equal((items[1].meta as Record<string, unknown>).steps, 11200);
    });

    it("parses Health Connect JSON and CSV files from disk", async () => {
      const jsonFile = join(root, "health.json");
      writeFileSync(
        jsonFile,
        JSON.stringify({
          steps: [{ count: 9000, date: "2023-09-01" }],
        })
      );

      const items = await parseHealthConnectPath(jsonFile);
      assert.equal(items.length, 1);
      assert.equal(items[0].title, "Health Summary for 2023-09-01");
      assert.equal((items[0].meta as Record<string, unknown>).steps, 9000);
    });
  });

  describe("Schema Migration v1 -> v2", () => {
    it("migrates existing schema v1 database with restricted CHECK constraint", async () => {
      const v1Root = mkdtempSync(join(tmpdir(), "dbk-v1-"));
      Databank.provision(v1Root, "v1-vault");
      mkdirSync(join(v1Root, "index"), { recursive: true });
      const db = new DatabaseSync(join(v1Root, "index", "databank.db"));

      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        INSERT INTO meta(key, value) VALUES ('schema_version', '1');
        CREATE TABLE items (
          item_id     TEXT PRIMARY KEY,
          source      TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('memory','document','photo','video','audio','text','other')),
          title       TEXT NOT NULL,
          path        TEXT NOT NULL DEFAULT '',
          mime        TEXT NOT NULL DEFAULT '',
          size        INTEGER NOT NULL DEFAULT 0,
          ts          INTEGER NOT NULL,
          blob_id     TEXT,
          meta        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
          tier        TEXT NOT NULL DEFAULT 'archived' CHECK (tier IN ('hot','archived')),
          ingested_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX items_kind_ts ON items(kind, ts);
        CREATE INDEX items_source ON items(source);
        CREATE INDEX items_blob ON items(blob_id);

        CREATE TABLE chunks (
          chunk_id INTEGER PRIMARY KEY,
          item_id  TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
          ord      INTEGER NOT NULL,
          text     TEXT NOT NULL,
          UNIQUE (item_id, ord)
        ) STRICT;
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          text, content='chunks', content_rowid='chunk_id', tokenize='porter unicode61'
        );
        CREATE TABLE vectors (
          chunk_id INTEGER PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
          model    TEXT NOT NULL,
          dim      INTEGER NOT NULL CHECK (dim > 0),
          scale    REAL NOT NULL,
          q8       BLOB NOT NULL
        ) STRICT;
        CREATE TABLE ingest_log (
          seq       INTEGER PRIMARY KEY AUTOINCREMENT,
          ts        INTEGER NOT NULL,
          action    TEXT NOT NULL,
          item_id   TEXT NOT NULL,
          prev_hash TEXT NOT NULL,
          hash      TEXT NOT NULL
        ) STRICT;

        INSERT INTO items(item_id, source, kind, title, path, mime, size, ts, meta, tier, ingested_at)
        VALUES ('v1_item', 'test', 'memory', 'Legacy Memory', '', 'text/plain', 10, 1000, '{}', 'archived', 1000);
      `);
      db.close();

      const v1Bank = Databank.open({
        root: v1Root,
        keys: new DatabankKeys(Buffer.alloc(32, 9)),
        embedder: new SimpleEmbedder(),
        skipVaultCheck: true,
      });

      const legacy = v1Bank.getItem("v1_item");
      assert.ok(legacy);
      assert.equal(legacy?.title, "Legacy Memory");

      const eventRes = await v1Bank.ingestText({
        kind: "event",
        source: "google-takeout-location",
        title: "Test Event",
        text: "Visiting Somewhere",
      });
      assert.ok(eventRes.itemId);

      const convRes = await v1Bank.ingestText({
        kind: "conversation",
        source: "join-sms",
        title: "SMS with Alice",
        text: "Hello",
      });
      assert.ok(convRes.itemId);

      const noteRes = await v1Bank.ingestText({
        kind: "note",
        source: "health-connect",
        title: "Health Summary",
        text: "Steps: 1000",
      });
      assert.ok(noteRes.itemId);

      v1Bank.close();
      rmSync(v1Root, { recursive: true, force: true });
    });
  });
});
