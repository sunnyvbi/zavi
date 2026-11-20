import { z } from "zod";
import { listXFundingInstruments, xAdsTenantToken } from "@/services/connectors/x-ads/client";
import type { ToolSpec } from "@/services/tools/types";
import { accountIdField } from "./_shared";

const inputSchema = z.object({ account_id: accountIdField });

export const xAdsListFundingInstrumentsTool: ToolSpec = {
  name: "x_ads_list_funding_instruments",
  effect: "read",
  description:
    "List the funding instruments (card, credit line, insertion order) on one X Ads account: id, description, " +
    "type, currency and whether it can fund a campaign right now. Read-only. A new campaign needs one that can fund.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id } = inputSchema.parse(input);
    const instruments = await listXFundingInstruments(await xAdsTenantToken(ctx.tenant_id), account_id);
    return {
      account_id,
      count: instruments.length,
      instruments,
      note: instruments.some((f) => f.able_to_fund)
        ? undefined
        : "No funding instrument on this account can pay for a campaign. The advertiser adds one in X Ads Manager → Billing.",
    };
  },
};
