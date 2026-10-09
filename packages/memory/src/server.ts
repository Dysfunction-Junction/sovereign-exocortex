/**
 * Pieces For All - Local Gateway Server
 *
 * Exposes a local HTTP API strictly on 127.0.0.1:
 * - GET  /health : Reports PiecesOS connectivity and reasoning readiness (never echoes keys)
 * - POST /ask    : Gathers memory context from PiecesOS and invokes the selected reasoning provider
 *
 * Security & Reliability Features:
 * - Strict Host & Origin validation (guards against browser DNS-rebinding and cross-origin attacks)
 * - Optional Gateway Token authentication (GATEWAY_TOKEN env)
 * - Strict Content-Type enforcement (blocks simple text/plain CORS bypasses)
 * - Streaming body byte-cap with HTTP 413
 * - Client disconnect propagation (aborts downstream inference to conserve user credits)
 * - Safe request lifecycle handling preventing unhandled rejections
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { OpenRouterClient, OpenRouterError, sanitizeDiagnostics } from "./openrouter.js";
import { PiecesClient, ContextResult, combineSignals } from "./pieces.js";
import { loadEnv } from "./env.js";
import { ReasoningClient, resolveReasoningClient } from "./reasoning.js";
import {
  appendMemoryLog,
  buildMemoryPrompt,
  DEFAULT_MEMORY_LOG,
  formatPiecesMaterial,
  parseDistilledMemories,
  RECENT_CAPTURE_QUERY,
} from "./memories.js";
import { localLTM } from "./local-ltm.js";

function safeCompareTokens(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const DEFAULT_PORT = 39400;
export const DEFAULT_HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 64 * 1024; // 64 KB limit
export const MAX_QUERY_LENGTH = 4000;
export const MAX_MODEL_NAME_LENGTH = 128;
export const MAX_CONCURRENT_INFERENCES = 5;

// Load .env automatically if present
loadEnv();

export interface ServerConfig {
  port?: number;
  host?: string;
  piecesClient?: PiecesClient;
  openRouterClient?: OpenRouterClient;
  reasoningClient?: ReasoningClient;
  gatewayToken?: string;
  memoryLogPath?: string;
  saveMemoriesToPieces?: boolean;
}

export interface AskRequestBody {
  query?: string;
  model?: string;
}

function getSafeCorsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Gateway-Token",
    "Vary": "Origin",
  };

  if (!origin) return headers;

  // Only reflect loopback origins
  try {
    const url = new URL(origin);
    if (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    ) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
  } catch {
    // Malformed origin: do not reflect
  }

  return headers;
}

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
  origin?: string
): void {
  if (res.headersSent) return;

  const json = JSON.stringify(data, null, 2);
  const corsHeaders = getSafeCorsHeaders(origin);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...corsHeaders,
  });
  res.end(json);
}

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // Direct CLI/curl or non-browser requests have no Origin
  try {
    const parsed = new URL(origin);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const hostWithoutPort = hostHeader.split(":")[0]?.toLowerCase();
  return (
    hostWithoutPort === "127.0.0.1" ||
    hostWithoutPort === "localhost" ||
    hostWithoutPort === "::1" ||
    hostHeader.startsWith("[::1]")
  );
}

export function buildGroundedPrompt(query: string, context: ContextResult): { systemPrompt: string; userPrompt: string } {
  if (context.piecesAvailable && context.snippets.length > 0) {
    const systemPrompt = [
      "You are a helpful assistant answering the user's question using their personal PiecesOS local memory.",
      "Ground your response in the provided notes and cite the source note titles or numbers when referencing facts.",
      "If the notes do not contain enough information to fully answer the question, state that clearly before providing any supplementary knowledge.",
    ].join(" ");

    const userPrompt = [
      "=== Context Notes from PiecesOS Memory ===",
      context.formattedNotes,
      "=== End Notes ===",
      "",
      `Question: ${query}`,
    ].join("\n");

    return { systemPrompt, userPrompt };
  }

  // Fallback when no notes matched or PiecesOS was offline / degraded
  const statusNote = !context.piecesAvailable
    ? "Note: The user's local PiecesOS instance is currently offline, so no local memory was retrieved."
    : context.retrievalStatus !== "ok"
    ? "Note: PiecesOS is running, but some or all memory retrieval queries failed; absence of retrieved notes is not evidence of absence in memory."
    : "Note: No matching records were found in the user's local PiecesOS memory for this topic.";

  const systemPrompt = [
    "You are a helpful assistant answering the user's question.",
    statusNote,
    "Answer from general knowledge, but clearly state in your response that this answer is not grounded in their saved Pieces memory.",
  ].join(" ");

  const userPrompt = `Question: ${query}`;
  return { systemPrompt, userPrompt };
}

function missingReasoningPayload(reasoning: ReasoningClient): { error: string; code: string } {
  if (reasoning.provider === "claude") {
    return {
      error: "Claude subscription is not signed in. Run `claude` once and log in with the Claude plan you already pay for.",
      code: "MISSING_SUBSCRIPTION",
    };
  }
  if (reasoning.provider === "codex") {
    return {
      error: "ChatGPT subscription is not signed in. Run `codex` once and log in with the ChatGPT plan you already pay for.",
      code: "MISSING_SUBSCRIPTION",
    };
  }
  if (reasoning.provider === "antigravity") {
    return {
      error: "Antigravity is not signed in. Run `agy` once and log in with the Antigravity subscription you already pay for.",
      code: "MISSING_SUBSCRIPTION",
    };
  }
  return {
    error: "OpenRouter API key is not configured. Set OPENROUTER_API_KEY in your environment to enable LLM reasoning.",
    code: "MISSING_API_KEY",
  };
}

function readCappedBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("delegate body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new Error("body stream failed")));
  });
}

function readyMessage(piecesOk: boolean, piecesBaseUrl: string, reasoning: ReasoningClient): string {
  if (!piecesOk) {
    return "PiecesOS is offline on " + piecesBaseUrl + ". Start os_server.exe for local memory context.";
  }
  if (!reasoning.hasCredentials()) {
    return missingReasoningPayload(reasoning).error;
  }
  if (reasoning.billing === "subscription") {
    const plan = reasoning.provider === "claude"
      ? "Claude"
      : reasoning.provider === "codex"
      ? "ChatGPT"
      : "Antigravity";
    return `Pieces For All gateway is fully operational. Reasoning uses your ${plan} subscription.`;
  }
  return "Pieces For All gateway is fully operational.";
}

export function createGatewayApp(config: ServerConfig = {}) {
  const pieces = config.piecesClient ?? new PiecesClient();
  const openRouter = config.openRouterClient ?? new OpenRouterClient();
  const reasoning = config.reasoningClient ?? resolveReasoningClient(openRouter);
  const memoryLogPath = config.memoryLogPath ?? DEFAULT_MEMORY_LOG;
  const saveMemoriesToPieces = config.saveMemoriesToPieces ?? true;
  const gatewayToken = config.gatewayToken !== undefined ? config.gatewayToken : (process.env.GATEWAY_TOKEN ?? process.env.PIECES_GATEWAY_TOKEN);
  const startTime = Date.now();
  let activeInferences = 0;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin;
    const host = req.headers.host;

    // 1. Host Validation (Loopback enforcement)
    if (!isHostAllowed(host)) {
      sendJson(res, 403, { error: "Forbidden: Host must be loopback (127.0.0.1 or localhost)" }, origin);
      return;
    }

    // 2. Origin Validation (CORS enforcement)
    if (!isOriginAllowed(origin)) {
      sendJson(res, 403, { error: "Forbidden: Cross-origin access denied for untrusted origin" }, origin);
      return;
    }

    // 3. Handle CORS preflight
    if (req.method === "OPTIONS") {
      const corsHeaders = getSafeCorsHeaders(origin);
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // 4. Token Authentication Check (if configured). Loopback delegation from
    // the Lubuntu gateway is already authenticated at that front door.
    const remoteAddr = req.socket.remoteAddress ?? "";
    const loopbackDelegate = req.method === "POST"
      && (req.url ?? "").split("?")[0] === "/mishmash/delegate"
      && (remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1")
      && isTrustedDelegateRequest(req.headers, req.socket.localPort);
    if (gatewayToken && gatewayToken.trim().length > 0 && !loopbackDelegate) {
      const authHeader = req.headers.authorization;
      const customToken = req.headers["x-gateway-token"];
      const providedToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : typeof customToken === "string"
        ? customToken.trim()
        : null;

      if (!providedToken || !safeCompareTokens(providedToken, gatewayToken.trim())) {
        sendJson(res, 401, { error: "Unauthorized: Invalid or missing gateway authentication token" }, origin);
        return;
      }
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", `http://${host ?? "127.0.0.1"}`);
    } catch {
      sendJson(res, 400, { error: "Malformed request URL" }, origin);
      return;
    }

    const pathname = parsedUrl.pathname;
    const method = req.method;
    const remote = req.socket.remoteAddress ?? "";
    const fromLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";

    if (method === "POST" && pathname === "/mishmash/delegate") {
      if (!fromLoopback) {
        sendJson(res, 403, { error: "delegate is only accepted from this PC" }, origin);
        return;
      }
      if (!isTrustedDelegateRequest(req.headers, req.socket.localPort)) {
        sendJson(res, 403, { error: "delegate rejects browser-origin or rebound-host requests" }, origin);
        return;
      }
      let raw = "";
      try {
        raw = await readCappedBody(req, 64 * 1024);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "bad body" }, origin);
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch {
        sendJson(res, 400, { error: "invalid JSON" }, origin);
        return;
      }
      // "null", numbers, strings and arrays parse fine but would throw on body.to below.
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, { error: "envelope must be a JSON object" }, origin);
        return;
      }
      if (body.to !== "pieces-for-all" || body.v !== 1) {
        sendJson(res, 400, { error: "envelope is not addressed to pieces-for-all" }, origin);
        return;
      }
      if (body.action !== "ping" && body.action !== "status" && body.action !== "memory") {
        sendJson(res, 400, { error: "pieces-for-all accepts ping, status, or memory" }, origin);
        return;
      }
      const result: Record<string, unknown> = { node: "pieces-for-all", host: "lubuntu", action: body.action };
      if (body.action === "status") {
        const health = await pieces.checkHealth(800);
        result.piecesReachable = health.ok;
      }
      if (body.action === "memory") {
        const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>;
        const subAction = typeof payload.action === "string" ? payload.action.toLowerCase() : "search";

        if (subAction === "add") {
          const allowedCallers = new Set([
            "pieces-android-companion-seamless",
            "autonomous-triad",
            "agent-mesh-mcp",
            "hermes-api",
            "pattern-analyzer",
            "registry-app",
          ]);
          const caller = typeof body.from === "string" ? body.from : "";
          if (!allowedCallers.has(caller)) {
            sendJson(res, 403, { error: `caller '${caller}' is not authorized to write to memory` }, origin);
            return;
          }

          const title = typeof payload.title === "string" ? payload.title.trim() : "";
          const bodyText = typeof payload.body === "string" ? payload.body.trim() : "";
          if (!title || !bodyText || title.length > 200 || bodyText.length > 8000) {
            sendJson(res, 400, { error: "memory.add requires non-empty title (<=200 chars) and body (<=8000 chars)" }, origin);
            return;
          }

          const tags = Array.isArray(payload.tags)
            ? payload.tags.filter((t): t is string => typeof t === "string" && t.length <= 50).slice(0, 20)
            : undefined;

          const added = await localLTM.addMemory({
            title,
            body: bodyText,
            source: caller,
            tags,
          });
          result.memory = added;
          result.status = "added";
        } else if (subAction === "search") {
          const query = typeof payload.query === "string" ? payload.query.trim() : "";
          if (!query || query.length > 500) {
            sendJson(res, 400, { error: "memory.search requires non-empty query (<=500 chars)" }, origin);
            return;
          }
          const rawLimit = payload.limit;
          const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit)
            ? Math.min(Math.max(rawLimit, 1), 50)
            : 5;
          const matches = await localLTM.searchMemories(query, limit);
          result.matches = matches;
          result.query = query;
          result.status = "searched";
        } else {
          sendJson(res, 400, { error: "memory action must be 'add' or 'search'" }, origin);
          return;
        }
      }
      sendJson(res, 200, {
        v: 1,
        inReplyTo: body.id,
        from: "pieces-for-all",
        to: body.from,
        ok: true,
        result,
      }, origin);
      return;
    }

    // GET /health
    if (method === "GET" && (pathname === "/health" || pathname === "/")) {
      const piecesHealth = await pieces.checkHealth();
      const hasKey = openRouter.hasApiKey();
      const model = openRouter.getModel();
      const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const reasoningReady = reasoning.hasCredentials();

      const isHealthy = piecesHealth.ok && reasoningReady;
      const responseData = {
        status: isHealthy ? "ok" : "degraded",
        uptimeSeconds,
        piecesOs: {
          status: piecesHealth.status,
          healthy: piecesHealth.ok,
          baseUrl: pieces.getBaseUrl(),
          version: piecesHealth.version,
          ...(piecesHealth.error ? { error: sanitizeDiagnostics(piecesHealth.error) } : {}),
        },
        openRouter: {
          keyConfigured: hasKey,
          model,
        },
        reasoning: {
          provider: reasoning.provider,
          billing: reasoning.billing,
          ready: reasoningReady,
          model: reasoning.getModel(),
        },
        message: readyMessage(piecesHealth.ok, pieces.getBaseUrl(), reasoning),
      };

      sendJson(res, 200, responseData, origin);
      return;
    }

    // POST /ask
    if (method === "POST" && pathname === "/ask") {
      // Content-Type enforcement (must be application/json)
      const rawContentType = req.headers["content-type"] ?? "";
      const mediaType = rawContentType.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        sendJson(res, 415, { error: "Unsupported Media Type: Content-Type must be application/json" }, origin);
        return;
      }

      // Check Content-Length header immediately to reject oversized uploads without waiting
      const contentLengthHeader = req.headers["content-length"];
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!Number.isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
          res.setHeader("Connection", "close");
          sendJson(res, 413, { error: `Payload Too Large: Request body exceeds maximum limit of ${MAX_BODY_BYTES} bytes` }, origin);
          req.resume();
          return;
        }
      }

      // Stream body with byte limit
      const chunks: Buffer[] = [];
      let byteCount = 0;
      let tooLarge = false;

      const bodyReadError = await new Promise<string | null>((resolve) => {
        req.on("data", (chunk: Buffer) => {
          if (tooLarge) {
            return;
          }
          byteCount += chunk.length;
          if (byteCount > MAX_BODY_BYTES) {
            tooLarge = true;
            res.setHeader("Connection", "close");
            sendJson(res, 413, { error: `Payload Too Large: Request body exceeds maximum limit of ${MAX_BODY_BYTES} bytes` }, origin);
            req.resume();
            return;
          }
          chunks.push(chunk);
        });

        req.on("end", () => {
          resolve(tooLarge ? "too_large" : null);
        });

        req.on("error", () => {
          resolve("stream_error");
        });
      });

      if (bodyReadError === "too_large") {
        return;
      }
      if (bodyReadError === "stream_error") {
        if (!res.headersSent) {
          sendJson(res, 400, { error: "Request body transfer failed" }, origin);
        }
        return;
      }

      // Multibyte-safe UTF-8 decoding
      const body = Buffer.concat(chunks).toString("utf8");

      // Robust JSON Parsing & Object Shape Validation
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON in request body" }, origin);
        return;
      }

      // Reject non-objects (e.g. literal null, numbers, strings, arrays)
      if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
        sendJson(res, 400, { error: "Request body must be a JSON object" }, origin);
        return;
      }

      const parsedBody = rawJson as Record<string, unknown>;

      // Validate 'query' field
      const query = parsedBody.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        sendJson(res, 400, { error: "Field 'query' is required and must be a non-empty string" }, origin);
        return;
      }
      if (query.length > MAX_QUERY_LENGTH) {
        sendJson(res, 400, { error: `Field 'query' exceeds maximum length of ${MAX_QUERY_LENGTH} characters` }, origin);
        return;
      }

      // Validate optional 'model' field
      const requestedModel = parsedBody.model;
      if (requestedModel !== undefined) {
        if (
          typeof requestedModel !== "string" ||
          requestedModel.trim().length === 0 ||
          requestedModel.length > MAX_MODEL_NAME_LENGTH ||
          !/^[a-zA-Z0-9_][a-zA-Z0-9_\-\.\/:]*$/.test(requestedModel.trim())
        ) {
          sendJson(res, 400, { error: "Field 'model' must be a valid model identifier string" }, origin);
          return;
        }

        const allowedModelsRaw = process.env.OPENROUTER_ALLOWED_MODELS;
        if (allowedModelsRaw && allowedModelsRaw.trim().length > 0) {
          const allowedList = allowedModelsRaw.split(",").map((s) => s.trim()).filter(Boolean);
          if (allowedList.length > 0 && !allowedList.includes(requestedModel.trim())) {
            sendJson(res, 400, { error: `Model '${requestedModel.trim()}' is not in the allowed models list` }, origin);
            return;
          }
        }
      }

      // Concurrency Gate - only holds an inference slot during active inference
      if (activeInferences >= MAX_CONCURRENT_INFERENCES) {
        sendJson(res, 429, { error: "Server busy: Maximum concurrent inferences reached. Please retry shortly." }, origin);
        return;
      }
      activeInferences++;

      // Abort controller linked to client connection premature close
      const abortController = new AbortController();
      const onClientClose = () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      };
      res.on("close", onClientClose);

      try {
        if (!reasoning.hasCredentials()) {
          sendJson(res, 503, missingReasoningPayload(reasoning), origin);
          return;
        }

        // Indexed searches are bounded, but a cold PiecesOS library can still take
        // several seconds. Leave room for that plus the OpenRouter round trip.
        const ctxSignal = combineSignals([abortController.signal, AbortSignal.timeout(25_000)]);
        const context = await pieces.gatherContext(query.trim(), { signal: ctxSignal });

        // Prepare prompts for OpenRouter
        const { systemPrompt, userPrompt } = buildGroundedPrompt(query.trim(), context);

        const completion = await reasoning.chat(userPrompt, systemPrompt, {
          model: requestedModel ? (requestedModel as string).trim() : undefined,
          signal: abortController.signal,
        });

        // Determine grounding status: true only if PiecesOS was connected and supplied relevant context with actual content
        const contextSupplied = context.piecesAvailable && context.snippets.length > 0 && context.snippets.some(s => s.content && s.content.trim().length > 0);

        sendJson(res, 200, {
          query: query.trim(),
          answer: completion.content,
          sources: context.snippets,
          contextSupplied,
          grounded: contextSupplied, // Backwards compatible with brief
          piecesConnected: context.piecesAvailable,
          retrievalStatus: context.retrievalStatus,
          model: completion.model,
          usage: completion.usage,
        }, origin);
      } catch (err) {
        if (err instanceof OpenRouterError) {
          // Map upstream 401 or generic upstream API_ERROR to 502 Bad Gateway to avoid colliding with local gateway errors
          const status = (err.status === 401 || err.code === "API_ERROR") ? 502 : err.status;
          const code = err.status === 401 ? "UPSTREAM_AUTH_FAILED" : err.code;
          sendJson(res, status, {
            error: err.message,
            code,
            details: err.details,
          }, origin);
          return;
        }

        sendJson(res, 500, {
          error: "Internal reasoning error while processing query.",
          details: sanitizeDiagnostics(err instanceof Error ? err.message : String(err)),
        }, origin);
      } finally {
        activeInferences--;
        res.removeListener("close", onClientClose);
      }
      return;
    }

    // POST /memorize — local workstream capture to local assets. Never calls /qgpt.
    if (method === "POST" && pathname === "/memorize") {
      if (!reasoning.hasCredentials()) {
        sendJson(res, 503, missingReasoningPayload(reasoning), origin);
        return;
      }
      if (activeInferences >= MAX_CONCURRENT_INFERENCES) {
        sendJson(res, 429, { error: "Server busy: Maximum concurrent inferences reached. Please retry shortly." }, origin);
        return;
      }
      activeInferences++;
      const abortController = new AbortController();
      const onClientClose = () => {
        if (!res.writableEnded) abortController.abort();
      };
      res.on("close", onClientClose);
      try {
        const context = await pieces.gatherContext(RECENT_CAPTURE_QUERY, {
          signal: combineSignals([abortController.signal, AbortSignal.timeout(25_000)]),
        });
        const loggedAt = new Date().toISOString();
        if (!context.piecesAvailable || context.snippets.length === 0) {
          sendJson(res, 200, {
            logged: 0,
            piecesSaved: 0,
            logFile: memoryLogPath,
            route: "local",
            qgpt: false,
            memories: [],
            message: "No local capture events were available to distill.",
          }, origin);
          return;
        }

        const { systemPrompt, userPrompt } = buildMemoryPrompt(context.formattedNotes);
        const completion = await reasoning.chat(userPrompt, systemPrompt, { signal: abortController.signal });
        const distilled = parseDistilledMemories(completion.content);
        const memories: Array<{ title: string; piecesSaved: boolean; assetId?: string; error?: string }> = [];

        for (const memory of distilled) {
          let piecesSaved = false;
          let assetId: string | undefined;
          let error: string | undefined;
          if (saveMemoriesToPieces) {
            const saved = await pieces.createAsset(
              { name: memory.title, content: formatPiecesMaterial(memory, loggedAt) },
              { signal: abortController.signal }
            );
            piecesSaved = saved.ok;
            if (saved.ok) assetId = saved.id;
            else error = saved.error;
          }
          await appendMemoryLog(memoryLogPath, {
            loggedAt,
            title: memory.title,
            body: memory.body,
            piecesSaved,
            piecesError: error,
            eventCount: context.snippets.length,
          });
          memories.push({ title: memory.title, piecesSaved, assetId, error });
        }

        sendJson(res, 200, {
          logged: memories.length,
          piecesSaved: memories.filter((memory) => memory.piecesSaved).length,
          logFile: memoryLogPath,
          route: "local",
          qgpt: false,
          model: completion.model,
          memories,
        }, origin);
      } catch (err) {
        if (err instanceof OpenRouterError) {
          const status = (err.status === 401 || err.code === "API_ERROR") ? 502 : err.status;
          sendJson(res, status, { error: err.message, code: err.status === 401 ? "UPSTREAM_AUTH_FAILED" : err.code }, origin);
          return;
        }
        sendJson(res, 500, {
          error: "Internal error while distilling local capture.",
          details: sanitizeDiagnostics(err instanceof Error ? err.message : String(err)),
        }, origin);
      } finally {
        activeInferences--;
        res.removeListener("close", onClientClose);
      }
      return;
    }

    // 404 for any other route
    sendJson(res, 404, { error: "Not Found", availableRoutes: ["GET /health", "POST /ask", "POST /memorize"] }, origin);
  };

  return { handleRequest, pieces, openRouter, reasoning };
}

/**
 * /mishmash/delegate skips the gateway token for loopback callers, so a loopback peer alone must not be
 * enough: a web page in the user's browser can POST here (Origin set) and a DNS-rebound hostname also
 * arrives from a loopback peer (Host is the attacker's name).
 */
