import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouterClient, OpenRouterError, sanitizeDiagnostics } from "../openrouter.js";

test("OpenRouterClient - throws if API key is missing", async () => {
  const client = new OpenRouterClient({ apiKey: "" });
  assert.equal(client.hasApiKey(), false);

  await assert.rejects(
    async () => {
      await client.chat("Hello");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "MISSING_API_KEY");
      assert.match(err.message, /OPENROUTER_API_KEY/);
      return true;
    }
  );
});

test("OpenRouterClient - sanitizeDiagnostics aggressively scrubs keys and tokens", () => {
  const secretKey = "sk-or-v1-998877665544332211aabbcc";
  const rawMsg = `Error connecting with key: ${secretKey} and Bearer 1234567890abcdef. api_key: "secret123456789"`;

  const cleaned = sanitizeDiagnostics(rawMsg, secretKey);
  assert.equal(cleaned.includes(secretKey), false);
  assert.equal(cleaned.includes("1234567890abcdef"), false);
  assert.match(cleaned, /REDACTED/);
});

test("OpenRouterClient - scrubs credential-bearing JSON error payload", async () => {
  const secretKey = "sk-or-v1-my-secret-openrouter-key-999";
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        error: {
          message: `The provided key ${secretKey} has expired. Contact support.`,
        },
      }),
      { status: 401 }
    );
  };

  const client = new OpenRouterClient({ apiKey: secretKey, fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Test prompt");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "UNAUTHORIZED");
      assert.equal(err.message.includes(secretKey), false);
      assert.equal(err.details?.includes(secretKey), false);
      return true;
    }
  );
});

test("OpenRouterClient - scrubs credential-bearing plain text error payload", async () => {
  const secretKey = "sk-or-v1-plaintext-token-11223344";
  const mockFetch: typeof fetch = async () => {
    return new Response(
      `500 Internal Server Error: Failed token validation for Bearer ${secretKey}`,
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  };

  const client = new OpenRouterClient({ apiKey: secretKey, fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Test prompt");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 500);
      assert.equal(err.message.includes(secretKey), false);
      assert.equal(err.details?.includes(secretKey), false);
      return true;
    }
  );
});

test("OpenRouterClient - scrubs credential-bearing thrown network exception", async () => {
  const secretKey = "sk-or-v1-thrown-network-key-556677";
  const mockFetch: typeof fetch = async () => {
    throw new Error(`Socket hang up during request with Authorization: Bearer ${secretKey}`);
  };

  const client = new OpenRouterClient({ apiKey: secretKey, fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Test prompt");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "NETWORK_ERROR");
      assert.equal(err.message.includes(secretKey), false);
      assert.equal(err.details?.includes(secretKey), false);
      return true;
    }
  );
});

test("OpenRouterClient - handles 401 Unauthorized cleanly", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({ error: { message: "User key not authorized" } }),
      { status: 401 }
    );
  };

  const client = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Hi");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "UNAUTHORIZED");
      assert.match(err.message, /verify OPENROUTER_API_KEY/i);
      return true;
    }
  );
});

test("OpenRouterClient - handles 402 Insufficient Credits cleanly", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({ error: { message: "Key has insufficient credits" } }),
      { status: 402 }
    );
  };

  const client = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Hi");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "PAYMENT_REQUIRED");
      assert.match(err.message, /credit balance depleted/i);
      return true;
    }
  );
});

test("OpenRouterClient - handles 429 Rate Limit cleanly", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({ error: { message: "Rate limit reached for model" } }),
      { status: 429 }
    );
  };

  const client = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Hi");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 429);
      assert.equal(err.code, "RATE_LIMIT");
      assert.match(err.message, /rate limit reached/i);
      return true;
    }
  );
});

test("OpenRouterClient - handles network timeout during initial fetch", async () => {
  const mockFetch: typeof fetch = async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  const client = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockFetch, timeoutMs: 1000 });
  await assert.rejects(
    async () => {
      await client.chat("Hi");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 504);
      assert.equal(err.code, "TIMEOUT");
      assert.match(err.message, /timed out/i);
      return true;
    }
  );
});

test("OpenRouterClient - handles body-read timeout after response headers arrive", async () => {
  const mockFetch: typeof fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => {
        const error = new Error("Body stream read timed out");
        error.name = "TimeoutError";
        throw error;
      },
    } as any;
  };

  const client = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Hi");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 504);
      assert.equal(err.code, "TIMEOUT");
      return true;
    }
  );
});

test("OpenRouterClient - respects caller abort signal", async () => {
  const controller = new AbortController();
  const mockFetch: typeof fetch = async () => {
    controller.abort();
    throw new Error("Aborted");
  };

  const client = new OpenRouterClient({ apiKey: "test-key", fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.createChatCompletion([{ role: "user", content: "Hi" }], { signal: controller.signal });
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 499);
      assert.equal(err.code, "CLIENT_ABORTED");
      return true;
    }
  );
});

test("OpenRouterClient - happy path returns assistant content and metadata", async () => {
  const mockFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, "meta-llama/llama-3.3-70b-instruct:free");
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");

    return new Response(
      JSON.stringify({
        id: "gen-12345",
        model: "meta-llama/llama-3.3-70b-instruct:free",
        choices: [
          {
            message: {
              role: "assistant",
              content: "This is a grounded answer citing [1] Asset: Note.",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 45,
          completion_tokens: 15,
          total_tokens: 60,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new OpenRouterClient({
    apiKey: "valid-test-key",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    fetchFn: mockFetch,
  });
  const result = await client.chat("What did I work on?", "System instructions");

  assert.equal(result.id, "gen-12345");
  assert.equal(result.content, "This is a grounded answer citing [1] Asset: Note.");
  assert.equal(result.model, "meta-llama/llama-3.3-70b-instruct:free");
  assert.deepEqual(result.usage, {
    promptTokens: 45,
    completionTokens: 15,
    totalTokens: 60,
  });
});

test("OpenRouterClient - throws EMPTY_RESPONSE if choices[0].message.content is blank or empty whitespace", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        id: "gen-empty",
        choices: [
          {
            message: {
              role: "assistant",
              content: "   ",
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new OpenRouterClient({ apiKey: "valid-key", fetchFn: mockFetch });
  await assert.rejects(
    async () => {
      await client.chat("Hi");
    },
    (err: unknown) => {
      assert.ok(err instanceof OpenRouterError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "EMPTY_RESPONSE");
      return true;
    }
  );
});

test("OpenRouterClient - validates metadata types and provides safe defaults for non-standard fields", async () => {
  const mockFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        id: 12345, // Number instead of string
        model: { name: "custom" }, // Object instead of string
        choices: [
          {
            message: {
              role: "assistant",
              content: "Valid response content",
            },
          },
        ],
        usage: {
          prompt_tokens: "45", // String instead of number
          completion_tokens: 15,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const client = new OpenRouterClient({ apiKey: "valid-key", fetchFn: mockFetch });
  const result = await client.chat("Hi");

  assert.equal(typeof result.id, "string");
  assert.equal(result.id, "unknown"); // Safely fell back to default string
  assert.equal(typeof result.model, "string");
  assert.equal(result.model, client.getModel()); // Safely fell back to configured model
  assert.equal(result.content, "Valid response content");
  assert.equal(typeof result.usage?.promptTokens, "number");
  assert.equal(result.usage?.promptTokens, 0); // Non-number safely sanitized to 0
  assert.equal(result.usage?.completionTokens, 15);
});


