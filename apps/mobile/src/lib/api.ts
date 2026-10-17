import { Preferences } from "@capacitor/preferences";
import { getConnectionTargets } from "./config";

export class ProxyNotConfiguredError extends Error {
  constructor() {
    super("Proxy is not configured — complete Setup first.");
    this.name = "ProxyNotConfiguredError";
  }
}

// Both the LAN proxy and the remote gateway return 503 specifically when the
// home node (PC running PiecesOS) is unreachable within their timeout — a
// deliberate fail-closed design, not a generic server error. Surfacing it
// distinctly lets the UI say "PC is offline" instead of a raw error string.
export class HomeNodeUnreachableError extends Error {
  constructor(detail?: string) {
    super(detail ?? "The home PC is offline or unreachable right now.");
    this.name = "HomeNodeUnreachableError";
  }
}

// The proxy/gateway enforce their own 5s upstream timeout and return 503 when
// PiecesOS is unreachable — but that only helps once our request actually
// reaches them. A stalled TCP handshake or dropped packet on the phone's own
// network never gets a response at all, so fetch() hangs indefinitely with
// no client-side abort. This client-side timeout ensures every call fails
// closed instead of leaving the UI stuck on "Checking…" forever.
const CLIENT_FETCH_TIMEOUT_MS = 10000;
// /mobile/recent/assets proxies to PiecesOS's /assets, which the proxy itself
// allows up to 30s for (a real store scan on a non-trivial asset count is
// legitimately slow — see ASSETS_TIMEOUT_MS in apps/proxy/src/server.ts).
// The client timeout must exceed that, or it aborts requests the server was
// still on track to complete successfully.
const ASSETS_CLIENT_FETCH_TIMEOUT_MS = 35000;
// /mobile/ask falls back to a local Ollama call (grounded in Pieces data)
// when PiecesOS itself can't answer — CPU-bound local generation measured
// 23.8s-63.9s in testing against OLLAMA_TIMEOUT_MS=90000 in
// apps/proxy/src/ollama-fallback.ts. Must exceed that ceiling or the client
// aborts requests the server was still on track to complete.
const ASK_CLIENT_FETCH_TIMEOUT_MS = 100000;
// /mobile/summaries makes one /workstream_summary/{id} call plus up to a few
// parallel /annotation/{id} calls PER summary (see apps/proxy/src/summaries.ts) —
// measured 0.4s for 21 summaries against the local PiecesOS install, but that's
// with an unusually low PIECES_BASE_URL round-trip; give real headroom for a
// slower network path rather than assume the default 10s always covers it.
const SUMMARIES_CLIENT_FETCH_TIMEOUT_MS = 30000;

