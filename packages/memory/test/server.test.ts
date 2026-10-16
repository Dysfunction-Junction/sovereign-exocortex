import "./setup-ltm.js"; // must stay first: redirects memory.add away from the tracked data file
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createGatewayApp } from "../server.js";
import { PiecesClient } from "../pieces.js";
import { OpenRouterClient } from "../openrouter.js";
import type { ReasoningClient } from "../reasoning.js";

// Ensure tests are isolated from host developer .env variables
delete process.env.GATEWAY_TOKEN;
delete process.env.PIECES_GATEWAY_TOKEN;
delete process.env.REASONING_PROVIDER;

function makeLocalRequest(
  server: any,
  options: {
    method: string;
    path: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const postData = options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
      ? JSON.stringify(options.body)
      : undefined;

    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: {
          ...(postData !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
              }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 500, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (postData !== undefined) {
      req.write(postData);
    }
    req.end();
  });
}

test("Server /health - reports 'ok' when PiecesOS is healthy and key is configured", async () => {
  const mockPiecesFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/.well-known/health")) {
      return new Response("ok:uuid", { status: 200 });
    }
    if (urlStr.endsWith("/.well-known/version")) {
      return new Response("12.6.0", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "valid-key-xyz" });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });

  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, { method: "GET", path: "/health" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(res.body.piecesOs.status, "up");
    assert.equal(res.body.piecesOs.healthy, true);
    assert.equal(res.body.openRouter.keyConfigured, true);
    // Invariant: Never echo the key!
    assert.equal(JSON.stringify(res.body).includes("valid-key-xyz"), false);
  } finally {
    srv.close();
  }
});

test("Server /health - reports 'degraded' when PiecesOS is down", async () => {
  const mockPiecesFetch: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:39300");
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "valid-key" });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });

  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, { method: "GET", path: "/health" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "degraded");
    assert.equal(res.body.piecesOs.status, "down");
    assert.equal(res.body.piecesOs.healthy, false);
    assert.match(res.body.message, /PiecesOS is offline/);
  } finally {
    srv.close();
  }
});

test("Server Security - rejects unauthorized Origin with 403 Forbidden", async () => {
  const app = createGatewayApp({ gatewayToken: "" });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "GET",
      path: "/health",
      headers: { Origin: "https://malicious-website.com" },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Forbidden: Cross-origin access denied/);
  } finally {
    srv.close();
  }
});

test("Server Security - allows loopback Origins (127.0.0.1, localhost, [::1]) and reflects CORS header", async () => {
  const mockPiecesFetch: typeof fetch = async () => new Response("ok:uuid", { status: 200 });
  const pieces = new PiecesClient({ fetchFn: mockPiecesFetch });
  const app = createGatewayApp({ gatewayToken: "", piecesClient: pieces });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const origins = ["http://127.0.0.1:3000", "http://localhost:8080", "http://[::1]:5173"];
    for (const origin of origins) {
      const res = await makeLocalRequest(srv, {
        method: "GET",
        path: "/health",
        headers: { Origin: origin },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers["access-control-allow-origin"], origin);
    }
  } finally {
    srv.close();
  }
});

test("Server Security - rejects non-loopback Host header with 403 Forbidden", async () => {
  const app = createGatewayApp({ gatewayToken: "" });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "GET",
      path: "/health",
      headers: { Host: "attacker.com" },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Host must be loopback/);
  } finally {
    srv.close();
  }
});

test("Server Security - enforces gateway token when configured", async () => {
  const mockPiecesFetch: typeof fetch = async () => new Response("ok:uuid", { status: 200 });
  const pieces = new PiecesClient({ fetchFn: mockPiecesFetch });
  const app = createGatewayApp({ gatewayToken: "secret-gate-token-456", piecesClient: pieces });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    // Missing token
    const resNoToken = await makeLocalRequest(srv, { method: "GET", path: "/health" });
    assert.equal(resNoToken.status, 401);

    // Wrong token
    const resWrong = await makeLocalRequest(srv, {
      method: "GET",
      path: "/health",
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(resWrong.status, 401);

    // Correct token
    const resOk = await makeLocalRequest(srv, {
      method: "GET",
      path: "/health",
      headers: { Authorization: "Bearer secret-gate-token-456" },
    });
    assert.equal(resOk.status, 200);
  } finally {
    srv.close();
  }
});

test("Server /ask - rejects Content-Type text/plain with 415", async () => {
  const app = createGatewayApp({ gatewayToken: "" });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      rawBody: JSON.stringify({ query: "Hello" }),
      headers: { "Content-Type": "text/plain" },
    });
    assert.equal(res.status, 415);
    assert.match(res.body.error, /application\/json/);
  } finally {
    srv.close();
  }
});

