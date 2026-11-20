
import { describe, it, expect } from "vitest";
import { listMetaAdsTools } from "@/services/mcp/internal/meta-ads";
import { metaAnalystBriefTool } from "../analyst_brief";

describe("meta_ads__analyst_brief registration", () => {
  it("is advertised by the meta_ads facade under tool_name 'analyst_brief'", () => {
    const names = listMetaAdsTools().map((t) => t.tool_name);
    expect(names).toContain("analyst_brief");
  });

  it("has a top-level object input schema (level + date_preset)", () => {
    expect(metaAnalystBriefTool.name).toBe("meta_ads_analyst_brief");
    expect(metaAnalystBriefTool.description).toMatch(/INVESTIGATE_FUNNEL/);
    expect(metaAnalystBriefTool.description).toMatch(/before any scale\/cut/i);
  });
});
