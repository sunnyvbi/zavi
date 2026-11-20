import { ArrowDown, ArrowUp, Bookmark, Heart, MessageCircle, MoreHorizontal, Repeat2, Send, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { AdPreviewMedia } from "./AdPreviewMedia";
import type { AdPlacementPreviewProps } from "./AdPlacementPreview";
import { adCtaLabel } from "./adReviewModel";

export function AdSocialPreview({ creative, platformName, channelSlug, aiGenerated }: AdPlacementPreviewProps) {
  const site = creative.target_url ? new URL(creative.target_url).hostname : null;
  const advertiser = creative.advertiser || site;
  const linkedin = channelSlug === "linkedin_ads";
  const reddit = channelSlug === "reddit_ads";
  const x = channelSlug === "x_ads";
  const cta = adCtaLabel(creative.call_to_action);
  const caption = creative.body && <p className={cn("whitespace-pre-wrap break-words text-detail leading-snug text-inkSoft", reddit ? "mt-1" : "px-3 py-2", linkedin ? "line-clamp-4" : !x && "line-clamp-3")}>{creative.body}</p>;
  const heading = creative.title && <p className={cn("min-w-0 flex-1 font-semibold leading-snug text-inkSoft", reddit ? "text-base" : "text-sm", !linkedin && !reddit && !x ? "truncate" : "break-words")}>{creative.title}</p>;
  const button = cta && <span className={cn("shrink-0 px-2.5 py-1 text-detail font-semibold", linkedin ? "rounded-full border border-ink text-ink" : "rounded-md bg-ink text-cream")}>{cta}</span>;
  return <figure aria-label={`${platformName} ad preview`} className={cn("w-full max-w-ad-feed overflow-hidden rounded-xl border border-rule bg-cream text-inkSoft", reddit && "p-3")}>
    <figcaption className={cn("flex items-center gap-2", reddit ? "text-detail" : linkedin ? "px-3 pt-3" : "px-3 py-2.5")}>{advertiser && <span aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full bg-ink font-semibold text-cream", reddit ? "size-ad-avatar-small text-ad-avatar-small" : linkedin ? "size-9 text-ad-avatar-large" : "size-8 text-detail")}>{advertiser.charAt(0).toUpperCase()}</span>}<span className="min-w-0 flex-1 leading-tight">{advertiser && <span className={cn("break-words font-semibold", reddit ? "text-detail" : "block text-sm")}>{advertiser}</span>}{reddit && advertiser && " · "}<span className={cn("text-detail", !reddit && "block")}>{linkedin || reddit ? "Promoted" : "Sponsored"}</span></span>{!reddit && <MoreHorizontal className="size-4" aria-hidden />}</figcaption>
    {reddit && <div className="mt-2">{heading}</div>}
    {(linkedin || reddit || x) && caption}
    <div className={cn(reddit && "mt-2 overflow-hidden rounded-lg")}><AdPreviewMedia key={creative.video_url ?? creative.image_url ?? creative.image_path ?? creative.image_artifact_id ?? "text"} creative={creative} format="feed" aiGenerated={aiGenerated} imageShape={linkedin ? "linkedin" : reddit ? "reddit" : x ? "x" : undefined} /></div>
    {!reddit && (heading || button) && <div className="flex items-center gap-2 border-b border-rule bg-creamDeep px-3 py-2">{heading}{button}</div>}
    <div aria-hidden className={cn("flex items-center gap-3 text-inkSoft", reddit ? "mt-2" : "px-3 py-2.5", linkedin && "justify-around text-detail")}>{reddit ? <><ArrowUp className="size-4" /><ArrowDown className="size-4" /><MessageCircle className="size-4" /><span className="ml-auto">{button}</span></> : linkedin ? <><span className="flex items-center gap-1"><ThumbsUp className="size-4" />Like</span><span className="flex items-center gap-1"><MessageCircle className="size-4" />Comment</span><span className="flex items-center gap-1"><Repeat2 className="size-4" />Repost</span></> : <><Heart className="size-5" /><MessageCircle className="size-5" />{x ? <Repeat2 className="size-5" /> : <Send className="size-5" />}<Bookmark className="ml-auto size-5" /></>}</div>
    {!linkedin && !reddit && !x && caption}
    {creative.target_url && <a href={creative.target_url} target="_blank" rel="noopener noreferrer" className="mx-3 mb-3 block break-all text-detail text-inkMuted underline underline-offset-4">{site}</a>}
  </figure>;
}
