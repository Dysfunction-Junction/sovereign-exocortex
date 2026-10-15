import { createServer } from "node:http";
import { timingSafeEqual, createPublicKey } from "node:crypto";
import { Agent, setGlobalDispatcher } from "undici";
import { findAllowedRoute } from "@pieces-android/allowlist";
import { verifyToken } from "./jwt.js";
import { canonicalJsonStringify, forwardApprove, forwardDelegate, isDelegateEnvelope, localNodes, parseDelegateEnvelope } from "./network.js";
import { defaultWorldModelHost } from "./world-model-host.js";
import { getDatabase } from "./db-host.js";
import { ShadowRecorder } from "./shadow-recorder.js";
import { defaultPredictionHost } from "./prediction-host.js";
import { defaultTriageHost } from "./triage-host.js";
import { dropKnownTelemetry } from "./telemetry-dedupe.js";
import { APPROVAL_TS_WINDOW_MS, ChallengeStore, approvalKeyMessage, parseP256Spki, verifyApprovalAttestation, verifyEcSignature, verifyLabelAttestation } from "./approval-attestation.js";
import { allowUnattestedKeys, verifyKeyAttestationChain } from "./key-attestation.js";
import { getRevokedAttestationSerials } from "./attestation-status.js";
import {
  buildPendingProposals,
  defaultPendingFetcher,
  defaultSpeculator,
  type PendingFetcher,
  type Speculator,
} from "./pending-proposals.js";
import { defaultPushNotifier } from "./push-notifier.js";
import { defaultRepoHealthWatcher } from "./repo-health.js";
import { applyShadowLabel, InferredOutcomeScheduler } from "./inferred-outcomes.js";
import { ExocortexDatabase, DeviceNotEnrolledError, DeviceRevokedError, EventIdConflictError } from "@exocortex/core/db";
import { isShadowLabel, type IngestReq, type DeviceRecord, type ShadowLabel } from "@exocortex/core";



// Observed in practice: a pooled keep-alive socket to the home proxy over
// Tailscale gets silently dropped (NAT/WireGuard idle timeout) without
// either side sending a FIN/RST. undici's default keep-alive behavior then
// tries to reuse that dead socket on the next fetch(), gets no response,
// and burns the full UPSTREAM_TIMEOUT_MS before failing - even though a
// FRESH connection to the exact same address succeeds in well under a
// second. This produced an intermittent 200/200/503 pattern that looked
// like a flaky tunnel but was actually a stale-socket-reuse bug. A short
// keepAliveTimeout forces undici to open a new socket well before Tailscale
// has a chance to drop the old one silently underneath it.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 4000, keepAliveMaxTimeout: 4000 }));

const PORT = Number(process.env.GATEWAY_PORT ?? 8788);
// Home PC's Tailscale IP, not its LAN IP - this gateway runs on a remote host
// off the home network entirely, and only the tailnet bridges the two.
const HOME_PROXY_BASE_URL = process.env.HOME_PROXY_BASE_URL;
// The Plan A proxy's own bearer token - this is a SECOND auth layer, distinct
// from the JWT below. Phone -> gateway is JWT; gateway -> home proxy is still
// the original Plan A bearer token. Never commit this value; it lives in the
// remote host's compose env only.
const HOME_PROXY_TOKEN = process.env.HOME_PROXY_TOKEN;
const JWT_SECRET = process.env.GATEWAY_JWT_SECRET;
// Default for routes with no documented worst case of their own. Several
// routes need MORE than this - see ROUTE_TIMEOUT_MS_OVERRIDES below. A flat
// 20s ceiling here previously killed slower routes before the proxy/PiecesOS
// even got a chance to finish - a real Plan B regression vs. Plan A, found
// 2026-08-29 while sweeping every route end to end. Each override's timeout
// tracks a specific documented ceiling elsewhere in the codebase - if that
// ceiling changes, this must change with it, or the bug just found comes
// back for that one route.
const UPSTREAM_TIMEOUT_MS = 20000;
const ROUTE_TIMEOUT_MS_OVERRIDES: Array<{ test: (method: string, pathname: string) => boolean; timeoutMs: number }> = [
  // ASSETS_TIMEOUT_MS in apps/proxy/src/server.ts is 30s (a real store scan
  // that scales with asset count).
  { test: (m, p) => m === "GET" && p === "/mobile/recent/assets", timeoutMs: 35000 },
  // /assets/search (recent/search's target) got the same ASSETS_TIMEOUT_MS
  // treatment as /assets itself on 2026-08-29 - same store, same scaling.
  { test: (m, p) => m === "GET" && p === "/mobile/recent/search", timeoutMs: 35000 },
  // ASK_CLIENT_FETCH_TIMEOUT_MS in apps/mobile/src/lib/api.ts is 100s,
  // covering the Ollama fallback path (measured 24-64s in practice).
  { test: (m, p) => m === "POST" && p === "/mobile/ask", timeoutMs: 105000 },
  // SUMMARIES_CLIENT_FETCH_TIMEOUT_MS in apps/mobile/src/lib/api.ts is 30s -
  // measured fast in practice (0.4s for 21 summaries) but that measurement
  // was against an unusually low PIECES_BASE_URL round-trip; give the same
  // headroom the client itself already assumes.
  { test: (m, p) => m === "GET" && p === "/mobile/summaries", timeoutMs: 32000 },
];
function upstreamTimeoutFor(method: string, pathname: string): number {
  return ROUTE_TIMEOUT_MS_OVERRIDES.find((r) => r.test(method, pathname))?.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
}

if (process.env.NODE_ENV !== "test") {
  if (!JWT_SECRET) {
    console.error("GATEWAY_JWT_SECRET is not set. Refusing to start.");
    process.exit(1);
  }
  if (!HOME_PROXY_BASE_URL) {
    console.error("HOME_PROXY_BASE_URL is not set (expected the PC's Tailscale IP, e.g. http://100.x.x.x:8787).");
    process.exit(1);
  }
  if (!HOME_PROXY_TOKEN) {
    console.error("HOME_PROXY_TOKEN is not set (the Plan A proxy's bearer token).");
    process.exit(1);
  }
}


// Capacitor's WebView makes requests from its own origin (typically
// https://localhost), not the gateway's own origin - without this header,
// the WebView's fetch() rejects immediately once it sees the response has no
// CORS allowance, even though the network request itself succeeded. This is
// why "could not reach proxy" showed instantly despite curl/browser working
// fine from the same network: curl and a plain browser tab don't enforce
// CORS, but a WebView's fetch() does.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Enroll-Token",
};

