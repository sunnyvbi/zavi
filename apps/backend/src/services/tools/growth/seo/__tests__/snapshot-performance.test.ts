
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ExpectedToolError } from "@/services/tools/types";
import { GOOGLE_PAGESPEED_API_KEY_ENV } from "../google-api";

type Row = Record<string, unknown> | null;

const MISSING_COLUMN_ERROR = {
  code: "42703",
  message: "column seo_audit_snapshots.performance_report does not exist",
};

const mockState = vi.hoisted(() => ({
  row: null as Row,
  facadeThrows: false,
  upserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  selects: [] as string[],
  performanceColumnMissing: false,
  selectError: null as null | { code: string; message: string },
  updateError: null as null | { code: string; message: string },
  runCalls: 0,
  run: null as null | (() => Promise<unknown>),
  siteOnFile: "https://example.com" as string | null,
  perfCalls: 0,
  perfUrls: [] as string[],
  perf: null as null | ((urls: string[]) => Promise<unknown>),
}));

function makeBuilder() {
  const b: Record<string, unknown> = {};
  b.eq = vi.fn(() => b);
  b.select = vi.fn((cols: string) => {
    mockState.selects.push(cols);
    return b;
  });
  b.maybeSingle = vi.fn(async () => {
    const asked = mockState.selects[mockState.selects.length - 1] ?? "";
    if (mockState.selectError) return { data: null, error: { ...mockState.selectError } };
    if (mockState.performanceColumnMissing && asked.includes("performance_report")) {
      return { data: null, error: { ...MISSING_COLUMN_ERROR } };
    }
    return { data: mockState.row, error: null };
  });
  b.upsert = vi.fn(async (payload: Record<string, unknown>) => {
    mockState.upserts.push(payload);
    return { data: null, error: null };
  });
  b.update = vi.fn(async (values: Record<string, unknown>) => {
    mockState.updates.push(values);
    return { data: null, error: mockState.updateError };
  });
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: vi.fn(() => {
      if (mockState.facadeThrows) throw new Error("seo_audit_snapshots is not registered");
      return makeBuilder();
    }),
  }),
}));

vi.mock("../run", () => ({
  runSiteAudit: vi.fn(async () => {
    mockState.runCalls++;
    if (!mockState.run) throw new Error("no run configured");
    return mockState.run();
  }),
  resolveTenantSite: vi.fn(async () => mockState.siteOnFile),
}));

vi.mock("../performance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../performance")>();
  return {
    ...actual,
    fetchSeoPerformance: vi.fn(async (urls: string[]) => {
      mockState.perfCalls++;
      mockState.perfUrls = urls;
      if (!mockState.perf) throw new Error("no perf configured");
      return mockState.perf(urls);
    }),
  };
});

import {
  getSeoPerformance,
  SEO_AUDIT_SCHEMA,
  SEO_AUDIT_TTL_MS,
  SEO_PERFORMANCE_ERROR_TTL_MS,
  SEO_PERFORMANCE_TTL_MS,
} from "../snapshot";

