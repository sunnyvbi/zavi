"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "../WorkspaceShell";
import { getAgentMeta, agentDisplayName } from "@/lib/agentRegistry";
import { Input } from "@/components/Input";

export function WorkspaceTopBar() {
  const router = useRouter();
  const { treeAgents, openAgentTab, setPaletteOpen } = useWorkspace();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return treeAgents
      .filter(
        (a) =>
          a.slug.toLowerCase().includes(q) ||
          agentDisplayName(a.slug).toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [treeAgents, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function choose(slug: string) {
    void openAgentTab(slug);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) {
      if (e.key === "Escape") {
        setQuery("");
        setOpen(false);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = results[activeIdx];
      if (pick) choose(pick.slug);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      setOpen(false);
    }
  }

  return (
    <header
      className="relative flex h-10 shrink-0 items-center gap-[22px] bg-[#f2ede3] px-4"
      style={{ borderBottom: "1px solid #faf7f2" }}
    >
      {}
      <div className="flex shrink-0 items-center gap-[5px]">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Go back"
          title="Back"
          className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-block text-[#141b34] transition-colors duration-150 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => router.forward()}
          aria-label="Go forward"
          title="Forward"
          className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-block text-[#9ca3af] transition-colors duration-150 hover:bg-ink/5 hover:text-[#141b34] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </button>
      </div>

      {}
      <div className="min-w-0 flex-1">
        <div ref={wrapRef} className="relative w-full max-w-[744px]">
          <div className="flex h-8 items-center gap-2 rounded-xl bg-white px-2 shadow-[0_1px_2px_rgba(25,25,25,.05)]">
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 shrink-0 text-[#747c88]"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <Input
              unstyled
              suppressHydrationWarning
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => {
                if (query.trim()) setOpen(true);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search anything…"
              aria-label="Search agents"
              aria-expanded={open && results.length > 0}
              role="combobox"
              aria-controls="ws-topbar-search-results"
              className="w-full border-0 bg-transparent p-0 text-[13px] text-ink placeholder:text-[#747c88] focus-visible:outline-none"
            />
          </div>

          {open && query.trim() && (
            <div
              id="ws-topbar-search-results"
              role="listbox"
              className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border border-ink/10 bg-white py-1 shadow-[0_8px_24px_rgba(10,31,58,0.12),0_2px_6px_rgba(10,31,58,0.08)]"
            >
              {results.length === 0 ? (
                <div className="px-3 py-2.5 text-[13px] text-inkMuted">
                  No agents match &ldquo;{query.trim()}&rdquo;.
                </div>
              ) : (
                results.map((a, i) => {
                  const meta = getAgentMeta(a.slug);
                  const isActive = i === activeIdx;
                  return (
                    <button
                      key={a.slug}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => choose(a.slug)}
                      className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100 ${
                        isActive ? "bg-ink/[0.05]" : ""
                      }`}
                    >
                      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-[13px] text-ink">
                          {agentDisplayName(a.slug)}
                        </span>
                        {meta.subtitle && (
                          <span className="block truncate text-[12px] text-inkMuted">
                            {meta.subtitle}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.12em] text-inkMuted">
                        {meta.department}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label="Open command palette"
        title="Command palette (⌘K)"
        className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-block text-[#141b34] transition-colors duration-150 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3" />
          <path d="M12 17h.01" />
        </svg>
      </button>
    </header>
  );
}
