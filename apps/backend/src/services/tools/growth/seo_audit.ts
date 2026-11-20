
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { MAX_PAGES } from "./seo/fetch";
import { cacheSiteAuditRun, cacheSeoAuditFailure } from "./seo/snapshot";
import { runSiteAudit, seoShapeOf, type SeoAuditRunResult } from "./seo/run";
import { ExpectedToolError } from "@/services/tools/types";

const inputSchema = z.object({
  paths: z.array(z.string().startsWith("/").max(200)).max(MAX_PAGES).optional(),
});

export type SeoAuditToolResult = SeoAuditRunResult;

export const seoAuditTool: ToolSpec = {
  name: "growth_seo_audit",
  effect: "read",
  description:
    "Audit the operator's own website for technical and on-page SEO problems: indexability " +
    "(robots.txt, noindex), titles and meta descriptions, duplicate titles, H1s, whether the " +
    "HTML carries readable content, sitemap presence, and Schema.org structured data. " +
    `Reads up to ${MAX_PAGES} pages: the homepage, pages the site links to or lists in llms.txt ` +
    "but leaves out of its sitemap, then a spread of sitemap pages. `site_graph.findings` labels " +
    "each URL the crawl proved something about (orphan, sitemap_unreachable, redirects_to_login, " +
    "schema_without_visible_content, missing_canonical, llms_txt_missing_page, could_not_read); " +
    "`site_graph.skipped` names checks that could not run. " +
    "Read-only, no connector required — it reads their PUBLIC site. Returns findings ranked " +
    "blocker/high/medium/low (low = a notice) plus per-page facts you can quote. It CANNOT see traffic, rankings, " +
    "impressions, clicks or CTR; use google_search_console__query for those, and never estimate them.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { paths } = inputSchema.parse(input ?? {});

    let full: Awaited<ReturnType<typeof runSiteAudit>>;
    try {
      full = await runSiteAudit(ctx.tenant_id, paths);
    } catch (e) {
      if (e instanceof ExpectedToolError && !ctx.writes_suppressed) {
        await cacheSeoAuditFailure(
          ctx.tenant_id,
          e.code,
          null,
          e.code === "seo_site_unreachable" ? e.message : null,
        );
      }
      throw e;
    }

    const report: SeoAuditRunResult = seoShapeOf(full);

    if ((!paths || paths.length === 0) && !ctx.writes_suppressed) {
      await cacheSiteAuditRun(ctx.tenant_id, full);
    }

    ctx.log("seo_audit completed", {
      pages: report.pages_analyzed,
      findings: report.findings.length,
    });

    return report satisfies SeoAuditToolResult;
  },
};
