import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const del = vi.fn();
const computeReadiness = vi.fn();
const staff = { user_id: "u-1", email: "ravi@upcar.ai" };
let existingProductUrl: Record<string, string> = {};
const regenerateBrief = vi.hoisted(() => vi.fn(async (_tenant_id: string) => true));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => staff,
}));

vi.mock("@/services/readiness/compute", () => ({
  computeReadiness: (...args: unknown[]) => computeReadiness(...args),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/company/brief", () => ({
  regenerateCompanyBrief: (tenant_id: string) => regenerateBrief(tenant_id),
}));

vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: (reason: string) => {
    if (!reason || reason.length < 8) throw new Error("reason required");
    return {
      rpc,
      from: (table: string) =>
        table === "tenants"
          ? {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { product_url: existingProductUrl },
                    error: null,
                  }),
                }),
              }),
            }
          : {
              select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
              delete: () => ({ eq: () => ({ eq: del }) }),
            },
    };
  },
}));

import { staffCompanyFactsSet } from "../company-facts";

function mkRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

const req = (facts: unknown) =>
  ({ params: { tenant_id: "t-1" }, body: { facts } }) as never;

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ error: null });
  del.mockReset().mockResolvedValue({ error: null });
  computeReadiness.mockReset().mockResolvedValue(33);
  regenerateBrief.mockReset().mockResolvedValue(true);
  existingProductUrl = {};
});

describe("staffCompanyFactsSet", () => {
  it("writes a fact as human_confirmed and attributes it to the staff member who typed it", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "what_we_sell", value: "P2P car rental" }]), res as never);

    expect(rpc).toHaveBeenCalledWith(
      "set_tenant_fact",
      expect.objectContaining({
        p_tenant_id: "t-1",
        p_key: "what_we_sell",
        p_value_text: "P2P car rental",
        p_source: "human_confirmed",
        p_source_ref: expect.stringContaining("ravi@upcar.ai"),
      }),
    );
  });

  it("writes the domain through the single validated writer, not fact-then-projection", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "domain", value: "upcar.ai" }]), res as never);

    expect(rpc).toHaveBeenCalledWith(
      "set_tenant_company_domain_system",
      expect.objectContaining({
        p_tenant_id: "t-1",
        p_url: "https://upcar.ai",
        p_source: "human_confirmed",
      }),
    );
    expect(rpc).not.toHaveBeenCalledWith("set_tenant_fact", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("set_tenant_product_url_system", expect.anything());
  });

  it("surfaces an RPC validation reject as 422, not a 500", async () => {
    rpc.mockImplementation((fn: string) =>
      fn === "set_tenant_company_domain_system"
        ? { error: { code: "22023", message: "company domain: resolves to a private/loopback host" } }
        : { error: null },
    );
    const res = mkRes();
    await staffCompanyFactsSet(
      req([{ key: "domain", value: "https://169.254.169.254" }]),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "invalid_domain" }) }),
    );
  });

  it("recomputes readiness after a domain save so the score moves with the edit (not next cron)", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "domain", value: "upcar.ai" }]), res as never);
    expect(computeReadiness).toHaveBeenCalledWith("t-1");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("does NOT recompute readiness for a fact that moves no dimension", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "what_we_sell", value: "P2P car rental" }]), res as never);
    expect(computeReadiness).not.toHaveBeenCalled();
  });

  it("a recompute failure NEVER fails the save that already committed", async () => {
    computeReadiness.mockRejectedValueOnce(new Error("rpc down"));
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "domain", value: "upcar.ai" }]), res as never);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, written: ["domain"] }));
  });

  it("REJECTS an unknown key — the closed enum is the anti-rot guarantee", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "ceo_favourite_colour", value: "blue" }]), res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an empty value CLEARS the fact instead of writing an empty string", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "competitors", value: "  " }]), res as never);

    expect(del).toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ cleared: ["competitors"] }));
  });

  it("rejects a value over the 500-char column limit rather than letting the DB throw", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key: "who_we_serve", value: "x".repeat(501) }]), res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("staffCompanyFactsSet — retired + guarded keys", () => {
  it.each(["signup_url", "pricing_page"])("rejects the retired key %s with a 400", async (key) => {
    const res = mkRes();
    await staffCompanyFactsSet(req([{ key, value: "https://acme.com/x" }]), res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("normalizes competitors at the WRITE boundary — a price never reaches the DB", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(
      req([{ key: "competitors", value: "Retell AI - $0.08/min, Synthflow" }]),
      res as never,
    );
    expect(rpc).toHaveBeenCalledWith(
      "set_tenant_fact",
      expect.objectContaining({ p_key: "competitors", p_value_text: "Synthflow" }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: [{ key: "competitors", dropped: ["Retell AI - $0.08/min"] }] }),
    );
  });
});

describe("staffCompanyFactsSet — product_url merge (data-loss regression)", () => {
  it("delegates to the merging writer instead of replacing the whole product_url object", async () => {
    existingProductUrl = {
      marketing: "https://old.example.com",
      api: "https://api.example.com",
    };
    const res = mkRes();
    await staffCompanyFactsSet(
      req([{ key: "domain", value: "https://new.example.com" }]),
      res as never,
    );
    expect(rpc).toHaveBeenCalledWith(
      "set_tenant_company_domain_system",
      expect.objectContaining({ p_url: "https://new.example.com" }),
    );
    expect(rpc).not.toHaveBeenCalledWith("set_tenant_product_url_system", expect.anything());
  });
});

describe("staffCompanyFactsSet re-renders the company brief", () => {
  it("renders exactly once for a multi-field save", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(
      req([
        { key: "what_we_sell", value: "Fleet software" },
        { key: "who_we_serve", value: "Fleet operators" },
        { key: "markets", value: "US" },
      ]),
      res as never,
    );

    expect(regenerateBrief).toHaveBeenCalledTimes(1);
    expect(regenerateBrief).toHaveBeenCalledWith("t-1");
  });

  it("still renders when a later field fails and the route returns early", async () => {
    rpc.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: "boom" } });
    const res = mkRes();
    await staffCompanyFactsSet(
      req([
        { key: "what_we_sell", value: "Fleet software" },
        { key: "who_we_serve", value: "Fleet operators" },
      ]),
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(regenerateBrief).toHaveBeenCalledTimes(1);
  });

  it("does not render when nothing was written or cleared", async () => {
    const res = mkRes();
    await staffCompanyFactsSet(req([]), res as never);

    expect(regenerateBrief).not.toHaveBeenCalled();
  });
});