// Plan A (LAN) -> Plan B (remote gateway) failover, resilient multi-target transport.
// Tries each configured target in order. A target is abandoned and the next
// one tried on: connection error / timeout, 401 or 403 (stale token for that
// profile — the OTHER profile may still be valid), or any 5xx. A 503 from the
// LAST target surfaces as HomeNodeUnreachableError; a non-auth 4xx (e.g. 404,
// 400) is returned as-is since retrying a different host won't help.
async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  let targets = await getConnectionTargets();
  if (targets.length === 0) throw new ProxyNotConfiguredError();
  // Approval/proposal routes exist only on the exocortex gateway (Plan B). The Plan A LAN proxy answers
  // 404 for them, and a 404 is not failed over, so skip it whenever a gateway is configured.
  if (path.startsWith("/v3/") || path === "/network/approve") {
    const gateway = targets.filter((t) => t.mode === "remote");
    if (gateway.length > 0) targets = gateway;
  }

  const baseTimeout = path.startsWith("/mobile/recent/assets")
    ? ASSETS_CLIENT_FETCH_TIMEOUT_MS
    : path.startsWith("/mobile/ask")
      ? ASK_CLIENT_FETCH_TIMEOUT_MS
      : path.startsWith("/mobile/summaries")
        ? SUMMARIES_CLIENT_FETCH_TIMEOUT_MS
        : CLIENT_FETCH_TIMEOUT_MS;

  let lastError: unknown = new HomeNodeUnreachableError();

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const isLast = i === targets.length - 1;
    // Probe the LAN target fast when a remote fallback exists, so being away
    // from home doesn't cost the full timeout before failing over. Not on
    // /mobile/ask — its long timeout is the whole point of that route.
    const probe =
      targets.length > 1 && i === 0 && target.mode === "lan" && !path.startsWith("/mobile/ask");
    const timeoutMs = probe ? 2500 : baseTimeout;

    let res: Response;
    try {
      res = await fetch(`${target.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError =
        err instanceof Error && err.name === "TimeoutError"
          ? new HomeNodeUnreachableError("Request timed out reaching the proxy.")
          : err;
      continue; // network error / timeout -> try next target
    }

    if (res.status === 401 || res.status === 403) {
      lastError = new Error(`Auth rejected by ${target.mode} target: HTTP ${res.status}`);
      if (!isLast) continue;
      return res; // last target: let the caller see the 401
    }
    if (res.status === 503) {
      const body = await res.json().catch(() => null);
      lastError = new HomeNodeUnreachableError(body?.reason ?? body?.error);
      if (!isLast) continue;
      throw lastError;
    }
    if (res.status >= 500) {
      lastError = new Error(`${target.mode} target error: HTTP ${res.status}`);
      if (!isLast) continue;
      return res;
    }

    return res; // ok, or a non-auth 4xx that failover can't fix
  }

  throw lastError;
}

export type AskResult =
  | { status: "answered"; answers: unknown }
  | { status: "unavailable"; reason: string; likelyNoModelConfigured?: boolean };

// One retry, after a short delay, specifically for HomeNodeUnreachableError.
// Real, reproducible cause: right after the gateway process restarts,
// Tailscale needs to re-establish its direct path to the home PC - the
// FIRST request in that window can take the full upstream timeout and fail,
// while every request after it is fast (sub-second in testing, 2026-08-29).
// A startup warm-up ping on the gateway itself covers most of this, but a
// client-side retry is the backstop for whatever window it doesn't catch
// (e.g. the phone's own request racing the warm-up). Retries only ONE time
// and only for this specific error - a real "PC is off" case still surfaces
// normally after the retry also fails, rather than hanging or looping.
//
// Deliberately NOT applied to ask() - its own client timeout is already
// 100s (ASK_CLIENT_FETCH_TIMEOUT_MS, covering the Ollama fallback path), so
// stacking a full retry on top would make the worst case ~205s before the
// user sees anything. A slow-but-generous single attempt beats doubling an
// already-long wait; the user's own Retry button covers the rare case where
// Ask specifically hits the restart window. Applied only to the fast routes
// (status ~10s, summaries ~30s) where a second attempt stays reasonable.
const HOME_UNREACHABLE_RETRY_DELAY_MS = 5000;
async function withHomeUnreachableRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof HomeNodeUnreachableError)) throw err;
    await new Promise((resolve) => setTimeout(resolve, HOME_UNREACHABLE_RETRY_DELAY_MS));
    return await fn();
  }
}

// Lightweight "last known good" cache for screens where stale-but-real data
// beats a blank error screen during a transient home-offline blip (e.g. the
// PC briefly asleep, a router hiccup). Never used to mask errors — callers
// still see the fresh call's outcome; this only supplies a fallback value
// alongside it. Preferences (not localStorage/memory) so it survives an app
// restart, not just a screen navigation.
const CACHE_KEY_PREFIX = "pieces-android:cache:";

async function readCache<T>(key: string): Promise<{ value: T; at: string } | null> {
  try {
    const { value } = await Preferences.get({ key: CACHE_KEY_PREFIX + key });
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function writeCache<T>(key: string, value: T): Promise<void> {
  try {
    await Preferences.set({
      key: CACHE_KEY_PREFIX + key,
      value: JSON.stringify({ value, at: new Date().toISOString() }),
    });
  } catch {
    // Best-effort - a failed cache write should never break the real call.
  }
}

/** Unauthenticated liveness check — safe to call before Setup is complete. */
export async function checkProxyHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/mobile/health`, {
      signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

export interface StatusResult {
  health: string;
  version: string;
}

async function getStatusUncached(): Promise<StatusResult> {
  const [healthRes, versionRes] = await Promise.all([
    authedFetch("/mobile/status/health"),
    authedFetch("/mobile/status/version"),
  ]);
  if (!healthRes.ok) throw new Error(`Status health check failed: HTTP ${healthRes.status}`);
  if (!versionRes.ok) throw new Error(`Status version check failed: HTTP ${versionRes.status}`);
  return { health: await healthRes.text(), version: await versionRes.text() };
}

/**
 * The real end-to-end check: this round-trips through proxy/gateway all the
 * way to PiecesOS and back, unlike checkProxyHealth (which only proves the
 * gateway process itself answers). Setup's "Connected" and Status's own
 * display both use this - a gateway that's up but can't reach PiecesOS is
 * NOT "connected" from the user's point of view, even though the earlier
 * unauthenticated health check would say otherwise.
 */
export async function getStatus(): Promise<StatusResult> {
  const result = await withHomeUnreachableRetry(getStatusUncached);
  await writeCache("status", result);
  return result;
}

/** Last successful getStatus() result, if any - for a stale-data fallback display. */
export async function getCachedStatus(): Promise<{ value: StatusResult; at: string } | null> {
  return readCache<StatusResult>("status");
}

export interface WorkstreamSummary {
  id: string;
  name: string;
  created: string;
  text: string;
}

/**
 * "What got done" — PiecesOS's own AI-generated workstream rollups, not raw
 * captured telemetry. The proxy filters each summary down to its SUMMARY (or
 * DESCRIPTION) annotation only; the broader HIERARCHICAL_PROFILE_SUMMARY
 * annotation every summary also carries never reaches this client.
 */
async function getWorkstreamSummariesUncached(): Promise<WorkstreamSummary[]> {
  const res = await authedFetch("/mobile/summaries");
  if (!res.ok) throw new Error(`Summaries fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.summaries) ? body.summaries : [];
}

export async function getWorkstreamSummaries(): Promise<WorkstreamSummary[]> {
  const result = await withHomeUnreachableRetry(getWorkstreamSummariesUncached);
  await writeCache("summaries", result);
  return result;
}

/** Last successful getWorkstreamSummaries() result, if any - for a stale-data fallback display. */
export async function getCachedWorkstreamSummaries(): Promise<{ value: WorkstreamSummary[]; at: string } | null> {
  return readCache<WorkstreamSummary[]>("summaries");
}

export async function ask(query: string): Promise<AskResult> {
  const res = await authedFetch("/mobile/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Ask failed: HTTP ${res.status}`);
  return res.json();
}

export interface ProposalApprovalPayload {
  proposalId: string;
  nonce: string;
  action?: "approve" | "reject";
  reason?: string;
  /** Device-bound signature from the Keystore approval key (see approvalKey.ts). */
  biometricAttestation?: { v: 1; method: "biometric"; ts: number; sig: string };
}

export interface ProposalApprovalResult {
  ok: boolean;
  status: string;
  proposal_id?: string;
  upstream_status?: number;
  upstream_notified?: boolean;
  error?: string;
  release?: {
    ok: boolean;
    result: {
      status: string;
      proposalId: string;
      releasedPayload: unknown;
    };
  };
}

export async function submitProposalApproval(
  approval: ProposalApprovalPayload
): Promise<ProposalApprovalResult> {
  const res = await authedFetch("/network/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(approval),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      status: body?.status || "release_failed",
      upstream_status: res.status,
      error: body?.error || `HTTP ${res.status}`,
    };
  }
  return body as ProposalApprovalResult;
}

export async function postApprovalKeyChallenge(): Promise<string> {
  const res = await authedFetch("/v3/devices/approval-key/challenge", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.challenge !== "string") throw new Error(body?.error || `HTTP ${res.status}`);
  return body.challenge;
}

export async function postApprovalKey(
  payload: { pubkey_b64: string; challenge: string; signature_b64: string; attestation_chain: string[] },
  enrollToken: string
): Promise<void> {
  const res = await authedFetch("/v3/devices/approval-key", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Enroll-Token": enrollToken },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
}

export interface PendingProposal {
  proposalId: string;
  candidateId: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  requiresBiometric: boolean;
  approvalNonce: string;
  expiresAt: number;
  actionPayload?: Record<string, unknown>;
  shadow?: boolean;
}

function isPendingProposal(p: unknown): p is PendingProposal {
  const o = p as Record<string, unknown> | null;
  return (
    !!o &&
    typeof o.proposalId === "string" &&
    typeof o.candidateId === "string" &&
    typeof o.approvalNonce === "string" &&
    typeof o.expiresAt === "number" &&
    (o.riskLevel === "low" || o.riskLevel === "medium" || o.riskLevel === "high")
  );
}

/** Proposals the daemon surfaced to this device that are still awaiting approval. */
export async function getPendingProposals(options?: { includeShadow?: boolean }): Promise<PendingProposal[]> {
  const url = options?.includeShadow ? "/v3/proposals/pending?include_shadow=1" : "/v3/proposals/pending";
  const res = await authedFetch(url);
  if (!res.ok) throw new Error(`Pending proposals fetch failed: HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body?.proposals)) return [];
  return body.proposals.filter(isPendingProposal).map((p: PendingProposal) => ({
    ...p,
    summary: typeof p.summary === "string" ? p.summary : "",
    requiresBiometric: p.requiresBiometric === true,
    shadow: p.shadow === true,
  }));
}

/** Dedicated fetcher for un-labeled shadow proposals from SQLite. */
export async function getPendingShadowProposals(): Promise<PendingProposal[]> {
  const res = await authedFetch("/v3/shadow/pending");
  if (!res.ok) throw new Error(`Pending shadow proposals fetch failed: HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body?.proposals)) return [];
  return body.proposals.filter(isPendingProposal).map((p: PendingProposal) => ({
    ...p,
    summary: typeof p.summary === "string" ? p.summary : "",
    requiresBiometric: p.requiresBiometric === true,
    shadow: true,
  }));
}

export async function postPushToken(token: string): Promise<void> {
  const res = await authedFetch("/v3/devices/push-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, platform: "fcm" }),
  });
  if (!res.ok) throw new Error(`Push token registration failed: HTTP ${res.status}`);
}

export interface NetworkMapNode {
  id: string;
  role: string;
  delegate: boolean;
  upstream?: string;
}

export interface NetworkMapResult {
  transport: string;
  nodes: NetworkMapNode[];
}

export async function getNetworkMap(): Promise<NetworkMapResult> {
  const res = await authedFetch("/network/map");
  if (!res.ok) throw new Error(`Network map fetch failed: HTTP ${res.status}`);
  return res.json();
}

export type ShadowLabel = "wanted" | "not_wanted" | "already_did" | "ignored";

export interface SubmitShadowLabelOptions {
  source?: "tap" | "inferred";
  latencyMs?: number;
  actual?: unknown;
  /** Single-use biometric signature over the label (see signLabel). Without it the server stores the label as "inferred". */
  attestation?: { v: 1; method: "biometric"; ts: number; sig: string; nonce: string };
}

export async function submitShadowLabel(
  proposalId: string,
  label: ShadowLabel,
  options?: SubmitShadowLabelOptions,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await authedFetch("/v3/shadow/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposal_id: proposalId,
        label,
        source: options?.source ?? "tap",
        latency_ms: options?.latencyMs,
        actual: options?.actual,
        attestation: options?.attestation,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const errorMsg = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
      return { ok: false, error: errorMsg };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ShadowMetricsQuery {
  days?: number;
  threshold?: number;
  minLabels?: number;
  baselinePrecision?: number;
}

export interface ShadowMetricsResult {
  metrics: {
    precision: number | null;
    wilsonLower: number | null;
    focusRegret: number;
    totalEvaluated: number;
    wanted: number;
    notWanted: number;
    tapped: number;
    inferred: number;
    heuristicScorer: boolean;
  };
  automated_verdict: string;
  breaker_tripped: boolean;
  canonical_breaker_tripped: boolean;
  effective_shadow: boolean;
}

export async function getShadowMetrics(query?: ShadowMetricsQuery): Promise<ShadowMetricsResult> {
  const params = new URLSearchParams();
  if (query?.days !== undefined && Number.isFinite(query.days)) params.set("days", String(query.days));
  if (query?.threshold !== undefined && Number.isFinite(query.threshold)) params.set("threshold", String(query.threshold));
  if (query?.minLabels !== undefined && Number.isFinite(query.minLabels)) params.set("min_labels", String(query.minLabels));
  if (query?.baselinePrecision !== undefined && Number.isFinite(query.baselinePrecision)) params.set("baseline_precision", String(query.baselinePrecision));

  const qs = params.toString();
  const url = `/v3/shadow/metrics${qs ? `?${qs}` : ""}`;
  const res = await authedFetch(url);
  if (!res.ok) {
    throw new Error(`Shadow metrics fetch failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<ShadowMetricsResult>;
}



export interface PreCognitiveStatus {
  deviceId: string;
  wakeThresholdMs: number;
  urgencyIntent: "CASUAL" | "PREPARED" | "HIGH_URGENCY" | (string & {});
  wakeupLatencyMs: number;
  hesitationScore: number;
  isPreStaged: boolean;
  preStagedProposalId?: string;
  calibrated: boolean;
  sampleCount: number;
  source: "device" | "global" | "default";
  futureSkewDrops?: number;
}

export interface PreCognitiveTelemetryPayload {
  timestamp?: number;
  screen_state?: "SCREEN_ON" | "SCREEN_OFF";
  vibration?: boolean;
  dwell_ms?: number;
  touch_duration_ms?: number;
  synthetic?: boolean;
}

export interface PreCognitiveCalibrateResult {
  wakeThresholdMs: number;
  sampleCount: number;
  calibrated: boolean;
  minSamples: number;
  error?: string;
}

export async function getPrecognitiveStatus(): Promise<PreCognitiveStatus> {
  const res = await authedFetch("/v3/precognitive/status");
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Precognitive status failed: HTTP ${res.status}${errorBody ? ` (${errorBody})` : ""}`);
  }
  const body = (await res.json()) as { ok?: boolean; status?: PreCognitiveStatus };
  if (!body.status) throw new Error("Malformed precognitive status response");
  return body.status;
}

export async function sendPrecognitiveTelemetry(
  payload: PreCognitiveTelemetryPayload
): Promise<PreCognitiveStatus> {
  const res = await authedFetch("/v3/precognitive/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Precognitive telemetry failed: HTTP ${res.status}${errorBody ? ` (${errorBody})` : ""}`);
  }
  const body = (await res.json()) as { ok?: boolean; status?: PreCognitiveStatus };
  if (!body.status) throw new Error("Malformed precognitive telemetry response");
  return body.status;
}

export async function calibratePrecognitive(minSamples?: number): Promise<PreCognitiveCalibrateResult> {
  const payload = minSamples !== undefined ? { min_samples: minSamples } : {};
  const res = await authedFetch("/v3/precognitive/calibrate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Precognitive calibration failed: HTTP ${res.status}${errorBody ? ` (${errorBody})` : ""}`);
  }
  const body = (await res.json()) as { ok?: boolean; result?: PreCognitiveCalibrateResult };
  if (!body.result) throw new Error("Malformed precognitive calibration response");
  return body.result;
}

export interface LivingGraphEntity {
  id: string;
  name: string;
  type: string;
  activation?: number;
}

export interface LivingGraphContextData {
  eventId: string;
  timestamp: number;
  matchedEntities: LivingGraphEntity[];
  activatedEntities: LivingGraphEntity[];
  subgraph?: {
    entities: LivingGraphEntity[];
    edges: Array<{ source: string; target: string; type: string; weight: number }>;
  };
  predictedNextStates: string[];
  recommendedActions: string[];
}

export interface LivingGraphStatus {
  cognitiveMode: string;
  entityCount: number;
  edgeCount: number;
  context: LivingGraphContextData | null;
  scopeRequired?: string;
}

export async function getLivingGraphContext(): Promise<LivingGraphStatus> {
  const res = await authedFetch("/v3/world-model/graph/context");
  if (res.status === 403) {
    return {
      cognitiveMode: "UNKNOWN",
      entityCount: 0,
      edgeCount: 0,
      context: null,
      scopeRequired: "admin:read",
    };
  }
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Graph context failed: HTTP ${res.status}${errorBody ? ` (${errorBody})` : ""}`);
  }
  const body = (await res.json()) as {
    ok?: boolean;
    cognitiveMode?: string;
    entityCount?: number;
    edgeCount?: number;
    context?: LivingGraphContextData | null;
  };
  return {
    cognitiveMode: body.cognitiveMode ?? "NORMAL",
    entityCount: body.entityCount ?? 0,
    edgeCount: body.edgeCount ?? 0,
    context: body.context ?? null,
  };
}

export interface FullGraphEntity {
  id: string;
  type: string;
  name: string;
  activation: number;
  lastActive: number;
  properties?: Record<string, unknown>;
}

export interface FullGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
  observedCount: number;
  lastObserved: number;
}

export interface FullLivingGraph {
  cognitiveMode: string;
  entityCount: number;
  edgeCount: number;
  entities: FullGraphEntity[];
  edges: FullGraphEdge[];
  scopeRequired?: string;
}

export async function getFullLivingGraph(): Promise<FullLivingGraph> {
  const res = await authedFetch("/v3/world-model/graph/full");
  if (res.status === 403) {
    return {
      cognitiveMode: "UNKNOWN",
      entityCount: 0,
      edgeCount: 0,
      entities: [],
      edges: [],
      scopeRequired: "admin:read",
    };
  }
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Full graph failed: HTTP ${res.status}${errorBody ? ` (${errorBody})` : ""}`);
  }
  const body = (await res.json()) as {
    ok?: boolean;
    cognitiveMode?: string;
    entityCount?: number;
    edgeCount?: number;
    entities?: FullGraphEntity[];
    edges?: FullGraphEdge[];
  };
  return {
    cognitiveMode: body.cognitiveMode ?? "NORMAL",
    entityCount: body.entityCount ?? (body.entities?.length ?? 0),
    edgeCount: body.edgeCount ?? (body.edges?.length ?? 0),
    entities: body.entities ?? [],
    edges: body.edges ?? [],
  };
}

export interface GraphStreamHandlers {
  onInit?: (data: { cognitiveMode: string; entityCount: number; edgeCount: number; timestamp: number }) => void;
  onPulse?: (data: { eventId: string; kind: string; matchedEntities: LivingGraphEntity[]; activatedEntities: LivingGraphEntity[]; timestamp: number }) => void;
  onPing?: (data: { cognitiveMode: string; timestamp: number }) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export function connectLivingGraphStream(handlers: GraphStreamHandlers): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const targets = await getConnectionTargets();
      if (targets.length === 0) {
        handlers.onError?.(new ProxyNotConfiguredError());
        return;
      }
      const localTarget = targets.find((t) => t.mode === "lan");
      const remoteTarget = targets.find((t) => t.mode === "remote");
      const target = localTarget ?? remoteTarget ?? targets[0];
      const url = `${target.baseUrl}/v3/world-model/graph/live`;

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${target.token}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        handlers.onError?.(new Error(`SSE connection failed: HTTP ${res.status}`));
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        handlers.onClose?.();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType = "message";
          const dataLines: string[] = [];

          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              dataLines.push(line.slice(6));
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5));
            }
          }

          if (dataLines.length > 0) {
            const rawData = dataLines.join("\n");
            let parsed: any = null;
            try {
              parsed = JSON.parse(rawData);
            } catch {
              // Non-json chunk
            }

            if (parsed) {
              if (eventType === "init") handlers.onInit?.(parsed);
              else if (eventType === "pulse") handlers.onPulse?.(parsed);
              else if (eventType === "ping") handlers.onPing?.(parsed);
            }
          }
        }
      }
      handlers.onClose?.();
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => {
    controller.abort();
  };
}

