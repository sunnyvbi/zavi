import { describe, it, expect, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: () => new Headers({ "x-forwarded-host": "www.zaviagent.com" }),
}));
vi.mock("@/lib/marketing/liveUpcar", () => ({ getLivePillSlug: async () => null, getLiveUpcar: async () => null }));

import sitemap from "@/app/sitemap";
import { footerGroups } from "@/components/marketing/growth-home/GrowthFooter";

const BASE = "https://www.zaviagent.com";
const START = "/start";

async function sitemapPaths(): Promise<string[]> {
  return (await sitemap()).map((e) => e.url.slice(BASE.length) || "/");
}

describe("sitemap.xml lists the affiliate program", () => {
  it("has exactly one /affiliates entry on the request host", async () => {
    const entries = (await sitemap()).filter((e) => e.url === `${BASE}/affiliates`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ changeFrequency: "monthly", priority: 0.6 });
    expect(entries[0]!.lastModified).toBeInstanceOf(Date);
  });

  it("lists every public page the footer links to", async () => {
    const paths = new Set(await sitemapPaths());
    const notInSitemap = new Set([START, "/login", "/growth", "/legal/subprocessors"]);
    const missing = footerGroups(START)
      .flatMap((g) => g.links.map((l) => l.href))
      .filter((href) => !notInSitemap.has(href) && !paths.has(href));
    expect(missing).toEqual([]);
  });
});
