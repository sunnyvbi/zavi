import { describe, expect, it } from "vitest";
import { rememberComposioInputs, validateComposioInputs } from "./composio-inputs";
import type { McpTool } from "./types";

const tool: McpTool = {
  server_id: "composio",
  tool_name: "TIKTOK_ADS_GET_CREATIVE_ASSETS",
  description: "Return metadata for specified video or image assets.",
  input_schema: {
    type: "object",
    required: ["advertiser_id", "asset_type", "asset_ids"],
    properties: {
      advertiser_id: { type: "string" },
      asset_type: { type: "string", enum: ["VIDEO", "IMAGE"] },
      asset_ids: { type: "array", items: { type: "string" }, minItems: 1 },
    },
  },
};

describe("Composio input preflight", () => {
  it("rejects the reported advertiser-only lookup before dispatch", () => {
    rememberComposioInputs("qa", [tool]);
    const result = validateComposioInputs("qa", tool.tool_name, { advertiser_id: "7683915592165785621" });
    expect(result?.is_error).toBe(true);
    expect(JSON.parse(result!.content)).toMatchObject({ error: "composio_invalid_arguments" });
    expect(result?.content).toContain("asset_type");
    expect(result?.content).toContain("no approval was created");
  });

  it("requires asset IDs and accepts supplied lookup inputs", () => {
    rememberComposioInputs("qa", [tool]);
    expect(validateComposioInputs("qa", tool.tool_name, { advertiser_id: "adv", asset_type: "VIDEO" })?.content).toContain("asset_ids");
    expect(validateComposioInputs("qa", tool.tool_name, { advertiser_id: "adv", asset_type: "VIDEO", asset_ids: ["video"] })).toBeNull();
    expect(validateComposioInputs("qa", tool.tool_name, { advertiser_id: "adv", asset_type: "VIDEO", asset_ids: [] })?.is_error).toBe(true);
    expect(validateComposioInputs("qa", tool.tool_name, { advertiser_id: "adv", asset_type: "AUDIO", asset_ids: ["video"] })?.is_error).toBe(true);
  });

  it("keeps schemas scoped to the tenant and replaces them on rediscovery", () => {
    rememberComposioInputs("qa", [tool]);
    expect(validateComposioInputs("other", tool.tool_name, {})).toBeNull();
    rememberComposioInputs("qa", []);
    expect(validateComposioInputs("qa", tool.tool_name, {})).toBeNull();
  });
});
