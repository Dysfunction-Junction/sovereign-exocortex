import { useEffect, useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router";
import {
  getPendingShadowProposals,
  ProxyNotConfiguredError,
  HomeNodeUnreachableError,
  type PendingProposal,
} from "../lib/api";
import { proposalManager, type TrackedProposal } from "../lib/proposals";
import { explainProposal } from "../lib/proposalExplainer";
import { fireAndForget, recordEventSafe } from "../lib/fireAndForget";
import { flushUsageEvents } from "../lib/flush";
import { ReviewIcon, RefreshIcon, CheckIcon, CloseIcon, AlertIcon } from "../components/Icons";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded" }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string }
  | { kind: "error"; message: string };

type FilterType = "all" | "gated" | "surfaced" | "staged";

const REASON_PRESETS = [
  "Wrong time",
  "Wrong thing",
  "Already did",
  "Not needed",
] as const;

export default function Review() {
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [allProposals, setAllProposals] = useState<PendingProposal[]>([]);
  const [proposalsMap, setProposalsMap] = useState<Map<string, TrackedProposal>>(new Map());
  const [selectedFilter, setSelectedFilter] = useState<FilterType>("all");
  const [activeReasonProposalId, setActiveReasonProposalId] = useState<string | null>(null);
  const [inFlightIds, setInFlightIds] = useState<Set<string>>(new Set());
  const [statusMessages, setStatusMessages] = useState<Record<string, { ok: boolean; text: string }>>({});

  const refreshProposalMap = useCallback(() => {
    const list = proposalManager.getProposals();
    const map = new Map<string, TrackedProposal>();
    for (const p of list) {
      map.set(p.proposalId, p);
    }
    setProposalsMap(map);
  }, []);

  const load = useCallback(async () => {
    setLoadState({ kind: "loading" });
    try {
      const items = await getPendingShadowProposals();
      for (const item of items) {
        proposalManager.ingestProposal({
          ...item,
          serverState: item.state,
        });
      }
      setAllProposals(items);
      refreshProposalMap();
      setLoadState({ kind: "loaded" });
    } catch (err) {
      if (err instanceof ProxyNotConfiguredError) {
        setLoadState({ kind: "not-configured" });
      } else if (err instanceof HomeNodeUnreachableError) {
        setLoadState({ kind: "home-offline", message: err.message });
      } else {
        setLoadState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [refreshProposalMap]);

  useEffect(() => {
    queueMicrotask(() => {
      fireAndForget(load(), "review.load");
    });
    recordEventSafe({ type: "screen_view", screen: "review", timestamp: new Date().toISOString() });
    void flushUsageEvents();

    const unsubscribe = proposalManager.subscribe(() => {
      refreshProposalMap();
    });
    return () => {
      unsubscribe();
    };
  }, [load, refreshProposalMap]);

  const handleLabelWanted = async (proposalId: string) => {
    setInFlightIds((prev) => new Set(prev).add(proposalId));
    setStatusMessages((prev) => {
      const next = { ...prev };
      delete next[proposalId];
      return next;
    });

    try {
      const res = await proposalManager.labelWanted(proposalId);
      if (res.ok) {
        setStatusMessages((prev) => ({
          ...prev,
          [proposalId]: { ok: true, text: "Marked as Wanted" },
        }));
      } else {
        setStatusMessages((prev) => ({
          ...prev,
          [proposalId]: { ok: false, text: res.error || "Failed to save label" },
        }));
      }
    } catch (err) {
      setStatusMessages((prev) => ({
        ...prev,
        [proposalId]: { ok: false, text: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setInFlightIds((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  const handleLabelNotWanted = async (proposalId: string, reason?: string) => {
    setInFlightIds((prev) => new Set(prev).add(proposalId));
    setActiveReasonProposalId(null);
    setStatusMessages((prev) => {
      const next = { ...prev };
      delete next[proposalId];
      return next;
    });

    try {
      const res = await proposalManager.labelNotWanted(proposalId, reason);
      if (res.ok) {
        setStatusMessages((prev) => ({
          ...prev,
          [proposalId]: { ok: true, text: reason ? `Not Wanted (${reason})` : "Marked as Not Wanted" },
        }));
      } else {
        setStatusMessages((prev) => ({
          ...prev,
          [proposalId]: { ok: false, text: res.error || "Failed to save label" },
        }));
      }
    } catch (err) {
      setStatusMessages((prev) => ({
        ...prev,
        [proposalId]: { ok: false, text: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setInFlightIds((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  const handleLabelAlreadyDid = async (proposalId: string) => {
    setInFlightIds((prev) => new Set(prev).add(proposalId));
    setStatusMessages((prev) => {
      const next = { ...prev };
      delete next[proposalId];
      return next;
    });

    try {
      const res = await proposalManager.labelAlreadyDid(proposalId);
      if (res.ok) {
        setStatusMessages((prev) => ({
          ...prev,
          [proposalId]: { ok: true, text: "Marked as Already Done" },
        }));
      } else {
        setStatusMessages((prev) => ({
          ...prev,
          [proposalId]: { ok: false, text: res.error || "Failed to save label" },
        }));
      }
    } catch (err) {
      setStatusMessages((prev) => ({
        ...prev,
        [proposalId]: { ok: false, text: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setInFlightIds((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  const handleLabelIgnored = async (proposalId: string) => {
    setInFlightIds((prev) => new Set(prev).add(proposalId));
    try {
      await proposalManager.labelIgnored(proposalId);
      setStatusMessages((prev) => ({
        ...prev,
        [proposalId]: { ok: true, text: "Dismissed" },
      }));
    } catch (err) {
      setStatusMessages((prev) => ({
        ...prev,
        [proposalId]: { ok: false, text: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setInFlightIds((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  const filterStats = useMemo(() => {
    let totalPending = 0;
    let gatedCount = 0;
    let surfacedCount = 0;
    let stagedCount = 0;
    let labeledCount = 0;

    for (const item of allProposals) {
      const tracked = proposalsMap.get(item.proposalId);
      const isPending = !tracked || tracked.state === "pending";
      if (!isPending) {
        labeledCount++;
      } else {
        totalPending++;
        const st = (item.state || "SURFACED").toUpperCase();
        if (st === "GATED") gatedCount++;
        else if (st === "SURFACED") surfacedCount++;
        else if (st === "STAGED") stagedCount++;
      }
    }

    return { totalPending, gatedCount, surfacedCount, stagedCount, labeledCount };
  }, [allProposals, proposalsMap]);

  const filteredProposals = useMemo(() => {
    return allProposals.filter((item) => {
      const tracked = proposalsMap.get(item.proposalId);
      const isPending = !tracked || tracked.state === "pending";
      const hasStatusMsg = Boolean(statusMessages[item.proposalId]);
      // Show pending proposals or ones just labeled in this session
      if (!isPending && !hasStatusMsg) return false;

      if (selectedFilter === "all") return true;
      const st = (item.state || "SURFACED").toUpperCase();
      if (selectedFilter === "gated") return st === "GATED";
      if (selectedFilter === "surfaced") return st === "SURFACED";
      if (selectedFilter === "staged") return st === "STAGED";
      return true;
    });
  }, [allProposals, proposalsMap, selectedFilter, statusMessages]);

  const totalBatch = allProposals.length;
  const progressPercent = totalBatch > 0 ? Math.round((filterStats.labeledCount / totalBatch) * 100) : 100;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-top">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ReviewIcon size={24} className="accent-text" />
            <h1 style={{ margin: 0 }}>Daily Shadow Review</h1>
          </div>
          <button className="secondary pill" onClick={load} title="Refresh proposals">
            <RefreshIcon size={14} /> Refresh
          </button>
        </div>
        <p className="hint">
          Review your assistant&apos;s practice proposals. One-tap answers calibrate the model
          without executing anything or changing your systems.
        </p>
      </div>

      {loadState.kind === "loading" && (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>Loading shadow proposals for daily review&hellip;</p>
        </div>
      )}

      {loadState.kind === "not-configured" && (
        <div className="card">
          <p className="status-error" style={{ marginBottom: 12 }}>Not set up yet.</p>
          <button onClick={() => navigate("/setup")}>Set Up Node Connection</button>
        </div>
      )}

      {loadState.kind === "home-offline" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 8 }}>
            Host is offline or unreachable. {loadState.message}
          </p>
          <button onClick={load}>Retry Connection</button>
        </div>
      )}

      {loadState.kind === "error" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 12 }}>{loadState.message}</p>
          <button onClick={load}>Retry</button>
        </div>
      )}

      {loadState.kind === "loaded" && (
        <>
          {/* Daily Progress Banner */}
          <div className="status-hero-card" style={{ marginBottom: 16 }}>
            <div className="card-row" style={{ marginBottom: 8 }}>
              <div>
                <span style={{ fontSize: 15, fontWeight: 700 }}>
                  {filterStats.totalPending === 0
                    ? "Batch Complete!"
                    : `${filterStats.totalPending} Shadow Proposals to Review`}
                </span>
                <p className="hint" style={{ margin: "2px 0 0", fontSize: 12 }}>
                  {filterStats.labeledCount} of {totalBatch} reviewed today ({progressPercent}%)
                </p>
              </div>
              <span className={`badge ${filterStats.totalPending === 0 ? "success" : "info"}`}>
                {filterStats.totalPending === 0 ? "All Done" : `${filterStats.totalPending} Pending`}
              </span>
            </div>
            <div
              style={{
                width: "100%",
                height: 6,
                background: "rgba(255, 255, 255, 0.08)",
                borderRadius: 3,
                overflow: "hidden",
                marginTop: 6,
              }}
            >
              <div
                style={{
                  width: `${progressPercent}%`,
                  height: "100%",
                  background: progressPercent === 100 ? "var(--color-success, #22c55e)" : "var(--color-primary, #6366f1)",
                  borderRadius: 3,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>

          {/* Filter Chips */}
          {allProposals.length > 0 && (
            <div
              style={{
                display: "flex",
                gap: 8,
                overflowX: "auto",
                paddingBottom: 8,
                marginBottom: 12,
              }}
            >
              <button
                type="button"
                className={`pill ${selectedFilter === "all" ? "primary" : "secondary"}`}
                onClick={() => setSelectedFilter("all")}
                style={{ fontSize: 12, padding: "4px 12px" }}
              >
                All ({filterStats.totalPending})
              </button>
              <button
                type="button"
                className={`pill ${selectedFilter === "gated" ? "primary" : "secondary"}`}
                onClick={() => setSelectedFilter("gated")}
                style={{ fontSize: 12, padding: "4px 12px" }}
              >
                Gated ({filterStats.gatedCount})
              </button>
              <button
                type="button"
                className={`pill ${selectedFilter === "surfaced" ? "primary" : "secondary"}`}
                onClick={() => setSelectedFilter("surfaced")}
                style={{ fontSize: 12, padding: "4px 12px" }}
              >
                Surfaced ({filterStats.surfacedCount})
              </button>
              {filterStats.stagedCount > 0 && (
                <button
                  type="button"
                  className={`pill ${selectedFilter === "staged" ? "primary" : "secondary"}`}
                  onClick={() => setSelectedFilter("staged")}
                  style={{ fontSize: 12, padding: "4px 12px" }}
                >
                  Staged ({filterStats.stagedCount})
                </button>
              )}
            </div>
          )}

          {/* List of Proposals */}
          {filteredProposals.length === 0 ? (
            <div className="card" style={{ textAlign: "center", padding: "32px 16px" }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 52,
                  height: 52,
                  borderRadius: "50%",
                  background: "rgba(34, 197, 94, 0.15)",
                  color: "#22c55e",
                  marginBottom: 12,
                }}
              >
                <CheckIcon size={28} />
              </div>
              <h2 style={{ fontSize: 18, margin: "0 0 6px" }}>All Caught Up!</h2>
              <p className="hint" style={{ maxWidth: 360, margin: "0 auto 16px" }}>
                {allProposals.length > 0
                  ? "You have reviewed all shadow proposals in this batch. Your answers directly calibrate precision for the rollout gate."
                  : "No shadow proposals are currently waiting for your review. When new proposals are evaluated, they will appear here."}
              </p>
              <button className="secondary pill" onClick={() => navigate("/status")}>
                Return to Status
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {filteredProposals.map((item) => {
                const explanation = explainProposal(item);
                const tracked = proposalsMap.get(item.proposalId);
                const isPending = !tracked || tracked.state === "pending";
                const isInFlight = inFlightIds.has(item.proposalId);
                const statusMsg = statusMessages[item.proposalId];
                const isReasonOpen = activeReasonProposalId === item.proposalId;
                const stateLabel = (item.state || "SURFACED").toUpperCase();

                return (
                  <div
                    key={item.proposalId}
                    className="card"
                    style={{
                      opacity: isPending ? 1 : 0.75,
                      borderColor: statusMsg?.ok ? "rgba(34, 197, 94, 0.4)" : undefined,
                      transition: "all 0.2s ease",
                    }}
                  >
                    {/* Header Badges */}
                    <div className="card-row" style={{ marginBottom: 8, alignItems: "flex-start" }}>
                      <div>
                        <h3 style={{ margin: "0 0 2px", fontSize: 16 }}>{explanation.title}</h3>
                        <p className="hint" style={{ margin: 0, fontSize: 12, fontFamily: "monospace" }}>
                          {item.candidateId}
                        </p>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <span className={`badge ${stateLabel === "GATED" ? "warning" : "info"}`}>
                          {stateLabel}
                        </span>
                        <span className={`badge ${item.riskLevel === "high" ? "danger" : item.riskLevel === "medium" ? "warning" : "success"}`}>
                          {item.riskLevel} risk
                        </span>
                        {typeof item.efe === "number" && (
                          <span className="badge neutral" title="Expected Free Energy">
                            EFE {item.efe.toFixed(2)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Explanation Body */}
                    <p style={{ margin: "0 0 10px", fontSize: 14, lineHeight: 1.45, color: "var(--text)" }}>
                      {item.summary || explanation.doesWhat}
                    </p>

                    {/* Status message or reason feedback */}
                    {statusMsg && (
                      <div
                        style={{
                          padding: "6px 10px",
                          borderRadius: 8,
                          fontSize: 13,
                          marginBottom: 10,
                          background: statusMsg.ok ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
                          color: statusMsg.ok ? "#22c55e" : "#ef4444",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {statusMsg.ok ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                        <span>{statusMsg.text}</span>
                      </div>
                    )}

                    {/* One-Tap Action Buttons (visible when pending) */}
                    {isPending && (
                      <>
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            flexWrap: "wrap",
                            marginTop: 6,
                          }}
                        >
                          <button
                            type="button"
                            className="primary pill"
                            disabled={isInFlight}
                            onClick={() => handleLabelWanted(item.proposalId)}
                            style={{
                              flex: "1 1 110px",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: 6,
                              background: "#16a34a",
                              borderColor: "#16a34a",
                            }}
                          >
                            <CheckIcon size={14} />
                            Wanted
                          </button>

                          <button
                            type="button"
                            className="secondary pill"
                            disabled={isInFlight}
                            onClick={() => {
                              if (isReasonOpen) {
                                void handleLabelNotWanted(item.proposalId);
                              } else {
                                setActiveReasonProposalId(item.proposalId);
                              }
                            }}
                            style={{
                              flex: "1 1 110px",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: 6,
                              borderColor: "#dc2626",
                              color: "#ef4444",
                            }}
                          >
                            <CloseIcon size={14} />
                            Not Wanted
                          </button>

                          <button
                            type="button"
                            className="secondary pill"
                            disabled={isInFlight}
                            onClick={() => handleLabelAlreadyDid(item.proposalId)}
                            style={{
                              flex: "1 1 100px",
                              fontSize: 12,
                            }}
                          >
                            Already Did
                          </button>

                          <button
                            type="button"
                            className="pill"
                            disabled={isInFlight}
                            onClick={() => handleLabelIgnored(item.proposalId)}
                            style={{
                              padding: "4px 8px",
                              fontSize: 11,
                              background: "transparent",
                              border: "none",
                              color: "var(--text-dim)",
                            }}
                          >
                            Dismiss
                          </button>
                        </div>

                        {/* Quick Reason Chips for Not Wanted */}
                        {isReasonOpen && (
                          <div
                            style={{
                              marginTop: 10,
                              padding: 10,
                              background: "rgba(0, 0, 0, 0.2)",
                              borderRadius: 8,
                              border: "1px solid rgba(255, 255, 255, 0.08)",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                                Optional: Why is this not wanted?
                              </span>
                              <button
                                type="button"
                                onClick={() => setActiveReasonProposalId(null)}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: "var(--text-dim)",
                                  cursor: "pointer",
                                  padding: 0,
                                }}
                              >
                                <CloseIcon size={14} />
                              </button>
                            </div>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {REASON_PRESETS.map((reason) => (
                                <button
                                  key={reason}
                                  type="button"
                                  className="secondary pill"
                                  disabled={isInFlight}
                                  onClick={() => handleLabelNotWanted(item.proposalId, reason)}
                                  style={{ fontSize: 12, padding: "4px 10px" }}
                                >
                                  {reason}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="secondary pill"
                                disabled={isInFlight}
                                onClick={() => handleLabelNotWanted(item.proposalId)}
                                style={{ fontSize: 12, padding: "4px 10px", color: "var(--text-dim)" }}
                              >
                                No reason
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
