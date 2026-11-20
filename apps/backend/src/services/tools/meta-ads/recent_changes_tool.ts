
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { fbGet, metaAdsCreds } from "./_client";

const CHANGE_EVENT_TYPES = new Set([
  "update_ad_set_budget",
  "update_ad_set_run_status",
  "update_campaign_run_status",
  "update_campaign_group_budget",
  "update_ad_set_bid_strategy",
]);

const EVENT_LABEL: Record<string, string> = {
  update_ad_set_budget: "ad set budget changed",
  update_ad_set_run_status: "ad set paused or resumed",
  update_campaign_run_status: "campaign paused or resumed",
  update_campaign_group_budget: "campaign budget changed",
  update_ad_set_bid_strategy: "ad set bid strategy changed",
};

const inputSchema = z
  .object({
    lookback_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(14)
      .describe("How far back to read the activity log. Default 14 days."),
  })
  .strict();

type ActivityRow = {
  event_type?: string;
  object_id?: string | number;
  object_name?: string;
  event_time?: string;
  extra_data?: string;
};

export const metaRecentChangesTool: ToolSpec = {
  name: "meta_ads_recent_changes",
  effect: "read",
  description:
    "Read Meta's own activity log for budget, run-status and bid-strategy changes on this ad account in the last N days — including changes made directly in Ads Manager, outside Zavi. Use it for two things: (1) before proposing a change, so you never re-propose something the operator already did; (2) when a line's numbers move, to check whether an EDIT explains the move before you attribute it to the auction, the creative or the market. Pair it with meta_ads__daily_series: the series shows WHEN the numbers changed, this shows whether something was changed on that day. Does NOT return who made the change, by design. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { lookback_days } = inputSchema.parse(input);
    const creds = await metaAdsCreds(ctx.tenant_id);
    const sinceIso = new Date(Date.now() - lookback_days * 86400_000).toISOString();

    const resp = (await fbGet(ctx.tenant_id, `${creds.ad_account_id}/activities`, {
      since: sinceIso,
      fields: "event_type,object_id,object_name,event_time,extra_data",
      limit: 300,
    })) as { data?: ActivityRow[] };

    const all = resp.data ?? [];
    const changes = all
      .filter((r) => r.event_type && CHANGE_EVENT_TYPES.has(r.event_type))
      .map((r) => ({
        event_type: r.event_type!,
        what_changed: EVENT_LABEL[r.event_type!] ?? r.event_type!,
        object_id: r.object_id == null ? null : String(r.object_id),
        object_name: r.object_name ?? null,
        changed_at: r.event_time ?? null,
        details_raw: r.extra_data ?? null,
      }))
      .sort((a, b) => String(b.changed_at ?? "").localeCompare(String(a.changed_at ?? "")));

    return {
      connected: true,
      lookback_days,
      since: sinceIso.slice(0, 10),
      changes,
      changes_found: changes.length,
      activity_rows_scanned: all.length,
      page_limit_reached: all.length >= 300,
      method:
        "Meta ad-account activity log, filtered to budget / run-status / bid-strategy events. Meta's own delivery, review and billing events are excluded. An empty list means no MONEY-KNOB change was logged in the window — it does not mean nothing about the account changed (creative swaps, audience edits and targeting changes are not in this filter). `details_raw` is Meta's unparsed extra_data: quote it, never compute from it.",
    };
  },
};
