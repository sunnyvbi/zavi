
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  eTldPlusOne,
  isPlatformHost,
  jaroWinkler,
  normalizeOrgName,
  resolveDomain,
  tokenize,
} from "../domain-match";

vi.mock("@/services/mcp/internal/web-search", () => ({
  callWebSearchTool: vi.fn(),
}));
import { callWebSearchTool } from "@/services/mcp/internal/web-search";

const mockSearch = callWebSearchTool as unknown as ReturnType<typeof vi.fn>;

function tavilyResults(urls: string[]) {
  return {
    ok: true as const,
    is_error: false,
    ms: 0,
    content: JSON.stringify({
      results: urls.map((u) => ({ url: u, title: "", snippet: "" })),
    }),
  };
}

describe("normalizeOrgName + tokenize", () => {
  it("normalizes accents and casing", () => {
    expect(normalizeOrgName("Café Rentals")).toBe("cafe rentals");
  });

  it("strips marketplace suffixes when tokenizing", () => {
    expect(tokenize(normalizeOrgName("Acme Rentals"))).toEqual(["acme"]);
    expect(tokenize(normalizeOrgName("Foo Tutors"))).toEqual(["foo"]);
  });

  it("preserves multi-token names that aren't suffixes", () => {
    expect(tokenize(normalizeOrgName("Blue Apron"))).toEqual(["blue", "apron"]);
  });
});

describe("eTldPlusOne", () => {
  it("returns the eTLD+1 for two-label hosts", () => {
    expect(eTldPlusOne("stripe.com")).toBe("stripe.com");
  });

  it("strips www subdomain", () => {
    expect(eTldPlusOne("www.stripe.com")).toBe("stripe.com");
  });

  it("returns eTLD+1 for deeper subdomains", () => {
    expect(eTldPlusOne("api.staging.stripe.com")).toBe("stripe.com");
  });

  it("handles common multi-part TLDs heuristically", () => {
    expect(eTldPlusOne("acme.co.uk")).toBe("acme.co.uk");
  });
});

describe("jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("stripe", "stripe")).toBe(1);
  });

  it("returns >= 0.9 for shared prefix", () => {
    expect(jaroWinkler("stripe", "stripey")).toBeGreaterThanOrEqual(0.9);
  });

  it("returns 0 for empty inputs", () => {
    expect(jaroWinkler("", "stripe")).toBe(0);
    expect(jaroWinkler("stripe", "")).toBe(0);
  });
});

