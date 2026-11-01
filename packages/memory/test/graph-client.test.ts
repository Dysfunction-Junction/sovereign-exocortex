import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { GraphClient, PIECES_GRAPH_MEDIA_TYPE, type PiecesGraphArtifact } from "../graph-client.js";
import { createGatewayApp } from "../server.js";

const CORE_SCHEMA_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../core/schema.sql"),
  "utf8",
);

test("GraphClient maps local records to untrusted hits ordered by links DESC with 300-char cap", async () => {
  const c = new GraphClient({
    records: [
      {
        id: "rec_low",
        kind: "Tags",
        name: "Android tag",
        ref: "ok",
        path: "tags/t1.json",
        created: "",
        links: 2,
      },
      {
        id: "rec_high",
        kind: "Summaries",
        name: "Android Dev",
        ref: "x".repeat(900),
        path: "markdown/a.md",
        created: "2026-10-01T00:00:00Z",
        links: 7,
      },
      {
        id: "rec_other",
        kind: "Websites",
        name: "Unrelated topic",
        ref: "https://example.org",
        path: "websites/w1.json",
        created: "",
        links: 99,
      },
    ],
  });

  const r = await c.search("android", 2);
  assert.equal(r.available, true);
  if (!r.available) return;
  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0]!.kind, "Summaries");
  assert.equal(r.hits[0]!.title, "Android Dev");
  assert.equal(r.hits[0]!.snippet.length, 300);
  assert.equal(r.hits[0]!.links, 7);
  assert.equal(r.hits[0]!.untrusted, true);
  assert.equal(r.hits[1]!.kind, "Tags");
  assert.equal(r.hits[1]!.links, 2);
  assert.equal(r.hits[1]!.untrusted, true);
});

