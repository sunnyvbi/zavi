"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Portal } from "@/components/ui/Portal";
import { sharedJson } from "@/lib/workspace/sharedRead";
import { ATTENTION_CHANGED_EVENT, useNeedsYouSnapshot } from "@/lib/workspace/needsYou";
import { notificationAge, notificationRows, readNotificationsSeen, seenStamp, unseenNotifications, writeNotificationsSeen, type NotificationRow, type NotificationsSeen } from "@/lib/workspace/notifications";
import { useWorkspace } from "../WorkspaceShell";
import { useWorkspaceThreads } from "../useAgentThreads";
import { APPROVALS_CHANGED_EVENT } from "../actions/topActions/api";
import { requestThreadPane, tabShowingThread } from "../onScreenThreads";
import { FOCUS_RING, cx, useOpenStatic } from "./shared";

const PANEL_WIDTH = 320;
const GAP = 8;

export function NotificationsMenu({ side = "below", className }: { side?: "below" | "right"; className?: string }) {
  const { tenantId, openAgentTab, setActiveTab, viewMode } = useWorkspace();
  const snap = useNeedsYouSnapshot();
  const { threads } = useWorkspaceThreads();
  const openStatic = useOpenStatic();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [seen, setSeen] = useState<NotificationsSeen>({});
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const reads = useRef(0);

  const read = useCallback(() => {
    const fresh = reads.current > 0;
    reads.current += 1;
    void sharedJson<{ channel_pending_counts?: Record<string, number> }>("/api/approvals", { fresh }).then((body) => {
      if (body) setCounts(body.channel_pending_counts ?? {});
    });
  }, []);

  useEffect(() => {
    setCounts(null);
    setSeen(typeof tenantId === "string" ? readNotificationsSeen(tenantId) : {});
    if (typeof tenantId !== "string") return;
    read();
    window.addEventListener(APPROVALS_CHANGED_EVENT, read);
    window.addEventListener(ATTENTION_CHANGED_EVENT, read);
    return () => {
      window.removeEventListener(APPROVALS_CHANGED_EVENT, read);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, read);
    };
  }, [tenantId, read]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const ready = snap.tenantId === tenantId;
  const rows = useMemo(
    () => unseenNotifications(notificationRows(ready ? snap : { ...snap, decisions: [], totals: null }, threads, counts), seen),
    [ready, snap, threads, counts, seen],
  );

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const rail = button.current?.closest("aside, nav")?.getBoundingClientRect();
    const room = window.innerWidth - PANEL_WIDTH - GAP;
    setPlace(
      side === "right"
        ? { top: rect.top, left: Math.min(room, (rail?.right ?? rect.right) + GAP) }
        : { top: rect.bottom + GAP, left: Math.max(GAP, Math.min(room, (rail?.left ?? rect.left) + GAP)) },
    );
    read();
    setOpen(true);
  };

  const go = (row: NotificationRow) => {
    setOpen(false);
    if (row.mark !== null) {
      const next = { ...seen, [row.key]: seenStamp(row) };
      setSeen(next);
      if (typeof tenantId === "string") writeNotificationsSeen(tenantId, next);
    }
    const target = row.target;
    if (target.kind === "channel") openStatic("channels", { channel: target.slug });
    else if (target.kind === "growth") openStatic("autopilot");
    else if (target.kind === "decision") openStatic("needs-you", { decision: target.id });
    else {
      const holder = tabShowingThread(target.threadId);
      if (holder) setActiveTab(holder);
      else void openAgentTab(target.agentSlug, { threadId: target.threadId }).then((tabId) => {
        if (viewMode === "threaded") requestThreadPane(tabId, target.threadId);
      });
    }
  };

  const seeAll = () => {
    setOpen(false);
    openStatic("needs-you");
  };

  const now = Date.now();
  const label = rows.length > 0 ? `Notifications (${rows.length} waiting on you)` : "Notifications";
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        className={cx(
          "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-cta text-ink transition-colors duration-150 hover:bg-bone active:bg-ink/10 motion-reduce:transition-none",
          open && "bg-bone",
          FOCUS_RING,
          className,
        )}
      >
        <Bell className="h-4 w-4" aria-hidden />
        {rows.length > 0 && <span aria-hidden data-notifications-dot="" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[#b7791f]" />}
      </button>
      {open && place && (
        <Portal>
          <div
            ref={panel}
            role="dialog"
            aria-label="Notifications"
            style={{ top: place.top, left: place.left, width: PANEL_WIDTH }}
            className="fixed z-[120] flex max-h-[min(70vh,520px)] flex-col overflow-hidden rounded-2xl border border-ca-border bg-ca-bg font-ui shadow-ca-md"
          >
            <h2 className="shrink-0 border-b border-ca-border px-4 py-3 text-[15px] font-semibold text-ca-xdark">Notifications</h2>
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-[14px] text-ca-secondary">Nothing new needs you.</p>
            ) : (
              <ul className="ws-scroll min-h-0 flex-1 overflow-y-auto py-1">
                {rows.map((row) => (
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => go(row)}
                      className={cx("flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-ca-hover motion-reduce:transition-none", FOCUS_RING)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-ca-xdark">{row.title}</span>
                        <span className="block truncate text-[13px] text-ca-secondary">{row.text}</span>
                      </span>
                      <span className="shrink-0 pt-0.5 text-[12px] tabular-nums text-ca-secondary">{notificationAge(row.at, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={seeAll}
              className={cx("shrink-0 border-t border-ca-border px-4 py-3 text-left text-[14px] font-medium text-ca-xdark transition-colors duration-150 hover:bg-ca-hover motion-reduce:transition-none", FOCUS_RING)}
            >
              See everything that needs you
            </button>
          </div>
        </Portal>
      )}
    </>
  );
}
