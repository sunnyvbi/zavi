import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ binding: vi.fn(), resolve: vi.fn(), connector: vi.fn(), batch: vi.fn() }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: m.binding }));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({ resolveLinkedinAccount: m.resolve }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ withLinkedInAdsToken: m.connector }));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({ linkedinAdsBatchGet: m.batch }));

import { readAdReview, type ReviewRow } from "../revision";

const BINDING = "33333333-3333-4333-8333-333333333333";
const URN = "urn:li:share:7001";
const notConnected = () => Object.assign(new Error("not connected"), { code: "linkedin_ads_not_connected" });
let n = 0;
const card = (bindingId: string | null = BINDING): ReviewRow => ({
  id: `li-${++n}`, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle",
  exec_payload: { account_id: "11", ...(bindingId ? { account_binding_id: bindingId } : {}), campaign: { name: "Spring" }, creative: { post_urn: URN } },
  body: {}, status: "pending", exec_status: null, approved_by: null, score: 0, score_inputs: null, blocking: false, impact: null, impact_reason: null,
} as ReviewRow);

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.connector.mockRejectedValue(notConnected());
  m.batch.mockResolvedValue({ [URN]: { commentary: "The managed post" } });
});

describe("a founder who only uses the shared wallet has no LinkedIn connection to reconnect", () => {
  it("reads the post with the managed account and never asks for a reconnect", async () => {
    m.binding.mockResolvedValue({ funding_source: "wallet" });
    m.resolve.mockResolvedValue({ token: "managed-token" });
    const read = await readAdReview("t", card(), true);
    expect(read.connection_blocker).toBeNull();
    expect(m.connector).not.toHaveBeenCalled();
    expect(m.batch).toHaveBeenCalledWith("managed-token", "posts", [URN]);
    expect(read.review?.creatives[0]?.body).toBe("The managed post");
  });

  it.each([
    ["the managed account cannot be read", () => { m.resolve.mockRejectedValue(notConnected()); }],
    ["the post read fails", () => { m.resolve.mockResolvedValue({ token: "managed-token" }); m.batch.mockRejectedValue(notConnected()); }],
  ])("%s: the card keeps working with no reconnect ask", async (_label, arrange) => {
    m.binding.mockResolvedValue({ funding_source: "wallet" });
    arrange();
    const read = await readAdReview("t", card(), true);
    expect(read.connection_blocker).toBeNull();
    expect(m.connector).not.toHaveBeenCalled();
  });

  it.each([
    ["an own-billing account", () => { m.binding.mockResolvedValue({ funding_source: "provider" }); }, BINDING],
    ["a card with no saved account", () => undefined, null],
    ["a binding this workspace cannot read", () => { m.binding.mockRejectedValue(new Error("not found")); }, BINDING],
  ])("%s still asks for the reconnect it needs", async (_label, arrange, id) => {
    arrange();
    const read = await readAdReview("t", card(id), true);
    expect(read.connection_blocker).toEqual({ message: "reconnect LinkedIn Ads to publish this ad" });
    expect(m.resolve).not.toHaveBeenCalled();
  });
});
