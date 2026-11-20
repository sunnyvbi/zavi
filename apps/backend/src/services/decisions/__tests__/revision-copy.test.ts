
import { describe, it, expect } from "vitest";
import { revisionPrompt } from "@/services/decisions/revision-copy";

describe("revisionPrompt", () => {
  it("asks meta_ads for a revised EXECUTABLE proposal", () => {
    const p = revisionPrompt(
      { id: "d1", decision_class: "meta_ads.update_ad_set_budget", body: {} },
      "make it smaller",
    );
    expect(p).toMatch(/revised proposal for approval/i);
    expect(p).toMatch(/do not execute/i);
  });

  it("keeps the meta_ads budget specifics that the old copy carried", () => {
    const p = revisionPrompt(
      {
        id: "d1",
        decision_class: "meta_ads.update_ad_set_budget",
        body: {
          expected_current_daily_budget_usd: 50,
          daily_budget_usd: 80,
        },
      },
      "smaller",
    );
    expect(p).toContain("50");
    expect(p).toContain("80");
  });

  it("asks a channel action for a rewritten INSTRUCTION, never an execution", () => {
    const p = revisionPrompt(
      {
        id: "d2",
        decision_class: "channel.recipe_step",
        body: { step: { title: "Add an H1 to the homepage" } },
      },
      "we are a marketplace not a SaaS",
    );
    expect(p).toMatch(/rewrite/i);
    expect(p).toContain("Add an H1 to the homepage");
    expect(p).not.toMatch(/proposal for approval/i);
  });

  it("names the specific action so the agent revises THAT one, not the whole run", () => {
    const p = revisionPrompt(
      {
        id: "d3",
        decision_class: "channel.recipe_step",
        body: {
          step: { title: "Build the /turo-alternative comparison page" },
          position: 4,
          of: 5,
        },
      },
      "shorter",
    );
    expect(p).toContain("Build the /turo-alternative comparison page");
    expect(p).toMatch(/4 of 5/);
  });

  it("falls back to a readable action name when a channel body has no step title", () => {
    const p = revisionPrompt(
      { id: "d5", decision_class: "channel.recipe_step", body: {} },
      "change it",
    );
    expect(p).toMatch(/rewrite/i);
    expect(p).toContain("this action");
  });

  it("falls back to generic phrasing for an unknown class rather than throwing", () => {
    expect(
      revisionPrompt(
        { id: "d4", decision_class: "some.new_class", body: {} },
        "change it",
      ),
    ).toMatch(/revise this proposal/i);
  });

  it("tolerates a null body", () => {
    expect(() =>
      revisionPrompt(
        { id: "d6", decision_class: "channel.recipe_step", body: null },
        "x",
      ),
    ).not.toThrow();
  });
});
