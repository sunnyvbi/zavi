
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAppListings } from "../fetch-app-store";

vi.mock("@/services/mcp/internal/web-search", () => ({
  callWebSearchTool: vi.fn(),
}));
import { callWebSearchTool } from "@/services/mcp/internal/web-search";
const mockSearch = callWebSearchTool as unknown as ReturnType<typeof vi.fn>;

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    promises: { lookup: vi.fn() },
  };
});
import { promises as dns } from "node:dns";
const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

const originalFetch = globalThis.fetch;

function tavily(urls: string[]) {
  return {
    ok: true as const,
    is_error: false,
    ms: 0,
    content: JSON.stringify({ results: urls.map((u) => ({ url: u })) }),
  };
}

function tavilyEmpty() {
  return tavily([]);
}

function htmlWithJsonLd(json: object): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body></body></html>`;
}

describe("fetchAppListings", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts iOS listing from JSON-LD SoftwareApplication block", async () => {
    mockSearch
      .mockResolvedValueOnce(tavily(["https://apps.apple.com/us/app/acme/id123"]))
      .mockResolvedValueOnce(tavilyEmpty());
    globalThis.fetch = vi.fn(async () =>
      new Response(
        htmlWithJsonLd({
          "@type": "SoftwareApplication",
          name: "Acme Rentals",
          softwareVersion: "4.2.1",
          datePublished: "2026-04-12",
          aggregateRating: { ratingValue: "4.6", ratingCount: 1243 },
          supportUrl: "https://acmerentals.com/support",
        }),
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const r = await fetchAppListings("Acme Rentals");
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({
      store: "ios",
      name: "Acme Rentals",
      version: "4.2.1",
      last_updated: "2026-04-12",
      rating: 4.6,
      ratings_count: 1243,
      support_url: "https://acmerentals.com/support",
    });
  });

  it("returns nulls when JSON-LD has no relevant block", async () => {
    mockSearch
      .mockResolvedValueOnce(tavily(["https://apps.apple.com/us/app/x/id1"]))
      .mockResolvedValueOnce(tavilyEmpty());
    globalThis.fetch = vi.fn(async () =>
      new Response(
        htmlWithJsonLd({ "@type": "Organization", name: "Whatever" }),
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const r = await fetchAppListings("X");
    expect(r.length).toBe(1);
    expect(r[0].name).toBeNull();
    expect(r[0].version).toBeNull();
    expect(r[0].rating).toBeNull();
  });

  it("extracts Play Store listing from JSON-LD MobileApplication block", async () => {
    mockSearch
      .mockResolvedValueOnce(tavilyEmpty())
      .mockResolvedValueOnce(tavily(["https://play.google.com/store/apps/details?id=com.acme"]));
    globalThis.fetch = vi.fn(async () =>
      new Response(
        htmlWithJsonLd({
          "@type": "MobileApplication",
          name: "Acme Android",
          softwareVersion: "9.9",
          aggregateRating: { ratingValue: 3.8, ratingCount: "55" },
        }),
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ) as unknown as typeof globalThis.fetch;
    const r = await fetchAppListings("Acme");
    expect(r.length).toBe(1);
    expect(r[0].store).toBe("android");
    expect(r[0].name).toBe("Acme Android");
    expect(r[0].rating).toBe(3.8);
    expect(r[0].ratings_count).toBe(55);
  });

  it("returns empty when both Tavily probes return nothing", async () => {
    mockSearch.mockResolvedValue(tavilyEmpty());
    globalThis.fetch = vi.fn(async () =>
      new Response("never reached", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await fetchAppListings("Nobody");
    expect(r).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
