import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const del = vi.fn();
const computeReadiness = vi.fn();
const canonicalizeUrl = vi.fn();
const competitorsFromIdea = vi.fn();

let membershipRole: string | null = "owner";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({
    user_id: "u-1",
    tenant_id: "auth-tenant",
    access_token: "tok",
  }),
}));

vi.mock("@/services/readiness/compute", () => ({
  computeReadiness: (...a: unknown[]) => computeReadiness(...a),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));

let ssrfVerdict: string | null = null;
let existingProductUrl: Record<string, string> = {};
vi.mock("@/services/onboarding/enrichment/url-guard", () => {
  class FakeSsrf extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
      this.name = "SsrfBlockedError";
    }
  }
  return {
    SsrfBlockedError: FakeSsrf,
    assertSafeUrl: async () => {
      if (ssrfVerdict) throw new FakeSsrf(ssrfVerdict);
      return new URL("https://ok.example");
    },
  };
});

vi.mock("@/services/company/idea-competitors", () => ({
  competitorsFromIdea: (...a: unknown[]) => competitorsFromIdea(...a),
}));

vi.mock("./../tenant-product-url", () => ({
  canonicalizeUrl: (...a: unknown[]) => canonicalizeUrl(...a),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () =>
              membershipRole === null
                ? { data: null, error: null }
                : { data: { role: membershipRole }, error: null },
          }),
        }),
      }),
    }),
  }),
  serviceClient: () => ({
    rpc,
    from: (table: string) =>
      table === "tenants"
        ? {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { product_url: existingProductUrl }, error: null }) }),
            }),
          }
        : { delete: () => ({ eq: () => ({ eq: del }) }) },
  }),
}));

import { companyCompetitorSuggestionsHandler, setCompanyFactsHandler } from "../tenant-company-facts";

function mkRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

const req = (body: unknown) =>
  ({ headers: { authorization: "Bearer tok" }, body }) as never;

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ error: null });
  del.mockReset().mockResolvedValue({ error: null });
  computeReadiness.mockReset().mockResolvedValue(20);
  canonicalizeUrl.mockReset().mockImplementation(async (u: string) => ({
    url: u,
    changed: false,
  }));
  membershipRole = "owner";
  ssrfVerdict = null;
  existingProductUrl = {};
  competitorsFromIdea.mockReset().mockResolvedValue([]);
});

