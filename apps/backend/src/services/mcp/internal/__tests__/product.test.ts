
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));

import {
  resolveProbeUrl,
  ProbeValidationError,
  callProductProbeTool,
} from "../product";

function installServiceClient(byTenant: Record<string, unknown>) {
  mocks.serviceClientMock.mockReturnValue({
    from: (table: string) => {
      expect(table).toBe("tenants");
      return {
        select: (cols: string) => {
          expect(cols).toBe("product_url");
          return {
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({
                data: id in byTenant ? { product_url: byTenant[id] } : null,
                error: null,
              }),
            }),
          };
        },
      };
    },
  });
}

function mkResponse(opts: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers(opts.headers ?? { "content-type": "text/html" });
  return new Response(opts.body ?? "", { status: opts.status, headers });
}

function installFetch(map: Record<string, Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const key =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const res = map[key];
      if (!res) throw new Error(`stub fetch: no entry for ${key}`);
      return res;
    }),
  );
}

beforeEach(() => {
  mocks.serviceClientMock.mockReset();
  mocks.logEvent.mockClear();
  vi.unstubAllGlobals();
});

describe("resolveProbeUrl — same-origin construction (H3)", () => {
  const base = "https://acme.example.com";

  it("builds a same-origin URL from a relative path", () => {
    expect(resolveProbeUrl(base, "/pricing")).toBe("https://acme.example.com/pricing");
  });

  it("defaults to '/' when no path supplied", () => {
    expect(resolveProbeUrl(base, undefined)).toBe("https://acme.example.com/");
  });

  it("rejects an absolute URL path (different origin)", () => {
    expect(() => resolveProbeUrl(base, "https://evil.com/")).toThrow(ProbeValidationError);
    try {
      resolveProbeUrl(base, "https://evil.com/");
    } catch (e) {
      expect((e as ProbeValidationError).code).toBe("invalid_path");
    }
  });

  it("rejects a protocol-relative '//host' path", () => {
    expect(() => resolveProbeUrl(base, "//evil.com/x")).toThrow(ProbeValidationError);
  });

  it("rejects a userinfo '@' path", () => {
    expect(() => resolveProbeUrl(base, "/@evil.com")).toThrow(ProbeValidationError);
  });

  it("rejects a backslash path", () => {
    expect(() => resolveProbeUrl(base, "/\\evil.com")).toThrow(ProbeValidationError);
  });

  it("rejects a '..' traversal path", () => {
    expect(() => resolveProbeUrl(base, "/foo/../../bar")).toThrow(ProbeValidationError);
  });

  it("rejects a path not starting with '/'", () => {
    expect(() => resolveProbeUrl(base, "pricing")).toThrow(ProbeValidationError);
  });

  it("clean product_url_not_configured when no base", () => {
    try {
      resolveProbeUrl(undefined, "/");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProbeValidationError);
      expect((e as ProbeValidationError).code).toBe("product_url_not_configured");
    }
  });

  it("origin_mismatch is impossible to bypass — even a tricky path lands same-origin or throws", () => {
    expect(() => resolveProbeUrl(base, "https://acme.example.com.evil.com/")).toThrow(
      ProbeValidationError,
    );
  });

  describe("FIX 3 — percent-encoded traversal cannot escape the origin", () => {
    it("rejects an encoded-slash traversal ('/%2f..%2f') cleanly", () => {
      expect(() => resolveProbeUrl(base, "/%2f..%2f")).toThrow(ProbeValidationError);
      try {
        resolveProbeUrl(base, "/%2f..%2f");
      } catch (e) {
        expect((e as ProbeValidationError).code).toBe("invalid_path");
      }
    });

    it("rejects a mixed encoded/decoded traversal ('/foo/%2e%2e/%2f..%2f')", () => {
      expect(() => resolveProbeUrl(base, "/foo/%2e%2e/%2f..%2f")).toThrow(
        ProbeValidationError,
      );
    });

    for (const p of ["/%2e%2e/admin", "/foo/%2e%2e/%2e%2e/etc"]) {
      it(`'${p}' never escapes the registered origin (rejected OR collapsed same-origin)`, () => {
        let result: string | null = null;
        try {
          result = resolveProbeUrl(base, p);
        } catch (e) {
          expect(e).toBeInstanceOf(ProbeValidationError);
        }
        if (result !== null) {
          const u = new URL(result);
          expect(u.origin).toBe("https://acme.example.com");
          expect(decodeURIComponent(u.pathname).split("/")).not.toContain("..");
        }
      });
    }
  });
});

