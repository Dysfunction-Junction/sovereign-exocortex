/**
 * Reasoning providers for the local gateway.
 *
 * openrouter — metered API key (OPENROUTER_API_KEY)
 * claude     — Claude Pro/Max subscription via the official Claude Code CLI
 * codex        — ChatGPT Plus/Pro subscription via the official Codex CLI
 * antigravity — Antigravity subscription via the official agy CLI
 * auto        — a signed-in subscription CLI, then the OpenRouter key
 */

import { OpenRouterClient, type CompletionOptions, type OpenRouterResponse } from "./openrouter.js";
import { SubscriptionCliClient, type SubscriptionProvider } from "./subscription.js";

export type ReasoningProvider = "openrouter" | SubscriptionProvider;

export interface ReasoningClient {
  readonly provider: ReasoningProvider;
  readonly billing: "api-key" | "subscription";
  hasCredentials(): boolean;
  getModel(): string;
  chat(prompt: string, systemPrompt?: string, options?: CompletionOptions): Promise<OpenRouterResponse>;
}

export function wrapOpenRouter(client: OpenRouterClient): ReasoningClient {
  return {
    provider: "openrouter",
    billing: "api-key",
    hasCredentials: () => client.hasApiKey(),
    getModel: () => client.getModel(),
    chat: (prompt, systemPrompt, options) => client.chat(prompt, systemPrompt, options),
  };
}

export function resolveReasoningClient(
  openRouter: OpenRouterClient,
  env: NodeJS.ProcessEnv = process.env
): ReasoningClient {
  const raw = (env.REASONING_PROVIDER ?? "openrouter").trim().toLowerCase();

  if (raw === "openrouter" || raw.length === 0) {
    return wrapOpenRouter(openRouter);
  }

  if (raw === "claude" || raw === "codex" || raw === "antigravity") {
    return new SubscriptionCliClient({ provider: raw });
  }

  if (raw === "auto") {
    const claude = new SubscriptionCliClient({ provider: "claude" });
    if (claude.hasCredentials()) return claude;
    const codex = new SubscriptionCliClient({ provider: "codex" });
    if (codex.hasCredentials()) return codex;
    const antigravity = new SubscriptionCliClient({ provider: "antigravity" });
    if (antigravity.hasCredentials()) return antigravity;
    return wrapOpenRouter(openRouter);
  }

  throw new Error(
    `Unknown REASONING_PROVIDER '${raw}'. Use openrouter, claude, codex, antigravity, or auto.`
  );
}
