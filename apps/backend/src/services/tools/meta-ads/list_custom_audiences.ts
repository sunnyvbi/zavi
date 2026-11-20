
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { fbGet, metaAdsCreds } from "./_client";

const inputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(100)
    .describe("Max audiences to return (Meta page size). Default 100."),
  include_usage: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Also fetch ad-set targeting to report which ad sets target each audience. Default true.",
    ),
});

type MetaStatus = { code?: number; description?: string };

type AudienceRow = {
  id?: string;
  name?: string;
  subtype?: string;
  description?: string;
  approximate_count_lower_bound?: number;
  approximate_count_upper_bound?: number;
  delivery_status?: MetaStatus;
  operation_status?: MetaStatus;
  time_created?: string;
  time_updated?: string;
  retention_days?: number;
};

type AdSetTargetingRow = {
  id?: string;
  name?: string;
  effective_status?: string;
  targeting?: {
    custom_audiences?: Array<{ id?: string; name?: string }>;
    excluded_custom_audiences?: Array<{ id?: string; name?: string }>;
  };
};

export type AudienceUsage = {
  adset_id: string;
  adset_name: string;
  effective_status: string | null;
  mode: "included" | "excluded";
};

const AUDIENCE_FIELDS = [
  "id",
  "name",
  "subtype",
  "description",
  "approximate_count_lower_bound",
  "approximate_count_upper_bound",
  "delivery_status",
  "operation_status",
  "time_created",
  "time_updated",
  "retention_days",
].join(",");

const ADSET_TARGETING_FIELDS =
  "id,name,effective_status,targeting{custom_audiences,excluded_custom_audiences}";

export function normalizeCount(n: number | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return n;
}

export function daysSince(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  return days < 0 ? 0 : days;
}

export function buildUsageIndex(
  adsets: readonly AdSetTargetingRow[],
): Map<string, AudienceUsage[]> {
  const index = new Map<string, AudienceUsage[]>();
  const add = (audId: string | undefined, row: AdSetTargetingRow, mode: AudienceUsage["mode"]) => {
    if (!audId) return;
    const list = index.get(audId) ?? [];
    list.push({
      adset_id: row.id ?? "",
      adset_name: row.name ?? "(unnamed)",
      effective_status: row.effective_status ?? null,
      mode,
    });
    index.set(audId, list);
  };
  for (const row of adsets) {
    for (const a of row.targeting?.custom_audiences ?? []) add(a.id, row, "included");
    for (const a of row.targeting?.excluded_custom_audiences ?? []) add(a.id, row, "excluded");
  }
  return index;
}

export function mapAudience(
  r: AudienceRow,
  usage: AudienceUsage[] | null,
  now: Date,
): Record<string, unknown> {
  const lower = normalizeCount(r.approximate_count_lower_bound);
  const upper = normalizeCount(r.approximate_count_upper_bound);
  const included = usage?.filter((u) => u.mode === "included") ?? null;
  return {
    id: r.id ?? "",
    name: r.name ?? "(unnamed)",
    subtype: r.subtype ?? null,
    description: r.description ?? null,
    approximate_size_lower_bound: lower,
    approximate_size_upper_bound: upper,
    size_available: lower !== null || upper !== null,
    delivery_status_code: r.delivery_status?.code ?? null,
    delivery_status: r.delivery_status?.description ?? null,
    operation_status_code: r.operation_status?.code ?? null,
    operation_status: r.operation_status?.description ?? null,
    retention_days: r.retention_days ?? null,
    time_created: r.time_created ?? null,
    time_updated: r.time_updated ?? null,
    days_since_updated: daysSince(r.time_updated, now),
    in_use: included === null ? null : included.length > 0,
    used_by_ad_sets: usage,
  };
}

export const metaListCustomAudiencesTool: ToolSpec = {
  name: "meta_ads_list_custom_audiences",
  effect: "read",
  description:
    "List the SAVED AUDIENCES on the operator's Meta ad account (custom audiences, lookalikes, website/engagement audiences) with size bounds, subtype, freshness, Meta's own delivery verdict, AND which ad sets currently target or exclude each one. Use it to find already-built audiences nothing is using (a free scaling lever), audiences Meta itself reports as too small to deliver, and stale lists that have not refreshed in months. Sizes come back as Meta's lower/upper bounds and are null when Meta has not computed them — say \"size not available\", never invent a number. `delivery_status` is Meta's own sentence, quote it rather than substituting your own size rule. If `usage_available` is false the ad-set cross-reference FAILED: `in_use` is null and you must NOT describe any audience as unused. Read-only — never spends or changes anything. Returns meta_ads_not_connected when Meta is absent.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { limit, include_usage } = inputSchema.parse(input);
    const creds = await metaAdsCreds(ctx.tenant_id);
    const now = new Date();

    const resp = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/customaudiences`, {
      fields: AUDIENCE_FIELDS,
      limit,
    })) as { data?: AudienceRow[]; paging?: { next?: string } };

    const rows = resp.data ?? [];
    const truncated = Boolean(resp.paging?.next);

    let usageIndex: Map<string, AudienceUsage[]> | null = null;
    let usage_unavailable_reason: string | null = null;
    if (include_usage && rows.length > 0) {
      try {
        const adsetResp = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/adsets`, {
          fields: ADSET_TARGETING_FIELDS,
          limit: 200,
        })) as { data?: AdSetTargetingRow[] };
        usageIndex = buildUsageIndex(adsetResp.data ?? []);
      } catch (e) {
        usageIndex = null;
        usage_unavailable_reason =
          e instanceof Error ? e.message : "ad-set targeting read failed";
        ctx.log("usage cross-reference failed; returning catalog without it", {
          reason: usage_unavailable_reason,
        });
      }
    } else if (!include_usage) {
      usage_unavailable_reason = "include_usage was false";
    }

    const audiences = rows
      .map((r) => mapAudience(r, usageIndex ? (usageIndex.get(r.id ?? "") ?? []) : null, now))
      .sort(
        (a, b) =>
          ((b.approximate_size_upper_bound as number | null) ?? -1) -
          ((a.approximate_size_upper_bound as number | null) ?? -1),
      );

    const usage_available = usageIndex !== null;
    const unused = usage_available ? audiences.filter((a) => a.in_use === false) : [];

    return {
      audiences,
      total_found: audiences.length,
      truncated,
      usage_available,
      usage_unavailable_reason,
      summary: {
        total: audiences.length,
        in_use: usage_available ? audiences.filter((a) => a.in_use === true).length : null,
        unused: usage_available ? unused.length : null,
        unused_audience_ids: usage_available ? unused.map((a) => a.id as string) : null,
      },
      ad_account_id: creds.ad_account_id,
      message: usage_available
        ? "Sizes are Meta's approximate bounds; null means Meta has not computed one — do not invent a size. Quote `delivery_status` verbatim instead of applying your own minimum-size rule."
        : "Ad-set cross-reference unavailable this call, so `in_use` is null for every audience. Do NOT call any audience unused — say the usage check did not run.",
    };
  },
};
