
import { z } from "zod";
import { listSitemaps } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

function num(v: string | number | undefined): number {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : 0;
}

export const gscListSitemapsTool: ToolSpec = {
  name: "google_search_console_list_sitemaps",
  effect: "read",
  description:
    "List the sitemaps submitted for the connected Search Console property with Google's own status for each: last submitted, last downloaded, pending state, sitemap-index flag, per-content-type submitted URL counts, and the error/warning counts Google hit while parsing. Use this to check sitemap health rather than inferring it from fetching /sitemap.xml, which cannot show submission or parse status. Read-only.",
  input_schema: inputSchema,
  async execute(ctx) {
    const { site_url, sitemaps } = await listSitemaps(ctx.tenant_id);

    const mapped = sitemaps.map((s) => ({
      path: s.path ?? "",
      type: s.type ?? null,
      is_sitemaps_index: Boolean(s.isSitemapsIndex),
      is_pending: Boolean(s.isPending),
      last_submitted: s.lastSubmitted ?? null,
      last_downloaded: s.lastDownloaded ?? null,
      errors: num(s.errors),
      warnings: num(s.warnings),
      contents: (s.contents ?? []).map((c) => ({ type: c.type ?? "", submitted: num(c.submitted) })),
    }));

    return {
      site_url,
      sitemap_count: mapped.length,
      none_submitted: mapped.length === 0,
      total_errors: mapped.reduce((s, m) => s + m.errors, 0),
      total_warnings: mapped.reduce((s, m) => s + m.warnings, 0),
      sitemaps: mapped,
      caveat:
        "Submitted-URL counts are Google's parse of the sitemap file, not an indexation count. Indexed-URL counts are not available from this API.",
    };
  },
};
