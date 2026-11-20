import { describe, it, expect } from "vitest";
import { callGrowthTool } from "../growth";
import { seoAuditTool } from "@/services/tools/growth/seo_audit";

describe("callGrowthTool schema rejection", () => {
  const TENANT = "00000000-0000-0000-0000-000000000000";

  it("returns a readable tool_input_invalid instead of throwing", async () => {
    const res = await callGrowthTool(TENANT, "seo_audit", { paths: ["pricing"] });

    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content) as { error: string; message: string };
    expect(body.error).toBe("tool_input_invalid");
    expect(body.message).toContain("paths");
  });

  it("exposes question acknowledgement but refuses a caller without verified chat identity", async () => {
    const res = await callGrowthTool(TENANT, "record_card_answer", { card_id: "44444444-4444-4444-8444-444444444444" });
    expect(JSON.parse(res.content)).toMatchObject({ error: "card_answer_unavailable" });
  });

  it("still reports an unregistered tool as tool_unknown", async () => {
    const res = await callGrowthTool(TENANT, "not_a_real_growth_tool", {});
    const body = JSON.parse(res.content) as { error: string };
    expect(body.error).toBe("tool_unknown");
  });

  it("does not swallow a non-Zod programmer error", async () => {
    const realParse = seoAuditTool.input_schema.parse;
    seoAuditTool.input_schema.parse = () => {
      const boom = new Error("kaboom");
      boom.name = "TypeError";
      throw boom;
    };
    try {
      await expect(callGrowthTool(TENANT, "seo_audit", { paths: ["/ok"] })).rejects.toThrow("kaboom");
    } finally {
      seoAuditTool.input_schema.parse = realParse;
    }
  });
});
