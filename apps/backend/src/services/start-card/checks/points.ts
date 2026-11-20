
import {
  START_CARD_POINTS_PER_CHECK,
  type StartCardAiEvidence,
  type StartCardDesignEvidence,
  type StartCardRenderResult,
  type StartCardSeoEvidence,
} from "@zavi/shared";

const MAX = START_CARD_POINTS_PER_CHECK;

export function googlePoints(position: number | null): number {
  if (position === null || !Number.isFinite(position) || position < 1) return 0;
  if (position <= 3) return 20;
  if (position <= 10) return 15;
  if (position <= 20) return 10;
  if (position <= 100) return 4;
  return 0;
}

export function aiPointsFromCounts(mentioned: number, answered: number): number | null {
  if (answered <= 0) return null;
  return Math.round((MAX * Math.min(mentioned, answered)) / answered);
}

export function aiPoints(ev: Pick<StartCardAiEvidence, "engines">): number | null {
  const answered = ev.engines.filter((e) => e.answered);
  return aiPointsFromCounts(answered.filter((e) => e.mentioned === true).length, answered.length);
}

export const SEO_TITLE_MIN = 10;
export const SEO_TITLE_MAX = 65;
export const SEO_META_MIN = 50;
export const SEO_META_MAX = 160;

export type SeoRubricInput = Pick<
  StartCardSeoEvidence,
  "title" | "meta_description" | "h1_count" | "schema_types" | "robots_allows_root" | "sitemap_found" | "broken_links"
>;

export function seoBreakdown(ev: SeoRubricInput) {
  const titleLen = ev.title?.trim().length ?? 0;
  const metaLen = ev.meta_description?.trim().length ?? 0;
  return {
    title: titleLen >= SEO_TITLE_MIN && titleLen <= SEO_TITLE_MAX ? 4 : 0,
    meta: metaLen >= SEO_META_MIN && metaLen <= SEO_META_MAX ? 4 : 0,
    h1: ev.h1_count === 1 ? 3 : 0,
    schema: ev.schema_types.length > 0 ? 3 : 0,
    crawl: ev.robots_allows_root !== false && ev.sitemap_found ? 3 : 0,
    links: ev.broken_links.length === 0 ? 3 : 0,
  };
}

export function seoPoints(ev: SeoRubricInput): number {
  const b = seoBreakdown(ev);
  return b.title + b.meta + b.h1 + b.schema + b.crawl + b.links;
}

export const BODY_TEXT_MIN_PX = 14;

export function pagespeedPart(ps: { performance: number; accessibility: number }): number {
  const perf = ps.performance >= 90 ? 6 : ps.performance >= 50 ? 3 : 0;
  const a11y = ps.accessibility >= 90 ? 4 : ps.accessibility >= 70 ? 2 : 0;
  return perf + a11y;
}

export function renderPart(r: StartCardRenderResult): number {
  return (
    (r.cta_above_fold ? 4 : 0) +
    (r.body_text_px !== null && r.body_text_px >= BODY_TEXT_MIN_PX ? 2 : 0) +
    (r.overlapping_boxes ? 0 : 2) +
    (r.horizontal_scroll ? 0 : 2)
  );
}

export function designPoints(ev: Pick<StartCardDesignEvidence, "pagespeed" | "render">): number | null {
  const ps = ev.pagespeed ? pagespeedPart(ev.pagespeed) : null;
  const rn = ev.render ? renderPart(ev.render) : null;
  if (ps !== null && rn !== null) return ps + rn;
  if (ps !== null) return ps * 2;
  if (rn !== null) return rn * 2;
  return null;
}

export function rivalDesignPoints(render: StartCardRenderResult | null): number | null {
  return render ? renderPart(render) * 2 : null;
}

export function comparePoints(rank: number, n: number): number {
  if (n < 2) return 0;
  return Math.round((MAX * (n - rank)) / (n - 1));
}

export function rankOf(total: number, all: readonly number[]): number {
  return 1 + all.filter((t) => t > total).length;
}
