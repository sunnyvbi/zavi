
import { z } from "zod";
import { tiktokAdsAccount, tiktokCampaignsUrl, verifyAdvertisers } from "@/services/connectors/tiktok-ads/composio-read";
import { ensureAdAccounts } from "@/services/connectors/tiktok-ads/ad-accounts";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

export const tiktokAdsListAccountsTool: ToolSpec = {
  name: "tiktok_ads_list_accounts",
  effect: "read",
  description:
    "List the TikTok advertiser accounts saved for the operator's TikTok Ads login, with name, currency, " +
    "status, timezone and which one they chose (selected). Read-only. Call this first — the campaign tool requires an advertiser_id from here; " +
    "TikTok Ads writes default to the selected one when advertiser_id is left out, and may name any account listed here. " +
    "A status other than ENABLE (e.g. CONTRACT_PENDING) means TikTok will not deliver ads until the operator " +
    "fixes it in Ads Manager. Throws tiktok_ads_not_connected if TikTok Ads has not been connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const account = await tiktokAdsAccount(ctx.tenant_id);
    const state = await ensureAdAccounts(ctx.tenant_id);
    const live = await verifyAdvertisers(account, state.accounts.map((a) => a.advertiser_id));
    const selected = live.some((a) => a.advertiser_id === state.selected_id) ? state.selected_id : null;
    return {
      count: live.length,
      selected_advertiser_id: selected,
      advertisers: live.map((a) => ({
        ...a,
        source: state.accounts.find((saved) => saved.advertiser_id === a.advertiser_id)?.source,
        selected: a.advertiser_id === selected,
        ads_manager_url: tiktokCampaignsUrl(a.advertiser_id),
      })),
      note:
        live.length === 0
          ? "The connection is live but no ad account was found. The founder adds theirs on the TikTok Ads channel page (Ad account card)."
          : !selected
            ? "The founder has not chosen which ad account Zavi writes to. They choose it on the TikTok Ads channel page (Ad account card)."
            : undefined,
    };
  },
};