test("Server /ask - rejects literal null, numbers, and arrays with 400", async () => {
  const app = createGatewayApp({ gatewayToken: "" });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const resNull = await makeLocalRequest(srv, { method: "POST", path: "/ask", rawBody: "null" });
    assert.equal(resNull.status, 400);
    assert.match(resNull.body.error, /JSON object/);

    const resArray = await makeLocalRequest(srv, { method: "POST", path: "/ask", rawBody: "[]" });
    assert.equal(resArray.status, 400);

    const resNumber = await makeLocalRequest(srv, { method: "POST", path: "/ask", rawBody: "123" });
    assert.equal(resNumber.status, 400);
  } finally {
    srv.close();
  }
});

test("Server /ask - rejects oversized request body with 413", async () => {
  const app = createGatewayApp({ gatewayToken: "" });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const largeQuery = "A".repeat(70 * 1024); // 70 KB > 64 KB limit
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: largeQuery },
    });
    assert.equal(res.status, 413);
    assert.match(res.body.error, /exceeds maximum limit/);
  } finally {
    srv.close();
  }
});

test("Server /ask - rejects invalid model identifier with 400", async () => {
  const app = createGatewayApp({ openRouterClient: new OpenRouterClient({ apiKey: "key" }) });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "valid query", model: "invalid model with spaces and !@#$" },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /valid model identifier/);
  } finally {
    srv.close();
  }
});

test("Server /ask - rejects a model identifier with a leading dash", async () => {
  const app = createGatewayApp({ openRouterClient: new OpenRouterClient({ apiKey: "key" }) });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "valid query", model: "--dangerously-skip-permissions" },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /valid model identifier/);
  } finally {
    srv.close();
  }
});

test("Server /ask - happy path gathers PiecesOS context and returns grounded answer", async () => {
  const mockPiecesFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/.well-known/health")) {
      return new Response("ok:uuid", { status: 200 });
    }
    if (urlStr.includes("/workstream_events/identifiers")) {
      return new Response(JSON.stringify({ iterable: [{ id: "evt-42" }] }), { status: 200 });
    }
    if (urlStr.includes("/workstream_events/batch/fetch")) {
      return new Response(
        JSON.stringify({
          workstreamEvents: {
            iterable: [
              {
                id: "evt-42",
                readable: "TypeScript Tips note: Always enable strict: true in tsconfig.json.",
                updated: { value: "2026-10-05T12:00:00Z" },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 200 });
  };

  const mockOpenRouterFetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(init?.body as string);
    assert.ok(payload.messages.some((m: any) => m.content.includes("TypeScript Tips")));

    return new Response(
      JSON.stringify({
        id: "gen-999",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        choices: [
          {
            message: {
              role: "assistant",
              content: "According to [1] Asset: TypeScript Tips, always set strict: true in tsconfig.json.",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 80, completion_tokens: 25, total_tokens: 105 },
      }),
      { status: 200 }
    );
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockOpenRouterFetch });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });

  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "What did I note about TypeScript?" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.piecesConnected, true);
    assert.equal(res.body.contextSupplied, true);
    assert.ok(res.body.sources.length >= 1);
    assert.match(res.body.answer, /TypeScript Tips/);
  } finally {
    srv.close();
  }
});

test("Server /ask - handles PiecesOS offline gracefully without crashing", async () => {
  const mockPiecesFetch: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:39300");
  };

  const mockOpenRouterFetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(init?.body as string);
    assert.ok(payload.messages.some((m: any) => m.content.includes("offline")));

    return new Response(
      JSON.stringify({
        id: "gen-offline-fallback",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        choices: [
          {
            message: {
              role: "assistant",
              content: "PiecesOS is currently offline. Based on general knowledge, TypeScript is a typed superset of JavaScript.",
            },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200 }
    );
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockOpenRouterFetch });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });

  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "What is TypeScript?" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.piecesConnected, false);
    assert.equal(res.body.contextSupplied, false);
    assert.equal(res.body.sources.length, 0);
    assert.match(res.body.answer, /PiecesOS is currently offline/);
  } finally {
    srv.close();
  }
});

