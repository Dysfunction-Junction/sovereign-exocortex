// Placeholder for the typed-text audit screen at /typed-text. The summarizer package replaces this with the
// fingerprint-gated list of notes and the erase button. Until then there is nothing stored to show.
export default function TypedTextAudit() {
  return (
    <div className="panel">
      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Typed-text notes</span>
      <p className="hint" style={{ margin: 0 }}>No notes yet. Summaries stay on this phone and open only with your fingerprint.</p>
    </div>
  );
}
