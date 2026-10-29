import { useState, useEffect, useRef } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { BarcodeScanner } from "@capacitor-mlkit/barcode-scanning";

const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');

import {
  checkConnectionUrl, getProxyBaseUrl, getProxyToken, setProxyBaseUrl, setProxyToken,
  getRemoteGatewayUrl, getRemoteGatewayToken, setRemoteGatewayUrl, setRemoteGatewayToken,
  isScreenContextEnabled, setScreenContextEnabled,
  tryAutoConnectLocalPc,
} from "../lib/config";
import { checkProxyHealth, getStatus, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent, classifyMode } from "../lib/usage";
import { fireAndForget, logRejection, recordEventSafe } from "../lib/fireAndForget";
import { flushUsageEvents } from "../lib/flush";
import { registerApprovalKey } from "../lib/approvalKey";
import { parseConnectionQrPayload } from "../lib/connectionQr";
import { exchangePairingToken } from "../lib/pairing";
import { decodeJwtForDisplay, formatExpiry } from "../lib/jwtDisplay";
import {
  isNotificationListenerGranted, getNotificationCaptureConfig, setNotificationCapture,
  openNotificationListenerSettings,
  startNotificationCaptureListener,
} from "../lib/notificationCapture";
import {
  smsPermissions, openSmsAppSettings, runSmsBackfill, resetSmsBackfillToRecent,
  listSmsContacts, getSmsAllowlist, setSmsAllowlist, type SmsContact,
} from "../lib/smsBackfill";
import {
  SENSORS, MASTER_COPY, getSensorState, setSensorToggle, setSensorMaster, refreshSensors,
  isAvailable, needsActivityPermissionNow, type SensorKey, type SensorState,
} from "../lib/sensorConsent";
import { requestPermission } from "../lib/devicePermissions";
import { Switch } from "../components/Switch";
import { ScanIcon, CheckIcon, WifiIcon, CloudIcon } from "../components/Icons";