test("Server /ask - maps OpenRouter 401 to HTTP 502 with UPSTREAM_AUTH_FAILED", async () => {
  const mockPiecesFetch: typeof fetch = async () => {
    return new Response("ok:uuid", { status: 200 });
  };
  const mockOpenRouterFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: { message: "Invalid API key provided" } }), { status: 401 });
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "bad-key", fetchFn: mockOpenRouterFetch });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "Test question" },
    });

    assert.equal(res.status, 502);
    assert.equal(res.body.code, "UPSTREAM_AUTH_FAILED");
    assert.match(res.body.error, /OpenRouter authentication failed/);
  } finally {
    srv.close();
  }
});

test("Server /ask - handles multibyte UTF-8 characters safely without corruption", async () => {
  const mockPiecesFetch: typeof fetch = async () => {
    return new Response("ok:uuid", { status: 200 });
  };
  const mockOpenRouterFetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(init?.body as string);
    assert.ok(payload.messages.some((m: any) => m.content.includes("こんにちは世界 🚀")));

    return new Response(
      JSON.stringify({
        id: "gen-utf8",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        choices: [{ message: { role: "assistant", content: "Multibyte safe: 🌸" } }],
      }),
      { status: 200 }
    );
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "key", fetchFn: mockOpenRouterFetch });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "こんにちは世界 🚀" },
    });

    assert.equal(res.status, 200);
    assert.match(res.body.answer, /Multibyte safe: 🌸/);
  } finally {
    srv.close();
  }
});

test("Server /ask - rejects excessive Content-Length header upfront with 413", async () => {
  const app = createGatewayApp({ gatewayToken: "" });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      rawBody: "{}",
      headers: {
        "Content-Length": "999999", // Declared size exceeds limit
      },
    });
    assert.equal(res.status, 413);
    assert.match(res.body.error, /Payload Too Large/);
  } finally {
    srv.close();
  }
});

test("Server /ask - when asset detail hydration fails, produces ungrounded answer without claiming memory grounding (P1)", async () => {
  const mockPiecesFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/.well-known/health")) {
      return new Response("ok:uuid", { status: 200 });
    }
    if (urlStr.includes("/assets/search")) {
      return new Response(
        JSON.stringify({
          iterable: [
            { asset: { id: "asset-fail-1", name: "Failing Asset" } },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/asset/")) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response("Internal Server Error", { status: 500 });
  };

  let receivedSystemPrompt = "";
  const mockOpenRouterFetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(init?.body as string);
    receivedSystemPrompt = payload.messages[0].content;

    return new Response(
      JSON.stringify({
        id: "gen-fallback",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        choices: [{ message: { role: "assistant", content: "General knowledge fallback answer." } }],
      }),
      { status: 200 }
    );
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "key", fetchFn: mockOpenRouterFetch });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "Docker container details" },
    });

    assert.equal(res.status, 200);
    // Crucial invariant: when hydration fails, contextSupplied and grounded must be FALSE
    assert.equal(res.body.contextSupplied, false);
    assert.equal(res.body.grounded, false);
    assert.equal(res.body.retrievalStatus !== "ok", true);
    assert.match(receivedSystemPrompt, /not grounded in their saved Pieces memory/i);
  } finally {
    srv.close();
  }
});

test("Server /ask - maps upstream OpenRouter API_ERROR (e.g. 403 or 404) to HTTP 502", async () => {
  const mockPiecesFetch: typeof fetch = async () => new Response("ok:uuid", { status: 200 });
  const mockOpenRouterFetch: typeof fetch = async () => {
    return new Response("Forbidden by upstream policy", { status: 403 });
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "key", fetchFn: mockOpenRouterFetch });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "Test query" },
    });

    assert.equal(res.status, 502);
    assert.equal(res.body.code, "API_ERROR");
  } finally {
    srv.close();
  }
});

test("Server /ask - enforces OPENROUTER_ALLOWED_MODELS when configured", async () => {
  const originalAllowed = process.env.OPENROUTER_ALLOWED_MODELS;
  process.env.OPENROUTER_ALLOWED_MODELS = "meta-llama/llama-3.3-70b-instruct:free,google/gemini-2.0-flash-exp:free";

  const mockPiecesFetch: typeof fetch = async () => new Response("ok:uuid", { status: 200 });
  const mockOpenRouterFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const openRouter = new OpenRouterClient({ apiKey: "key", fetchFn: mockOpenRouterFetch });
  const app = createGatewayApp({ piecesClient: pieces, openRouterClient: openRouter });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    // Disallowed model
    const resDisallowed = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "Test", model: "openai/gpt-4o" },
    });
    assert.equal(resDisallowed.status, 400);
    assert.match(resDisallowed.body.error, /not in the allowed models list/i);

    // Allowed model
    const resAllowed = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "Test", model: "google/gemini-2.0-flash-exp:free" },
    });
    assert.equal(resAllowed.status, 200);
  } finally {
    if (originalAllowed !== undefined) {
      process.env.OPENROUTER_ALLOWED_MODELS = originalAllowed;
    } else {
      delete process.env.OPENROUTER_ALLOWED_MODELS;
    }
    srv.close();
  }
});

