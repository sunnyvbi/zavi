"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Lightbulb, Loader2, Plus } from "lucide-react";
import type { BuildSuggestion } from "@/lib/workspace/useBuildSuggestions";

export const SUGGESTIONS_COLLAPSED_KEY = "zavi:build-suggestions-collapsed";
export const MORE_SUGGESTIONS_LABEL = "More suggestions";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SUGGESTIONS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SUGGESTIONS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
  }
}

const ARROW =
  "grid h-7 w-7 shrink-0 place-items-center rounded-full border border-rule bg-white text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-40";

export function BuildSuggestionsBar({
  suggestions,
  loading,
  loadingMore = false,
  moreFailed = false,
  disabled,
  describedBy,
  onPick,
  onMore,
}: {
  suggestions: readonly BuildSuggestion[];
  loading: boolean;
  loadingMore?: boolean;
  moreFailed?: boolean;
  disabled: boolean;
  describedBy?: string;
  onPick: (suggestion: BuildSuggestion) => void;
  onMore?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const max = row.scrollWidth - row.clientWidth;
    setEdges({ start: row.scrollLeft <= 1, end: row.scrollLeft >= max - 1 });
  }, []);

  useEffect(() => {
    measure();
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [measure, suggestions.length, collapsed, loading]);

  const countRef = useRef(suggestions.length);
  useEffect(() => {
    const grew = countRef.current > 0 && suggestions.length > countRef.current;
    countRef.current = suggestions.length;
    if (grew) rowRef.current?.scrollBy?.({ left: rowRef.current.clientWidth * 0.7, behavior: "smooth" });
  }, [suggestions.length]);

  const scrollBy = (dir: 1 | -1) => {
    const row = rowRef.current;
    if (!row) return;
    row.scrollBy({ left: dir * Math.max(120, row.clientWidth * 0.7), behavior: "smooth" });
  };

  const toggle = () => {
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });
  };

  return (
    <section aria-label="Suggested next improvements" data-testid="build-suggestions" className="border-b border-rule/60 bg-white px-4 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        data-testid="build-suggestions-toggle"
        className="inline-flex items-center gap-1.5 rounded-md text-[12px] font-medium text-inkMuted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <Lightbulb className="h-3.5 w-3.5" aria-hidden />
        Suggestions
        <ChevronDown className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`} aria-hidden />
      </button>
      {!collapsed && (
        <div className="mt-2 flex items-center gap-1.5">
          {!edges.start && (
            <button type="button" aria-label="Scroll suggestions left" data-testid="build-suggestions-left" onClick={() => scrollBy(-1)} className={ARROW}>
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
          )}
          {loading ? (
            <div aria-label="Loading suggestions" role="status" className="hide-scrollbar flex min-w-0 flex-1 gap-2 overflow-x-auto">
              {[96, 132, 112].map((width) => (
                <div key={width} className="h-8 shrink-0 animate-pulse rounded-full bg-bone motion-reduce:animate-none" style={{ width }} />
              ))}
            </div>
          ) : (
            <div ref={rowRef} onScroll={measure} className="hide-scrollbar min-w-0 flex-1 snap-x snap-proximity overflow-x-auto">
              <ul aria-label="Suggested next improvements" className="flex w-max min-w-full gap-2">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.key} className="shrink-0 snap-start">
                    <button
                      type="button"
                      disabled={disabled}
                      aria-describedby={describedBy}
                      onClick={() => onPick(suggestion)}
                      className="inline-flex h-8 items-center whitespace-nowrap rounded-full border border-rule bg-white px-3 text-[13px] font-medium text-ink transition-colors hover:border-ink/20 hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-rule disabled:hover:bg-white"
                      aria-label={suggestion.label}
                    >
                      {suggestion.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!loading &&
            (!edges.end ? (
              <button type="button" aria-label="Scroll suggestions right" data-testid="build-suggestions-right" onClick={() => scrollBy(1)} className={ARROW}>
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            ) : onMore ? (
              <button
                type="button"
                aria-label={MORE_SUGGESTIONS_LABEL}
                title={MORE_SUGGESTIONS_LABEL}
                data-testid="build-suggestions-more"
                disabled={loadingMore}
                onClick={onMore}
                className={ARROW}
              >
                {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
              </button>
            ) : null)}
        </div>
      )}
      {!collapsed && moreFailed && !loadingMore && onMore && (
        <p role="status" data-testid="build-suggestions-more-failed" className="mt-1.5 text-[12px] text-inkMuted">
          Couldn&apos;t get more suggestions. Try again.
        </p>
      )}
    </section>
  );
}
