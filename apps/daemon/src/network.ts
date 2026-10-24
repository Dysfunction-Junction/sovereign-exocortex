// Loopback delegation table for this PC.
// The phone reaches this gateway over Tailscale. The gateway then hands the
// envelope to a service on this same machine. Nothing here is a cloud VM.
// Every local project is one node. The launch table is the list of them.

import { MISHMASH_LAUNCH } from "./mishmash-nodes.js";

export const GATEWAY_NODE = "pieces-android-companion-seamless";

export interface DelegateEnvelope {
  v: 1;
  id: string;
  from: string;
  to: string;
  capability: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface LocalNode {
  id: string;
  role: string;
  delegate: boolean;
  upstream?: string;
}

const DELEGATE_UPSTREAMS = new Map(
  MISHMASH_LAUNCH.map((spec) => [
    spec.id,
    {
      role: spec.role,
      env: spec.envKey,
      fallback: `http://127.0.0.1:${spec.port}`,
    },
  ]),
);

export function loopbackBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") return null;
  return `${url.protocol}//${url.host}`;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      total += chunk.length;
      if (value.length > remaining) {
        await reader.cancel();
        break;
      }
    }
    if (total >= maxBytes) await reader.cancel();
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function localNodes(env: NodeJS.ProcessEnv = process.env): LocalNode[] {
  return MISHMASH_LAUNCH.map((spec) => {
    const upstream = delegateUpstream(spec.id, env);
    return {
      id: spec.id,
      role: spec.role,
      delegate: upstream !== null,
      ...(upstream ? { upstream } : {}),
    };
  });
}

export function delegateUpstream(nodeId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const spec = DELEGATE_UPSTREAMS.get(nodeId);
  if (!spec) return null;
  const configured = (env[spec.env] || "").trim();
  return loopbackBase(configured || spec.fallback);
}

// Approve/reject carry authority only /network/approve verifies (shadow mode,
// biometric attestation, scope, breaker). The generic delegate path must never relay them.
export function isApprovalAction(action: string): boolean {
  const a = action.trim().toLowerCase();
  return a === "approve" || a === "reject";
}

export async function forwardDelegate(
  envelope: DelegateEnvelope,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<{ status: number; body: unknown; contentType: string; isRawText?: boolean }> {
  if (isApprovalAction(envelope.action)) {
    return {
      status: 403,
      contentType: "application/json",
      body: { error: "approve/reject must go through /network/approve", action: envelope.action },
    };
  }
  return relayEnvelope(envelope, env, fetchImpl, timeoutMs);
}

// No approval gate here: only forwardApprove (behind /network/approve's checks) may call this with approve/reject.
async function relayEnvelope(
  envelope: DelegateEnvelope,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; contentType: string; isRawText?: boolean }> {
  if (!DELEGATE_UPSTREAMS.has(envelope.to)) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "unknown delegate node", to: envelope.to },
    };
  }
  const upstream = delegateUpstream(envelope.to, env);
  if (!upstream) {
    return {
      status: 409,
      contentType: "application/json",
      body: { error: "node is on this PC but does not take a delegated call", to: envelope.to },
    };
  }
  const memoryToken = (env.GATEWAY_TOKEN ?? env.PIECES_GATEWAY_TOKEN ?? "").trim();
  try {
    const delegated = await fetchImpl(new URL("/mishmash/delegate", upstream), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The triad refuses delegated approve/reject without its server token.
        ...(envelope.to === "autonomous-triad" && env.TRIAD_SERVER_TOKEN
          ? { Authorization: `Bearer ${env.TRIAD_SERVER_TOKEN}` }
          : {}),
        // The memory service no longer trusts loopback callers; it wants its own gateway token.
        ...(memoryToken && envelope.to === "pieces-for-all"
          ? { Authorization: `Bearer ${memoryToken}` }
          : {}),
        // The mesh service requires token authentication when configured.
        ...(memoryToken && envelope.to === "agent-mesh-mcp"
          ? { Authorization: `Bearer ${memoryToken}` }
          : {}),
      },
      body: JSON.stringify(envelope),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readBodyCapped(delegated, 65536);
    const contentType = delegated.headers.get("content-type") ?? "application/json";
    try {
      return { status: delegated.status, body: JSON.parse(text) as unknown, contentType };
    } catch {
      return { status: delegated.status, body: text, contentType, isRawText: true };
    }
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 503,
      contentType: "application/json",
      body: {
        error: "local node unreachable",
        reason: isTimeout ? "timed out reaching a service on this PC" : message.slice(0, 300),
      },
    };
  }
}

export function parseDelegateEnvelope(body: unknown): DelegateEnvelope | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "envelope must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  const id = record.id;
  const from = record.from;
  const to = record.to;
  const capability = record.capability;
  const action = record.action;
  const payload = record.payload ?? {};
  if (record.v !== 1) return { error: "envelope v must be 1" };
  if (typeof id !== "string" || id.length < 8 || id.length > 80) return { error: "envelope id is invalid" };
  if (typeof from !== "string" || from.length < 2 || from.length > 80) return { error: "envelope from is invalid" };
  if (typeof to !== "string" || to.length < 2 || to.length > 80) return { error: "envelope to is invalid" };
  if (typeof capability !== "string" || capability.length < 2 || capability.length > 40) {
    return { error: "envelope capability is invalid" };
  }
  if (typeof action !== "string" || action.length < 2 || action.length > 40) {
    return { error: "envelope action is invalid" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "envelope payload must be an object" };
  }
  return { v: 1, id, from, to, capability, action, payload: payload as Record<string, unknown> };
}

export function isDelegateEnvelope(value: DelegateEnvelope | { error: string }): value is DelegateEnvelope {
  return !("error" in value);
}

export interface ApprovePayload {
  proposalId: string;
  nonce?: string;
  reason?: string;
  action?: "approve" | "reject";
  biometricAttestation?: string | Record<string, unknown>;
}

import { canonicalJsonStringify } from "@exocortex/core";
export { canonicalJsonStringify };


export async function forwardApprove(
  approval: ApprovePayload,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<{ status: number; body: unknown; contentType: string; isRawText?: boolean }> {
  const attestationStr = approval.biometricAttestation
    ? (typeof approval.biometricAttestation === "string"
        ? approval.biometricAttestation
        : canonicalJsonStringify(approval.biometricAttestation))
    : undefined;

  const envelope: DelegateEnvelope = {
    v: 1,
    id: `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: GATEWAY_NODE,
    to: "autonomous-triad",
    capability: "intent",
    action: approval.action ?? "approve",
    payload: {
      proposal_id: approval.proposalId,
      nonce: approval.nonce,
      reason: approval.reason ?? "Biometric approval via Pieces Mobile Gateway",
      ...(attestationStr ? { biometric_attestation: attestationStr } : {}),
    },
  };
  return relayEnvelope(envelope, env, fetchImpl, timeoutMs);
}

