"use client";

import { ExternalLink, Reply as ReplyIcon } from "lucide-react";
import { PostCard } from "../PostCard";
import type { ActionBodyProps } from "../types";

export function Reply(props: ActionBodyProps) {
  const to = props.action.body?.reply_to;
  const url = typeof to?.url === "string" && /^https?:\/\//i.test(to.url) ? to.url : null;
  const above =
    to && (to.text || to.author) ? (
      <div data-testid="reply-to" className="border-l-2 border-rule pl-3 text-[14px] text-inkSoft">
        {to.author && <p className="font-medium text-ink">{to.author}</p>}
        {to.text && <p className="line-clamp-3 whitespace-pre-wrap">{to.text}</p>}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-inkMuted underline-offset-2 hover:underline">
            Open the original
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>
    ) : null;
  return <PostCard {...props} icon={ReplyIcon} above={above} />;
}
