import { Outlet } from "react-router";
import TabBar from "./TabBar";
import BiometricApprovalModal from "./BiometricApprovalModal";

export default function Layout() {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <img src="/favicon.png" alt="" className="app-topbar-icon" />
        <span className="app-topbar-title">Pieces Companion</span>
      </header>
      <div className="page-viewport">
        <Outlet />
      </div>
      <BiometricApprovalModal />
      <div className="bottom-dock-scrim" />
      <TabBar />
    </div>
  );
}

