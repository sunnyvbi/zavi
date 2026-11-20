
import { describe, it, expect, vi } from "vitest";

const stripeCreate = vi.fn();
vi.mock("@/services/billing/client", () => ({
  billingStripe: () => ({ checkout: { sessions: { create: stripeCreate } } }),
}));
const tenantRpc = vi.fn();
vi.mock("@/services/tenant-client", () => ({ tenantRpc }));

import { startupOfferCheckout } from "../startup-offer";

describe("startup offer retired", () => {
  it("returns 410 offer_retired and never claims a seat or opens Checkout", async () => {
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { this.body = b; return this; },
    };
    await startupOfferCheckout({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({ error: expect.objectContaining({ code: "offer_retired" }) });
    expect(stripeCreate).not.toHaveBeenCalled();
    expect(tenantRpc).not.toHaveBeenCalled();
  });
});
