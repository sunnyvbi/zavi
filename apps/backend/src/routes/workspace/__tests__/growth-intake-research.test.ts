
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/growth/plan-dossier", async (orig) => ({
  ...(await orig<object>()),
  buildPlanDossier: vi.fn(async () => null),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({
    user_id: "user-1",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    access_token: "tok",
  })),
}));

let tableRows: Record<string, Record<string, unknown> | null> = {};
let updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
let claimResult: boolean | Error = true;
let updateError: { message: string } | null = null;
const tenantRpcSpy = vi.fn();

vi.mock("@/services/tenant-client", () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.update = (patch: Record<string, unknown>) => {
      updates.push({ table, patch });
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: updateError });
      return q;
    };
    q.maybeSingle = async () => ({ data: tableRows[table] ?? null, error: null });
    return q;
  };
  return {
    asTenantId: (s: string) => s,
    tenantClient: () => ({ from: (table: string) => chain(table) }),
    tenantRpc: (...args: unknown[]) => {
      tenantRpcSpy(...args);
      if (claimResult instanceof Error) throw claimResult;
      return Promise.resolve({ data: claimResult, error: null });
    },
  };
});

let settingValue: unknown = undefined;
vi.mock("@/services/settings", () => ({
  getAppSetting: vi.fn(async () => settingValue),
}));

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => undefined),
}));

vi.mock("@/services/onboarding/enrichment/web-research", () => ({
  researchCompany: vi.fn(async () => []),
  RESEARCH_QUERY_COUNT: 4,
}));
vi.mock("@/services/onboarding/enrichment/competitors", () => ({
  findCompetitors: vi.fn(async () => []),
}));
vi.mock("@/services/tools/growth/seo/snapshot", () => ({
  getSeoSiteHealth: vi.fn(async () => null),
}));

let marketplaceConfig: unknown = null;
vi.mock("@/services/marketplace-intel/self-serve", () => ({
  resolveMarketplaceConfig: vi.fn(async () => marketplaceConfig),
}));
vi.mock("@/services/tools/growth/marketplace_intelligence", () => ({
  getMarketplaceIntel: vi.fn(async () => ({ configured: true, states: [] })),
  marketplaceIntelligenceTool: { name: "marketplace_intelligence" },
}));
vi.mock("@/services/tools/growth/liquidity_gap", () => ({
  getLiquidityGap: vi.fn(async () => ({ available: false, reason: "no_rollup_data" })),
}));

import {
  getGrowthIntakeLearned,
  postGrowthIntakeResearch,
  isMarketplaceShaped,
  domainFromProductUrl,
} from "../growth-intake-research";
import { researchCompany } from "@/services/onboarding/enrichment/web-research";
import { getMarketplaceIntel } from "@/services/tools/growth/marketplace_intelligence";
import { getSeoSiteHealth } from "@/services/tools/growth/seo/snapshot";
import { findCompetitors } from "@/services/onboarding/enrichment/competitors";
import { buildPlanDossier } from "@/services/growth/plan-dossier";

const mockResearch = researchCompany as unknown as ReturnType<typeof vi.fn>;
const mockIntel = getMarketplaceIntel as unknown as ReturnType<typeof vi.fn>;

function mockRes(): { res: Response; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn();
  status.mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, json };
}

const req = {} as unknown as Request;

function page(url: string) {
  return { url, title: "t", text_excerpt: "x".repeat(200) };
}

beforeEach(() => {
  tableRows = {
    tenants: { display_name: "Acme", product_url: { marketing: "https://acme.com" } },
  };
  updates = [];
  claimResult = true;
  updateError = null;
  settingValue = undefined;
  marketplaceConfig = null;
  tenantRpcSpy.mockClear();
  mockResearch.mockClear();
  mockIntel.mockClear();
  mockResearch.mockResolvedValue([]);
});

