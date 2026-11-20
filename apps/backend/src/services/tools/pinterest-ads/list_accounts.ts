
import { z } from "zod";
import { listPinterestAdAccounts } from "@/services/connectors/pinterest-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

export const pinterestAdsListAccountsTool: ToolSpec = {
  name: "pinterest_ads_list_accounts",
  effect: "read",
  description:
    "List the Pinterest Ads ad accounts the operator's connection can access (id, name, currency, status). " +
    "Read-only. Call this first — the campaign tool requires an account_id from here. " +
    "Throws pinterest_ads_not_connected if Pinterest Ads has not been connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const accounts = await listPinterestAdAccounts(ctx.tenant_id);
    return {
      count: accounts.length,
      accounts,
      note:
        accounts.length === 0
          ? "The connection is live but no ad account is visible to it. Access is granted per account by the advertiser's own admin."
          : undefined,
    };
  },
};
