
import { z } from "zod";
import { listMicrosoftAdAccounts } from "@/services/connectors/microsoft-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

export const microsoftAdsListAccountsTool: ToolSpec = {
  name: "microsoft_ads_list_accounts",
  effect: "read",
  description:
    "List the Microsoft Ads ad accounts the operator's connection can access (id, name, currency, status). " +
    "Read-only. Call this first — the campaign tool requires an account_id from here. " +
    "Throws microsoft_ads_not_connected if Microsoft Ads has not been connected.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    inputSchema.parse(input);
    const accounts = await listMicrosoftAdAccounts(ctx.tenant_id);
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
