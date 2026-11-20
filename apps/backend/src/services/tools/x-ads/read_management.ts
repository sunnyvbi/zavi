import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import {
  xAdsTenantToken,
  xCampaignStats,
} from "@/services/connectors/x-ads/client";
import {
  listXResources,
  readXAccess,
  type XLineItem,
} from "@/services/connectors/x-ads/resources";
import { xId } from "@/services/connectors/x-ads/schema";

export const xAdsVerifyPermissionsTool: ToolSpec = {
  name: "x_ads_verify_permissions",
  effect: "read",
  description:
    "Read authenticated user ad-account roles. Campaign writes require ACCOUNT_ADMIN or AD_MANAGER. App approval and app-level write permissions remain unverified until X accepts a write; no write is attempted.",
  input_schema: z.object({ account_id: xId }),
  async execute(ctx, input) {
    const { account_id } = z.object({ account_id: xId }).parse(input);
    return readXAccess(await xAdsTenantToken(ctx.tenant_id), account_id);
  },
};
const inventoryInput = z.object({
  account_id: xId,
  campaign_id: xId.optional(),
  line_item_id: xId.optional(),
});
export const xAdsReadAdGroupsTool: ToolSpec = {
  name: "x_ads_read_ad_groups",
  effect: "read",
  description:
    "Read ad groups (line items), bids, budgets, schedules, promoted ad associations and targeting. Supplying line_item_id also reads that group's promoted posts and targeting. Values are returned in X's native micro-currency units.",
  input_schema: inventoryInput,
  async execute(ctx, input) {
    const a = inventoryInput.parse(input);
    const token = await xAdsTenantToken(ctx.tenant_id);
    const ad_groups = await listXResources<XLineItem>(
      token,
      a.account_id,
      "line_items",
      {
        ...(a.campaign_id ? { campaign_ids: a.campaign_id } : {}),
        ...(a.line_item_id ? { line_item_ids: a.line_item_id } : {}),
      },
    );
    const promoted_ads = a.line_item_id
      ? await listXResources(token, a.account_id, "promoted_tweets", {
          line_item_ids: a.line_item_id,
        })
      : [];
    const targeting = a.line_item_id
      ? await listXResources(token, a.account_id, "targeting_criteria", {
          line_item_ids: a.line_item_id,
        })
      : [];
    return { ad_groups, promoted_ads, targeting };
  },
};
const trackingInput = z.object({ account_id: xId, campaign_id: xId });
export const xAdsCheckConversionsTool: ToolSpec = {
  name: "x_ads_check_conversions",
  effect: "read",
  description:
    "Check ad-group primary conversion tags and reported web conversions over the last seven complete UTC days. This does not prove Pixel/CAPI installation, event receipt, deduplication or matching health. Missing or inaccessible conversions are unknown, not zero. Confirm event health in X Ads Manager Events Manager.",
  input_schema: trackingInput,
  async execute(ctx, input) {
    const a = trackingInput.parse(input);
    const token = await xAdsTenantToken(ctx.tenant_id);
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    const groups = await listXResources<XLineItem>(
      token,
      a.account_id,
      "line_items",
      { campaign_ids: a.campaign_id },
    );
    const stats = await xCampaignStats(
      token,
      a.account_id,
      [a.campaign_id],
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
    );
    return {
      campaign_id: a.campaign_id,
      tags: groups.map((g) => ({
        line_item_id: g.id,
        primary_web_event_tag: g.primary_web_event_tag ?? null,
      })),
      reported_conversions:
        stats.conversionsRead &&
        !stats.missing.get(a.campaign_id)?.has("conversions")
          ? (stats.get(a.campaign_id)?.conversions ?? null)
          : null,
      event_receipt: "unverified",
      installation: "unverified",
      window: {
        from: start.toISOString().slice(0, 10),
        to: end.toISOString().slice(0, 10),
      },
      limitation:
        "Attributable conversion totals are not event-health diagnostics; only ALL_ON_TWITTER placement is read.",
    };
  },
};
