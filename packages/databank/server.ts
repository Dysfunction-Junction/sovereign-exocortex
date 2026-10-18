/**
 * @file server.ts
 * Minimal authenticated HTTP API in front of the databank. Bind it to loopback and let
 * Tailscale Serve provide the tailnet HTTPS.
 *
 *   GET  /                            -> search UI (public shell; token is typed into the page)
 *   GET  /health                      -> {ok, items}
 *   POST /search  {q, k?, kind?, source?, since?, until?}
 *   GET  /item/:id
 *   GET  /blob/:id                    -> decrypted bytes (id = 64 hex chars)
 *   POST /ingest/text {source, kind, title, text, path?, ts?, meta?}
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isBlobId } from "./blobstore.js";
import type { Databank, ItemKind } from "./databank.js";
import { UI_HTML } from "./ui.js";

const KINDS = new Set(["memory", "document", "photo", "video", "audio", "text", "other"]);
const MAX_BODY = 4 * 1024 * 1024;

export interface ServerOptions {
  token: string;
}

export function createDatabankServer(bank: Databank, opts: ServerOptions): Server {
  if (!opts.token || opts.token.length < 16) throw new Error("DATABANK_TOKEN must be at least 16 characters");
  const want = Buffer.from(opts.token);

  const authorized = (req: IncomingMessage): boolean => {
    const h = req.headers.authorization ?? "";
    if (!h.startsWith("Bearer ")) return false;
    const got = Buffer.from(h.slice(7));
    return got.length === want.length && timingSafeEqual(got, want);
  };

  return createServer((req, res) => {
    handle(bank, req, res, authorized(req)).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.destroy();
      console.error("[databank] request failed:", err instanceof Error ? err.message : err);
    });
  });
}

async function handle(bank: Databank, req: IncomingMessage, res: ServerResponse, ok: boolean): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const method = req.method ?? "GET";
  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(UI_HTML);
    return;
  }
  if (!ok) return json(res, 401, { error: "unauthorized" });

  if (method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, ...bank.stats() });

  if (method === "POST" && url.pathname === "/search") {
    const b = await readJson(req);
    if (!b || typeof b.q !== "string" || b.q.length === 0 || b.q.length > 1000) return json(res, 400, { error: "q required" });
    if (b.kind !== undefined && !KINDS.has(String(b.kind))) return json(res, 400, { error: "invalid kind" });
    const hits = await bank.search(b.q, {
      k: typeof b.k === "number" ? b.k : undefined,
      kind: b.kind as ItemKind | undefined,
      source: typeof b.source === "string" ? b.source : undefined,
      since: typeof b.since === "number" ? b.since : undefined,
      until: typeof b.until === "number" ? b.until : undefined,
    });
    return json(res, 200, { hits });
  }

  const item = /^\/item\/([0-9a-f]{32})$/.exec(url.pathname);
  if (method === "GET" && item) {
    const row = bank.getItem(item[1]);
    return row ? json(res, 200, row) : json(res, 404, { error: "not found" });
  }

  const blob = /^\/blob\/([0-9a-f]{64})$/.exec(url.pathname);
  if (method === "GET" && blob) {
    const id = blob[1];
    if (!isBlobId(id) || !(await bank.blobs.has(id))) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
    const stream = bank.blobs.get(id);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }

  if (method === "POST" && url.pathname === "/ingest/text") {
    const b = await readJson(req);
    if (!b || typeof b.source !== "string" || typeof b.title !== "string" || typeof b.text !== "string" || !KINDS.has(String(b.kind))) {
      return json(res, 400, { error: "source, kind, title, text required" });
    }
    const r = await bank.ingestText({
      source: b.source,
      kind: b.kind as ItemKind,
      title: b.title,
      text: b.text,
      path: typeof b.path === "string" ? b.path : undefined,
      ts: typeof b.ts === "number" ? b.ts : undefined,
      meta: b.meta && typeof b.meta === "object" && !Array.isArray(b.meta) ? (b.meta as Record<string, unknown>) : undefined,
    });
    return json(res, 200, r);
  }

  return json(res, 404, { error: "not found" });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const cl = Number(req.headers["content-length"]);
  if (Number.isFinite(cl) && cl > MAX_BODY) return null;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
