"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import IconBell from "../IconBell";
import { DRAWERS, DRAWER_KEYS, useUgcDrawer, type DrawerName, type DrawerParams } from "./hub";
import { stamp } from "./ui";
import { callJson } from "./useCards";

type Notice = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link_path: string | null;
  read_at: string | null;
  created_at: string;
};

const POLL_MS = 60_000;

export const NOTICES_CHANGED = "zavi:ugc-notices-changed";

type NoticeLink = { id: string; link_path: string | null; read_at: string | null };

export function noticeIdsFor(notices: NoticeLink[], name: DrawerName, params: DrawerParams): string[] {
  const want = name === "thread" ? params.creator : params.job;
  if (!want) return [];
  return notices
    .filter((n) => {
      if (n.read_at || !n.link_path) return false;
      const d = drawerFromLink(n.link_path);
      if (!d) return false;
      return name === "thread" ? d.name === "thread" && d.params.creator === want : d.name !== "thread" && d.params.job === want;
    })
    .map((n) => n.id);
}

export async function readNotices(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const r = await callJson("/api/humans/notifications/read", { body: { ids } });
  if (r.ok) window.dispatchEvent(new Event(NOTICES_CHANGED));
  return r.ok;
}

export async function readThreadNotices(creator: string): Promise<void> {
  const r = await callJson<{ notifications?: NoticeLink[] }>("/api/humans/notifications");
  if (!r.ok || !r.data?.notifications) return;
  await readNotices(noticeIdsFor(r.data.notifications, "thread", { creator }));
}

export function drawerFromLink(link: string): { name: DrawerName; params: DrawerParams } | null {
  const url = new URL(link, "https://workspace.local");
  const name = url.searchParams.get("drawer");
  if (url.pathname !== "/workspace" || !name || !(DRAWERS as readonly string[]).includes(name)) return null;
  const params: DrawerParams = {};
  for (const k of DRAWER_KEYS) {
    if (k === "drawer") continue;
    const v = url.searchParams.get(k);
    if (v) params[k as keyof DrawerParams] = v;
  }
  return { name: name as DrawerName, params };
}

export function UgcNotificationBell() {
  const drawer = useUgcDrawer();
  const [items, setItems] = useState<Notice[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await callJson<{ notifications: Notice[]; unread: number }>("/api/humans/notifications");
    if (!r.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setItems(r.data.notifications);
    setUnread(r.data.unread);
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    window.addEventListener(NOTICES_CHANGED, onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(NOTICES_CHANGED, onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markRead = useCallback(
    (body: { ids: string[] } | { all: true }) => {
      const now = new Date().toISOString();
      const hit = (n: Notice) => !n.read_at && ("all" in body || body.ids.includes(n.id));
      setItems((xs) => xs?.map((n) => (hit(n) ? { ...n, read_at: now } : n)) ?? xs);
      setUnread((u) => ("all" in body ? 0 : Math.max(0, u - (items ?? []).filter(hit).length)));
      void callJson("/api/humans/notifications/read", { body }).then((r) => {
        if (!r.ok) void load();
      });
    },
    [items, load],
  );

  const openNotice = (n: Notice) => {
    if (!n.read_at) markRead({ ids: [n.id] });
    setOpen(false);
    if (!n.link_path) return;
    const target = drawerFromLink(n.link_path);
    if (target) drawer.open(target.name, target.params);
    else window.location.assign(n.link_path);
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void load();
        }}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-full text-ink hover:bg-bone"
      >
        <IconBell size={18} />
        <span className="sr-only">{unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}</span>
        {unread > 0 ? (
          <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-cream" />
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-10 z-40 w-[min(360px,90vw)] overflow-hidden rounded-xl border border-rule bg-cream shadow-elev"
        >
          <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-2.5">
            <p className="text-[14px] font-semibold text-ink">
              Notifications
              {unread > 0 ? <span className="ml-1.5 font-normal text-inkMuted">{unread} unread</span> : null}
            </p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => markRead({ all: true })}
                className="text-[13px] font-medium text-inkMuted underline underline-offset-2 hover:text-ink"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {failed && !items ? (
              <p className="px-4 py-6 text-center text-[13px] text-inkMuted">Notifications did not load. Try again in a moment.</p>
            ) : !items ? (
              <p className="px-4 py-6 text-center text-[13px] text-inkMuted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-inkMuted">
                Nothing yet. Creator messages, acceptances and delivered videos show here.
              </p>
            ) : (
              <ul>
                {items.map((n) => (
                  <li key={n.id} className="border-b border-rule last:border-b-0">
                    <button
                      type="button"
                      onClick={() => openNotice(n)}
                      className={`flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-bone ${n.read_at ? "" : "bg-ink/[0.03]"}`}
                    >
                      <span
                        aria-hidden
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-danger"}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[14px] leading-snug text-ink ${n.read_at ? "" : "font-semibold"}`}>
                          {n.title}
                        </span>
                        {n.body ? (
                          <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-inkMuted">{n.body}</span>
                        ) : null}
                        <span className="mt-1 block text-[12px] text-inkLight">
                          {stamp(n.created_at)}
                          {n.read_at ? "" : <span className="sr-only">, unread</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
