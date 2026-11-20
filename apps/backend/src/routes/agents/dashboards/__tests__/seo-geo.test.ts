import { describe, it, expect, vi, beforeEach } from "vitest";

import { ExpectedToolError } from "@/services/tools/types";

const mockState = vi.hoisted(() => ({
  gsc: null as null | (() => Promise<unknown>),
  health: null as null | (() => Promise<unknown>),
  geo: null as null | (() => Promise<unknown>),
  performance: null as null | (() => Promise<unknown>),
  healthOpts: undefined as undefined | { maxAgeMs?: number },
  geoOpts: undefined as undefined | { maxAgeMs?: number },
  performanceOpts: undefined as undefined | { maxAgeMs?: number },
  publishCrawled: undefined as undefined | string | null,
  publish: null as unknown,
}));

vi.mock("@/services/tools/growth/seo/site-publish-state", () => ({
  sitePublishDeps: vi.fn(() => ({})),
  getSitePublishState: vi.fn(async (_t: string, crawled: string | null) => {
    mockState.publishCrawled = crawled;
    return mockState.publish;
  }),
}));

vi.mock("@/services/tools/google-search-console/summary", () => ({
  buildSearchConsoleSummary: vi.fn(async () => {
    if (!mockState.gsc) throw new Error("no gsc configured");
    return mockState.gsc();
  }),
}));

vi.mock("@/services/tools/growth/seo/snapshot", () => ({
  getSeoSiteHealth: vi.fn(async (_t: string, opts?: { maxAgeMs?: number }) => {
    mockState.healthOpts = opts;
    if (!mockState.health) throw new Error("no health configured");
    return mockState.health();
  }),
  getGeoReadiness: vi.fn(async (_t: string, opts?: { maxAgeMs?: number }) => {
    mockState.geoOpts = opts;
    if (!mockState.geo) throw new Error("no geo configured");
    return mockState.geo();
  }),
  getSeoPerformance: vi.fn(async (_t: string, opts?: { maxAgeMs?: number }) => {
    mockState.performanceOpts = opts;
    if (!mockState.performance) throw new Error("no performance configured");
    return mockState.performance();
  }),
}));

import { build } from "../seo-geo";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

const HEALTH = {
  status: "ok" as const,
  site: "https://example.com",
  error_code: null,
  fetched_at: new Date().toISOString(),
  stale: false,
  pages_analyzed: 2,
  findings: [
    {
      code: "title_duplicate",
      severity: "high" as const,
      summary: "Different pages share the same title.",
      urls: ["https://example.com/", "https://example.com/pricing"],
    },
  ],
  pages: [],
  notes: [],
};

const GEO = {
  status: "ok" as const,
  site: "https://example.com",
  error_code: null,
  fetched_at: new Date().toISOString(),
  stale: false,
  notes: [],
  pages_analyzed: 2,
  score: { total: 58, bands: [] },
  crawlers: [],
  llms_txt: false,
  findings: [],
  pages: [],
  not_checked: ["Whether you are actually cited in AI Overviews."],
};

const PERFORMANCE = {
  status: "ok" as const,
  site: "https://example.com",
  error_code: null,
  audit_fetched_at: new Date().toISOString(),
  stale: false,
  notes: [],
  field: { state: "no_data" as const, tried: ["url", "origin"] },
  lab: { state: "ok" as const, pages: [], truncated: false },
  fetched_at: new Date().toISOString(),
  warming: false,
};

const GSC = {
  connected: true as const,
  site_url: "sc-domain:example.com",
  days: 28,
  start_date: "2026-08-05",
  end_date: "2026-09-01",
  totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  series: [],
  top_queries: [],
  top_pages: [],
};

const ctx = {
  tenantId: TID,
  accessToken: "tok",
  ctx: { tenant_id: TID, log: () => {}, agent_slug: "seo-geo" },
  sb: {},
  refresh: false,
} as unknown as Parameters<typeof build>[0];

beforeEach(() => {
  mockState.gsc = async () => GSC;
  mockState.health = async () => HEALTH;
  mockState.geo = async () => GEO;
  mockState.performance = async () => PERFORMANCE;
  mockState.healthOpts = undefined;
  mockState.geoOpts = undefined;
  mockState.performanceOpts = undefined;
  mockState.publishCrawled = undefined;
  mockState.publish = null;
});

