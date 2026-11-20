import type { AdReviewCreative } from "@zavi/shared";
import { CopyText } from "../../card/blocks/CopyText";
import { MediaTile, WithMedia } from "../../card/blocks/MediaTile";
import { adCtaLabel } from "../../ads/adReviewModel";
import { useAdImagePreview } from "../../ads/useAdImagePreview";
import { useArtifactImagePreview } from "../../ads/useArtifactImagePreview";
import { InlineFacts, type Fact } from "./InlineFacts";

export function hasAdMedia(creative: AdReviewCreative | undefined): boolean {
  return !!(creative?.image_url || creative?.image_path || creative?.image_artifact_id || creative?.video_url || creative?.youtube_video_id);
}

function useMediaUrl(creative: AdReviewCreative) {
  const image = useAdImagePreview(creative.image_url ?? creative.image_path ?? null);
  const artifact = useArtifactImagePreview(creative.image_url || creative.image_path ? null : creative.image_artifact_id);
  if (creative.video_url) return { url: creative.video_url, video: true, loading: false };
  const still = image.src ?? artifact.src ?? (creative.youtube_video_id ? `https://i.ytimg.com/vi/${encodeURIComponent(creative.youtube_video_id)}/hqdefault.jpg` : null);
  return { url: still, video: false, loading: image.loading || artifact.loading };
}

export function AdCreative({ creative, facts }: { creative: AdReviewCreative; facts: Fact[] }) {
  const media = useMediaUrl(creative);
  const shown = hasAdMedia(creative);
  const headline = creative.title ?? creative.headlines?.[0] ?? null;
  const text = creative.body ?? creative.descriptions?.[0] ?? null;
  const cta = adCtaLabel(creative.call_to_action);
  const copy = (
    <div className="flex flex-col gap-2">
      {headline && !shown && <p className="text-ca-body font-semibold text-ca-xdark">{headline}</p>}
      {text && <CopyText text={text} />}
      {!headline && !text && !shown && <p className="text-ca-action text-ca-secondary">The source post’s content has not been supplied for preview.</p>}
      {cta && <span className="inline-flex h-8 w-fit items-center rounded-lg bg-ca-subtle px-3 text-ca-action font-semibold text-ca-xdark">{cta}</span>}
      <InlineFacts facts={facts} />
    </div>
  );
  if (!shown) return <div data-testid="ads-preview">{copy}</div>;
  const overlay = headline ? (
    <>
      <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/75" aria-hidden />
      <span className="absolute bottom-3 left-3 right-3 text-ca-facts font-bold leading-tight text-white">{headline}</span>
    </>
  ) : null;
  const tile = media.url
    ? <MediaTile url={media.url} alt={headline ?? ""} video={media.video} overlay={overlay} />
    : <span role="status" aria-label={media.loading ? "Loading ad image" : "Ad image not available"} className={`relative block aspect-ad-feed w-ca-media shrink-0 overflow-hidden rounded-lg bg-ca-subtle${media.loading ? " animate-pulse" : ""}`}>{!media.loading && overlay}</span>;
  return <div data-testid="ads-preview"><WithMedia media={tile}>{copy}</WithMedia></div>;
}
