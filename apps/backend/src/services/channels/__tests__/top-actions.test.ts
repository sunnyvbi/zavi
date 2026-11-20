
import { describe, it, expect } from "vitest";
import {
  TOP_ACTIONS,
  isTopActionRun,
  metaCreateNewAdInputs,
  topActionDef,
  topActionModeKeeps,
  topActionModeOf,
  topActionRefusesClass,
  withTopActionBrief,
} from "@/services/channels/top-actions";

const inputs = { about: "Halloween deal on Teslas", link: "https://upcar.ai/halloween", goal: "visit", placement: "ig", daily_budget: 20 };
const payload = { channel_slug: "meta_ads", top_action: { key: "create_new_ad", inputs, instruction: "x", by: "u1" } };

describe("Meta create_new_ad inputs", () => {
  it("takes visit or buy only, an https link, and a positive budget", () => {
    expect(metaCreateNewAdInputs.safeParse(inputs).success).toBe(true);
    expect(metaCreateNewAdInputs.safeParse({ ...inputs, goal: "message" }).success).toBe(false);
    expect(metaCreateNewAdInputs.safeParse({ ...inputs, link: "http://upcar.ai" }).success).toBe(false);
    expect(metaCreateNewAdInputs.safeParse({ ...inputs, link: undefined }).success).toBe(false);
    expect(metaCreateNewAdInputs.safeParse({ ...inputs, daily_budget: 0 }).success).toBe(false);
  });

  it("maps placement to publisher_platforms in the instruction", () => {
    const def = TOP_ACTIONS.meta_ads.create_new_ad;
    expect(def.instruction({ ...inputs, placement: "ig" })).toContain('["instagram"]');
    expect(def.instruction({ ...inputs, placement: "fb" })).toContain('["facebook"]');
    expect(def.instruction({ ...inputs, placement: "both" })).toContain('["facebook","instagram"]');
  });
});

describe("topActionModeOf", () => {
  it("is null for a run without top_action", () => {
    expect(topActionModeOf({ channel_slug: "meta_ads", recipe_body: "x" })).toBeNull();
    expect(topActionModeOf(null)).toBeNull();
  });
  it("fails closed for an unknown key or bad inputs", () => {
    expect(topActionModeOf({ ...payload, top_action: { ...payload.top_action, key: "nope" } })).toEqual({ valid: false });
    expect(topActionModeOf({ ...payload, top_action: { ...payload.top_action, inputs: { ...inputs, goal: "message" } } })).toEqual({ valid: false });
    expect(topActionModeOf({ ...payload, channel_slug: "pinterest_ads" })).toEqual({ valid: false });
  });
  it("resolves a valid one", () => {
    expect(topActionModeOf(payload)).toMatchObject({ valid: true, key: "create_new_ad", by: "u1" });
    expect(topActionDef("meta_ads", "create_new_ad")).toBe(TOP_ACTIONS.meta_ads.create_new_ad);
    expect(topActionDef("meta_ads", "toString")).toBeNull();
  });
});

describe("what a top-action run may do", () => {
  it("keeps only the action's tools, any separator", () => {
    expect(topActionModeKeeps("meta_ads__propose_new_ad", payload)).toBe(true);
    expect(topActionModeKeeps("meta_ads_propose_campaign_launch", payload)).toBe(true);
    expect(topActionModeKeeps("meta_ads__propose_budget_change", payload)).toBe(false);
    expect(topActionModeKeeps("meta_ads__propose_status_change", payload)).toBe(false);
    expect(topActionModeKeeps("meta_ads__propose_budget_change", { channel_slug: "meta_ads" })).toBe(true);
  });
  it("files only the action's classes; a broken payload files nothing", () => {
    expect(topActionRefusesClass(payload, "meta_ads.create_ad")).toBe(false);
    expect(topActionRefusesClass(payload, "meta_ads.launch_campaign")).toBe(false);
    expect(topActionRefusesClass(payload, "meta_ads.update_ad_set_budget")).toBe(true);
    expect(topActionRefusesClass(payload, "channel.recipe_step")).toBe(true);
    expect(topActionRefusesClass({ ...payload, top_action: { key: 1 } }, "meta_ads.create_ad")).toBe(true);
    expect(topActionRefusesClass({ channel_slug: "meta_ads" }, "meta_ads.update_ad_set_budget")).toBe(false);
  });
  it("reads the instruction first; other runs are byte-identical", () => {
    expect(withTopActionBrief(payload, "TURN")).toMatch(/^## This run: one ad the founder asked for[\s\S]*TURN$/);
    expect(withTopActionBrief({ channel_slug: "meta_ads" }, "TURN")).toBe("TURN");
  });
  it("is a human-asked run only on a channel_recipe trigger with a valid action", () => {
    expect(isTopActionRun(payload, "channel_recipe")).toBe(true);
    expect(isTopActionRun(payload, "chat")).toBe(false);
    expect(isTopActionRun({ channel_slug: "meta_ads" }, "channel_recipe")).toBe(false);
    expect(isTopActionRun({ ...payload, top_action: { key: "nope" } }, "channel_recipe")).toBe(false);
  });
});
