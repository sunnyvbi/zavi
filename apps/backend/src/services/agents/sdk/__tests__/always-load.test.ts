import { describe, it, expect } from "vitest";

import { alwaysLoadForAgent, alwaysLoadWhenGranted } from "../always-load";

describe("alwaysLoadWhenGranted", () => {
  it("keeps the database catalog and query out of tool search for an agent granted them", () => {
    expect(
      alwaysLoadWhenGranted(["github__grep", "operator_db__catalog", "operator_db__query", "operator_db__codeact"]),
    ).toEqual(["operator_db__catalog", "operator_db__query"]);
  });

  it("loads nothing extra for an agent without those grants", () => {
    expect(alwaysLoadWhenGranted(["github__grep", "web_fetch__fetch"])).toEqual([]);
  });

  it("still always-loads the Agent Builder tool when granted", () => {
    expect(alwaysLoadWhenGranted(["praxis__propose_custom_agent"])).toEqual(["praxis__propose_custom_agent"]);
  });
});

describe("alwaysLoadForAgent", () => {
  it("preloads cgo's everyday reads even though its frontmatter does not list the database tools", () => {
    const loaded = alwaysLoadForAgent("cgo", ["growth__get_metric", "memory__search"]);
    expect(loaded).toEqual(
      expect.arrayContaining(["growth__get_metric", "operator_db__catalog", "operator_db__query", "memory__search", "web_fetch__fetch", "web_search__search"]),
    );
    expect(new Set(loaded).size).toBe(loaded.length);
  });

  it("leaves other agents on the granted-tool list only", () => {
    expect(alwaysLoadForAgent("pm", ["github__grep", "operator_db__catalog"])).toEqual(["operator_db__catalog"]);
    expect(alwaysLoadForAgent("research", ["web_fetch__fetch"])).toEqual([]);
  });

  it("never preloads a money or write tool for cgo", () => {
    expect(alwaysLoadForAgent("cgo", []).filter((t) => /propose|apply|set_|write|send|post/.test(t))).toEqual([]);
  });
});

describe("chat handoff preload", () => {
  it("preloads the routing tool and the specialist's first live read", () => {
    expect(alwaysLoadForAgent("operator", [])).toContain("praxis__handoff");
    expect(alwaysLoadForAgent("chatgpt_ads", [])).toEqual(["chatgpt_ads__read_performance"]);
    expect(alwaysLoadForAgent("research", [])).not.toContain("praxis__handoff");
  });
});

describe("meta_ads preload", () => {
  it("shows the launch, pause and edit proposals without a tool search", () => {
    expect(alwaysLoadForAgent("meta_ads", [])).toEqual(expect.arrayContaining([
      "meta_ads__list_pages", "meta_ads__propose_campaign_launch", "meta_ads__propose_new_campaign",
      "meta_ads__propose_status_change", "meta_ads__propose_campaign_update",
    ]));
  });
  it("preloads only approval-card writes, never a direct apply or the delete", () => {
    const writes = alwaysLoadForAgent("meta_ads", []).filter((t) => !/__(list|pixel)_/.test(t));
    expect(writes.every((t) => /__propose_/.test(t))).toBe(true);
    expect(writes).not.toContain("meta_ads__propose_campaign_delete");
  });
});

describe("CGO stage-specific preload", () => {
  it("loads plan evidence tools only for a strategy draft", () => {
    const tools=alwaysLoadForAgent("cgo",[],"draft_strategy");
    expect(tools).toEqual(expect.arrayContaining(["growth__seo_audit","growth__diagnose_funnel"]));
    expect(tools).not.toContain("growth__ad_budget_room");
  });
  it("loads calculation and budget reads only for goal review", () => {
    expect(alwaysLoadForAgent("cgo",[],"own_goals")).toEqual(expect.arrayContaining(["growth__compute","growth__ad_budget_room"]));
    expect(alwaysLoadForAgent("cgo",[],"own_goals")).not.toContain("growth__seo_audit");
  });
  it.each([undefined,null,"chat","unknown",{stage:"draft_strategy"}])("leaves the chat/default tool list unchanged for %s", stage => {
    expect(alwaysLoadForAgent("cgo",[],stage)).toEqual(alwaysLoadForAgent("cgo",[]));
  });
  it("does not change other agents even with a matching stage", () => {
    expect(alwaysLoadForAgent("research",[],"draft_strategy")).toEqual([]);
  });
});
