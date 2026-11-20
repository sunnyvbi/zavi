
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mockRpc = vi.fn();
const mockRequireAuth = vi.fn();
let currentProductUrl: Record<string, string> | null = null;
let productUrlReadError: { message: string } | null = null;

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock("@/services/onboarding/enrichment/url-guard", async (orig) => ({
  ...(await orig<typeof import("@/services/onboarding/enrichment/url-guard")>()),
  assertSafeUrl: vi.fn(async () => {}),
}));

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    rpc: mockRpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: productUrlReadError ? null : { product_url: currentProductUrl },
            error: productUrlReadError,
          }),
        }),
      }),
    }),
  }),
}));

import {
  setProductUrlHandler,
  clearProductUrlHandler,
} from "../../routes/connectors/tenant-product-url";

function makeReq(opts: { body?: unknown; auth?: string } = {}): Request {
  return {
    body: opts.body ?? {},
    headers: { authorization: opts.auth ?? "Bearer faketoken" },
  } as unknown as Request;
}

function makeRes() {
  const res: Partial<Response> & { _status?: number; _body?: unknown } = {};
  res.status = vi.fn((n: number) => {
    res._status = n;
    return res as Response;
  });
  res.json = vi.fn((b: unknown) => {
    res._body = b;
    return res as Response;
  });
  return res as Response & { _status?: number; _body?: unknown };
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRequireAuth.mockReset();
  currentProductUrl = null;
  productUrlReadError = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: 200, headers: { get: () => null } })),
  );
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe("setProductUrlHandler", () => {
  it("does nothing when requireAuth fails (401 owned by middleware)", async () => {
    mockRequireAuth.mockResolvedValueOnce(null);
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { marketing: "https://x.com" } }), res);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400s on a non-https marketing URL (client-side filter, no RPC)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { marketing: "http://insecure.com" } }), res);
    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: { code: "invalid_marketing_url" } });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400s on a non-URL string", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { api: "not a url" } }), res);
    expect(res._status).toBe(400);
  });

  it("routes marketing and api through their own merging writers", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(
      makeReq({ body: { marketing: "https://acme.com", api: "https://api.acme.com" } }),
      res,
    );
    expect(mockRpc).toHaveBeenNthCalledWith(1, "set_tenant_company_domain", {
      p_tenant_id: "t1",
      p_url: "https://acme.com/",
      p_source_ref: "registered via the product URL settings",
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, "set_tenant_api_origin", {
      p_tenant_id: "t1",
      p_url: "https://api.acme.com/",
    });
    expect(mockRpc).not.toHaveBeenCalledWith("set_tenant_product_url", expect.anything());
    expect(res._status).toBe(200);
  });

  it("rejects the whole save when only the API URL is a private host — nothing written", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(
      makeReq({ body: { marketing: "https://acme.com", api: "https://10.0.0.5" } }),
      res,
    );
    expect(res._status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ["https://[::1]/", "IPv6 loopback"],
    ["https://[fc00::1]/", "IPv6 unique-local"],
    ["https://[fe80::1]/", "IPv6 link-local"],
  ])("rejects %s (%s) despite the brackets", async (url) => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { marketing: url } }), res);
    expect(res._status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects the whole save when only the marketing URL is a private host", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(
      makeReq({ body: { marketing: "https://169.254.169.254", api: "https://api.acme.com" } }),
      res,
    );
    expect(res._status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("does NOT commit the api change when the marketing URL is rejected in SQL", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "company domain: rejected by a rule the route cannot see" },
    });
    const res = makeRes();
    await setProductUrlHandler(
      makeReq({ body: { marketing: "https://acme.com", api: "https://api.acme.com" } }),
      res,
    );
    expect(res._status).toBe(422);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalledWith("set_tenant_api_origin", expect.anything());
  });

  it("rejects a >500-char URL before any write", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(
      makeReq({ body: { marketing: `https://acme.com/${"a".repeat(520)}` } }),
      res,
    );
    expect(res._status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("does not read tenants to merge — the merge is the database's job now", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    currentProductUrl = { marketing: "https://acme.com/" };
    productUrlReadError = { message: "connection reset" };
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { api: "https://api.acme.com" } }), res);
    expect(res._status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("set_tenant_api_origin", {
      p_tenant_id: "t1",
      p_url: "https://api.acme.com/",
    });
  });

  it("writing api alone sends only the api key — no whole-object replace", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    currentProductUrl = { marketing: "https://acme.com/" };
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { api: "https://api.acme.com" } }), res);
    expect(mockRpc).toHaveBeenCalledWith("set_tenant_api_origin", {
      p_tenant_id: "t1",
      p_url: "https://api.acme.com/",
    });
    expect(mockRpc).not.toHaveBeenCalledWith("set_tenant_product_url", expect.anything());
    expect(res._status).toBe(200);
  });

  it("marketing-only touches ONLY the domain writer — the legacy RPC is never called", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { marketing: "https://acme.com" } }), res);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("set_tenant_company_domain", {
      p_tenant_id: "t1",
      p_url: "https://acme.com/",
      p_source_ref: "registered via the product URL settings",
    });
    expect(mockRpc).not.toHaveBeenCalledWith("set_tenant_product_url", expect.anything());
  });

  it("403s on admin refusal from the RPC (Postgres 42501)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "forbidden — role member cannot perform admin action" },
    });
    const res = makeRes();
    await setProductUrlHandler(makeReq({ body: { marketing: "https://acme.com" } }), res);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ error: { code: "not_admin" } });
  });

  it("422s on a private host rejected at the RPC (Postgres 22023)", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "marketing resolves to a private/loopback host" },
    });
    const res = makeRes();
    await setProductUrlHandler(
      makeReq({ body: { marketing: "https://169.254.169.254" } }),
      res,
    );
    expect(res._status).toBe(422);
    expect(res._body).toMatchObject({ error: { code: "invalid_product_url" } });
  });
});

