import test from "node:test";
import assert from "node:assert/strict";
import { PiecesClient } from "../pieces.js";

test("PiecesClient - checkHealth returns 'up' when health endpoint responds ok", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/.well-known/health")) {
      return new Response("ok:test-uuid-1234", { status: 200 });
    }
    if (urlStr.endsWith("/.well-known/version")) {
      return new Response("12.6.0", { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const health = await client.checkHealth();

  assert.equal(health.ok, true);
  assert.equal(health.status, "up");
  assert.equal(health.version, "12.6.0");
});

test("PiecesClient - checkHealth returns 'down' without throwing when unreachable", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:39300");
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const health = await client.checkHealth();

  assert.equal(health.ok, false);
  assert.equal(health.status, "down");
  assert.match(health.error ?? "", /ECONNREFUSED/);
});

test("PiecesClient - pollReadiness succeeds when PiecesOS becomes ready", async () => {
  let healthChecks = 0;
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/.well-known/health")) {
      healthChecks++;
      if (healthChecks < 3) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:39300");
      }
      return new Response("ok:ready-uuid", { status: 200 });
    }
    return new Response("12.6.0", { status: 200 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const ready = await client.pollReadiness({ maxAttempts: 5, intervalMs: 10, timeoutPerAttemptMs: 50 });

  assert.equal(ready, true);
  assert.equal(healthChecks, 3);
});

test("PiecesClient - pollReadiness returns false when service never binds", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:39300");
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const ready = await client.pollReadiness({ maxAttempts: 2, intervalMs: 5, timeoutPerAttemptMs: 20 });

  assert.equal(ready, false);
});

