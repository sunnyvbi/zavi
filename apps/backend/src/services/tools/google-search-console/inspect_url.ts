
import { z } from "zod";
import { urlInspect } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  url: z.string().url(),
  language_code: z.string().min(2).max(10).default("en-US"),
});

export const gscInspectUrlTool: ToolSpec = {
  name: "google_search_console_inspect_url",
  effect: "read",
  description:
    "Ask Google what it knows about ONE URL in the connected property: is it indexed, what coverage state, which canonical GOOGLE chose vs the one the page declares, robots.txt verdict, last crawl time, crawl user-agent, the sitemaps referencing it, and which structured-data / rich-result types Google parsed (including JSON-LD injected client-side, which a static fetch cannot see). Use this instead of inferring indexation or schema presence from fetched HTML. Read-only; quota is 2,000 inspections/day per property, so inspect specific URLs, never a whole list.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { url, language_code } = inputSchema.parse(input);
    const { site_url, result } = await urlInspect(ctx.tenant_id, url, language_code);

    const idx = result.indexStatusResult ?? {};
    const rich = result.richResultsResult ?? {};

    const detected = (rich.detectedItems ?? []).map((d) => ({
      rich_result_type: d.richResultType ?? "",
      item_count: (d.items ?? []).length,
      issues: (d.items ?? []).flatMap((i) =>
        (i.issues ?? []).map((iss) => ({
          item: i.name ?? "",
          severity: iss.severity ?? "",
          message: iss.issueMessage ?? "",
        })),
      ),
    }));

    const googleCanonical = idx.googleCanonical ?? null;
    const userCanonical = idx.userCanonical ?? null;

    return {
      url,
      site_url,
      inspection_link: result.inspectionResultLink ?? null,
      index_status: {
        verdict: idx.verdict ?? null,
        coverage_state: idx.coverageState ?? null,
        indexing_state: idx.indexingState ?? null,
        robots_txt_state: idx.robotsTxtState ?? null,
        page_fetch_state: idx.pageFetchState ?? null,
        last_crawl_time: idx.lastCrawlTime ?? null,
        crawled_as: idx.crawledAs ?? null,
        google_canonical: googleCanonical,
        user_canonical: userCanonical,
        canonical_mismatch: Boolean(googleCanonical && userCanonical && googleCanonical !== userCanonical),
        referring_urls: idx.referringUrls ?? [],
        sitemaps: idx.sitemap ?? [],
      },
      rich_results: {
        verdict: rich.verdict ?? null,
        detected: detected,
        detected_types: detected.map((d) => d.rich_result_type).filter(Boolean),
      },
      mobile_usability: {
        verdict: result.mobileUsabilityResult?.verdict ?? null,
        issues: (result.mobileUsabilityResult?.issues ?? []).map((i) => ({
          issue_type: i.issueType ?? "",
          severity: i.severity ?? "",
          message: i.message ?? "",
        })),
      },
      caveat:
        "Reflects Google's index as of last_crawl_time, not the live page. Recent changes may not be represented yet.",
    };
  },
};
