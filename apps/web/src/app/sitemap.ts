import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { WWW_ORIGIN, isRetiredSegmentHost } from "@/lib/marketing/retiredSubdomains";
import { isUnknownSiteHost } from "@/lib/siteHosts";
import { USE_CASES, USE_CASES_PATH, pathForUseCase } from "@/lib/marketing/useCases";
import { TOOLS_PATH } from "@/lib/workspace/starters";
import { CREATOR_MARKETPLACE_ENABLED } from "@zavi/shared";
import { CHANNEL_PAGES, CHANNELS_PATH } from "@/components/marketing/growth-home/channels/channelPages";
import { COMPARISONS, pathForComparison } from "@/lib/marketing/comparisons";
import { BLOG_PATH, BLOG_POSTS, pathForPost } from "@/lib/marketing/blog";
import { getLivePillSlug, getLiveUpcar } from "@/lib/marketing/liveUpcar";
import { publishedDayNumbers, dayDates } from "@/app/live/[slug]/_components/publishedDay";
import { dayPath } from "@/app/live/[slug]/_components/dayCopy";

const FALLBACK_BASE =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
  "https://www.zaviagent.com";

export const dynamic = "force-dynamic";

const SITE_LAST_UPDATED = new Date("2026-10-11T00:00:00Z");

async function hostAndBase(): Promise<{ base: string; unknownSite: boolean }> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "")
    .split(",")[0]
    ?.trim()
    ?.toLowerCase() ?? "";
  if (!host) return { base: FALLBACK_BASE, unknownSite: false };
  if (isUnknownSiteHost(host)) return { base: WWW_ORIGIN, unknownSite: true };
  if (isRetiredSegmentHost(host)) return { base: WWW_ORIGIN, unknownSite: false };
  return { base: `https://${host}`, unknownSite: false };
}

const LIVE_DAYS_DEADLINE_MS = 3_000;
const LIVE_RUN_MIN_MS = 200;
async function liveDayUrls(base: string): Promise<MetadataRoute.Sitemap> {
  const started = Date.now();
  const work = (async () => {
    const slug = await getLivePillSlug({ evenIfEnded: true });
    if (!slug) return [];
    const left = LIVE_DAYS_DEADLINE_MS - (Date.now() - started) - 100;
    if (left < LIVE_RUN_MIN_MS) return [];
    const run = await getLiveUpcar(slug, false, left);
    if (!run || run === "not_found" || !run.run.listed) return [];
    return publishedDayNumbers(run).map(({ n, entry }) => ({
      url: `${base}${dayPath(slug, n)}`,
      lastModified: new Date(dayDates(entry).modified),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }));
  })().catch(() => [] as MetadataRoute.Sitemap);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MetadataRoute.Sitemap>((resolve) => {
    timer = setTimeout(() => resolve([]), LIVE_DAYS_DEADLINE_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { base, unknownSite } = await hostAndBase();
  if (unknownSite) return [];
  const liveDays = await liveDayUrls(base);
  const now = SITE_LAST_UPDATED;

  return [
    { url: `${base}/`,         lastModified: now, changeFrequency: "weekly",  priority: 1.0 },
    { url: `${base}/about`,    lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/support`,  lastModified: now, changeFrequency: "yearly",  priority: 0.3 },
    { url: `${base}/pricing`,  lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/tutorials`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    ...(CREATOR_MARKETPLACE_ENABLED
      ? [
          { url: `${base}/creators`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.7 },
          { url: `${base}/affiliates`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.6 },
        ]
      : []),
    { url: `${base}/live/upcar`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/careers`,  lastModified: now, changeFrequency: "weekly",  priority: 0.6 },
    { url: `${base}/security`, lastModified: now, changeFrequency: "monthly", priority: 0.4 },
    { url: `${base}/docs/ai-clients`, lastModified: now, changeFrequency: "monthly", priority: 0.4 },
    { url: `${base}/terms`,    lastModified: now, changeFrequency: "yearly",  priority: 0.3 },
    { url: `${base}/privacy`,  lastModified: now, changeFrequency: "yearly",  priority: 0.3 },
    { url: `${base}/cookie-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}${USE_CASES_PATH}`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    ...USE_CASES.map((u) => ({
      url: `${base}${pathForUseCase(u.slug)}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...COMPARISONS.map((c) => ({
      url: `${base}${pathForComparison(c.slug)}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    { url: `${base}${TOOLS_PATH}`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/launch-video`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}${CHANNELS_PATH}`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    ...CHANNEL_PAGES.map((c) => ({
      url: `${base}/channels/${c.id}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...(BLOG_POSTS.length
      ? [{ url: `${base}${BLOG_PATH}`, lastModified: new Date(`${BLOG_POSTS.map((p) => p.dateModified).sort().at(-1)}T12:00:00Z`), changeFrequency: "weekly" as const, priority: 0.7 }]
      : []),
    ...BLOG_POSTS.map((p) => ({
      url: `${base}${pathForPost(p.slug)}`,
      lastModified: new Date(`${p.dateModified}T12:00:00Z`),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...liveDays,
  ];
}
