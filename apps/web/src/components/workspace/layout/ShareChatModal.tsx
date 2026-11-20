"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useWorkspace } from "../WorkspaceShell";
import { cx, FOCUS_RING } from "./shared";

export function ShareChatModal({
  slug,
  threadId,
  anchor,
  onClose,
}: {
  slug: string;
  threadId: string;
  anchor: { top: number; right: number };
  onClose: () => void;
}) {
  const { userEmail } = useWorkspace();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyLink = () => {
    const url = `${window.location.origin}/workspace/${encodeURIComponent(threadId)}`;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fallback);
    } else {
      fallback();
    }
  };

  const owner = userEmail || "You";
  const initial = (owner[0] || "U").toUpperCase();

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share chat"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ top: anchor.top, right: anchor.right }}
        className="absolute w-[400px] max-w-[calc(100vw-32px)] rounded-3xl border border-rule bg-cream p-6 shadow-elev"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[20px] font-normal tracking-[-0.01em] text-ink">Share Chat</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={cx(
              "flex h-10 w-10 items-center justify-center rounded-full border border-rule text-inkLight transition-colors duration-150 hover:bg-bone hover:text-ink motion-reduce:transition-none",
              FOCUS_RING,
            )}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {}
        <p className="mt-5 text-[13px] leading-5 text-inkMuted">
          Only you can open this chat. Teammates in your workspace can&apos;t
          see it, so the link works when you&apos;re signed in.
        </p>

        <p className="mt-5 text-[13px] font-medium text-inkMuted">People with access</p>
        <div className="mt-2 flex items-center gap-3 rounded-2xl border border-rule px-3.5 py-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bone text-[12px] font-semibold text-ink">
            {initial}
          </span>
          <span className="min-w-0 flex-1 truncate text-[16px] text-ink">{owner}</span>
          <span className="shrink-0 text-[13px] text-inkMuted">Owner</span>
        </div>

        <button
          type="button"
          onClick={copyLink}
          className={cx(
            "mt-6 h-12 w-full rounded-full bg-ink text-[14px] font-medium text-cream transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none",
            FOCUS_RING,
          )}
        >
          {copied ? "Link Copied" : "Copy Link"}
        </button>
      </div>
    </div>
  );
}
