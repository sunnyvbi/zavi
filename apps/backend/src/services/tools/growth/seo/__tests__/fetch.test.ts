
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

import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import { extractSameSiteLinks, fetchForSeoAudit, DEFAULT_PATHS, MAX_PAGES, FETCH_CONCURRENCY, MAX_BYTES, compactHtml } from "../fetch";

const HTML = "<html><head><title>t</title></head><body><h1>h</h1></body></html>";

let requested: string[] = [];

function stubNetwork(robotsTxt: string): void {
  requested = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response(robotsTxt, { status: 200 });
      if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
      requested.push(url);
      return new Response(HTML, { status: 200 });
    }),
  );
}

function sitemapXml(...locs: string[]): string {
  return `<?xml version="1.0"?><urlset>${locs.map((l) => `<loc>${l}</loc>`).join("")}</urlset>`;
}

beforeEach(() => {
  safeFetchText.mockReset();
  safeFetchText.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchForSeoAudit — where the page sample comes from", () => {
  it("reads the sitemap robots.txt declares, and crawls real URLs from it", async () => {
    stubNetwork("User-agent: *\nAllow: /\nSitemap: https://upcar.ai/sitemap.xml\n");
    safeFetchText.mockImplementation(async (url) =>
      url === "https://upcar.ai/sitemap.xml"
        ? sitemapXml(
            "https://upcar.ai/",
            "https://upcar.ai/cars/tesla-model-3",
            "https://upcar.ai/cars/honda-civic",
            "https://upcar.ai/cities/los-angeles",
            "https://upcar.ai/host",
          )
        : null,
    );

    const r = await fetchForSeoAudit("https://upcar.ai");

    expect(requested).toEqual([
      "https://upcar.ai/",
      "https://upcar.ai/cars/tesla-model-3",
      "https://upcar.ai/cities/los-angeles",
      "https://upcar.ai/host",
      "https://upcar.ai/cars/honda-civic",
    ]);
    expect(requested).not.toContain("https://upcar.ai/features");
    expect(r.sitemapReachable).toBe(true);
    expect(r.pages).toHaveLength(5);
  });

  it("expands one bounded level of a sitemap index", async () => {
    stubNetwork("Sitemap: https://acme.com/sitemap.xml\n");
    safeFetchText.mockImplementation(async (url) => {
      if (url === "https://acme.com/sitemap.xml") {
        return `<?xml version="1.0"?><sitemapindex><loc>https://acme.com/sitemap-1.xml</loc></sitemapindex>`;
      }
      if (url === "https://acme.com/sitemap-1.xml") {
        return sitemapXml("https://acme.com/pricing", "https://acme.com/docs/start");
      }
      return null;
    });

    await fetchForSeoAudit("https://acme.com");

    expect(requested).toEqual([
      "https://acme.com/",
      "https://acme.com/pricing",
      "https://acme.com/docs/start",
    ]);
  });

  it("refuses to fetch a sitemap robots.txt points at another host", async () => {
    stubNetwork("Sitemap: https://evil.example.net/sitemap.xml\n");

    await fetchForSeoAudit("https://acme.com");

    expect(safeFetchText).not.toHaveBeenCalledWith(
      "https://evil.example.net/sitemap.xml",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("drops sitemap entries that point off the site", async () => {
    stubNetwork("Sitemap: https://acme.com/sitemap.xml\n");
    safeFetchText.mockResolvedValue(
      sitemapXml("https://evil.example.net/x", "http://acme.com/insecure", "https://acme.com/good"),
    );

    await fetchForSeoAudit("https://acme.com");

    expect(requested).toEqual(["https://acme.com/", "https://acme.com/good"]);
  });

  it("accepts the www variant of the same site", async () => {
    stubNetwork("Sitemap: https://www.acme.com/sitemap.xml\n");
    safeFetchText.mockImplementation(async (url) =>
      url === "https://www.acme.com/sitemap.xml" ? sitemapXml("https://www.acme.com/pricing") : null,
    );

    await fetchForSeoAudit("https://acme.com");

    expect(requested).toContain("https://acme.com/pricing");
  });

  it("stays within the page budget", async () => {
    stubNetwork("Sitemap: https://acme.com/sitemap.xml\n");
    safeFetchText.mockResolvedValue(
      sitemapXml(...Array.from({ length: 50 }, (_, i) => `https://acme.com/s${i}/page`)),
    );

    await fetchForSeoAudit("https://acme.com");

    expect(requested).toHaveLength(MAX_PAGES);
  });
});

describe("fetchForSeoAudit — fallbacks", () => {
  it("falls back to the guessed paths when there is no usable sitemap", async () => {
    stubNetwork("User-agent: *\nAllow: /\n");

    const r = await fetchForSeoAudit("https://acme.com");

    expect(requested).toEqual(DEFAULT_PATHS.map((p) => `https://acme.com${p}`.replace(/\/$/, "/")));
    expect(safeFetchText).toHaveBeenCalledWith(
      "https://acme.com/sitemap.xml",
      "acme.com",
      expect.any(Number),
      expect.any(Number),
    );
    expect(r.sitemapReachable).toBe(false);
  });

  it("uses the conventional sitemap location when robots.txt declares none", async () => {
    stubNetwork("User-agent: *\nAllow: /\n");
    safeFetchText.mockResolvedValue(sitemapXml("https://acme.com/only-real-page"));

    const r = await fetchForSeoAudit("https://acme.com");

    expect(requested).toEqual(["https://acme.com/", "https://acme.com/only-real-page"]);
    expect(r.sitemapReachable).toBe(true);
  });

  it("keeps a path the caller named specifically", async () => {
    stubNetwork("Sitemap: https://acme.com/sitemap.xml\n");
    safeFetchText.mockResolvedValue(
      sitemapXml(...Array.from({ length: 20 }, (_, i) => `https://acme.com/s${i}/page`)),
    );

    await fetchForSeoAudit("https://acme.com", [...DEFAULT_PATHS, "/solutions/dentists"]);

    expect(requested[0]).toBe("https://acme.com/");
    expect(requested[1]).toBe("https://acme.com/solutions/dentists");
  });
});

describe("fetchForSeoAudit — redirects are guarded per hop", () => {
  it("re-runs the SSRF guard on the redirect target", async () => {
    const INTERNAL = "http://169.254.169.254/latest/meta-data/";
    requested = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/robots.txt")) return new Response("User-Agent: *\nAllow: /", { status: 200 });
        if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        requested.push(url);
        return new Response("", { status: 302, headers: { location: INTERNAL } });
      }),
    );
    const guard = assertSafeUrl as unknown as ReturnType<typeof vi.fn>;
    guard.mockClear();
    guard.mockImplementation(async (u: string) => {
      if (u.startsWith("http://169.254.")) throw new Error("ssrf blocked");
    });

    const out = await fetchForSeoAudit("https://evil.example.com", ["/"]);

    const guarded = guard.mock.calls.map((c) => String(c[0]));
    expect(guarded).toContain(INTERNAL);
    expect(requested).not.toContain(INTERNAL);
    expect(out.pages.every((p) => p.html === "")).toBe(true);

    guard.mockImplementation(async () => undefined);
  });
});

