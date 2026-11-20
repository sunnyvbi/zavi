import { describe, it, expect, vi, beforeEach } from "vitest";

import { ExpectedToolError } from "@/services/tools/types";

type Row = Record<string, unknown> | null;

const mockState = vi.hoisted(() => ({
  row: null as Row,
  readError: null as { message: string } | null,
  facadeThrows: false,
  upsertThrows: false,
  upserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  runCalls: 0,
  run: null as null | (() => Promise<unknown>),
  siteOnFile: "https://example.com" as string | null,
  resolveThrows: false,
}));

function makeBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) {
    b[m] = vi.fn(() => b);
  }
  b.maybeSingle = vi.fn(async () => ({ data: mockState.row, error: mockState.readError }));
  b.update = vi.fn((payload: Record<string, unknown>) => {
    mockState.updates.push(payload);
    if (mockState.row) mockState.row = { ...mockState.row, ...payload };
    const done = { data: null, error: null };
    const chain: Record<string, unknown> = {
      eq: vi.fn(() => chain),
      then: (resolve: (v: typeof done) => unknown) => Promise.resolve(done).then(resolve),
    };
    return chain;
  });
  b.upsert = vi.fn(async (payload: Record<string, unknown>) => {
    if (mockState.upsertThrows) throw new Error("upsert exploded");
    mockState.upserts.push(payload);
    return { data: null, error: null };
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
  resolveTenantSite: vi.fn(async () => {
    if (mockState.resolveThrows) throw new Error("tenants read exploded");
    return mockState.siteOnFile;
  }),
}));

import {
  expireSeoAuditForSite,
  getSeoSiteHealth,
  readSiteReadState,
  SEO_AUDIT_ERROR_TTL_MS,
  SEO_AUDIT_SCHEMA,
  SEO_AUDIT_TTL_MS,
} from "../snapshot";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

const FINDING = {
  code: "noindex",
  severity: "blocker" as const,
  summary: "Every page checked asks search engines not to index it.",
  urls: ["https://example.com/"],
};

const PAGE = {
  url: "https://example.com/",
  status: 200,
  title: "Example",
  title_length: 7,
  meta_description: null,
  canonical: null,
  h1_count: 1,
  schema_types: [],
  noindex: true,
  visible_words: 400,
};

function storedRow(over: Record<string, unknown> = {}): Row {
  return {
    site: "https://example.com",
    status: "ok",
    error_code: null,
    report: { pages_analyzed: 1, findings: [FINDING], pages: [PAGE] },
    geo_report: GEO_REPORT,
    notes: [],
    schema_version: SEO_AUDIT_SCHEMA,
    fetched_at: new Date().toISOString(),
    ...over,
  };
}

const GEO_REPORT = {
  pages_analyzed: 2,
  score: { total: 55, bands: [] },
  crawlers: [],
  llms_txt: false,
  findings: [],
  pages: [],
  not_checked: ["Whether you are actually cited in AI Overviews."],
};

function freshRun() {
  return {
    site: "https://example.com",
    provenance: "public" as const,
    notes: ["partial"],
    seo: { pages_analyzed: 2, findings: [FINDING], pages: [PAGE] },
    geo: GEO_REPORT,
  };
}

beforeEach(() => {
  mockState.row = null;
  mockState.readError = null;
  mockState.facadeThrows = false;
  mockState.upsertThrows = false;
  mockState.upserts = [];
  mockState.runCalls = 0;
  mockState.run = async () => freshRun();
  mockState.siteOnFile = "https://example.com";
  mockState.resolveThrows = false;
});