describe("clearProductUrlHandler", () => {
  it("does nothing when requireAuth fails", async () => {
    mockRequireAuth.mockResolvedValueOnce(null);
    const res = makeRes();
    await clearProductUrlHandler(makeReq(), res);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("clears the domain fact first, then empties the jsonb to drop api", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    const res = makeRes();
    await clearProductUrlHandler(makeReq(), res);
    expect(mockRpc).toHaveBeenNthCalledWith(1, "set_tenant_company_domain", {
      p_tenant_id: "t1",
      p_url: null,
      p_source_ref: "cleared via the product URL settings",
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, "set_tenant_product_url", {
      p_tenant_id: "t1",
      p_product_url: {},
    });
    expect(res._status).toBe(200);
  });

  it("403s on admin refusal when clearing", async () => {
    mockRequireAuth.mockResolvedValueOnce({ tenant_id: "t1", user_id: "u1" });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });
    const res = makeRes();
    await clearProductUrlHandler(makeReq(), res);
    expect(res._status).toBe(403);
  });
});

describe("canonicalizeUrl", () => {
  const mkRedirect = (to: string) =>
    new Response(null, { status: 301, headers: { location: to } });
  const mkOk = () => new Response("<html></html>", { status: 200 });

  it("resolves an apex→www redirect to the origin actually served", async () => {
    const { canonicalizeUrl } = await import("@/routes/connectors/tenant-product-url");
    const fake = (async (u: string | URL) =>
      String(u) === "https://a2ztell.ai/"
        ? mkRedirect("https://www.a2ztell.ai/")
        : mkOk()) as unknown as typeof fetch;
    const out = await canonicalizeUrl("https://a2ztell.ai/", fake);
    expect(out.url).toBe("https://www.a2ztell.ai/");
    expect(out.changed).toBe(true);
  });

  it("leaves an already-canonical URL untouched", async () => {
    const { canonicalizeUrl } = await import("@/routes/connectors/tenant-product-url");
    const fake = (async () => mkOk()) as unknown as typeof fetch;
    const out = await canonicalizeUrl("https://www.apnatutor.live/", fake);
    expect(out.url).toBe("https://www.apnatutor.live/");
    expect(out.changed).toBe(false);
  });

  it("FAILS OPEN on an unreachable host — a customer whose site is down can still save", async () => {
    const { canonicalizeUrl } = await import("@/routes/connectors/tenant-product-url");
    const fake = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const out = await canonicalizeUrl("https://down.example/", fake);
    expect(out.url).toBe("https://down.example/");
    expect(out.changed).toBe(false);
  });

  it("stops at the redirect cap instead of following a loop forever", async () => {
    const { canonicalizeUrl } = await import("@/routes/connectors/tenant-product-url");
    let n = 0;
    const fake = (async () => {
      n += 1;
      return mkRedirect(`https://loop.example/${n}`);
    }) as unknown as typeof fetch;
    await canonicalizeUrl("https://loop.example/0", fake);
    expect(n).toBeLessThanOrEqual(3);
  });
});