describe("fetchForSeoAudit — concurrency", () => {
  let peak = 0;

  function stubTimed(): void {
    requested = [];
    peak = 0;
    let inFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/robots.txt")) return new Response("Sitemap: https://acme.com/sitemap.xml\n", { status: 200 });
        if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        requested.push(url);
        inFlight++;
        peak = Math.max(peak, inFlight);
        const idx = Number(/\/s(\d+)\//.exec(url)?.[1] ?? 0);
        await new Promise((r) => setTimeout(r, Math.max(1, 30 - idx)));
        inFlight--;
        return new Response(HTML, { status: 200 });
      }),
    );
    safeFetchText.mockResolvedValue(
      sitemapXml(...Array.from({ length: 50 }, (_, i) => `https://acme.com/s${i}/page`)),
    );
  }

  it("runs requests in parallel, bounded by FETCH_CONCURRENCY", async () => {
    stubTimed();
    await fetchForSeoAudit("https://acme.com");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(FETCH_CONCURRENCY);
  });

  it("returns pages in candidate order even when later pages resolve first", async () => {
    stubTimed();
    const r = await fetchForSeoAudit("https://acme.com");
    const got = r.pages.map((p) => p.url);
    const byRequestOrder = [...got].sort(
      (a, b) => requested.indexOf(a) - requested.indexOf(b),
    );
    expect(got).toEqual(byRequestOrder);
    expect(got[0]).toBe("https://acme.com/");
  });

  it("sees far more of a large site than the old serial ceiling of 6", async () => {
    stubTimed();
    const r = await fetchForSeoAudit("https://acme.com");
    expect(r.pages).toHaveLength(MAX_PAGES);
    expect(r.pages.length).toBeGreaterThan(6);
  });
});

