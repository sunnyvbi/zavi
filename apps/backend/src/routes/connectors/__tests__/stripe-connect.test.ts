import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rpc: vi.fn(),
  retrieve: vi.fn(),
  chargesList: vi.fn(),
  recordAccountGeo: vi.fn(),
  autoSet: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/services/company/country-inference", () => ({
  recordAccountGeo: mocks.recordAccountGeo,
  autoSetCompanyCountryInBackground: mocks.autoSet,
}));
vi.mock("stripe", () => ({
  default: class {
    charges = { list: mocks.chargesList };
    accounts = { retrieve: mocks.retrieve };
  },
}));

import { stripeConnect } from "../stripe";

function mockRes() {
  const res: {
    statusCode: number;
    body: unknown;
    status: (c: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.rpc.mockReset();
  mocks.retrieve.mockReset();
  mocks.chargesList.mockReset();
  mocks.recordAccountGeo.mockReset();
  mocks.autoSet.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1" });
  mocks.chargesList.mockResolvedValue({ data: [] });
});

describe("stripeConnect — validate-before-store", () => {
  it("400s a publishable key and never probes or stores", async () => {
    const res = mockRes();
    await stripeConnect({ body: { api_key: "pk_live_abc12345" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("400s a too-short key with no probe", async () => {
    const res = mockRes();
    await stripeConnect({ body: { api_key: "rk_x" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a key Stripe refuses at the charges probe and NEVER stores it (no rpc call)", async () => {
    mocks.chargesList.mockRejectedValueOnce(
      Object.assign(new Error("Invalid API Key provided: rk_live_secret"), {
        type: "StripeAuthenticationError",
        statusCode: 401,
      }),
    );
    const res = mockRes();
    await stripeConnect({ body: { api_key: "rk_live_badkey9999" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("stripe_key_invalid");
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("rk_live_badkey9999");
  });

  it("connects a valid key even when accounts.retrieve() 403s (best-effort metadata)", async () => {
    mocks.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), {
        type: "StripePermissionError",
        statusCode: 403,
      }),
    );
    mocks.rpc.mockResolvedValueOnce({ error: null });
    const res = mockRes();
    await stripeConnect({ body: { api_key: "rk_live_scopedkey12" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("set_stripe_connection", {
      p_tenant_id: "tnt-1",
      p_api_key: "rk_live_scopedkey12",
      p_account_id: null,
      p_account_email: null,
      p_country: null,
      p_default_currency: null,
      p_capabilities: [],
    });
  });

  it("stores via set_stripe_connection only after a passing probe, with real account metadata", async () => {
    mocks.retrieve.mockResolvedValueOnce({
      id: "acct_123",
      email: "ops@acme.com",
      country: "US",
      default_currency: "usd",
      capabilities: { card_payments: "active", transfers: "inactive" },
    });
    mocks.rpc.mockResolvedValueOnce({ error: null });
    const res = mockRes();
    await stripeConnect(
      { body: { api_key: "rk_live_goodkey4567" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("set_stripe_connection", {
      p_tenant_id: "tnt-1",
      p_api_key: "rk_live_goodkey4567",
      p_account_id: "acct_123",
      p_account_email: "ops@acme.com",
      p_country: "US",
      p_default_currency: "usd",
      p_capabilities: ["card_payments"],
    });
  });

  it("keeps the account country as a company-country signal and asks Zavi to set the country", async () => {
    mocks.retrieve.mockResolvedValueOnce({ id: "acct_123", country: "GB", capabilities: {} });
    mocks.rpc.mockResolvedValueOnce({ error: null });
    const res = mockRes();
    await stripeConnect({ body: { api_key: "rk_live_goodkey4567" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.recordAccountGeo).toHaveBeenCalledWith("tnt-1", "stripe", { for: "acct_123", countries: ["GB"], timezones: [] });
    expect(mocks.autoSet).toHaveBeenCalledWith("tnt-1");
  });

  it("stores no country when accounts.retrieve() 403s, and never on a failed save", async () => {
    mocks.retrieve.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { statusCode: 403 }));
    mocks.rpc.mockResolvedValueOnce({ error: null });
    await stripeConnect({ body: { api_key: "rk_live_scopedkey12" } } as never, mockRes() as never);
    expect(mocks.recordAccountGeo).not.toHaveBeenCalled();

    mocks.retrieve.mockResolvedValueOnce({ id: "acct_9", country: "US", capabilities: {} });
    mocks.rpc.mockResolvedValueOnce({ error: { code: "23505", message: "x" } });
    mocks.autoSet.mockReset();
    await stripeConnect({ body: { api_key: "rk_live_goodkey7890" } } as never, mockRes() as never);
    expect(mocks.recordAccountGeo).not.toHaveBeenCalled();
    expect(mocks.autoSet).not.toHaveBeenCalled();
  });

  it("500s on an RPC error and NEVER echoes the key or RPC detail to the client", async () => {
    mocks.retrieve.mockResolvedValueOnce({ id: "acct_9", capabilities: {} });
    mocks.rpc.mockResolvedValueOnce({
      error: { code: "23505", message: "secret-bearing detail" },
    });
    const res = mockRes();
    await stripeConnect({ body: { api_key: "rk_live_goodkey7890" } } as never, res as never);
    expect(res.statusCode).toBe(500);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("rk_live_goodkey7890");
    expect(serialized).not.toContain("secret-bearing detail");
    expect((res.body as { error: { code: string } }).error.code).toBe("stripe_connect_failed");
  });

  it("returns early when auth fails (requireAuth already responded)", async () => {
    mocks.requireAuth.mockResolvedValueOnce(null);
    const res = mockRes();
    await stripeConnect({ body: { api_key: "rk_live_anything000" } } as never, res as never);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
