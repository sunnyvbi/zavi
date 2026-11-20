"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../WorkspaceShell";
import type { TabDescriptor } from "@/lib/workspace/types";
import { Input } from "@/components/Input";
import { apiFetch } from "@/lib/api";
import { relativeTime } from "@/lib/workspace/relativeTime";
import { capBadgeCount, exactCountLabel } from "@/lib/workspace/badgeCount";

type AgentPayload = { kind: "agent"; slug: string; threadId?: string | null };

type ThreadMeta = {
  id: string;
  title: string | null;
  last_message_at: string | null;
  last_message: string | null;
  run_status: string | null;
  pending: boolean | null;
};

type TabUnit = { slug: string; tabs: TabDescriptor[] };

export function TabBar() {
  const {
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    openTab,
    openAgentTab,
    renameTab,
    unreadTabIds,
    setPaletteOpen,
    treeAgents,
  } = useWorkspace();

  const pendingBySlug = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of treeAgents) {
      if (a.pending_decisions_count > 0) {
        m.set(a.slug, a.pending_decisions_count);
      }
    }
    return m;
  }, [treeAgents]);

  const activeAgentSlug = (() => {
    const t = tabs.find((x) => x.id === activeTabId);
    return t && t.kind === "agent" ? (t.payload as AgentPayload).slug : null;
  })();
  const lastClosed = useRef<TabDescriptor | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [confirmClose, setConfirmClose] = useState<TabDescriptor | null>(null);

  const hasChat = useCallback((tab: TabDescriptor) => {
    if (tab.kind !== "agent") return false;
    const p = tab.payload as { threadId?: string | null };
    return typeof p.threadId === "string" && p.threadId.length > 0;
  }, []);

  const doClose = useCallback(
    (tab: TabDescriptor) => {
      lastClosed.current = tab;
      closeTab(tab.id);
    },
    [closeTab],
  );

  const requestClose = useCallback(
    (tab: TabDescriptor) => {
      if (hasChat(tab)) setConfirmClose(tab);
      else doClose(tab);
    },
    [hasChat, doClose],
  );

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const MAX_TITLE_LEN = 80;

  const [ctxMenu, setCtxMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [groupOpen, setGroupOpen] = useState<{
    slug: string;
    x: number;
    y: number;
  } | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);

  const [threadMeta, setThreadMeta] = useState<Record<string, ThreadMeta>>({});

  useEffect(() => {
    if (!groupOpen) return;
    const slug = groupOpen.slug;
    let cancelled = false;
    setThreadMeta({});
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/agents/${encodeURIComponent(slug)}/threads`,
        );
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { threads: ThreadMeta[] };
        if (cancelled) return;
        const map: Record<string, ThreadMeta> = {};
        for (const t of data.threads ?? []) map[t.id] = t;
        setThreadMeta(map);
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupOpen]);

  useEffect(() => {
    if (!ctxMenu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = ctxMenu.x;
    let ny = ctxMenu.y;
    if (r.right > vw - pad) nx = Math.max(pad, vw - r.width - pad);
    if (r.bottom > vh - pad) ny = Math.max(pad, vh - r.height - pad);
    if (nx !== ctxMenu.x || ny !== ctxMenu.y) {
      setCtxMenu({ ...ctxMenu, x: nx, y: ny });
    }
  }, [ctxMenu]);

  useEffect(() => {
    if (!groupOpen || !groupRef.current) return;
    const r = groupRef.current.getBoundingClientRect();
    const pad = 8;
    const vw = window.innerWidth;
    if (r.right > vw - pad) {
      const nx = Math.max(pad, vw - r.width - pad);
      if (nx !== groupOpen.x) setGroupOpen({ ...groupOpen, x: nx });
    }
  }, [groupOpen]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current && menuRef.current.contains(target)) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const onScroll = () => setCtxMenu(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    scrollerRef.current?.addEventListener("scroll", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      scrollerRef.current?.removeEventListener("scroll", onScroll);
    };
  }, [ctxMenu]);

  useEffect(() => {
    if (!groupOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (groupRef.current && groupRef.current.contains(target)) return;
      setGroupOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGroupOpen(null);
    };
    const onScroll = () => setGroupOpen(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    scrollerRef.current?.addEventListener("scroll", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      scrollerRef.current?.removeEventListener("scroll", onScroll);
    };
  }, [groupOpen]);

  useEffect(() => {
    if (ctxMenu && !tabs.find((t) => t.id === ctxMenu.tabId)) {
      setCtxMenu(null);
    }
  }, [tabs, ctxMenu]);

  const startRename = useCallback((tab: TabDescriptor) => {
    setEditingTabId(tab.id);
    setEditingValue(tab.title);
  }, []);

  const commitRename = useCallback(() => {
    if (!editingTabId) return;
    const trimmed = editingValue.trim().slice(0, MAX_TITLE_LEN);
    if (trimmed) renameTab(editingTabId, trimmed);
    setEditingTabId(null);
  }, [editingTabId, editingValue, renameTab]);

  const cancelRename = useCallback(() => {
    setEditingTabId(null);
  }, []);

  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingTabId]);

  useEffect(() => {
    if (editingTabId && !tabs.find((t) => t.id === editingTabId)) {
      setEditingTabId(null);
    }
  }, [tabs, editingTabId]);

  useEffect(() => {
    const el = tabRefs.current[activeTabId];
    if (el && scrollerRef.current) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        const tab = tabs.find((t) => t.id === activeTabId);
        if (tab && !tab.pinned) {
          e.preventDefault();
          startRename(tab);
        }
        return;
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "t" || e.key === "T" || e.key === "†")) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        const t = lastClosed.current;
        if (t) {
          openTab({
            kind: t.kind,
            title: t.title,
            payload: t.payload,
            dirty: false,
            pinned: t.pinned,
            customTitle: t.customTitle,
          });
          lastClosed.current = null;
        }
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "w") {
        e.preventDefault();
        const tab = tabs.find((t) => t.id === activeTabId);
        if (tab && !tab.pinned) {
          requestClose(tab);
        }
        return;
      }
      const n = Number.parseInt(e.key, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const target = tabs[n - 1];
        if (target) {
          e.preventDefault();
          setActiveTab(target.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, activeTabId, setActiveTab, openTab, startRename, requestClose]);

  const stripTabs = tabs.filter((t) => t.kind === "agent");
  const units: TabUnit[] = (() => {
    const out: TabUnit[] = [];
    const idxBySlug = new Map<string, number>();
    for (const t of stripTabs) {
      const slug = (t.payload as AgentPayload).slug;
      const at = idxBySlug.get(slug);
      if (at === undefined) {
        idxBySlug.set(slug, out.length);
        out.push({ slug, tabs: [t] });
      } else {
        out[at].tabs.push(t);
      }
    }
    return out;
  })();

  const unitIsActive = (u: TabUnit) => u.tabs.some((t) => t.id === activeTabId);

  useEffect(() => {
    if (!groupOpen) return;
    const remaining = stripTabs.filter(
      (t) => (t.payload as AgentPayload).slug === groupOpen.slug,
    );
    if (remaining.length <= 1) setGroupOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, groupOpen]);

  const openGroupPopover = useCallback(
    (slug: string, anchor: HTMLElement) => {
      const r = anchor.getBoundingClientRect();
      setGroupOpen((prev) =>
        prev && prev.slug === slug ? null : { slug, x: r.left, y: r.bottom },
      );
    },
    [],
  );

  const plusButton = (
    <div className="sticky right-0 flex shrink-0 items-stretch bg-[#faf7f2]">
      <span aria-hidden className="my-2 w-px shrink-0 self-stretch bg-[#e5e7eb]" />
      <button
        type="button"
        onClick={() => {
          if (activeAgentSlug) {
            void openAgentTab(activeAgentSlug, { newThread: true });
          } else {
            setPaletteOpen(true);
          }
        }}
        aria-label={
          activeAgentSlug
            ? `New thread for ${activeAgentSlug}`
            : "Open command palette"
        }
        title={
          activeAgentSlug ? `New thread for ${activeAgentSlug}` : "New (⌘K)"
        }
        className="flex h-10 w-12 shrink-0 cursor-pointer items-center justify-center text-[#0e0f11] transition-colors duration-150 hover:bg-ink/[0.04] outline-none [&:focus-visible]:shadow-none"
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );

  return (
    <>
    <div
      className="flex h-10 w-full min-w-0 shrink-0 items-stretch bg-[#faf7f2]"
      style={{ borderBottom: "1px solid #e5e7eb" }}
    >
      {}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        aria-label="Open history (command palette)"
        title="History: recent agents & commands (⌘K)"
        className="flex h-10 w-12 shrink-0 cursor-pointer items-center justify-center text-[#0e0f11] transition-colors duration-150 hover:bg-ink/[0.04] outline-none [&:focus-visible]:shadow-none"
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      <span aria-hidden className="my-2 w-px shrink-0 self-stretch bg-[#e5e7eb]" />

      <div
        ref={scrollerRef}
        className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden scroll-smooth"
      >
      {}
      {units.map((unit, unitIdx) => {
        const active = unitIsActive(unit);
        const prevActive = unitIdx > 0 && unitIsActive(units[unitIdx - 1]);
        const divider = unitIdx > 0 && !active && !prevActive;

        if (unit.tabs.length === 1) {
          const tab = unit.tabs[0];
          const editing = editingTabId === tab.id;
          return (
            <Fragment key={unit.slug}>
              {divider && (
                <span
                  aria-hidden
                  className="my-2 w-px shrink-0 self-stretch bg-[#e5e7eb]"
                />
              )}
              <Chip
                active={active}
                editing={editing}
                registerRef={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                onContextMenu={(e) => {
                  if (tab.pinned) return;
                  e.preventDefault();
                  setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
                }}
              >
                {editing ? (
                  <div className="flex min-w-0 flex-1 items-center py-1">
                    <Input
                      unstyled
                      ref={editInputRef}
                      type="text"
                      value={editingValue}
                      maxLength={MAX_TITLE_LEN}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                        e.stopPropagation();
                      }}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      className={`
                        h-7 w-full min-w-[160px] max-w-[218px]
                        rounded-md
                        border border-ink/70
                        bg-white text-ink
                        px-2 py-0
                        text-[13px] leading-none
                        shadow-[0_1px_0_rgba(10,31,58,0.04),0_0_0_3px_rgba(25,25,25,0.12)]
                        outline-none
                        caret-ink
                        selection:bg-bone selection:text-ink
                        transition-shadow duration-150
                        font-mono tracking-[-0.01em]
                        ${active ? "font-medium" : ""}
                      `}
                      aria-label="Tab name"
                      aria-describedby={`rename-hint-${tab.id}`}
                      title="Press Enter to save · Esc to cancel"
                    />
                    <span id={`rename-hint-${tab.id}`} className="sr-only">
                      Press Enter to save, or Escape to cancel.
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    onDoubleClick={() => {
                      if (!tab.pinned) startRename(tab);
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 outline-none [&:focus-visible]:shadow-none"
                    aria-current={active ? "page" : undefined}
                    aria-label={`Switch to ${tab.title}`}
                    title={tab.title}
                  >
                    {tab.dirty && (
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-marigold"
                        aria-label="Unsaved changes"
                      />
                    )}
                    {unreadTabIds[tab.id] && !active && (
                      <span
                        className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center"
                        aria-label="Task finished. Click to view"
                        title="Task finished"
                      >
                        <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-70" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                      </span>
                    )}
                    <span className="truncate font-mono font-medium">
                      {tab.title}
                    </span>
                    {pendingBySlug.has(unit.slug) && (
                      <NeedsYouPip count={pendingBySlug.get(unit.slug)!} />
                    )}
                  </button>
                )}
                {!tab.pinned && !editing && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(tab);
                    }}
                    aria-label={`Close ${tab.title}`}
                    className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[#0e0f11]/70 transition-colors duration-150 hover:bg-ink/[0.08] hover:text-[#0e0f11] outline-none [&:focus-visible]:shadow-none"
                  >
                    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M6 6 18 18M18 6 6 18" />
                    </svg>
                  </button>
                )}
                {active && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-0 right-0 h-[3px] bg-black"
                  />
                )}
              </Chip>
            </Fragment>
          );
        }

        const groupDirty = unit.tabs.some((t) => t.dirty);
        const groupUnread = unit.tabs.some(
          (t) => unreadTabIds[t.id] && t.id !== activeTabId,
        );
        const isOpen = groupOpen?.slug === unit.slug;
        return (
          <Fragment key={unit.slug}>
            {divider && (
              <span
                aria-hidden
                className="my-2 w-px shrink-0 self-stretch bg-[#e5e7eb]"
              />
            )}
            <Chip
              active={active}
              editing={false}
              registerRef={(el) => {
                for (const t of unit.tabs) tabRefs.current[t.id] = el;
              }}
            >
              <button
                type="button"
                onClick={(e) => openGroupPopover(unit.slug, e.currentTarget)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 outline-none [&:focus-visible]:shadow-none"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label={`${unit.slug}, ${unit.tabs.length} threads`}
                title={`${unit.slug}, ${unit.tabs.length} threads`}
              >
                {groupDirty && (
                  <span
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-marigold"
                    aria-label="Unsaved changes"
                  />
                )}
                {groupUnread && (
                  <span
                    className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center"
                    aria-label="A thread finished. Click to view"
                    title="A thread finished"
                  >
                    <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-70" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                )}
                <span className="truncate font-mono font-medium">
                  {unit.slug}
                </span>
                {pendingBySlug.has(unit.slug) ? (
                  <NeedsYouPip count={pendingBySlug.get(unit.slug)!} />
                ) : (
                  <span
                    className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-ink/[0.08] px-1.5 text-[11px] font-semibold leading-none tabular-nums text-ink/80"
                    aria-hidden
                  >
                    {unit.tabs.length}
                  </span>
                )}
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`h-3.5 w-3.5 shrink-0 text-ink/55 transition-transform duration-150 motion-reduce:transition-none ${isOpen ? "rotate-180" : ""}`}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {active && (
                <span
                  aria-hidden
                  className="absolute bottom-0 left-0 right-0 h-[3px] bg-black"
                />
              )}
            </Chip>
          </Fragment>
        );
      })}

      {plusButton}
      </div>
    </div>

    {}
    {typeof window !== "undefined" &&
      groupOpen &&
      (() => {
        const slug = groupOpen.slug;
        const groupTabs = tabs.filter(
          (t) => t.kind === "agent" && (t.payload as AgentPayload).slug === slug,
        );
        if (groupTabs.length <= 1) return null;

        const orderOf = new Map(groupTabs.map((t, i) => [t.id, i]));
        const sortedTabs = groupTabs;

        return createPortal(
          <div
            ref={groupRef}
            role="menu"
            aria-label={`Threads for ${slug}`}
            style={{
              position: "fixed",
              top: groupOpen.y + 2,
              left: groupOpen.x,
              zIndex: 80,
              transformOrigin: "top left",
            }}
            className="w-[296px] origin-top-left animate-pop-in overflow-hidden rounded-xl bg-[#FBFAF7] p-1 text-[13px] shadow-[0_0_0_1px_rgba(25,25,25,.08),0_2px_4px_rgba(25,25,25,.06),0_10px_28px_rgba(25,25,25,.10)] motion-reduce:animate-none"
          >
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="truncate font-mono text-[12px] font-semibold text-ink">
                {slug}
              </span>
              <span className="ml-auto text-[11px] tabular-nums text-inkMuted">
                {groupTabs.length} threads
              </span>
            </div>
            {}
            <div className="-mx-1 my-1 h-px bg-[rgba(25,25,25,.08)]" aria-hidden />
            {sortedTabs.map((tab, i) => {
              const isActive = tab.id === activeTabId;
              const meta = (() => {
                const tid = (tab.payload as AgentPayload).threadId;
                return tid ? threadMeta[tid] : undefined;
              })();
              const fallbackOrdinal = (orderOf.get(tab.id) ?? 0) + 1;
              const title = tab.customTitle
                ? tab.title
                : meta?.title && meta.title.trim().length > 0
                  ? meta.title
                  : fallbackOrdinal === 1
                    ? "Main thread"
                    : "Untitled thread";
              const pending = meta?.pending === true;
              const status = meta?.run_status ?? null;
              const running = status === "running" || status === "queued";
              const failed =
                status === "failed" ||
                status === "error" ||
                status === "parse_failed" ||
                status === "dispatch_error";
              return (
                <div
                  key={tab.id}
                  className={`group/row flex items-start gap-2 rounded-md px-2 py-1.5 ${isActive ? "bg-[rgba(25,25,25,.04)]" : "hover:bg-[rgba(25,25,25,.05)]"}`}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setActiveTab(tab.id);
                      setGroupOpen(null);
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left outline-none"
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {}
                      <span
                        className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center"
                        aria-hidden
                      >
                        {running && (
                          <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-emerald-400 opacity-70" />
                        )}
                        <span
                          className={`relative inline-flex h-2 w-2 rounded-full ${
                            running
                              ? "bg-emerald-500"
                              : failed
                                ? "bg-coral"
                                : "bg-ink/25"
                          }`}
                        />
                      </span>
                      {tab.dirty && (
                        <span
                          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-marigold"
                          aria-label="Unsaved changes"
                        />
                      )}
                      <span
                        className={`truncate ${isActive ? "font-medium text-ink" : "text-ink/90"}`}
                      >
                        {title}
                      </span>
                      {pending && (
                        <span
                          className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-[#fbeccb] px-1.5 py-px text-[11px] font-bold leading-none text-[#8a5a10]"
                          title="An approval is waiting on you"
                        >
                          <span
                            className="inline-block h-2 w-2 rotate-45 bg-[#d8881e]"
                            aria-hidden
                          />
                          needs you
                        </span>
                      )}
                      {isActive && (
                        <svg
                          aria-label="Current thread"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="ml-auto h-3.5 w-3.5 shrink-0 text-ink/55"
                        >
                          <path d="m5 12 5 5L20 7" />
                        </svg>
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-2 pl-3.5 text-[12px] text-inkMuted">
                      <span className="min-w-0 flex-1 truncate">
                        {meta?.last_message && meta.last_message.trim().length > 0
                          ? meta.last_message
                          : "No messages yet"}
                      </span>
                      {meta?.last_message_at && (
                        <span className="shrink-0 tabular-nums text-inkMuted/80">
                          {relativeTime(meta.last_message_at)}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(tab);
                    }}
                    aria-label={`Close ${title}`}
                    className="mt-0.5 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-ink/40 opacity-0 transition-colors duration-150 hover:bg-ink/[0.08] hover:text-ink group-hover/row:opacity-100 focus-visible:opacity-100 outline-none"
                  >
                    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                      <path d="M6 6 18 18M18 6 6 18" />
                    </svg>
                  </button>
                </div>
              );
            })}
            {}
            <div className="-mx-1 my-1 h-px bg-[rgba(25,25,25,.08)]" aria-hidden />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void openAgentTab(slug, { newThread: true });
                setGroupOpen(null);
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-ink transition-colors duration-100 hover:bg-[rgba(25,25,25,.05)] outline-none"
            >
              <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-inkMuted">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New {slug} thread
            </button>
          </div>,
          document.body,
        );
      })()}

    {typeof window !== "undefined" &&
      ctxMenu &&
      (() => {
        const tab = tabs.find((t) => t.id === ctxMenu.tabId);
        if (!tab) return null;
        return createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Tab actions for ${tab.title}`}
            style={{
              position: "fixed",
              top: ctxMenu.y,
              left: ctxMenu.x,
              zIndex: 80,
            }}
            className="min-w-[180px] overflow-hidden rounded-md border border-ink/10 bg-white py-1 text-[13px] shadow-[0_8px_24px_rgba(10,31,58,0.12),0_2px_6px_rgba(10,31,58,0.08)]"
          >
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                const t = tab;
                setCtxMenu(null);
                startRename(t);
              }}
              className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-left text-ink transition-colors duration-100 hover:bg-bone/60 focus-visible:bg-bone/60 focus-visible:outline-none"
            >
              <span className="flex items-center gap-2">
                <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-inkMuted">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                </svg>
                Rename
              </span>
              <span className="font-mono text-[11px] text-inkMuted/70">F2</span>
            </button>
            <div className="my-1 h-px bg-ink/[0.06]" aria-hidden />
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                const t = tab;
                setCtxMenu(null);
                requestClose(t);
              }}
              className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-left text-ink transition-colors duration-100 hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:outline-none"
            >
              <span className="flex items-center gap-2">
                <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-inkMuted">
                  <path d="M6 6 18 18M18 6 6 18" />
                </svg>
                Close tab
              </span>
              <span className="font-mono text-[11px] text-inkMuted/70">⌘W</span>
            </button>
          </div>,
          document.body,
        );
      })()}

      {typeof window !== "undefined" &&
        confirmClose &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm close tab"
            className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/40 px-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setConfirmClose(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirmClose(null);
            }}
          >
            <div className="w-full max-w-sm rounded-2xl border border-ink/10 bg-white p-4 shadow-[0_8px_24px_rgba(10,31,58,0.12),0_2px_6px_rgba(10,31,58,0.08)]">
              <h2 className="font-display text-[16px] font-semibold text-ink">
                Close this chat?
              </h2>
              <p className="mt-1.5 text-[13px] text-inkMuted">
                {`"${confirmClose.title}" has a conversation. Closing only hides the tab. The chat is saved and you can reopen it anytime.`}
              </p>
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmClose(null)}
                  className="rounded-full border border-ink/10 bg-white px-4 py-1.5 text-[13px] font-medium text-ink transition-colors hover:border-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={() => {
                    const t = confirmClose;
                    setConfirmClose(null);
                    doClose(t);
                  }}
                  className="rounded-full border border-transparent bg-ink px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-inkSoft"
                >
                  Close tab
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function Chip({
  active,
  editing,
  registerRef,
  onContextMenu,
  children,
}: {
  active: boolean;
  editing: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={registerRef}
      onContextMenu={onContextMenu}
      className={`
        group relative flex shrink-0 max-w-[240px] min-w-0 items-center gap-2 pl-3 pr-2.5 text-[16px] tracking-[0.14px] transition-colors duration-150
        ${active ? "rounded-t-[8px] bg-[#f2ede3] text-[#0e0f11]" : "text-[#0e0f11] hover:bg-ink/[0.03]"}
        ${editing ? "bg-bone/60" : ""}
      `}
    >
      {children}
    </div>
  );
}

function NeedsYouPip({ count }: { count: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#fbeccb] px-1.5 py-px text-[11px] font-bold leading-none tabular-nums text-[#8a5a10]"
      title={exactCountLabel(count)}
      aria-label={exactCountLabel(count)}
    >
      <span className="inline-block h-2 w-2 rounded-full bg-[#d8881e]" aria-hidden />
      {capBadgeCount(count)}
    </span>
  );
}
