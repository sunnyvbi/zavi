"use client";

import { useCallback, useRef, useState } from "react";

export type ThreadPaneComposerProps = {
  onSend?: (text: string) => void | Promise<void>;
  sending?: boolean;
  disabled?: boolean;
  agentSlug?: string;
};

export const THREAD_REPLY_PLACEHOLDER = "Reply…";

export function ThreadPaneComposer({
  onSend,
  sending = false,
  disabled = false,
  agentSlug,
}: ThreadPaneComposerProps) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const canSend = value.trim().length > 0 && !sending && !disabled;

  const fire = useCallback(() => {
    const text = value.trim();
    if (!text || sending || disabled) return;
    setValue("");
    void onSend?.(text);
    taRef.current?.focus();
  }, [disabled, onSend, sending, value]);

  return (
    <div
      className="w-full shrink-0 bg-white px-4 pb-4 pt-3"
      data-testid="thread-pane-composer"
    >
      {}
      <div className="flex w-full flex-col gap-2 rounded-[16px] border border-[#ebecef] bg-white pb-[7px] pl-[9px] pr-[7px] pt-[13px] shadow-[0_1px_1px_rgba(14,15,17,0.05)] transition-shadow duration-150 focus-within:border-ink/30 focus-within:shadow-[0_1px_3px_rgba(14,15,17,0.06),0_0_0_3px_rgba(25,25,25,0.10)] motion-reduce:transition-none">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              fire();
            }
          }}
          rows={1}
          disabled={disabled}
          placeholder={THREAD_REPLY_PLACEHOLDER}
          aria-label={
            agentSlug
              ? `Reply in this ${agentSlug} thread`
              : "Reply in this thread"
          }
          className="block w-full resize-none border-0 bg-transparent px-3 py-1 text-[16px] font-medium leading-[24px] tracking-[-0.3125px] text-[#0e0f11] placeholder:text-[#8c8c8c] focus:outline-none disabled:opacity-60"
        />
        {}
        <div className="flex w-full items-center justify-end">
          <button
            type="button"
            onClick={fire}
            disabled={!canSend}
            aria-label={sending ? "Sending reply" : "Send reply"}
            title="Send reply"
            className="inline-flex size-10 items-center justify-center rounded-full text-white transition-colors duration-150 disabled:cursor-default disabled:bg-[#d9d9d9] disabled:text-white enabled:bg-ink enabled:hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
          >
            {}
            <svg aria-hidden viewBox="0 0 20 20" className="size-[18px]" fill="currentColor">
              <path d="M2.4 2.6a.75.75 0 0 1 .82-.13l14 6.5a.75.75 0 0 1 0 1.36l-14 6.5a.75.75 0 0 1-1.04-.9L3.9 10 2.18 3.57a.75.75 0 0 1 .22-.97Zm2.9 8.15-1.1 4.1L14.9 10 4.2 5.15l1.1 4.1L11 10l-5.7.75Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
