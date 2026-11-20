import { describe, it, expect } from "vitest";
import { isMutatingToolName, hasMutatingSideEffect } from "../mutating-tools";

describe("isMutatingToolName", () => {
  it("slack post/upload → mutating (real delivery)", () => {
    expect(isMutatingToolName("mcp__server__slack__post_message")).toBe(true);
    expect(isMutatingToolName("mcp__server__slack__upload_file")).toBe(true);
  });

  it("slack reads → NOT mutating", () => {
    expect(isMutatingToolName("mcp__server__slack__list_channels")).toBe(false);
    expect(isMutatingToolName("mcp__server__slack__get_channel_history")).toBe(false);
    expect(isMutatingToolName("mcp__server__slack__read_thread")).toBe(false);
    expect(isMutatingToolName("mcp__server__slack__open_dm")).toBe(false);
  });

  it("stripe money-rail writes → mutating; stripe reads → NOT", () => {
    expect(isMutatingToolName("mcp__server__stripe__create_payment")).toBe(true);
    expect(isMutatingToolName("mcp__server__stripe__remit_to_tenant")).toBe(true);
    expect(isMutatingToolName("mcp__server__stripe__submit_dispute_evidence")).toBe(true);
    expect(isMutatingToolName("mcp__server__stripe__list_charges")).toBe(false);
    expect(isMutatingToolName("mcp__server__stripe__retrieve_dispute")).toBe(false);
  });

  it("email send → mutating", () => {
    expect(isMutatingToolName("mcp__server__email__send")).toBe(true);
  });

  it("provision__* → mutating (real resource)", () => {
    expect(isMutatingToolName("mcp__server__provision__domain")).toBe(true);
    expect(isMutatingToolName("mcp__server__provision__hosting")).toBe(true);
    expect(isMutatingToolName("mcp__server__provision__repo")).toBe(true);
  });

  it("ad-platform create/edit → mutating; ad reads → NOT", () => {
    expect(isMutatingToolName("mcp__server__meta_ads__create_ad_set")).toBe(true);
    expect(isMutatingToolName("mcp__server__google_ads__update_campaign")).toBe(true);
    expect(isMutatingToolName("mcp__server__meta_ads__list_campaigns")).toBe(false);
    expect(isMutatingToolName("mcp__server__meta_ads__pixel_health")).toBe(false);
    expect(isMutatingToolName("mcp__server__google_ads__list_ad_groups")).toBe(false);
  });

  it("github writes → mutating; github reads → NOT", () => {
    expect(isMutatingToolName("mcp__server__github__open_pr")).toBe(true);
    expect(isMutatingToolName("mcp__server__github__read_file")).toBe(false);
    expect(isMutatingToolName("mcp__server__github__search_code")).toBe(false);
    expect(isMutatingToolName("mcp__server__github__list_open_prs")).toBe(false);
    expect(isMutatingToolName("mcp__server__github__get_pr_diff")).toBe(false);
  });

  it("PROPOSE_* is HELD, not shipped → NOT mutating", () => {
    expect(isMutatingToolName("mcp__server__meta_ads__propose_new_ad_set")).toBe(false);
    expect(isMutatingToolName("mcp__server__meta_ads__propose_status_change")).toBe(false);
    expect(isMutatingToolName("mcp__server__outbound__propose_email")).toBe(false);
  });

  it("memory/brain writes are LOW-SIGNAL → NOT mutating (explicit exclusion)", () => {
    expect(isMutatingToolName("mcp__server__memory__write")).toBe(false);
    expect(isMutatingToolName("mcp__server__memory__search")).toBe(false);
    expect(isMutatingToolName("mcp__server__brain__apply_anchor")).toBe(false);
    expect(isMutatingToolName("mcp__server__brain__retire_note")).toBe(false);
  });

  it("operator_db reads → NOT mutating", () => {
    expect(isMutatingToolName("mcp__server__operator_db__query")).toBe(false);
    expect(isMutatingToolName("mcp__server__operator_db__catalog")).toBe(false);
  });

  it("sandbox / browser / meta tools → NOT mutating (engineer-internal / probe / meta)", () => {
    expect(isMutatingToolName("mcp__sandbox__create")).toBe(false);
    expect(isMutatingToolName("mcp__sandbox__str_replace")).toBe(false);
    expect(isMutatingToolName("mcp__sandbox__run_bash")).toBe(false);
    expect(isMutatingToolName("mcp__browser__browser_fill")).toBe(false);
    expect(isMutatingToolName("ToolSearch")).toBe(false);
    expect(isMutatingToolName("AskUserQuestion")).toBe(false);
  });

  it("unknown tool name → NON-mutating (conservative — never fabricates shipped)", () => {
    expect(isMutatingToolName("mcp__server__some_new_area__frobnicate")).toBe(false);
    expect(isMutatingToolName("totally_made_up")).toBe(false);
    expect(isMutatingToolName("")).toBe(false);
  });

  it("unambiguous verb under an UNMAPPED area still classifies mutating (area-independent net)", () => {
    expect(isMutatingToolName("mcp__x__post_message")).toBe(true);
    expect(isMutatingToolName("mcp__future_host__open_pr")).toBe(true);
  });
});

describe("hasMutatingSideEffect", () => {
  it("≥1 mutating tool with status ok → true", () => {
    expect(
      hasMutatingSideEffect([
        { name: "mcp__server__memory__search", status: "ok" },
        { name: "mcp__server__slack__post_message", status: "ok" },
      ]),
    ).toBe(true);
  });

  it("mutating tool that ERRORED (throw / tool_error) → false", () => {
    expect(hasMutatingSideEffect([{ name: "mcp__server__slack__post_message", status: "throw" }])).toBe(false);
    expect(
      hasMutatingSideEffect([{ name: "mcp__server__stripe__create_payment", status: "tool_error" }]),
    ).toBe(false);
  });

  it("only reads → false", () => {
    expect(
      hasMutatingSideEffect([
        { name: "mcp__server__meta_ads__list_campaigns", status: "ok" },
        { name: "mcp__server__growth__read_cohort", status: "ok" },
      ]),
    ).toBe(false);
  });

  it("absent / empty / non-array → false", () => {
    expect(hasMutatingSideEffect(null)).toBe(false);
    expect(hasMutatingSideEffect(undefined)).toBe(false);
    expect(hasMutatingSideEffect([])).toBe(false);
  });
});
