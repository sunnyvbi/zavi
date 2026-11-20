import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { AuthedRequest } from "@/services/auth/middleware";
import { ExpectedToolError } from "@/services/tools/types";
import type { SiteAuditRunResult } from "@/services/tools/growth/seo/run";
import { createSiteSeoHandlers } from "@/routes/workspace/website-site-seo";
import type { BuildSessionApp } from "../session-site";
import type { SiteRow } from "../contract";
import {
  ERROR_TTL_MS,
  liveUrlOf,
  OK_TTL_MS,
  REFRESH_COOLDOWN_MS,
  resetSiteSeoInFlight,
  SITE_SEO_SCHEMA,
  siteSeo,
  type SiteSeoDeps,
  type SiteSeoRow,
} from "../site-seo";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const SITE = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  status: "live" as const,
  hostname: "golden-fork-1a2b3c4d.zaviagent.com",
  live_url: "https://golden-fork-1a2b3c4d.zaviagent.com/",
  live_deploy_id: "d1",
};
const URL_ = "https://golden-fork-1a2b3c4d.zaviagent.com";

function run(): SiteAuditRunResult {
  return {
    site: URL_,
    provenance: "public",
    notes: [],
    seo: { pages_analyzed: 2, findings: [{ code: "h1_missing", severity: "medium", summary: "x", urls: [URL_] }], pages: [] },
    geo: {
      pages_analyzed: 2,
      score: { total: 40, bands: [] },
      completeness: { pages_planned: 2, pages_returned: 2, robots_fetched: true, llms_txt: false } as never,
      disclosure: "d",
      crawlers: [],
      llms_txt: false,
      findings: [],
      pages: [],
      not_checked: [],
    },
  };
}

function world(row: SiteSeoRow | null = null, now = T0) {
  let stored = row;
  let clock = now;
  const crawl = vi.fn(async (_url: string, _paths: string[]) => run());
  const deps: SiteSeoDeps = {
    read: async () => stored,
    write: async (r) => {
      stored = r;
    },
    crawl,
    now: () => clock,
  };
  return { deps, crawl, stored: () => stored, tick: (ms: number) => (clock += ms) };
}

const stored = (over: Partial<SiteSeoRow> = {}): SiteSeoRow => ({
  site_id: SITE.id,
  tenant_id: SITE.tenant_id,
  url: URL_,
  deploy_id: "d1",
  status: "ok",
  error_code: null,
  report: run().seo,
  geo_report: run().geo,
  notes: [],
  schema_version: SITE_SEO_SCHEMA,
  fetched_at: new Date(T0 - 60 * 60 * 1000).toISOString(),
  ...over,
});

afterEach(() => resetSiteSeoInFlight());

describe("liveUrlOf", () => {
  it("is the live origin, or the hostname of a live site, and nothing before it is live", () => {
    expect(liveUrlOf(SITE)).toBe(URL_);
    expect(liveUrlOf({ ...SITE, live_url: null })).toBe(URL_);
    expect(liveUrlOf({ ...SITE, live_url: null, status: "building" })).toBeNull();
    expect(liveUrlOf({ ...SITE, live_url: "http://x.example" , status: "building"})).toBeNull();
  });
});

