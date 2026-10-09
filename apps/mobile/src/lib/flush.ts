import { getConnectionTargets } from "./config";
import { peekQueue, clearSentEvents, type UsageEvent } from "./usage";
import { extractDeviceIdFromToken } from "./jwtDisplay";

// Best-effort batch flush of queued usage events into Architecture & Schema v3
// event store (POST /v3/events) with graceful fallback to legacy /mobile/usage-report.
// Never throws — telemetry must never surface an error to the UI.
//
// Key architectural properties:
//  1. Only ever sends a PREFIX of the queue up to (not including) the first
//     untriaged background capture — never the whole queue unconditionally.
//     This keeps raw captured screen text / notification / SMS bodies off the
//     wire until triageQueue.ts has summarized them on-device.
//  2. Plan A (LAN) -> Plan B (remote gateway) failover: try each target in
//     order, move on for network error / timeout / 401 / 403 / 5xx.

let isFlushing = false;

export interface V3EventIn {
  event_id: string;
  kind: string;
  ts_device: number;
  schema_ver: 1;
  payload: Record<string, unknown>;
}

export function usageEventToV3(e: UsageEvent): V3EventIn {
  let kind = "telemetry";
  if (e.type === "ask" || e.type === "search") {
    kind = "query";
  } else if (e.type === "screen_view" || e.type === "setup_saved") {
    kind = "touch";
  } else if (e.type === "system_telemetry") {
    kind = "telemetry";
  }
  const ts = new Date(e.timestamp).getTime();
  const ts_device = Number.isSafeInteger(ts) && ts > 0 ? ts : Date.now();
  const event_id = e.id || `evt_${ts_device}_${e.type}_${e.screen}`;

  return {
    event_id,
    kind,
    ts_device,
    schema_ver: 1,
    payload: {
      type: e.type,
      screen: e.screen,
      ...(e.type === "ask" ? { query: e.query, result: e.result } : {}),
      ...(e.type === "search" ? { query: e.query, resultCount: e.resultCount, mode: e.mode } : {}),
      ...(e.type === "setup_saved" ? { mode: e.mode } : {}),
      ...(e.type === "system_telemetry"
        ? {
            telemetry: e.telemetry,
            package: e.package,
            app_label: e.app_label,
            triaged: e.triaged,
          }
        : {}),
    },
  };
}

export async function flushUsageEvents(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;

  try {
    const events = await peekQueue();
    if (events.length === 0) return;

    // Stop at the first untriaged background capture — send only what's ready, capped at 100 items.
    let sendCount = Math.min(events.length, 100);
    for (let i = 0; i < sendCount; i++) {
      const e = events[i];
      if (e.type === "system_telemetry" && e.screen === "background" && e.triaged === undefined) {
        sendCount = i;
        break;
      }
    }
    if (sendCount === 0) return;
    const toSend = events.slice(0, sendCount);

    const targets = await getConnectionTargets();
    if (targets.length === 0) return;

    const v3Events = toSend.map(usageEventToV3);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const probe = targets.length > 1 && i === 0 && target.mode === "lan";
      const timeoutMs = probe ? 2500 : 8000;
      const deadline = Date.now() + timeoutMs;
      const getSignal = () => AbortSignal.timeout(Math.max(500, deadline - Date.now()));
      const deviceId = extractDeviceIdFromToken(target.token) || "device_phone_galaxy";

      try {
        let res = await fetch(`${target.baseUrl}/v3/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.token}`,
          },
          body: JSON.stringify({ device_id: deviceId, events: v3Events }),
          signal: getSignal(),
        });

        // Graceful fallback to legacy /mobile/usage-report if /v3/events is not supported (404) or scope forbidden (403)
        if (res.status === 404 || res.status === 403) {
          res = await fetch(`${target.baseUrl}/mobile/usage-report`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${target.token}`,
            },
            body: JSON.stringify({ events: toSend }),
            signal: getSignal(),
          });
        }

        if (res.ok) {
          await clearSentEvents(toSend);
          return;
        }

        // Stale token, forbidden scope, or server error — failover to other profile (Plan B gateway)
        if (res.status === 401 || res.status === 403 || res.status >= 500) continue;

        // On 400 or 409 (malformed or duplicate event), safely clear only if isolated single item
        // to prevent infinite retry deadlock without wiping up to 100 valid events
        if (res.status === 400 || res.status === 409) {
          if (toSend.length === 1) {
            await clearSentEvents(toSend);
          }
          return;
        }
        return;
      } catch {
        // Network error / timeout — try next target (e.g. Plan B gateway).
      }
    }
    // All targets failed: queue stays intact for next flush attempt.
  } catch {
    // Silently retry on next flush call.
  } finally {
    isFlushing = false;
  }
}
