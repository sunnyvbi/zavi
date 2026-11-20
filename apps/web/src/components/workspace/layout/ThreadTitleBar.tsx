"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, MoreVertical, PenLine, Share, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { stripChannelMention } from "@/lib/workspace/channelMention";
import { useDismissableMenu } from "@/hooks/useDismissableMenu";
import { useWorkspace } from "../WorkspaceShell";
import { notifyThreadsChanged, useAgentThreads } from "../useAgentThreads";
import { ShareChatModal } from "./ShareChatModal";
import { cx, FOCUS_RING } from "./shared";

export function ThreadTitleBar({ slug, threadId }: { slug: string; threadId?: string | null }) {
  const { openAgentTab } = useWorkspace();
  const threads = useAgentThreads(slug, threadId);
  const current = threadId ? threads.find((t) => t.id === threadId) : undefined;
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [sharing, setSharing] = useState<{ top: number; right: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [localTitle, setLocalTitle] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { open, setOpen, close } = useDismissableMenu(rootRef, menuBtnRef);

  const title =
    threadId === null
      ? "New thread"
      : localTitle ??
        (stripChannelMention(current?.title?.trim() ?? null) ||
          (threadId ? "Untitled thread" : ""));

  useEffect(() => {
    setLocalTitle(null);
    setRenaming(false);
    setOpen(false);
    setSharing(null);
  }, [threadId, setOpen]);

  useEffect(() => {
    if (!open) return;
    const onAway = () => setOpen(false);
    window.addEventListener("resize", onAway);
    window.addEventListener("scroll", onAway, true);
    return () => {
      window.removeEventListener("resize", onAway);
      window.removeEventListener("scroll", onAway, true);
    };
  }, [open, setOpen]);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const toggleMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) {
      close();
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    setOpen(true);
  };

  const startRename = () => {
    close(false);
    setDraft(title);
    setRenaming(true);
  };

  const commitRename = () => {
    setRenaming(false);
    const next = draft.trim();
    if (!threadId || !next || next === title) return;
    setLocalTitle(next);
    void apiFetch(`/api/agents/${encodeURIComponent(slug)}/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    })
      .then((res) => {
        if (!res.ok) setLocalTitle(null);
        notifyThreadsChanged();
      })
      .catch(() => setLocalTitle(null));
  };

  const deleteThread = () => {
    close();
    if (!threadId) return;
    void apiFetch(`/api/agents/${encodeURIComponent(slug)}/threads/${threadId}`, {
      method: "DELETE",
    })
      .then(() => notifyThreadsChanged())
      .catch(() => {});
    void openAgentTab(slug, { newThread: true });
  };

  const menuItem =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors duration-100 hover:bg-creamDeep motion-reduce:transition-none " +
    FOCUS_RING;

  return (
    <div ref={rootRef} className="flex h-12 items-center gap-2 px-4">
      <MessageSquare className="h-4 w-4 shrink-0 text-inkLight" aria-hidden />
      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          maxLength={120}
          aria-label="Thread title"
          className={cx(
            "min-w-0 flex-1 rounded-lg bg-creamDeep px-2 py-1 text-[14px] font-normal leading-5 tracking-[-0.01em] text-ink outline-none",
            FOCUS_RING,
          )}
        />
      ) : (
        <h1
          className="min-w-0 flex-1 truncate text-[14px] font-normal leading-5 tracking-[-0.01em] text-ink"
          title={title}
        >
          {title}
        </h1>
      )}
      {threadId && !renaming && (
        <>
          <button
            type="button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSharing({ top: r.bottom + 8, right: window.innerWidth - r.right });
            }}
            className={cx(
              "flex h-8 shrink-0 items-center gap-2 rounded-full border border-rule px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-bone motion-reduce:transition-none",
              FOCUS_RING,
            )}
          >
            <Share className="h-3.5 w-3.5" aria-hidden />
            Share
          </button>
          <button
            ref={menuBtnRef}
            type="button"
            aria-label="Thread options"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggleMenu}
            className={cx(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-inkLight transition-colors duration-150 hover:bg-bone hover:text-ink motion-reduce:transition-none",
              open && "bg-bone text-ink",
              FOCUS_RING,
            )}
          >
            <MoreVertical className="h-4 w-4" aria-hidden />
          </button>
        </>
      )}
      {open && menuPos && (
        <div
          role="menu"
          aria-label="Thread options"
          style={{ top: menuPos.top, right: menuPos.right }}
          className="fixed z-50 w-44 rounded-xl border border-rule bg-cream p-1.5 shadow-elev"
        >
          <button type="button" role="menuitem" onClick={startRename} className={cx(menuItem, "text-ink")}>
            <PenLine className="h-4 w-4 text-inkLight" aria-hidden />
            Rename
          </button>
          <button type="button" role="menuitem" onClick={deleteThread} className={cx(menuItem, "text-danger")}>
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete
          </button>
        </div>
      )}
      {sharing && threadId && (
        <ShareChatModal slug={slug} threadId={threadId} anchor={sharing} onClose={() => setSharing(null)} />
      )}
    </div>
  );
}