describe("large pages — read far enough, keep only what the analyzers use", () => {
  const LD = '<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>';
  const hydration = `<script id="__NEXT_DATA__">${"x".repeat(900 * 1024)}</script>`;

  function stubPage(body: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow:", { status: 200 });
        if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        return new Response(body, { status: 200 });
      }),
    );
  }

  it("reads JSON-LD that sits past the old 400KB cap, and keeps the page small", async () => {
    stubPage(`<html><head><title>t</title></head><body><h1>h</h1>${hydration}${LD}</body></html>`);
    const r = await fetchForSeoAudit("https://acme.com", ["/"]);
    const home = r.pages[0];
    expect(home.truncated).toBe(false);
    expect(home.html).toContain('"@type":"Organization"');
    expect(home.html).toContain('<script id="__NEXT_DATA__"></script>');
    expect(home.html.length).toBeLessThan(2_000);
  });

  it("marks a page past the read cap as truncated, and drops an unclosed trailing script", async () => {
    stubPage(`<html><body><h1>h</h1><p>real words here</p><script>${"y".repeat(MAX_BYTES + 1024)}</script>${LD}</body></html>`);
    const r = await fetchForSeoAudit("https://acme.com", ["/"]);
    const home = r.pages[0];
    expect(home.truncated).toBe(true);
    expect(home.html).toContain("real words here");
    expect(home.html).not.toContain("yyyy");
  });
});

describe("compactHtml", () => {
  it("empties inline scripts and styles but keeps JSON-LD whole", () => {
    const html =
      '<head><style>.a{color:red}</style><script src="/app.js"></script><script>window.x=1</script>' +
      '<script type="application/ld+json">{"@type":"Product"}</script></head>';
    expect(compactHtml(html, false)).toBe(
      '<head><style></style><script src="/app.js"></script><script></script>' +
        '<script type="application/ld+json">{"@type":"Product"}</script></head>',
    );
  });

  it("keeps JSON-LD whatever the attribute order or quoting", () => {
    const html = "<script data-x=1 type=application/ld+json>{}</script>";
    expect(compactHtml(html, false)).toBe(html);
  });

  it("cuts an unclosed script or style only on a truncated page", () => {
    expect(compactHtml("<p>a</p><script>var z=", true)).toBe("<p>a</p>");
    expect(compactHtml("<p>a</p><style>.z{", true)).toBe("<p>a</p>");
    expect(compactHtml("<p>a</p><script>var z=", false)).toBe("<p>a</p><script>var z=");
  });
});

