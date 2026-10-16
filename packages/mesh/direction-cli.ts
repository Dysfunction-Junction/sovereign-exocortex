#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PeerChannelRegistry } from "./peer-channels.js";
import { redactSecrets, stateDirectory } from "./security.js";
import {
  TrafficControlRegistry,
  resolveTrafficLocation,
} from "./traffic-control.js";
import { PROVIDERS } from "./types.js";
import type { Origin, Provider } from "./types.js";

const MAX_STDIN_BYTES = 256 * 1024;
const MAX_WORKSPACE_ROOTS = 8;
const MINIMUM_PROMPT_CHARS = 12;
const MAX_BODY_CHARS = 16_000;
const MAX_TITLE_BYTES = 200;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_IDEMPOTENCY_KEY_BYTES = 200;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const IDEMPOTENCY_UNSAFE = /[^A-Za-z0-9._:-]/g;

export type DirectionIntakeOutcome =
  | "published"
  | "refused-delegated-child"
  | "prompt-too-short"
  | "no-git-workspace"
  | "no-mesh-activity";

export interface DirectionIntakeRequest {
  prompt: string;
  conversationId: string | null;
  generationId: string | null;
  workspaceRoots: string[];
}

export interface DirectionIntakeResult {
  outcome: DirectionIntakeOutcome;
  directionId?: string;
  revision?: number;
  targets?: number;
}

export interface DirectionIntakeOptions {
  origin?: Origin;
  peerPath?: string;
  trafficPath?: string;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return value;
  return new TextDecoder("utf-8")
    .decode(encoded.subarray(0, maximumBytes))
    .replace(/\uFFFD+$/u, "");
}

/**
 * Parse one editor hook payload. Malformed input is not an error worth
 * reporting: the hook runs on every submitted prompt and must stay quiet.
 */
export function parseIntakeRequest(source: string): DirectionIntakeRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const payload = parsed as Record<string, unknown>;
  if (typeof payload.prompt !== "string") return null;
  const roots = Array.isArray(payload.workspace_roots)
    ? payload.workspace_roots
        .filter((root): root is string => typeof root === "string")
        .map((root) => root.trim())
        .filter((root) => isAbsolute(root))
        .slice(0, MAX_WORKSPACE_ROOTS)
    : [];
  return {
    prompt: payload.prompt,
    conversationId: textField(payload.conversation_id),
    generationId: textField(payload.generation_id),
    workspaceRoots: roots.length > 0 ? roots : [process.cwd()],
  };
}

export function intakeOrigin(argv: string[] = process.argv.slice(2)): Origin {
  const inline = argv.find((value) => value.startsWith("--origin="));
  const raw = inline
    ? inline.slice("--origin=".length)
    : process.env.AGENT_MESH_HOOK_ORIGIN;
  return PROVIDERS.includes(raw as Provider) ? (raw as Origin) : "cursor";
}

/**
 * Derive the direction envelope. The prompt is redacted and bounded here so a
 * pasted credential never reaches durable mesh state.
 */
function directionEnvelope(prompt: string): {
  title: string;
  summary: string;
  body: string;
} {
  const redacted = redactSecrets(prompt)
    .replace(CONTROL_CHARACTERS, " ")
    .trim();
  const body = redacted.slice(0, MAX_BODY_CHARS);
  const headline =
    body.split("\n").find((line) => line.trim().length > 0)?.trim() ?? body;
  return {
    title: boundedUtf8(headline, MAX_TITLE_BYTES),
    summary: body.slice(0, MAX_SUMMARY_CHARS),
    body,
  };
}

/**
 * A resubmitted prompt must land on the same direction revision. Editors that
 * omit conversation or generation identity fall back to prompt identity, which
 * is equally stable.
 */
function idempotencyKey(request: DirectionIntakeRequest): string {
  const raw =
    request.conversationId && request.generationId
      ? `${request.conversationId}:${request.generationId}`
      : `prompt-${createHash("sha256").update(request.prompt).digest("hex").slice(0, 32)}`;
  return boundedUtf8(
    raw.replace(IDEMPOTENCY_UNSAFE, "-"),
    MAX_IDEMPOTENCY_KEY_BYTES,
  );
}