describe("siteSeo", () => {
  it("does nothing for a site that is not live", async () => {
    const w = world();
    expect(await siteSeo(w.deps, { ...SITE, live_url: null, status: "building" })).toEqual({ state: "not_live" });
    expect(w.crawl).not.toHaveBeenCalled();
  });

  it("crawls the site's own live address from its home page, stores it, and serves it while fresh", async () => {
    const w = world();
    const out = await siteSeo(w.deps, SITE);
    expect(w.crawl).toHaveBeenCalledWith(URL_, ["/"]);
    expect(out).toMatchObject({ state: "ready", url: URL_, current: true, seo: { pages_analyzed: 2 } });
    expect(w.stored()).toMatchObject({ site_id: SITE.id, tenant_id: SITE.tenant_id, deploy_id: "d1", status: "ok" });
    w.tick(OK_TTL_MS - 1000);
    await siteSeo(w.deps, SITE);
    expect(w.crawl).toHaveBeenCalledTimes(1);
    w.tick(2000);
    await siteSeo(w.deps, SITE);
    expect(w.crawl).toHaveBeenCalledTimes(2);
  });

  it("crawls again after a new publish", async () => {
    const w = world(stored());
    await siteSeo(w.deps, { ...SITE, live_deploy_id: "d2" });
    expect(w.crawl).toHaveBeenCalledTimes(1);
    expect(w.stored()?.deploy_id).toBe("d2");
  });

  it("stores an unreachable site as an error for a while instead of crawling on every open", async () => {
    const w = world();
    w.crawl.mockRejectedValueOnce(new ExpectedToolError("seo_site_unreachable", "nothing answered"));
    expect(await siteSeo(w.deps, SITE)).toMatchObject({ state: "error", error_code: "seo_site_unreachable", seo: null, notes: ["nothing answered"] });
    w.tick(ERROR_TTL_MS - 1000);
    await siteSeo(w.deps, SITE);
    expect(w.crawl).toHaveBeenCalledTimes(1);
  });

  it("refresh crawls now, but not twice within the cooldown, and says when it can", async () => {
    const w = world(stored());
    await siteSeo(w.deps, SITE, { refresh: true });
    expect(w.crawl).toHaveBeenCalledTimes(1);
    const again = await siteSeo(w.deps, SITE, { refresh: true });
    expect(w.crawl).toHaveBeenCalledTimes(1);
    expect(again.state === "ready" && again.refresh_after).toBe(new Date(T0 + REFRESH_COOLDOWN_MS).toISOString());
  });

  it("concurrent opens share one crawl", async () => {
    const w = world();
    await Promise.all([siteSeo(w.deps, SITE), siteSeo(w.deps, SITE)]);
    expect(w.crawl).toHaveBeenCalledTimes(1);
  });

  it("an unexpected failure is not cached", async () => {
    const w = world();
    w.crawl.mockRejectedValueOnce(new Error("boom"));
    await expect(siteSeo(w.deps, SITE)).rejects.toThrow("boom");
    expect(w.stored()).toBeNull();
  });
});

describe("GET /api/website/site-seo", () => {
  const auth = { user_id: "u1", tenant_id: SITE.tenant_id, access_token: "tok" } as AuthedRequest;

  function call(app: BuildSessionApp, query: Record<string, string>, member = false) {
    const w = world();
    const h = createSiteSeoHandlers({
      requireAuth: async () => auth,
      requireOwnerOrAdmin: async (_a, res) => {
        if (member) res.status(403).json({ error: { code: "forbidden" } });
        return !member;
      },
      resolveSession: async () => app,
      seo: w.deps,
    });
    const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    return { w, run: async (refresh = false) => { await (refresh ? h.refresh : h.get)({ query, body: {} } as unknown as Request, res as unknown as Response); return res; } };
  }

  it("needs a build session and a site", async () => {
    expect((await call({ kind: "none" }, {}).run()).statusCode).toBe(400);
    expect((await call({ kind: "old_flow", run_id: "r" }, { build_session_id: SITE.id }).run()).statusCode).toBe(409);
  });

  it("never reads another workspace's site", async () => {
    const c = call({ kind: "site", run_id: "r", site: { ...SITE, tenant_id: "33333333-3333-4333-8333-333333333333" } as unknown as SiteRow }, { build_session_id: SITE.id });
    expect((await c.run()).statusCode).toBe(404);
    expect(c.w.crawl).not.toHaveBeenCalled();
  });

  it("lets a member read but not force a crawl", async () => {
    const site = { kind: "site" as const, run_id: "r", site: SITE as unknown as SiteRow };
    expect((await call(site, { build_session_id: SITE.id }, true).run(false)).statusCode).toBe(200);
    const c = call(site, { build_session_id: SITE.id }, true);
    expect((await c.run(true)).statusCode).toBe(403);
  });

  it("answers the caller's site's crawl", async () => {
    const c = call({ kind: "site", run_id: "r", site: SITE as unknown as SiteRow }, { build_session_id: SITE.id });
    const res = await c.run(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ state: "ready", url: URL_ });
  });
});
