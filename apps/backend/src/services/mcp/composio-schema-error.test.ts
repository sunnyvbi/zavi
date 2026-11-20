import { describe, expect, it } from "vitest";
import { rememberComposioInputs, validateComposioInputs } from "./composio-inputs";
import type { McpTool } from "./types";

const tool: McpTool = {
  server_id: "composio",
  tool_name: "TIKTOK_ADS_CREATE_SMART_PLUS_AD",
  description: "Create a disabled Smart+ ad",
  input_schema: {
    type: "object",
    required: ["advertiser_id", "creative_list"],
    properties: {
      advertiser_id: { type: "string", minLength: 1 },
      operation_status: { type: "string", enum: ["DISABLE"] },
      creative_list: {
        type: "array", minItems: 1,
        items: {
          type: "object", required: ["creative_info"],
          properties: {
            creative_info: {
              type: "object", required: ["video_info"],
              properties: {
                video_info: {
                  type: "object", required: ["video_id"],
                  properties: { video_id: { type: "string", minLength: 1 } },
                },
              },
            },
          },
        },
      },
    },
  },
};

function validate(creative: unknown, status = "DISABLE") {
  rememberComposioInputs("creation-test", [tool]);
  return validateComposioInputs("creation-test", tool.tool_name, {
    advertiser_id: "advertiser", operation_status: status, creative_list: [creative],
  });
}

describe("TikTok creation input preflight", () => {
  it("rejects missing nested creative IDs before a creation proposal", () => {
    expect(validate({ creative_info: { video_info: {} } })?.content).toContain("arguments.creative_list[0].creative_info.video_info.video_id");
  });

  it("rejects malformed creative entries and blank IDs", () => {
    expect(validate("video")?.is_error).toBe(true);
    expect(validate({ creative_info: { video_info: { video_id: 123 } } })?.is_error).toBe(true);
    expect(validate({ creative_info: { video_info: { video_id: "" } } })?.is_error).toBe(true);
  });

  it("accepts complete disabled creation and enforces the discovered status enum", () => {
    const creative = { creative_info: { video_info: { video_id: "verified-video" } } };
    expect(validate(creative)).toBeNull();
    expect(validate(creative, "ENABLE")?.is_error).toBe(true);
  });
});
