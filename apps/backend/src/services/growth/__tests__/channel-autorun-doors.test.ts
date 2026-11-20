import { beforeEach, describe, expect, it, vi } from "vitest";

const BAKERY = "33333333-3333-4333-8333-333333333333";

const effective = vi.fn(async (_t: string, slug: string, _w?: string) => slug !== "email_marketing");
const view = vi.fn(async (_t: string, _w?: string) => ({ effectiveSet: () => new Set(["seo", "meta_ads"]) }));
vi.mock("../channel-autorun", async (orig) => ({
  ...((await orig()) as object),
  readEffectiveAutorun: (t: string, s: string, w?: string) => effective(t, s, w),
  readChannelAutorunView: (t: string, w?: string) => view(t, w),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    throw new Error("a door read tenant_channels directly");
  },
}));

import { readChannelAutorun } from "../unattended-policy";
import { readAutorunChannels } from "../goal-owner";
import { loadUnattendedEmailFacts } from "../unattended-email";

beforeEach(() => {
  effective.mockClear();
  view.mockClear();
});

describe("each door uses the shared reader", () => {
  it("the unattended gate's channel read (x, reddit, chatgpt, email, dispatch re-check)", async () => {
    expect(await readChannelAutorun(BAKERY, "seo")).toBe(true);
    expect(await readChannelAutorun(BAKERY, "email_marketing")).toBe(false);
    expect(effective).toHaveBeenCalledWith(BAKERY, "seo", "unattended-policy");
  });

  it("cgo's review: the channels it may start", async () => {
    expect([...(await readAutorunChannels(BAKERY))].sort()).toEqual(["meta_ads", "seo"]);
    expect(view).toHaveBeenCalledWith(BAKERY, "goal-owner");
  });

  it("the email send gate's 'set to run on its own' fact", async () => {
    const facts = await loadUnattendedEmailFacts(
      BAKERY,
      { action_id: "a1", exec_class: "email_campaign.create_and_send", payload: {}, audience_count: 10 },
      { autopilotOn: async () => true, sentRecently: async () => false },
    );
    expect(facts.channel_autorun_on).toBe(false);
    expect(effective).toHaveBeenCalledWith(BAKERY, "email_marketing", "unattended-policy");
  });
});
