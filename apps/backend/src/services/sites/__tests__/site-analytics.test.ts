import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { AuthedRequest } from "@/services/auth/middleware";
import type { ShardHandle, SiteAuthDirectory, SubmissionStatRow } from "@/services/site-auth/types";
import { createShardStore } from "@/services/site-auth/store";
import { createSiteAnalyticsHandler } from "@/routes/workspace/website-site-analytics";
import type { BuildSessionApp } from "../session-site";
import type { SiteRow } from "../contract";
import {
  addDays,
  analyticsWindow,
  collectionLabel,
  parseRange,
  parseTimeZone,
  resetAnalyticsCache,
  shapeAnalytics,
  siteAnalytics,
  shapeTraffic,
  SUBMISSION_STATS_SCHEMA,
  type TrafficStats,
  zonedMidnight,
  type SiteAnalyticsDeps,
} from "../site-analytics";

const SITE = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const pooled = { id: SITE, tenant_id: TENANT, backend_mode: "pooled" as const, shard_id: "row-1", kernel_shard_id: null };

function directory(rows: SubmissionStatRow[] | (() => Promise<SubmissionStatRow[]>), opts: { site?: boolean; shard?: boolean } = {}) {
  const submissionStats = vi.fn(typeof rows === "function" ? rows : async () => rows);
  const dir: SiteAuthDirectory = {
    site: async () => (opts.site === false ? null : { siteId: SITE, shardId: "abcdefghijklmnopqrst", hostname: "x.zaviagent.com", name: "X", active: true }),
    shard: async () => (opts.shard === false ? null : ({ shardId: "abcdefghijklmnopqrst", store: { submissionStats } } as unknown as ShardHandle)),
  };
  return { dir, submissionStats };
}

function deps(
  dir: SiteAuthDirectory,
  now = new Date("2026-10-07T18:00:00Z"),
  traffic: TrafficStats = {},
): SiteAnalyticsDeps & { requestSchema: ReturnType<typeof vi.fn>; traffic: ReturnType<typeof vi.fn> } {
  return { directory: () => dir, traffic: vi.fn(async () => traffic) as unknown as SiteAnalyticsDeps["traffic"] & ReturnType<typeof vi.fn>, now: () => now, requestSchema: vi.fn() };
}

afterEach(() => resetAnalyticsCache());

