import { describe, expect, it, vi } from "vitest";
import { isEngineerDispatch, withEngineerRepo } from "../engineer-dispatch-repo";

const connected = vi.fn(async () => ({ repo: "acme/site", defaultBranch: "main" }));
const none = vi.fn(async () => null);

describe("isEngineerDispatch", () => {
  it("is every producer's dispatch card whose target is the engineer, and nothing else", () => {
    for (const cls of ["chief-of-staff.dispatch-specialist", "growth-lead.dispatch-specialist", "cgo.dispatch-specialist"]) {
      expect(isEngineerDispatch(cls, { target_agent_slug: "engineer", intent: "fix the signup form" })).toBe(true);
      expect(isEngineerDispatch(cls, { target_agent_slug: "performance-marketer", intent: "x" })).toBe(false);
    }
    expect(isEngineerDispatch("engineer.ship-pr", { target_agent_slug: "engineer" })).toBe(false);
    expect(isEngineerDispatch("growth-lead.dispatch-specialist", null)).toBe(false);
    expect(isEngineerDispatch("growth-lead.dispatch-specialist", "engineer")).toBe(false);
  });
});

describe("withEngineerRepo", () => {
  it("leaves a non-engineer card alone without reading anything", async () => {
    const body = { target_agent_slug: "performance-marketer", intent: "x" };
    expect(await withEngineerRepo("growth-lead.dispatch-specialist", body, none)).toBe(body);
    expect(await withEngineerRepo("social.publish.v2", { text: "hi" }, none)).toEqual({ text: "hi" });
    expect(none).not.toHaveBeenCalled();
  });

  it("checks a producer hint so site identity can be resolved", async () => {
    const body = { target_agent_slug: "engineer", intent: "x", repo_hint: "acme/site" };
    expect(await withEngineerRepo("cgo.dispatch-specialist", body, connected)).toEqual(body);
    expect(connected).toHaveBeenCalledWith("acme/site");
  });

  it("puts the server's repo on a chief-of-staff or growth-lead engineer card", async () => {
    const body = { target_agent_slug: "engineer", intent: "fix the signup form", dispatched_by: "growth-lead" };
    expect(await withEngineerRepo("growth-lead.dispatch-specialist", body, connected)).toEqual({ ...body, repo_hint: "acme/site" });
  });

  it("lets the card through unhinted when the tenant has repos but no single one to name", async () => {
    const body = { target_agent_slug: "engineer", intent: "x" };
    expect(await withEngineerRepo("growth-lead.dispatch-specialist", body, async () => ({}))).toBe(body);
  });

  it("refuses the card when the tenant has no connected or provisioned repo", async () => {
    expect(
      await withEngineerRepo("chief-of-staff.dispatch-specialist", { target_agent_slug: "engineer", intent: "x" }, none),
    ).toBeNull();
    expect(
      await withEngineerRepo("chief-of-staff.dispatch-specialist", { target_agent_slug: "engineer", repo_hint: "  " }, none),
    ).toBeNull();
  });
});