function conversationReference(request: DirectionIntakeRequest): string | undefined {
  if (!request.conversationId) return undefined;
  const normalized = request.conversationId.replace(/[^A-Za-z0-9._:@/-]/g, "-");
  return /^[A-Za-z0-9]/.test(normalized)
    ? boundedUtf8(normalized, 512)
    : undefined;
}

/**
 * Turn one human prompt into durable repository direction. Every skip path is
 * silent by design: this runs on every prompt a human types.
 */
export async function runDirectionIntake(
  request: DirectionIntakeRequest,
  options: DirectionIntakeOptions = {},
): Promise<DirectionIntakeResult> {
  // Delegated children inherit AGENT_MESH_CHILD=1. Without this refusal a
  // delegated agent could forge direction that claims a human typed it.
  if (process.env.AGENT_MESH_CHILD === "1") {
    return { outcome: "refused-delegated-child" };
  }
  if (request.prompt.trim().length < MINIMUM_PROMPT_CHARS) {
    return { outcome: "prompt-too-short" };
  }
  const location = await resolveIntakeWorkspace(request.workspaceRoots);
  if (!location) return { outcome: "no-git-workspace" };

  const peerPath = options.peerPath ?? resolve(stateDirectory(), "peer.db");
  const trafficPath =
    options.trafficPath ?? resolve(stateDirectory(), "traffic.db");
  if (!existsSync(peerPath) || !existsSync(trafficPath)) {
    return { outcome: "no-mesh-activity" };
  }
  const origin = options.origin ?? "cursor";
  const traffic = new TrafficControlRegistry({ origin, path: trafficPath });
  try {
    const peers = new PeerChannelRegistry({
      origin,
      path: peerPath,
      agentResolver: (agentId) => traffic.getAgent(agentId),
    });
    try {
      const channel = peers
        .listChannels()
        .find(
          (candidate) =>
            candidate.kind === "repository" &&
            candidate.status === "open" &&
            candidate.sourceRepoKey === location.repoKey,
        );
      if (!channel) return { outcome: "no-mesh-activity" };
      const envelope = directionEnvelope(request.prompt);
      const conversationId = conversationReference(request);
      const published = peers.publishDirection({
        expectedRevision: 0,
        repoKey: location.repoKey,
        title: envelope.title,
        body: envelope.body,
        summary: envelope.summary,
        provenance: "hook_prompt",
        ...(conversationId ? { conversationId } : {}),
        disposition: "active",
        idempotencyKey: idempotencyKey(request),
      });
      return {
        outcome: "published",
        directionId: published.direction.id,
        revision: published.revision.revision,
        targets: published.targets.length,
      };
    } finally {
      peers.close();
    }
  } finally {
    traffic.close();
  }
}

/**
 * Resolve the first workspace root that is a git repository through the same
 * traffic derivation that binds managed agents to a repository channel.
 */
async function resolveIntakeWorkspace(
  roots: string[],
): Promise<{ repoKey: string } | undefined> {
  for (const root of roots.slice(0, MAX_WORKSPACE_ROOTS)) {
    try {
      return await resolveTrafficLocation(root);
    } catch {
      // A non-repository or out-of-roots workspace is a silent skip.
    }
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Buffer);
    bytes += buffer.byteLength;
    if (bytes > MAX_STDIN_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Never fail the human's prompt: every path exits 0 and prints at most one
 * content-free status line to stderr.
 */
export async function main(): Promise<void> {
  const request = parseIntakeRequest(await readStdin());
  if (!request) return;
  const result = await runDirectionIntake(request, { origin: intakeOrigin() });
  if (result.outcome === "published") {
    process.stderr.write(
      `agent-mesh-direction: published revision ${result.revision} to ${result.targets} peer(s)\n`,
    );
    return;
  }
  if (result.outcome === "refused-delegated-child") {
    process.stderr.write(
      "agent-mesh-direction: refused; delegated child processes cannot publish human direction\n",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => undefined);
}
