import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached");
  },
}));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({ id: "dispatch-decision" }), send: vi.fn() } }));
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: vi.fn(async () => false) }));
const exec = vi.hoisted(() => ({ resume: vi.fn(async () => ({ ok: true })), budget: vi.fn(async () => ({ ok: true })), targeting: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/services/connectors/linkedin-ads/execute-change", () => ({ executeLinkedInResume: exec.resume, executeLinkedInBudgetChange: exec.budget, executeLinkedInTargetingChange: exec.targeting }));

import { __testOnly_handlers as HANDLERS, NEVER_AUTO_DECISION_CLASSES } from "../dispatch-decision";

const CLASSES = ["linkedin_ads.resume_campaign", "linkedin_ads.update_campaign_budget", "linkedin_ads.update_targeting"] as const;

describe("the LinkedIn change classes are wired and never auto-dispatched", () => {
  it.each(CLASSES)("%s is in the never-auto mirror", (cls) => {
    expect(NEVER_AUTO_DECISION_CLASSES.has(cls)).toBe(true);
  });

  it("each handler hands the claimed row (its id, tenant, body and approver source) to its executor, and nothing else", async () => {
    const d = { id: "d1", tenant_id: "t1", body: { campaign_id: "22" }, approved_by_source: null } as never;
    await HANDLERS["linkedin_ads.resume_campaign"](d);
    await HANDLERS["linkedin_ads.update_campaign_budget"](d);
    await HANDLERS["linkedin_ads.update_targeting"](d);
    for (const f of Object.values(exec)) expect(f).toHaveBeenCalledWith({ id: "d1", tenant_id: "t1", body: { campaign_id: "22" }, approved_by_source: null });
  });
});