describe("the day claim", () => {
  it("returns the existing row and does NOT research when the claim is lost", async () => {
    claimResult = false;
    tableRows.growth_intake_research = {
      status: "ready",
      reason: null,
      payload: { domain: "acme.com", research_pages: [page("https://a.com/1"), page("https://b.com/2")], competitors: [], site: null, marketplace: null },
      fetched_at: "2026-09-10T00:00:00Z",
    };
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "ready", sources: 2 });
    expect(mockResearch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("reports pending when the claim is lost and the winner's row is not readable yet", async () => {
    claimResult = false;
    tableRows.growth_intake_research = null;
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "pending" });
    expect(mockResearch).not.toHaveBeenCalled();
  });

  it("does not research when the claim RPC itself fails — no claim, no spend", async () => {
    claimResult = new Error("rpc down");
    tableRows.growth_intake_research = null;
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "skipped", reason: "claim_unavailable" });
    expect(mockResearch).not.toHaveBeenCalled();
  });

  it("passes the day but never a tenant id from the request", async () => {
    claimResult = false;
    const { res } = mockRes();
    await postGrowthIntakeResearch(req, res);
    const calls = tenantRpcSpy.mock.calls as Array<[unknown, string, Record<string, unknown>]>;
    const claim = calls.find(([, n]) => n === "claim_growth_intake_research");
    expect(claim).toBeDefined();
    expect(Object.keys(claim![2])).toEqual(["p_day"]);
  });
});

describe("what a won claim stores", () => {
  it("starts dependent research before a slow site audit finishes, but awaits every result before storing", async () => {
    let releaseSite!: (value: null) => void;
    const slowSite = new Promise<null>(resolve => { releaseSite = resolve; });
    vi.mocked(getSeoSiteHealth).mockReturnValueOnce(slowSite);
    vi.mocked(findCompetitors).mockClear();
    vi.mocked(buildPlanDossier).mockClear();
    const sources = [page("https://trustpilot.com/acme"), page("https://reddit.com/r/x")];
    mockResearch.mockResolvedValue(sources);
    const { res, json } = mockRes();
    const pending = postGrowthIntakeResearch(req, res);
    try {
      await vi.waitFor(() => expect(buildPlanDossier).toHaveBeenCalled());
      expect(findCompetitors).toHaveBeenCalledWith("Acme", "acme.com", expect.stringContaining("t\n"));
      expect(vi.mocked(buildPlanDossier).mock.calls[0][0].researchPages).toEqual(sources);
      expect(json).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    } finally {
      releaseSite(null);
      await pending;
    }
    expect(json).toHaveBeenCalledWith({ status: "ready", sources: 2 });
  });

  it("stores ready with a cost estimate once there are two domain-matched sources", async () => {
    mockResearch.mockResolvedValue([page("https://trustpilot.com/acme"), page("https://reddit.com/r/x")]);
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "ready", sources: 2 });
    const written = updates.find((u) => u.table === "growth_intake_research");
    expect(written?.patch.status).toBe("ready");
    expect(typeof written?.patch.est_cost_usd).toBe("number");
    expect(written?.patch.est_cost_usd as number).toBeGreaterThan(0);
  });

  it("stores thin — not ready — on a single source", async () => {
    mockResearch.mockResolvedValue([page("https://trustpilot.com/acme")]);
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "thin", sources: 1 });
    expect(updates.find((u) => u.table === "growth_intake_research")?.patch.status).toBe("thin");
  });

});

