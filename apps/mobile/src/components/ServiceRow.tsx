import React, { useState } from "react";
import { type ServiceId, type ServiceInfo, restartService, getServices } from "../lib/api";
import { tryAutoConnectLocalPc } from "../lib/config";

export interface ServiceRowProps {
  id: ServiceId;
  label: string;
  descriptor?: string;
  service?: ServiceInfo;
  daemonUnreachable?: boolean;
  onRefresh?: () => Promise<void> | void;
  onDaemonRestarting?: (reconnecting: boolean) => void;
}

export const ServiceRow: React.FC<ServiceRowProps> = ({
  id,
  label,
  descriptor,
  service,
  daemonUnreachable = false,
  onRefresh,
  onDaemonRestarting,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [reconnectState, setReconnectState] = useState(false);
  const [restartResult, setRestartResult] = useState<"ok" | "failed" | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);

  const status = daemonUnreachable ? "unknown" : isRestarting ? "restarting" : (service?.status ?? "unknown");

  let statusBadgeClass = "badge";
  let statusText = "Checking";
  let statusDotColor = "#9ca3af";

  if (daemonUnreachable) {
    statusBadgeClass = "badge danger";
    statusText = "Unknown (daemon unreachable)";
    statusDotColor = "#ef4444";
  } else if (isRestarting || reconnectState) {
    statusBadgeClass = "badge warning";
    statusText = id === "daemon" && reconnectState ? "Reconnecting…" : "Restarting…";
    statusDotColor = "#f59e0b";
  } else if (status === "healthy") {
    statusBadgeClass = "badge success";
    statusText = "Healthy";
    statusDotColor = "#10b981";
  } else if (status === "unhealthy") {
    statusBadgeClass = "badge danger";
    statusText = "Unhealthy";
    statusDotColor = "#ef4444";
  }

  const handleRestartClick = () => {
    setConfirmOpen(true);
    setRestartResult(null);
    setRestartError(null);
  };

  const handleConfirmRestart = async () => {
    setConfirmOpen(false);
    setIsRestarting(true);
    setRestartResult(null);
    setRestartError(null);

    const isDaemon = id === "daemon";
    if (isDaemon) {
      setReconnectState(true);
      onDaemonRestarting?.(true);
    }

    try {
      await restartService(id);
    } catch (err) {
      if (!isDaemon) {
        setIsRestarting(false);
        setRestartResult("failed");
        setRestartError(err instanceof Error ? err.message : String(err));
        return;
      }
      // For daemon, immediate loss of connection is expected
    }

    // Polling phase: poll every 2s until healthy or timeout
    const maxWaitMs = id === "piecesos" ? 150_000 : 90_000;
    const startTime = Date.now();
    let recovered = false;
    let lastDetail = "";

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const services = await getServices();
        const current = services.find((s) => s.id === id);
        if (current) {
          lastDetail = current.detail;
          if (current.status === "healthy" && !current.restart?.in_progress) {
            recovered = true;
            break;
          }
        }
      } catch {
        // Expected while daemon or proxy is rebooting
      }
    }

    if (isDaemon) {
      try {
        await tryAutoConnectLocalPc();
      } catch {
        // Best effort token refresh
      }
      setReconnectState(false);
      onDaemonRestarting?.(false);
    }

    setIsRestarting(false);
    if (recovered) {
      setRestartResult("ok");
    } else {
      setRestartResult("failed");
      setRestartError(lastDetail || "Timeout waiting for service to recover");
    }

    if (onRefresh) {
      try {
        await onRefresh();
      } catch {
        // Ignore
      }
    }
  };

  const isAvailable = service?.restart?.available ?? (id === "worldmodel");

  return (
    <div className="service-row-item" data-testid={`service-row-${id}`}>
      <button
        type="button"
        className="service-row-header-btn"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              backgroundColor: statusDotColor,
              flexShrink: 0,
            }}
            aria-hidden="true"
          />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
            {descriptor && (
              <div className="hint" style={{ fontSize: 12, fontFamily: "monospace", marginTop: 1 }}>
                {descriptor}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={statusBadgeClass} style={{ fontSize: 11 }}>
            {statusText}
          </span>
          <span style={{ fontSize: 12, opacity: 0.6, transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease" }}>
            ▼
          </span>
        </div>
      </button>

      {isExpanded && (
        <div className="service-row-expanded-content" data-testid={`service-row-expanded-${id}`}>
          {daemonUnreachable ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ margin: 0, color: "#f87171" }}>
                Unknown (daemon unreachable): Daemon API is not responding.
              </p>
              {id === "daemon" && (
                <p className="hint" style={{ margin: "2px 0 0", fontSize: 12 }}>
                  The Daemon can be restarted from the Windows system tray or by running elevated:
                  <code style={{ display: "block", marginTop: 4, padding: "4px 6px", background: "rgba(0,0,0,0.3)", borderRadius: 4 }}>
                    Start-ScheduledTask ExocortexDaemon
                  </code>
                </p>
              )}
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="secondary"
                  style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={onRefresh}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "4px 8px", fontSize: 12 }}>
                <span className="hint">Status:</span>
                <span style={{ fontWeight: 500 }}>{statusText}</span>

                <span className="hint">Detail:</span>
                <span>{service?.detail || "-"}</span>

                <span className="hint">Latency:</span>
                <span>{service?.latency_ms !== null && service?.latency_ms !== undefined ? `${service.latency_ms} ms` : "-"}</span>

                {(service?.pid !== undefined || service?.uptime_s !== undefined) && (
                  <>
                    <span className="hint">Process:</span>
                    <span>
                      {service.pid !== undefined ? `PID: ${service.pid}` : ""}
                      {service.uptime_s !== undefined ? ` (Uptime: ${service.uptime_s}s)` : ""}
                    </span>
                  </>
                )}

                <span className="hint">Checked:</span>
                <span>{service?.checked_at ? new Date(service.checked_at).toLocaleTimeString() : "-"}</span>

                {service?.restart?.last_result && (
                  <>
                    <span className="hint">Last Restart:</span>
                    <span>
                      {service.restart.last_result}
                      {service.restart.last_at ? ` at ${new Date(service.restart.last_at).toLocaleTimeString()}` : ""}
                    </span>
                  </>
                )}
              </div>

              {/* Status Outcome Banner */}
              {restartResult === "ok" && (
                <div style={{ marginTop: 4 }}>
                  <span className="badge success" style={{ fontSize: 12 }}>
                    Restarted
                  </span>
                </div>
              )}
              {restartResult === "failed" && (
                <div style={{ marginTop: 4 }}>
                  <span className="badge danger" style={{ fontSize: 12 }}>
                    Restart failed: {restartError || "Unknown error"}
                  </span>
                </div>
              )}

              {/* Actions */}
              <div style={{ marginTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 8 }}>
                {!isAvailable ? (
                  <div>
                    <span className="hint" style={{ color: "#fbbf24", display: "block", marginBottom: 4 }}>
                      Restart task not installed
                    </span>
                    <p className="hint" style={{ margin: "0 0 6px", fontSize: 11 }}>
                      Run elevated once from PowerShell:
                    </p>
                    <code style={{ display: "block", padding: "4px 6px", background: "rgba(0,0,0,0.3)", borderRadius: 4, fontSize: 11 }}>
                      powershell -ExecutionPolicy Bypass -File apps/daemon/ops/register-restart-tasks.ps1
                    </code>
                    <button type="button" disabled style={{ marginTop: 8, fontSize: 12, opacity: 0.5, cursor: "not-allowed" }}>
                      Restart
                    </button>
                  </div>
                ) : isRestarting || reconnectState ? (
                  <button type="button" disabled style={{ fontSize: 12, opacity: 0.7, cursor: "wait" }}>
                    {id === "daemon" && reconnectState ? "Reconnecting…" : "Restarting…"}
                  </button>
                ) : confirmOpen ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "rgba(255,255,255,0.05)", padding: 8, borderRadius: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>
                      Restart {label}? {id === "daemon" ? "The app will reconnect." : ""}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        style={{ fontSize: 12, padding: "4px 10px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
                        onClick={handleConfirmRestart}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        style={{ fontSize: 12, padding: "4px 10px" }}
                        onClick={() => setConfirmOpen(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={{ fontSize: 12, padding: "4px 12px", cursor: "pointer" }}
                    onClick={handleRestartClick}
                  >
                    Restart
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
