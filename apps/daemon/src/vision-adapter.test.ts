import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  analyzeTestScreenshot,
  isConfidentTestClassification,
} from "./vision-adapter.js";

const OLLAMA = "http://127.0.0.1:11434/api/generate";

function ollamaResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify({ response: JSON.stringify(payload) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function llamaResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("defaults to local llama.cpp chat completions with a resized data-URI image", async () => {
  const image = await sharp({
    create: { width: 1800, height: 1200, channels: 3, background: "#fff" },
  }).png().toBuffer();
  let requestUrl = "";
  let requestBody: Record<string, any> | undefined;
  const result = await analyzeTestScreenshot(image, {
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, any>;
      return llamaResponse({ status: "passed", confidence: 0.95, summary: "All tests passed." });
    },
  });

  assert.equal(requestUrl, "http://127.0.0.1:8082/v1/chat/completions");
  assert.equal(requestBody?.model, "llava:latest");
  assert.equal(requestBody?.response_format?.type, "json_object");
  assert.equal(typeof requestBody?.response_format?.schema, "object");
  assert.equal(requestBody?.response_format?.schema?.properties?.summary?.maxLength, 280);
  const parts = requestBody?.messages?.[0]?.content as Array<Record<string, any>>;
  assert.equal(parts[0].type, "text");
  const url = String(parts[1].image_url.url);
  assert.ok(url.startsWith("data:image/jpeg;base64,"));
  const resized = await sharp(Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64")).metadata();
  assert.ok(resized.width! <= 1024 && resized.height! <= 1024);
  assert.equal(result.status, "passed");
  assert.equal(isConfidentTestClassification(result), true);

  await assert.rejects(
    analyzeTestScreenshot(image, {
      fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    }),
    /invalid response envelope/,
  );
});

test("resizes a selected screenshot and sends it only to local Ollama", async () => {
  const image = await sharp({
    create: { width: 1800, height: 1200, channels: 3, background: "#fff" },
  }).png().toBuffer();
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const result = await analyzeTestScreenshot(image, {
    endpoint: "http://127.0.0.1:11434/api/generate",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ollamaResponse({ status: "failed", confidence: 0.98, summary: "The test runner reports failures." });
    },
  });

  assert.equal(requestUrl, "http://127.0.0.1:11434/api/generate");
  assert.equal(requestBody?.model, "llava:latest");
  assert.equal(requestBody?.stream, false);
  assert.equal(typeof requestBody?.format, "object");
  assert.equal(result.status, "failed");
  assert.equal(isConfidentTestClassification(result), true);

  const images = requestBody?.images as string[];
  const resized = await sharp(Buffer.from(images[0], "base64")).metadata();
  assert.ok(resized.width! <= 1024 && resized.height! <= 1024);
});

test("rejects remote endpoints before sending screenshot data", async () => {
  let called = false;
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#fff" },
  }).png().toBuffer();
  await assert.rejects(
    analyzeTestScreenshot(image, {
      endpoint: "http://example.com/api/generate",
      fetchImpl: async () => {
        called = true;
        return ollamaResponse({});
      },
    }),
    /vision endpoint must be local/,
  );
  assert.equal(called, false);
});

test("rejects invalid model output, oversized summaries, and unavailable service", async () => {
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#fff" },
  }).png().toBuffer();

  await assert.rejects(
    analyzeTestScreenshot(image, { endpoint: OLLAMA, fetchImpl: async () => ollamaResponse({ status: "execute", confidence: 1, summary: "" }) }),
    /invalid classification/,
  );
  await assert.rejects(
    analyzeTestScreenshot(image, {
      endpoint: OLLAMA,
      fetchImpl: async () => ollamaResponse({ status: "passed", confidence: 1, summary: "x".repeat(281) }),
    }),
    /summary exceeds/,
  );
  await assert.rejects(
    analyzeTestScreenshot(image, { endpoint: OLLAMA, fetchImpl: async () => ollamaResponse({}, 503) }),
    /HTTP 503/,
  );
});

test("rejects oversized input images and oversized model responses", async () => {
  await assert.rejects(
    analyzeTestScreenshot(Buffer.alloc(20 * 1024 * 1024 + 1)),
    /no larger than 20 MiB/,
  );
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#fff" },
  }).png().toBuffer();
  await assert.rejects(
    analyzeTestScreenshot(image, {
      fetchImpl: async () => new Response("x".repeat(32 * 1024 + 1)),
    }),
    /response exceeds the permitted size/,
  );
});

test("fails closed for unclear or low-confidence classifications", () => {
  assert.equal(isConfidentTestClassification({ status: "unknown", confidence: 1, summary: "" }), false);
  assert.equal(isConfidentTestClassification({ status: "failed", confidence: 0.89, summary: "" }), false);
  assert.equal(isConfidentTestClassification({ status: "passed", confidence: 0.9, summary: "" }), true);
});
