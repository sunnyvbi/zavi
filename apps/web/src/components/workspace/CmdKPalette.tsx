"use client";

import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "./WorkspaceShell";
import { getAgentMeta, agentDisplayName } from "@/lib/agentRegistry";
import { Input } from "@/components/Input";
import { useOpenStatic } from "./layout/shared";

type Agent = {
  slug: string;
  custom?: boolean;
};

const CUSTOM_SLUG_RE = /^c-[a-z0-9]{8,12}$/;

export function CmdKPalette({ agents }: { agents: Agent[] }) {
  const { paletteOpen, setPaletteOpen, openAgentTab } = useWorkspace();
  const openStatic = useOpenStatic();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        setQuery("");
        setCursor(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents.slice(0, 20);
    return agents
      .filter((a) => {
        const meta = getAgentMeta(a.slug);
        return (
          a.slug.toLowerCase().includes(q) ||
          agentDisplayName(a.slug).toLowerCase().includes(q) ||
          meta.subtitle.toLowerCase().includes(q) ||
          meta.department.toLowerCase().includes(q)
        );
      })
      .slice(0, 20);
  }, [query, agents]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!paletteOpen) return null;

  const choose = (slug: string, newThread: boolean) => {
    const custom = agents.some((a) => a.slug === slug && a.custom === true) && CUSTOM_SLUG_RE.test(slug);
    if (custom && !newThread) openStatic("agent-builder", { agentId: slug });
    else void openAgentTab(slug, { newThread });
    setPaletteOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-4 pt-[10vh] backdrop-blur-sm"
      role="dialog"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-ink/10 bg-white shadow-2xl">
        <Input
          unstyled
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setPaletteOpen(false);
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, matches.length - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const slug = matches[cursor]?.slug;
              if (slug) choose(slug, e.metaKey || e.ctrlKey);
            }
          }}
          placeholder="Search agents…"
          className="w-full border-b border-ink/10 px-4 py-3 text-[16px] outline-none"
          aria-label="Search agents"
        />
        <ul role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {matches.length === 0 && (
            <li className="px-4 py-3 text-[13px] text-inkMuted">
              No agents match.
            </li>
          )}
          {matches.map((a, idx) => {
            const meta = getAgentMeta(a.slug);
            const active = idx === cursor;
            return (
              <li key={a.slug}>
                <button
                  type="button"
                  onClick={(e) => choose(a.slug, e.metaKey || e.ctrlKey)}
                  onMouseEnter={() => setCursor(idx)}
                  className={`
                    flex w-full items-center gap-3 px-4 py-2 text-left text-[13px]
                    ${active ? "bg-bone" : "hover:bg-bone"}
                  `}
                >
                  <span className="font-medium text-ink">{agentDisplayName(a.slug)}</span>
                  <span className="truncate text-[12px] text-inkMuted">
                    {meta.subtitle}
                  </span>
                  <span className="ml-auto text-[11px] uppercase tracking-wide text-inkMuted">
                    {meta.department}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-ink/10 bg-bone px-4 py-1.5 text-[11px] text-inkMuted">
          <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
          <kbd className="font-mono">↵</kbd> open ·{" "}
          <kbd className="font-mono">⌘↵</kbd> new thread ·{" "}
          <kbd className="font-mono">esc</kbd> close
        </div>
      </div>
    </div>
  );
}
