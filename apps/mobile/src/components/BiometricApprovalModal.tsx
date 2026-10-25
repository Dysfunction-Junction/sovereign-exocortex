import { explainProposal } from "../lib/proposalExplainer";
import { useState, useEffect } from "react";
import { proposalManager, type TrackedProposal } from "../lib/proposals";

export default function BiometricApprovalModal() {
  const [pending, setPending] = useState<TrackedProposal[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingSec, setRemainingSec] = useState<number>(0);

  useEffect(() => {
    const update = (list: TrackedProposal[]) => {
      setPending(list.filter((p) => p.state === "pending"));
    };
    update(proposalManager.getProposals());
    return proposalManager.subscribe(update);
  }, []);

  const active = pending[0] ?? null;

  useEffect(() => {
    if (!active) return;
    const updateTime = () => {
      const left = Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000));
      setRemainingSec(left);
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return null;

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await proposalManager.approve(active.proposalId);
      if (!res.ok && res.status !== "cancelled") {
        setError(res.error || res.status || "That did not go through. Nothing was done.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await proposalManager.reject(active.proposalId, "User dismissed from mobile modal");
      if (!res.ok && res.status !== "not_found") {
        setError(res.error || res.status || "That did not go through. Please try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const explanation = explainProposal(active);
  const isShadow = Boolean(active.shadow);
  const isHighRisk = !isShadow && (active.riskLevel === "high" || active.requiresBiometric);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "400px",
          background: "linear-gradient(145deg, #181920 0%, #101116 100%)",
          border: isShadow ? "1px solid rgba(168, 85, 247, 0.5)" : isHighRisk ? "1px solid rgba(239, 68, 68, 0.4)" : "1px solid rgba(59, 130, 246, 0.4)",
          borderRadius: "16px",
          boxShadow: isHighRisk
            ? "0 20px 40px rgba(239, 68, 68, 0.2)"
            : "0 20px 40px rgba(147, 51, 234, 0.2)",
          padding: "20px",
          color: "#f3f4f6",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              textTransform: "uppercase",
              padding: "4px 8px",
              borderRadius: "6px",
              background: isShadow ? "rgba(168, 85, 247, 0.2)" : isHighRisk ? "rgba(239, 68, 68, 0.2)" : "rgba(59, 130, 246, 0.2)",
              color: isShadow ? "#c084fc" : isHighRisk ? "#f87171" : "#60a5fa",
              letterSpacing: "0.05em",
            }}
          >
            {isShadow ? "🧪 Practice question" : isHighRisk ? "🔒 Needs your fingerprint or face" : "⚡ Quick suggestion"}
          </span>
          <span style={{ fontSize: "12px", color: remainingSec < 15 ? "#ef4444" : "#9ca3af", fontVariantNumeric: "tabular-nums" }}>
            ⏱ {remainingSec}s left
          </span>
        </div>

        <h3 style={{ margin: "0 0 8px 0", fontSize: "16px", fontWeight: 600, color: "#fff" }}>
          {explanation.title}
        </h3>

        <div style={{ fontSize: "13px", color: "#d1d5db", marginBottom: "16px", lineHeight: 1.45 }}>
          <div style={{ marginBottom: "8px" }}><strong>What it will do:</strong> {explanation.doesWhat}</div>
          <div style={{ marginBottom: "8px" }}><strong>What gets saved:</strong> {explanation.saved}</div>
          <div style={{ marginBottom: "8px" }}><strong>What changes:</strong> {explanation.changes}</div>
          <div style={{ color: "#9ca3af", fontSize: "12px" }}>
            {active.riskLevel === "low" ? "Low risk: easy to undo." : active.riskLevel === "high" ? "Higher risk: please check before saying yes." : "Moderate risk."} Choosing No does nothing.
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              marginBottom: "14px",
              borderRadius: "8px",
              background: "rgba(239, 68, 68, 0.15)",
              color: "#fca5a5",
              fontSize: "12px",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
          <button
            onClick={handleReject}
            disabled={submitting}
            style={{
              flex: 1,
              padding: "10px",
              borderRadius: "10px",
              background: "#27272a",
              color: "#d4d4d8",
              border: "1px solid #3f3f46",
              cursor: submitting ? "not-allowed" : "pointer",
              fontWeight: 500,
              fontSize: "13px",
            }}
          >
            No thanks
          </button>
          <button
            onClick={handleApprove}
            disabled={submitting || remainingSec <= 0}
            style={{
              flex: 2,
              padding: "10px",
              borderRadius: "10px",
              background: isHighRisk
                ? "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)"
                : "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)",
              color: "#fff",
              border: "none",
              cursor: submitting || remainingSec <= 0 ? "not-allowed" : "pointer",
              fontWeight: 600,
              fontSize: "13px",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
            }}
          >
            {submitting ? "Checking it's you…" : isShadow ? "Yes, that's useful" : isHighRisk ? "Yes, go ahead" : "Yes, do it"}
          </button>
        </div>
      </div>
    </div>
  );
}
