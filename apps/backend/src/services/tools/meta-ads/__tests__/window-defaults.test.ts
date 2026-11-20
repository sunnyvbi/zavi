
import { describe, it, expect } from "vitest";
import { metaListCampaignsTool } from "../list_campaigns";
import { metaListAdSetsTool } from "../list_ad_sets";

describe("meta-ads list tools — window default", () => {
  it("list_campaigns defaults to last_30d (aligned with dashboard + rule #4a)", () => {
    const parsed = metaListCampaignsTool.input_schema.parse({}) as {
      date_preset: string;
      status: string;
    };
    expect(parsed.date_preset).toBe("last_30d");
    expect(parsed.status).toBe("ACTIVE");
  });

  it("list_ad_sets leaves the window unset: execute reads it as the last 30 days ending on the settled day (list_ad_sets.settled.test.ts)", () => {
    const parsed = metaListAdSetsTool.input_schema.parse({
      campaign_id: "120252798122720059",
    }) as { date_preset?: string };
    expect(parsed.date_preset).toBeUndefined();
  });
});
