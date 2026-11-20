import { z } from "zod";
import { searchXLocations, xAdsTenantToken } from "@/services/connectors/x-ads/client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  query: z.string().min(1).max(100).optional().describe("A place name, e.g. a country, state or city."),
  country_code: z.string().regex(/^[A-Za-z]{2}$/, "two-letter ISO country code").optional(),
  location_type: z.enum(["COUNTRIES", "REGIONS", "METROS", "CITIES", "POSTAL_CODES"]).optional(),
});

export const xAdsSearchLocationsTool: ToolSpec = {
  name: "x_ads_search_locations",
  effect: "read",
  description:
    "Find X Ads location targeting ids by name, country code and type. Returns id, name, type and country. " +
    "Read-only. Pass them to x_ads_propose_create_campaign as locations ({id, name}).",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const locations = await searchXLocations(await xAdsTenantToken(ctx.tenant_id), inputSchema.parse(input));
    return { count: locations.length, locations };
  },
};
