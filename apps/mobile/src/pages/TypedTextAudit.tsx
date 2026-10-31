import { useEffect, useState } from "react";
import type {
  TypedNote,
  TypedTextCounters,
  PreferredControl,
} from "../lib/typedText";
import {
  getTypedCounters,
  isTypedGateOn,
  toggleTypedGate,
  getPreferredControl,
  setPreferredControl,
  listTypedNotes,
  unlockEpoch,
  deleteTypedNote,
  deleteAllTypedNotes,
  setSecureWindow,
  lockAuditSession
} from "../lib/typedText";

export default function TypedTextAudit() {
  const [gateOn, setGateOn] = useState<boolean>(false);
  const [control, setControl] = useState<PreferredControl>("in_app");
  const [counters, setCounters] = useState<TypedTextCounters | null>(null);
  const [notes, setNotes] = useState<TypedNote[]>([]);
  const [modelState] = useState<"not installed" | "verifying" | "ready" | "failed">("not installed");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await setSecureWindow(true);
      } catch (err) {
        console.warn("Could not set secure window", err);
      }
      if (mounted) {
        await loadData();
      }
    })();
    return () => {
      mounted = false;
      lockAuditSession().catch(() => {});
      setSecureWindow(false).catch(() => {});
    };
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [isOn, prefControl, currentCounters, notesList] = await Promise.all([
        isTypedGateOn(),
        getPreferredControl(),
        getTypedCounters(),
        listTypedNotes()
      ]);
      setGateOn(isOn);
      setControl(prefControl);
      setCounters(currentCounters);
      setNotes(notesList);
    } catch (e: any) {
      setError(e?.message || "Failed to load audit data");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleGate() {
    try {
      const next = !gateOn;
      const res = await toggleTypedGate(next);
      setGateOn(res);
    } catch (e: any) {
      setError(e?.message || "Failed to toggle gate");
    }
  }

  async function handleControlChange(newControl: PreferredControl) {
    try {
      const saved = await setPreferredControl(newControl);
      setControl(saved);
    } catch (e: any) {
      setError(e?.message || "Failed to change preferred control");
    }
  }

  async function handleUnlock(epochId: number) {
    try {
      const ok = await unlockEpoch(epochId);
      if (ok) {
        const refreshed = await listTypedNotes();
        setNotes(refreshed);
      }
    } catch (e: any) {
      setError(e?.message || "Authentication cancelled or failed");
    }
  }

  async function handleDeleteNote(id: string) {
    try {
      await deleteTypedNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (e: any) {
      setError(e?.message || "Failed to delete note");
    }
  }

  async function handleDeleteAll() {
    if (!window.confirm("Delete all typed-text notes, epoch encryption keys, and purge secure store?")) {
      return;
    }
    try {
      await deleteAllTypedNotes();
      setNotes([]);
      const currentCounters = await getTypedCounters();
      setCounters(currentCounters);
    } catch (e: any) {
      setError(e?.message || "Failed to erase notes");
    }
  }

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>Typed-Text Audit & Storage</span>
        <button className="button secondary" onClick={loadData} disabled={loading} style={{ fontSize: 12, padding: "4px 8px" }}>
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: 8, background: "rgba(255,0,0,0.1)", color: "#ff6b6b", borderRadius: 4, fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Model & Kill Switch Status */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Model Status:</span>
          <span style={{ fontSize: 13, textTransform: "capitalize", color: modelState === "ready" ? "#4ade80" : "var(--muted)" }}>
            {modelState}
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Kill Switch (Gate):</div>
            <div className="hint" style={{ fontSize: 12, margin: 0 }}>Instant off clears memory buffers & zero-fills KEK</div>
          </div>
          <button
            className={`button ${gateOn ? "primary" : "secondary"}`}
            onClick={handleToggleGate}
            style={{ minWidth: 70 }}
          >
            {gateOn ? "ON" : "OFF"}
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>Preferred Control:</span>
          <select
            value={control}
            onChange={(e) => handleControlChange(e.target.value as PreferredControl)}
            style={{ background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px" }}
          >
            <option value="in_app">App Switch</option>
            <option value="quick_settings_tile">Quick Settings Tile</option>
            <option value="accessibility_button">Accessibility Button</option>
          </select>
        </div>
      </div>

      {/* Drop & Capture Counters */}
      {counters && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Telemetry Counters</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
            <div style={{ padding: 6, background: "var(--surface)", borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Captured</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{counters.captured}</div>
            </div>
            <div style={{ padding: 6, background: "var(--surface)", borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Flushed</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{counters.flushed}</div>
            </div>
            <div style={{ padding: 6, background: "var(--surface)", borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Stored</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#4ade80" }}>{counters.stored}</div>
            </div>
            <div style={{ padding: 6, background: "var(--surface)", borderRadius: 4 }}>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Dropped</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: counters.dropped > 0 ? "#f87171" : "var(--text)" }}>
                {counters.dropped}
              </div>
            </div>
          </div>

          {counters.dropped_reasons && Object.keys(counters.dropped_reasons).length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <span style={{ color: "var(--muted)" }}>Drop Reasons: </span>
              {Object.entries(counters.dropped_reasons).map(([reason, count]) => (
                <span key={reason} style={{ marginRight: 8, padding: "2px 6px", background: "rgba(255,0,0,0.1)", borderRadius: 3 }}>
                  {reason}: {count}
                </span>
              ))}
            </div>
          )}

          {counters.stripped_reasons && Object.keys(counters.stripped_reasons).length > 0 && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <span style={{ color: "var(--muted)" }}>Summary Stripped: </span>
              {Object.entries(counters.stripped_reasons).map(([reason, count]) => (
                <span key={reason} style={{ marginRight: 8, padding: "2px 6px", background: "rgba(234,179,8,0.15)", borderRadius: 3 }}>
                  {reason}: {count}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Encrypted Notes List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Stored Summaries ({notes.length})</span>
          {notes.length > 0 && (
            <button className="button danger" onClick={handleDeleteAll} style={{ fontSize: 12, padding: "4px 8px" }}>
              Erase All
            </button>
          )}
        </div>

        {notes.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            No summaries stored. Raw input is never saved; notes are created on-device and encrypted under your fingerprint.
          </p>
        ) : (
          notes.map((note) => (
            <div
              key={note.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: 10,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "var(--muted)" }}>
                <span>
                  {new Date(note.created_at).toLocaleString()} • <strong style={{ color: "var(--text)" }}>{note.app_category}</strong>
                </span>
                <button
                  className="button secondary"
                  onClick={() => handleDeleteNote(note.id)}
                  style={{ fontSize: 11, padding: "2px 6px" }}
                >
                  Delete
                </button>
              </div>

              {note.unlocked ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", color: "#60a5fa" }}>
                      {note.intent || "other"}
                    </span>
                    {note.topics && note.topics.map((t) => (
                      <span key={t} style={{ fontSize: 11, padding: "1px 5px", background: "rgba(255,255,255,0.06)", borderRadius: 3 }}>
                        #{t}
                      </span>
                    ))}
                  </div>

                  <p style={{ margin: "4px 0", fontSize: 14, color: "var(--text)" }}>
                    {note.summary || <em style={{ color: "var(--muted)" }}>[Summary stripped by privacy guard]</em>}
                  </p>

                  {note.stripped_reason && (
                    <span style={{ fontSize: 11, color: "#facc15" }}>
                      Stripped for privacy: {note.stripped_reason}
                    </span>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    Encrypted under epoch #{note.epoch_id}
                  </span>
                  <button
                    className="button primary"
                    onClick={() => handleUnlock(note.epoch_id)}
                    style={{ fontSize: 12, padding: "3px 10px" }}
                  >
                    Unlock with Fingerprint
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
