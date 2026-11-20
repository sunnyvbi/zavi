import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  auth: { tenant_id: "t-1", user_id: "u-1" } as { tenant_id: string; user_id: string } | null,
  audit: null as unknown,
  note: null as unknown,
  getSiteAudit: vi.fn(),
  fanOutFirstRun: vi.fn(),
  siteOnFile: "https://acme.com" as string | null,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!mocks.auth) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return mocks.auth;
  }),
}));
vi.mock("@/services/tools/growth/seo/snapshot", () => ({
  getSiteAudit: mocks.getSiteAudit,
}));
vi.mock("@/services/tools/growth/seo/run", () => ({
  resolveTenantSite: vi.fn(async () => mocks.siteOnFile),
}));
vi.mock("@/services/growth/strategy-note", () => ({
  readStrategyNote: vi.fn(async () => mocks.note),
}));
vi.mock("@/services/growth/auto-first-run", () => ({
  fanOutFirstRun: mocks.fanOutFirstRun,
}));
vi.mock("@/routes/workspace/growth-strategy", () => ({
  projectStrategy: (raw: unknown) => raw,
}));

import { siteRescan, resetSiteRescanCooldowns } from "../site-rescan";

function call(body: unknown = {}) {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  } as unknown as Response;
  return siteRescan({ body } as Request, res).then(() => out);
}

const OK_AUDIT = { status: "ok", site: "https://acme.com", error_code: null, seo: { pages_analyzed: 3 } };
const BETS = [{ channel_slug: "seo" }];

beforeEach(() => {
  resetSiteRescanCooldowns();
  mocks.auth = { tenant_id: "t-1", user_id: "u-1" };
  mocks.siteOnFile = "https://acme.com";
  mocks.audit = OK_AUDIT;
  mocks.note = { id: "n", metadata: { accepted: true, strategy: { channel_bets: BETS } } };
  mocks.getSiteAudit.mockReset().mockImplementation(async () => mocks.audit);
  mocks.fanOutFirstRun.mockReset().mockResolvedValue({ ran: true, channel_slug: "seo" });
});

describe("POST /api/channels/site-rescan", () => {
  it("requires auth and does no work without it", async () => {
    mocks.auth = null;
    const out = await call();
    expect(out.status).toBe(401);
    expect(mocks.getSiteAudit).not.toHaveBeenCalled();
    expect(mocks.fanOutFirstRun).not.toHaveBeenCalled();
  });

  it("crawls fresh and starts the first run for the AUTHED tenant, ignoring a tenant in the body", async () => {
    const out = await call({ tenant_id: "victim" });
    expect(out.status).toBe(200);
    expect(mocks.getSiteAudit).toHaveBeenCalledWith("t-1", { maxAgeMs: 0 });
    expect(mocks.fanOutFirstRun).toHaveBeenCalledWith("t-1", BETS);
    expect(JSON.stringify(mocks.getSiteAudit.mock.calls)).not.toContain("victim");
    expect(out.body).toEqual({
      site_read: { state: "ok", site: "https://acme.com", error_code: null },
      first_run: { ran: true, channel_slug: "seo" },
    });
  });

  it("does not fan out when the site still cannot be read", async () => {
    mocks.audit = { status: "error", site: "https://acme.com", error_code: "seo_site_unreachable", seo: null };
    const out = await call();
    expect(mocks.fanOutFirstRun).not.toHaveBeenCalled();
    expect(out.body).toEqual({
      site_read: { state: "error", site: "https://acme.com", error_code: "seo_site_unreachable" },
      first_run: { ran: false, reason: "site_not_read" },
    });
  });

  it("does not fan out on a read that found no pages", async () => {
    mocks.audit = { ...OK_AUDIT, seo: { pages_analyzed: 0 } };
    const out = await call();
    expect(mocks.fanOutFirstRun).not.toHaveBeenCalled();
    expect((out.body as { site_read: { state: string } }).site_read.state).toBe("error");
  });

  it("just reports the read when there is no accepted plan yet", async () => {
    mocks.note = { id: "n", metadata: { accepted: false, strategy: { channel_bets: BETS } } };
    const out = await call();
    expect(mocks.fanOutFirstRun).not.toHaveBeenCalled();
    expect(out.body).toMatchObject({ site_read: { state: "ok" }, first_run: { ran: false, reason: "no_strategy" } });
  });

  it("allows one rescan a minute per tenant, and one tenant's press does not block another", async () => {
    expect((await call()).status).toBe(200);
    const second = await call();
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ error: { code: "rescan_cooldown" } });
    expect(mocks.getSiteAudit).toHaveBeenCalledTimes(1);

    mocks.auth = { tenant_id: "t-2", user_id: "u-2" };
    expect((await call()).status).toBe(200);
    expect(mocks.getSiteAudit).toHaveBeenLastCalledWith("t-2", { maxAgeMs: 0 });
  });

  it("checks a newly saved URL straight away, even right after a check of the old one", async () => {
    mocks.audit = { status: "error", site: "https://acme.com", error_code: "seo_site_unreachable", seo: null };
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);

    mocks.siteOnFile = "https://acme.io";
    mocks.audit = { ...OK_AUDIT, site: "https://acme.io" };
    const out = await call();
    expect(out.status).toBe(200);
    expect(mocks.getSiteAudit).toHaveBeenCalledTimes(2);
    expect(mocks.fanOutFirstRun).toHaveBeenCalledWith("t-1", BETS);
  });

  it("caps crawls per tenant however often the URL changes", async () => {
    for (let i = 0; i < 5; i++) {
      mocks.siteOnFile = `https://acme${i}.com`;
      expect((await call()).status).toBe(200);
    }
    mocks.siteOnFile = "https://acme-new.com";
    const capped = await call();
    expect(capped.status).toBe(429);
    expect(capped.body).toMatchObject({ error: { code: "rescan_cooldown" } });
    expect(mocks.getSiteAudit).toHaveBeenCalledTimes(5);

    mocks.auth = { tenant_id: "t-2", user_id: "u-2" };
    expect((await call()).status).toBe(200);
  });

  it("treats the same host as the same site (www, case)", async () => {
    mocks.siteOnFile = "https://acme.com";
    expect((await call()).status).toBe(200);
    mocks.siteOnFile = "https://WWW.Acme.com/";
    expect((await call()).status).toBe(429);
  });

  it("lets the cap lapse after the window", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        mocks.siteOnFile = `https://acme${i}.com`;
        await call();
      }
      expect((await call()).status).toBe(429);
      vi.advanceTimersByTime(10 * 60_000);
      expect((await call()).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
