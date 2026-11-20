
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/onboarding/enrichment/url-guard", () => ({
  assertSafeUrl: vi.fn(async () => undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const safeFetchText = vi.fn<[string, string, number, number], Promise<string | null>>();
vi.mock("@/services/onboarding/enrichment/discover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/onboarding/enrichment/discover")>();
  return { ...actual, safeFetchText: (...args: Parameters<typeof safeFetchText>) => safeFetchText(...args) };
});

import {
  fetchForSeoAudit,
  parseCrawlDelayMs,
  retryAfterMs,
  createPacer,
  MAX_CRAWL_DELAY_MS,
  UA,
} from "../fetch";
import { unreachableReason } from "../run";

const HTML = "<html><head><title>t</title></head><body><h1>h</h1></body></html>";

beforeEach(() => {
  safeFetchText.mockReset();
  safeFetchText.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseCrawlDelayMs", () => {
  it("reads the * group's Crawl-delay", () => {
    expect(parseCrawlDelayMs("User-agent: *\nAllow: /\nCrawl-Delay: 5\n")).toBe(5_000);
  });

  it("prefers a group naming ZaviBot over *", () => {
    const body = "User-agent: *\nCrawl-delay: 8\n\nUser-agent: ZaviBot\nCrawl-delay: 2\n";
    expect(parseCrawlDelayMs(body)).toBe(2_000);
  });

  it("ignores a delay set only for some other crawler", () => {
    expect(parseCrawlDelayMs("User-agent: Bingbot\nCrawl-delay: 9\n")).toBe(0);
  });

  it("caps a huge delay and treats junk or no robots.txt as none", () => {
    expect(parseCrawlDelayMs("User-agent: *\nCrawl-delay: 600\n")).toBe(MAX_CRAWL_DELAY_MS);
    expect(parseCrawlDelayMs("User-agent: *\nCrawl-delay: soon\n")).toBe(0);
    expect(parseCrawlDelayMs(null)).toBe(0);
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    expect(retryAfterMs("3")).toBe(3_000);
    expect(retryAfterMs(new Date(Date.now() - 1000).toUTCString())).toBe(0);
    expect(retryAfterMs(undefined)).toBeNull();
    expect(retryAfterMs("whenever")).toBeNull();
  });
});

describe("createPacer", () => {
  it("does not wait at interval 0, and refuses a slot past the deadline", async () => {
    const p = createPacer();
    expect(await p.wait(Date.now() + 1000)).toBe(true);
    p.slowTo(10_000);
    expect(await p.wait(Date.now() + 1000)).toBe(false);
    const fresh = createPacer();
    fresh.slowTo(10_000);
    expect(await fresh.wait(Date.now() + 1000)).toBe(true);
    expect(await fresh.wait(Date.now() + 1000)).toBe(false);
  });

  it("only ever slows down", () => {
    const p = createPacer(500);
    p.slowTo(100);
    expect(p.intervalMs).toBe(500);
  });
});

describe("fetchForSeoAudit against a rate-limiting host", () => {
  it("retries a 429 instead of counting the page as unread, and slows the crawl", async () => {
    let homeHits = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
      homeHits++;
      return homeHits === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : new Response(HTML, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchForSeoAudit("https://shop.example.com", ["/"]);

    expect(homeHits).toBe(2);
    expect(r.pages[0]?.status).toBe(200);
    expect(r.throttled).toBe(true);
  });

  it("gives up after the retries and keeps the host's real status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
        if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        return new Response("challenge", { status: 503, headers: { "retry-after": "0" } });
      }),
    );

    const r = await fetchForSeoAudit("https://shop.example.com", ["/"]);

    expect(r.pages[0]?.status).toBe(503);
    expect(unreachableReason(r)).toContain("HTTP 503 (Service Unavailable)");
  }, 10_000);

  it("honours robots.txt Crawl-delay: one request at a time, spaced out", async () => {
    const starts: number[] = [];
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        starts.push(Date.now());
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nCrawl-delay: 0.05\n", { status: 200 });
        if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return new Response(HTML, { status: 200 });
      }),
    );

    const r = await fetchForSeoAudit("https://shop.example.com", ["/", "/about", "/pricing"]);

    expect(r.crawl_delay_ms).toBe(50);
    expect(peak).toBe(1);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(45);
  });

  it("leaves out pages the paced crawl had no time to request, instead of calling them unanswered", async () => {
    vi.useFakeTimers();
    try {
      const paths = Array.from({ length: 12 }, (_, i) => (i === 0 ? "/" : `/p${i}`));
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nCrawl-delay: 10\n", { status: 200 });
        if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        return new Response(HTML, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const run = fetchForSeoAudit("https://shop.example.com", paths);
      await vi.runAllTimersAsync();
      const r = await run;

      expect(r.truncated).toBe(true);
      expect(r.pages.length).toBeGreaterThan(0);
      expect(r.pages.length).toBeLessThan(paths.length);
      expect(r.pages.every((p) => p.status === 200)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads an http:// address over https instead of refusing it", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.endsWith("/robots.txt") || url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        return new Response(HTML, { status: 200 });
      }),
    );

    const r = await fetchForSeoAudit("http://www.shopatmela.com", ["/"]);

    expect(seen).toContain("https://www.shopatmela.com/");
    expect(seen.some((u) => u.startsWith("http://"))).toBe(false);
    expect(r.pages[0]?.status).toBe(200);
  });

  it("identifies itself as ZaviBot on every request", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(HTML, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchForSeoAudit("https://shop.example.com", ["/"]);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>)["user-agent"]).toBe(UA);
    }
    expect(UA).toBe("ZaviBot/1.0 (+https://www.zaviagent.com; read-only SEO audit)");
  });
});