describe("seo-geo dashboard builder", () => {
  it("returns both lanes when Search Console is connected", async () => {
    const p = await build(ctx);
    expect(p.connected).toBe(true);
    expect(p.totals).toEqual(GSC.totals);
    expect(p.site_health).toEqual(HEALTH);
  });

  it("KEEPS site_health when Search Console is not connected", async () => {
    mockState.gsc = async () => {
      throw new ExpectedToolError("google_search_console_not_connected", "nope");
    };
    const p = await build(ctx);

    expect(p.connected).toBe(false);
    expect(p.site_health).toEqual(HEALTH);
    expect((p.site_health as typeof HEALTH).findings).toHaveLength(1);
  });

  it("treats not_configured the same as not_connected", async () => {
    mockState.gsc = async () => {
      throw new ExpectedToolError("google_search_console_not_configured", "nope");
    };
    const p = await build(ctx);
    expect(p.connected).toBe(false);
    expect(p.load_error).toBeUndefined();
    expect(p.site_health).toEqual(HEALTH);
  });

  it("reports a real GSC fault as load_error, still with site_health", async () => {
    mockState.gsc = async () => {
      throw new Error("502 from Google");
    };
    const p = await build(ctx);
    expect(p.connected).toBe(true);
    expect(p.load_error).toBe(true);
    expect(p.site_health).toEqual(HEALTH);
  });

  it("keeps the Search Console lane when the health lane returns nothing", async () => {
    mockState.health = async () => null;
    const p = await build(ctx);
    expect(p.connected).toBe(true);
    expect(p.totals).toEqual(GSC.totals);
    expect(p.site_health).toBeNull();
  });

  it("never throws when the health lane throws", async () => {
    mockState.health = async () => {
      throw new Error("unexpected");
    };
    const p = await build(ctx);
    expect(p.connected).toBe(true);
    expect(p.site_health).toBeNull();
  });

  it("never throws when BOTH lanes fail", async () => {
    mockState.gsc = async () => {
      throw new ExpectedToolError("google_search_console_not_connected", "nope");
    };
    mockState.health = async () => null;
    mockState.geo = async () => null;
    mockState.performance = async () => null;
    const p = await build(ctx);
    expect(p).toEqual({
      connected: false,
      site_health: null,
      geo: null,
      performance: null,
      site_publish: null,
    });
  });

  it("asks about the site the crawl actually read and returns its publish state", async () => {
    mockState.publish = { pending: 2, capped: false };
    const p = await build(ctx);
    expect(mockState.publishCrawled).toBe("https://example.com");
    expect(p.site_publish).toEqual({ pending: 2, capped: false });
  });

  it("returns the GEO lane with Search Console connected", async () => {
    const p = await build(ctx);
    expect(p.geo).toEqual(GEO);
  });

  it("KEEPS the GEO lane when Search Console is not connected", async () => {
    mockState.gsc = async () => {
      throw new ExpectedToolError("google_search_console_not_connected", "nope");
    };
    const p = await build(ctx);
    expect(p.connected).toBe(false);
    expect(p.geo).toEqual(GEO);
  });

  it("keeps the other two lanes when GEO returns nothing", async () => {
    mockState.geo = async () => null;
    const p = await build(ctx);
    expect(p.geo).toBeNull();
    expect(p.site_health).toEqual(HEALTH);
    expect(p.totals).toEqual(GSC.totals);
  });

  it("never throws when the GEO lane throws", async () => {
    mockState.geo = async () => {
      throw new Error("unexpected");
    };
    const p = await build(ctx);
    expect(p.geo).toBeNull();
    expect(p.site_health).toEqual(HEALTH);
    expect(p.connected).toBe(true);
  });

  it("keeps GEO alive when the SEO health lane is the one that dies", async () => {
    mockState.health = async () => {
      throw new Error("unexpected");
    };
    const p = await build(ctx);
    expect(p.site_health).toBeNull();
    expect(p.geo).toEqual(GEO);
  });

  it("returns the performance lane alongside the other three", async () => {
    const p = await build(ctx);
    expect(p.performance).toEqual(PERFORMANCE);
  });

  it("KEEPS the performance lane when Search Console is not connected", async () => {
    mockState.gsc = async () => {
      throw new ExpectedToolError("google_search_console_not_connected", "nope");
    };
    const p = await build(ctx);
    expect(p.connected).toBe(false);
    expect(p.performance).toEqual(PERFORMANCE);
  });

  it("degrades to a partial payload when the fetchers came back unavailable", async () => {
    const unavailable = {
      ...PERFORMANCE,
      field: { state: "unavailable" as const, reason: "Google is rate-limiting these checks." },
      lab: { state: "unavailable" as const, reason: "Google is rate-limiting these checks." },
    };
    mockState.performance = async () => unavailable;
    const p = await build(ctx);

    expect(p.performance).toEqual(unavailable);
    expect(p.site_health).toEqual(HEALTH);
    expect(p.geo).toEqual(GEO);
    expect(p.connected).toBe(true);
  });

  it("carries not_configured through as its own state, not as an error", async () => {
    const notConfigured = {
      ...PERFORMANCE,
      field: { state: "not_configured" as const },
      lab: { state: "not_configured" as const },
    };
    mockState.performance = async () => notConfigured;
    const p = await build(ctx);

    expect(p.performance).toEqual(notConfigured);
    expect(p.load_error).toBeUndefined();
  });

  it("keeps the other three lanes when performance returns nothing", async () => {
    mockState.performance = async () => null;
    const p = await build(ctx);
    expect(p.performance).toBeNull();
    expect(p.site_health).toEqual(HEALTH);
    expect(p.geo).toEqual(GEO);
    expect(p.totals).toEqual(GSC.totals);
  });

  it("never throws when the performance lane throws", async () => {
    mockState.performance = async () => {
      throw new Error("unexpected");
    };
    const p = await build(ctx);
    expect(p.performance).toBeNull();
    expect(p.site_health).toEqual(HEALTH);
    expect(p.geo).toEqual(GEO);
    expect(p.connected).toBe(true);
  });

  it("keeps performance alive when the health lane is the one that dies", async () => {
    mockState.health = async () => {
      throw new Error("unexpected");
    };
    const p = await build(ctx);
    expect(p.site_health).toBeNull();
    expect(p.performance).toEqual(PERFORMANCE);
  });

  it("does not blank the panel when the vitals could not be SAVED", async () => {
    const explained = {
      ...PERFORMANCE,
      field: { state: "unavailable", reason: "We measured your site but couldn't save it." },
      lab: { state: "unavailable", reason: "We measured your site but couldn't save it." },
      fetched_at: new Date().toISOString(),
      warming: false,
    };
    mockState.performance = async () => explained;
    const p = await build(ctx);

    expect(p.performance).toEqual(explained);
    expect(p.site_health).toEqual(HEALTH);
    expect(p.geo).toEqual(GEO);
  });

  it("carries the warming flag through untouched", async () => {
    const warming = {
      ...PERFORMANCE,
      field: null,
      lab: null,
      fetched_at: null,
      warming: true,
    };
    mockState.performance = async () => warming;
    const p = await build(ctx);

    expect(p.performance).toEqual(warming);
    expect((p.performance as typeof warming).warming).toBe(true);
    expect(p.site_health).toEqual(HEALTH);
    expect(p.geo).toEqual(GEO);
    expect(p.connected).toBe(true);
  });

  it("does not wait on the lane — the render finishes at the speed of the others", async () => {
    mockState.gsc = async () => {
      await new Promise((res) => setTimeout(res, 25));
      return GSC;
    };
    const started = Date.now();
    await build(ctx);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("seo-geo dashboard builder — refresh", () => {
  it("serves the snapshot cache on a normal open", async () => {
    await build(ctx);
    expect(mockState.healthOpts?.maxAgeMs).toBeUndefined();
    expect(mockState.geoOpts?.maxAgeMs).toBeUndefined();
    expect(mockState.performanceOpts?.maxAgeMs).toBeUndefined();
  });

  it("bypasses the snapshot cache on all three cached lanes when refresh is set", async () => {
    await build({ ...ctx, refresh: true });
    expect(mockState.healthOpts?.maxAgeMs).toBe(0);
    expect(mockState.geoOpts?.maxAgeMs).toBe(0);
    expect(mockState.performanceOpts?.maxAgeMs).toBe(0);
  });
});
