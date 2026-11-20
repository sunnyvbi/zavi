import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, founderRuns: [] as string[], recorded: [] as unknown[], tables: [] as string[], fail: false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      m.tables.push(table);
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "is", "in", "order", "limit"]) q[k] = () => q;
      q.then = (resolve: (v: unknown) => void) => resolve(table === "channel_actions" ? (m.fail && m.tables.filter((t) => t === "channel_actions").length > 1 ? { data: null, error: { message: "down" } } : { data: m.rows, error: null }) : { data: m.founderRuns.map((id) => ({ id })), error: null });
      return q;
    },
  }),
}));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", () => ({ isLinkedInAdsWriteEnabled: async () => true }));
vi.mock("@/services/growth/goal-owner", () => ({ goalToday: async () => "2026-11-03" }));
vi.mock("./../propose-pause", () => ({ insertFounderRun: async () => "run-founder-new" }));
vi.mock("@/services/channels/channel-actions", () => ({
  recordChannelRunActions: async (input: { envelope: unknown }) => { m.recorded.push(input.envelope); return { ids: [{ id: "card-new" }], kept: [] }; },
}));

import { fileFounderCampaignDraft, founderCampaignDraftStep } from "../propose-campaign-draft";

const presentation = (over: Record<string, unknown>) => ({ type: "campaign_draft", channel: "linkedin_ads", name: "Model draft", group_name: "Buyers", rationale: "Why", post_preview: "First lines", country: "US", language: "en", ...over });
const card = (id: string, run_id: string, pres: Record<string, unknown>) => ({ id, run_id, body: { step: { responsibility: "client", deliverable: { presentation: pres } } } });
const filed = () => (m.recorded[0] as { steps: Array<ReturnType<typeof founderCampaignDraftStep>> }).steps[0].deliverable.presentation;

beforeEach(() => { m.rows = []; m.founderRuns = []; m.recorded = []; m.tables = []; m.fail = false; });

describe("a founder-started LinkedIn draft starts from Zavi's latest plan", () => {
  it("copies the newest model draft's audience, places and post, skipping a newer founder draft and a model draft with nothing to suggest", async () => {
    m.founderRuns = ["run-founder-old"];
    m.rows = [
      card("c1", "run-founder-old", presentation({ audience_suggestions: { titles: ["Nobody"] }, rationale: "founder" })),
      card("c2", "run-model-empty", presentation({})),
      card("c3", "run-model", presentation({ post_urn: "urn:li:share:7123456789012345678", post_preview: "Our launch post", locations: ["Canada"], excluded_locations: ["Quebec"], audience_suggestions: { seniorities: ["Senior"], industries: ["Software"] } })),
      card("c4", "run-model-older", presentation({ audience_suggestions: { titles: ["CEO"] } })),
    ];
    const out = await fileFounderCampaignDraft("tenant-1", {}, new Date("2026-11-03T10:00:00Z"));
    expect(out).toEqual({ action_id: "card-new", reused: false });
    const pres = filed();
    expect(pres.name).toBe("LinkedIn campaign - 2026-11-03");
    expect(pres.post_urn).toBe("urn:li:share:7123456789012345678");
    expect(pres.post_preview).toBe("Our launch post");
    expect(pres.locations).toEqual(["Canada"]);
    expect(pres.excluded_locations).toEqual(["Quebec"]);
    expect(pres.audience_suggestions).toMatchObject({ seniorities: ["Senior"], industries: ["Software"] });
    expect(pres.audience_suggestions?.titles ?? []).toEqual([]);
    expect(pres.rationale).toMatch(/filled in the audience, places and post/);
  });

  it("with no model draft, files the plain placeholder draft", async () => {
    await fileFounderCampaignDraft("tenant-1", {}, new Date("2026-11-03T10:00:00Z"));
    const pres = filed();
    expect(pres.post_urn).toBeUndefined();
    expect(pres.audience_suggestions).toBeUndefined();
    expect(pres.post_preview).toBe("Paste the link to the company post when you review this draft.");
    expect(pres.rationale).toMatch(/Pick the company post to promote/);
  });

  it("never carries a model draft's text as the post when that draft named no post", async () => {
    m.rows = [card("c3", "run-model", presentation({ post_preview: "Suggested text only", audience_suggestions: { titles: ["CEO"] } }))];
    await fileFounderCampaignDraft("tenant-1", {}, new Date("2026-11-03T10:00:00Z"));
    const pres = filed();
    expect(pres.post_urn).toBeUndefined();
    expect(pres.post_preview).toBe("Paste the link to the company post when you review this draft.");
    expect(pres.audience_suggestions).toMatchObject({ titles: ["CEO"] });
  });

  it("still files the draft when the earlier drafts cannot be read for the seed", async () => {
    m.fail = true;
    const out = await fileFounderCampaignDraft("tenant-1", {}, new Date("2026-11-03T10:00:00Z"));
    expect(out.action_id).toBe("card-new");
    expect(filed().audience_suggestions).toBeUndefined();
  });
});
