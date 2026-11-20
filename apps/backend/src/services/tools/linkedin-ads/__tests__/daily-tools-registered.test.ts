import { describe, expect, it } from "vitest";
import { getChannel } from "@zavi/shared";
import { listLinkedinAdsTools } from "@/services/mcp/internal/linkedin-ads";
import { linkedinAdsAnalystBriefTool } from "../analyst_brief";
import { linkedinAdsDailySeriesTool } from "../daily_series";
import { linkedinAdsListAdsTool } from "../list_ads";
import { linkedinAdsListCampaignGroupsTool } from "../list_campaign_groups";
import { linkedinAdsRecentChangesTool } from "../recent_changes";

describe("the LinkedIn daily tools are advertised everywhere the Meta ones are", () => {
  it("the channel registry lists both so a channel run may call them", () => {
    const tools = getChannel("linkedin_ads")?.tools ?? [];
    expect(tools).toContain("linkedin_ads_daily_series");
    expect(tools).toContain("linkedin_ads_analyst_brief");
    expect(tools).toContain("linkedin_ads_list_campaign_groups");
    expect(tools).toContain("linkedin_ads_list_ads");
    expect(tools).toContain("linkedin_ads_recent_changes");
    expect(tools.indexOf("linkedin_ads_list_campaign_groups")).toBeLessThan(tools.indexOf("linkedin_ads_list_campaigns"));
    expect(tools.indexOf("linkedin_ads_daily_series")).toBeLessThan(tools.indexOf("linkedin_ads_propose_pause_campaign"));
  });

  it("the linkedin_ads facade serves both under their short names", () => {
    const names = listLinkedinAdsTools().map((t) => t.tool_name);
    expect(names).toContain("daily_series");
    expect(names).toContain("analyst_brief");
    expect(names).toContain("list_campaign_groups");
    expect(names).toContain("list_ads");
    expect(names).toContain("recent_changes");
    expect(linkedinAdsListAdsTool.name).toBe("linkedin_ads_list_ads");
    expect(linkedinAdsRecentChangesTool.name).toBe("linkedin_ads_recent_changes");
    expect(linkedinAdsListAdsTool.description).toMatch(/prior window/);
    expect(linkedinAdsRecentChangesTool.description).toMatch(/unknown/);
    expect(linkedinAdsListCampaignGroupsTool.name).toBe("linkedin_ads_list_campaign_groups");
    expect(linkedinAdsDailySeriesTool.name).toBe("linkedin_ads_daily_series");
    expect(linkedinAdsAnalystBriefTool.name).toBe("linkedin_ads_analyst_brief");
    expect(linkedinAdsAnalystBriefTool.description).toMatch(/NO_DECISION/);
    expect(linkedinAdsDailySeriesTool.description).toMatch(/unknown/i);
  });
});
