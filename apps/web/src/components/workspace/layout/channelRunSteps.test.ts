import { describe, it, expect } from "vitest";
import { buildChannelRunSteps, labelForTool, bareToolName, GENERIC_TOOL_LABEL } from "./channelRunSteps";

const tool = (stage: string, tool_name: string) => ({ stage, meta: { tool_name } });
const stage = (s: string) => ({ stage: s, meta: null });

describe("labelForTool", () => {
  it("strips the transport prefix real rows carry", () => {
    expect(bareToolName("mcp__server__google_ads__list_campaigns")).toBe("google_ads__list_campaigns");
    expect(bareToolName("assistant_turn")).toBe("assistant_turn");
  });

  it("maps a mapped family to plain English, in both tenses", () => {
    expect(labelForTool("mcp__server__google_ads__search_terms")).toEqual({
      doing: "Reading your Google Ads account",
      done: "Read your Google Ads account",
    });
  });

  it("hides the model's own turn and the tool lookup", () => {
    expect(labelForTool("assistant_turn")).toBeNull();
    expect(labelForTool("ToolSearch")).toBeNull();
  });

  it("degrades an UNMAPPED tool to the generic phrase, never the raw name", () => {
    const label = labelForTool("mcp__server__quickbooks__list_invoices");
    expect(label).toEqual(GENERIC_TOOL_LABEL);
    expect(JSON.stringify(label)).not.toMatch(/quickbooks|mcp__|__/);
  });

  it("never returns a string containing the transport prefix, for any input", () => {
    const wild = [
      "mcp__server__weird__thing",
      "__",
      "totally_new_tool",
      "mcp__server__",
      "mcp__server__google_ads__x",
    ];
    for (const raw of wild) {
      const label = labelForTool(raw);
      if (!label) continue;
      expect(label.doing).not.toMatch(/mcp__|__/);
      expect(label.done).not.toMatch(/mcp__|__/);
    }
  });
});

describe("buildChannelRunSteps", () => {
  it("is empty before anything has happened, so the caller shows no list", () => {
    expect(buildChannelRunSteps([])).toEqual([]);
    expect(buildChannelRunSteps([stage("claimed")])).toEqual([]);
  });

  it("folds a real Google Ads run into one line per family, in order", () => {
    const steps = buildChannelRunSteps([
      stage("claimed"),
      stage("loaded_context"),
      tool("tool_use_completed", "assistant_turn"),
      tool("tool_use_completed", "ToolSearch"),
      tool("tool_use_started", "mcp__server__growth__read_action_outcomes"),
      tool("tool_use_completed", "mcp__server__growth__read_action_outcomes"),
      tool("tool_use_started", "mcp__server__google_ads__list_campaigns"),
      tool("tool_use_completed", "mcp__server__google_ads__list_campaigns"),
      tool("tool_use_started", "mcp__server__google_ads__search_terms"),
      tool("tool_use_completed", "mcp__server__google_ads__search_terms"),
      tool("tool_use_started", "mcp__server__google_ads__list_keywords"),
    ]);
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Read your company setup", "done"],
      ["Checked what past changes did", "done"],
      ["Read your Google Ads account", "done"],
      ["Write the steps up for your approval", "pending"],
    ]);
  });

  it("shows the family still in flight as running", () => {
    const steps = buildChannelRunSteps([
      stage("loaded_context"),
      tool("tool_use_started", "mcp__server__web_search__search"),
    ]);
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Read your company setup", "done"],
      ["Searching the web", "running"],
      ["Write the steps up for your approval", "pending"],
    ]);
  });

  it("one error inside a family that otherwise completed is still done", () => {
    const steps = buildChannelRunSteps([
      tool("tool_use_started", "mcp__server__google_ads__list_campaigns"),
      tool("tool_use_completed", "mcp__server__google_ads__list_campaigns"),
      tool("tool_use_started", "mcp__server__google_ads__conversion_lag"),
      tool("tool_use_errored", "mcp__server__google_ads__conversion_lag"),
    ]);
    expect(steps[0]).toMatchObject({ label: "Read your Google Ads account", state: "done" });
  });

  it("a family that ONLY ever errored is reported failed, not hidden", () => {
    const steps = buildChannelRunSteps([
      tool("tool_use_started", "mcp__server__web_fetch__fetch"),
      tool("tool_use_errored", "mcp__server__web_fetch__fetch"),
    ]);
    expect(steps[0]).toMatchObject({ label: "Reading pages on the web", state: "failed" });
  });

  it("the write-up line tracks the run's own stages", () => {
    const base = [tool("tool_use_completed", "mcp__server__memory__search")];
    const last = (rows: Parameters<typeof buildChannelRunSteps>[0]) =>
      buildChannelRunSteps(rows).at(-1);
    expect(last(base)).toMatchObject({ label: "Write the steps up for your approval", state: "pending" });
    expect(last([...base, stage("envelope_extracted")])).toMatchObject({
      label: "Writing the steps up for your approval",
      state: "running",
    });
    expect(last([...base, stage("envelope_extracted"), stage("persisted")])).toMatchObject({
      label: "Wrote the steps up for your approval",
      state: "done",
    });
  });

  it("families that share wording collapse into one line", () => {
    const steps = buildChannelRunSteps([
      tool("tool_use_completed", "mcp__server__web_fetch__fetch"),
      tool("tool_use_completed", "mcp__server__apify__scrape_reddit"),
    ]);
    expect(steps.filter((s) => s.label === "Read pages on the web")).toHaveLength(1);
  });

  it("an unmapped run renders generically and leaks no tool name", () => {
    const steps = buildChannelRunSteps([
      stage("loaded_context"),
      tool("tool_use_started", "mcp__server__quickbooks__list_invoices"),
      tool("tool_use_completed", "mcp__server__quickbooks__list_invoices"),
      tool("tool_use_completed", "mcp__server__hubspot__deals"),
    ]);
    const text = steps.map((s) => s.label).join(" | ");
    expect(text).not.toMatch(/quickbooks|hubspot|mcp__|__/);
    expect(steps.map((s) => s.label)).toContain("Checked a connected tool");
  });

  it("ignores a row whose meta carries no tool name", () => {
    expect(buildChannelRunSteps([{ stage: "tool_use_errored", meta: {} }])).toEqual([]);
    expect(buildChannelRunSteps([{ stage: "tool_use_errored", meta: null }])).toEqual([]);
  });
});
