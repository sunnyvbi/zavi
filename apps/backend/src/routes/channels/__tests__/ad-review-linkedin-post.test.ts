import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn(), media: vi.fn(), row: {} as Record<string, unknown> }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: async () => "owner", requireTenantRole: async () => true }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: async () => null }));
vi.mock("@/services/channels/ad-review/media", () => ({ resolveAdReviewMedia: m.media }));
vi.mock("@/services/tenant-client", () => ({
  tenantRpc: m.rpc,
  tenantClient: () => ({ from: () => { const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: m.row, error: null }) }; return q; } }),
}));

import { channelAdPreview, channelAdReview, channelAdRevise } from "../ad-review";
import { adReviewVersion } from "@/services/channels/ad-review/version";

const ID = "10000000-0000-4000-8000-000000000001";
const OWN_POST = "urn:li:share:7000000000000000001";
const OTHER_COMPANY_POST = "urn:li:share:7000000000000000099";
const payload = {
  account_id: "11",
  account_binding_id: "20000000-0000-4000-8000-000000000002",
  group: { name: "First test" },
  campaign: { name: "Pilot", daily_budget: { amount: "18", currency: "USD" }, unit_cost: { amount: "6", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: "urn:li:organization:42" },
  creative: { post_urn: OWN_POST },
};
const res = () => {
  const r: { statusCode: number; body: unknown; status(n: number): typeof r; json(b: unknown): typeof r; setHeader(): void } = {
    statusCode: 200, body: null,
    status(n) { r.statusCode = n; return r; },
    json(b) { r.body = b; return r; },
    setHeader() {},
  };
  return r;
};

beforeEach(() => {
  m.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tenant", user_id: "owner-1" });
  m.rpc.mockReset().mockResolvedValue({ data: { ok: true, action_id: "30000000-0000-4000-8000-000000000003" }, error: null });
  m.media.mockReset().mockImplementation(async (_t: string, _c: string, _p: unknown, review: unknown) => review);
  m.row = { id: ID, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: structuredClone(payload), body: { exact_change: { rows: [{ item: "Promoted post", before: "Not chosen", after: `https://www.linkedin.com/feed/update/${OWN_POST}` }] } }, status: "pending", exec_status: null, exec_result: null, approved_by: null, score: 0, score_inputs: {}, blocking: false, impact: null, impact_reason: null };
});

describe("the ad-review editor on a prepared LinkedIn sponsored-post card", () => {
  const revision = () => adReviewVersion("linkedin_ads.create_campaign_bundle", payload);

  it("offers no field that swaps the promoted post, since that would skip the post check prepare ran", async () => {
    const r = res();
    await channelAdReview({ params: { id: ID }, query: {} } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ editable: false, fields: [] });
    expect(JSON.stringify(r.body)).not.toMatch(/Source post URN|creative\.post_urn/);
  });

  it("refuses to save another company's post into the card, and files no new pending card", async () => {
    const r = res();
    await channelAdRevise({ params: { id: ID }, body: { revision: revision(), changes: { "creative.post_urn": OTHER_COMPANY_POST }, request_id: "req-12345678" } } as never, r as never);
    expect(r.statusCode).toBe(422);
    expect(m.rpc).not.toHaveBeenCalled();
    expect((m.row.exec_payload as typeof payload).creative.post_urn).toBe(OWN_POST);
  });

  it("does not preview the swapped post either", async () => {
    const r = res();
    await channelAdPreview({ params: { id: ID }, body: { revision: revision(), changes: { "creative.post_urn": OTHER_COMPANY_POST } } } as never, r as never);
    expect(r.statusCode).toBe(409);
    expect(m.media).not.toHaveBeenCalled();
  });
});
