"use client";

import { useEffect, useRef } from "react";
import { useWorkspace } from "./WorkspaceShell";

export function KeybindingsLayer() {
  const { tabs, setActiveTab, openTab } = useWorkspace();
  const lastKey = useRef<{ key: string; ts: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const now = Date.now();
      const prev = lastKey.current;
      if (prev && now - prev.ts < 500 && prev.key === "g" && e.key === "g") {
        e.preventDefault();
        const home = tabs.find((t) => t.kind === "home");
        if (home) setActiveTab(home.id);
        lastKey.current = null;
        return;
      }
      if (prev && now - prev.ts < 500 && prev.key === "g" && e.key === "a") {
        e.preventDefault();
        const firstAgent = tabs.find((t) => t.kind === "agent");
        if (firstAgent) {
          setActiveTab(firstAgent.id);
        } else {
        }
        lastKey.current = null;
        return;
      }
      if (e.key === "g") {
        lastKey.current = { key: "g", ts: now };
        return;
      }
      lastKey.current = null;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, setActiveTab, openTab]);

  return null;
}
