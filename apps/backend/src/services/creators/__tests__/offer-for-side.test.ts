import { describe, expect, it } from "vitest";
import { isOfferExpired, offerForSide, toOfferView, type OfferRow } from "../offers";

const row: OfferRow = {
  id: "o1",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  human_member_id: "m1",
  thread_id: "t1",
  proposed_by: "tenant",
  kind: "ugc_video",
  terms: { title: "2 TikTok videos" },
  price_cents: 30000,
  currency: "usd",
  delivery_days: 7,
  note: null,
  status: "open",
  expires_at: "2999-01-01T00:00:00.000Z",
  responded_at: null,
  created_at: "2026-09-25T00:00:00.000Z",
};

describe("offerForSide", () => {
  const view = toOfferView(row, new Date("2026-09-25T01:00:00Z"));

  it("strips tenant_id for the creator and keeps what the card renders", () => {
    const out = offerForSide(view, "creator");
    expect(out).not.toHaveProperty("tenant_id");
    expect(JSON.stringify(out)).not.toContain(row.tenant_id);
    expect(out).toMatchObject({ id: "o1", price_cents: 30000, expired: false, fees: view.fees });
  });

  it("leaves the business view whole", () => {
    expect(offerForSide(view, "tenant")).toBe(view);
  });
});

describe("an offer whose agreed due date has ended is expired (E2E 2026-09-27 P2)", () => {
  const exp = "2026-09-30T00:00:00.000Z";
  it("is live through the agreed day and dead after it", () => {
    const terms = { due_date: "2026-09-28" };
    expect(isOfferExpired({ expires_at: exp, terms }, new Date("2026-09-28T23:00:00.000Z"))).toBe(false);
    expect(isOfferExpired({ expires_at: exp, terms }, new Date("2026-09-29T00:00:00.000Z"))).toBe(true);
  });
  it("an offer of N days only expires on its 72h clock", () => {
    expect(isOfferExpired({ expires_at: exp, terms: {} }, new Date("2026-09-29T12:00:00.000Z"))).toBe(false);
  });
});
