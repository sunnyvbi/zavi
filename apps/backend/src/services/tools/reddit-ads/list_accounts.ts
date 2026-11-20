
import { z } from "zod";
import { listAdAccounts, redditAdsAccount } from "@/services/connectors/reddit-ads/composio-read";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

export const redditAdsListAccountsTool: ToolSpec = {
  name: "reddit_ads_list_accounts",
  effect: "read",
  description:
    "List the Reddit ad accounts the linked Reddit Ads login can access, across every business. " +
    "Returns id, name, currency. Read-only. Call this first — the campaign tools require an " +
    "account_id from here. Throws reddit_ads_not_connected if Reddit Ads has not been connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const accounts = await listAdAccounts(await redditAdsAccount(ctx.tenant_id));
    return {
      count: accounts.length,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
      note:
        accounts.length === 0
          ? "The linked Reddit login can see no ad accounts. Reddit Ads access is granted per business in Reddit Ads Manager."
          : undefined,
    };
  },
};