describe("unreachableReason", () => {
  it("names the status and the crawler to allowlist on a 429", () => {
    const msg = unreachableReason({ pages: [{ status: 429 }], ssrf_blocked: 0 });
    expect(msg).toContain("HTTP 429 (Too Many Requests)");
    expect(msg).toContain("ZaviBot/1.0");
  });

  it("says nothing answered when no request got a response", () => {
    expect(unreachableReason({ pages: [{ status: 0 }], ssrf_blocked: 0 })).toContain("Nothing answered in time");
  });

  it("names a plain status like 404 without blaming a firewall", () => {
    const msg = unreachableReason({ pages: [{ status: 404 }], ssrf_blocked: 0 });
    expect(msg).toContain("HTTP 404 (Not Found)");
    expect(msg).not.toContain("firewall");
  });

  it("does not promise allowlisting fixes a 503, which a down site also answers", () => {
    const msg = unreachableReason({ pages: [{ status: 503 }], ssrf_blocked: 0 });
    expect(msg).toContain("HTTP 503 (Service Unavailable)");
    expect(msg).toContain("may be down");
    expect(msg).not.toContain("should fix this");
  });

  it("says the homepage did not answer instead of quoting a guessed page's 404", () => {
    const msg = unreachableReason({ pages: [{ status: 0 }, { status: 404 }], ssrf_blocked: 0 });
    expect(msg).toContain("homepage did not answer");
    expect(msg).not.toContain("404");
  });

  it("quotes the homepage's own answer over a guessed page's 403", () => {
    const msg = unreachableReason({ pages: [{ status: 404 }, { status: 403 }], ssrf_blocked: 0 });
    expect(msg).toContain("HTTP 404 (Not Found)");
    expect(msg).not.toContain("firewall");
  });

  it("names a block on a later page even when the homepage timed out", () => {
    const msg = unreachableReason({ pages: [{ status: 0 }, { status: 404 }, { status: 429 }], ssrf_blocked: 0 });
    expect(msg).toContain("HTTP 429 (Too Many Requests)");
  });
});

describe("fetchForSeoAudit retry honesty", () => {
  const pageFetch = (page: (n: number) => Response | Promise<Response>) => {
    let n = 0;
    return vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt") || url.endsWith("/llms.txt")) return new Response("", { status: 404 });
      return page(++n);
    });
  };

  it("does not retry before a Retry-After longer than it will wait", async () => {
    const fetchMock = pageFetch(() => new Response("later", { status: 429, headers: { "retry-after": "20" } }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchForSeoAudit("https://shop.example.com", ["/"]);

    expect(fetchMock.mock.calls.filter(([u]) => !/robots|llms/.test(u as string)).length).toBe(1);
    expect(r.pages[0]?.status).toBe(429);
  });

  it("holds every other page until the host's Retry-After, not just the one that got it", async () => {
    const fetchMock = pageFetch(() => new Response("later", { status: 429, headers: { "retry-after": "30" } }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await fetchForSeoAudit("https://shop.example.com", ["/", "/about", "/pricing"]);

    expect(fetchMock.mock.calls.filter(([u]) => !/robots|llms/.test(u as string)).length).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it("keeps the 429 when the retry gets no answer at all", async () => {
    vi.stubGlobal(
      "fetch",
      pageFetch((n) => {
        if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
        throw new Error("socket hang up");
      }),
    );

    const r = await fetchForSeoAudit("https://shop.example.com", ["/"]);

    expect(r.pages[0]?.status).toBe(429);
    expect(unreachableReason(r)).toContain("HTTP 429");
  });
});
