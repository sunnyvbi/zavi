import { describe, expect, it, vi } from "vitest";
import { getRenderCustomDomainStatus, verifyRenderCustomDomain } from "../render-custom-domain";

type Res = { status: number; json: () => Promise<unknown>; text: () => Promise<string> };
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Res>;

function envelope(id: string, name: string, verificationStatus: string) {
  return { customDomain: { id, name, domainType: "subdomain", verificationStatus }, cursor: `c-${id}` };
}

function renderWithManyDomains(ours: ReturnType<typeof envelope>) {
  const filler = Array.from({ length: 30 }, (_, i) => envelope(`cdm-filler-${i}`, `f${i}.example.com`, "unverified"));
  const all = [...filler, ours];
  return vi.fn(async (url: string): Promise<Res> => {
    const limit = Number(new URL(url).searchParams.get("limit") ?? 20);
    const page = all.slice(0, limit);
    return { status: 200, json: async () => page, text: async () => JSON.stringify(page) };
  });
}

const deps = (fetchFn: Fetch) => ({ token: () => "rnd-token", fetchFn });

describe("getRenderCustomDomainStatus", () => {
  it("still finds the built-in domain on a service that already carries more than Render's default page of 20", async () => {
    const fetchFn = renderWithManyDomains(envelope("cdm-ours", "Mohit-93bd8436.zaviagent.com", "verified"));
    expect(await getRenderCustomDomainStatus("srv-1", "cdm-ours", deps(fetchFn))).toBe("verified");
    expect(await getRenderCustomDomainStatus("srv-1", "mohit-93bd8436.zaviagent.com", deps(fetchFn))).toBe("verified");
  });

  it("reads the domain out of Render's { customDomain, cursor } envelope and reports unverified honestly", async () => {
    const fetchFn = renderWithManyDomains(envelope("cdm-ours", "x.zaviagent.com", "unverified"));
    expect(await getRenderCustomDomainStatus("srv-1", "cdm-ours", deps(fetchFn))).toBe("unverified");
    expect(await getRenderCustomDomainStatus("srv-1", "cdm-missing", deps(fetchFn))).toBeNull();
  });
});

describe("verifyRenderCustomDomain", () => {
  it("posts to Render's per-domain verify endpoint and accepts the 202", async () => {
    const fetchFn = vi.fn(async (): Promise<Res> => ({ status: 202, json: async () => ({}), text: async () => "" }));
    await verifyRenderCustomDomain("srv-1", "cdm-ours", deps(fetchFn));
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.render.com/v1/services/srv-1/custom-domains/cdm-ours/verify",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on a real Render failure so the caller can keep the DNS record and retry", async () => {
    const fetchFn = vi.fn(async (): Promise<Res> => ({ status: 500, json: async () => ({}), text: async () => "boom" }));
    await expect(verifyRenderCustomDomain("srv-1", "cdm-ours", deps(fetchFn))).rejects.toThrow(/verify failed \(500\)/);
  });
});