describe("resolveDomain", () => {
  it.each([
    ["https://example-clinic.netlify.app/", "example-clinic.netlify.app"],
    ["https://brand.vercel.app/pricing", "brand.vercel.app"],
    ["https://brand.github.io/", "brand.github.io"],
    ["https://brand.onrender.com/", "brand.onrender.com"],
    ["https://brand.framer.app/", "brand.framer.app"],
    ["https://brand.carrd.co/", "brand.carrd.co"],
    ["https://brand.my.canva.site/", "brand.my.canva.site"],
    ["https://brand.lovable.app/", "brand.lovable.app"],
    ["https://brand.glitch.me/", "brand.glitch.me"],
    ["https://brand.substack.com/", "brand.substack.com"],
    ["https://brand.bubbleapps.io/", "brand.bubbleapps.io"],
    ["https://www.example.co.jp/", "example.co.jp"],
    ["https://Brand.Netlify.App./", "brand.netlify.app"],
    ["https://netlify.app/", "netlify.app"],
    ["https://www.netlify.app/", "www.netlify.app"],
    ["https://www.brand.netlify.app/", "brand.netlify.app"],
    ["https://www.example.com./", "example.com"],
    ["https://brand.netlify.app.evil.com/", "evil.com"],
  ])("keeps the business host for override %s", async (override, domain) => {
    expect(await resolveDomain("Example", { override })).toEqual({ domain, confidence: 1, via: "override" });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  beforeEach(() => mockSearch.mockReset());

  it("override path returns operator-supplied domain (bare host)", async () => {
    const r = await resolveDomain("Apple Rentals", { override: "acmerentals.example" });
    expect(r).toEqual({ domain: "acmerentals.example", confidence: 1, via: "override" });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("override path accepts full URL and extracts hostname", async () => {
    const r = await resolveDomain("Stripe", { override: "https://www.stripe.com/pricing" });
    expect(r?.domain).toBe("stripe.com");
    expect(r?.via).toBe("override");
  });

  it("override path strips path from a bare host+path (no scheme)", async () => {
    const r = await resolveDomain("Acme", { override: "acme.com/pricing" });
    expect(r?.domain).toBe("acme.com");
    expect(r?.via).toBe("override");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("override path strips path + www from a scheme-less host", async () => {
    const r = await resolveDomain("Acme", { override: "www.acme.com/a/b?x=1" });
    expect(r?.domain).toBe("acme.com");
  });

  it("Tavily path resolves stripe.com for orgName 'Stripe'", async () => {
    mockSearch.mockResolvedValue(tavilyResults(["https://stripe.com", "https://example.org"]));
    const r = await resolveDomain("Stripe");
    expect(r?.domain).toBe("stripe.com");
    expect(r?.via).toBe("tavily");
    expect(r?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("Tavily path resolves acmerentals.com for 'Acme Rentals' (suffix-strip)", async () => {
    mockSearch.mockResolvedValue(tavilyResults(["https://acmerentals.com"]));
    const r = await resolveDomain("Acme Rentals");
    expect(r?.domain).toBe("acmerentals.com");
  });

  it("PASSES apple.com for 'Apple Rentals' — wizard confirm is the gate, NOT resolver", async () => {
    mockSearch.mockResolvedValue(tavilyResults(["https://apple.com"]));
    const r = await resolveDomain("Apple Rentals");
    expect(r?.domain).toBe("apple.com");
    expect(r?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("REJECTS unrelated random domain on a name with no token overlap", async () => {
    mockSearch.mockResolvedValue(tavilyResults(["https://github.com"]));
    const r = await resolveDomain("Stripe");
    expect(r).toBeNull();
  });

  it("returns null when Tavily returns no usable results", async () => {
    mockSearch.mockResolvedValue(tavilyResults([]));
    const r = await resolveDomain("Stripe");
    expect(r).toBeNull();
  });

  it("returns null when Tavily errors out", async () => {
    mockSearch.mockResolvedValue({
      ok: false,
      is_error: true,
      ms: 0,
      content: JSON.stringify({ code: "web_search_not_configured", message: "x" }),
    });
    const r = await resolveDomain("Stripe");
    expect(r).toBeNull();
  });

  it("returns null for empty orgName without override", async () => {
    const r = await resolveDomain("");
    expect(r).toBeNull();
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("handles single-token org name", async () => {
    mockSearch.mockResolvedValue(tavilyResults(["https://notion.so"]));
    const r = await resolveDomain("Notion");
    expect(r?.domain).toBe("notion.so");
  });

  it("handles special characters and unicode in orgName", async () => {
    mockSearch.mockResolvedValue(tavilyResults(["https://cafe.com"]));
    const r = await resolveDomain("Café!!");
    expect(r?.domain).toBe("cafe.com");
  });

  it("REJECTS literal IPv4 IMDS address as override (SSRF probe class)", async () => {
    const r = await resolveDomain("IMDSProbe", { override: "169.254.169.254" });
    expect(r).toBeNull();
  });

  it("REJECTS literal RFC1918 IPv4 as override", async () => {
    const r = await resolveDomain("InternalProbe", { override: "10.0.0.1" });
    expect(r).toBeNull();
  });

  it("REJECTS localhost / single-label hostname as override", async () => {
    expect(await resolveDomain("LocalhostProbe", { override: "localhost" })).toBeNull();
    expect(await resolveDomain("InternalProbe", { override: "internal" })).toBeNull();
  });

  it("REJECTS IPv6-ish override", async () => {
    const r = await resolveDomain("IPv6Probe", { override: "::1" });
    expect(r).toBeNull();
  });
});

describe("platform hosts are not a company site", () => {
  it("refuses a social profile as the override, so nothing is crawled", async () => {
    for (const override of [
      "https://www.facebook.com/greenfarm",
      "m.facebook.com/greenfarm",
      "fb.com/greenfarm",
      "youtu.be/abc",
      "x.com/greenfarm",
      "greenfarm.etsy.com",
      "www.amazon.com/stores/greenfarm",
      "play.google.com/store/apps/details?id=com.greenfarm",
    ]) {
      expect(await resolveDomain("Green Farm", { override }), override).toBeNull();
    }
  });

  it("still accepts the founder's own site", async () => {
    expect(await resolveDomain("Green Farm", { override: "greenfarm.com/about" })).toMatchObject({
      domain: "greenfarm.com",
      via: "override",
    });
  });

  it("does not catch look-alike company domains", () => {
    expect(isPlatformHost("notfacebook.com")).toBe(false);
    expect(isPlatformHost("xbox-repair.com")).toBe(false);
    expect(isPlatformHost("apple.com")).toBe(false);
    expect(isPlatformHost("amazonia-coffee.com")).toBe(false);
  });
});

it("resolves a hosted company from search using its own label", async () => {
  mockSearch.mockResolvedValue(tavilyResults(["https://acmeclinic.netlify.app/about"]));
  expect(await resolveDomain("Acme Clinic")).toEqual({domain: "acmeclinic.netlify.app", confidence: 1, via: "tavily"});
});
