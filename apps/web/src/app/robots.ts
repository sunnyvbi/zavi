import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { WWW_ORIGIN, isRetiredSegmentHost } from "@/lib/marketing/retiredSubdomains";
import { isUnknownSiteHost } from "@/lib/siteHosts";

const FALLBACK_BASE =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
  "https://www.zaviagent.com";

export const dynamic = "force-dynamic";

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

export default async function robots(): Promise<MetadataRoute.Robots> {
  const { base, unknownSite } = await hostAndBase();
  if (unknownSite) return { rules: [{ userAgent: "*", disallow: "/" }] };

  const rules: MetadataRoute.Robots["rules"] = [
    {
      userAgent: "*",
      allow: [
        "/",
        "/about",
        "/support",
        "/careers",
        "/pricing",
        "/security",
        "/docs/ai-clients",
        "/live/upcar",
        "/tools",
        "/use-cases",
        "/channels",
        "/channels/",
        "/compare/",
        "/blog",
        "/launch-video",
        "/llms.txt",
      ],
      disallow: [
        "/live/*/review/",
        "/mascot-preview",
        "/agents",
        "/approvals",
        "/applications",
        "/artifacts",
        "/connectors",
        "/memory",
        "/roles",
        "/staff",
        "/loginas",
        "/c/",
        "/auth/",
        "/login",
      ],
    },
  ];

  return {
    rules,
    sitemap: `${base}/sitemap.xml`,
  };
}