describe("setCompanyFactsHandler — trust boundary", () => {
  it("rejects a non-owner/admin member with 403 and writes NOTHING", async () => {
    membershipRole = "member";
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "what_we_sell", value: "cars" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("rejects a caller with no membership row at all", async () => {
    membershipRole = null;
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "what_we_sell", value: "cars" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("IGNORES a body-supplied tenant_id — writes go to the AUTH tenant only", async () => {
    const res = mkRes();
    await setCompanyFactsHandler(
      req({
        tenant_id: "victim-tenant",
        facts: [{ key: "what_we_sell", value: "cars" }],
      }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const call = rpc.mock.calls.find((c) => c[0] === "set_tenant_fact");
    expect(call).toBeDefined();
    expect(call![1].p_tenant_id).toBe("auth-tenant");
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("victim-tenant");
  });

  it("rejects an unknown fact key (closed key set)", async () => {
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "pricing_page", value: "x" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("setCompanyFactsHandler — domain lockstep + canonicalization", () => {
  it("writes the domain through the single atomic writer", async () => {
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "https://www.example.com" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const dom = rpc.mock.calls.find((c) => c[0] === "set_tenant_company_domain_system");
    expect(dom).toBeDefined();
    expect(dom![1].p_url).toBe("https://www.example.com");
    expect(dom![1].p_source).toBe("human_confirmed");
    expect(rpc).not.toHaveBeenCalledWith("set_tenant_fact", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("set_tenant_product_url_system", expect.anything());
    expect(computeReadiness).toHaveBeenCalledWith("auth-tenant");
  });

  it("stores the CANONICAL origin when the typed domain redirects off-origin", async () => {
    canonicalizeUrl.mockResolvedValue({
      url: "https://www.a2ztell.ai/",
      changed: true,
    });
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "https://a2ztell.ai" }] }),
      res as never,
    );
    const dom = rpc.mock.calls.find((c) => c[0] === "set_tenant_company_domain_system");
    expect(dom![1].p_url).toBe("https://www.a2ztell.ai/");
    expect(res.json.mock.calls[0][0].canonicalized).toEqual([
      "domain → https://www.a2ztell.ai/",
    ]);
  });

  it('"" CLEARS the domain through the same atomic writer', async () => {
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "" }] }),
      res as never,
    );
    const dom = rpc.mock.calls.find((c) => c[0] === "set_tenant_company_domain_system");
    expect(dom).toBeDefined();
    expect(dom![1].p_url).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });
});

describe("setCompanyFactsHandler — prosecutor findings (2026-07-18)", () => {
  it("does NOT report success when clearing the domain fails", async () => {
    rpc.mockImplementation(async (name: string) =>
      name === "set_tenant_company_domain_system"
        ? { error: { message: "boom" } }
        : { error: null },
    );
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].error.code).toBe("clear_failed");
  });

  it("rejects a domain that resolves to a private address", async () => {
    ssrfVerdict = "ssrf_blocked";
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "https://internal.corp" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe("unsafe_domain");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("STILL saves a domain that is merely unreachable (fail-open preserved)", async () => {
    ssrfVerdict = "ssrf_dns_failed";
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "https://down.example" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const dom = rpc.mock.calls.find((c) => c[0] === "set_tenant_company_domain_system");
    expect(dom).toBeDefined();
  });
});

describe("setCompanyFactsHandler — product_url merge (data-loss regression)", () => {
  it("delegates a Website CHANGE to the merging writer, not the replacer", async () => {
    existingProductUrl = {
      marketing: "https://old.example.com",
      api: "https://api.example.com",
    };
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "https://new.example.com" }] }),
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(rpc).toHaveBeenCalledWith(
      "set_tenant_company_domain_system",
      expect.objectContaining({ p_url: "https://new.example.com" }),
    );
    expect(rpc).not.toHaveBeenCalledWith("set_tenant_product_url_system", expect.anything());
  });

  it("delegates a Website CLEAR to the merging writer, not the replacer", async () => {
    existingProductUrl = {
      marketing: "https://old.example.com",
      api: "https://api.example.com",
    };
    const res = mkRes();
    await setCompanyFactsHandler(
      req({ facts: [{ key: "domain", value: "" }] }),
      res as never,
    );
    expect(rpc).toHaveBeenCalledWith(
      "set_tenant_company_domain_system",
      expect.objectContaining({ p_url: null }),
    );
    expect(rpc).not.toHaveBeenCalledWith("set_tenant_product_url_system", expect.anything());
  });
});

describe("companyCompetitorSuggestionsHandler", () => {
  it("researches for the AUTH tenant and returns the names", async () => {
    competitorsFromIdea.mockResolvedValue(["Turo", "Getaround"]);
    const res = mkRes();
    await companyCompetitorSuggestionsHandler(req({ tenant_id: "other-tenant" }), res as never);
    expect(competitorsFromIdea).toHaveBeenCalledWith("auth-tenant");
    expect(res.json).toHaveBeenCalledWith({ competitors: ["Turo", "Getaround"], pending: false });
  });

  it("spends nothing for a member who cannot save the result", async () => {
    membershipRole = "member";
    const res = mkRes();
    await companyCompetitorSuggestionsHandler(req({}), res as never);
    expect(competitorsFromIdea).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ competitors: [], pending: false });
  });

  it("answers pending when the research outlasts the wait", async () => {
    vi.useFakeTimers();
    try {
      competitorsFromIdea.mockReturnValue(new Promise(() => {}));
      const res = mkRes();
      const done = companyCompetitorSuggestionsHandler(req({}), res as never);
      await vi.advanceTimersByTimeAsync(40_000);
      await done;
      expect(res.json).toHaveBeenCalledWith({ competitors: [], pending: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fails the step when the research throws", async () => {
    competitorsFromIdea.mockRejectedValue(new Error("tavily down"));
    const res = mkRes();
    await companyCompetitorSuggestionsHandler(req({}), res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ competitors: [], pending: false });
  });
});