describe("fetchForSeoAudit — app shells and catch-all routes", () => {
  const SHELL = "<!doctype html><html><head><title>App</title></head><body><div id=root></div></body></html>";
  let all: string[] = [];

  function stubShell(): void {
    all = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        all.push(url);
        return new Response(SHELL, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      }),
    );
  }

  it("does not guess paths when the sitemap was read, even if it lists only /", async () => {
    stubNetwork("User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.xml\n");
    safeFetchText.mockResolvedValue(sitemapXml("https://acme.com/"));

    const r = await fetchForSeoAudit("https://acme.com");

    expect(requested).toEqual(["https://acme.com/"]);
    expect(r.sitemapReachable).toBe(true);
  });

  it("still counts a text sitemap as reachable", async () => {
    stubNetwork("User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.txt\n");
    safeFetchText.mockResolvedValue("https://acme.com/\nhttps://acme.com/pricing\n");

    const r = await fetchForSeoAudit("https://acme.com");

    expect(r.sitemapReachable).toBe(true);
  });

  it("treats an HTML shell as no robots.txt, no llms.txt and no sitemap", async () => {
    stubShell();
    safeFetchText.mockResolvedValue(SHELL);

    const r = await fetchForSeoAudit("https://acme.com");

    expect(r.robots.fetched).toBe(false);
    expect(r.robotsBody).toBeNull();
    expect(r.llmsTxt).toBe(false);
    expect(r.sitemapReachable).toBe(false);
    expect(r.graph.llms_txt_paths).toBeNull();
  });

  it("still reads a real robots.txt served as text/html", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/robots.txt")
          ? new Response("User-agent: *\nDisallow: /\n", { status: 200, headers: { "content-type": "text/html" } })
          : new Response(HTML, { status: 200 }),
      ),
    );

    const r = await fetchForSeoAudit("https://acme.com");

    expect(r.robots.fetched).toBe(true);
    expect(r.robots.disallowsAll).toBe(true);
  });
});

describe("fetchForSeoAudit — a site stored with a path", () => {
  it("reads root files from the origin and starts the crawl at the stored page", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
        if (url.endsWith("/llms.txt")) return new Response("", { status: 404 });
        return new Response(HTML, { status: 200 });
      }),
    );
    safeFetchText.mockResolvedValue(sitemapXml("https://example.com/squad", "https://example.com/portfolio"));

    await fetchForSeoAudit("https://example.com/squad");

    expect(seen).toContain("https://example.com/robots.txt");
    expect(seen).toContain("https://example.com/llms.txt");
    expect(seen).not.toContain("https://example.com/squad/robots.txt");
    expect(safeFetchText).toHaveBeenCalledWith(
      "https://example.com/sitemap.xml",
      "example.com",
      expect.any(Number),
      expect.any(Number),
    );
    expect(seen).toContain("https://example.com/squad/");
    expect(seen).toContain("https://example.com/portfolio");
    expect(seen).not.toContain("https://example.com/squad/portfolio");
  });
});

it("keeps hosted SEO discovery on the company, not provider or sibling", () => {
  const html = `<a href="https://netlify.app/pricing">Host</a><a href="https://rival.netlify.app/about">Rival</a><a href="https://clinic.netlify.app/services">Own</a>`;
  expect(extractSameSiteLinks(html, "https://clinic.netlify.app/", "clinic.netlify.app")).toEqual(["/services"]);
});

it("uses the hosted company as the sitemap fetch boundary", async () => {
  stubNetwork("Sitemap: https://clinic.netlify.app/sitemap.xml\nSitemap: https://netlify.app/provider.xml\nSitemap: https://rival.netlify.app/rival.xml\n");
  safeFetchText.mockResolvedValue(sitemapXml("https://clinic.netlify.app/services", "https://netlify.app/pricing", "https://rival.netlify.app/about"));
  await fetchForSeoAudit("https://clinic.netlify.app");
  expect(safeFetchText).toHaveBeenCalled();
  for (const [url, root] of safeFetchText.mock.calls) {
    expect(new URL(url).hostname).toBe("clinic.netlify.app");
    expect(root).toBe("clinic.netlify.app");
  }
});
