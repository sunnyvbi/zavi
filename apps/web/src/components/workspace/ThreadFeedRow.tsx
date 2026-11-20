"use client";

import { AgentAvatar } from "./AgentAvatar";
import { AuthorAvatar } from "./AuthorAvatar";
import { fullTimestamp } from "@/lib/workspace/dayLabels";
import { relativeTime } from "@/lib/workspace/relativeTime";
import {
  feedRowBody,
  feedRowTimestamp,
  isThreadInFlight,
  threadLineLabel,
  type ThreadFeedItem,
} from "@/lib/workspace/threadFeedTypes";

export type ThreadFeedRowProps = {
  thread: ThreadFeedItem;
  agentSlug: string;
  agentName: string;
  authorLabel?: string;
  onOpen: (threadId: string) => void;
};

export function ThreadFeedRow({
  thread,
  agentSlug,
  agentName,
  authorLabel = "You",
  onOpen,
}: ThreadFeedRowProps) {
  const iso = feedRowTimestamp(thread);
  const inFlight = isThreadInFlight(thread);
  const body = feedRowBody(thread);
  const replies = thread.reply_count;
  const replyText = replies === 1 ? "1 reply" : `${replies} replies`;

  return (
    <li className="list-none">
      {}
      <article className="group flex gap-2 rounded-xl p-3 transition-colors hover:bg-[#f9f9f9] motion-reduce:transition-none">
        {}
        <span className="flex size-10 shrink-0 items-center justify-center">
          <AuthorAvatar label={authorLabel} size="ml" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[14px] font-semibold leading-[19.5px] tracking-[-0.0762px] text-ink">
              {authorLabel}
            </span>
            {iso && (
              <time
                dateTime={iso}
                title={fullTimestamp(iso)}
                className="text-[12px] leading-[17.25px] tracking-[0.0337px] text-inkMuted"
              >
                {relativeTime(iso)}
              </time>
            )}
          </div>

          {}
          <p className="mt-1 max-w-[78ch] truncate text-[14px] leading-6 tracking-[-0.1121px] text-ink">
            {body}
          </p>

          {(replies > 0 || inFlight) && (
            <button
              type="button"
              onClick={() => onOpen(thread.id)}
              aria-label={threadLineLabel(thread, agentName)}
              className="mt-1.5 flex w-full max-w-[567px] items-center gap-2 rounded-cta border border-transparent px-1 py-1 transition-[background-color,border-color,box-shadow] duration-150 group-hover:border-[#f0f0f0] group-hover:bg-white group-hover:shadow-[0px_1px_2px_rgba(14,15,17,0.05)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink motion-reduce:transition-none"
            >
              {}
              <span aria-hidden className="flex -space-x-1.5">
                <AgentAvatar slug={agentSlug} size="sm" />
              </span>

              {inFlight ? (
                <span
                  aria-live="polite"
                  className="text-[13px] font-medium leading-[18px] text-[#8a5a10]"
                >
                  {agentName} is working…
                </span>
              ) : (
                <>
                  {}
                  <span className="text-[13px] font-medium leading-[18px] tracking-[0.13px] text-[#027bff]">
                    {replyText}
                  </span>
                  {}
                  {thread.last_message_at && (
                    <span className="text-[13px] leading-5 tracking-[0.01px] text-inkMuted">
                      Last reply {relativeTime(thread.last_message_at)}
                    </span>
                  )}
                </>
              )}
            </button>
          )}
        </div>
      </article>
    </li>
  );
}
