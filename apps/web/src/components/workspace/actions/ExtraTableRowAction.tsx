"use client";

import { useState } from "react";
import { toast } from "@/components/ui/toast";
import { useChannelChatOpener } from "./channelChat";
import { ROW_ACTION, ROW_ACTION_PRIMARY } from "./extraTableStyles";
import type { ExtraRowAction } from "./extraTableTypes";

export function RowAction({ action }: { action: ExtraRowAction }) {
  if (action.chatDraft !== undefined) return <ChatDraftAction action={action} draft={action.chatDraft} />;
  return <CallbackAction action={action} />;
}

function ChatDraftAction({ action, draft }: { action: ExtraRowAction; draft: string }) {
  const openChat = useChannelChatOpener();
  if (!openChat) return null;
  return (
    <button
      type="button"
      title={action.title}
      aria-label={action.title}
      onClick={() => openChat({ target: "channel", draft: { text: draft, nonce: Date.now() } })}
      className={ROW_ACTION_PRIMARY}
    >
      {action.label}
    </button>
  );
}

function CallbackAction({ action }: { action: ExtraRowAction }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  if (action.href) {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noopener noreferrer"
        title={action.title}
        aria-label={action.title}
        className={ROW_ACTION}
      >
        {action.label}
      </a>
    );
  }
  const label = busy
    ? (action.busyLabel ?? action.label)
    : error
      ? (action.retryLabel ?? action.label)
      : action.label;
  return (
    <span className="inline-flex min-w-0 flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        title={action.title}
        aria-label={action.title}
        onClick={() => {
          setError(false);
          setSaid(null);
          const r = action.onClick?.();
          if (!(r instanceof Promise)) return;
          setBusy(true);
          void r.then(
            (value: unknown) => {
              setBusy(false);
              const note = typeof value === "string" && value.trim() ? value : null;
              if (note && action.toast) toast.add({ type: "success", title: note });
              else setSaid(note);
            },
            (e: unknown) => {
              setBusy(false);
              setError(true);
              toast.add({
                type: "error",
                title: e instanceof Error && e.message ? e.message : "Couldn't do that. Try again in a moment.",
              });
            },
          );
        }}
        className={ROW_ACTION}
      >
        {label}
      </button>
      {said && !error && (
        <span
          role="status"
          className="max-w-table-hint whitespace-normal text-right text-detail font-normal text-inkMuted"
        >
          {said}
        </span>
      )}
    </span>
  );
}

