import { useEffect, useState, useRef } from "react";
import {
  getChannels,
  syncChannel,
  configureChannel,
  toggleAirGap,
  type ChannelClientStatus,
} from "../lib/api";

export function IntegrationsHub() {
  const [channels, setChannels] = useState<ChannelClientStatus[]>([]);
  const [airGap, setAirGap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Edit states for inline configuration
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [configMode, setConfigMode] = useState<"api" | "offline">("api");
  const [configInput, setConfigInput] = useState("");

  const isMountedRef = useRef(true);

  async function loadData() {
    try {
      const data = await getChannels();
      if (!isMountedRef.current) return;
      setChannels(data.channels);
      setAirGap(data.airGap);
      setErrorMessage(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    isMountedRef.current = true;
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
    };
  }, []);

  async function handleToggleAirGap() {
    try {
      const res = await toggleAirGap(!airGap);
      setAirGap(res.airGap);
      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSync(channelId: string) {
    setSyncingId(channelId);
    setErrorMessage(null);
    try {
      await syncChannel(channelId);
      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      if (isMountedRef.current) {
        setSyncingId(null);
      }
    }
  }

  async function handleSaveConfig(channelId: string) {
    setErrorMessage(null);
    const trimmed = configInput.trim();
    if (!trimmed) {
      setErrorMessage("Configuration input cannot be empty.");
      return;
    }

    try {
      if (channelId === "obsidian") {
        await configureChannel(channelId, { vaultPath: trimmed, watchEnabled: true });
      } else if (channelId === "notion") {
        if (configMode === "api") {
          await configureChannel(channelId, { apiKey: trimmed });
        } else {
          await configureChannel(channelId, { offlineExportPath: trimmed });
        }
      } else if (channelId === "gmail") {
        if (configMode === "api") {
          await configureChannel(channelId, { accessToken: trimmed });
        } else {
          await configureChannel(channelId, { offlineMboxDir: trimmed });
        }
      }
      setEditingChannel(null);
      setConfigInput("");
      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading && channels.length === 0) {
    return (
      <div className="card" style={{ marginTop: 20 }}>
        <p className="hint">Loading integration channels…</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      {/* Header and Air-Gap Status Bar */}
      <div className="card-row" style={{ marginBottom: 12, alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Integration Channels & Air-Gap Defense</h3>
          <p className="hint" style={{ margin: "2px 0 0", fontSize: 13 }}>
            Connect local vaults and cloud streams into the Living Brain with one-way diode defenses.
          </p>
        </div>
        <button
          type="button"
          onClick={handleToggleAirGap}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            borderRadius: 6,
            border: airGap ? "1px solid #10b981" : "1px solid #64748b",
            background: airGap ? "rgba(16, 185, 129, 0.15)" : "transparent",
            color: airGap ? "#10b981" : "inherit",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {airGap ? "🛡️ Air-Gap Active" : "🌐 Air-Gap Disabled"}
        </button>
      </div>

      {airGap && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            background: "rgba(16, 185, 129, 0.1)",
            border: "1px solid rgba(16, 185, 129, 0.3)",
            color: "#10b981",
            fontSize: 12,
            marginBottom: 16,
          }}
        >
          <strong>Sovereign Isolation Active:</strong> All outbound WAN requests to cloud services are blocked at the socket level. Local Obsidian operates with 100% full capability.
        </div>
      )}

      {errorMessage && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            color: "#ef4444",
            fontSize: 12,
            marginBottom: 16,
          }}
        >
          {errorMessage}
        </div>
      )}

      {/* Channel Cards Grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {channels.map((ch) => {
          const isSyncing = syncingId === ch.id || ch.status === "syncing";
          const isConnected = ch.status === "connected";

          return (
            <div
              key={ch.id}
              style={{
                padding: "12px 14px",
                borderRadius: 8,
                background: "rgba(255, 255, 255, 0.03)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{ch.name}</span>
                    {ch.airGapped && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "rgba(56, 189, 248, 0.15)",
                          color: "#38bdf8",
                          fontWeight: 600,
                        }}
                      >
                        100% Air-Gapped
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: isConnected ? "rgba(16, 185, 129, 0.2)" : "rgba(148, 163, 184, 0.15)",
                        color: isConnected ? "#10b981" : "#94a3b8",
                      }}
                    >
                      {isConnected ? "Connected" : ch.status === "error" ? "Error" : "Standby"}
                    </span>
                  </div>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color: "#94a3b8" }}>{ch.description}</p>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingChannel === ch.id) {
                        setEditingChannel(null);
                        setConfigInput("");
                      } else {
                        setEditingChannel(ch.id);
                        // Do not prefill summary strings into raw inputs to prevent corrupting configs
                        setConfigInput(ch.id === "obsidian" ? "C:\\Users\\micha\\Vault" : "");
                        setConfigMode(ch.airGapped ? "offline" : "api");
                      }
                    }}
                    style={{
                      padding: "4px 8px",
                      fontSize: 11,
                      borderRadius: 4,
                      background: "rgba(255, 255, 255, 0.06)",
                      border: "1px solid rgba(255, 255, 255, 0.15)",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {editingChannel === ch.id ? "Cancel" : "Configure"}
                  </button>

                  <button
                    type="button"
                    disabled={isSyncing}
                    onClick={() => handleSync(ch.id)}
                    style={{
                      padding: "4px 10px",
                      fontSize: 11,
                      borderRadius: 4,
                      background: isConnected ? "#2563eb" : "rgba(255, 255, 255, 0.1)",
                      border: "none",
                      color: "#fff",
                      cursor: isSyncing ? "default" : "pointer",
                      fontWeight: 600,
                      opacity: isSyncing ? 0.6 : 1,
                    }}
                  >
                    {isSyncing ? "Syncing…" : "Sync Now"}
                  </button>
                </div>
              </div>

              {/* Status info bar */}
              <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#64748b", marginTop: 4 }}>
                <div>
                  <strong>Indexed:</strong> {ch.itemCount.toLocaleString()} items
                </div>
                {ch.configSummary && (
                  <div style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <strong>Target:</strong> {ch.configSummary}
                  </div>
                )}
                {ch.lastSyncAt && (
                  <div>
                    <strong>Last Sync:</strong> {new Date(ch.lastSyncAt).toLocaleTimeString()}
                  </div>
                )}
              </div>

              {/* Inline Configure Drawer */}
              {editingChannel === ch.id && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255, 255, 255, 0.06)" }}>
                  {ch.id !== "obsidian" && (
                    <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 11 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                          type="radio"
                          name={`mode-${ch.id}`}
                          value="api"
                          checked={configMode === "api"}
                          onChange={() => setConfigMode("api")}
                        />
                        Live API Mode (Inbound Diode)
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                          type="radio"
                          name={`mode-${ch.id}`}
                          value="offline"
                          checked={configMode === "offline"}
                          onChange={() => setConfigMode("offline")}
                        />
                        Offline Local Folder (100% Air-Gapped)
                      </label>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      type={configMode === "api" && ch.id !== "obsidian" ? "password" : "text"}
                      value={configInput}
                      onChange={(e) => setConfigInput(e.target.value)}
                      placeholder={
                        ch.id === "obsidian"
                          ? "C:\\Users\\micha\\Vault"
                          : configMode === "api"
                          ? ch.id === "notion"
                            ? "secret_... or ntn_..."
                            : "OAuth Access Token"
                          : ch.id === "notion"
                          ? "C:\\path\\to\\notion-export"
                          : "C:\\path\\to\\mbox-dir"
                      }
                      style={{
                        flex: 1,
                        padding: "6px 8px",
                        fontSize: 12,
                        background: "rgba(0, 0, 0, 0.3)",
                        border: "1px solid rgba(255, 255, 255, 0.15)",
                        borderRadius: 4,
                        color: "#fff",
                        fontFamily: "monospace",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => handleSaveConfig(ch.id)}
                      style={{
                        padding: "6px 12px",
                        fontSize: 12,
                        borderRadius: 4,
                        background: "#10b981",
                        border: "none",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      Save & Connect
                    </button>
                  </div>
                  <p style={{ margin: "4px 0 0", fontSize: 11, color: "#94a3b8" }}>
                    {ch.id === "obsidian"
                      ? "Points to your local Obsidian vault directory (default: C:\\Users\\micha\\Vault)."
                      : configMode === "api"
                      ? ch.id === "notion"
                        ? "Enter Notion Internal Integration token (secret_... or ntn_...)."
                        : "Enter Google OAuth access token."
                      : ch.id === "notion"
                      ? "Points to a local directory containing unzipped Notion markdown export files."
                      : "Points to a local directory containing exported .eml or .mbox files."}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
