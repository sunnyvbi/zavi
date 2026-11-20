import type { ReactNode } from "react";
import { ArrowUp, Bookmark, Heart, MessageCircle, Repeat2, Send, Share2, ThumbsUp } from "lucide-react";
import { getChannel } from "@zavi/shared";
import { formatDate } from "@/lib/formatDate";
import { cn } from "@/lib/cn";
import type { PlatformSpec } from "./types";

export function PostPreview({ channelSlug, account, proposedAt, media, children, edited, posted }: { channelSlug: string; account?: PlatformSpec["account"]; proposedAt: string; media?: ReactNode; children: ReactNode; edited: boolean; posted?: boolean }) {
  const name = getChannel(channelSlug)?.name ?? "Channel";
  const social = channelSlug.endsWith("_organic");
  const imageFirst = ["instagram_organic", "pinterest_organic", "tiktok_organic", "youtube_organic"].includes(channelSlug);
  const vertical = ["tiktok_organic", "youtube_organic"].includes(channelSlug);
  const LinkedIcon = channelSlug === "linkedin_organic" ? ThumbsUp : channelSlug === "reddit_organic" ? ArrowUp : Heart;
  const reactions = <div aria-hidden className="flex items-center gap-4 border-t border-rule p-4 text-inkSoft"><LinkedIcon className="size-5" /><MessageCircle className="size-5" />{channelSlug === "x_organic" || channelSlug === "linkedin_organic" ? <Repeat2 className="size-5" /> : channelSlug === "instagram_organic" ? <Send className="size-5" /> : <Share2 className="size-5" />}<Bookmark className="ml-auto size-5" /></div>;
  return <figure aria-label={`${name} post preview`} data-preview-channel={channelSlug} className={cn("w-full overflow-hidden rounded-xl border border-rule bg-cream", vertical && "max-w-ad-feed")}>
    <figcaption className="flex items-center gap-3 border-b border-rule p-4">
      {account && <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-sm font-semibold text-cream">{account.name.slice(0, 1)}</span>}
      <span className="min-w-0"><span className="block break-words text-sm font-semibold text-ink">{account?.name ?? `${name} draft`}</span><span className="block break-words text-xs text-inkMuted">{account?.handle && account.handle !== account.name && <>{account.handle} · </>}{formatDate(proposedAt, "en-US", "UTC", "short")}{!posted && " · Draft"}</span></span>
    </figcaption>
    {imageFirst && media && <div data-testid="post-preview-media">{media}</div>}
    {social && imageFirst && reactions}
    <div className="space-y-3 p-4">{children}</div>
    {!imageFirst && media && <div data-testid="post-preview-media" className="px-4 pb-4">{media}</div>}
    {social && !imageFirst && reactions}
    {edited && <p data-testid="edited-with-zavi" className="px-4 pb-4 text-xs font-medium text-inkMuted">Edited with Zavi</p>}
  </figure>;
}
