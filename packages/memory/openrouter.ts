/**
 * OpenRouter LLM Client
 *
 * Calls OpenRouter's OpenAI-compatible completions API (https://openrouter.ai/api/v1/chat/completions)
 * using the user's personal API key.
 *
 * Invariants:
 * - API key read ONLY from OPENROUTER_API_KEY env or constructor config.
 * - Real API keys are NEVER printed, logged, or echoed in error messages or exceptions.
 * - Handles 401 (invalid/missing key), 402 (insufficient credits), 429 (rate limit), and timeouts cleanly.
 * - All error messages and diagnostics are aggressively sanitized against credential leakage.
 */

export const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_TIMEOUT_MS = 30000;

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OpenRouterResponse {
  id: string;
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export class OpenRouterError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: string;

  constructor(status: number, code: string, message: string, details?: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Aggressively sanitizes text to ensure credentials, tokens, and authorization
 * headers are never leaked in error messages or diagnostics.
 */
export function sanitizeDiagnostics(rawText: string, activeKey?: string): string {
  if (!rawText) return "";
  let cleaned = rawText;

  if (activeKey && activeKey.trim().length > 0) {
    cleaned = cleaned.replaceAll(activeKey.trim(), "[REDACTED_API_KEY]");
  }

  // Scrub general patterns resembling API keys, bearer tokens, or auth headers
  cleaned = cleaned.replace(/sk-[a-zA-Z0-9_\-]{8,}/g, "[REDACTED_KEY]");
  cleaned = cleaned.replace(/Bearer\s+[a-zA-Z0-9_\-\.]{8,}/gi, "Bearer [REDACTED_TOKEN]");
  cleaned = cleaned.replace(/(api[_-]?key|token|secret|password)["':\s]+[a-zA-Z0-9_\-]{8,}/gi, "$1: [REDACTED]");

  return cleaned.slice(0, 500); // Bounded length
}

export class OpenRouterClient {
  private readonly apiKey?: string;
  private readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(options: OpenRouterClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.defaultModel = options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
    this.baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, "");
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
    this.fetch = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Check if an API key is configured without exposing its contents.
   */
  hasApiKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Get the active model name.
   */
  getModel(): string {
    return this.defaultModel;
  }

  /**
   * Send a chat completion request to OpenRouter.
   * Handles timeout and client disconnect across the entire request/response lifecycle.
   */
  async createChatCompletion(
    messages: OpenRouterMessage[],
    options: CompletionOptions = {}
  ): Promise<OpenRouterResponse> {
    if (!this.hasApiKey()) {
      throw new OpenRouterError(
        401,
        "MISSING_API_KEY",
        "OpenRouter API key is not configured. Set OPENROUTER_API_KEY in your environment."
      );
    }

    const model = options.model ?? this.defaultModel;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const endpoint = `${this.baseUrl}/chat/completions`;

    // Setup combined abort controller for timeout and external signal
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("TimeoutError"));
    }, timeoutMs);

    const onCallerAbort = () => {
      controller.abort(new Error("CallerAbortError"));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutId);
        throw new OpenRouterError(499, "CLIENT_ABORTED", "Client aborted request before execution.");
      }
      options.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const payload: Record<string, unknown> = {
      model,
      messages,
    };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;

    let res: Response;
    try {
      res = await this.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "http://127.0.0.1:39400",
          "X-Title": "Pieces For All Prototype",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        let rawErrorBody = "";
        try {
          rawErrorBody = await res.text();
        } catch (readErr: unknown) {
          if (timedOut || (readErr instanceof Error && readErr.name === "TimeoutError")) {
            throw new OpenRouterError(504, "TIMEOUT", `OpenRouter request timed out after ${timeoutMs}ms.`);
          }
        }

        const safeDetails = sanitizeDiagnostics(rawErrorBody, this.apiKey);

        if (res.status === 401) {
          throw new OpenRouterError(
            401,
            "UNAUTHORIZED",
            "OpenRouter authentication failed (HTTP 401). Please verify OPENROUTER_API_KEY.",
            safeDetails
          );
        }

        if (res.status === 402) {
          throw new OpenRouterError(
            402,
            "PAYMENT_REQUIRED",
            "OpenRouter credit balance depleted (HTTP 402). Please add credits at https://openrouter.ai/credits.",
            safeDetails
          );
        }

        if (res.status === 429) {
          throw new OpenRouterError(
            429,
            "RATE_LIMIT",
            "OpenRouter rate limit reached (HTTP 429). Please wait a moment and try again.",
            safeDetails
          );
        }

        throw new OpenRouterError(
          res.status,
          "API_ERROR",
          `OpenRouter API error (HTTP ${res.status}).`,
          safeDetails
        );
      }

      let data: any;
      try {
        data = await res.json();
      } catch (jsonErr: unknown) {
        if (options.signal?.aborted) {
          throw new OpenRouterError(499, "CLIENT_ABORTED", "Client disconnected while waiting for OpenRouter response.");
        }
        if (timedOut || (jsonErr instanceof Error && jsonErr.name === "TimeoutError")) {
          throw new OpenRouterError(504, "TIMEOUT", `OpenRouter request timed out after ${timeoutMs}ms.`);
        }
        throw new OpenRouterError(
          502,
          "INVALID_RESPONSE",
          "OpenRouter returned a non-JSON response payload."
        );
      }

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new OpenRouterError(
          502,
          "INVALID_RESPONSE",
          "OpenRouter response payload must be a JSON object."
        );
      }

      const choices = (data as Record<string, unknown>).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new OpenRouterError(
          502,
          "EMPTY_RESPONSE",
          "OpenRouter response contained no choices."
        );
      }

      const firstChoice = choices[0];
      const message = firstChoice && typeof firstChoice === "object" ? (firstChoice as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;

      if (typeof content !== "string" || content.trim().length === 0) {
        throw new OpenRouterError(
          502,
          "EMPTY_RESPONSE",
          "OpenRouter response contained no text in choices[0].message.content."
        );
      }

      const rawId = (data as Record<string, unknown>).id;
      const id = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : "unknown";

      const rawModel = (data as Record<string, unknown>).model;
      const returnedModel = typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : model;

      const rawUsage = (data as Record<string, unknown>).usage;
      let usage: OpenRouterResponse["usage"] | undefined;
      if (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
        const u = rawUsage as Record<string, unknown>;
        const promptTokens = typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : 0;
        const completionTokens = typeof u.completion_tokens === "number" && Number.isFinite(u.completion_tokens) ? u.completion_tokens : 0;
        const totalTokens = typeof u.total_tokens === "number" && Number.isFinite(u.total_tokens) ? u.total_tokens : (promptTokens + completionTokens);
        usage = { promptTokens, completionTokens, totalTokens };
      }

      return {
        id,
        content: content.trim(),
        model: returnedModel,
        usage,
      };
    } catch (err: unknown) {
      if (err instanceof OpenRouterError) {
        throw err;
      }

      if (timedOut || (err instanceof Error && (err.name === "TimeoutError" || err.message.includes("TimeoutError")))) {
        throw new OpenRouterError(504, "TIMEOUT", `OpenRouter request timed out after ${timeoutMs}ms.`);
      }

      if (options.signal?.aborted) {
        throw new OpenRouterError(499, "CLIENT_ABORTED", "Client disconnected while waiting for OpenRouter response.");
      }

      const safeErrMessage = sanitizeDiagnostics(err instanceof Error ? err.message : String(err), this.apiKey);
      throw new OpenRouterError(
        502,
        "NETWORK_ERROR",
        "Failed to communicate with OpenRouter.",
        safeErrMessage
      );
    } finally {
      clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  /**
   * Simple helper for one-shot chat prompts.
   */
  async chat(prompt: string, systemPrompt?: string, options: CompletionOptions = {}): Promise<OpenRouterResponse> {
    const messages: OpenRouterMessage[] = [];
    if (systemPrompt && systemPrompt.trim()) {
      messages.push({ role: "system", content: systemPrompt.trim() });
    }
    messages.push({ role: "user", content: prompt });
    return this.createChatCompletion(messages, options);
  }
}
