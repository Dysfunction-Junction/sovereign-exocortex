import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { getStatus, getCachedStatus, getPendingShadowProposals, ProxyNotConfiguredError, HomeNodeUnreachableError, getServices, type ServiceInfo } from "../lib/api";
import { ServiceRow } from "../components/ServiceRow";
import { recordEvent } from "../lib/usage";
import { fireAndForget, logRejection, recordEventSafe } from "../lib/fireAndForget";
import { flushUsageEvents } from "../lib/flush";
import { isScreenContextEnabled, tryAutoConnectLocalPc } from "../lib/config";
import { onPassiveCapture, getLastPassiveCapture, startPassiveCaptureListener } from "../lib/passiveCapture";
import { withPlayCategoryFallback } from "../lib/playCategories";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Switch } from "../components/Switch";
import { PermissionsPanel } from "../components/PermissionsPanel";
import { RefreshIcon, ReviewIcon } from "../components/Icons";
import { AnticipationRing } from "../components/AnticipationRing";
import { AmbientGraphHud } from "../components/AmbientGraphHud";
import { IntegrationsHub } from "../components/IntegrationsHub";

const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');

type State =
  | { kind: "loading" }
  | { kind: "ok"; health: string; version: string }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string; stale?: { health: string; version: string; at: string } }
  | { kind: "error"; message: string };

type AppEntry = { packageName: string; label: string; isSystemApp: boolean; hasLauncherIcon: boolean; category: string };

const PASSIVE_MODE_CONFIRM_PHRASE = "I understand";