describe("the domain comes from the URL on file", () => {
  it("uses the registered site, and never the company name", async () => {
    tableRows.tenants = {
      display_name: "Reena Day Care · Family child care in San Jose, CA",
      product_url: { marketing: "https://www.reenadaycare.com/" },
    };
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(mockResearch).toHaveBeenCalledWith(
      "Reena Day Care · Family child care in San Jose, CA",
      "reenadaycare.com",
    );
  });

  it("takes another key when there is no marketing URL", async () => {
    tableRows.tenants = { display_name: "Acme", product_url: { api: "https://api.acme.dev" } };
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(mockResearch).toHaveBeenCalledWith("Acme", "acme.dev");
  });

  it("stores no_domain_on_file — and researches nothing — when no URL is on file", async () => {
    tableRows.tenants = { display_name: "Acme", product_url: null };
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "failed", reason: "no_domain_on_file" });
    const written = updates.find((u) => u.table === "growth_intake_research");
    expect(written?.patch.status).toBe("failed");
    expect(written?.patch.reason).toBe("no_domain_on_file");
    expect(mockResearch).not.toHaveBeenCalled();
  });

  it("treats an empty product_url object as no URL on file", async () => {
    tableRows.tenants = { display_name: "Acme", product_url: {} };
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "failed", reason: "no_domain_on_file" });
  });

  it("reads a jsonb column of uncertain shape without throwing", () => {
    expect(domainFromProductUrl(null)).toBeNull();
    expect(domainFromProductUrl("https://acme.com")).toBeNull();
    expect(domainFromProductUrl({ marketing: 42 })).toBeNull();
    expect(domainFromProductUrl({ marketing: "not a url" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://acme" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://localhost" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://8.8.8.8" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://[2001:db8::1]" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://acme.123" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://www.reenadaycare.com/about" })).toBe(
      "reenadaycare.com",
    );
    expect(domainFromProductUrl({ marketing: "https://acme.co.uk" })).toBe("acme.co.uk");
    expect(domainFromProductUrl({ marketing: "https://münchen.de" })).toBe("xn--mnchen-3ya.de");
    expect(domainFromProductUrl({ marketing: "https://пример.рф" })).toBe("xn--e1afmkfd.xn--p1ai");
    expect(domainFromProductUrl({ marketing: "https://acme.com." })).toBe("acme.com");
    expect(domainFromProductUrl({ marketing: "https://acme.invalid" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://acme.localhost" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://acme.test" })).toBeNull();
    expect(domainFromProductUrl({ marketing: "https://acme.example" })).toBeNull();
    expect(
      domainFromProductUrl({ marketing: "https://build-a-simple-landing-a613c47c.onrender.com" }),
    ).toBe("build-a-simple-landing-a613c47c.onrender.com");
    expect(domainFromProductUrl({ marketing: "https://brand.github.io" })).toBe("brand.github.io");
    expect(domainFromProductUrl({ marketing: "https://acme.vercel.app" })).toBe("acme.vercel.app");
    expect(domainFromProductUrl({ marketing: "https://onrender.com" })).toBe("onrender.com");
    expect(
      domainFromProductUrl({ api: "https://api.acme.dev", marketing: "https://acme.co.uk" }),
    ).toBe("acme.co.uk");
  });
});

describe("the marketplace gate", () => {
  it("is the tenant's Supply & Demand setup, not the company_shape column", async () => {
    marketplaceConfig = null;
    expect(await isMarketplaceShaped("any-tenant")).toBe(false);
    marketplaceConfig = { tenant_id: "t" };
    expect(await isMarketplaceShaped("any-tenant")).toBe(true);
  });

  it("skips the tenant-scoped marketplace reads when no config exists", async () => {
    marketplaceConfig = null;
    mockResearch.mockResolvedValue([page("https://a.com/1"), page("https://b.com/2")]);
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(mockIntel).not.toHaveBeenCalled();
  });

  it("runs them when a setup exists", async () => {
    marketplaceConfig = { tenant_id: "t" };
    mockResearch.mockResolvedValue([page("https://a.com/1"), page("https://b.com/2")]);
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(mockIntel).toHaveBeenCalled();
  });
});

describe("the spend brake", () => {
  it("skips before claiming anything when the setting is explicitly off", async () => {
    settingValue = false;
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "skipped", reason: "disabled" });
    expect(tenantRpcSpy).not.toHaveBeenCalled();
  });

  it("defaults ON when the setting has never been stored (repo hard rule 7)", async () => {
    settingValue = undefined;
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(tenantRpcSpy).toHaveBeenCalled();
  });
});

describe("readiness counts independent hosts, not pages", () => {
  it("stores thin when both sources share one host", async () => {
    mockResearch.mockResolvedValue([
      page("https://trustpilot.com/acme"),
      page("https://trustpilot.com/acme/reviews?page=2"),
    ]);
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    const written = updates.find((u) => u.table === "growth_intake_research");
    expect(written?.patch.status).toBe("thin");
  });

  it("treats www. and the bare host as the same source", async () => {
    mockResearch.mockResolvedValue([
      page("https://trustpilot.com/acme"),
      page("https://www.trustpilot.com/acme/other"),
    ]);
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(updates.find((u) => u.table === "growth_intake_research")?.patch.status).toBe("thin");
  });

  it("treats two subdomains of one site as a single source", async () => {
    mockResearch.mockResolvedValue([
      page("https://reviews.trustpilot.com/acme"),
      page("https://support.trustpilot.com/acme"),
    ]);
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(updates.find((u) => u.table === "growth_intake_research")?.patch.status).toBe("thin");
  });

  it("keeps two different .co.uk sites apart", async () => {
    mockResearch.mockResolvedValue([
      page("https://acme.co.uk/about"),
      page("https://which.co.uk/reviews/acme"),
    ]);
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(updates.find((u) => u.table === "growth_intake_research")?.patch.status).toBe("ready");
  });

  it("stores ready when the two sources are genuinely different hosts", async () => {
    mockResearch.mockResolvedValue([
      page("https://trustpilot.com/acme"),
      page("https://reddit.com/r/acme"),
    ]);
    const { res } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(updates.find((u) => u.table === "growth_intake_research")?.patch.status).toBe("ready");
  });
});

describe("a result that did not save is not reported as saved", () => {
  it("answers failed, not ready, when the terminal write errors", async () => {
    updateError = { message: "canceling statement due to statement timeout" };
    mockResearch.mockResolvedValue([
      page("https://trustpilot.com/acme"),
      page("https://reddit.com/r/acme"),
    ]);
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(updates.find((u) => u.table === "growth_intake_research")?.patch.status).toBe("ready");
    expect(json).toHaveBeenCalledWith({ status: "failed", reason: "research_not_saved" });
  });

  it("answers ready when the write lands", async () => {
    mockResearch.mockResolvedValue([
      page("https://trustpilot.com/acme"),
      page("https://reddit.com/r/acme"),
    ]);
    const { res, json } = mockRes();

    await postGrowthIntakeResearch(req, res);

    expect(json).toHaveBeenCalledWith({ status: "ready", sources: 2 });
  });
});

describe("GET /growth-intake/learned (the card shown while the plan cooks)", () => {
  it("serves today's stored research as the card and never claims, researches or spends", async () => {
    tableRows.growth_intake_research = {
      status: "ready",
      reason: null,
      fetched_at: "2026-10-30T00:00:00Z",
      payload: {
        domain: "acme.com",
        research_pages: [page("https://yelp.com/acme"), page("https://bbb.org/acme")],
        competitors: [{ name: "Globex" }, { name: "Initech" }],
        site: null,
        marketplace: null,
        dossier: {
          facts: [{ topic: "pricing", fact: "f", own_site: true, quote: "Plans from $9 a month", source_url: "https://acme.com/pricing" }],
          pages_read: [{ url: "https://acme.com/", title: "Home" }],
          dropped_unverified: 0,
          cost_usd: 0,
        },
      },
    };
    const dossierCalls = (buildPlanDossier as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const { res, json } = mockRes();
    await getGrowthIntakeLearned(req, res);
    expect(json).toHaveBeenCalledWith({
      status: "ready",
      card: {
        lines: [
          "Read 2 pages about you outside your own site, on yelp.com and bbb.org.",
          "You come up next to Globex and Initech.",
          "Read 1 page of your own site.",
        ],
        quotes: [{ text: "Plans from $9 a month", source_url: "https://acme.com/pricing" }],
      },
    });
    expect(tenantRpcSpy).not.toHaveBeenCalled();
    expect(mockResearch).not.toHaveBeenCalled();
    expect((buildPlanDossier as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(dossierCalls);
    expect(updates).toEqual([]);
  });

  it("before the pass has stored anything it answers none, so the page keeps waiting", async () => {
    const { res, json } = mockRes();
    await getGrowthIntakeLearned(req, res);
    expect(json).toHaveBeenCalledWith({ status: "none", card: null });
    expect(tenantRpcSpy).not.toHaveBeenCalled();
  });
});
