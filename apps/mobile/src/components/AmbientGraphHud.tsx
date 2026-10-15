import { useState, useEffect, useRef, useCallback } from "react";
import { getLivingGraphContext, type LivingGraphStatus, type LivingGraphEntity } from "../lib/api";

interface AmbientGraphHudProps {
  initialStatus?: LivingGraphStatus;
  autoPoll?: boolean;
  pollIntervalMs?: number;
  className?: string;
}

export function AmbientGraphHud({
  initialStatus,
  autoPoll = true,
  pollIntervalMs = 6000,
  className = "",
}: AmbientGraphHudProps) {
  const [status, setStatus] = useState<LivingGraphStatus | null>(initialStatus ?? null);
  const [loading, setLoading] = useState(!initialStatus);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const reqIdRef = useRef(0);

  const fetchGraphStatus = useCallback(async (background = false) => {
    const curReq = ++reqIdRef.current;
    if (!background) setLoading(true);
    try {
      const res = await getLivingGraphContext();
      if (!isMountedRef.current || curReq !== reqIdRef.current) return;
      setStatus(res);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current || curReq !== reqIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isMountedRef.current && curReq === reqIdRef.current && !background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    if (!initialStatus) {
      void fetchGraphStatus(false);
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [fetchGraphStatus, initialStatus]);

  useEffect(() => {
    if (!autoPoll || status?.scopeRequired) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void fetchGraphStatus(true);
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [autoPoll, pollIntervalMs, fetchGraphStatus, status?.scopeRequired]);

  if (!status && loading) {
    return (
      <div className={`card ${className}`} data-testid="ambient-graph-hud-loading" style={{ marginTop: 16 }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#ffffff", marginBottom: 6 }}>
          Ambient Living Graph & Cognitive HUD
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Synchronizing with Living Life Graph & Active Inference engine...
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={`card panel-danger ${className}`} data-testid="ambient-graph-hud-error" style={{ marginTop: 16 }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#ffffff", marginBottom: 6 }}>
          Ambient Living Graph & Cognitive HUD
        </div>
        <p className="status-error" style={{ margin: "4px 0 10px" }}>
          {error || "Living World Model offline"}
        </p>
        <button type="button" className="secondary pill" onClick={() => void fetchGraphStatus(false)}>
          Retry Sync
        </button>
      </div>
    );
  }

  const mode = status.cognitiveMode.toUpperCase();
  let modeBadgeBg = "rgba(16, 185, 129, 0.15)";
  let modeBadgeColor = "#34d399";
  if (mode === "DEEP_FOCUS") {
    modeBadgeBg = "rgba(99, 102, 241, 0.2)";
    modeBadgeColor = "#a5b4fc";
  } else if (mode === "RECEPTIVE") {
    modeBadgeBg = "rgba(6, 182, 212, 0.2)";
    modeBadgeColor = "#22d3ee";
  } else if (mode === "SURPRISED" || mode === "ANOMALY") {
    modeBadgeBg = "rgba(245, 158, 11, 0.25)";
    modeBadgeColor = "#fbbf24";
  }

  const activated: LivingGraphEntity[] = status.context?.activatedEntities ?? [];
  const recommended: string[] = status.context?.recommendedActions ?? [];
  const nextStates: string[] = status.context?.predictedNextStates ?? [];

  return (
    <div className={`card ${className}`} data-testid="ambient-graph-hud" style={{ marginTop: 16, position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "#ffffff", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#38bdf8",
              boxShadow: "0 0 10px #38bdf8",
            }} />
            Ambient Living Graph HUD
          </div>
          <div style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: 2 }}>
            Real-time cognitive projection & Active Inference
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span
            data-testid="cognitive-mode-badge"
            style={{
              fontSize: "11px",
              fontWeight: 700,
              padding: "3px 8px",
              borderRadius: "12px",
              background: modeBadgeBg,
              color: modeBadgeColor,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {mode}
          </span>
          <span
            data-testid="graph-size-badge"
            style={{
              fontSize: "11px",
              fontWeight: 600,
              padding: "3px 8px",
              borderRadius: "12px",
              background: "rgba(255, 255, 255, 0.08)",
              color: "var(--text-muted)",
            }}
          >
            {status.entityCount} entities · {status.edgeCount} edges
          </span>
          {error && (
            <span
              data-testid="graph-hud-stale-badge"
              style={{
                fontSize: "11px",
                fontWeight: 600,
                padding: "3px 8px",
                borderRadius: "12px",
                background: "rgba(245, 158, 11, 0.2)",
                color: "#fbbf24",
              }}
              title={error}
            >
              Stale
            </span>
          )}
        </div>
      </div>

      {/* Top Activated Neural Entities */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Active Neural Entities
        </div>
        {activated.length === 0 ? (
          <div style={{ fontSize: "12.5px", color: "var(--text-dim)", fontStyle: "italic" }}>
            Life graph projection listening for incoming device events...
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-testid="activated-entities-list">
            {activated.slice(0, 8).map((entity) => (
              <div
                key={entity.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "rgba(255, 255, 255, 0.05)",
                  border: "1px solid rgba(255, 255, 255, 0.09)",
                  borderRadius: "8px",
                  padding: "4px 8px",
                  fontSize: "12px",
                }}
              >
                <span
                  style={{
                    fontSize: "9.5px",
                    fontWeight: 800,
                    padding: "1px 5px",
                    borderRadius: "4px",
                    background:
                      entity.type === "PERSON"
                        ? "rgba(244, 63, 94, 0.2)"
                        : entity.type === "PROJECT"
                        ? "rgba(99, 102, 241, 0.25)"
                        : entity.type === "GOAL"
                        ? "rgba(16, 185, 129, 0.2)"
                        : "rgba(56, 189, 248, 0.2)",
                    color:
                      entity.type === "PERSON"
                        ? "#fb7185"
                        : entity.type === "PROJECT"
                        ? "#818cf8"
                        : entity.type === "GOAL"
                        ? "#34d399"
                        : "#38bdf8",
                  }}
                >
                  {entity.type}
                </span>
                <span style={{ color: "var(--text)", fontWeight: 500 }}>{entity.name || entity.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active Inference Recommendations */}
      {recommended.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Proactive Inferences
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="recommended-actions-list">
            {recommended.slice(0, 4).map((action, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: "12.5px",
                  color: "#cbd5e1",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  background: "rgba(99, 102, 241, 0.08)",
                  borderRadius: "6px",
                  borderLeft: "3px solid #6366f1",
                }}
              >
                <span>⚡</span>
                <span>{action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Predicted Next States */}
      {nextStates.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Anticipated Next States
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-testid="predicted-states-list">
            {nextStates.slice(0, 6).map((state, idx) => (
              <span
                key={idx}
                style={{
                  fontSize: "11px",
                  color: "#94a3b8",
                  background: "rgba(255, 255, 255, 0.04)",
                  padding: "3px 8px",
                  borderRadius: "6px",
                }}
              >
                → {state}
              </span>
            ))}
          </div>
        </div>
      )}

      {status.scopeRequired && (
        <div style={{ fontSize: "11px", color: "var(--warning)", marginTop: 8, fontStyle: "italic" }}>
          ⚠️ Real-time topology streaming requires admin:read scope (grant via PC: grant-scope-cli.ts).
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button
          type="button"
          className="secondary pill"
          onClick={() => void fetchGraphStatus(false)}
          data-testid="graph-hud-refresh-btn"
          style={{ fontSize: "11px", padding: "4px 12px" }}
        >
          {loading ? "Syncing..." : "Refresh HUD"}
        </button>
      </div>
    </div>
  );
}
