import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getChannel } from "@zavi/shared";
import { listLinkedinAdsTools } from "@/services/mcp/internal/linkedin-ads";
import { INTERNAL_TOOL_NAMES } from "@/services/mcp/internal-tool-names";
import { linkedinAdsProposeBudgetChangeTool } from "../write/propose_budget_change";
import { linkedinAdsProposeResumeCampaignTool } from "../write/propose_resume_campaign";
import { linkedinAdsProposeTargetingChangeTool } from "../write/propose_targeting_change";

const SHORT = ["propose_resume_campaign", "propose_budget_change", "propose_targeting_change", "propose_campaign_edit", "propose_campaign_group_edit", "propose_archive", "propose_ad_status", "propose_new_ad", "propose_ad_swap", "propose_new_campaign", "propose_duplicate", "search_targeting", "preview_ad", "list_media"];

describe("the LinkedIn change tools are advertised everywhere the pause tool is", () => {
  it("channel registry, facade and the internal tool-name list", () => {
    const tools = getChannel("linkedin_ads")?.tools ?? [];
    for (const s of SHORT) {
      expect(tools).toContain(`linkedin_ads_${s}`);
      expect(INTERNAL_TOOL_NAMES.has(`linkedin_ads__${s}`)).toBe(true);
    }
    const facade = listLinkedinAdsTools();
    for (const s of SHORT) expect(facade.find((t) => t.tool_name === s)?.server_id).toBe("linkedin_ads");
    for (const t of [linkedinAdsProposeResumeCampaignTool, linkedinAdsProposeBudgetChangeTool, linkedinAdsProposeTargetingChangeTool]) expect(t.effect).toBe("write");
  });
  it("the agent may call them and the recipe routes to them", () => {
    const agent = readFileSync(join(__dirname, "../../../../agents/linkedin_ads/agent.md"), "utf8");
    const recipe = readFileSync(join(__dirname, "../../../../channels/linkedin_ads/recipe.md"), "utf8");
    for (const s of SHORT) {
      expect(agent).toContain(`- linkedin_ads__${s}`);
      expect(recipe).toContain(`linkedin_ads__${s}`);
    }
  });
});
