"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useWorkspace } from "../WorkspaceShell";
import { useWorkspaceThreads } from "../useAgentThreads";
import { APPROVALS_CHANGED_EVENT } from "../actions/topActions/api";
import { requestThreadPane, tabShowingThread } from "../onScreenThreads";
import { cx, useOpenStatic } from "./shared";
import {
  ATTENTION_CHANGED_EVENT,
  NEEDS_YOU_HIDDEN_POLL_MS,
  NEEDS_YOU_POLL_MS,
  needsYouItems,
  needsYouRemaining,
  refreshNeedsYou,
  useNeedsYouSnapshot,
  type NeedsYouItem,
} from "@/lib/workspace/needsYou";
import { bumpTabTitle } from "@/lib/workspace/tabTitle";

const NONE: ReadonlySet<string> = new Set();

export function NeedsYouLine() {
  const { tenantId, openAgentTab, setActiveTab, viewMode } = useWorkspace();
  const snap = useNeedsYouSnapshot();
  const { threads } = useWorkspaceThreads();
  const openStatic = useOpenStatic();
  const [closedAt, setClosedAt] = useState<string | null>(null);

  useEffect(() => setClosedAt(null), [tenantId]);

  useEffect(() => {
    if (typeof tenantId !== "string") return;
    const refresh = () => void refreshNeedsYou(tenantId);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, NEEDS_YOU_POLL_MS);
    const hiddenId = window.setInterval(() => {
      if (document.hidden) refresh();
    }, NEEDS_YOU_HIDDEN_POLL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(ATTENTION_CHANGED_EVENT, refresh);
    window.addEventListener(APPROVALS_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(id);
      window.clearInterval(hiddenId);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, refresh);
      window.removeEventListener(APPROVALS_CHANGED_EVENT, refresh);
    };
  }, [tenantId]);

  const ready = snap.loaded && snap.tenantId === tenantId;
  const items = useMemo(() => {
    const all = needsYouItems(ready ? snap.decisions : [], threads, NONE);
    return closedAt === null ? all : all.filter((i) => i.at > closedAt);
  }, [ready, snap.decisions, threads, closedAt]);

  const knownRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    const known = knownRef.current;
    knownRef.current = new Set(items.map((i) => i.key));
    if (known === null) return;
    for (const i of items) {
      if (i.kind === "approval" && !known.has(i.key)) bumpTabTitle(i.key, `${i.who} needs you`);
    }
  }, [ready, items]);
  useEffect(() => {
    knownRef.current = null;
  }, [tenantId]);

  const remaining = ready && closedAt === null ? needsYouRemaining(snap, items, NONE) : items.length;
  const top = items[0];
  if (!top && remaining <= 0) return null;
  const more = remaining - (top ? 1 : 0);

  const review = (item: NeedsYouItem) => {
    if (item.kind === "approval") {
      openStatic("needs-you", { decision: item.id });
      return;
    }
    const holder = tabShowingThread(item.threadId);
    if (holder) {
      setActiveTab(holder);
      return;
    }
    void openAgentTab(item.agentSlug, { threadId: item.threadId }).then((tabId) => {
      if (viewMode === "threaded") requestThreadPane(tabId, item.threadId);
    });
  };

  const openPendingHome = () => {
    const t = snap.totals;
    if (!t || t.needs_you > 0) openStatic("needs-you");
    else if (t.growth > 0) openStatic("autopilot");
    else openStatic("channels");
  };
  const next = items[1];
  const openMore = () => (next ? review(next) : openPendingHome());
  const closeAll = () => setClosedAt(items.reduce((max, i) => (i.at > max ? i.at : max), ""));

  if (!top) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="needs-you-line"
        className="flex shrink-0 items-center gap-2.5 border-b border-[#f0dca6] bg-[#fdf6e7] px-4 py-1.5 text-[13.5px] leading-5 text-ink"
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[#b7791f]" />
        <span className="min-w-0 flex-1 truncate font-semibold text-[#7a4f12]">
          {more} more {more === 1 ? "thing needs" : "things need"} you
        </span>
        <button
          type="button"
          onClick={openPendingHome}
          className="shrink-0 rounded-[8px] bg-ink px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-ink/85 compact:-my-3 compact:min-h-11 compact:min-w-11"
        >
          Review
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="needs-you-line"
      className="flex shrink-0 items-center gap-2.5 border-b border-[#f0dca6] bg-[#fdf6e7] px-4 py-1.5 text-[13.5px] leading-5 text-ink"
    >
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[#b7791f]" />
      <span className="min-w-0 flex-1 truncate font-semibold text-[#7a4f12] sm:max-w-[40%] sm:flex-initial" title={top.who}>
        {top.who} needs you
      </span>
      <span className="hidden min-w-0 flex-1 truncate text-inkSoft sm:block">{top.text}</span>
      {more > 0 && (
        <button
          type="button"
          onClick={openMore}
          title={next ? `Next: ${next.who}` : undefined}
          className="shrink-0 text-[12.5px] font-medium text-[#7a4f12] underline-offset-2 hover:underline compact:-my-3 compact:min-h-11 compact:px-1"
        >
          and {more} more
        </button>
      )}
      <button
        type="button"
        onClick={() => review(top)}
        className={cx(
          "shrink-0 rounded-[8px] bg-ink px-2.5 py-1 text-[12.5px] font-medium text-white compact:-my-3 compact:min-h-11 compact:min-w-11",
          "hover:bg-ink/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        )}
      >
        {top.kind === "question" ? "Answer" : "Review"}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={closeAll}
        className="inline-flex shrink-0 items-center justify-center rounded p-0.5 text-[#a19c92] hover:text-ink compact:-my-3 compact:-mr-3 compact:min-h-11 compact:min-w-11"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