test("PiecesClient - searchAssets searches and hydrates snippets", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/assets/search")) {
      return new Response(
        JSON.stringify({
          iterable: [
            {
              asset: {
                id: "asset-1",
                name: "Docker Config",
                updated: { readable: "Today" },
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/asset/asset-1")) {
      return new Response(
        JSON.stringify({
          id: "asset-1",
          name: "Docker Config",
          formats: {
            iterable: [
              {
                fragment: {
                  string: {
                    raw: "version: '3.8'\nservices:\n  gateway:\n    ports: ['39400:39400']",
                  },
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const result = await client.searchAssets("docker");

  assert.equal(result.status, "ok");
  assert.equal(result.snippets.length, 1);
  assert.equal(result.snippets[0].title, "Asset: Docker Config");
  assert.match(result.snippets[0].content, /services/);
});

test("PiecesClient - fetchRelevantWorkstreamEvents scores and filters keywords", async () => {
  const events = [
    {
      id: "evt-1",
      readable: "User researched OpenRouter gateway architecture in Chrome",
      updated: { value: "2026-10-03T10:00:00Z" },
    },
    {
      id: "evt-2",
      readable: "Unrelated grocery shopping note",
      updated: { value: "2026-10-03T10:05:00Z" },
    },
  ];
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    assert.equal(urlStr.endsWith("/workstream_events"), false);
    if (urlStr.includes("/workstream_events/identifiers")) {
      return new Response(JSON.stringify({ iterable: events.map((event) => ({ id: event.id })) }), { status: 200 });
    }
    if (urlStr.includes("/workstream_events/batch/fetch")) {
      return new Response(JSON.stringify({ workstreamEvents: { iterable: events } }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const result = await client.fetchRelevantWorkstreamEvents("OpenRouter gateway");

  assert.equal(result.status, "ok");
  assert.equal(result.snippets.length, 1);
  assert.equal(result.snippets[0].id, "evt-1");
  assert.match(result.snippets[0].content, /OpenRouter gateway/);
});

test("PiecesClient - fetchWorkstreamSummaries applies relevance gating to prevent unrelated context leakage", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    assert.equal(urlStr.endsWith("/workstream_summaries"), false);
    if (urlStr.includes("/workstream_summaries/search")) {
      return new Response(
        JSON.stringify({
          iterable: [
            {
              identifier: "sum-1",
              similarity: 0.8,
              summary: { id: "sum-1", name: "Android Bridge Setup", created: { readable: "Yesterday", value: "2026-10-02T12:00:00Z" } },
              annotations: { iterable: [{ annotation: { type: "SUMMARY", text: "Configured the Android bridge relay on port 8766." } }] },
            },
            {
              identifier: "sum-2",
              similarity: 0.2,
              summary: { id: "sum-2", name: "Unrelated Cooking Notes", created: { readable: "2 days ago", value: "2026-10-01T12:00:00Z" } },
              annotations: { iterable: [{ annotation: { type: "SUMMARY", text: "Recipe for weeknight pasta." } }] },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });

  // Query matching Android
  const resMatch = await client.fetchWorkstreamSummaries("Android bridge");
  assert.equal(resMatch.status, "ok");
  assert.equal(resMatch.snippets.length, 1);
  assert.equal(resMatch.snippets[0].title, "Summary: Android Bridge Setup");

  // Query for unrelated topic should yield 0 summaries (relevance gated)
  const resNoMatch = await client.fetchWorkstreamSummaries("quantum computing");
  assert.equal(resNoMatch.status, "ok");
  assert.equal(resNoMatch.snippets.length, 0);
});

test("PiecesClient - fetchWorkstreamSummaries sorts chronologically using ISO timestamp over human string", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/workstream_summaries/search")) {
      return new Response(
        JSON.stringify({
          iterable: [
            {
              identifier: "sum-old",
              similarity: 0.5,
              summary: { id: "sum-old", name: "Bridge Docs", created: { readable: "2 days ago", value: "2026-10-01T12:00:00Z" } },
              annotations: { iterable: [{ annotation: { type: "SUMMARY", text: "Bridge info" } }] },
            },
            {
              identifier: "sum-new",
              similarity: 0.5,
              summary: { id: "sum-new", name: "Bridge Update", created: { readable: "Yesterday", value: "2026-10-02T12:00:00Z" } },
              annotations: { iterable: [{ annotation: { type: "SUMMARY", text: "Bridge info" } }] },
            },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const res = await client.fetchWorkstreamSummaries("bridge");
  assert.equal(res.status, "ok");
  assert.equal(res.snippets.length, 2);
  assert.equal(res.snippets[0].id, "sum-new");
});

test("PiecesClient - gatherContext preserves errors when PiecesOS is healthy but retrieval fails", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/.well-known/health")) {
      return new Response("ok:uuid", { status: 200 });
    }
    // All retrieval endpoints 500
    return new Response("Internal Server Error", { status: 500 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const context = await client.gatherContext("docker");

  assert.equal(context.piecesAvailable, true);
  assert.equal(context.retrievalStatus, "failed");
  assert.equal(context.snippets.length, 0);
  assert.ok(context.errors && context.errors.length > 0);
  assert.match(context.formattedNotes, /retrieval queries encountered errors/i);
});

test("PiecesClient - gatherContext gracefully handles PiecesOS offline", async () => {
  const mockFetch: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:39300");
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const context = await client.gatherContext("docker");

  assert.equal(context.piecesAvailable, false);
  assert.equal(context.retrievalStatus, "offline");
  assert.equal(context.snippets.length, 0);
  assert.match(context.formattedNotes, /offline/i);
  assert.ok(context.errors && context.errors.length > 0);
});

test("PiecesClient - extractKeywords filters stopwords, preserves Unicode accented characters, and generates CJK bigrams", () => {
  const client = new PiecesClient();

  // Stopwords filter test
  const stopwordKeywords = client.extractKeywords("what did you do with that and for this code");
  assert.deepEqual(stopwordKeywords, ["code"]);

  // Accented Latin characters
  const accentedKeywords = client.extractKeywords("café barista crème brûlée");
  assert.ok(accentedKeywords.includes("café"));
  assert.ok(accentedKeywords.includes("barista"));
  assert.ok(accentedKeywords.includes("crème"));
  assert.ok(accentedKeywords.includes("brûlée"));

  // CJK bigrams
  const cjkKeywords = client.extractKeywords("TypeScriptの環境設定");
  assert.ok(cjkKeywords.includes("typescript"));
  assert.ok(cjkKeywords.includes("環境"));
  assert.ok(cjkKeywords.includes("設定"));
});

test("PiecesClient - fetchRelevantWorkstreamEvents correctly matches non-ASCII queries (accented & CJK)", async () => {
  const events = [
    {
      id: "evt-accented",
      readable: "User researched café barista menu designs",
      updated: { value: "2026-10-03T11:00:00Z" },
    },
    {
      id: "evt-cjk",
      readable: "TypeScriptの環境設定ドキュメントを更新",
      updated: { value: "2026-10-03T11:05:00Z" },
    },
    {
      id: "evt-unrelated",
      readable: "Database schema migration finished",
      updated: { value: "2026-10-03T11:10:00Z" },
    },
  ];
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/workstream_events/identifiers")) {
      return new Response(JSON.stringify({ iterable: events.map((event) => ({ id: event.id })) }), { status: 200 });
    }
    if (urlStr.includes("/workstream_events/batch/fetch")) {
      return new Response(JSON.stringify({ workstreamEvents: { iterable: events } }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });

  // Accented query
  const resAccented = await client.fetchRelevantWorkstreamEvents("café barista");
  assert.equal(resAccented.status, "ok");
  assert.equal(resAccented.snippets.length, 1);
  assert.equal(resAccented.snippets[0].id, "evt-accented");

  // CJK query
  const resCjk = await client.fetchRelevantWorkstreamEvents("環境設定");
  assert.equal(resCjk.status, "ok");
  assert.equal(resCjk.snippets.length, 1);
  assert.equal(resCjk.snippets[0].id, "evt-cjk");
});

test("PiecesClient - failed asset hydration returns 'failed' status and prevents false content grounding (P1)", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/assets/search")) {
      return new Response(
        JSON.stringify({
          iterable: [
            { asset: { id: "asset-fail-1", name: "Failing Asset 1" } },
            { asset: { id: "asset-fail-2", name: "Failing Asset 2" } },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/asset/")) {
      // Detail request 500s
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const result = await client.searchAssets("search query");

  assert.equal(result.status, "failed");
  assert.equal(result.snippets.length, 0);
  assert.match(result.error ?? "", /hydrations failed/);
});

test("PiecesClient - extractExcerpt and event search capture keywords beyond character 500 (P5)", async () => {
  const prefixPadding = "A".repeat(850);
  const fullText = `${prefixPadding} critical hyperdrive malfunction observed in telemetry log ${prefixPadding}`;
  assert.ok(fullText.indexOf("hyperdrive") > 800);

  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/workstream_events/identifiers")) {
      return new Response(JSON.stringify({ iterable: [{ id: "evt-long" }] }), { status: 200 });
    }
    if (urlStr.includes("/workstream_events/batch/fetch")) {
      return new Response(
        JSON.stringify({
          workstreamEvents: {
            iterable: [
              {
                id: "evt-long",
                readable: fullText,
                updated: { value: "2026-10-03T12:00:00Z" },
              },
            ],
          },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  const result = await client.fetchRelevantWorkstreamEvents("hyperdrive");

  assert.equal(result.status, "ok");
  assert.equal(result.snippets.length, 1);
  // Verify that the transmitted excerpt actually contains the matched keyword!
  assert.ok(result.snippets[0].content.includes("hyperdrive"));
});

test("PiecesClient - cancellation abort signal stops subsequent detail hydration requests (P2)", async () => {
  let detailRequestsAttempted = 0;
  const controller = new AbortController();

  const mockFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/assets/search")) {
      return new Response(
        JSON.stringify({
          iterable: [
            { asset: { id: "asset-1", name: "Asset One" } },
            { asset: { id: "asset-2", name: "Asset Two" } },
            { asset: { id: "asset-3", name: "Asset Three" } },
          ],
        }),
        { status: 200 }
      );
    }
    if (urlStr.includes("/asset/")) {
      detailRequestsAttempted++;
      // Abort after first detail request
      controller.abort();
      return new Response(
        JSON.stringify({
          id: "asset-1",
          formats: { iterable: [{ fragment: { string: { raw: "content 1" } } }] },
        }),
        { status: 200 }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const client = new PiecesClient({ baseUrl: "http://127.0.0.1:39300", fetchFn: mockFetch });
  await client.searchAssets("test", 5, { signal: controller.signal });

  // Out of 3 candidate assets, at most 1 detail request was attempted before cancellation halted further calls
  assert.ok(detailRequestsAttempted <= 1);
});