export default function Status() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [contextEnabled, setContextEnabled] = useState(false);
  const [accessibilityGranted, setAccessibilityGranted] = useState(true);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [daemonUnreachable, setDaemonUnreachable] = useState(false);
  const [isDaemonRestarting, setIsDaemonRestarting] = useState(false);

  const fetchServices = async () => {
    if (Capacitor.isNativePlatform()) return;
    try {
      const data = await getServices();
      setServices(data);
      setDaemonUnreachable(false);
      setServicesLoading(false);
    } catch {
      if (!isDaemonRestarting) {
        setDaemonUnreachable(true);
      }
      setServicesLoading(false);
    }
  };

  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;

    fetchServices();

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchServices();
      }
    }, 10_000);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchServices();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isDaemonRestarting]);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [allowlist, setAllowlistState] = useState<Set<string>>(new Set());
  // Picker working copy. Nothing reaches the native allowlist until the user taps "Save";
  // "Cancel" discards it (including the first-run recent-apps suggestion).
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [recentPackages, setRecentPackages] = useState<Set<string>>(new Set());
  const [usageAccessGranted, setUsageAccessGranted] = useState(false);
  const [showSystemApps, setShowSystemApps] = useState(false);
  // Hidden by default: an app with no launcher icon (getLaunchIntentForPackage
  // returns null natively) can never be brought to the foreground, so it can
  // never have on-screen text worth capturing - filtering it out of the
  // picker's main list reduces noise for the common case. Not a hard
  // exclusion like EXCLUDED_PREFIXES/EXCLUDED_NOISE_PREFIXES (Java-side,
  // enforced even against a manually-edited allowlist) - this is just a
  // default view filter the user can lift with the toggle below, since a
  // background-only package is unusual but not impossible to want.
  const [showBackgroundApps, setShowBackgroundApps] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  // Total foreground ms per package over the same window as recentPackages
  // (see getRecentlyUsedPackages) — only populated when Usage Access is
  // granted, same gate as recentPackages itself. Empty otherwise, which the
  // "Active time" sort mode below falls back gracefully from (0 for every
  // app just means that sort ties everything and falls through to name).
  const [usageMs, setUsageMs] = useState<Record<string, number>>({});
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerCategoryFilter, setPickerCategoryFilter] = useState<string>("all");
  type SortMode = "name" | "recent" | "active-time" | "category";
  const [sortMode, setSortMode] = useState<SortMode>("category");
  const [passiveMode, setPassiveMode] = useState(false);
  const [passiveConfirmText, setPassiveConfirmText] = useState("");
  const [showPassiveConfirm, setShowPassiveConfirm] = useState(false);
  const [lastPassiveCapture, setLastPassiveCapture] = useState<{ pkg: string; at: string } | null>(getLastPassiveCapture());
  const [shadowPendingCount, setShadowPendingCount] = useState<number | null>(null);

  async function load() {
    setState({ kind: "loading" });
    if (Capacitor.isNativePlatform()) {
      AccessibilityScanner.isAccessibilityServiceEnabled()
        .then(({ enabled }: { enabled: boolean }) => setAccessibilityGranted(enabled))
        .catch(() => {});
    }
    try {
      const { health, version } = await getStatus();
      setState({ kind: "ok", health, version });
      getPendingShadowProposals()
        .then((props) => setShadowPendingCount(props.length))
        .catch(() => setShadowPendingCount(null));
    } catch (err) {
      if (err instanceof ProxyNotConfiguredError) {
        setState({ kind: "not-configured" });
      } else if (err instanceof HomeNodeUnreachableError) {
        const cached = await getCachedStatus();
        setState({
          kind: "home-offline",
          message: err.message,
          stale: cached ? { ...cached.value, at: cached.at } : undefined,
        });
      } else {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  useEffect(() => {
    function refreshA11y() {
      if (Capacitor.isNativePlatform()) {
        AccessibilityScanner.isAccessibilityServiceEnabled()
          .then(({ enabled }: { enabled: boolean }) => setAccessibilityGranted(enabled))
          .catch(() => {});
      }
    }

    queueMicrotask(() => {
      fireAndForget(load(), "status.load");
    });
    isScreenContextEnabled().then(setContextEnabled).catch(logRejection("status.screenContext")); // default false = fail-closed
    refreshA11y();
    AccessibilityScanner.getPassiveModeEnabled()
      .then((r: any) => setPassiveMode(r.enabled))
      .catch(() => {});
    // Load the saved allowlist on mount to avoid stale empty default
    AccessibilityScanner.getAllowlist()
      .then(({ packages }: { packages: string[] }) => setAllowlistState(new Set(packages)))
      .catch(() => {});
    recordEventSafe({ type: "screen_view", screen: "status", timestamp: new Date().toISOString() });
    void flushUsageEvents();

    // In web/desktop mode, re-poll on tab visibility; in native Capacitor, appStateChange handles resume
    const handleVisibility = () => {
      if (!Capacitor.isNativePlatform() && typeof document !== "undefined" && document.visibilityState === "visible") {
        refreshA11y();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // On native Android, re-poll a11y service state when user returns from Accessibility Settings
    const appStatePromise = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) refreshA11y();
    });

    // App-wide passive capture listener subscription for the status view
    const unsubscribePassive = onPassiveCapture((capture) => setLastPassiveCapture(capture));

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      appStatePromise.then((handle) => handle.remove()).catch(() => {});
      unsubscribePassive();
    };
  }, []);

  async function handleTogglePassiveMode(next: boolean) {
    if (!next) {
      setPassiveMode(false);
      setShowPassiveConfirm(false);
      setPassiveConfirmText("");
      await AccessibilityScanner.setPassiveModeEnabled({ enabled: false });
      return;
    }
    setShowPassiveConfirm(true);
  }

  async function confirmPassiveMode() {
    if (passiveConfirmText.trim() !== PASSIVE_MODE_CONFIRM_PHRASE) return;
    setPassiveMode(true);
    setShowPassiveConfirm(false);
    setPassiveConfirmText("");
    // Covers turning passive mode on mid-session, when App.tsx's startup
    // check already ran and found it off — startPassiveCaptureListener is a
    // no-op if App.tsx already started it.
    startPassiveCaptureListener();
    await AccessibilityScanner.setPassiveModeEnabled({ enabled: true });
  }

  async function openPicker() {
    try {
      const [{ apps }, { packages }, { granted }] = await Promise.all([
        AccessibilityScanner.listInstalledApps(),
        AccessibilityScanner.getAllowlist(),
        AccessibilityScanner.isUsageAccessGranted(),
      ]);
      // Fills in a real category (from the offline Play Store scrape seed)
      // only where the OS-reported category is "Uncategorized" — never
      // overrides a category Android itself declared.
      setApps(apps.map(withPlayCategoryFallback));
      setUsageAccessGranted(granted);

      // Suggestion, not an override — recent packages are pre-checked only if
      // the saved allowlist is empty (first-run convenience). An existing
      // allowlist reflects a deliberate prior choice and is never silently
      // expanded by this.
      if (granted) {
        const { packages: recent, usageMs: usage } = await AccessibilityScanner.getRecentlyUsedPackages({ days: 7 });
        setRecentPackages(new Set(recent));
        setUsageMs(usage ?? {});
        setAllowlistState(new Set(packages));
        if (packages.length === 0 && recent.length > 0) {
          // Pre-check only in the picker's draft; persisted solely on Save.
          const installedNames = new Set(apps.map((a: AppEntry) => a.packageName));
          setDraft(new Set(recent.filter((p: string) => installedNames.has(p))));
        } else {
          setDraft(new Set(packages));
        }
      } else {
        setAllowlistState(new Set(packages));
        setDraft(new Set(packages));
      }

      setShowPicker(true);
    } catch (e: any) {
      alert("Could not load app list: " + (e.message || String(e)));
    }
  }

  function toggleCategoryCollapsed(category: string) {
    const next = new Set(collapsedCategories);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    setCollapsedCategories(next);
  }

  function toggleApp(packageName: string) {
    const next = new Set(draft);
    if (next.has(packageName)) next.delete(packageName);
    else next.add(packageName);
    setDraft(next);
  }

  // A real toggle, not just "add all" - if every app in the group is
  // already selected, this deselects the whole group instead of being a
  // no-op, so the header checkbox's own checked state stays meaningful
  // (checked = "all of these are in the allowlist").
  function toggleGroup(groupApps: AppEntry[]) {
    const next = new Set(draft);
    const allSelected = groupApps.every(a => next.has(a.packageName));
    for (const a of groupApps) {
      if (allSelected) next.delete(a.packageName);
      else next.add(a.packageName);
    }
    setDraft(next);
  }

  async function saveAllowlist() {
    const next = new Set(draft);
    await AccessibilityScanner.setAllowlist({ packages: Array.from(next) });
    setAllowlistState(next);
    setShowPicker(false);

    if (next.size === 0 && passiveMode) {
      setPassiveMode(false);
      await AccessibilityScanner.setPassiveModeEnabled({ enabled: false });
    }
  }

  function cancelPicker() {
    setDraft(new Set(allowlist));
    setShowPicker(false);
  }

  function selectAllApps() {
    // apps is already pre-filtered by the Java side (banking/password-manager
    // packages excluded from the list entirely, both by package prefix AND by
    // app-label keyword as of 2026-08-30 — see AccessibilityPlugin.isExcluded),
    // so "all" here still respects that boundary — it's a bulk-edit convenience,
    // not a wider grant. setAllowlist also re-checks label-based exclusion
    // server-side as defense in depth, so this stays safe even if this list
    // were ever stale.
    // Deliberately NOT scoped to the "hide background-only apps" view filter
    // below (showBackgroundApps) — that filter only controls what's shown,
    // Select All still means every capturable app, matching its existing
    // pre-filter behavior rather than silently changing meaning based on a
    // view toggle's current state.
    setDraft(new Set(apps.map(a => a.packageName)));
  }

  function deselectAllApps() {
    setDraft(new Set());
  }

  async function scanScreenText() {
    try {
      const res = await AccessibilityScanner.getActiveScreenText();
      if (res.status === "success") {
        if (!Capacitor.isNativePlatform()) {
          await recordEvent({
            type: "system_telemetry",
            screen: "background",
            telemetry: `Package: ${res.package}\n\n${res.textNodes}`,
            package: res.package,
            app_label: res.appLabel,
            timestamp: new Date().toISOString(),
            triaged: false,
          });
          await flushUsageEvents();
        } else {
          // On native platform, PiecesAccessibilityService already queued the capture
          // to NativeTelemetrySync. Force an immediate native outbox sync.
          await AccessibilityScanner.flushOutbox();
        }
        alert(`Captured & synced ${res.textNodes.length} characters from ${res.package}.`);
      } else {
        alert(res.status);
      }
    } catch (e: any) {
      alert("Accessibility error: " + (e.message || String(e)));
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-top">
          <h1>System Status</h1>
          <button className="secondary pill" onClick={load} title="Refresh connection">
            <RefreshIcon size={14} /> Refresh
          </button>
        </div>
        <p className="hint">
          {Capacitor.isNativePlatform()
            ? "Live bridge health and diagnostics between Android and your PC's PiecesOS."
            : "Live node health, world model state, and local engine diagnostics on this workstation."}
        </p>
      </div>

      {state.kind === "loading" && (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>Checking PiecesOS connection…</p>
        </div>
      )}

      {state.kind === "not-configured" && (
        <div className="card">
          <p className="status-error" style={{ marginBottom: 12 }}>Not set up yet.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={async () => {
                setState({ kind: "loading" });
                const connected = await tryAutoConnectLocalPc().catch(() => false);
                if (connected) {
                  await load();
                } else {
                  navigate("/setup");
                }
              }}
            >
              ⚡ Auto-Connect to Local PC
            </button>
            <button className="secondary" onClick={() => navigate("/setup")}>Manual Setup</button>
          </div>
        </div>
      )}

      {state.kind === "home-offline" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 8 }}>Home PC is offline or unreachable. {state.message}</p>
          <button onClick={load} style={{ alignSelf: "flex-start", marginBottom: 8 }}>Retry</button>

          {state.stale && (
            <p className="hint setup-note" style={{ margin: 0 }}>
              Last known: PiecesOS {state.stale.version}, as of {new Date(state.stale.at).toLocaleString()}.
            </p>
          )}
        </div>
      )}

      {state.kind === "error" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 12 }}>{state.message}</p>
          <button onClick={load} style={{ alignSelf: "flex-start" }}>Retry</button>
        </div>
      )}

      {state.kind === "ok" && (
        <>
          <div className="status-hero-card">
            <div className="card-row">
              <div className="status-ok">
                <span className="status-pulse-live" />
                <span style={{ fontSize: 16, fontWeight: 700 }}>PiecesOS Connected</span>
              </div>
              <span className="badge success">Active</span>
            </div>
            <div className="metrics-grid">
              <div className="metric-box">
                <div className="metric-label">Health</div>
                <div className="metric-val">{state.health}</div>
              </div>
              <div className="metric-box">
                <div className="metric-label">Version</div>
                <div className="metric-val">{state.version}</div>
              </div>
              <div className="metric-box">
                <div className="metric-label">{Capacitor.isNativePlatform() ? "Allowlist" : "Workstation"}</div>
                <div className="metric-val">{Capacitor.isNativePlatform() ? `${allowlist.size} apps` : "Windows Host"}</div>
              </div>
            </div>
          </div>

          {/* Daily Shadow Review Banner */}
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-row" style={{ alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ReviewIcon size={22} className="accent-text" />
                <div>
                  <h3 style={{ margin: 0, fontSize: 15 }}>Daily Shadow Review</h3>
                  <p className="hint" style={{ margin: "2px 0 0", fontSize: 13 }}>
                    {shadowPendingCount === null
                      ? "Calibrate shadow proposals with one-tap answers."
                      : shadowPendingCount === 0
                        ? "All caught up! No shadow proposals awaiting review."
                        : `${shadowPendingCount} proposal${shadowPendingCount === 1 ? "" : "s"} waiting for your one-tap review.`}
                  </p>
                </div>
              </div>
              <button
                className={`pill ${(shadowPendingCount ?? 0) > 0 ? "primary" : "secondary"}`}
                onClick={() => navigate("/review")}
                style={{ fontSize: 13, padding: "6px 14px" }}
              >
                {(shadowPendingCount ?? 0) > 0
                  ? `Review (${shadowPendingCount})`
                  : "Open Review"}
              </button>
            </div>
          </div>

          <AnticipationRing />
          <AmbientGraphHud />

          {!Capacitor.isNativePlatform() && (
            <div className="card" style={{ marginTop: 20 }}>
              <div className="card-row" style={{ marginBottom: 12 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16 }}>Windows Workstation Node</h3>
                  <p className="hint" style={{ margin: "2px 0 0", fontSize: 13 }}>
                    Host daemon, vector databanks, and living world model active on this PC.
                  </p>
                </div>
                {daemonUnreachable ? (
                  <span className="badge danger">Daemon unreachable</span>
                ) : servicesLoading || services.length === 0 ? (
                  <span className="badge">Checking</span>
                ) : services.some((s) => s.status === "unhealthy") ? (
                  <span className="badge danger">
                    {services.filter((s) => s.status === "unhealthy").length} unhealthy
                  </span>
                ) : services.every((s) => s.status === "healthy") ? (
                  <span className="badge success">All services healthy</span>
                ) : (
                  <span className="badge">Checking</span>
                )}
              </div>

              <div className="service-rows-container">
                <ServiceRow
                  id="daemon"
                  label="Daemon API"
                  descriptor=":8788"
                  service={services.find((s) => s.id === "daemon")}
                  daemonUnreachable={daemonUnreachable}
                  onRefresh={fetchServices}
                  onDaemonRestarting={setIsDaemonRestarting}
                />
                <ServiceRow
                  id="proxy"
                  label="Proxy Bus"
                  descriptor=":8787"
                  service={services.find((s) => s.id === "proxy")}
                  daemonUnreachable={daemonUnreachable}
                  onRefresh={fetchServices}
                />
                <ServiceRow
                  id="piecesos"
                  label="PiecesOS Engine"
                  descriptor=":39300"
                  service={services.find((s) => s.id === "piecesos")}
                  daemonUnreachable={daemonUnreachable}
                  onRefresh={fetchServices}
                />
                <ServiceRow
                  id="worldmodel"
                  label="World Model Store"
                  descriptor="SQLite (WAL)"
                  service={services.find((s) => s.id === "worldmodel")}
                  daemonUnreachable={daemonUnreachable}
                  onRefresh={fetchServices}
                />
              </div>
            </div>
          )}

          {Capacitor.isNativePlatform() && !contextEnabled && (
            <p className="hint setup-note">
              Screen context is off. Enable it in Setup to capture on-screen text.
            </p>
          )}

          {contextEnabled && (
            <div className="panel" style={{ marginTop: 20 }}>
              <p className="panel-title">Screen Context</p>
              {!accessibilityGranted && (
                <div className="card panel-danger" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                  <p className="status-error" style={{ margin: 0, fontSize: 13 }}>
                    ⚠️ Accessibility permission is inactive or was stopped by Android.
                  </p>
                  <button className="secondary" onClick={() => AccessibilityScanner.openAccessibilitySettings()}>
                    Open Accessibility Settings
                  </button>
                </div>
              )}
              <p className="hint" style={{ margin: 0 }}>
                Screen-text capture only reads from apps you've explicitly allowed below.
              </p>
              <button className="secondary" onClick={openPicker}>
                Choose allowed apps ({allowlist.size} selected)
              </button>
              <button onClick={scanScreenText} disabled={allowlist.size === 0}>
                Scan Screen Text
              </button>

              {showPicker && (() => {
                // A currently-allowlisted app is never hidden by this filter,
                // even if it has no launcher icon - toggling the filter off
                // must not make an existing selection disappear from view.
                const backgroundFiltered = apps.filter(
                  a => showBackgroundApps || a.hasLauncherIcon || draft.has(a.packageName)
                );
                const hiddenBackgroundCount = apps.length - backgroundFiltered.length;

                // Search matches label or package name, case-insensitive.
                // Category filter and search compose - both narrow the same
                // list, neither resets the other.
                const query = pickerSearch.trim().toLowerCase();
                const searched = query
                  ? backgroundFiltered.filter(a =>
                      a.label.toLowerCase().includes(query) || a.packageName.toLowerCase().includes(query))
                  : backgroundFiltered;
                const categoryFiltered = pickerCategoryFilter === "all"
                  ? searched
                  : searched.filter(a => a.category === pickerCategoryFilter);

                const allCategoryNames = Array.from(new Set(apps.map(a => a.category))).sort();

                const userApps = categoryFiltered.filter(a => !a.isSystemApp);
                const systemApps = categoryFiltered.filter(a => a.isSystemApp);
                const recentApps = userApps.filter(a => recentPackages.has(a.packageName));
                const recentNames = new Set(recentApps.map(a => a.packageName));

                const renderAppRow = (app: AppEntry) => (
                  <label key={app.packageName} className="app-row">
                    <input
                      type="checkbox"
                      checked={draft.has(app.packageName)}
                      onChange={() => toggleApp(app.packageName)}
                    />
                    {app.label} <span className="app-row-pkg">({app.packageName})</span>
                    {sortMode === "active-time" && usageMs[app.packageName] > 0 && (
                      <span className="app-row-pkg" style={{ marginLeft: "auto" }}>
                        {/* MIN_FOREGROUND_MS_FOR_RECENT (native) is 60s, so this is never 0m for
                            anything that actually appears in usageMs - but Math.max guards it
                            anyway in case that threshold ever changes without this comment
                            being noticed. */}
                        {Math.max(1, Math.round(usageMs[app.packageName] / 60000))}m
                      </span>
                    )}
                  </label>
                );

                // "category" reuses the existing grouped-by-category layout
                // (with its own Recently Used carve-out and collapsible
                // sections) - the other three modes are a single flat list,
                // since flattening AND grouping-by-category at the same time
                // doesn't make sense as one ordering.
                const byCategory = new Map<string, AppEntry[]>();
                if (sortMode === "category") {
                  for (const app of userApps) {
                    if (recentNames.has(app.packageName)) continue;
                    const list = byCategory.get(app.category) ?? [];
                    list.push(app);
                    byCategory.set(app.category, list);
                  }
                }
                const categoryNames = Array.from(byCategory.keys())
                  .filter(c => c !== "Uncategorized")
                  .sort();
                if (byCategory.has("Uncategorized")) categoryNames.push("Uncategorized");

                const flatSortComparators: Record<Exclude<SortMode, "category">, (a: AppEntry, b: AppEntry) => number> = {
                  name: (a, b) => a.label.localeCompare(b.label),
                  recent: (a, b) => {
                    const aRecent = recentNames.has(a.packageName) ? 1 : 0;
                    const bRecent = recentNames.has(b.packageName) ? 1 : 0;
                    return bRecent - aRecent || a.label.localeCompare(b.label);
                  },
                  "active-time": (a, b) => {
                    const diff = (usageMs[b.packageName] ?? 0) - (usageMs[a.packageName] ?? 0);
                    return diff !== 0 ? diff : a.label.localeCompare(b.label);
                  },
                };
                const flatSortedUserApps = sortMode === "category"
                  ? []
                  : [...userApps].sort(flatSortComparators[sortMode]);

                return (
                  <div className="picker">
                    <input
                      type="search"
                      placeholder="Search apps…"
                      value={pickerSearch}
                      onChange={(e) => setPickerSearch(e.target.value)}
                      style={{ marginBottom: 8 }}
                    />

                    <div className="picker-actions" style={{ flexWrap: "wrap" }}>
                      <select
                        value={pickerCategoryFilter}
                        onChange={(e) => setPickerCategoryFilter(e.target.value)}
                        style={{ padding: "6px 10px", fontSize: 12.5, borderRadius: 8, border: "1.5px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
                      >
                        <option value="all">All categories</option>
                        {allCategoryNames.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select
                        value={sortMode}
                        onChange={(e) => setSortMode(e.target.value as SortMode)}
                        style={{ padding: "6px 10px", fontSize: 12.5, borderRadius: 8, border: "1.5px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
                      >
                        <option value="category">Sort: Category</option>
                        <option value="name">Sort: Name</option>
                        <option value="recent">Sort: Recently used</option>
                        <option value="active-time">Sort: Active time</option>
                      </select>
                    </div>

                    <div className="picker-actions">
                      <button className="secondary" onClick={selectAllApps}>Select all</button>
                      <button className="secondary" onClick={deselectAllApps}>Deselect all</button>
                    </div>

                    {hiddenBackgroundCount > 0 && (
                      <label className="app-row" style={{ marginBottom: 6 }}>
                        <input
                          type="checkbox"
                          checked={showBackgroundApps}
                          onChange={(e) => setShowBackgroundApps(e.target.checked)}
                        />
                        Show background-only apps ({hiddenBackgroundCount} hidden — no launcher icon, can't ever be brought on-screen)
                      </label>
                    )}

                    {!usageAccessGranted && (
                      <div className="picker-notice">
                        <p>Grant Usage Access to auto-suggest apps you've used this week.</p>
                        <button className="secondary" onClick={() => AccessibilityScanner.openUsageAccessSettings()}>
                          Grant Usage Access
                        </button>
                      </div>
                    )}

                    {sortMode !== "category" && (
                      userApps.length === 0
                        ? <p className="hint">No apps match.</p>
                        : flatSortedUserApps.map(renderAppRow)
                    )}

                    {sortMode === "category" && recentApps.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div className="picker-group-header">
                          <input
                            type="checkbox"
                            title="Select all in this group"
                            checked={recentApps.every(a => draft.has(a.packageName))}
                            onChange={() => toggleGroup(recentApps)}
                          />
                          <span className="picker-group-label recent" style={{ cursor: "default" }}>
                            Recently used (last 7 days)
                          </span>
                        </div>
                        {recentApps.map(renderAppRow)}
                      </div>
                    )}

                    {sortMode === "category" && categoryNames.map(category => {
                      const collapsed = collapsedCategories.has(category);
                      const categoryApps = (byCategory.get(category) ?? []).sort((a, b) => a.label.localeCompare(b.label));
                      return (
                        <div key={category} style={{ marginBottom: 4 }}>
                          <div className="picker-group-header">
                            <input
                              type="checkbox"
                              title="Select all in this category"
                              checked={categoryApps.every(a => draft.has(a.packageName))}
                              onChange={() => toggleGroup(categoryApps)}
                            />
                            <span className="picker-group-label" onClick={() => toggleCategoryCollapsed(category)}>
                              {collapsed ? '▸' : '▾'} {category} ({categoryApps.length})
                            </span>
                          </div>
                          {!collapsed && categoryApps.map(renderAppRow)}
                        </div>
                      );
                    })}

                    {systemApps.length > 0 && (() => {
                      const sortedSystemApps = systemApps
                        .slice()
                        .sort(sortMode === "category" ? flatSortComparators.name : flatSortComparators[sortMode]);
                      return (
                        <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
                          <div className="picker-group-header">
                            <input
                              type="checkbox"
                              title="Select all system apps"
                              checked={sortedSystemApps.every(a => draft.has(a.packageName))}
                              onChange={() => toggleGroup(sortedSystemApps)}
                            />
                            <span className="picker-group-label" onClick={() => setShowSystemApps(!showSystemApps)}>
                              {showSystemApps ? '▾' : '▸'} System apps ({systemApps.length})
                            </span>
                          </div>
                          {showSystemApps && sortedSystemApps.map(renderAppRow)}
                        </div>
                      );
                    })()}

                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button onClick={saveAllowlist}>Save ({draft.size} selected)</button>
                      <button className="secondary" onClick={cancelPicker}>Cancel</button>
                    </div>
                  </div>
                );
              })()}

              <div className="panel panel-danger" style={{ marginTop: 14 }}>
                <Switch
                  checked={passiveMode}
                  disabled={allowlist.size === 0}
                  onChange={handleTogglePassiveMode}
                  danger={true}
                  label={<strong>Passive mode (advanced)</strong>}
                  description={
                    <span>
                      Push screen text from allowed apps to PiecesOS continuously whenever it changes and settles for ~2s.
                      {allowlist.size === 0 && " (Select at least one app above to enable)"}
                    </span>
                  }
                />

                {showPassiveConfirm && (
                  <div className="confirm-box">
                    <p>
                      This will continuously send text from {allowlist.size} allowed app{allowlist.size === 1 ? '' : 's'} to
                      PiecesOS in the background, without asking each time. Type "{PASSIVE_MODE_CONFIRM_PHRASE}" to confirm.
                    </p>
                    <input
                      value={passiveConfirmText}
                      onChange={(e) => setPassiveConfirmText(e.target.value)}
                      placeholder={PASSIVE_MODE_CONFIRM_PHRASE}
                    />
                    <div className="confirm-actions">
                      <button
                        className="danger"
                        onClick={confirmPassiveMode}
                        disabled={passiveConfirmText.trim() !== PASSIVE_MODE_CONFIRM_PHRASE}
                      >
                        Confirm
                      </button>
                      <button
                        className="secondary"
                        onClick={() => { setShowPassiveConfirm(false); setPassiveConfirmText(""); }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {passiveMode && lastPassiveCapture && (
                  <div className="status-ok" style={{ fontSize: 12, marginTop: 8, fontWeight: 500 }}>
                    <span className="status-pulse-live" />
                    <span>Last passive capture: {lastPassiveCapture.pkg} at {new Date(lastPassiveCapture.at).toLocaleTimeString()}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <IntegrationsHub />

      <PermissionsPanel />
    </div>
  );
}
