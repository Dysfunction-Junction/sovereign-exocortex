import { Outlet, useLocation, useNavigate } from "react-router";
import TabBar from "./TabBar";
import BiometricApprovalModal from "./BiometricApprovalModal";
import { StatusIcon, BrainIcon, SparklesIcon, RecentIcon, SearchIcon, SetupIcon } from "./Icons";

import { isDesktopApp } from "../lib/config";

const MOBILE_NAV_ITEMS = [
  { path: "/status", label: "Status & HUD", icon: StatusIcon },
  { path: "/brain", label: "Living Brain 3D", icon: BrainIcon },
  { path: "/ask", label: "Ask AI", icon: SparklesIcon },
  { path: "/recent", label: "Recent Telemetry", icon: RecentIcon },
  { path: "/search", label: "Semantic Search", icon: SearchIcon },
  { path: "/setup", label: "Setup", icon: SetupIcon },
];

const DESKTOP_NAV_ITEMS = [
  { path: "/brain", label: "Living Brain 3D", icon: BrainIcon },
  { path: "/status", label: "Workstation Node", icon: StatusIcon },
  { path: "/ask", label: "Ask AI", icon: SparklesIcon },
  { path: "/recent", label: "Recent Telemetry", icon: RecentIcon },
  { path: "/search", label: "Semantic Search", icon: SearchIcon },
  { path: "/setup", label: "Node Hub & Pairing", icon: SetupIcon },
];

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const pathname = location.pathname;
  const isBrain = pathname === "/brain";
  const isDesktop = isDesktopApp();
  const navItems = isDesktop ? DESKTOP_NAV_ITEMS : MOBILE_NAV_ITEMS;

  return (
    <div className={`app-shell ${isBrain ? "is-brain-view" : ""}`}>
      {/* Desktop Navigation Topbar (PC Command Center) */}
      <header className="desktop-topbar">
        <div
          className="desktop-brand"
          role="button"
          tabIndex={0}
          onClick={() => navigate(isDesktop ? "/brain" : "/status")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              navigate(isDesktop ? "/brain" : "/status");
            }
          }}
        >
          <img src="/favicon.png" alt="" className="app-topbar-icon" />
          <div className="desktop-brand-titles">
            <span className="desktop-brand-title">Sovereign Exocortex</span>
            <span className="desktop-brand-sub">PC Command Center</span>
          </div>
        </div>

        <nav className="desktop-nav">
          {navItems.map((item) => {
            const isActive = pathname === item.path;
            const Icon = item.icon;
            return (
              <button
                key={item.path}
                type="button"
                className={`desktop-nav-btn ${isActive ? "active" : ""}`}
                onClick={() => navigate(item.path)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="desktop-status-pill">
          <span className="live-pulse-dot" />
          <span>Living World Model</span>
        </div>
      </header>

      {/* Mobile Topbar (hidden on desktop screens) */}
      <header className="app-topbar mobile-only">
        <img src="/favicon.png" alt="" className="app-topbar-icon" />
        <span className="app-topbar-title">Sovereign Exocortex</span>
      </header>

      <div className={`page-viewport ${isBrain ? "full-viewport" : ""}`}>
        <Outlet />
      </div>

      <BiometricApprovalModal />
      <div className="bottom-dock-scrim mobile-only" />
      <div className="mobile-only">
        <TabBar />
      </div>
    </div>
  );
}
