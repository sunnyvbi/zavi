
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({});

export const listLocationsTool: ToolSpec = {
  name: "google_ads_list_locations",
  effect: "read",
  description:
    "Where each live (ENABLED) Google Ads campaign shows: its targeted countries, states, cities or markets. places is null with not_listed_because when they cannot be listed: no_location_criteria (worldwide, or radius targeting this read does not cover) or unnamed_place (a place Google did not name; the others are not shown), or location_exclusions (the campaign excludes places this read does not list). Returns google_ads_not_connected when Google Ads is absent.",
  input_schema: inputSchema,
  async execute(ctx) {
    const { readGoogleCampaignPlaces } = await import("@/services/growth/copy-regions");
    const campaigns = await readGoogleCampaignPlaces(ctx.tenant_id);
    return {
      campaigns: campaigns.map((c) =>
        c.has_exclusions
          ? { campaign_id: c.campaign_id, campaign_name: c.campaign_name, places: null, not_listed_because: "location_exclusions" }
          : c.places === "everywhere"
            ? { campaign_id: c.campaign_id, campaign_name: c.campaign_name, places: null, not_listed_because: c.everywhere_reason ?? "no_location_criteria" }
            : { campaign_id: c.campaign_id, campaign_name: c.campaign_name, places: c.places },
      ),
    };
  },
};
