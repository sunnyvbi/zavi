"use client";

import { createPortal } from "react-dom";
import { MessageSquare, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { FeedbackPanel } from "../settings/FeedbackPanel";

export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  return createPortal(
    <Dialog id="send-feedback" label="Send feedback" onClose={onClose} className="workspace-shell !bg-transparent text-ink">
      <div
        className="flex h-full w-full items-center justify-center bg-black/40 p-4"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-y-auto rounded-2xl border border-rule bg-cream p-5 shadow-pop">
          <div className="mb-1 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-ink" aria-hidden />
            <h2 className="text-[16px] font-semibold text-ink">Send feedback</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-inkMuted hover:bg-creamDeep hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <p className="mb-4 text-[14px] text-inkMuted">
            It goes straight to the team. You can see where each request is below.
          </p>
          <FeedbackPanel source="menu" showRequests />
        </div>
      </div>
    </Dialog>,
    document.body,
  );
}
