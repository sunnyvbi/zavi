import { describe, expect, it } from "vitest";
import { landedChanges, newCampaignState } from "./editorSave";

const change = (approved = true, decision_id = "d-1") => ({ label: "New campaign", decision_id, approved, code: approved ? null : "budget_choice_required" });

describe("newCampaignState", () => {
  it("only a create the platform took says it was built", () => {
    expect(newCampaignState([])).toBe("open");
    expect(newCampaignState([{ change: change(), outcome: { state: "done" } }])).toBe("done");
  });

  it("a create waiting in Approvals is not built, and blocks a second build", () => {
    expect(newCampaignState([{ change: change(false), outcome: null }])).toBe("waiting");
    expect(newCampaignState([{ change: change(false), outcome: { state: "waiting" } }])).toBe("waiting");
  });

  it("an approved create still on its way is not built either", () => {
    expect(newCampaignState([{ change: change(), outcome: null }])).toBe("sending");
    expect(newCampaignState([{ change: change(), outcome: { state: "running" } }])).toBe("sending");
  });

  it("a refused create, or a Save that failed before staging, leaves the form open", () => {
    expect(newCampaignState([{ change: change(), outcome: { state: "refused" } }])).toBe("open");
    expect(newCampaignState([{ change: change(false, ""), outcome: { state: "refused" } }])).toBe("open");
  });
});

describe("landedChanges", () => {
  it("reads the staged changes a partly failed Save sends with its error", () => {
    const e = Object.assign(new Error("x"), { body: { changes: [change(), { label: "bad" }, change(true, "")] } });
    expect(landedChanges(e)).toEqual([change()]);
    expect(landedChanges(new Error("x"))).toEqual([]);
    expect(landedChanges(null)).toEqual([]);
  });
});
