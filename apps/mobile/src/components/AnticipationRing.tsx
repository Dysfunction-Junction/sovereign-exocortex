import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import {
  getPrecognitiveStatus,
  sendPrecognitiveTelemetry,
  calibratePrecognitive,
  type PreCognitiveStatus,
} from "../lib/api";

interface AnticipationRingProps {
  initialStatus?: PreCognitiveStatus;
  autoPoll?: boolean;
  pollIntervalMs?: number;
  onStatusChange?: (status: PreCognitiveStatus) => void;
  className?: string;
}

export function AnticipationRing({
  initialStatus,
  autoPoll = true,
  pollIntervalMs = 5000,
  onStatusChange,
  className = "",
}: AnticipationRingProps) {
  const [status, setStatus] = useState<PreCognitiveStatus | null>(initialStatus ?? null);
  const [initialLoading, setInitialLoading] = useState(!initialStatus);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastDwellReported, setLastDwellReported] = useState<number | null>(null);
  const [isHolding, setIsHolding] = useState(false);
  const [holdDurationMs, setHoldDurationMs] = useState(0);
  const [probing, setProbing] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationMsg, setCalibrationMsg] = useState<string | null>(null);

  const holdStartRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const reqIdRef = useRef(0);

  const onChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onChangeRef.current = onStatusChange;
  });

  const fetchStatus = useCallback(async (isBackgroundPoll = false) => {
    if (!isBackgroundPoll) {
      setInitialLoading(true);
    }
    const currentReqId = ++reqIdRef.current;
    try {
      const res = await getPrecognitiveStatus();
      if (!isMountedRef.current || currentReqId !== reqIdRef.current) return;
      setStatus(res);
      setPollError(null);
      onChangeRef.current?.(res);
    } catch (err) {
      if (!isMountedRef.current || currentReqId !== reqIdRef.current) return;
      setPollError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isMountedRef.current && !isBackgroundPoll) {
        setInitialLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    if (!initialStatus) {
      void fetchStatus(false);
    }
    return () => {
      isMountedRef.current = false;
      if (holdTimerRef.current !== null) {
        clearInterval(holdTimerRef.current);
      }
    };
  }, [fetchStatus, initialStatus]);

  useEffect(() => {
    if (!autoPoll) return;

    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return; // Pause polling when app/tab is backgrounded
      }
      void fetchStatus(true);
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [autoPoll, pollIntervalMs, fetchStatus]);

  const handlePointerDown = () => {
    const now = Date.now();
    holdStartRef.current = now;
    setIsHolding(true);
    setHoldDurationMs(0);

    if (holdTimerRef.current !== null) {
      clearInterval(holdTimerRef.current);
    }

    holdTimerRef.current = window.setInterval(() => {
      if (holdStartRef.current !== null) {
        setHoldDurationMs(Date.now() - holdStartRef.current);
      }
    }, 50);
  };

  const endHold = async (commit: boolean) => {
    const start = holdStartRef.current;
    if (start === null) return;
    holdStartRef.current = null;

    if (holdTimerRef.current !== null) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setIsHolding(false);

    if (!commit) return;

    const dwellMs = Math.max(1, Date.now() - start);
    setLastDwellReported(dwellMs);

    try {
      setActionError(null);
      const updated = await sendPrecognitiveTelemetry({
        dwell_ms: dwellMs,
        touch_duration_ms: dwellMs,
      });
      // Invalidate in-flight polls so newer telemetry is not clobbered
      ++reqIdRef.current;
      if (isMountedRef.current) {
        setStatus(updated);
        onChangeRef.current?.(updated);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleProbePulse = async () => {
    try {
      setProbing(true);
      setActionError(null);
      const updated = await sendPrecognitiveTelemetry({
        dwell_ms: 125,
        vibration: false,
        synthetic: true,
      });
      ++reqIdRef.current;
      if (isMountedRef.current) {
        setStatus(updated);
        setLastDwellReported(125);
        onChangeRef.current?.(updated);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isMountedRef.current) {
        setProbing(false);
      }
    }
  };

  const handleCalibrate = async () => {
    try {
      setCalibrating(true);
      setCalibrationMsg(null);
      setActionError(null);
      const result = await calibratePrecognitive(5);
      if (result.error) {
        setCalibrationMsg(`Calibration error: ${result.error}`);
      } else if (result.calibrated) {
        setCalibrationMsg(`Calibrated: ${result.wakeThresholdMs}ms (${result.sampleCount} samples)`);
      } else {
        setCalibrationMsg(`Need ${result.minSamples ?? 5} samples (currently ${result.sampleCount})`);
      }
      await fetchStatus(false);
    } catch (err) {
      if (isMountedRef.current) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isMountedRef.current) {
        setCalibrating(false);
      }
    }
  };

  if (!status && initialLoading) {
    return (
      <div className={`anticipation-card ${className}`} data-testid="anticipation-ring-card">
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#ffffff", marginBottom: 6 }}>
          Pre-Cognitive Dynamic Wake
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Initializing Obsidian Glass anticipation ring...
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className={`anticipation-card ${className}`} data-testid="anticipation-ring-card">
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#ffffff", marginBottom: 6 }}>
          Pre-Cognitive Dynamic Wake
        </div>
        <p className="status-error" style={{ margin: "4px 0" }}>
          {pollError || "Precognitive engine offline"}
        </p>
        <button type="button" className="secondary pill" onClick={() => void fetchStatus(false)}>
          Retry
        </button>
      </div>
    );
  }

  // Urgency styling mapping
  const urgency = String(status.urgencyIntent ?? "CASUAL").toUpperCase();
  const isUrgent = urgency === "HIGH_URGENCY";
  const isPrepared = urgency === "PREPARED";

  let ringGlowColor = "rgba(16, 185, 129, 0.25)";
  let strokeColor = "#10b981";
  let badgeBg = "rgba(16, 185, 129, 0.15)";
  let badgeColor = "#34d399";
  let barGradient = "linear-gradient(90deg, #10b981 0%, #059669 100%)";

  if (isUrgent) {
    ringGlowColor = "rgba(245, 158, 11, 0.4)";
    strokeColor = "#f59e0b";
    badgeBg = "rgba(245, 158, 11, 0.2)";
    badgeColor = "#fbbf24";
    barGradient = "linear-gradient(90deg, #f59e0b 0%, #dc2626 100%)";
  } else if (isPrepared) {
    ringGlowColor = "rgba(6, 182, 212, 0.35)";
    strokeColor = "#06b6d4";
    badgeBg = "rgba(6, 182, 212, 0.2)";
    badgeColor = "#22d3ee";
    barGradient = "linear-gradient(90deg, #06b6d4 0%, #3b82f6 100%)";
  }

  // SVG Gauge Calculations
  const radius = 70;
  const circumference = 2 * Math.PI * radius; // ~439.82
  const rawHesitation = Number(status.hesitationScore);
  const clampedHesitation = Number.isFinite(rawHesitation) ? Math.max(0, Math.min(1, rawHesitation)) : 0;
  const readinessPercent = Math.round((1 - clampedHesitation) * 100);
  const strokeDashoffset = circumference * (1 - readinessPercent / 100);

  return (
    <div
      className={`anticipation-card ${className}`}
      style={{ "--ring-glow-color": ringGlowColor } as CSSProperties}
      data-testid="anticipation-ring-card"
    >
      <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: "#ffffff", letterSpacing: "0.02em" }}>
            Pre-Cognitive Dynamic Wake
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-dim)", marginTop: "2px" }}>
            Obsidian Glass Anticipation Ring
          </div>
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span
            className="badge"
            style={{
              fontSize: "10px",
              padding: "2px 8px",
              background: status.calibrated ? "rgba(16, 185, 129, 0.2)" : "rgba(255, 255, 255, 0.08)",
              color: status.calibrated ? "#34d399" : "var(--text-muted)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
            }}
          >
            {status.calibrated ? `Calibrated (${status.sampleCount})` : `Uncalibrated (${status.sampleCount})`}
          </span>
          <span
            className="badge"
            style={{
              fontSize: "10px",
              padding: "2px 8px",
              background: "rgba(99, 102, 241, 0.15)",
              color: "#a5b4fc",
              border: "1px solid rgba(99, 102, 241, 0.3)",
              textTransform: "uppercase",
            }}
          >
            {status.source}
          </span>
        </div>
      </div>

      <div
        className="anticipation-ring-container"
        onPointerDown={handlePointerDown}
        onPointerUp={() => void endHold(true)}
        onPointerLeave={() => void endHold(false)}
        onPointerCancel={() => void endHold(false)}
        role="button"
        tabIndex={0}
        aria-label="Anticipation ring dynamic wake target"
        data-testid="anticipation-ring-touch"
      >
        <svg className="anticipation-ring-svg" viewBox="0 0 200 200">
          <circle className="anticipation-ring-track" cx="100" cy="100" r={radius} />
          <circle
            className={`anticipation-ring-progress anticipation-ring-pulse ${isUrgent ? "urgent" : ""}`}
            cx="100"
            cy="100"
            r={radius}
            stroke={strokeColor}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
          />
        </svg>

        <div className="anticipation-center-content">
          <span
            className="anticipation-urgency-badge"
            style={{ background: badgeBg, color: badgeColor }}
            data-testid="urgency-badge"
          >
            {status.urgencyIntent}
          </span>
          <div className="anticipation-latency-val" data-testid="wake-threshold">
            {status.wakeThresholdMs}ms
          </div>
          <span className="anticipation-subtext">p20 wake quantile</span>
          {status.isPreStaged && (
            <span
              style={{
                marginTop: "4px",
                fontSize: "10px",
                fontWeight: 700,
                color: "#c084fc",
                letterSpacing: "0.04em",
              }}
            >
              PRE-STAGED
            </span>
          )}
        </div>
      </div>

      <div className="hesitation-bar-container">
        <div className="hesitation-bar-header">
          <span>Readiness Score</span>
          <span data-testid="readiness-score">{readinessPercent}%</span>
        </div>
        <div className="hesitation-track">
          <div
            className="hesitation-fill"
            style={{
              width: `${readinessPercent}%`,
              background: barGradient,
            }}
          />
        </div>
      </div>

      <div
        className={`dwell-probe-target ${isHolding ? "active" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerUp={() => void endHold(true)}
        onPointerLeave={() => void endHold(false)}
        onPointerCancel={() => void endHold(false)}
        role="button"
        tabIndex={0}
        aria-label="Hold to measure touch dwell duration"
        data-testid="dwell-probe-target"
      >
        <span>
          {isHolding
            ? `Recording Dwell: ${holdDurationMs}ms...`
            : lastDwellReported !== null
            ? `Last probe dwell: ${lastDwellReported}ms (Hold to test)`
            : "Hold probe target to measure touch dwell"}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          gap: "10px",
          marginTop: "16px",
          width: "100%",
          justifyContent: "center",
        }}
      >
        <button
          type="button"
          className="secondary pill"
          onClick={handleProbePulse}
          disabled={probing}
          data-testid="probe-pulse-btn"
        >
          {probing ? "Probing..." : "Probe Pulse"}
        </button>
        <button
          type="button"
          className="secondary pill"
          onClick={handleCalibrate}
          disabled={calibrating}
          data-testid="calibrate-btn"
        >
          {calibrating ? "Calibrating..." : "Calibrate"}
        </button>
      </div>

      {calibrationMsg && (
        <div style={{ fontSize: "11px", color: "#38bdf8", marginTop: "10px", fontWeight: 600 }}>
          {calibrationMsg}
        </div>
      )}

      {actionError && (
        <div
          style={{
            fontSize: "11.5px",
            color: "#fb7185",
            marginTop: "10px",
            background: "rgba(244, 63, 94, 0.12)",
            padding: "4px 10px",
            borderRadius: "4px",
            border: "1px solid rgba(244, 63, 94, 0.25)",
          }}
          data-testid="action-error"
        >
          {actionError}
        </div>
      )}

      {pollError && !actionError && (
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-dim)",
            marginTop: "8px",
          }}
        >
          Background update paused: {pollError}
        </div>
      )}
    </div>
  );
}

export default AnticipationRing;