test("GraphClient reads core schema.sql artifacts ordered by latest curation_import seq, refreshes after TTL, and rejects tamper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exo-p5-schema-"));
  try {
    const dbPath = join(dir, "exocortex.db");
    let fakeNow = 1_700_000_000_000;
    const fromEnvClient = GraphClient.fromEnv({ EXOCORTEX_DB_PATH: dbPath });
    assert.ok(fromEnvClient);
    const timedClient = new GraphClient({ sqliteDbPath: dbPath, nowMs: () => fakeNow });

    // Before DB exists -> unreachable (and negative-cached for 5s)
    assert.deepEqual(await timedClient.search("alpha"), { available: false, reason: "unreachable" });

    const db = new DatabaseSync(dbPath);
    let shaV2 = "";
    try {
      db.exec(CORE_SCHEMA_SQL);
      db.prepare(
        "INSERT INTO devices (device_id, name, platform, pubkey_spki, key_attested, scopes, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("host:exocortexd", "Host", "windows", Buffer.alloc(32), 0, '["host:proposal"]', fakeNow);

      const putCanonical = (art: PiecesGraphArtifact, seq: number, prevHashHex: string) => {
        const bytes = Buffer.from(JSON.stringify(art) + "\n", "utf8");
        const digest = createHash("sha256").update(bytes).digest();
        const shaHex = digest.toString("hex");
        db.prepare("INSERT INTO artifacts (sha256, media_type, bytes) VALUES (?, ?, ?)").run(
          digest,
          PIECES_GRAPH_MEDIA_TYPE,
          bytes,
        );
        const payload = JSON.stringify({
          artifact_sha256: shaHex,
          media_type: PIECES_GRAPH_MEDIA_TYPE,
          count: art.nodes.length,
        });
        const evHashHex = createHash("sha256").update(prevHashHex + payload).digest("hex");
        db.prepare(
          "INSERT INTO events (seq, event_id, device_id, kind, ts_device, ts_server, schema_ver, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          seq,
          `curation_import_pieces_graph_${shaHex.slice(0, 16)}`,
          "host:exocortexd",
          "curation_import",
          fakeNow + seq,
          fakeNow + seq,
          1,
          payload,
          Buffer.from(prevHashHex, "hex"),
          Buffer.from(evHashHex, "hex"),
        );
        return { shaHex, evHash: evHashHex };
      };

      const v1 = putCanonical(
        {
          version: 1,
          nodes: [
            {
              id: "doc_v1",
              kind: "Summaries",
              name: "Alpha V1 Summary",
              ref: "first export",
              path: "summaries/v1.json",
              created: "",
              links: 3,
            },
          ],
          relationships: [],
        },
        1,
        "0".repeat(64),
      );

      // Advance past 5s negative backoff -> v1 becomes live without restarting client
      fakeNow += 6_000;
      const resV1 = await timedClient.search("alpha", 5);
      assert.equal(resV1.available, true);
      if (resV1.available) {
        assert.equal(resV1.hits.length, 1);
        assert.equal(resV1.hits[0]!.title, "Alpha V1 Summary");
      }

      const v2 = putCanonical(
        {
          version: 1,
          nodes: [
            {
              id: "doc_v2",
              kind: "Summaries",
              name: "Alpha V2 Updated Summary",
              ref: "second export",
              path: "summaries/v2.json",
              created: "",
              links: 9,
            },
          ],
          relationships: [],
        },
        2,
        v1.evHash,
      );
      shaV2 = v2.shaHex;

      // Within 30s TTL -> cached v1
      fakeNow += 5_000;
      const cachedStillV1 = await timedClient.search("alpha", 5);
      assert.equal(cachedStillV1.available && cachedStillV1.hits[0]?.title, "Alpha V1 Summary");

      // Past 30s TTL -> refreshes to latest seq (v2)
      fakeNow += 30_000;
      const refreshedV2 = await timedClient.search("alpha", 5);
      assert.equal(refreshedV2.available, true);
      if (refreshedV2.available) {
        assert.equal(refreshedV2.hits.length, 1);
        assert.equal(refreshedV2.hits[0]!.title, "Alpha V2 Updated Summary");
        assert.equal(refreshedV2.hits[0]!.links, 9);
      }

      // Simulate disk bit-rot on v2 bytes (dropping insert-only trigger on scratch DB)
      db.exec("DROP TRIGGER IF EXISTS artifacts_no_update; DROP TRIGGER IF EXISTS trg_artifacts_no_update;");
      for (const row of db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'artifacts'")
        .all() as Array<{ name: string }>) {
        db.exec(`DROP TRIGGER "${row.name}";`);
      }
      db.prepare("UPDATE artifacts SET bytes = ? WHERE sha256 = ?").run(
        Buffer.from('{"version":1,"nodes":[]}\n', "utf8"),
        Buffer.from(shaV2, "hex"),
      );
    } finally {
      db.close();
    }

    // Fresh client reading corrupted SQLite blob rejects SHA-256 mismatch with reason: "error"
    const corruptedReader = new GraphClient({ sqliteDbPath: dbPath });
    assert.deepEqual(await corruptedReader.search("alpha"), { available: false, reason: "error" });

    // Malformed non-empty nodes array maps to reason: "error", not empty hits
    const badExportPath = join(dir, "malformed.json");
    writeFileSync(badExportPath, JSON.stringify({ version: 1, nodes: [{ broken: 123 }] }), "utf8");
    const badClient = new GraphClient({ exportPath: badExportPath });
    assert.deepEqual(await badClient.search("alpha"), { available: false, reason: "error" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GraphClient.fromEnv ignores legacy NEO4J_* vars and graph-client.ts imports only allowlisted local modules", () => {
  assert.equal(
    GraphClient.fromEnv({
      NEO4J_URI: "neo4j+s://retired.databases.neo4j.io",
      NEO4J_USERNAME: "neo4j",
      NEO4J_PASSWORD: "secret",
    }),
    null,
  );
  assert.ok(GraphClient.fromEnv({ PIECES_GRAPH_EXPORT_PATH: "./local-export.json" }));
  assert.ok(GraphClient.fromEnv({ EXOCORTEX_DB_PATH: "./local-exocortex.db" }));

  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../graph-client.ts"), "utf8");
  const imports = [...src.matchAll(/^\s*import\s+.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const allowed = new Set(["node:crypto", "node:fs", "node:sqlite"]);
  for (const mod of imports) {
    assert.equal(allowed.has(mod), true, `Disallowed import in graph-client.ts: ${mod}`);
  }
  assert.equal(/\bfetch\s*\(/.test(src), false, "graph-client.ts must contain zero fetch() calls");
});

test("P5-G1: memory.search returns local graph hits when globalThis.fetch throws unconditionally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "exo-p5-gateway-"));
  const originalFetch = globalThis.fetch;
  const originalLtmFile = process.env.LOCAL_LTM_FILE;
  try {
    const ltmPath = join(dir, "memories.jsonl");
    writeFileSync(ltmPath, "", "utf8");
    process.env.LOCAL_LTM_FILE = ltmPath;

    const exportPath = join(dir, "pieces-export.json");
    writeFileSync(
      exportPath,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "pieces_doc_42",
            kind: "Summaries",
            name: "Exocortex World Model Architecture",
            ref: "Ledger-rebuilt graph store replacing Neo4j",
            path: "summaries/42.json",
            created: "2026-10-31T00:00:00Z",
            links: 11,
          },
        ],
        relationships: [],
      }) + "\n",
      "utf8",
    );

    const app = createGatewayApp({
      gatewayToken: "",
      archiveClient: null,
      mem0Client: null,
      graphClient: new GraphClient({ exportPath }),
    });
    const server = createServer((req, res) => {
      void app.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      globalThis.fetch = (async () => {
        throw new Error("Outbound network access forbidden in P5-G1");
      }) as typeof fetch;

      const reqBody = JSON.stringify({
        v: 1,
        id: "0123456789abcdef",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "memory",
        payload: { action: "search", query: "World Model", limit: 5 },
      });

      const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/mishmash/delegate",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(reqBody),
              Host: `127.0.0.1:${port}`,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
            );
          },
        );
        req.on("error", reject);
        req.write(reqBody);
        req.end();
      });

      assert.equal(response.status, 200);
      const body = JSON.parse(response.text) as {
        ok: boolean;
        result?: {
          status?: string;
          graph?: { available: boolean; hits?: Array<{ title: string; untrusted: boolean; links: number }> };
        };
      };
      assert.equal(body.ok, true);
      assert.equal(body.result?.status, "searched");
      assert.equal(body.result?.graph?.available, true);
      assert.equal(body.result?.graph?.hits?.length, 1);
      assert.equal(body.result?.graph?.hits?.[0]?.title, "Exocortex World Model Architecture");
      assert.equal(body.result?.graph?.hits?.[0]?.untrusted, true);
      assert.equal(body.result?.graph?.hits?.[0]?.links, 11);
    } finally {
      globalThis.fetch = originalFetch;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLtmFile === undefined) delete process.env.LOCAL_LTM_FILE;
    else process.env.LOCAL_LTM_FILE = originalLtmFile;
    rmSync(dir, { recursive: true, force: true });
  }
});