test("Server /ask - uses a signed-in subscription without an OpenRouter key", async () => {
  const mockPiecesFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/.well-known/health")) return new Response("ok:uuid", { status: 200 });
    if (urlStr.endsWith("/.well-known/version")) return new Response("12.6.0", { status: 200 });
    return new Response("not found", { status: 404 });
  };

  let sawPrompt = false;
  const reasoning: ReasoningClient = {
    provider: "claude",
    billing: "subscription",
    hasCredentials: () => true,
    getModel: () => "claude-subscription",
    chat: async (prompt) => {
      sawPrompt = prompt.includes("Question:");
      return { id: "sub-1", content: "Answer from the Claude subscription.", model: "claude-subscription" };
    },
  };

  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockPiecesFetch });
  const app = createGatewayApp({
    piecesClient: pieces,
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
    reasoningClient: reasoning,
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const health = await makeLocalRequest(srv, { method: "GET", path: "/health" });
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.openRouter.keyConfigured, false);
    assert.equal(health.body.reasoning.provider, "claude");
    assert.equal(health.body.reasoning.billing, "subscription");
    assert.equal(health.body.reasoning.ready, true);
    assert.equal(JSON.stringify(health.body).includes("sk-"), false);

    const ask = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "What was I doing?" },
    });
    assert.equal(ask.status, 200);
    assert.equal(ask.body.answer, "Answer from the Claude subscription.");
    assert.equal(ask.body.model, "claude-subscription");
    assert.equal(sawPrompt, true);
  } finally {
    srv.close();
  }
});

test("Server /ask - reports a missing subscription login instead of demanding an API key", async () => {
  const reasoning: ReasoningClient = {
    provider: "codex",
    billing: "subscription",
    hasCredentials: () => false,
    getModel: () => "codex-subscription",
    chat: async () => {
      throw new Error("should not be called");
    },
  };
  const pieces = new PiecesClient({
    baseUrl: "http://127.0.0.1:1",
    fetchFn: async () => {
      throw new Error("pieces should not be called");
    },
  });
  const app = createGatewayApp({
    piecesClient: pieces,
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
    reasoningClient: reasoning,
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));

  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/ask",
      body: { query: "hello" },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "MISSING_SUBSCRIPTION");
    assert.match(res.body.error, /codex/i);
  } finally {
    srv.close();
  }
});

test("loopback /mishmash/delegate answers a ping without calling a model", async () => {
  const pieces = new PiecesClient({
    baseUrl: "http://127.0.0.1:1",
    fetchFn: async () => {
      throw new Error("pieces should not be called");
    },
  });
  const app = createGatewayApp({
    piecesClient: pieces,
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
    gatewayToken: "ask-token",
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "0123456789abcdef",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "ping",
        payload: {},
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.result.node, "pieces-for-all");
  } finally {
    srv.close();
  }
});

test("loopback /mishmash/delegate status reports Pieces reachability without a model", async () => {
  const calls: string[] = [];
  const pieces = new PiecesClient({
    baseUrl: "http://127.0.0.1:1",
    fetchFn: async (url) => {
      calls.push(String(url));
      throw new Error("pieces down");
    },
  });
  const app = createGatewayApp({
    piecesClient: pieces,
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
    gatewayToken: "ask-token",
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "0123456789abcdef",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "status",
        payload: {},
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.result.piecesReachable, false);
    assert.ok(calls.some((url) => url.includes("/.well-known/health")));
  } finally {
    srv.close();
  }
});

