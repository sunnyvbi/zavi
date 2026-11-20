import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentChildEnv, MCP_DESCRIPTION_MAX_CHARS } from "../../agent-auth";
import { sdkToolDescription } from "../tool-input-shape";
import { listChatgptAdsTools } from "@/services/mcp/internal/chatgpt-ads";

async function everyInternalTool() {
  const dir = path.resolve(__dirname, "../../../mcp/internal");
  const tools: Array<{ name: string; text: string }> = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const mod = (await import(path.join(dir, file))) as Record<string, unknown>;
    for (const [name, list] of Object.entries(mod)) {
      if (typeof list !== "function" || !/^list\w*Tools$/.test(name)) continue;
      const listed = await (list as () => unknown)();
      if (!Array.isArray(listed)) continue;
      for (const t of listed as Array<{ tool_name?: string; description?: string; input_schema?: unknown }>) {
        if (t?.input_schema && t.tool_name) tools.push({ name: `${file}:${t.tool_name}`, text: sdkToolDescription(t.description ?? "", t.input_schema) });
      }
    }
  }
  return tools;
}

describe("MCP tool description cap", () => {
  it("the child env raises the binary's 2,048-char default, and an explicit value wins", () => {
    expect(buildAgentChildEnv({ mode: "none", baseEnv: {} }).CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH).toBe(String(MCP_DESCRIPTION_MAX_CHARS));
    expect(buildAgentChildEnv({ mode: "none", baseEnv: { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "4000" } }).CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH).toBe("4000");
  });

  it("every backend tool's description, schema included, fits the cap", async () => {
    const tools = await everyInternalTool();
    expect(tools.length).toBeGreaterThan(100);
    const over = tools.filter((t) => t.text.length > MCP_DESCRIPTION_MAX_CHARS).map((t) => `${t.name} (${t.text.length})`);
    expect(over).toEqual([]);
  }, 120_000);

  it("ChatGPT Ads shows the automatic-bidding field and the targeting shape", () => {
    const t = listChatgptAdsTools().find((x) => x.tool_name === "propose_new_campaign")!;
    const text = sdkToolDescription(t.description, t.input_schema).slice(0, MCP_DESCRIPTION_MAX_CHARS);
    expect(JSON.parse(text.slice(text.indexOf("{"))).properties.group.properties.strategy.enum).toContain("maximize_clicks");
    expect(JSON.parse(text.slice(text.indexOf("{"))).properties.campaign.properties.targeting.properties.locations.properties.countries.type).toBe("array");
  });
});