export function isTrustedDelegateRequest(headers: IncomingMessage["headers"], port: number | undefined): boolean {
  if (headers.origin !== undefined) return false;
  if (port === undefined) return false;
  const host = headers.host;
  return (
    typeof host === "string" &&
    [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase())
  );
}

export function startGatewayServer(config: ServerConfig = {}): Promise<{ server: Server; port: number; host: string }> {
  const parsedPort = process.env.PORT ? parseInt(process.env.PORT, 10) : NaN;
  const port = config.port ?? (!Number.isNaN(parsedPort) ? parsedPort : DEFAULT_PORT);
  const host = config.host ?? DEFAULT_HOST;
  const { handleRequest, pieces } = createGatewayApp(config);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[gateway] Top-level request handler rejection:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal Server Error" });
      }
    });
  });

  // headersTimeout limits slow-drip clients. requestTimeout must stay above
  // retrieval (25s) plus a subscription CLI call (60s).
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  server.timeout = 0;

  const gatewayToken = config.gatewayToken !== undefined ? config.gatewayToken : (process.env.GATEWAY_TOKEN ?? process.env.PIECES_GATEWAY_TOKEN);

  return new Promise((resolve, reject) => {
    const onStartupError = (err: Error) => reject(err);
    server.once("error", onStartupError);

    server.listen(port, host, async () => {
      server.removeListener("error", onStartupError);
      server.on("error", (err) => {
        console.error("[pieces-for-all] Server runtime error:", err);
      });

      const addr = server.address();
      const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;

      console.log(`[pieces-for-all] Gateway running at http://${host}:${actualPort}`);
      console.log(`[pieces-for-all] Health: http://${host}:${actualPort}/health`);
      console.log(`[pieces-for-all] Ask:    POST http://${host}:${actualPort}/ask`);

      if (!gatewayToken) {
        console.log("[pieces-for-all] Notice: No GATEWAY_TOKEN configured; loopback callers can access /ask without auth.");
      }

      // Non-blocking readiness poll on startup (up to 3 attempts, 500ms apart)
      pieces.pollReadiness({ maxAttempts: 3, intervalMs: 500, timeoutPerAttemptMs: 1000 })
        .then((isReady) => {
          if (isReady) {
            pieces.checkHealth(1500).then((health) => {
              console.log(`[pieces-for-all] PiecesOS detected online at ${pieces.getBaseUrl()} (version: ${health.version ?? "unknown"})`);
            });
          } else {
            console.log(`[pieces-for-all] Notice: PiecesOS not detected at ${pieces.getBaseUrl()}. Gateway will operate in offline/degraded mode.`);
          }
        })
        .catch(() => {});

      resolve({ server, port: actualPort, host });
    });
  });
}

// Auto-run if executed directly as entry point
const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  startGatewayServer()
    .catch((err) => {
      console.error("[pieces-for-all] Failed to start gateway server:", err);
      process.exit(1);
    });
}