type AttestationCandidate =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "val"; value: string | Record<string, unknown> };

function parseAttestationCandidate(raw: unknown): AttestationCandidate {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw === "string") {
    if (raw.trim().length === 0) return { kind: "invalid" };
    return { kind: "val", value: raw };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return { kind: "invalid" };
    return { kind: "val", value: obj };
  }
  return { kind: "invalid" };
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

function sendInternalError(res: import("node:http").ServerResponse, message: string, err: unknown) {
  console.error(`[daemon] ${message}:`, err);
  sendJson(res, 500, { error: message });
}

/**
 * Lazily attach the shadow recorder on first event or observation (no DB side effects at import time).
 * Env is read once at attach; changing SHADOW or EXOCORTEX_SHADOW_RECORD needs a restart.
 */
function ensureShadowRecorder(): void {
  if (process.env.EXOCORTEX_SHADOW_RECORD === "0" || defaultWorldModelHost.shadowRecordingSettled) return;
  try {
    defaultWorldModelHost.setShadowRecorder(
      new ShadowRecorder(getDatabase(), { shadow: process.env.SHADOW !== "0" }),
    );
    const people = defaultWorldModelHost.seedCommsFromPastEvents(getDatabase());
    if (people) console.log(`[life-graph] seeded ${people.people} people from ${people.events} past calls and texts`);
    const seeded = defaultWorldModelHost.seedFromPastEvents(getDatabase());
    if (seeded) console.log(`[life-graph] seeded from ${seeded.sessions} past sessions: ${seeded.topics} topics, ${seeded.persons} people, ${seeded.edges} edges`);
  } catch (err) {
    console.error("[shadow-recorder] disabled:", err instanceof Error ? err.message : err);
    defaultWorldModelHost.disableShadowRecording();
  }
}

/**
 * Validates and atomically records a ground-truth shadow label to both the shadow_labels
 * table and the immutable hash-chained event log. Authoritatively enforces source placement.
 */
const approvalKeyChallenges = new ChallengeStore();

/** Scopes /v3/devices/enroll may grant. "admin*" is only ever granted from the PC (grant-scope-cli.ts). */
export const ENROLL_SCOPE_ALLOWLIST: Record<string, readonly string[]> = {
  android: ["telemetry:write", "approval:write"],
  windows: ["telemetry:write", "approval:write", "admin:read"],
  linux: ["telemetry:write", "approval:write", "admin:read"],
};

let pendingFetcher: PendingFetcher = defaultPendingFetcher;
/** Test hook: replace how registry nonces are fetched. */
export function setPendingFetcherForTest(f: PendingFetcher | null): void {
  pendingFetcher = f ?? defaultPendingFetcher;
  // A faked fetcher means no registry-app: do not speculate against the network unless a test asks to.
  pendingSpeculator = f ? null : defaultSpeculator;
}

let pendingSpeculator: Speculator | null = defaultSpeculator;
/** Test hook: replace how our proposals are speculated into registry-app (null disables). */
export function setPendingSpeculatorForTest(sp: Speculator | null): void {
  pendingSpeculator = sp;
}

/** A tap label needs a valid, single-use device-signed attestation; everything else is "inferred". */
function labelSource(
  db: ExocortexDatabase,
  deviceId: string,
  proposalId: string,
  label: string,
  attestation: unknown,
): "tap" | "inferred" {
  if (attestation === undefined || attestation === null) return "inferred";
  const dev = db.getDevice(deviceId);
  if (!dev || dev.revoked_at) return "inferred";
  const v = verifyLabelAttestation(attestation, { deviceId, proposalId, label }, dev.pubkey_spki, Boolean(dev.key_attested));
  if (!v.ok) return "inferred";
  try {
    if (!db.consumeLabelAttestationNonce(deviceId, v.nonce, v.ts + APPROVAL_TS_WINDOW_MS)) return "inferred";
  } catch (err) {
    console.warn("[shadow-label] could not consume label attestation nonce; recording as inferred:", err);
    return "inferred";
  }
  return "tap";
}

export const defaultInferredOutcomeScheduler = new InferredOutcomeScheduler({
  getDb: () => getDatabase(),
  intervalMs: Number(process.env.EXOCORTEX_INFER_INTERVAL_MS) || 15 * 60 * 1000,
});


