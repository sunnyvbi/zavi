
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const start = vi.fn();
vi.mock("@/services/creators/booking", async (orig) => ({
  ...(await orig<typeof import("@/services/creators/booking")>()),
  startCreatorCheckout: (...a: unknown[]) => start(...a),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "t1", user_id: "u1", access_token: "x" }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
const findByOffer = vi.fn(async () => null as { id: string } | null);
const loadCheckout = vi.fn(async () => null as { id: string; agent_run_id: string | null } | null);
vi.mock("@/services/creators/booking-db", async (orig) => ({
  ...(await orig<typeof import("@/services/creators/booking-db")>()),
  findOrderByOffer: (...a: unknown[]) => findByOffer(...(a as [])),
  loadOrderForCheckout: (...a: unknown[]) => loadCheckout(...(a as [])),
}));
const resume = vi.fn();
vi.mock("@/services/creators/checkout-resume", () => ({ resumeOrderCheckout: (...a: unknown[]) => resume(...a) }));

const offerView = vi.fn(async () => ({ expired: false }) as { expired: boolean; agent_run_id?: string | null } | null);
vi.mock("@/services/creators/offers", async (orig) => ({
  ...(await orig<typeof import("@/services/creators/offers")>()),
  getOfferView: (...a: unknown[]) => offerView(...(a as [])),
}));

import { postCreatorOfferCheckout } from "@/routes/creators/offers";

function res() {
  const r = { statusCode: 200, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } };
  return r;
}
const OFFER = "11111111-1111-4111-8111-111111111111";

describe("offer checkout resume", () => {
  it("reuses the offer's order through the claimed-offer path and returns to the job drawer", async () => {
    process.env.WEB_ORIGIN = "https://www.zaviagent.com";
    start.mockResolvedValue({ order_id: "o1", checkout_url: "https://checkout.test/s", reused_existing: true });
    const r = res();
    await postCreatorOfferCheckout({ params: { offer_id: OFFER }, body: {} } as unknown as Request, r as unknown as Response);
    expect(r.body).toEqual({ ok: true, order_id: "o1", checkout_url: "https://checkout.test/s" });
    const args = start.mock.calls[0][0];
    expect(args).toMatchObject({ tenant_id: "t1", target: { source: "offer", offer_id: OFFER }, offer_already_claimed: true });
    expect(args.success_url).toBe("https://www.zaviagent.com/workspace?tab=channels&channel=ugc&drawer=job&job={ORDER_ID}&paid=1");
  });

  it("an offer that already has its order reopens THAT order, never booking a second", async () => {
    start.mockClear();
    findByOffer.mockResolvedValueOnce({ id: "o9" });
    resume.mockResolvedValueOnce({ order_id: "o9", checkout_url: "https://checkout.test/o9" });
    const r = res();
    await postCreatorOfferCheckout({ params: { offer_id: OFFER }, body: {} } as unknown as Request, r as unknown as Response);
    expect(r.body).toEqual({ ok: true, order_id: "o9", checkout_url: "https://checkout.test/o9" });
    expect(resume).toHaveBeenCalledWith({ tenant_id: "t1", order_id: "o9" });
    expect(start).not.toHaveBeenCalled();
  });

  it("an expired offer cannot be paid: no resume, no new checkout", async () => {
    start.mockClear();
    resume.mockClear();
    offerView.mockResolvedValueOnce({ expired: true });
    findByOffer.mockResolvedValueOnce({ id: "o9" });
    const r = res();
    await postCreatorOfferCheckout({ params: { offer_id: OFFER }, body: {} } as unknown as Request, r as unknown as Response);
    expect(r.statusCode).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("offer_expired");
    expect(resume).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses a bad id without touching checkout", async () => {
    start.mockClear();
    const r = res();
    await postCreatorOfferCheckout({ params: { offer_id: "nope" }, body: {} } as unknown as Request, r as unknown as Response);
    expect(r.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("an agent offer's Pay button is refused with 409 before any order lookup, resume or Checkout", async () => {
    start.mockClear();
    resume.mockClear();
    findByOffer.mockClear();
    offerView.mockResolvedValueOnce({ expired: false, agent_run_id: "run-1" });
    const r = res();
    await postCreatorOfferCheckout({ params: { offer_id: OFFER }, body: {} } as unknown as Request, r as unknown as Response);
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({
      error: { code: "creator_hire_awaiting_approval", message: "This hire is waiting for the founder's approval on its hire card." },
    });
    expect(findByOffer).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("an existing order stamped by an agent is refused with 409 and never resumed", async () => {
    start.mockClear();
    resume.mockClear();
    findByOffer.mockReset();
    findByOffer.mockResolvedValueOnce({ id: "o9" });
    loadCheckout.mockResolvedValueOnce({ id: "o9", agent_run_id: "run-1" });
    const r = res();
    await postCreatorOfferCheckout({ params: { offer_id: OFFER }, body: {} } as unknown as Request, r as unknown as Response);
    expect(r.statusCode).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("creator_hire_awaiting_approval");
    expect(loadCheckout).toHaveBeenCalledWith("t1", "o9");
    expect(resume).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("a person's own offer order with no agent stamp still resumes", async () => {
    resume.mockClear();
    findByOffer.mockReset();
    findByOffer.mockResolvedValueOnce({ id: "o7" });
    loadCheckout.mockResolvedValueOnce({ id: "o7", agent_run_id: null });
    resume.mockResolvedValueOnce({ order_id: "o7", checkout_url: "https://checkout.test/o7" });
    const r = res();
    await postCreatorOfferCheckout({ params: { offer_id: OFFER }, body: {} } as unknown as Request, r as unknown as Response);
    expect(r.statusCode).toBe(200);
    expect(resume).toHaveBeenCalledWith({ tenant_id: "t1", order_id: "o7" });
  });
});
