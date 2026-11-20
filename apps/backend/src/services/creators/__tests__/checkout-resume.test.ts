
import { describe, expect, it, vi } from "vitest";
import { resumeCreatorCheckout, type CreatorMoneyDeps } from "../orders-money";
import { resumeOrderCheckout, resumeReturnUrls, type ResumeDeps } from "../checkout-resume";
import { computeCreatorFees } from "../order-fees";

const fees = computeCreatorFees(15000);
const order = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  tenant_id: "t1",
  human_member_id: "m1",
  livemode: false,
  currency: "usd",
  price_cents: 15000,
  business_fee_cents: fees.business_fee_cents,
  creator_fee_cents: fees.creator_fee_cents,
  business_total_cents: fees.business_total_cents,
  creator_payout_cents: fees.creator_payout_cents,
  payout_amount_cents: null,
  status: "checkout_pending",
  payout_status: "none",
  stripe_checkout_session_id: null as string | null,
  stripe_payment_intent_id: null,
  stripe_transfer_id: null,
  hold_expires_at: null,
  ...over,
});

function money(row: ReturnType<typeof order>, session?: { status: string; url: string | null }) {
  const create = vi.fn(async (_body: unknown, opts: { idempotencyKey: string }) => ({ id: `cs_new_${opts.idempotencyKey}`, url: "https://checkout.test/new" }));
  const retrieve = vi.fn(async (id: string) => ({ id, ...(session ?? { status: "expired", url: null }) }));
  const deps = {
    loadOrder: async () => row,
    platformKey: () => "sk_test_x",
    stripe: () => ({ checkout: { sessions: { create, retrieve } } }),
  } as unknown as CreatorMoneyDeps;
  return { deps, create, retrieve };
}
const args = { tenant_id: "t1", order_id: "o1", creator_country: "US", success_url: "s", cancel_url: "c" };

describe("resumeCreatorCheckout", () => {
  it("hands back the order's own open session and creates nothing", async () => {
    const m = money(order({ stripe_checkout_session_id: "cs_1" }), { status: "open", url: "https://checkout.test/cs_1" });
    const r = await resumeCreatorCheckout(args, m.deps);
    expect(r).toMatchObject({ url: "https://checkout.test/cs_1", reused_session: true });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("refuses when the session already completed: the money is in", async () => {
    const m = money(order({ stripe_checkout_session_id: "cs_1" }), { status: "complete", url: null });
    await expect(resumeCreatorCheckout(args, m.deps)).rejects.toMatchObject({ code: "checkout_already_paid" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("opens a new session for the SAME order once the old one expired, keyed on the expired one", async () => {
    const m = money(order({ stripe_checkout_session_id: "cs_1" }));
    await resumeCreatorCheckout(args, m.deps);
    expect(m.create.mock.calls[0][1].idempotencyKey).toBe("cr-checkout-o1:after-cs_1");
    expect((m.create.mock.calls[0][0] as { client_reference_id: string }).client_reference_id).toBe("o1");
  });

  it("with no session recorded, reuses the ORIGINAL key so a never-attached session is handed back", async () => {
    const m = money(order());
    await resumeCreatorCheckout(args, m.deps);
    expect(m.create.mock.calls[0][1].idempotencyKey).toBe("cr-checkout-o1");
  });

  it("finds a never-attached session made with the /humans return URLs, with the SAME key", async () => {
    const m = money(order());
    m.create.mockImplementation(async (body: unknown, opts: { idempotencyKey: string }) => {
      if ((body as { success_url: string }).success_url !== "humans-s") throw new Error("idempotency key reused with different parameters");
      return { id: `cs_orig_${opts.idempotencyKey}`, url: "https://checkout.test/orig" };
    });
    const r = await resumeCreatorCheckout({ ...args, alternate_urls: [{ success_url: "humans-s", cancel_url: "humans-c" }] }, m.deps);
    expect(r.url).toBe("https://checkout.test/orig");
    expect(m.create.mock.calls.map((c) => c[1].idempotencyKey)).toEqual(["cr-checkout-o1", "cr-checkout-o1"]);
  });

  it("refuses an order that is no longer waiting for payment", async () => {
    const m = money(order({ status: "in_progress" }));
    await expect(resumeCreatorCheckout(args, m.deps)).rejects.toMatchObject({ code: "creator_order_not_awaiting_checkout" });
  });
});

describe("resumeOrderCheckout", () => {
  const job = { id: "o1", human_member_id: "m1", source: "booking", brief_id: null, application_id: null, package_snapshot: { title: "1 video" } };
  it("reopens the order it was asked for and records a NEW session only", async () => {
    const attach = vi.fn();
    const resume = vi.fn(async () => ({ checkout_session_id: "cs_2", url: "https://checkout.test/cs_2", amount_cents: 16500, reused_session: false }));
    const deps = {
      loadJob: async () => job,
      loadCreator: async () => ({ country_code: "US" }),
      resume,
      attach,
      offerExpired: async () => false,
    } as unknown as ResumeDeps;
    process.env.WEB_ORIGIN = "https://www.zaviagent.com";
    const r = await resumeOrderCheckout({ tenant_id: "t1", order_id: "o1" }, deps);
    expect(r).toEqual({ order_id: "o1", checkout_url: "https://checkout.test/cs_2" });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ order_id: "o1", creator_country: "US" }));
    expect(attach).toHaveBeenCalledWith({ tenant_id: "t1", order_id: "o1", checkout_session_id: "cs_2" });
  });

  it("refuses to reopen payment for an offer that has expired, and opens nothing at Stripe", async () => {
    const resume = vi.fn();
    const offerExpired = vi.fn(async () => true);
    const deps = {
      loadJob: async () => ({ ...job, source: "offer", offer_id: "of1" }),
      loadCreator: async () => ({ country_code: "US" }),
      resume,
      attach: vi.fn(),
      offerExpired,
    } as unknown as ResumeDeps;
    await expect(resumeOrderCheckout({ tenant_id: "t1", order_id: "o1" }, deps)).rejects.toMatchObject({ code: "offer_expired" });
    expect(offerExpired).toHaveBeenCalledWith("t1", "of1");
    expect(resume).not.toHaveBeenCalled();
  });

  it("still reopens payment for an offer that has not expired", async () => {
    const resume = vi.fn(async () => ({ checkout_session_id: "cs_3", url: "https://checkout.test/cs_3", amount_cents: 16500, reused_session: true }));
    const deps = {
      loadJob: async () => ({ ...job, source: "offer", offer_id: "of1" }),
      loadCreator: async () => ({ country_code: "US" }),
      resume,
      attach: vi.fn(),
      offerExpired: async () => false,
    } as unknown as ResumeDeps;
    const r = await resumeOrderCheckout({ tenant_id: "t1", order_id: "o1" }, deps);
    expect(r.checkout_url).toBe("https://checkout.test/cs_3");
  });

  it("returns a booking to its own job drawer either way", () => {
    process.env.WEB_ORIGIN = "https://www.zaviagent.com";
    expect(resumeReturnUrls({ id: "o1", source: "booking", brief_id: null, application_id: null })).toEqual({
      success_url: "https://www.zaviagent.com/workspace?tab=channels&channel=ugc&drawer=job&job=o1&paid=1",
      cancel_url: "https://www.zaviagent.com/workspace?tab=channels&channel=ugc&drawer=job&job=o1&cancelled=1",
    });
  });
});