export const server = createServer(async (req, res) => {

  // Fixed base: a malformed attacker-supplied Host header must not throw out of this async handler (unhandled rejection).
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendJson(res, 400, { error: "malformed request URL" });
    return;
  }
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Unauthenticated liveness check for the gateway process itself - does NOT
  // prove the home node is reachable, just that this service is up. The
  // mobile app's Setup screen should treat this as "gateway is up", separate
  // from an actual proxied call succeeding.
  if (method === "GET" && url.pathname === "/mobile/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Device enrollment endpoint: registers device with public key and scopes into v3 SQLite database
  if (method === "POST" && url.pathname === "/v3/devices/enroll") {
    const authHeader = req.headers.authorization;
    const enrollToken = process.env.GATEWAY_ENROLL_TOKEN;
    if (!enrollToken) {
      // Fail closed: never fall back to a well-known default enrollment secret.
      sendJson(res, 401, { error: "unauthorized: enrollment disabled (GATEWAY_ENROLL_TOKEN not set)" });
      return;
    }
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const bearerBuf = Buffer.from(bearer, "utf8");
    const tokenBuf = Buffer.from(enrollToken, "utf8");
    const isAuth = bearerBuf.length === tokenBuf.length && timingSafeEqual(bearerBuf, tokenBuf);
    if (!isAuth) {
      sendJson(res, 401, { error: "unauthorized: invalid enrollment token" });
      return;
    }

    try {
      const raw = await readBody(req, 64 * 1024);
      let decoded: unknown;
      try {
        decoded = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        sendJson(res, 400, { error: "enrollment body must be a JSON object" });
        return;
      }
      const dev = decoded as any;
      if (typeof dev.device_id !== "string" || dev.device_id.length === 0 || dev.device_id.length > 128) {
        sendJson(res, 400, { error: "device_id must be a string of 1-128 chars" });
        return;
      }
      if (typeof dev.name !== "string" || dev.name.length === 0 || dev.name.length > 128) {
        sendJson(res, 400, { error: "name must be a string of 1-128 chars" });
        return;
      }
      if (!["android", "windows", "linux"].includes(dev.platform)) {
        sendJson(res, 400, { error: "invalid platform ('android'|'windows'|'linux')" });
        return;
      }

      const pubkeyB64 = typeof dev.pubkey_b64 === "string" ? dev.pubkey_b64 : "";
      if (!pubkeyB64) {
        sendJson(res, 400, { error: "missing or invalid pubkey_b64" });
        return;
      }

      const spki = Buffer.from(pubkeyB64, "base64");
      let pubkeyObj: any;
      try {
        pubkeyObj = createPublicKey({ key: spki, format: "der", type: "spki" });
      } catch {
        sendJson(res, 400, { error: "invalid pubkey_spki: not a valid SPKI public key" });
        return;
      }
      if (pubkeyObj.asymmetricKeyType !== "ec" && pubkeyObj.asymmetricKeyType !== "ed25519") {
        sendJson(res, 400, { error: "pubkey must be EC or Ed25519" });
        return;
      }

      const db = getDatabase();
      if (db.getDevice(dev.device_id)) {
        sendJson(res, 409, { error: "device already enrolled" });
        return;
      }

      let scopes: string[] = ["telemetry:write"];
      if (dev.scopes !== undefined && dev.scopes !== null) {
        if (!Array.isArray(dev.scopes)) {
          sendJson(res, 400, { error: "scopes must be an array of strings" });
          return;
        }
        if (dev.scopes.length > 0) {
          const allowed = ENROLL_SCOPE_ALLOWLIST[dev.platform] ?? [];
          const offending = dev.scopes.filter((s: unknown) => typeof s !== "string" || !allowed.includes(s));
          if (offending.length > 0) {
            sendJson(res, 400, {
              error: `scopes not allowed for platform ${dev.platform}: ${offending.map((s: unknown) => String(s)).join(", ")}`,
              offending_scopes: offending.map((s: unknown) => String(s)),
              allowed_scopes: allowed,
            });
            return;
          }
          scopes = Array.from(new Set<string>(dev.scopes));
        }
      }

      try {
        db.registerDevice({
          device_id: dev.device_id,
          name: dev.name,
          platform: dev.platform,
          pubkey_spki: new Uint8Array(spki),
          // Never client-asserted: only /v3/devices/approval-key (verified attestation chain) sets this.
          key_attested: 0,
          scopes,
          enrolled_at: Date.now(),
          revoked_at: null,
        });
      } catch (regErr: any) {
        if (regErr?.message?.includes("UNIQUE constraint") || regErr?.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          sendJson(res, 409, { error: "device already enrolled" });
          return;
        }
        throw regErr;
      }

      sendJson(res, 200, { ok: true, enrolled: dev.device_id });
    } catch (err) {
      sendInternalError(res, "failed to enroll device", err);
    }
    return;
  }

  const secret = JWT_SECRET ?? process.env.GATEWAY_JWT_SECRET;
  if (!secret) {
    sendJson(res, 503, { error: "gateway authentication is not configured" });
    return;
  }
  const auth = verifyToken(req.headers.authorization, secret);

  if (!auth.ok) {
    sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
    return;
  }

  if (method === "GET" && url.pathname === "/network/map") {
    sendJson(res, 200, {
      transport: "tailscale",
      nodes: localNodes(),
    });
    return;
  }

  if (method === "GET" && url.pathname === "/world-model/state") {
    sendJson(res, 200, {
      ok: true,
      state: defaultWorldModelHost.getStatus(),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/world-model/telemetry") {
    try {
      const raw = await readBody(req, 64 * 1024);
      const decoded = raw.length === 0 ? {} : JSON.parse(raw);
      const signals = (decoded.signals ?? decoded) as import("@exocortex/world-model").ContextualSignals;
      const result = defaultWorldModelHost.ingestTelemetry(signals);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 400, { error: "failed to ingest telemetry", reason: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/world-model/observation") {
    try {
      const raw = await readBody(req, 64 * 1024);
      const decoded = raw.length === 0 ? {} : JSON.parse(raw);
      const obs = (decoded.observation ?? decoded) as import("@exocortex/world-model").SystemObservation;
      ensureShadowRecorder();
      const result = defaultWorldModelHost.ingestObservation(obs);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 400, { error: "failed to ingest observation", reason: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // --- Sovereign Exocortex Architecture & Schema v3 Event Store ---

  if (method === "POST" && url.pathname === "/v3/events") {
    try {
      const raw = await readBody(req, 1024 * 1024);
      let decoded: unknown;
      try {
        decoded = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const reqObj = decoded as IngestReq;
      if (!reqObj || typeof reqObj.device_id !== "string" || !Array.isArray(reqObj.events)) {
        sendJson(res, 400, { error: "invalid IngestReq: missing device_id or events array" });
        return;
      }

      // Security: bind device_id in request payload to the authenticated JWT deviceId
      if (reqObj.device_id !== auth.deviceId) {
        sendJson(res, 403, { error: "forbidden: device_id mismatch with authenticated token" });
        return;
      }

      if (reqObj.events.length === 0 || reqObj.events.length > 100) {
        sendJson(res, 400, { error: "events batch must contain between 1 and 100 events" });
        return;
      }

      for (const ev of reqObj.events) {
        if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
          sendJson(res, 400, { error: "invalid event in batch: event must be a JSON object" });
          return;
        }
        if (typeof ev.event_id !== "string" || ev.event_id.length === 0 || ev.event_id.length > 128) {
          sendJson(res, 400, { error: "invalid event in batch: event_id must be a string of 1-128 chars" });
          return;
        }
        if (typeof ev.kind !== "string" || ev.kind.length === 0 || ev.kind.length > 128) {
          sendJson(res, 400, { error: "invalid event in batch: kind must be a string of 1-128 chars" });
          return;
        }
        if (!Number.isSafeInteger(ev.ts_device) || ev.ts_device <= 0) {
          sendJson(res, 400, { error: "invalid event in batch: ts_device must be a positive safe integer" });
          return;
        }
        if (ev.schema_ver !== undefined && (!Number.isSafeInteger(ev.schema_ver) || ev.schema_ver <= 0)) {
          sendJson(res, 400, { error: "invalid event in batch: schema_ver must be a positive safe integer" });
          return;
        }
        if (typeof ev.payload !== "object" || ev.payload === null || Array.isArray(ev.payload)) {
          sendJson(res, 400, { error: "invalid event in batch: payload must be a plain JSON object" });
          return;
        }
      }

      const db = getDatabase();
      // Telemetry the log already holds (the phone re-sends old SMS with fresh ids) is dropped, not re-stored.
      const deduped = dropKnownTelemetry(db, reqObj);
      const stored =
        deduped.req.events.length > 0
          ? db.ingestBatch(deduped.req)
          : { insertedCount: 0, duplicateCount: 0, events: [] as ReturnType<typeof db.ingestBatch>["events"] };
      const result = { ...stored, duplicateCount: stored.duplicateCount + deduped.skipped };
      if (result.events.length > 0) {
        try {
          // Attach the shadow recorder to the normal append-only event pipeline. The host
          // maps only explicitly supported observation signals into shadow proposals.
          ensureShadowRecorder();
          defaultWorldModelHost.onEventsAppended(result.events, db);
        } catch (wmErr) {
          console.error("[world-model-host] event batch ingest hook error:", wmErr);
        }

        // Next-action prediction log (shadow only). Isolated: it must never break event ingest.
        if (process.env.EXOCORTEX_PREDICTIONS !== "0") {
          try {
            defaultPredictionHost.onEventsAppended(result.events, db);
          } catch (predErr) {
            console.error("[prediction-host] event batch hook error:", predErr instanceof Error ? predErr.message : predErr);
          }
        }

        // Local-LLM triage of telemetry text (shadow only, async, off the ingest path).
        try {
          defaultTriageHost.onEventsAppended(result.events, db);
        } catch (triageErr) {
          console.error("[triage-host] event batch hook error:", triageErr instanceof Error ? triageErr.message : triageErr);
        }

        // Synchronize any shadow label events into shadow_labels table
        for (const ev of result.events) {
          if (ev.kind === "label") {
            try {
              const payload = JSON.parse(ev.payload);
              if (payload?.proposal_id && isShadowLabel(payload?.label)) {
                const source = payload?.source === "inferred"
                  ? "inferred"
                  : labelSource(db, auth.deviceId, String(payload.proposal_id), payload.label, payload.attestation);
                applyShadowLabel(db, auth.deviceId, {
                  proposalId: String(payload.proposal_id),
                  label: payload.label,
                  source,
                  actual: payload.actual,
                  latencyMs: payload.latency_ms,
                  emitEvent: false,
                });
              }
            } catch {
              // Non-fatal label sync
            }
          }
        }
      }
      sendJson(res, 200, {
        ok: true,
        result: {
          insertedCount: result.insertedCount,
          duplicateCount: result.duplicateCount,
          events: result.events.map((e) => ExocortexDatabase.eventToJson(e)),
        },
      });
    } catch (err) {
      if (err instanceof DeviceNotEnrolledError || err instanceof DeviceRevokedError) {
        sendJson(res, 403, { error: err.message });
        return;
      }
      if (err instanceof EventIdConflictError) {
        sendJson(res, 409, { error: err.message });
        return;
      }
      sendInternalError(res, "failed to ingest events", err);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v3/events") {
    try {
      const db = getDatabase();
      const kind = url.searchParams.get("kind") || undefined;
      const sinceSeqStr = url.searchParams.get("sinceSeq");
      const limitStr = url.searchParams.get("limit");

      const parseStrictInt = (v: string | null, def: number | undefined, min: number, max: number): number | undefined => {
        if (v == null || v === "") return def;
        if (!/^\d+$/.test(v)) throw new TypeError("invalid integer parameter");
        const n = Number(v);
        return Math.min(Math.max(n, min), max);
      };

      let sinceSeq: number | undefined;
      let limit: number | undefined;
      try {
        sinceSeq = parseStrictInt(sinceSeqStr, undefined, 0, Number.MAX_SAFE_INTEGER);
        limit = parseStrictInt(limitStr, 50, 1, 1000);
      } catch {
        sendJson(res, 400, { error: "invalid query parameter: sinceSeq and limit must be positive integers" });
        return;
      }

      const callingDev = db.getDevice(auth.deviceId);
      const isCallerAdmin = Boolean(
        callingDev?.scopes?.includes("admin") ||
        callingDev?.scopes?.includes("admin:read")
      );
      const deviceIdParam = isCallerAdmin ? (url.searchParams.get("deviceId") || undefined) : auth.deviceId;

      const events = db.listEvents({ deviceId: deviceIdParam, kind, sinceSeq, limit });
      sendJson(res, 200, {
        ok: true,
        events: events.map((e) => ExocortexDatabase.eventToJson(e)),
      });
    } catch (err) {
      sendInternalError(res, "failed to query events", err);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v3/events/verify") {
    try {
      const db = getDatabase();
      const callingDev = db.getDevice(auth.deviceId);
      const isCallerAdmin = Boolean(
        callingDev?.scopes?.includes("admin") ||
        callingDev?.scopes?.includes("admin:read")
      );
      if (!isCallerAdmin) {
        sendJson(res, 403, { error: "forbidden: verify requires admin scope" });
        return;
      }
      const verification = db.verifyEventChain();
      sendJson(res, 200, { ok: true, verification });
    } catch (err) {
      sendInternalError(res, "failed to verify event chain", err);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v3/devices") {
    try {
      const db = getDatabase();
      const callingDev = db.getDevice(auth.deviceId);
      const isCallerAdmin = Boolean(
        callingDev?.scopes?.includes("admin") ||
        callingDev?.scopes?.includes("admin:read")
      );
      if (!isCallerAdmin) {
        const selfDev = db.getDevice(auth.deviceId);
        sendJson(res, 200, {
          ok: true,
          devices: selfDev ? [ExocortexDatabase.deviceToJson(selfDev)] : [],
        });
        return;
      }
      const devices = db.listDevices();
      sendJson(res, 200, {
        ok: true,
        devices: devices.map((d) => ExocortexDatabase.deviceToJson(d)),
      });
    } catch (err) {
      sendInternalError(res, "failed to list devices", err);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v3/world-model/beliefs") {
    try {
      const db = getDatabase();
      const seqParam = url.searchParams.get("seq");
      if (seqParam !== null) {
        if (!/^\d+$/.test(seqParam)) {
          sendJson(res, 400, { error: "invalid query parameter: seq must be a non-negative integer string" });
          return;
        }
        const seq = Number.parseInt(seqParam, 10);
        if (!Number.isSafeInteger(seq) || seq < 0) {
          sendJson(res, 400, { error: "invalid query parameter: seq must be a non-negative integer" });
          return;
        }
        const snapshot = db.getBeliefSnapshot(seq);
        if (!snapshot) {
          sendJson(res, 404, { error: `no belief snapshot found for seq ${seq}` });
          return;
        }
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      const limitParam = url.searchParams.get("limit");
      const limit = limitParam !== null && /^\d+$/.test(limitParam) ? Math.min(Math.max(1, Number.parseInt(limitParam, 10)), 500) : 50;
      const latest = db.getLatestBeliefSnapshot();
      const snapshots = db.listBeliefSnapshots(limit);

      sendJson(res, 200, {
        ok: true,
        latest: latest ?? null,
        snapshots,
      });
    } catch (err) {
      sendInternalError(res, "failed to retrieve belief snapshots", err);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v3/world-model/params") {
    try {
      const db = getDatabase();
      const factor = url.searchParams.get("factor") ?? undefined;
      const rawKind = url.searchParams.get("kind");
      let kind: 'A' | 'B' | 'C' | 'D' | undefined = undefined;
      if (rawKind !== null) {
        if (!["A", "B", "C", "D"].includes(rawKind)) {
          sendJson(res, 400, { error: "invalid query parameter: kind must be one of A, B, C, D" });
          return;
        }
        kind = rawKind as 'A' | 'B' | 'C' | 'D';
      }

      let params = db.listModelParams(factor, kind);
      if (params.length === 0) {
        const latestSnapshot = db.getLatestBeliefSnapshot();
        const asOfSeq = latestSnapshot?.as_of_seq ?? 0;
        const liveParams = defaultWorldModelHost.learnedEngine.exportModelParams(asOfSeq);
        params = liveParams.filter((p) => {
          if (factor && p.factor !== factor) return false;
          if (kind && p.kind !== kind) return false;
          return true;
        });
      }

      sendJson(res, 200, {
        ok: true,
        params,
      });
    } catch (err) {
      sendInternalError(res, "failed to retrieve model parameters", err);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v3/world-model/replay") {
    try {
      const db = getDatabase();
      const callingDev = db.getDevice(auth.deviceId);
      const isCallerAdmin = Boolean(
        callingDev?.scopes?.includes("admin") ||
        callingDev?.scopes?.includes("admin:write")
      );
      if (!isCallerAdmin) {
        sendJson(res, 403, { error: "forbidden: replay requires admin write scope" });
        return;
      }

      const raw = await readBody(req, 64 * 1024);
      let payloadObj: { from_seq?: number; to_seq?: number } = {};
      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "invalid JSON body: payload must be a plain JSON object" });
            return;
          }
          payloadObj = parsed;
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
      }

      if (payloadObj.from_seq !== undefined) {
        if (!Number.isSafeInteger(payloadObj.from_seq) || payloadObj.from_seq < 0) {
          sendJson(res, 400, { error: "from_seq must be a non-negative integer" });
          return;
        }
      }
      if (payloadObj.to_seq !== undefined) {
        if (!Number.isSafeInteger(payloadObj.to_seq) || payloadObj.to_seq < 0) {
          sendJson(res, 400, { error: "to_seq must be a non-negative integer" });
          return;
        }
      }
      if (payloadObj.from_seq !== undefined && payloadObj.to_seq !== undefined) {
        if (payloadObj.from_seq > payloadObj.to_seq) {
          sendJson(res, 400, { error: "from_seq must be less than or equal to to_seq" });
          return;
        }
      }

      const events = db.listEvents({
        from_seq: payloadObj.from_seq,
        to_seq: payloadObj.to_seq,
      });

      const replayResult = defaultWorldModelHost.replayEvents(events, db);
      sendJson(res, 200, {
        ok: true,
        replayedCount: replayResult.replayedCount,
        snapshotsCount: replayResult.snapshots.length,
        latestParamsCount: replayResult.latestParams.length,
        latestSnapshot: replayResult.snapshots.length > 0 ? replayResult.snapshots[replayResult.snapshots.length - 1] : null,
      });
    } catch (err) {
      sendInternalError(res, "failed to replay world model events", err);
    }
    return;
  }

  // --- Shadow Calibration Engine & Rollback Circuit Breaker ---

  if (method === "GET" && url.pathname === "/v3/shadow/metrics") {
    try {
      const db = getDatabase();
      const callingDev = db.getDevice(auth.deviceId);
      if (!callingDev || callingDev.revoked_at !== null) {
        sendJson(res, 403, { error: `caller device not enrolled or revoked: ${auth.deviceId}` });
        return;
      }

      // Query params
      const daysParam = url.searchParams.get("days") ?? url.searchParams.get("window_days");
      let windowDays = 14;
      if (daysParam !== null) {
        if (!/^\d+$/.test(daysParam)) {
          sendJson(res, 400, { error: "days must be a positive integer" });
          return;
        }
        windowDays = Number(daysParam);
        if (windowDays < 1 || windowDays > 365) {
          sendJson(res, 400, { error: "days must be between 1 and 365" });
          return;
        }
      }

      const thresholdParam = url.searchParams.get("threshold");
      let threshold = 0.90;
      if (thresholdParam !== null) {
        const parsed = Number(thresholdParam);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          sendJson(res, 400, { error: "threshold must be a number between 0 and 1" });
          return;
        }
        threshold = parsed;
      }

      const minLabelsParam = url.searchParams.get("min_labels");
      let minLabels = 50;
      if (minLabelsParam !== null) {
        if (!/^\d+$/.test(minLabelsParam)) {
          sendJson(res, 400, { error: "min_labels must be a positive integer" });
          return;
        }
        minLabels = Number(minLabelsParam);
        if (minLabels < 1 || minLabels > 10000) {
          sendJson(res, 400, { error: "min_labels must be between 1 and 10000" });
          return;
        }
      }

      const baselineParam = url.searchParams.get("baseline_precision");
      let baselinePrecision: number | undefined;
      if (baselineParam !== null) {
        const parsed = Number(baselineParam);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          sendJson(res, 400, { error: "baseline_precision must be a number between 0 and 1" });
          return;
        }
        baselinePrecision = parsed;
      }

      const metrics = db.getShadowMetrics({
        nowMs: Date.now(),
        windowDays,
        threshold,
        minLabels,
        baselinePrecision,
      });

      const canonicalBreakerTripped = db.isCircuitBreakerTripped();

      sendJson(res, 200, {
        ok: true,
        metrics,
        automated_verdict: metrics.automatedVerdict,
        breaker_tripped: metrics.breakerTripped,
        canonical_breaker_tripped: canonicalBreakerTripped,
        effective_shadow: process.env.SHADOW !== "0" || canonicalBreakerTripped,
      });
    } catch (err) {
      sendInternalError(res, "failed to compute shadow metrics", err);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/v3/shadow/labels") {
    try {
      const db = getDatabase();
      const callingDev = db.getDevice(auth.deviceId);
      if (!callingDev || callingDev.revoked_at !== null) {
        sendJson(res, 403, { error: `caller device not enrolled or revoked: ${auth.deviceId}` });
        return;
      }

      const raw = await readBody(req, 64 * 1024);
      let payloadObj: {
        proposal_id?: string;
        label?: string;
        source?: string;
        latency_ms?: number;
        actual?: unknown;
        attestation?: unknown;
      } = {};
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          sendJson(res, 400, { error: "invalid JSON body: payload must be a plain JSON object" });
          return;
        }
        payloadObj = parsed;
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }

      const proposalId = String(payloadObj.proposal_id ?? "").trim();
      if (!proposalId) {
        sendJson(res, 400, { error: "proposal_id is required" });
        return;
      }

      const rawLabel = String(payloadObj.label ?? "").trim();
      if (!isShadowLabel(rawLabel)) {
        sendJson(res, 400, { error: `invalid label: must be one of wanted, not_wanted, already_did, ignored` });
        return;
      }
      const label = rawLabel;

      const source = payloadObj.source === "inferred"
        ? "inferred"
        : labelSource(db, auth.deviceId, proposalId, label, payloadObj.attestation);

      let latencyMs: number | null = null;
      if (payloadObj.latency_ms !== undefined) {
        if (!Number.isSafeInteger(payloadObj.latency_ms) || (payloadObj.latency_ms as number) < 0) {
          sendJson(res, 400, { error: "latency_ms must be a non-negative integer" });
          return;
        }
        latencyMs = payloadObj.latency_ms as number;
      }

      const proposal = db.getProposal(proposalId);
      if (!proposal) {
        sendJson(res, 404, { error: `proposal not found: ${proposalId}` });
        return;
      }

      const result = applyShadowLabel(db, auth.deviceId, {
        proposalId,
        label,
        source,
        actual: payloadObj.actual,
        latencyMs,
      });

      sendJson(res, 200, {
        ok: true,
        proposal_id: result.proposalId,
        label: result.label,
        source: result.source,
        attested: result.source === "tap",
        recorded_at: result.recordedAt,
      });
    } catch (err) {
      sendInternalError(res, "failed to record shadow label", err);
    }
    return;
  }



  // Approval-key registration. The security boundary for biometric approvals: the key that later verifies
  // them must be bound by someone holding the PC-side enrollment secret AND the phone proving possession.
  if (method === "POST" && url.pathname === "/v3/devices/approval-key/challenge") {
    sendJson(res, 200, { ok: true, challenge: approvalKeyChallenges.issue(auth.deviceId) });
    return;
  }

  if (method === "POST" && url.pathname === "/v3/devices/approval-key") {
    try {
      const enrollToken = process.env.GATEWAY_ENROLL_TOKEN;
      if (!enrollToken) {
        sendJson(res, 401, { error: "unauthorized: key registration disabled (GATEWAY_ENROLL_TOKEN not set)" });
        return;
      }
      const presentedRaw = req.headers["x-enroll-token"];
      const presented = Buffer.from(typeof presentedRaw === "string" ? presentedRaw : "", "utf8");
      const expected = Buffer.from(enrollToken, "utf8");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        sendJson(res, 401, { error: "unauthorized: invalid enrollment token" });
        return;
      }
      const raw = await readBody(req, 16 * 1024);
      let body: any;
      try {
        body = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, { error: "body must be a JSON object" });
        return;
      }
      const pubkeyB64 = typeof body.pubkey_b64 === "string" ? body.pubkey_b64 : "";
      const challenge = typeof body.challenge === "string" ? body.challenge : "";
      const signature = typeof body.signature_b64 === "string" ? body.signature_b64 : "";
      const spki = new Uint8Array(Buffer.from(pubkeyB64, "base64"));
      if (!pubkeyB64 || !parseP256Spki(spki)) {
        sendJson(res, 400, { error: "pubkey_b64 must be an EC P-256 SPKI public key" });
        return;
      }
      // Consumed even on failure so a challenge can never be retried.
      if (!challenge || !approvalKeyChallenges.consume(auth.deviceId, challenge)) {
        sendJson(res, 400, { error: "challenge missing, expired or already used" });
        return;
      }
      if (!verifyEcSignature(spki, approvalKeyMessage(auth.deviceId, challenge), signature)) {
        sendJson(res, 400, { error: "proof of possession failed" });
        return;
      }
      // Hardware attestation: only the explicit dev escape hatch skips the chain checks (not proof of possession).
      const hatch = allowUnattestedKeys();
      if (!hatch) {
        const revokedSerials = process.env.NODE_ENV === "test" ? new Set<string>() : await getRevokedAttestationSerials();
        const chain = verifyKeyAttestationChain(body.attestation_chain, { pubkeySpki: spki, challenge }, { revokedSerials });
        if (!chain.ok) {
          sendJson(res, 400, { error: `key attestation rejected: ${chain.reason}` });
          return;
        }
      } else {
        console.warn("[approval-key] EXOCORTEX_ALLOW_UNATTESTED_KEYS=1: key attestation chain NOT verified");
      }
      if (!getDatabase().setDeviceApprovalKey(auth.deviceId, spki, !hatch)) {
        sendJson(res, 404, { error: "device not enrolled or revoked" });
        return;
      }
      sendJson(res, 200, { ok: true, device_id: auth.deviceId, attested: !hatch, attestation_verified: !hatch });
    } catch (err) {
      sendInternalError(res, "failed to register approval key", err);
    }
    return;
  }

  // Push token registration: latest token wins; revoked devices are refused.
  if (method === "POST" && url.pathname === "/v3/devices/push-token") {
    try {
      const raw = await readBody(req, 16 * 1024);
      let body: any;
      try {
        body = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, { error: "body must be a JSON object" });
        return;
      }
      if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 4096) {
        sendJson(res, 400, { error: "token must be a string of 1-4096 chars" });
        return;
      }
      if (body.platform !== "fcm") {
        sendJson(res, 400, { error: "platform must be 'fcm'" });
        return;
      }
      if (!getDatabase().setDevicePushToken(auth.deviceId, body.token, "fcm")) {
        sendJson(res, 403, { error: "device not enrolled or revoked" });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendInternalError(res, "failed to register push token", err);
    }
    return;
  }

  if (method === "GET" && url.pathname === "/v3/proposals/pending") {
    try {
      const db = getDatabase();
      const dev = db.getDevice(auth.deviceId);
      if (!dev || dev.revoked_at) {
        sendJson(res, 403, { error: `caller device not enrolled or revoked: ${auth.deviceId}` });
        return;
      }
      if (!dev.scopes.includes("approval:write") && !dev.scopes.includes("admin") && !dev.scopes.includes("admin:read")) {
        sendJson(res, 403, { error: "forbidden: requires approval:write or admin:read scope" });
        return;
      }
      sendJson(res, 200, { ok: true, proposals: await buildPendingProposals(db, pendingFetcher, Date.now(), pendingSpeculator) });
    } catch (err) {
      sendInternalError(res, "failed to list pending proposals", err);
    }
    return;
  }

  if (method === "POST" && url.pathname === "/network/delegate") {
    try {
      const raw = await readBody(req, 64 * 1024);
      let decoded: unknown;
      try {
        decoded = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const parsed = parseDelegateEnvelope(decoded);
      if (!isDelegateEnvelope(parsed)) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      // Shadow mode: propose-only. Device/phone actuation is never delegated while SHADOW is on.
      if (parsed.to === "hermes-api" && process.env.SHADOW !== "0") {
        sendJson(res, 423, {
          ok: false,
          error: "shadow mode: device actuation disabled (set SHADOW=0 to allow delegation to hermes-api)",
          shadow_mode: true,
        });
        return;
      }
      const outcome = await forwardDelegate(parsed);
      if (outcome.isRawText) {
        res.writeHead(outcome.status, {
          "Content-Type": outcome.contentType,
          ...CORS_HEADERS,
        });
        res.end(String(outcome.body));
        return;
      }
      sendJson(res, outcome.status, outcome.body);
    } catch (err) {
      if (err instanceof Error && err.message === "delegate body too large") {
        sendJson(res, 413, { error: "delegate body too large" });
        return;
      }
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      sendJson(res, 503, {
        error: "local node unreachable",
        reason: isTimeout ? "timed out reaching a service on this PC" : (err instanceof Error ? err.message : String(err)),
      });
    }
    return;
  }

  if (method === "POST" && url.pathname === "/network/approve") {
    try {
      const raw = await readBody(req, 16 * 1024);
      let decoded: unknown;
      try {
        decoded = raw.length === 0 ? {} : JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        sendJson(res, 400, { error: "approval body must be a JSON object" });
        return;
      }
      const rec = decoded as Record<string, unknown>;
      const proposalId = String(rec.proposal_id ?? rec.proposalId ?? "").trim();
      const nonce = String(rec.nonce ?? rec.approval_nonce ?? rec.approvalNonce ?? "").trim();
      const action = rec.action === "reject" ? "reject" : "approve";
      const reason = typeof rec.reason === "string" ? rec.reason : undefined;
      const snakeCandidate = parseAttestationCandidate(rec.biometric_attestation);
      const camelCandidate = parseAttestationCandidate(rec.biometricAttestation);

      if (snakeCandidate.kind === "invalid" || camelCandidate.kind === "invalid") {
        sendJson(res, 400, { error: "biometric_attestation must be a non-empty string or non-empty object" });
        return;
      }

      if (snakeCandidate.kind === "val" && camelCandidate.kind === "val") {
        const sStr = typeof snakeCandidate.value === "string" ? snakeCandidate.value : canonicalJsonStringify(snakeCandidate.value);
        const cStr = typeof camelCandidate.value === "string" ? camelCandidate.value : canonicalJsonStringify(camelCandidate.value);
        if (sStr !== cStr) {
          sendJson(res, 400, { error: "conflicting biometric_attestation and biometricAttestation values provided" });
          return;
        }
      }

      const activeCandidate = snakeCandidate.kind === "val" ? snakeCandidate : camelCandidate;
      const biometricAttestation = activeCandidate.kind === "val" ? activeCandidate.value : undefined;

      if (biometricAttestation !== undefined) {
        const repr = typeof biometricAttestation === "string" ? biometricAttestation : canonicalJsonStringify(biometricAttestation);
        if (Buffer.byteLength(repr, "utf8") > 4096) {
          sendJson(res, 400, { error: "biometric attestation exceeds maximum allowed size (4096 UTF-8 bytes)" });
          return;
        }
      }

      if (!proposalId) {
        sendJson(res, 400, { error: "proposal_id is required" });
        return;
      }
      if (action === "approve" && !nonce) {
        sendJson(res, 400, { error: "nonce is required for approval" });
        return;
      }

      if (action === "approve") {
        try {
          const db = getDatabase();
          if (db.isCircuitBreakerTripped()) {
            sendJson(res, 423, {
              ok: false,
              error: "circuit breaker tripped: precision below threshold, actuation clamped to shadow mode",
              automated_verdict: "BREAKER_TRIPPED_PRECISION_LOW",
              breaker_tripped: true,
            });
            return;
          }
          if (db.getProposal(proposalId)?.shadow === 1) {
            sendJson(res, 423, {
              ok: false,
              error: "shadow proposal cannot be approved, even when live actuation is enabled",
              shadow_mode: true,
            });
            return;
          }
          if (process.env.SHADOW !== "0") {
            sendJson(res, 423, {
              ok: false,
              error: "shadow mode: actuation disabled (set SHADOW=0 to allow approvals)",
              shadow_mode: true,
            });
            return;
          }
          // Every approval must carry a fresh biometric signature from the key bound to THIS authenticated device.
          const device = db.getDevice(auth.deviceId);
          const verdict = verifyApprovalAttestation(
            biometricAttestation,
            { deviceId: auth.deviceId, proposalId, nonce, action },
            device && !device.revoked_at ? device.pubkey_spki : null,
            Boolean(device?.key_attested),
          );
          if (!verdict.ok) {
            // 428/422 (not 403): the phone treats 403 as a consumed proposal, but this is retryable once a key is registered.
            const noKey = verdict.reason === "device has no registered approval key";
            sendJson(res, noKey ? 428 : 422, { ok: false, error: `biometric attestation rejected: ${verdict.reason}` });
            return;
          }
        } catch {
          // Fail closed: if breaker state cannot be determined, do not forward an approval.
          sendJson(res, 503, { ok: false, error: "circuit breaker state unavailable: approval refused" });
          return;
        }
      }

      const outcome = await forwardApprove({ proposalId, nonce, reason, action, biometricAttestation });
      // Authoritative tap label: the approve attestation was verified above and the triad confirmed the release.
      if (
        action === "approve" &&
        outcome.status >= 200 &&
        outcome.status < 300 &&
        (outcome.body as { ok?: unknown } | null)?.ok === true
      ) {
        try {
          const db = getDatabase();
          if (db.getProposal(proposalId)) {
            applyShadowLabel(db, auth.deviceId, { proposalId, label: "wanted", source: "tap", actual: { via: "approval" } });
          }
        } catch (labelErr) {
          console.error("[approve] failed to record tap label:", labelErr);
        }
      }
      // Advance the DB state once the triad confirmed the decision, so the proposal leaves the pending list
      // and cannot be re-speculated with a fresh nonce (which would allow a second approval).
      if (outcome.status >= 200 && outcome.status < 300 && (outcome.body as { ok?: unknown } | null)?.ok === true) {
        try {
          const db = getDatabase();
          if (db.getProposal(proposalId)) {
            db.updateProposalState(proposalId, action === "approve" ? "APPROVED" : "REJECTED");
          }
        } catch (stateErr) {
          console.error("[approve] could not advance proposal state:", stateErr);
        }
      }
      sendJson(res, outcome.status, outcome.body);
    } catch (err) {
      sendInternalError(res, "approval forward failed", err);
    }
    return;
  }


  // Ask and usage-report both need their raw POST body forwarded rather than
  // being routed through the generic allowlist below - neither maps to a
  // PiecesOS path (packages/allowlist only knows mobile-path -> PiecesOS-path
  // mappings), and both terminate at the home proxy itself. usage-report
  // forwards rather than logging locally so Plan A and Plan B events land in
  // the same file on the PC instead of splitting across two logs.
  const isAsk = method === "POST" && url.pathname === "/mobile/ask";
  const isRelevantSearch = method === "GET" && url.pathname === "/mobile/search/relevant";
  const isUsageReport = method === "POST" && url.pathname === "/mobile/usage-report";
  const isAssetFetch = method === "GET" && url.pathname.startsWith("/mobile/asset/");
  const isConversationFetch = method === "GET" && url.pathname.startsWith("/mobile/conversation/") && url.pathname.endsWith("/messages");
  // Same reasoning as isRelevantSearch: /mobile/summaries has no PiecesOS
  // path of its own (the home proxy's summaries.ts does annotation
  // hydration + SUMMARY-vs-profile filtering server-side) - a plain GET
  // passthrough to the home proxy, no special body handling needed. Missing
  // this case was a real gap (not present in the original Plan B port) -
  // the Recent ("What Got Done") tab 404'd over the gateway even though it
  // worked fine on Plan A's direct LAN connection.
  const isSummaries = method === "GET" && url.pathname === "/mobile/summaries";
  const route = isAsk || isRelevantSearch || isUsageReport || isAssetFetch || isConversationFetch || isSummaries ? { piecesPath: "" } : findAllowedRoute(method, url.pathname);

  if (!route) {
    // Deny-by-default: same allowlist module as Plan A. Anything not listed
    // there is a 404 here too, even with a valid JWT.
    sendJson(res, 404, { error: "not found" });
    return;
  }

  try {
    const target = new URL(url.pathname + url.search, HOME_PROXY_BASE_URL);
    const upstreamReq: RequestInit & { duplex?: "half" } = {
      method,
      headers: { Authorization: `Bearer ${HOME_PROXY_TOKEN}` },
      signal: AbortSignal.timeout(upstreamTimeoutFor(method, url.pathname)),
    };
    if (isAsk || isUsageReport) {
      upstreamReq.body = req as unknown as BodyInit;
      upstreamReq.headers = { ...upstreamReq.headers, "Content-Type": "application/json" };
      // Node.js native fetch requires duplex: 'half' when streaming a body.
      upstreamReq.duplex = "half";
    }

    const homeRes = await fetch(target, upstreamReq);
    const text = await homeRes.text();
    res.writeHead(homeRes.status, {
      "Content-Type": homeRes.headers.get("content-type") ?? "application/json",
      ...CORS_HEADERS,
    });
    res.end(text);
  } catch (err) {
    // Fail closed: if the tailnet path to the home PC is down (PC asleep,
    // Tailscale down, home proxy not running because the user is logged
    // out), this returns an explicit 503 within UPSTREAM_TIMEOUT_MS rather
    // than hanging the phone indefinitely.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    sendJson(res, 503, {
      error: "home node unreachable",
      reason: isTimeout ? "timed out reaching the home proxy over Tailscale" : (err instanceof Error ? err.message : String(err)),
    });
  }
});

server.on("close", () => {
  defaultPushNotifier.stop();
  defaultRepoHealthWatcher.stop();
  defaultInferredOutcomeScheduler.stop();
});

// 0.0.0.0, not 127.0.0.1: this runs inside a Docker container reached by
// Caddy over the compose network, not on bare metal. It is still not
// internet-facing - only exposed (not published) in docker-compose.yml, so
// only other containers on the same compose network can reach it directly.
if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`pieces-gateway listening on 0.0.0.0:${PORT} (reached via Caddy over the compose network, not published to the internet directly)`);
    console.log(`forwarding to home proxy at ${HOME_PROXY_BASE_URL}`);
  });
  if (HOME_PROXY_BASE_URL) {
    // Retries and logs internally; the .catch is a backstop so a future edit can't crash startup.
    warmUpHomeProxyConnection().catch((err) => console.warn("[warmup] unexpected failure:", err));
  }
  // Push hook: poll the DB for newly SURFACED proposals (notifyProposalSurfaced() in push-notifier.ts is the in-process hook).
  defaultPushNotifier.start();
  if (process.env.EXOCORTEX_REPO_WATCH !== "0") {
    defaultRepoHealthWatcher.start();
  }
  if (process.env.EXOCORTEX_INFER_SCHEDULE !== "0") {
    defaultInferredOutcomeScheduler.start();
  }
}


function readBody(req: import("node:http").IncomingMessage, limit: number): Promise<string> {
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
    req.on("error", reject);
  });
}

// Tailscale needs to (re-)establish its direct WireGuard path/NAT punch to
// the home node after this process (re)starts - observed in practice as the
// FIRST real request timing out at the full UPSTREAM_TIMEOUT_MS even though
// every request after it is fast (a few hundred ms). Rather than let a real
// user request pay that cost, fire an unauthenticated warm-up ping against
// the home proxy's own /mobile/health at startup - result doesn't matter
// (logged only), this exists purely to wake the tunnel up early.
async function warmUpHomeProxyConnection() {
  const target = new URL("/mobile/health", HOME_PROXY_BASE_URL);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      console.log(`[warmup] home proxy reachable (attempt ${attempt}, HTTP ${res.status})`);
      return;
    } catch (err) {
      console.warn(`[warmup] home proxy not yet reachable (attempt ${attempt}/3): ${err instanceof Error ? err.message : err}`);
    }
  }
  console.warn("[warmup] gave up after 3 attempts - first real request may still pay the cold-start cost");
}
