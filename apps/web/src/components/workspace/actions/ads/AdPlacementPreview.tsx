import type { AdReviewCreative } from "@zavi/shared";
import { cn } from "@/lib/cn";
import { AdPreviewMedia } from "./AdPreviewMedia";
import { AdSocialPreview } from "./AdSocialPreview";
import { adCtaLabel, type AdPreviewFormat } from "./adReviewModel";
import { draftAdFields, type DraftAdFields } from "./draftAdFields";

export interface AdPlacementPreviewProps {
  creative: AdReviewCreative;
  format: AdPreviewFormat;
  platformName: string;
  channelSlug: string;
  draftOnly: boolean;
  aiGenerated?: boolean;
}

export function AdPlacementPreview(props: AdPlacementPreviewProps) {
  const { creative, format, platformName, channelSlug, draftOnly, aiGenerated } = props;
  const hasCreative = !!creative.title || !!creative.body || !!creative.media_kind || !!creative.image_url || !!creative.image_path || !!creative.video_url || !!creative.youtube_video_id;
  if (format === "feed" && !draftOnly && hasCreative) return <AdSocialPreview {...props} />;
  const site = creative.target_url ? new URL(creative.target_url).hostname : null;
  const advertiser = creative.advertiser || site;
  const cta = adCtaLabel(creative.call_to_action);
  const draft = draftOnly ? draftAdFields(creative.body) : null;
  if (draft) return <DraftAdCard fields={draft} advertiser={advertiser} platformName={platformName} />;
  const search = format === "search" && !draftOnly;
  const livePost = channelSlug === "linkedin_ads" && !!creative.source && !!creative.target_url;
  return (
    <figure aria-label={`${platformName} ad preview`} className={cn("w-full overflow-hidden rounded-xl border border-rule bg-cream text-inkSoft", format === "vertical" ? "max-w-ad-feed" : "max-w-full")}>
      {search && <figcaption className="px-4 pt-4 text-sm"><span className="font-semibold">Sponsored</span>{site && <span className="ml-2 break-all">{site}</span>}</figcaption>}
      <AdPreviewMedia key={creative.video_url ?? creative.image_url ?? creative.image_path ?? creative.image_artifact_id ?? creative.youtube_video_id ?? "text"} creative={creative} format={format} aiGenerated={aiGenerated} />
      {!search && advertiser && <figcaption className="px-4 pt-4 text-sm font-semibold">{advertiser}<span className="ml-2 text-detail font-normal text-inkMuted">Sponsored</span></figcaption>}
      {creative.title && <p className={cn("break-words px-4 pt-3 font-semibold", search ? "text-lg text-brand" : "text-ad-body")}>{creative.title}</p>}
      <div className="space-y-3 p-4">
        {creative.body && <p className="whitespace-pre-wrap break-words text-detail leading-relaxed">{creative.body}</p>}
        {!hasCreative && (livePost ? <p className="py-3 text-sm text-inkMuted">This ad runs your company post as it appears on LinkedIn.</p> : <p className="py-3 text-sm text-inkMuted">The source post’s content has not been supplied for preview.</p>)}
        {creative.target_url && <a href={creative.target_url} target="_blank" rel="noopener noreferrer" className={cn("block break-all text-sm underline underline-offset-4", cta && "rounded-lg bg-ink px-3 py-2.5 text-center font-semibold text-cream no-underline")}>{cta || site}</a>}
      </div>
    </figure>
  );
}

function DraftAdCard({ fields, advertiser, platformName }: { fields: DraftAdFields; advertiser: string | null | undefined; platformName: string }) {
  return (
    <figure aria-label={`${platformName} ad preview`} data-testid="draft-ad-card" className="w-full max-w-full overflow-hidden rounded-xl border border-rule bg-cream text-inkSoft">
      <figcaption className="flex items-center gap-2 px-4 pt-4 text-sm">
        <span className="font-semibold text-ink">{advertiser || "Your company"}</span>
        <span className="text-detail text-inkMuted">Sponsored</span>
      </figcaption>
      {fields.intro && <p className="whitespace-pre-wrap break-words px-4 pt-3 text-detail leading-relaxed text-ink">{fields.intro}</p>}
      {(fields.headline || fields.description || fields.cta) && (
        <div className="mt-4 flex items-center gap-3 border-t border-rule bg-creamDeep px-4 py-3">
          <div className="min-w-0 flex-1">
            {fields.headline && <p className="break-words text-sm font-semibold leading-5 text-ink">{fields.headline}</p>}
            {fields.description && <p className="mt-0.5 break-words text-detail leading-5 text-inkMuted">{fields.description}</p>}
          </div>
          {fields.cta && <span className="shrink-0 rounded-full border border-ink px-3 py-1 text-detail font-semibold text-ink">{fields.cta}</span>}
        </div>
      )}
    </figure>
  );
}