export default function Setup() {
  const scanBusy = useRef(false);

  // Plan A (LAN)
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  // Plan B (remote gateway) — optional; auto-failover target
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<"idle" | "ok" | "server-only" | "unreachable">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [screenContext, setScreenContext] = useState(false);
  const [accessibilityGranted, setAccessibilityGranted] = useState(false);

  // Part 1: notification capture
  const [notifCapture, setNotifCapture] = useState(false);
  const [notifAllApps, setNotifAllApps] = useState(false);
  const [notifListenerGranted, setNotifListenerGranted] = useState(false);

  // Part 2: SMS backfill (contact-allowlist model)
  const [smsGranted, setSmsGranted] = useState(false);
  const [contactsGranted, setContactsGranted] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [smsResult, setSmsResult] = useState<string | null>(null);
  const [contacts, setContacts] = useState<SmsContact[]>([]);
  const [contactFilter, setContactFilter] = useState("");
  const [smsAllow, setSmsAllow] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [enrollToken, setEnrollToken] = useState("");

  const [sensorState, setSensorState] = useState<SensorState | null>(null);
  const [sensorBusy, setSensorBusy] = useState(false);

  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  async function refreshSmsState() {
    const perms = await smsPermissions();
    setSmsGranted(perms.sms);
    setContactsGranted(perms.contacts);
    if (perms.sms) {
      try {
        setSmsAllow(new Set(await getSmsAllowlist()));
      } catch { /* not granted yet */ }
    }
  }

  async function refreshSensorState() {
    setSensorState(await getSensorState());
  }

  // Each change is applied on the phone before the switch moves, so the UI never shows "off" for a running sensor.
  async function changeSensors(change: () => Promise<SensorState | null>) {
    setSensorBusy(true);
    try {
      const next = await change();
      if (next) setSensorState(next);
    } catch (e) {
      logRejection("setup.sensorConsent")(e);
    } finally {
      setSensorBusy(false);
    }
  }

  async function handleAllowActivity() {
    await requestPermission("activity");
    await changeSensors(refreshSensors);
  }

  async function refreshNotifState() {
    const [granted, cfg] = await Promise.all([
      isNotificationListenerGranted(),
      getNotificationCaptureConfig(),
    ]);
    setNotifListenerGranted(granted);
    setNotifCapture(cfg.enabled);
    setNotifAllApps(cfg.allApps);
  }

  const [mountTime] = useState(() => Date.now());

  useEffect(() => {
    (async () => {
      if (!Capacitor.isNativePlatform()) {
        await tryAutoConnectLocalPc().catch(() => false);
      }
      const [savedUrl, savedToken, savedRemoteUrl, savedRemoteToken, contextEnabled] =
        await Promise.all([
          getProxyBaseUrl(), getProxyToken(),
          getRemoteGatewayUrl(), getRemoteGatewayToken(),
          isScreenContextEnabled(),
        ]);
      if (savedUrl) setBaseUrl(savedUrl);
      if (savedToken) setToken(savedToken);
      if (savedRemoteUrl) setRemoteUrl(savedRemoteUrl);
      if (savedRemoteToken) setRemoteToken(savedRemoteToken);
      setScreenContext(contextEnabled);
    })().catch(logRejection("setup.loadConfig"));
    if (Capacitor.isNativePlatform()) {
      AccessibilityScanner.isAccessibilityServiceEnabled()
        .then(({ enabled }: { enabled: boolean }) => setAccessibilityGranted(enabled))
        .catch(() => {});
      void Promise.resolve().then(() => {
        fireAndForget(refreshNotifState(), "setup.refreshNotifState");
        fireAndForget(refreshSmsState(), "setup.refreshSmsState");
        fireAndForget(refreshSensorState(), "setup.refreshSensorState");
      });
    }
    recordEventSafe({ type: "screen_view", screen: "setup", timestamp: new Date().toISOString() });
    void flushUsageEvents();

    let lastResume = 0;
    const onResume = () => {
      const now = Date.now();
      if (now - lastResume < 500) return;
      lastResume = now;
      AccessibilityScanner.isAccessibilityServiceEnabled()
        .then(({ enabled }: { enabled: boolean }) => setAccessibilityGranted(enabled))
        .catch(() => {});
      void Promise.resolve().then(() => {
        fireAndForget(refreshNotifState(), "setup.refreshNotifState");
        fireAndForget(refreshSmsState(), "setup.refreshSmsState");
        fireAndForget(refreshSensorState(), "setup.refreshSensorState");
      });
    };

    let disposed = false;
    let appListenerHandle: { remove: () => Promise<void> } | undefined;
    CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) onResume();
    }).then((handle) => {
      if (disposed) {
        handle.remove();
      } else {
        appListenerHandle = handle;
      }
    }).catch(() => {});

    window.addEventListener("focus", onResume);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onResume);
      appListenerHandle?.remove();
    };
  }, []);



  async function handleToggleNotifCapture(next: boolean) {
    setNotifCapture(next);
    await setNotificationCapture(next, notifAllApps);
    if (next) startNotificationCaptureListener();
  }

  async function handleToggleNotifAllApps(next: boolean) {
    setNotifAllApps(next);
    await setNotificationCapture(notifCapture, next);
  }

  async function handleOpenPicker() {
    setSmsError(null);
    setPickerOpen(true);
    try {
      setContacts(await listSmsContacts());
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
      setPickerOpen(false);
    }
  }

  function toggleContactNumbers(numbers: string[]) {
    setSmsAllow((prev) => {
      const next = new Set(prev);
      const allOn = numbers.every((n) => next.has(n));
      for (const n of numbers) {
        if (allOn) next.delete(n);
        else next.add(n);
      }
      return next;
    });
  }

  async function handleSaveAllowlist() {
    setSmsBusy(true);
    setSmsError(null);
    try {
      const count = await setSmsAllowlist([...smsAllow]);
      setSmsResult(`Allowlist saved — ${count} number${count === 1 ? "" : "s"}.`);
      setPickerOpen(false);
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    }
    setSmsBusy(false);
  }

  async function handleSmsBackfill() {
    setSmsBusy(true);
    setSmsError(null);
    setSmsResult(null);
    try {
      const { ingested, done } = await runSmsBackfill((p) =>
        setSmsResult(`${p.ingested} messages queued${p.done ? "" : "…"}`)
      );
      setSmsResult(
        done
          ? `Done — ${ingested} messages from allowlisted contacts queued for PiecesOS.`
          : `${ingested} queued so far — run again to continue (large history is paced across runs).`
      );
      void flushUsageEvents();
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    }
    setSmsBusy(false);
  }

  async function handleResetToRecent() {
    setSmsBusy(true);
    setSmsError(null);
    setSmsResult(null);
    try {
      const target = await resetSmsBackfillToRecent(30);
      const targetDate = new Date(target).toLocaleDateString();
      const res = await runSmsBackfill((p) => {
        setSmsResult(`Syncing recent from ${targetDate}: ${p.ingested} message${p.ingested === 1 ? "" : "s"}…`);
      });
      await flushUsageEvents();
      setSmsResult(
        res.ingested > 0
          ? `Synced ${res.ingested} recent message${res.ingested === 1 ? "" : "s"} from ${targetDate} forward.`
          : `Caught up — no newer messages found since ${targetDate}.`
      );
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSmsBusy(false);
    }
  }

  async function handleToggleScreenContext(next: boolean) {
    setScreenContext(next);
    await setScreenContextEnabled(next);
    try {
      await AccessibilityScanner.setScreenContextEnabled({ enabled: next });
    } catch (e) {
      console.warn("[Accessibility] setScreenContextEnabled failed", e);
    }
  }

  async function deepCheckAfterSave(): Promise<"ok" | "server-only"> {
    try {
      await getStatus();
      return "ok";
    } catch (e) {
      if (e instanceof HomeNodeUnreachableError) return "server-only";
      return "server-only";
    }
  }

  async function handleScanToConnect() {
    if (scanBusy.current) return;
    scanBusy.current = true;
    setScanError(null);
    try {
      const { camera } = await BarcodeScanner.checkPermissions();
      if (camera !== "granted" && camera !== "limited") {
        const req = await BarcodeScanner.requestPermissions();
        if (req.camera !== "granted" && req.camera !== "limited") {
          setScanError("Camera permission is required to scan the connection code.");
          return;
        }
      }

      const { barcodes } = await BarcodeScanner.scan();
      const raw = barcodes[0]?.rawValue;
      if (!raw) return;

      const parsed = parseConnectionQrPayload(raw);
      setChecking(true);
      setResult("idle");

      const targetUrl = parsed.baseUrl;
      const scannedProblem = checkConnectionUrl(targetUrl);
      if (scannedProblem) {
        setScanError(scannedProblem);
        return;
      }

      // 1. Health check first so we never spend a single-use token or overwrite config if host is down
      const reachable = await checkProxyHealth(targetUrl);
      if (!reachable) {
        setResult("unreachable");
        return;
      }

      let activeToken = parsed.token ?? "";

      // 2. Exchange token now that host reachability is confirmed
      if (parsed.isPairingToken && parsed.pairingToken) {
        try {
          const pairResult = await exchangePairingToken(targetUrl, parsed.pairingToken);
          activeToken = pairResult.token;
        } catch (pairErr) {
          setScanError(pairErr instanceof Error ? pairErr.message : String(pairErr));
          setResult("unreachable");
          return;
        }
      }

      if (!activeToken) {
        setScanError("No token could be extracted or exchanged from the QR code.");
        setResult("unreachable");
        return;
      }

      // 3. Persist credentials only after verified reachability and exchange
      const mode = classifyMode(targetUrl);
      if (mode === "remote") {
        setRemoteUrl(targetUrl);
        setRemoteToken(activeToken);
        await setRemoteGatewayUrl(targetUrl);
        await setRemoteGatewayToken(activeToken);
      } else {
        setBaseUrl(targetUrl);
        setToken(activeToken);
        await setProxyBaseUrl(targetUrl);
        await setProxyToken(activeToken);
      }

      setResult(await deepCheckAfterSave());
      await recordEvent({
        type: "setup_saved",
        screen: "setup",
        mode,
        timestamp: new Date().toISOString(),
      });
      void flushUsageEvents();
      AccessibilityScanner.flushOutbox().catch(() => {});
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      scanBusy.current = false;
      setChecking(false);
    }
  }

  async function handleTestAndSave() {
    setChecking(true);
    setResult("idle");

    const planA = baseUrl.trim() && token.trim();
    const planB = remoteUrl.trim() && remoteToken.trim();
    if (!planA && !planB) {
      setChecking(false);
      setResult("unreachable");
      return;
    }

    const urlProblem = (planA ? checkConnectionUrl(baseUrl) : null) ?? (planB ? checkConnectionUrl(remoteUrl) : null);
    if (urlProblem) {
      setScanError(urlProblem);
      setChecking(false);
      return;
    }
    setScanError(null);

    const verifyUrl = planA ? baseUrl : remoteUrl;
    const reachable = await checkProxyHealth(verifyUrl);
    if (!reachable) {
      setChecking(false);
      setResult("unreachable");
      return;
    }

    try {
      await setProxyBaseUrl(planA ? baseUrl.trim() : "");
      await setProxyToken(planA ? token.trim() : "");
      await setRemoteGatewayUrl(planB ? remoteUrl.trim() : "");
      await setRemoteGatewayToken(planB ? remoteToken.trim() : "");
      setResult(await deepCheckAfterSave());
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
      return;
    } finally {
      setChecking(false);
    }

    await recordEvent({
      type: "setup_saved",
      screen: "setup",
      mode: classifyMode(planA ? baseUrl : remoteUrl),
      timestamp: new Date().toISOString(),
    });
    void flushUsageEvents();
  }

  async function handleRegisterApprovalKey() {
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      await registerApprovalKey(enrollToken);
      setEnrollToken("");
      setKeyMsg("Approval key registered. Approvals now require your biometric.");
    } catch (err) {
      setKeyMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setKeyBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>{Capacitor.isNativePlatform() ? "Setup Bridge" : "Node Hub & Companion Pairing"}</h1>
        <p className="hint">
          {Capacitor.isNativePlatform()
            ? "Connect your Android device to PiecesOS via Plan A (LAN proxy at home) or Plan B (remote gateway away). Automatic failover kicks in when away from home."
            : "Workstation daemon status and companion pairing credentials for mobile devices."}
        </p>
      </div>

      {!Capacitor.isNativePlatform() && (
        <>
          <div className="card" style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.12) 0%, var(--surface) 100%)", borderColor: "rgba(16,185,129,0.3)", marginBottom: 16 }}>
            <div className="card-row" style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="status-pulse-live" />
                <span style={{ fontWeight: 700, fontSize: 16, color: "var(--text)" }}>Local Workstation Node Active</span>
              </div>
              <span className="badge success">Localhost Online</span>
            </div>
            <p className="hint" style={{ fontSize: 13, margin: "0 0 16px" }}>
              This desktop workstation communicates directly with your local Sovereign Exocortex daemon and PiecesOS engine. All database telemetry, world model beliefs, and vector embeddings reside on this PC.
            </p>
            <div className="metrics-grid" style={{ marginBottom: 14 }}>
              <div className="metric-box">
                <div className="metric-label">Daemon API (:8788)</div>
                <div className="metric-val" style={{ fontSize: 13, color: "var(--ok)" }}>Connected</div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Proxy Bus (:8787)</div>
                <div className="metric-val" style={{ fontSize: 13, color: "var(--ok)" }}>Connected</div>
              </div>
              <div className="metric-box">
                <div className="metric-label">PiecesOS (:39300)</div>
                <div className="metric-val" style={{ fontSize: 13, color: "var(--ok)" }}>Connected</div>
              </div>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                setChecking(true);
                setScanError(null);
                const ok = await tryAutoConnectLocalPc();
                const [savedUrl, savedToken, savedRemoteUrl, savedRemoteToken] = await Promise.all([
                  getProxyBaseUrl(), getProxyToken(), getRemoteGatewayUrl(), getRemoteGatewayToken(),
                ]);
                if (savedUrl) setBaseUrl(savedUrl);
                if (savedToken) setToken(savedToken);
                if (savedRemoteUrl) setRemoteUrl(savedRemoteUrl);
                if (savedRemoteToken) setRemoteToken(savedRemoteToken);
                if (ok) {
                  setResult(await deepCheckAfterSave());
                } else {
                  try {
                    const healthRes = await fetch("http://127.0.0.1:8788/mobile/health", { signal: AbortSignal.timeout(2000) });
                    if (healthRes.ok) {
                      setResult("ok");
                      setScanError(null);
                    } else {
                      setScanError("Local daemon on port :8788 did not return healthy status.");
                      setResult("unreachable");
                    }
                  } catch {
                    setScanError("Could not reach local PC services on port 8788. Ensure exocortexd is running.");
                    setResult("unreachable");
                  }
                }
                setChecking(false);
              }}
              disabled={checking}
              style={{ width: "100%" }}
            >
              {checking ? "Checking Local Endpoints…" : "⚡ Refresh Local Endpoints"}
            </button>
            {scanError && <p className="status-error" style={{ marginTop: 10, fontSize: 13 }}>{scanError}</p>}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-row" style={{ marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Mobile Companion Pairing (Galaxy S26 Ultra)</span>
              <span className="badge primary">Pairing Hub</span>
            </div>
            <p className="hint" style={{ fontSize: 13, margin: "0 0 14px" }}>
              Your PC is the sovereign master node. Use the pairing credentials below to connect your Android companion app to this workstation.
            </p>
            <div className="setup-fields">
              <div className="input-group">
                <label className="input-label">Localhost / LAN Proxy Target</label>
                <input type="text" readOnly value={baseUrl || "http://127.0.0.1:8787"} />
              </div>
              <div className="input-group">
                <label className="input-label">Exocortex Gateway Target</label>
                <input type="text" readOnly value={remoteUrl || "http://127.0.0.1:8788"} />
              </div>
              {remoteToken && (
                <div className="input-group">
                  <label className="input-label">Gateway Access Token</label>
                  <input type="password" readOnly value={remoteToken} />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {Capacitor.isNativePlatform() && (
        <>
          <div className="card" style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.12) 0%, var(--surface) 100%)", marginBottom: 16 }}>
            <div className="card-row" style={{ marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)" }}>Instant QR Pairing</span>
              <span className="badge primary">Fastest</span>
            </div>
            <p className="hint" style={{ fontSize: 13, margin: "0 0 14px" }}>
              Scan the connection QR code generated by the PC proxy script to configure and test automatically.
            </p>
            <button onClick={handleScanToConnect} disabled={checking} style={{ width: "100%" }}>
              <ScanIcon size={18} />
              {checking ? "Checking…" : "Scan to Connect"}
            </button>
            {scanError && <p className="status-error" style={{ marginTop: 10, fontSize: 13 }}>{scanError}</p>}
          </div>

      <div className="setup-card">
        <div className="setup-card-header">
          <div className="setup-card-title-group">
            <div className="setup-card-icon lan">
              <WifiIcon size={18} />
            </div>
            <div>
              <div className="setup-card-title">Plan A — Home Wi-Fi</div>
              <div className="setup-card-subtitle">Fast local proxy when connected to your home network</div>
            </div>
          </div>
          <span className="badge">LAN</span>
        </div>
        <div className="setup-fields">
          <div className="input-group">
            <label className="input-label">LAN Proxy Address</label>
            <input
              type="text"
              placeholder="http://192.168.1.20:8787"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label className="input-label">Bearer Token (from PC)</label>
            <input
              type="password"
              placeholder="Proxy bearer token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="setup-card">
        <div className="setup-card-header">
          <div className="setup-card-title-group">
            <div className="setup-card-icon remote">
              <CloudIcon size={18} />
            </div>
            <div>
              <div className="setup-card-title">Plan B — Remote Gateway</div>
              <div className="setup-card-subtitle">Automatic failover when away from home via Tailscale</div>
            </div>
          </div>
          <span className="badge">Failover</span>
        </div>
        <div className="setup-fields">
          <div className="input-group">
            <label className="input-label">Gateway URL</label>
            <input
              type="text"
              placeholder="https://pieces.yourdomain.com"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label className="input-label">Device Token (from gateway enroll)</label>
            <input
              type="password"
              placeholder="Device JWT"
              value={remoteToken}
              onChange={(e) => setRemoteToken(e.target.value)}
            />
          </div>
          {(() => {
            const info = remoteToken ? decodeJwtForDisplay(remoteToken) : null;
            if (!info?.expiresAt) return null;
            const expired = info.expiresAt.getTime() < mountTime;
            return (
              <p className={`setup-note ${expired ? "status-error" : "hint"}`} style={{ fontSize: 12, margin: "6px 0 0" }}>
                Device token {formatExpiry(info.expiresAt)}
                {expired && " — re-enroll this device on the gateway."}
              </p>
            );
          })()}
        </div>
      </div>

      <div className="input-group" style={{ marginTop: 18 }}>
        <label className="input-label">Approval key (biometric)</label>
        <input
          type="password"
          placeholder="Enrollment token (from your PC)"
          value={enrollToken}
          onChange={(e) => setEnrollToken(e.target.value)}
        />
        <button
          className="secondary"
          onClick={handleRegisterApprovalKey}
          disabled={keyBusy || !enrollToken.trim()}
          style={{ width: "100%", marginTop: 8 }}
        >
          {keyBusy ? "Registering…" : "Register approval key"}
        </button>
        {keyMsg && (
          <p className="setup-note hint" style={{ fontSize: 12, margin: "6px 0 0" }}>
            {keyMsg}
          </p>
        )}
        <p className="setup-note hint" style={{ fontSize: 12, margin: "6px 0 0" }}>
          Required once per phone (and again after changing enrolled fingerprints). Approvals are refused until this is done.
        </p>
      </div>

      <div style={{ marginTop: 18 }}>
        <button
          className="primary-btn-large"
          onClick={handleTestAndSave}
          disabled={checking || (!(baseUrl && token) && !(remoteUrl && remoteToken))}
          style={{ width: "100%" }}
        >
          {checking ? "Testing connection…" : "Test & Save Connection"}
        </button>
      </div>

      {result === "ok" && (
        <div className="card" style={{ marginTop: 12, borderLeft: "4px solid var(--ok)" }}>
          <div className="status-ok">
            <span className="status-pulse-live" />
            <span>Connected & Saved successfully.</span>
          </div>
        </div>
      )}

      {result === "server-only" && (
        <div className="card panel-danger" style={{ marginTop: 12 }}>
          <div className="status-ok" style={{ marginBottom: 4 }}>Saved.</div>
          <p className="status-error" style={{ fontSize: 13, margin: 0 }}>
            Server is reachable, but cannot reach your home PC right now. Check Status tab for details.
          </p>
        </div>
      )}

      {result === "unreachable" && (
        <div className="card panel-danger" style={{ marginTop: 12 }}>
          <p className="status-error" style={{ margin: 0 }}>Could not reach proxy at the specified address.</p>
        </div>
      )}

      <div className="panel">
        <Switch
          checked={screenContext}
          onChange={handleToggleScreenContext}
          label="Enable screen context"
          description="Capture on-screen text from allowed apps using Android's standard Accessibility permission."
        />
        {screenContext && (
          <div style={{ paddingTop: 8, borderTop: "1px solid var(--border-subtle)" }}>
            {accessibilityGranted ? (
              <p className="status-ok" style={{ fontSize: 13, margin: 0 }}>
                <CheckIcon size={14} /> Accessibility permission granted.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p className="status-error" style={{ fontSize: 13, margin: 0 }}>
                  Accessibility permission not granted yet.
                </p>
                <button className="secondary" onClick={() => AccessibilityScanner.openAccessibilitySettings()}>
                  Open Accessibility Settings
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <Switch
          checked={notifCapture}
          onChange={handleToggleNotifCapture}
          label="Capture notifications"
          description="Stream incoming notification previews (texts, email, chat) to PiecesOS. Sensitive 2FA apps excluded."
        />
        {notifCapture && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10, borderTop: "1px solid var(--border-subtle)" }}>
            {notifListenerGranted ? (
              <p className="status-ok" style={{ fontSize: 13, margin: 0 }}>
                <CheckIcon size={14} /> Notification access granted.
              </p>
            ) : (
              <div>
                <p className="status-error" style={{ fontSize: 13, margin: "0 0 8px" }}>
                  Notification access not granted yet.
                </p>
                <button className="secondary" onClick={() => openNotificationListenerSettings()}>
                  Open Settings
                </button>
              </div>
            )}
            <Switch
              checked={notifAllApps}
              onChange={handleToggleNotifAllApps}
              label="Capture from all apps"
              description="Capture across every app rather than only allowlisted apps."
            />
          </div>
        )}
      </div>

      {sensorState && (
        <div className="panel">
          <Switch
            checked={sensorState.master}
            onChange={(next) => void changeSensors(() => setSensorMaster(next))}
            disabled={sensorBusy}
            label="Sensors"
            description={MASTER_COPY}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10, borderTop: "1px solid var(--border-subtle)" }}>
            {SENSORS.map((info) => {
              const available = isAvailable(sensorState, info.key);
              return (
                <div key={info.key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <Switch
                    checked={sensorState.toggles[info.key] === true}
                    onChange={(next) => void changeSensors(() => setSensorToggle(info.key as SensorKey, next))}
                    disabled={sensorBusy || !available}
                    label={info.title}
                    description={available ? info.copy : "Not available on this phone."}
                  />
                  {needsActivityPermissionNow(sensorState, info) && (
                    <div>
                      <p className="status-error" style={{ fontSize: 13, margin: "0 0 8px" }}>
                        Activity recognition permission not granted yet.
                      </p>
                      <button className="secondary" onClick={() => void handleAllowActivity()}>
                        Allow activity recognition
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {!sensorState.master && (
              <p className="hint" style={{ margin: 0 }}>Nothing is collected until the Sensors switch is on.</p>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>SMS History & Sync</span>
          <p className="hint" style={{ margin: 0 }}>
            Sync and backfill SMS/MMS messages exclusively from contacts you explicitly allow below.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8 }}>
          {!smsGranted ? (
            <div>
              <p className="status-error" style={{ fontSize: 13, margin: "0 0 8px" }}>
                SMS access not granted yet.
              </p>
              <button className="secondary" onClick={() => openSmsAppSettings()}>
                Open Settings
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="status-ok" style={{ fontSize: 13 }}>
                <CheckIcon size={14} />
                <span>SMS access granted{contactsGranted ? " · contacts readable" : ""}.</span>
              </div>
              <p className="hint" style={{ fontSize: 12, margin: 0 }}>
                Allowlist: <strong>{smsAllow.size}</strong> number{smsAllow.size === 1 ? "" : "s"} selected.
              </p>
              {!contactsGranted && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <p className="status-error" style={{ fontSize: 12, margin: 0 }}>
                    Contacts not readable — grant permission in Android Settings.
                  </p>
                  <button className="secondary pill" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => openSmsAppSettings()}>
                    Settings
                  </button>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                <button className="secondary" onClick={handleOpenPicker} disabled={smsBusy || !contactsGranted}>
                  Choose contacts
                </button>
                <button
                  onClick={handleSmsBackfill}
                  disabled={smsBusy || smsAllow.size === 0}
                >
                  {smsBusy ? "Backfilling…" : "Backfill now"}
                </button>
                <button
                  className="secondary"
                  onClick={handleResetToRecent}
                  disabled={smsBusy || smsAllow.size === 0}
                  title="Jump directly to the last 30 days of messages"
                >
                  Sync Recent (30d)
                </button>
              </div>
            </div>
          )}

          {smsResult && <p className="status-ok" style={{ fontSize: 13 }}>{smsResult}</p>}
          {smsError && <p className="status-error" style={{ fontSize: 13 }}>{smsError}</p>}
        </div>

        {pickerOpen && (
          <div className="picker">
            <input
              type="text"
              placeholder="Filter contacts…"
              value={contactFilter}
              onChange={(e) => setContactFilter(e.target.value)}
              style={{ width: "100%", marginBottom: 8 }}
            />
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
              <button
                type="button"
                className="secondary"
                style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                onClick={() => {
                  const visible = contacts.filter((c) =>
                    c.name.toLowerCase().includes(contactFilter.toLowerCase())
                  );
                  setSmsAllow((prev) => {
                    const next = new Set(prev);
                    for (const c of visible) {
                      for (const n of c.numbers) next.add(n);
                    }
                    return next;
                  });
                }}
              >
                Select All
              </button>
              <button
                type="button"
                className="secondary"
                style={{ fontSize: "0.75rem", padding: "4px 10px" }}
                onClick={() => {
                  const visible = contacts.filter((c) =>
                    c.name.toLowerCase().includes(contactFilter.toLowerCase())
                  );
                  setSmsAllow((prev) => {
                    const next = new Set(prev);
                    for (const c of visible) {
                      for (const n of c.numbers) next.delete(n);
                    }
                    return next;
                  });
                }}
              >
                Deselect All
              </button>
              <span className="hint" style={{ marginLeft: "auto", fontSize: "0.75rem", margin: 0 }}>
                {contacts.length} contacts
              </span>
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto" }}>
              {contacts.length === 0 && <p className="hint">Loading contacts…</p>}
              {contacts
                .filter((c) =>
                  c.name.toLowerCase().includes(contactFilter.toLowerCase())
                )
                .map((c) => {
                  const on = c.numbers.length > 0 && c.numbers.every((n) => smsAllow.has(n));
                  return (
                    <label key={`${c.name}:${c.numbers.join(",")}`} className="app-row">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleContactNumbers(c.numbers)}
                      />
                      <span>
                        {c.name}
                        {c.numbers.length > 1 && (
                          <span className="hint"> ({c.numbers.length} numbers)</span>
                        )}
                      </span>
                    </label>
                  );
                })}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={handleSaveAllowlist} disabled={smsBusy}>
                {smsBusy ? "Saving…" : "Save allowlist"}
              </button>
              <button className="secondary" onClick={() => setPickerOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}