let TID = freshTenant();
function freshTenant(): string {
  return `73db45ff-457e-4541-bc8f-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
}

const PAGE = {
  url: "https://example.com/",
  status: 200,
  title: "Example",
  title_length: 7,
  meta_description: null,
  canonical: null,
  h1_count: 1,
  schema_types: [],
  noindex: false,
  visible_words: 400,
};

const GEO_REPORT = {
  pages_analyzed: 1,
  score: { total: 55, bands: [] },
  crawlers: [],
  llms_txt: false,
  findings: [],
  pages: [],
  not_checked: [],
};

function perfOk(over: Record<string, unknown> = {}) {
  return {
    field: {
      state: "ok" as const,
      scope: "origin" as const,
      key: "https://example.com",
      collection_period: { first_date: "2026-08-17", last_date: "2026-09-13" },
      metrics: {},
    },
    lab: {
      state: "ok" as const,
      pages: [{ kind: "ok", requested_url: "https://example.com/" }],
      truncated: false,
    },
    fetched_at: new Date().toISOString(),
    ...over,
  };
}

function storedRow(over: Record<string, unknown> = {}): Row {
  return {
    site: "https://example.com",
    status: "ok",
    error_code: null,
    report: { pages_analyzed: 1, findings: [], pages: [PAGE] },
    geo_report: GEO_REPORT,
    performance_report: null,
    notes: [],
    schema_version: SEO_AUDIT_SCHEMA,
    fetched_at: new Date().toISOString(),
    ...over,
  };
}

function freshRun() {
  return {
    site: "https://example.com",
    provenance: "public" as const,
    notes: [],
    seo: { pages_analyzed: 1, findings: [], pages: [PAGE] },
    geo: GEO_REPORT,
  };
}

const settleWarm = () => new Promise((res) => setTimeout(res, 0));

let hadKey: string | undefined;

beforeEach(() => {
  hadKey = process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
  process.env[GOOGLE_PAGESPEED_API_KEY_ENV] = "test-key-do-not-log";
  TID = freshTenant();
  mockState.row = null;
  mockState.facadeThrows = false;
  mockState.upserts = [];
  mockState.updates = [];
  mockState.selects = [];
  mockState.performanceColumnMissing = false;
  mockState.selectError = null;
  mockState.updateError = null;
  mockState.runCalls = 0;
  mockState.run = async () => freshRun();
  mockState.siteOnFile = "https://example.com";
  mockState.perfCalls = 0;
  mockState.perfUrls = [];
  mockState.perf = async () => perfOk();
});

afterEach(async () => {
  await settleWarm();
  if (hadKey === undefined) delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
  else process.env[GOOGLE_PAGESPEED_API_KEY_ENV] = hadKey;
});

describe("getSeoPerformance — the schema bump", () => {
  it("treats a schema-2 row as a cache miss and re-crawls", async () => {
    mockState.row = storedRow({ schema_version: 2 });
    await getSeoPerformance(TID);
    expect(mockState.runCalls).toBe(1);
  });

  it("keeps a fresh performance half across a crawl-schema bump", async () => {
    mockState.row = storedRow({ schema_version: SEO_AUDIT_SCHEMA - 1, performance_report: perfOk() });
    const p = await getSeoPerformance(TID);
    expect(mockState.runCalls).toBe(1);
    expect(p?.lab).toMatchObject({ state: "ok" });
    expect(p?.warming).toBe(false);
    expect(mockState.perfCalls).toBe(0);
  });

  it("is at 9 — performance (3), GEO check-completeness (4), per-page site-health checks (5), sitemap-judged crawler blocks (6), HTML-only rules skip Markdown/text (7), scanner false positives (8), non_html_urls (9)", () => {
    expect(SEO_AUDIT_SCHEMA).toBe(9);
  });
});

describe("getSeoPerformance — its own, longer TTL", () => {
  it("is longer than the crawl's", () => {
    expect(SEO_PERFORMANCE_TTL_MS).toBeGreaterThan(SEO_AUDIT_TTL_MS);
  });

  it("serves a stored payload without re-measuring", async () => {
    mockState.row = storedRow({ performance_report: perfOk() });
    const p = await getSeoPerformance(TID);

    expect(mockState.perfCalls).toBe(0);
    expect(p?.field?.state).toBe("ok");
    expect(p?.lab?.state).toBe("ok");
  });

  it("serves a payload that is stale by the CRAWL's TTL but fresh by its own", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * SEO_AUDIT_TTL_MS).toISOString();
    mockState.row = storedRow({
      fetched_at: twoDaysAgo,
      performance_report: perfOk({ fetched_at: twoDaysAgo }),
    });
    const p = await getSeoPerformance(TID);

    expect(mockState.runCalls).toBe(1);
    expect(mockState.perfCalls).toBe(0);
    expect(p?.fetched_at).toBe(twoDaysAgo);
  });

  it("re-measures once the payload passes its own TTL", async () => {
    mockState.row = storedRow({
      performance_report: perfOk({
        fetched_at: new Date(Date.now() - SEO_PERFORMANCE_TTL_MS - 60_000).toISOString(),
      }),
    });
    await getSeoPerformance(TID);
    expect(mockState.perfCalls).toBe(1);
  });

  it("re-measures on a forced refresh", async () => {
    mockState.row = storedRow({ performance_report: perfOk() });
    await getSeoPerformance(TID, { maxAgeMs: 0 });
    expect(mockState.perfCalls).toBe(1);
  });
});

describe("getSeoPerformance — the crawl must not wipe the vitals", () => {
  it("carries a fresh stored payload across a crawl refresh", async () => {
    mockState.row = storedRow({
      fetched_at: new Date(Date.now() - SEO_AUDIT_TTL_MS - 60_000).toISOString(),
      performance_report: perfOk(),
    });
    const p = await getSeoPerformance(TID);

    expect(mockState.runCalls).toBe(1);
    expect(mockState.perfCalls).toBe(0);
    expect(p?.lab?.state).toBe("ok");
  });

  it("never writes performance_report as part of the crawl upsert", async () => {
    await getSeoPerformance(TID);
    expect(mockState.upserts).toHaveLength(1);
    expect(mockState.upserts[0]).not.toHaveProperty("performance_report");
  });

  it("writes the vitals through a column-scoped update, not a whole-row upsert", async () => {
    await getSeoPerformance(TID);
    await settleWarm();
    expect(mockState.updates).toHaveLength(1);
    expect(Object.keys(mockState.updates[0]).sort()).toEqual([
      "performance_report",
      "updated_at",
    ]);
  });
});

describe("getSeoPerformance — what is worth storing", () => {
  it("never stores a not_configured result", async () => {
    mockState.perf = async () => ({
      field: { state: "not_configured" as const },
      lab: { state: "not_configured" as const },
      fetched_at: new Date().toISOString(),
    });
    await getSeoPerformance(TID);
    await settleWarm();

    expect(mockState.perfCalls).toBe(1);
    expect(mockState.updates).toHaveLength(0);
  });

  it("says not_configured directly when there is no key, and does NOT warm", async () => {
    delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
    const p = await getSeoPerformance(TID);

    expect(p?.field).toEqual({ state: "not_configured" });
    expect(p?.lab).toEqual({ state: "not_configured" });
    expect(p?.warming).toBe(false);
    expect(mockState.perfCalls).toBe(0);
  });

  it("re-derives not_configured rather than serving a stored one", async () => {
    mockState.row = storedRow({
      performance_report: {
        field: { state: "not_configured" },
        lab: { state: "not_configured" },
        fetched_at: new Date().toISOString(),
      },
    });
    await getSeoPerformance(TID);
    expect(mockState.perfCalls).toBe(1);
  });

  it("ages a failed lab half out on the short error TTL, not the week", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * SEO_PERFORMANCE_ERROR_TTL_MS).toISOString();
    mockState.row = storedRow({
      performance_report: perfOk({
        lab: { state: "unavailable", reason: "Google is rate-limiting these checks right now." },
        fetched_at: twoHoursAgo,
      }),
    });
    await getSeoPerformance(TID);
    expect(mockState.perfCalls).toBe(1);
  });

  it("keeps serving a CrUX no_data for the full week — it is not a failure", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * SEO_PERFORMANCE_ERROR_TTL_MS).toISOString();
    mockState.row = storedRow({
      performance_report: perfOk({
        field: { state: "no_data", tried: ["url", "origin"] },
        fetched_at: twoHoursAgo,
      }),
    });
    const p = await getSeoPerformance(TID);

    expect(mockState.perfCalls).toBe(0);
    expect(p?.field).toEqual({ state: "no_data", tried: ["url", "origin"] });
  });

  it("discards a payload measured against a site the customer has since changed", async () => {
    mockState.row = storedRow({
      site: "https://old-domain.com",
      report: { pages_analyzed: 1, findings: [], pages: [{ ...PAGE, url: "https://new.com/" }] },
      performance_report: perfOk(),
    });
    mockState.siteOnFile = "https://new.com";
    mockState.run = async () => ({
      ...freshRun(),
      site: "https://new.com",
      seo: { pages_analyzed: 1, findings: [], pages: [{ ...PAGE, url: "https://new.com/" }] },
    });

    await getSeoPerformance(TID);
    expect(mockState.perfCalls).toBe(1);
  });
});

describe("getSeoPerformance — never blanks the panel", () => {
  it("measures the pages the CRAWL visited, not a list it invented", async () => {
    mockState.row = storedRow({
      report: {
        pages_analyzed: 2,
        findings: [],
        pages: [PAGE, { ...PAGE, url: "https://example.com/pricing" }],
      },
    });
    await getSeoPerformance(TID);

    expect(mockState.perfUrls).toEqual([
      "https://example.com/",
      "https://example.com/pricing",
    ]);
  });

  it("explains an unreachable site instead of measuring nothing", async () => {
    mockState.run = async () => {
      throw new ExpectedToolError("seo_site_unreachable", "nope");
    };
    const p = await getSeoPerformance(TID);

    expect(p?.status).toBe("error");
    expect(p?.error_code).toBe("seo_site_unreachable");
    expect(p?.field?.state).toBe("unavailable");
    expect(p?.lab?.state).toBe("unavailable");
    expect(mockState.perfCalls).toBe(0);
  });

  it("explains a missing URL on file the same way", async () => {
    mockState.siteOnFile = null;
    mockState.run = async () => {
      throw new ExpectedToolError("seo_site_unknown", "nope");
    };
    const p = await getSeoPerformance(TID);

    expect(p?.error_code).toBe("seo_site_unknown");
    if (p?.lab?.state !== "unavailable") throw new Error("unreachable");
    expect(p.lab.reason).toContain("no website on file");
  });

  it("returns null — not a throw — when there is nothing at all to say", async () => {
    mockState.run = async () => {
      throw new Error("unclassified");
    };
    await expect(getSeoPerformance(TID)).resolves.toBeNull();
  });

  it("does not throw when the fetcher explodes — the warm fails, the render does not", async () => {
    mockState.perf = async () => {
      throw new Error("boom");
    };
    const p = await getSeoPerformance(TID);

    expect(p).not.toBeNull();
    expect(p?.field).toBeNull();
    expect(p?.lab).toBeNull();
    await settleWarm();
    expect(mockState.updates).toHaveLength(0);
  });

  it("keeps a stale-but-true payload on screen while the fresh one is measured", async () => {
    const old = new Date(Date.now() - SEO_PERFORMANCE_TTL_MS - 60_000).toISOString();
    mockState.row = storedRow({ performance_report: perfOk({ fetched_at: old }) });
    const p = await getSeoPerformance(TID);

    expect(p?.field?.state).toBe("ok");
    expect(p?.fetched_at).toBe(old);
    expect(p?.warming).toBe(true);
  });

  it("WITHHOLDS a payload about the customer's old site — wrong, not merely stale", async () => {
    mockState.row = storedRow({
      site: "https://old-domain.com",
      report: { pages_analyzed: 1, findings: [], pages: [{ ...PAGE, url: "https://new.com/" }] },
      performance_report: perfOk(),
    });
    mockState.siteOnFile = "https://new.com";
    mockState.run = async () => ({
      ...freshRun(),
      site: "https://new.com",
      seo: { pages_analyzed: 1, findings: [], pages: [{ ...PAGE, url: "https://new.com/" }] },
    });
    const p = await getSeoPerformance(TID);

    expect(p?.field).toBeNull();
    expect(p?.lab).toBeNull();
    expect(p?.warming).toBe(true);
  });

  it("does not throw when the cache facade throws on `.from()`", async () => {
    mockState.facadeThrows = true;
    await expect(getSeoPerformance(TID)).resolves.not.toThrow();
  });

  it("carries the crawl's own freshness separately from the vitals'", async () => {
    const crawledAt = new Date(Date.now() - 60_000).toISOString();
    const measuredAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    mockState.row = storedRow({
      fetched_at: crawledAt,
      performance_report: perfOk({ fetched_at: measuredAt }),
    });
    const p = await getSeoPerformance(TID);

    expect(p?.fetched_at).toBe(measuredAt);
    expect(p?.audit_fetched_at).toBe(crawledAt);
  });
});

describe("getSeoPerformance — never blocks the render", () => {
  function hangingMeasure() {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    mockState.perf = async () => {
      await gate;
      return perfOk();
    };
    return { release };
  }

  it("returns in well under a second on a COLD tenant while the measure runs", async () => {
    const { release } = hangingMeasure();
    const started = Date.now();
    const p = await getSeoPerformance(TID);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500);
    expect(p).not.toBeNull();
    expect(p?.field).toBeNull();
    expect(p?.lab).toBeNull();
    expect(p?.fetched_at).toBeNull();
    expect(p?.warming).toBe(true);
    expect(mockState.perfCalls).toBe(1);

    release();
    await settleWarm();
  });

  it("refresh=1 QUEUES a re-measure and returns the current numbers, it does not block", async () => {
    mockState.row = storedRow({ performance_report: perfOk() });
    const { release } = hangingMeasure();

    const started = Date.now();
    const p = await getSeoPerformance(TID, { maxAgeMs: 0 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500);
    expect(mockState.perfCalls).toBe(1);
    expect(p?.field?.state).toBe("ok");
    expect(p?.warming).toBe(true);

    release();
    await settleWarm();
  });

  it("collects the measure on a LATER render rather than this one", async () => {
    const { release } = hangingMeasure();
    const first = await getSeoPerformance(TID);
    expect(first?.field).toBeNull();

    release();
    await settleWarm();
    expect(mockState.updates).toHaveLength(1);
  });

  it("six impatient renders produce ONE measure, not six", async () => {
    const { release } = hangingMeasure();
    const renders = await Promise.all([
      getSeoPerformance(TID),
      getSeoPerformance(TID),
      getSeoPerformance(TID, { maxAgeMs: 0 }),
      getSeoPerformance(TID),
      getSeoPerformance(TID, { maxAgeMs: 0 }),
      getSeoPerformance(TID),
    ]);

    expect(mockState.perfCalls).toBe(1);
    expect(renders.every((r) => r?.warming === true)).toBe(true);

    release();
    await settleWarm();
    expect(mockState.updates).toHaveLength(1);
  });

  it("starts a fresh measure once the previous one has finished", async () => {
    await getSeoPerformance(TID);
    await settleWarm();
    expect(mockState.perfCalls).toBe(1);

    await getSeoPerformance(TID, { maxAgeMs: 0 });
    expect(mockState.perfCalls).toBe(2);
    await settleWarm();
  });

  it("a REJECTED warm does not surface as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      mockState.perf = async () => {
        throw new Error("PSI exploded");
      };
      const p = await getSeoPerformance(TID);
      expect(p).not.toBeNull();

      await settleWarm();
      await settleWarm();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clears the warming flag once a failed warm is done", async () => {
    mockState.perf = async () => {
      throw new Error("PSI exploded");
    };
    const first = await getSeoPerformance(TID);
    expect(first?.warming).toBe(true);

    await settleWarm();
    const second = await getSeoPerformance(TID);
    expect(second?.warming).toBe(false);
    expect(mockState.perfCalls).toBe(1);
  });
});

describe("getSeoPerformance — a failed warm backs off", () => {
  const writeRejects = () => {
    mockState.updateError = { ...MISSING_COLUMN_ERROR };
  };

  const measureRejects = () => {
    mockState.perf = async () => {
      throw new Error("PSI exploded");
    };
  };

  const reasonOf = (half: { state: string; reason?: string } | null | undefined) =>
    half?.state === "unavailable" ? (half.reason ?? "") : "";

  it("does not start a second sweep inside the window", async () => {
    writeRejects();
    await getSeoPerformance(TID);
    await settleWarm();
    expect(mockState.perfCalls).toBe(1);

    await getSeoPerformance(TID);
    await getSeoPerformance(TID);
    await settleWarm();
    expect(mockState.perfCalls).toBe(1);
  });

  it("stops claiming to be measuring, and says what happened instead", async () => {
    writeRejects();
    await getSeoPerformance(TID);
    await settleWarm();
    const p = await getSeoPerformance(TID);

    expect(p?.warming).toBe(false);
    expect(p?.field?.state).toBe("unavailable");
    expect(p?.lab?.state).toBe("unavailable");
    expect(reasonOf(p?.lab)).toContain("couldn't save");
  });

  it("tells a write failure apart from a measure failure", async () => {
    writeRejects();
    await getSeoPerformance(TID);
    await settleWarm();
    const persist = await getSeoPerformance(TID);

    const other = freshTenant();
    mockState.updateError = null;
    measureRejects();
    await getSeoPerformance(other);
    await settleWarm();
    const fetchFailed = await getSeoPerformance(other);

    expect(reasonOf(persist?.lab)).toContain("couldn't save");
    expect(reasonOf(fetchFailed?.lab)).toContain("couldn't measure");
    expect(reasonOf(persist?.lab)).not.toBe(reasonOf(fetchFailed?.lab));
  });

  it("still serves a stale-but-true payload underneath the failure", async () => {
    const old = new Date(Date.now() - SEO_PERFORMANCE_TTL_MS - 60_000).toISOString();
    mockState.row = storedRow({ performance_report: perfOk({ fetched_at: old }) });
    writeRejects();

    await getSeoPerformance(TID);
    await settleWarm();
    const p = await getSeoPerformance(TID);

    expect(p?.field?.state).toBe("ok");
    expect(p?.fetched_at).toBe(old);
    expect(p?.warming).toBe(false);
    expect(mockState.perfCalls).toBe(1);
  });

  it("lapses, so a database that comes back heals unattended", async () => {
    writeRejects();
    await getSeoPerformance(TID);
    await settleWarm();
    expect(mockState.perfCalls).toBe(1);

    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + SEO_PERFORMANCE_ERROR_TTL_MS + 60_000);
    try {
      mockState.updateError = null;
      await getSeoPerformance(TID);
      expect(mockState.perfCalls).toBe(2);
      await settleWarm();
    } finally {
      clock.mockRestore();
    }
  });

  it("leaves nothing behind once a write actually lands", async () => {
    writeRejects();
    await getSeoPerformance(TID);
    await settleWarm();

    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + SEO_PERFORMANCE_ERROR_TTL_MS + 60_000);
    try {
      mockState.updateError = null;
      await getSeoPerformance(TID);
      await settleWarm();
      expect(mockState.perfCalls).toBe(2);

      await getSeoPerformance(TID);
      await settleWarm();
      expect(mockState.perfCalls).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  it("never throws to the caller, on either render", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      writeRejects();
      await expect(getSeoPerformance(TID)).resolves.not.toBeNull();
      await settleWarm();
      await settleWarm();
      await expect(getSeoPerformance(TID)).resolves.not.toBeNull();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("getSeoPerformance — a database without the performance column", () => {
  it("still serves the crawl halves rather than reading as no snapshot at all", async () => {
    mockState.performanceColumnMissing = true;
    mockState.row = storedRow();
    await getSeoPerformance(TID);

    expect(mockState.runCalls).toBe(0);
    expect(mockState.selects.some((s) => s.includes("performance_report"))).toBe(true);
    expect(mockState.selects.some((s) => !s.includes("performance_report"))).toBe(true);
  });

  it("degrades to no performance half, then backs off on the write it cannot do", async () => {
    mockState.performanceColumnMissing = true;
    mockState.updateError = { ...MISSING_COLUMN_ERROR };
    mockState.row = storedRow();

    await getSeoPerformance(TID);
    await settleWarm();
    const p = await getSeoPerformance(TID);

    expect(mockState.perfCalls).toBe(1);
    expect(p?.warming).toBe(false);
    expect(p?.lab?.state).toBe("unavailable");
  });

  it("does NOT paper over a read failure that is not about that column", async () => {
    mockState.selectError = {
      code: "42P01",
      message: 'relation "seo_audit_snapshots" does not exist',
    };
    mockState.row = storedRow();
    await getSeoPerformance(TID);

    expect(mockState.selects).toHaveLength(1);
    expect(mockState.runCalls).toBe(1);
  });
});

describe("getSeoPerformance — the agent-readiness half", () => {
  it("is on the payload, and says whose read it is", async () => {
    mockState.row = storedRow({ performance_report: perfOk() });
    const p = await getSeoPerformance(TID);
    expect(p?.agent_readiness.checks.map((c) => c.id)).toEqual([
      "llms_txt",
      "ai_crawlers",
      "server_rendered",
      "layout_stable",
    ]);
    expect(p?.agent_readiness.disclosure).toMatch(/Zavi's own check, not Google's/i);
  });

  it("is still served when there is no Google key — three checks, not zero", async () => {
    delete process.env[GOOGLE_PAGESPEED_API_KEY_ENV];
    mockState.row = storedRow();
    const p = await getSeoPerformance(TID);
    expect(p?.field).toEqual({ state: "not_configured" });
    const r = p!.agent_readiness;
    expect(r.checks.find((c) => c.id === "server_rendered")?.state).toBe("pass");
    expect(r.checks.find((c) => c.id === "layout_stable")?.state).toBe("unknown");
    expect(r.passed).toBe(1);
    expect(r.applicable).toBe(2);
    await settleWarm();
  });

  it("reads CLS out of the stored field half, string or number", async () => {
    for (const [p75, want] of [
      [0.04, "pass"],
      ["0.33", "fail"],
    ] as const) {
      mockState.row = storedRow({
        performance_report: perfOk({
          field: {
            state: "ok",
            scope: "origin",
            key: "https://example.com",
            collection_period: { first_date: "2026-08-17", last_date: "2026-09-13" },
            metrics: { cumulative_layout_shift: { p75, histogram: [] } },
          },
        }),
      });
      const got = await getSeoPerformance(TID);
      expect(
        got?.agent_readiness.checks.find((c) => c.id === "layout_stable")?.state,
        String(p75),
      ).toBe(want);
    }
  });

  it("degrades to four unknowns when the crawl itself failed", async () => {
    mockState.row = storedRow({
      status: "error",
      error_code: "seo_site_unreachable",
      report: null,
      geo_report: null,
    });
    const p = await getSeoPerformance(TID);
    expect(p?.agent_readiness.applicable).toBe(0);
    expect(p?.agent_readiness.passed).toBe(0);
    expect(p?.agent_readiness.checks.every((c) => c.state === "unknown")).toBe(true);
  });
});

describe("getSeoPerformance — server_rendered's homepage rule reaches the payload", () => {
  const ssr = (p: Awaited<ReturnType<typeof getSeoPerformance>>) =>
    p!.agent_readiness.checks.find((c) => c.id === "server_rendered")!;

  it("fails when the crawled homepage is thin", async () => {
    mockState.row = storedRow({
      report: {
        pages_analyzed: 2,
        findings: [],
        pages: [
          { ...PAGE, visible_words: 8 },
          { ...PAGE, url: "https://example.com/about", visible_words: 900 },
        ],
      },
      performance_report: perfOk(),
    });
    const c = ssr(await getSeoPerformance(TID));
    expect(c.state).toBe("fail");
    expect(c.detail).toMatch(/^The homepage/);
  });

  it("passes a good homepage with one thin legal page, and still names it", async () => {
    mockState.row = storedRow({
      report: {
        pages_analyzed: 2,
        findings: [],
        pages: [PAGE, { ...PAGE, url: "https://example.com/terms", visible_words: 6 }],
      },
      performance_report: perfOk(),
    });
    const c = ssr(await getSeoPerformance(TID));
    expect(c.state).toBe("pass");
    expect(c.detail).toContain("https://example.com/terms");
  });
});
