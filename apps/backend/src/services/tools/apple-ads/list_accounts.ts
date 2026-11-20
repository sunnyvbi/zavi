
import { z } from "zod";
import { listAppleAdAccounts } from "@/services/connectors/apple-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

export const appleAdsListAccountsTool: ToolSpec = {
  name: "apple_ads_list_accounts",
  effect: "read",
  description:
    "List the Apple Ads ad accounts the operator's connection can access (id, name, currency, status). " +
    "Read-only. Call this first — the campaign tool requires an account_id from here. " +
    "Throws apple_ads_not_connected if Apple Ads has not been connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const accounts = await listAppleAdAccounts(ctx.tenant_id);
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
