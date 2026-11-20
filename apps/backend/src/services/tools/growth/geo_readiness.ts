
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { getGeoReadiness, type GeoReadiness } from "./seo/snapshot";

const MAX_PAGES_OUT = 24;
export const GEO_READINESS_MAX_AGE_MS = 60_000;

const inputSchema = z.object({});

export function slimReadiness(r: GeoReadiness | null) {
  if (!r) {
    return {
      checked: false as const,
      status: "error" as const,
      error_code: "geo_readiness_unavailable",
      site: null,
      note: "The audit could not be read or run. Nothing was checked: report that, not a finding about the site.",
    };
  }
  return {
    checked: true as const,
    status: r.status,
    error_code: r.error_code,
    site: r.site,
    fetched_at: r.fetched_at,
    stale: r.stale,
    notes: r.notes,
    pages_analyzed: r.pages_analyzed,
    completeness: {
      planned: r.completeness.planned,
      returned: r.completeness.returned,
      warning: r.completeness.warning,
    },
    robots_read: r.crawlers.some((c) => c.state !== "unknown"),
    crawlers: r.crawlers.map((c) => ({
      name: c.name,
      owner: c.owner,
      class: c.class,
      governs_citation: c.recommended,
      obeys_robots: c.obeys_robots,
      state: c.state,
      directive: c.directive,
      from_wildcard: c.from_wildcard,
      ...(c.disallowed_paths?.length ? { disallowed_paths: c.disallowed_paths } : {}),
      ...(c.public_blocked ? { public_blocked: c.public_blocked } : {}),
      ...(c.caveat ? { caveat: c.caveat } : {}),
    })),
    llms_txt: r.llms_txt,
    findings: r.findings,
    pages: r.pages.slice(0, MAX_PAGES_OUT).map((p) => ({
      url: p.url,
      server_rendered: p.server_rendered,
      visible_words: p.visible_words,
      schema_types: p.schema_types,
      truncated: p.truncated,
    })),
    not_checked: r.not_checked,
  };
}

export type GeoReadinessToolResult = ReturnType<typeof slimReadiness>;

export const geoReadinessTool: ToolSpec = {
  name: "growth_geo_readiness",
  effect: "read",
  description:
    "Read what the site audit found about AI crawlers and AI-readable markup on the company's own public site: " +
    "for each named AI bot (training, search and user-triggered), whether robots.txt allows or blocks it, with the " +
    "directive quoted; whether /llms.txt exists; the AI-readiness findings; and per fetched page whether it is " +
    "server-rendered and which Schema.org types it carries in the raw HTML. `robots_read: false` or a crawler " +
    "`state: unknown` means robots.txt could not be read, never that crawling is allowed. `checked: false` or " +
    "`status: error` means nothing was checked. Describes only the pages listed in `pages`. Read-only, no connector required. It is NOT a " +
    "measure of how often AI answers cite the company; use growth_geo_visibility for sampled rates.",
  input_schema: inputSchema,
  async execute(ctx) {
    const readiness = await getGeoReadiness(ctx.tenant_id, {
      maxAgeMs: GEO_READINESS_MAX_AGE_MS,
      persist: !ctx.writes_suppressed,
    });
    const out = slimReadiness(readiness);
    ctx.log("geo_readiness read", { status: out.status });
    return out satisfies GeoReadinessToolResult;
  },
};