describe("inputs", () => {
  it("allows 7, 30 or 90 days, defaulting to 30", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange(90)).toBe(90);
    expect(parseRange("365")).toBe(30);
    expect(parseRange(undefined)).toBe(30);
  });

  it("keeps a real IANA zone and falls back to UTC for anything else", () => {
    expect(parseTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(parseTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(parseTimeZone("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(parseTimeZone("CET")).toBe("CET");
    expect(parseTimeZone("EST5EDT")).toBe("EST5EDT");
    expect(parseTimeZone("Mars/Olympus")).toBe("UTC");
    expect(parseTimeZone("'; drop table x; --")).toBe("UTC");
    expect(parseTimeZone(undefined)).toBe("UTC");
  });

  it("labels collections for people", () => {
    expect(collectionLabel("contact_requests")).toBe("Contact requests");
    expect(collectionLabel("quoteRequests")).toBe("Quote requests");
    expect(collectionLabel("bookings")).toBe("Bookings");
  });
});

describe("the window is the founder's calendar days", () => {
  it("ends today in their zone and starts at their midnight", () => {
    const w = analyticsWindow(new Date("2026-10-08T01:30:00Z"), 7, "America/Los_Angeles");
    expect(w.to).toBe("2026-10-07");
    expect(w.from).toBe("2026-10-01");
    expect(w.since.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(w.prevSince.toISOString()).toBe("2026-09-24T07:00:00.000Z");
  });

  it("is right across a daylight-saving change", () => {
    expect(zonedMidnight("2026-11-01", "America/Los_Angeles").toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(zonedMidnight("2026-11-02", "America/Los_Angeles").toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(zonedMidnight("2026-10-07", "Asia/Kolkata").toISOString()).toBe("2026-10-06T18:30:00.000Z");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("starts a day at its first instant where the clocks jump at midnight", () => {
    expect(zonedMidnight("2026-09-06", "America/Santiago").toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(zonedMidnight("2026-04-05", "America/Santiago").toISOString()).toBe("2026-04-05T04:00:00.000Z");
  });
});

describe("shapeAnalytics", () => {
  const w = { from: "2026-10-01", to: "2026-10-07", tz: "UTC" };
  it("fills every day, totals per form, compares with the period before, and labels bookings", () => {
    const out = shapeAnalytics(
      [
        { collection: "enquiries", viaAction: false, day: "2026-10-02", n: 2, prevN: null, totalN: null, lastAt: null },
        { collection: "enquiries", viaAction: false, day: "2026-10-07", n: 1, prevN: null, totalN: null, lastAt: null },
        { collection: "enquiries", viaAction: false, day: null, n: null, prevN: 4, totalN: 20, lastAt: "2026-10-07T09:00:00.000Z" },
        { collection: "class_signups", viaAction: true, day: "2026-10-07", n: 5, prevN: null, totalN: null, lastAt: null },
        { collection: "class_signups", viaAction: true, day: null, n: null, prevN: 0, totalN: 5, lastAt: "2026-10-07T10:00:00.000Z" },
        { collection: "appointments", viaAction: false, day: null, n: null, prevN: 1, totalN: 1, lastAt: "2026-09-01T10:00:00.000Z" },
      ],
      w,
      7,
    );
    expect(out.state).toBe("ready");
    expect(out.daily.map((d) => d.count)).toEqual([0, 2, 0, 0, 0, 0, 6]);
    expect(out.total).toBe(8);
    expect(out.previous_total).toBe(5);
    expect(out.all_time).toBe(26);
    expect(out.forms.map((f) => [f.label, f.kind, f.count])).toEqual([
      ["Class signups", "booking", 5],
      ["Enquiries", "form", 3],
      ["Appointments", "booking", 0],
    ]);
  });
});

describe("traffic", () => {
  const w = { from: "2026-10-01", to: "2026-10-07" };
  it("fills every day, keeps pages and sources (null = direct) and works out conversion", () => {
    const t = shapeTraffic(
      {
        visits: 40,
        previous_visits: 25,
        pageviews: 95,
        daily: [{ day: "2026-10-02", visits: 10, pageviews: 30 }, { day: "2026-10-07", visits: 30, pageviews: 65 }],
        pages: [{ path: "/", pageviews: 60, visits: 38 }, { path: "/pricing", pageviews: 35, visits: 12 }],
        sources: [{ source: null, visits: 20 }, { source: "www.google.com", visits: 15 }, { source: "spring_promo", visits: 5 }],
      },
      w,
      4,
    );
    expect(t.daily.map((d) => d.visits)).toEqual([0, 10, 0, 0, 0, 0, 30]);
    expect(t.conversion).toBe(0.1);
    expect(t.sources[0]).toEqual({ source: null, visits: 20 });
    expect(t.pages[1]).toEqual({ path: "/pricing", pageviews: 35, visits: 12 });
  });

  it("has no conversion without visits, and never above 100%", () => {
    expect(shapeTraffic({}, w, 3).conversion).toBeNull();
    expect(shapeTraffic({ visits: 2 }, w, 9).conversion).toBe(1);
    expect(shapeTraffic({ visits: "x", daily: "nope" } as TrafficStats, w, 0)).toMatchObject({ visits: 0, daily: expect.any(Array) });
  });

  it("a static site (no forms) still gets its traffic, read for its own tenant and site", async () => {
    const { dir } = directory([]);
    const d = deps(dir, undefined, { visits: 7, pageviews: 9 });
    const out = await siteAnalytics(d, { ...pooled, backend_mode: "static", shard_id: null }, 7, "UTC");
    expect(out.state).toBe("no_database");
    expect(out.traffic).toMatchObject({ visits: 7, pageviews: 9, conversion: 0 });
    expect(d.traffic).toHaveBeenCalledWith(TENANT, SITE, expect.objectContaining({ tz: "UTC" }));
  });
});

describe("siteAnalytics", () => {
  it("answers no_database for a site that stores nothing, without touching a shard", async () => {
    const { dir, submissionStats } = directory([]);
    const out = await siteAnalytics(deps(dir), { ...pooled, backend_mode: "static", shard_id: null }, 7, "UTC");
    expect(out.state).toBe("no_database");
    expect(out.daily).toHaveLength(7);
    expect(submissionStats).not.toHaveBeenCalled();
  });

  it("reads a graduated site from its kernel shard", async () => {
    const { dir, submissionStats } = directory([]);
    const out = await siteAnalytics(deps(dir), { id: SITE, tenant_id: TENANT, backend_mode: "dedicated", shard_id: null, kernel_shard_id: "k-1" }, 30, "UTC");
    expect(out.state).toBe("ready");
    expect(submissionStats).toHaveBeenCalledWith(SITE, expect.objectContaining({ tz: "UTC" }));
  });

  it("caches for a minute and shares one read between concurrent callers", async () => {
    const { dir, submissionStats } = directory([]);
    const d = deps(dir);
    await Promise.all([siteAnalytics(d, pooled, 7, "UTC"), siteAnalytics(d, pooled, 7, "UTC")]);
    await siteAnalytics(d, pooled, 7, "UTC");
    expect(submissionStats).toHaveBeenCalledTimes(1);
    await siteAnalytics(d, pooled, 30, "UTC");
    expect(submissionStats).toHaveBeenCalledTimes(2);
  });

  it("asks for the shard schema and says so when the shard has not got 1040 yet", async () => {
    const missing = Object.assign(new Error("function zsite_auth.site_submission_stats(...) does not exist"), { code: "42883" });
    const { dir } = directory(async () => {
      throw missing;
    });
    const d = deps(dir);
    await expect(siteAnalytics(d, pooled, 7, "UTC")).rejects.toMatchObject({ code: "analytics_updating" });
    expect(d.requestSchema).toHaveBeenCalledWith("abcdefghijklmnopqrst", SUBMISSION_STATS_SCHEMA);
  });

  it("counts in UTC when the shard does not know the founder's zone", async () => {
    const calls: string[] = [];
    const { dir } = directory(async () => []);
    const shard = await dir.shard("x");
    (shard!.store.submissionStats as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_s: string, w: { tz: string }) => {
      calls.push(w.tz);
      if (w.tz !== "UTC") throw new Error("invalid_timezone");
      return [];
    });
    const d = deps({ ...dir, shard: async () => shard });
    expect((await siteAnalytics(d, pooled, 7, "Asia/Kolkata")).range.tz).toBe("UTC");
    expect(calls).toEqual(["Asia/Kolkata", "UTC"]);
  });

  it("is unavailable (retryable), never 'no forms', when a site with a database cannot be resolved or reached", async () => {
    await expect(siteAnalytics(deps(directory([], { shard: false }).dir), pooled, 7, "UTC")).rejects.toMatchObject({ code: "analytics_unavailable" });
    await expect(siteAnalytics(deps(directory([], { site: false }).dir), pooled, 7, "UTC")).rejects.toMatchObject({ code: "analytics_unavailable" });
  });
});

describe("the broker store maps the shard rows", () => {
  it("passes the window as instants and reads counts as numbers", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const store = createShardStore(async (sql, params) => {
      calls.push({ sql, params });
      return [
        { collection: "enquiries", via_action: false, day: "2026-10-02", n: "3", prev_n: null, total_n: null, last_at: null },
        { collection: "enquiries", via_action: false, day: null, n: null, prev_n: "1", total_n: "9", last_at: new Date("2026-10-02T10:00:00Z") },
      ];
    });
    const w = analyticsWindow(new Date("2026-10-07T18:00:00Z"), 7, "UTC");
    const rows = await store.submissionStats(SITE, w);
    expect(calls[0].sql).toContain("zsite_auth.site_submission_stats($1, $2, $3, $4, $5)");
    expect(calls[0].params).toEqual([SITE, "2026-10-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z", "2026-09-24T00:00:00.000Z", "UTC"]);
    expect(rows).toEqual([
      { collection: "enquiries", viaAction: false, day: "2026-10-02", n: 3, prevN: null, totalN: null, lastAt: null },
      { collection: "enquiries", viaAction: false, day: null, n: null, prevN: 1, totalN: 9, lastAt: "2026-10-02T10:00:00.000Z" },
    ]);
  });
});

describe("GET /api/website/site-analytics", () => {
  const auth = { user_id: "u1", tenant_id: "t1", access_token: "tok" } as AuthedRequest;
  const site = { id: SITE, tenant_id: "t1", backend_mode: "pooled", shard_id: "row-1", kernel_shard_id: null } as unknown as SiteRow;

  function call(app: BuildSessionApp | Error, query: Record<string, string>, rows: SubmissionStatRow[] = []) {
    const { dir } = directory(rows);
    const resolveSession = vi.fn(async () => {
      if (app instanceof Error) throw app;
      return app;
    });
    const handler = createSiteAnalyticsHandler({ requireAuth: async () => auth, resolveSession, analytics: deps(dir) });
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    const req = { query } as unknown as Request;
    return { run: () => handler(req, res as unknown as Response).then(() => res), resolveSession };
  }

  it("needs the build session", async () => {
    const res = await call({ kind: "site", run_id: "r", site }, {}).run();
    expect(res.statusCode).toBe(400);
  });

  it("refuses a build that is not a site", async () => {
    const res = await call({ kind: "old_flow", run_id: "r" }, { build_session_id: SITE }).run();
    expect(res.statusCode).toBe(409);
  });

  it("answers the caller's own site's counts for the asked range and zone", async () => {
    const c = call({ kind: "site", run_id: "r", site }, { build_session_id: SITE, days: "7", tz: "Europe/London" }, [
      { collection: "enquiries", viaAction: false, day: "2026-10-07", n: 2, prevN: null, totalN: null, lastAt: null },
    ]);
    const res = await c.run();
    expect(res.statusCode).toBe(200);
    expect(c.resolveSession).toHaveBeenCalledWith(auth, SITE);
    expect(res.body).toMatchObject({ state: "ready", total: 2, range: { days: 7, tz: "Europe/London" } });
  });
});