describe("callProductProbeTool — server-side base + guards", () => {
  it("re-derives the base from tenant_id (C8) and fetches same-origin path", async () => {
    installServiceClient({
      "tenant-a": { marketing: "https://8.8.8.8/" },
    });
    installFetch({
      "https://8.8.8.8/pricing": mkResponse({ status: 200, body: "<p>Plans</p>" }),
    });
    const res = await callProductProbeTool("tenant-a", "probe", { path: "/pricing" });
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content);
    expect(out.final_url).toBe("https://8.8.8.8/pricing");
    expect(out.target).toBe("marketing");
    expect(out.body_text).toMatch(/Plans/);
  });

  it("returns clean product_url_not_configured when nothing registered (H7, no throw)", async () => {
    installServiceClient({});
    const res = await callProductProbeTool("tenant-x", "probe", { path: "/" });
    expect(res.is_error).toBe(true);
    const out = JSON.parse(res.content);
    expect(out.error).toBe("product_url_not_configured");
  });

  it("redacts a secret in the path + surfaces scrub_note (H1)", async () => {
    installServiceClient({ "tenant-a": { marketing: "https://8.8.8.8/" } });
    installFetch({
      "https://8.8.8.8/p/[redacted]": mkResponse({ status: 200, body: "<p>ok</p>" }),
    });
    const res = await callProductProbeTool("tenant-a", "probe", {
      path: "/p/sk_live_abcdefghijklmnop12345",
    });
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content);
    expect(out.secret_scrub_note).toMatch(/redacted/);
    expect(mocks.logEvent).toHaveBeenCalled();
  });

  it("blocks a redirect to a private IP (H2 — assertSafeUrl per hop)", async () => {
    installServiceClient({ "tenant-a": { marketing: "https://8.8.8.8/" } });
    installFetch({
      "https://8.8.8.8/go": mkResponse({
        status: 302,
        headers: { location: "https://169.254.169.254/" },
      }),
    });
    const res = await callProductProbeTool("tenant-a", "probe", { path: "/go" });
    expect(res.is_error).toBe(true);
    const out = JSON.parse(res.content);
    expect(out.error).toMatch(/ssrf/);
  });

  it("refuses a redirect OFF the registered origin to another PUBLIC host (H4)", async () => {
    installServiceClient({ "tenant-a": { marketing: "https://8.8.8.8/" } });
    installFetch({
      "https://8.8.8.8/leave": mkResponse({
        status: 302,
        headers: { location: "https://1.1.1.1/" },
      }),
    });
    const res = await callProductProbeTool("tenant-a", "probe", { path: "/leave" });
    expect(res.is_error).toBe(true);
    const out = JSON.parse(res.content);
    expect(out.message).toMatch(/redirect off registered product origin/);
    expect(out.message).toMatch(/1\.1\.1\.1 != https:\/\/8\.8\.8\.8/);
  });

  it("rejects an absolute-URL path before any fetch (H3)", async () => {
    installServiceClient({ "tenant-a": { marketing: "https://8.8.8.8/" } });
    installFetch({});
    const res = await callProductProbeTool("tenant-a", "probe", {
      path: "https://evil.com/steal",
    });
    expect(res.is_error).toBe(true);
    const out = JSON.parse(res.content);
    expect(out.error).toBe("invalid_path");
  });

  it("the schema has NO url/host/tenant arg — a supplied url is ignored", async () => {
    installServiceClient({ "tenant-a": { marketing: "https://8.8.8.8/" } });
    installFetch({
      "https://8.8.8.8/": mkResponse({ status: 200, body: "<p>home</p>" }),
    });
    const res = await callProductProbeTool("tenant-a", "probe", {
      url: "https://evil.com",
      tenant_id: "tenant-b",
    } as unknown);
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content);
    expect(out.final_url).toBe("https://8.8.8.8/");
  });
});

describe("T3 — cross-tenant isolation", () => {
  it("tenant B's probe uses ONLY tenant B's registered base", async () => {
    installServiceClient({
      "tenant-a": { marketing: "https://8.8.8.8/" },
      "tenant-b": { marketing: "https://1.1.1.1/" },
    });
    installFetch({
      "https://1.1.1.1/": mkResponse({ status: 200, body: "<p>B home</p>" }),
    });
    const res = await callProductProbeTool("tenant-b", "probe", { path: "/" });
    expect(res.is_error).toBe(false);
    const out = JSON.parse(res.content);
    expect(out.final_url).toBe("https://1.1.1.1/");
    expect(out.final_url).not.toMatch(/8\.8\.8\.8/);
  });

  it("a tenant with no registration cannot ride on another tenant's base", async () => {
    installServiceClient({ "tenant-a": { marketing: "https://8.8.8.8/" } });
    const res = await callProductProbeTool("tenant-c", "probe", { path: "/" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toBe("product_url_not_configured");
  });
});
