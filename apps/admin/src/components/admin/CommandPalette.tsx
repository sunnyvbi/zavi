"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft } from "lucide-react";
import { ALL_ITEMS, TONE_CLASSES, filterNav, pinsFirst } from "@/lib/admin-nav";
import { useNavPrefs } from "@/lib/nav-prefs";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { pins } = useNavPrefs();
  const results = useMemo(() => (q.trim() ? filterNav(ALL_ITEMS, q) : pinsFirst(ALL_ITEMS, pins)), [q, pins]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setSel(0);
  }, [q]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  function go(href: string) {
    onClose();
    router.push(href);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[sel];
      if (hit) go(hit.href);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/35 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Jump to page"
    >
      <div className="w-full max-w-[560px] overflow-hidden rounded-[14px] border border-slate-200 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.4)]">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${ALL_ITEMS.length} admin pages`}
          autoComplete="off"
          aria-label="Search admin pages"
          className="w-full border-0 border-b border-slate-200 bg-transparent px-[18px] py-4 text-base text-slate-900 outline-none placeholder:text-slate-500"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-[14px] text-slate-600">No page matches &ldquo;{q}&rdquo;</div>
          ) : (
            results.map((r, i) => {
              const Icon = r.icon;
              return (
                <button
                  key={r.href}
                  type="button"
                  data-idx={i}
                  onMouseEnter={() => setSel(i)}
                  onFocus={() => setSel(i)}
                  onClick={() => go(r.href)}
                  className={
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[15px] font-medium text-slate-900 " +
                    (i === sel ? "bg-sky-100" : "")
                  }
                >
                  <Icon className={"h-[17px] w-[17px] " + TONE_CLASSES[r.tone].icon} strokeWidth={1.9} />
                  <span className="truncate">{r.label}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs text-slate-600">
                    {!q.trim() && pins.includes(r.href) ? "Pinned" : r.group || "Home"}
                    {i === sel && <CornerDownLeft className="h-3.5 w-3.5" />}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