test("loopback /mishmash/delegate memory stores and searches local LTM without cloud egress", async () => {
  const pieces = new PiecesClient({ baseUrl: "http://127.0.0.1:39300" });
  const app = createGatewayApp({
    piecesClient: pieces,
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  try {
    // 1. Add memory
    const addRes = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "mem-add-1",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "memory",
        payload: {
          action: "add",
          title: "Sovereign Exocortex Memory",
          body: "Zero token rent local long-term memory store",
          tags: ["exocortex", "sovereign"],
        },
      },
    });
    assert.equal(addRes.status, 200);
    assert.equal(addRes.body.ok, true);
    assert.equal(addRes.body.result.status, "added");
    assert.equal(addRes.body.result.memory.title, "Sovereign Exocortex Memory");

    // 2. Search memory
    const searchRes = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "mem-search-1",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "memory",
        payload: {
          action: "search",
          query: "sovereign exocortex rent",
          limit: 3,
        },
      },
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.ok, true);
    assert.equal(searchRes.body.result.status, "searched");
    assert.ok(Array.isArray(searchRes.body.result.matches));
    assert.ok(searchRes.body.result.matches.length >= 1);
    assert.equal(searchRes.body.result.matches[0].title, "Sovereign Exocortex Memory");
    assert.ok(searchRes.body.result.matches[0].score > 0);

    // 3. Negative tests: invalid title/body returns 400
    const badAdd = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "mem-bad-1",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "memory",
        payload: { action: "add", title: "" },
      },
    });
    assert.equal(badAdd.status, 400);

    // 4. Negative tests: unauthorized from returns 403
    const unauthAdd = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "mem-unauth-1",
        from: "evil-script",
        to: "pieces-for-all",
        capability: "memory",
        action: "memory",
        payload: { action: "add", title: "hack", body: "payload" },
      },
    });
    assert.equal(unauthAdd.status, 403);

    // 5. Negative tests: empty search query returns 400
    const emptySearch = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "mem-bad-search-1",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "memory",
        payload: { action: "search", query: "" },
      },
    });
    assert.equal(emptySearch.status, 400);

    // 6. Negative tests: unknown sub-action returns 400
    const badAction = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: {
        v: 1,
        id: "mem-bad-act-1",
        from: "pieces-android-companion-seamless",
        to: "pieces-for-all",
        capability: "memory",
        action: "memory",
        payload: { action: "drop_all" },
      },
    });
    assert.equal(badAction.status, 400);
  } finally {
    srv.close();
  }
});





test("loopback /mishmash/delegate answers 400 (not a crash) for non-object JSON bodies", async () => {
  const app = createGatewayApp({
    piecesClient: new PiecesClient({ baseUrl: "http://127.0.0.1:1", fetchFn: async () => { throw new Error("no"); } }),
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  try {
    for (const body of ["null", "42", "[1]"]) {
      const res = await makeLocalRequest(srv, {
        method: "POST",
        path: "/mishmash/delegate",
        rawBody: body,
      } as any);
      assert.equal(res.status, 400, `body ${body}`);
    }
  } finally {
    srv.close();
  }
});

test("/mishmash/delegate refuses browser-origin and rebound-host requests even from loopback, and never skips the token for them", async () => {
  const pieces = new PiecesClient({
    baseUrl: "http://127.0.0.1:1",
    fetchFn: async () => {
      throw new Error("pieces should not be called");
    },
  });
  const app = createGatewayApp({
    piecesClient: pieces,
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
    gatewayToken: "ask-token",
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const envelope = {
    v: 1,
    id: "0123456789abcdef",
    from: "pieces-android-companion-seamless",
    to: "pieces-for-all",
    capability: "memory",
    action: "ping",
    payload: {},
  };
  try {
    // a plain local call still works without the token
    const ok = await makeLocalRequest(srv, { method: "POST", path: "/mishmash/delegate", body: envelope });
    assert.equal(ok.status, 200);

    // a page served from ANY localhost port passes the generic Origin allowlist, so only the delegate guard stops it
    const browser = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: envelope,
      headers: { Origin: "http://localhost:5173" },
    });
    assert.notEqual(browser.status, 200);
    assert.ok(browser.status === 401 || browser.status === 403);

    // right name, wrong port: not this server's own host:port
    const wrongPort = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: envelope,
      headers: { Host: "127.0.0.1:9" },
    });
    assert.notEqual(wrongPort.status, 200);
    assert.ok(wrongPort.status === 401 || wrongPort.status === 403);
  } finally {
    srv.close();
  }
});

test("/mishmash/delegate rejects browser-origin requests when no gateway token is configured too", async () => {
  const app = createGatewayApp({
    piecesClient: new PiecesClient({ baseUrl: "http://127.0.0.1:1", fetchFn: async () => { throw new Error("no"); } }),
    openRouterClient: new OpenRouterClient({ apiKey: "" }),
  });
  const srv = createServer(app.handleRequest);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  try {
    const res = await makeLocalRequest(srv, {
      method: "POST",
      path: "/mishmash/delegate",
      body: { v: 1, id: "0123456789abcdef", from: "x", to: "pieces-for-all", capability: "memory", action: "ping", payload: {} },
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.status, 403);
  } finally {
    srv.close();
  }
});
