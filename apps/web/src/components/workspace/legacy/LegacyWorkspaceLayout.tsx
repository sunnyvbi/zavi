"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../WorkspaceShell";
import { GettingStartedCard } from "../GettingStartedCard";
import { WorkspacePane } from "../WorkspacePane";
import { ExplorerTree } from "./ExplorerTree";
import { InspectorPane } from "./InspectorPane";

const SIDEBAR_COLLAPSED_KEY = "zavi:sidebar-collapsed";

export function LegacyWorkspaceLayout() {
  const { treeAgents, inspectorByTab, activeTabId } = useWorkspace();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
        setSidebarCollapsed(true);
      }
    } catch {}
  }, []);

  const toggleSidebar = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {}
  }, []);

  const activeInspector = inspectorByTab[activeTabId];
  useEffect(() => {
    if (activeInspector) setInspectorOpen(true);
  }, [activeInspector, activeTabId]);

  return (
    <div
      className={`workspace-shell flex h-screen w-screen flex-col bg-cream pt-[var(--service-banner-h,0px)] text-ink ${
        inspectorOpen ? "inspector-open" : ""
      } ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <div className="workspace-body relative grid min-h-0 flex-1">
        <nav
          aria-label="Explorer"
          className="flex flex-col overflow-hidden"
          style={{ borderRight: "1px solid #e5e7eb" }}
        >
          <ExplorerTree
            agents={treeAgents}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => toggleSidebar(!sidebarCollapsed)}
          />
        </nav>

        <main className="flex min-h-0 min-w-0 flex-col bg-cream">
          <GettingStartedCard />
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkspacePane />
          </div>
        </main>

        <aside aria-label="Inspector" className="inspector-slide">
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: "1px solid rgba(10,31,58,0.06)" }}
          >
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-inkMuted">
              Inspector
            </span>
            <button
              type="button"
              onClick={() => setInspectorOpen(false)}
              className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-inkMuted transition-colors duration-150 hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
              aria-label="Close inspector"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-3.5 w-3.5"
              >
                <path d="M6 6 18 18M18 6 6 18" />
              </svg>
            </button>
          </div>
          <InspectorPane />
        </aside>
      </div>
    </div>
  );
}
