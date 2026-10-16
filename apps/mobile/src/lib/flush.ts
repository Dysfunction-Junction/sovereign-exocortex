import { getConnectionTargets } from "./config";
import { peekQueue, clearSentEvents, getBridgeState, setBridgeState, recordEvent, type BridgeState, type UsageEvent } from "./usage";
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
let bridgeState: BridgeState | undefined;

async function reportBridgeTransition(state: BridgeState, observation: "ping_fast" | "ping_slow" | "ws_dropped"): Promise<void> {
  let previous = bridgeState;
  if (previous === undefined) {
    try {
      previous = await getBridgeState();
    } catch {
      // A missing local status is equivalent to unknown; report the observed transition.
    }
  }
  if (previous === state) {
    bridgeState = state;
    return;
  }
  try {
    await recordEvent({
      type: "health_observation",
      factor: "link_health",
      observation,
      timestamp: new Date().toISOString(),
    });
    await setBridgeState(state);
    bridgeState = state;
  } catch {
    // Link diagnostics are best-effort and must never interfere with event delivery.
  }
}

/** Test-only reset for independent flush scenarios. */
export function resetBridgeStateForTest(): void {
  bridgeState = undefined;
}

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
  } else if (e.type === "health_observation") {
    kind = "observation";
  }
  const ts = new Date(e.timestamp).getTime();
  const ts_device = Number.isSafeInteger(ts) && ts > 0 ? ts : Date.now();
  const screen = "screen" in e ? e.screen : undefined;
  const event_id = e.id || `evt_${ts_device}_${e.type}_${screen ?? "system"}`;

  return {
    event_id,
    kind,
    ts_device,
    schema_ver: 1,
    payload: {
      type: e.type,
      ...(screen ? { screen } : {}),
      ...(e.type === "ask" ? { query: e.query, result: e.result } : {}),
      ...(e.type === "search" ? { query: e.query, resultCount: e.resultCount, mode: e.mode } : {}),
      ...(e.type === "setup_saved" ? { mode: e.mode } : {}),
      ...(e.type === "health_observation" ? { factor: e.factor, observation: e.observation } : {}),
      ...(e.type === "system_telemetry"
        ? {
            telemetry: e.telemetry,
            package: e.package,
            app_label: e.app_label,
            triaged: e.triaged,
            ...(e.audio ? { audio: e.audio } : {}),
            ...(e.thermal ? { thermal: e.thermal } : {}),
            ...(e.battery_micro ? { battery_micro: e.battery_micro } : {}),
            ...(e.motion ? { motion: e.motion } : {}),
            ...(e.notification_actions ? { notification_actions: e.notification_actions } : {}),
            ...(e.extracted_entities ? { extracted_entities: e.extracted_entities } : {}),
            ...(e.contextual_suggestions ? { contextual_suggestions: e.contextual_suggestions } : {}),
            ...(e.sys_suggest ? { sys_suggest: e.sys_suggest } : {}),
            ...(e.physical_surface ? { physical_surface: e.physical_surface } : {}),
            ...(e.network_telemetry ? { network_telemetry: e.network_telemetry } : {}),
            ...(e.hardware_telemetry ? { hardware_telemetry: e.hardware_telemetry } : {}),
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

    let networkFailures = 0;

    const v3Events = toSend.map(usageEventToV3);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const probe = targets.length > 1 && i === 0 && target.mode === "lan";
      const timeoutMs = probe ? 2500 : 8000;
      const deadline = Date.now() + timeoutMs;
      const getSignal = () => AbortSignal.timeout(Math.max(500, deadline - Date.now()));
      const deviceId = extractDeviceIdFromToken(target.token) || "device_phone_galaxy";
      let targetReachedHttpServer = false;

      const post = async (batch: UsageEvent[], v3: V3EventIn[], signal: () => AbortSignal) => {
        const headers = { "Content-Type": "application/json", Authorization: `Bearer ${target.token}` };
        let res = await fetch(`${target.baseUrl}/v3/events`, {
          method: "POST",
          headers,
          body: JSON.stringify({ device_id: deviceId, events: v3 }),
          signal: signal(),
        });
        targetReachedHttpServer = true;
        // Graceful fallback to legacy /mobile/usage-report if /v3/events is not supported (404) or scope forbidden (403)
        if (res.status === 404 || res.status === 403) {
          res = await fetch(`${target.baseUrl}/mobile/usage-report`, {
            method: "POST",
            headers,
            body: JSON.stringify({ events: batch }),
            signal: signal(),
          });
          targetReachedHttpServer = true;
        }
        return res;
      };

      try {
        const startedAt = Date.now();
        const res = await post(toSend, v3Events, getSignal);

        if (res.ok) {
          await clearSentEvents(toSend);
          const observation = Date.now() - startedAt < 1500 ? "ping_fast" : "ping_slow";
          await reportBridgeTransition("connected", observation);
          return;
        }

        // Stale token, forbidden scope, or server error — failover to other profile (Plan B gateway)
        if (res.status === 401 || res.status === 403 || res.status >= 500) continue;

        // 400/409: a malformed or duplicate event. A single event is cleared so it cannot block the queue.
        // A larger batch is re-sent one event at a time (same endpoint chain, shared deadline): accepted and
        // rejected events are cleared as they resolve; anything else stops the pass or fails over, and the
        // already-cleared events are never re-sent.
        if (res.status === 400 || res.status === 409) {
          if (toSend.length === 1) {
            await clearSentEvents(toSend);
            return;
          }
          const isoDeadline = Date.now() + 8000;
          const isoSignal = () => AbortSignal.timeout(Math.max(500, isoDeadline - Date.now()));
          for (const ev of toSend) {
            if (Date.now() >= isoDeadline) return;
            let single: Response;
            try {
              single = await post([ev], [usageEventToV3(ev)], isoSignal);
            } catch {
              return; // network error mid-pass: keep the rest queued, don't resend cleared events elsewhere
            }
            if (single.ok || single.status === 400 || single.status === 409) {
              await clearSentEvents([ev]);
            } else {
              return;
            }
          }
          return;
        }
        return;
      } catch {
        // Network error / timeout — try next target (e.g. Plan B gateway).
        if (!targetReachedHttpServer) networkFailures++;
      }
    }
    // All targets failed: queue stays intact for next flush attempt.
    if (networkFailures === targets.length) {
      await reportBridgeTransition("disconnected", "ws_dropped");
    }
  } catch {
    // Silently retry on next flush call.
  } finally {
    isFlushing = false;
  }
}