describe("getSeoSiteHealth — serving the cache", () => {
  it("serves a fresh stored audit without crawling", async () => {
    mockState.row = storedRow();
    const health = await getSeoSiteHealth(TID);

    expect(mockState.runCalls).toBe(0);
    expect(health?.status).toBe("ok");
    expect(health?.stale).toBe(false);
    expect(health?.findings).toHaveLength(1);
    expect(health?.pages_analyzed).toBe(1);
  });

  it("re-crawls when there is nothing stored, and stores the result", async () => {
    const health = await getSeoSiteHealth(TID);

    expect(mockState.runCalls).toBe(1);
    expect(health?.pages_analyzed).toBe(2);
    expect(mockState.upserts).toHaveLength(1);
    expect(mockState.upserts[0]).toMatchObject({
      tenant_id: TID,
      status: "ok",
      site: "https://example.com",
      schema_version: SEO_AUDIT_SCHEMA,
    });
  });

  it("re-crawls a stored audit that has aged past the TTL", async () => {
    mockState.row = storedRow({
      fetched_at: new Date(Date.now() - SEO_AUDIT_TTL_MS - 60_000).toISOString(),
    });
    const health = await getSeoSiteHealth(TID);

    expect(mockState.runCalls).toBe(1);
    expect(health?.pages_analyzed).toBe(2);
  });

  it("treats a row written under an older payload shape as a miss", async () => {
    mockState.row = storedRow({ schema_version: SEO_AUDIT_SCHEMA - 1 });
    await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(1);
  });

  it("honours a caller-supplied maxAgeMs", async () => {
    mockState.row = storedRow({
      fetched_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    await getSeoSiteHealth(TID, { maxAgeMs: 60_000 });
    expect(mockState.runCalls).toBe(1);
  });
});

describe("getSeoSiteHealth — failure handling", () => {
  it("PERSISTS a classified failure so a dead site is not re-crawled every render", async () => {
    mockState.run = async () => {
      throw new ExpectedToolError("seo_site_unreachable", "nothing answered");
    };
    const health = await getSeoSiteHealth(TID);

    expect(health?.status).toBe("error");
    expect(health?.error_code).toBe("seo_site_unreachable");
    expect(health?.findings).toEqual([]);
    expect(mockState.upserts).toHaveLength(1);
    expect(mockState.upserts[0]).toMatchObject({
      status: "error",
      error_code: "seo_site_unreachable",
      report: null,
    });
  });

  it("distinguishes no-URL-on-file from an unreachable site", async () => {
    mockState.run = async () => {
      throw new ExpectedToolError("seo_site_unknown", "no url");
    };
    const health = await getSeoSiteHealth(TID);
    expect(health?.error_code).toBe("seo_site_unknown");
  });

  it("serves the last good audit flagged stale when an unclassified error hits", async () => {
    mockState.row = storedRow({
      fetched_at: new Date(Date.now() - SEO_AUDIT_TTL_MS - 60_000).toISOString(),
    });
    mockState.run = async () => {
      throw new Error("socket hang up");
    };
    const health = await getSeoSiteHealth(TID);

    expect(health?.status).toBe("ok");
    expect(health?.stale).toBe(true);
    expect(health?.findings).toHaveLength(1);
    expect(mockState.upserts).toHaveLength(0);
  });

  it("returns null only when there is no cache and the crawl failed unclassified", async () => {
    mockState.run = async () => {
      throw new Error("socket hang up");
    };
    expect(await getSeoSiteHealth(TID)).toBeNull();
  });

  it("never throws when the facade itself is broken", async () => {
    mockState.facadeThrows = true;
    const health = await getSeoSiteHealth(TID);
    expect(health?.status).toBe("ok");
    expect(health?.pages_analyzed).toBe(2);
  });

  it("still returns the fresh audit when the cache write fails", async () => {
    mockState.upsertThrows = true;
    const health = await getSeoSiteHealth(TID);
    expect(health?.status).toBe("ok");
    expect(health?.pages_analyzed).toBe(2);
  });

  it("treats a read error as a miss rather than an empty audit", async () => {
    mockState.readError = { message: "permission denied" };
    const health = await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(1);
    expect(health?.pages_analyzed).toBe(2);
  });
});

describe("getSeoSiteHealth — provenance", () => {
  it("carries no measured-performance field", async () => {
    mockState.row = storedRow();
    const health = await getSeoSiteHealth(TID);
    const keys = Object.keys(health ?? {});
    for (const banned of ["clicks", "impressions", "ctr", "position", "sessions"]) {
      expect(keys).not.toContain(banned);
    }
  });
});

describe("getSeoSiteHealth — a cached failure must not outlive its cause", () => {
  const failing = (code: string) => async () => {
    throw new ExpectedToolError(code, "nope");
  };

  function errorRow(over: Record<string, unknown> = {}): Row {
    return storedRow({
      status: "error",
      error_code: "seo_site_unreachable",
      report: null,
      geo_report: null,
      ...over,
    });
  }

  it("re-crawls an error row past the SHORT error TTL, while a success of the same age is served", async () => {
    const age = new Date(Date.now() - SEO_AUDIT_ERROR_TTL_MS - 60_000).toISOString();

    mockState.row = errorRow({ fetched_at: age });
    await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(1);

    mockState.runCalls = 0;
    mockState.row = storedRow({ fetched_at: age });
    await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(0);
  });

  it("serves a RECENT error row rather than re-crawling a site that is genuinely down", async () => {
    mockState.row = errorRow({
      fetched_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const health = await getSeoSiteHealth(TID);

    expect(mockState.runCalls).toBe(0);
    expect(health?.error_code).toBe("seo_site_unreachable");
  });

  it("re-crawls immediately once a URL is added to a tenant that had none", async () => {
    mockState.row = errorRow({
      site: null,
      error_code: "seo_site_unknown",
      fetched_at: new Date().toISOString(),
    });
    mockState.siteOnFile = "https://justadded.example.com";

    const health = await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(1);
    expect(health?.status).toBe("ok");
  });

  it("does NOT re-crawl when the tenant still has no URL on file", async () => {
    mockState.row = errorRow({
      site: null,
      error_code: "seo_site_unknown",
      fetched_at: new Date().toISOString(),
    });
    mockState.siteOnFile = null;

    await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(0);
  });

  it("re-crawls when the URL on file was CHANGED after a failure", async () => {
    mockState.row = errorRow({
      site: "https://old.example.com",
      fetched_at: new Date().toISOString(),
    });
    mockState.siteOnFile = "https://new.example.com";

    await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(1);
  });

  it("keeps serving the stored failure when the URL lookup itself fails", async () => {
    mockState.row = errorRow({ fetched_at: new Date().toISOString() });
    mockState.resolveThrows = true;

    await getSeoSiteHealth(TID);
    expect(mockState.runCalls).toBe(0);
  });

  it("stores the URL it actually tried, so the panel can name it", async () => {
    mockState.row = null;
    mockState.siteOnFile = "https://www.zaviagent.com";
    mockState.run = failing("seo_site_unreachable");

    const health = await getSeoSiteHealth(TID);
    expect(health?.site).toBe("https://www.zaviagent.com");
    expect(mockState.upserts[0]).toMatchObject({
      status: "error",
      site: "https://www.zaviagent.com",
    });
  });

  it("maxAgeMs 0 forces a re-crawl past a fresh error row — this is what Retry does", async () => {
    mockState.row = errorRow({ fetched_at: new Date().toISOString() });
    await getSeoSiteHealth(TID, { maxAgeMs: 0 });
    expect(mockState.runCalls).toBe(1);
  });

  it("maxAgeMs 0 forces a re-crawl past a fresh SUCCESS row too", async () => {
    mockState.row = storedRow();
    await getSeoSiteHealth(TID, { maxAgeMs: 0 });
    expect(mockState.runCalls).toBe(1);
  });
});

describe("readSiteReadState — the channels page read never crawls", () => {
  it("reports a stored readable site as ok", async () => {
    mockState.row = storedRow();
    expect(await readSiteReadState(TID)).toEqual({ state: "ok", site: "https://example.com", error_code: null });
    expect(mockState.runCalls).toBe(0);
  });

  it("reports a stored failure as error, even when it is old enough that getSiteAudit would re-crawl", async () => {
    mockState.row = storedRow({
      status: "error",
      error_code: "seo_site_unreachable",
      report: null,
      fetched_at: new Date(Date.now() - SEO_AUDIT_ERROR_TTL_MS * 4).toISOString(),
    });
    expect(await readSiteReadState(TID)).toEqual({
      state: "error",
      site: "https://example.com",
      error_code: "seo_site_unreachable",
    });
    expect(mockState.runCalls).toBe(0);
    expect(mockState.upserts).toHaveLength(0);
  });

  it("is unknown when nothing is stored, and does not crawl to find out", async () => {
    expect(await readSiteReadState(TID)).toEqual({ state: "unknown", site: null, error_code: null });
    expect(mockState.runCalls).toBe(0);
  });

  it("names the new URL as not yet checked when the stored failure is about an old one", async () => {
    mockState.row = storedRow({ status: "error", error_code: "seo_site_unreachable", report: null });
    mockState.siteOnFile = "https://new-site.com";
    expect(await readSiteReadState(TID)).toEqual({
      state: "error",
      site: "https://new-site.com",
      error_code: "seo_site_unchecked",
    });
    expect(mockState.runCalls).toBe(0);
  });

  it("says no site is on file when the founder cleared it after a failure", async () => {
    mockState.row = storedRow({ status: "error", error_code: "seo_site_unreachable", report: null });
    mockState.siteOnFile = null;
    expect(await readSiteReadState(TID)).toEqual({ state: "error", site: null, error_code: "seo_site_unknown" });
    expect(mockState.runCalls).toBe(0);
  });

  it("never throws", async () => {
    mockState.facadeThrows = true;
    expect((await readSiteReadState(TID)).state).toBe("unknown");
  });
});
