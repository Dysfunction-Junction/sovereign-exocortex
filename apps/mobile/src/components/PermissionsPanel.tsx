import { useCallback, useEffect, useState } from "react";
import { App } from "@capacitor/app";
import {
  PERMISSIONS,
  getPermissionStatus,
  isNative,
  requestPermission,
  sendUsageSnapshot,
  type PermissionName,
  type PermissionStatus,
} from "../lib/devicePermissions";

// Shows every phone permission with its state and a button that asks for it. Special grants open Settings, so the
// panel re-reads the state whenever the app returns to the foreground.
export function PermissionsPanel() {
  const [status, setStatus] = useState<PermissionStatus | null>(null);
  const [note, setNote] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await getPermissionStatus());
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not read permission state");
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!isNative()) return;
    const handle = App.addListener("appStateChange", (s) => {
      if (s.isActive) void refresh();
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, [refresh]);

  if (!isNative()) {
    return null;
  }

  const grant = async (name: PermissionName) => {
    setNote("");
    try {
      const next = await requestPermission(name);
      if (next) setStatus(next);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Request failed");
    }
  };

  const testUsage = async () => {
    try {
      const r = await sendUsageSnapshot(15);
      setNote(r?.queued ? "Usage summary queued; it will sync with the next flush." : `Usage summary not sent: ${r?.result ?? "unavailable"}`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Usage summary failed");
    }
  };

  return (
    <div className="card">
      <h3>Phone permissions</h3>
      <p className="hint">Grant these so the phone can keep sending context. Special ones open Settings.</p>
      {PERMISSIONS.map((p) => {
        const on = status?.[p.name] === true;
        return (
          <div key={p.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, margin: "10px 0" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {p.title}
                {p.optional ? " (optional)" : ""}
              </div>
              <div className="hint" style={{ margin: 0 }}>{p.why}</div>
            </div>
            {on ? (
              <span className="status-ok">On</span>
            ) : (
              <button className="secondary" onClick={() => void grant(p.name)}>
                {p.kind === "runtime" ? "Allow" : "Open settings"}
              </button>
            )}
          </div>
        );
      })}
      <button className="secondary" onClick={() => void testUsage()}>Send a usage summary now</button>
      {note && <p className="hint" role="status">{note}</p>}
    </div>
  );
}
