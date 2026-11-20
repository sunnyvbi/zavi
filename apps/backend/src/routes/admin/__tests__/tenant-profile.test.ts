
import { describe, it, expect, vi, beforeEach } from "vitest";

const { assertStaffMock } = vi.hoisted(() => ({
  assertStaffMock: vi.fn(() => ({ user_id: "u-staff", email: "ravi@upcar.ai" })),
}));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: assertStaffMock }));

const { serviceClientMock, cfg, reset } = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null };
  const c = {
    tables: {} as Record<string, Result>,
    calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
    getUserById: (async () => ({ data: { user: null } })) as (id: string) => Promise<unknown>,
  };
  const CHAIN = ["select", "eq", "in", "is", "gte", "order", "limit"];
  const client = {
    from: (table: string) => {
      const result = (): Result => c.tables[table] ?? { data: null, error: null };
      const b: Record<string, unknown> = {};
      for (const op of CHAIN) b[op] = (...args: unknown[]) => { c.calls.push({ table, op, args }); return b; };
      b.maybeSingle = () => Promise.resolve(result());
      b.single = () => Promise.resolve(result());
      b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(onF, onR);
      return b;
    },
    auth: { admin: { getUserById: (id: string) => c.getUserById(id) } },
  };
  return {
    serviceClientMock: vi.fn(() => client),
    cfg: c,
    reset: () => {
      c.tables = {};
      c.calls = [];
      c.getUserById = async () => ({ data: { user: null } });
      assertStaffMock.mockReset();
      assertStaffMock.mockReturnValue({ user_id: "u-staff", email: "ravi@upcar.ai" });
    },
  };
});
vi.mock("@/services/supabase", () => ({ serviceClient: serviceClientMock }));
vi.mock("@/services/agents/visibility", () => ({
  getAgentEffectiveStates: vi.fn(async () => [
    { slug: "engineer", effective_state: "visible" },
    { slug: "pm", effective_state: "visible" },
    { slug: "qa", effective_state: "hidden" },
  ]),
}));

import type { Request, Response } from "express";
import {
  inferSignupPath,
  summarizeConnectors,
  summarizeUsageSurfaces,
  summarizeBilling,
  computeLastActive,
  normalizeProductUrl,
  staffTenantProfile,
} from "../tenant-profile";

function mockRes() {
  const res: Partial<Response> & { _status: number; _json: unknown } = {
    _status: 200,
    _json: undefined,
    status(code: number) {
      this._status = code;
      return this as unknown as Response;
    },
    json(body: unknown) {
      this._json = body;
      return this as unknown as Response;
    },
  };
  return res as Response & { _status: number; _json: any };
}
const reqFor = (id: string) => ({ params: { tenant_id: id } }) as unknown as Request;

beforeEach(() => reset());

describe("inferSignupPath", () => {
  const created = "2026-01-01T00:00:00.000Z";
  it("slack draft present → slack-first / slack_draft", () => {
    expect(
      inferSignupPath({ hasSlackDraft: true, slackConnectedAt: null, tenantCreatedAt: created, onboardedAt: null }),
    ).toEqual({ path: "slack-first", evidence: "slack_draft" });
  });
  it("slack connected within 10min of created → slack_connected_near_created", () => {
    const near = "2026-01-01T00:05:00.000Z";
    expect(
      inferSignupPath({ hasSlackDraft: false, slackConnectedAt: near, tenantCreatedAt: created, onboardedAt: null }),
    ).toEqual({ path: "slack-first", evidence: "slack_connected_near_created" });
  });
  it("slack connected far from created falls through to onboarded", () => {
    const far = "2026-02-01T00:00:00.000Z";
    expect(
      inferSignupPath({ hasSlackDraft: false, slackConnectedAt: far, tenantCreatedAt: created, onboardedAt: "2026-02-01T00:00:00Z" }),
    ).toEqual({ path: "web-wizard", evidence: "profile_onboarded" });
  });
  it("onboarded, no slack → web-wizard / profile_onboarded", () => {
    expect(
      inferSignupPath({ hasSlackDraft: false, slackConnectedAt: null, tenantCreatedAt: created, onboardedAt: "2026-01-02T00:00:00Z" }),
    ).toEqual({ path: "web-wizard", evidence: "profile_onboarded" });
  });
  it("nothing → unknown / null", () => {
    expect(
      inferSignupPath({ hasSlackDraft: false, slackConnectedAt: null, tenantCreatedAt: created, onboardedAt: null }),
    ).toEqual({ path: "unknown", evidence: null });
  });
});

describe("summarizeConnectors", () => {
  it("connected only from authoritative source, not row existence", () => {
    const rows = summarizeConnectors(
      [
        { slug: "slack", team_name: "Acme", connected_at: "2026-01-01T00:00:00Z" },
        { slug: "github", team_name: null, connected_at: null },
      ],
      [{ server_id: "sentry", enabled: true }],
      [{ resource_kind: "hosting", provider: "render", status: "pending" }],
    );
    const bySlug = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(bySlug["slack"].connected).toBe(true);
    expect(bySlug["github"].connected).toBe(false);
    expect(bySlug["mcp:sentry"].connected).toBe(true);
    expect(bySlug["resource:render:hosting"].connected).toBe(false);
  });
  it("dedups an mcp server already covered by connector_metadata", () => {
    const rows = summarizeConnectors(
      [{ slug: "slack", team_name: null, connected_at: "2026-01-01T00:00:00Z" }],
      [{ server_id: "slack", enabled: true }],
      [],
    );
    expect(rows.filter((r) => r.label.startsWith("Slack")).length).toBe(1);
  });
});

describe("summarizeUsageSurfaces", () => {
  it("labels known triggers and buckets the rest into Other; last_at = max", () => {
    const out = summarizeUsageSurfaces([
      { trigger: "slack", enqueued_at: "2026-01-01T00:00:00Z", finished_at: null },
      { trigger: "slack", enqueued_at: "2026-01-03T00:00:00Z", finished_at: "2026-01-03T01:00:00Z" },
      { trigger: "chat", enqueued_at: "2026-01-02T00:00:00Z", finished_at: null },
      { trigger: "webhook", enqueued_at: "2026-01-04T00:00:00Z", finished_at: null },
    ]);
    const by = Object.fromEntries(out.map((s) => [s.surface, s]));
    expect(by["Slack"].runs).toBe(2);
    expect(by["Slack"].last_at).toBe("2026-01-03T01:00:00Z");
    expect(by["Web chat"].runs).toBe(1);
    expect(by["Other"].runs).toBe(1);
  });
});

describe("summarizeBilling", () => {
  it("null sub → free/unknown defaults, null credits", () => {
    const b = summarizeBilling(null, null, null);
    expect(b.plan).toBe("free");
    expect(b.status).toBe("unknown");
    expect(b.credits).toBeNull();
    expect(b.daily_cap_usd).toBeNull();
  });
  it("credits math = allowance - used, passthrough purchased + cap", () => {
    const b = summarizeBilling(
      { plan: "team", status: "active", current_period_end: null, cancel_at_period_end: false, stripe_customer_id: "cus_1" },
      { included_allowance: 100, included_used: 30, purchased_balance: 50, reserved: 5, period_end: null },
      { daily_cap_usd: 25 },
    );
    expect(b.plan).toBe("team");
    expect(b.credits?.included_remaining).toBe(70);
    expect(b.credits?.purchased_balance).toBe(50);
    expect(b.daily_cap_usd).toBe(25);
  });
});

describe("computeLastActive", () => {
  it("takes max across run + chat, tags source", () => {
    expect(
      computeLastActive(
        [{ trigger: "cron", enqueued_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T01:00:00Z" }],
        "2026-01-05T00:00:00Z",
      ),
    ).toEqual({ at: "2026-01-05T00:00:00Z", source: "chat" });
  });
  it("run newer than chat → source run", () => {
    expect(
      computeLastActive([{ trigger: "cron", enqueued_at: "2026-02-01T00:00:00Z", finished_at: null }], "2026-01-01T00:00:00Z"),
    ).toEqual({ at: "2026-02-01T00:00:00Z", source: "run" });
  });
  it("both null → null/null", () => {
    expect(computeLastActive([], null)).toEqual({ at: null, source: null });
  });
});

describe("normalizeProductUrl", () => {
  it("string http(s) → {href,label}", () => {
    expect(normalizeProductUrl("https://acme.com/app")).toEqual({ href: "https://acme.com/app", label: "acme.com/app" });
  });
  it("object with href", () => {
    expect(normalizeProductUrl({ href: "https://x.io" })?.label).toBe("x.io");
  });
  it("non-http / garbage → null", () => {
    expect(normalizeProductUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeProductUrl("not a url")).toBeNull();
    expect(normalizeProductUrl(null)).toBeNull();
  });
});

describe("staffTenantProfile handler", () => {
  const TID = "73db45ff-457e-4541-bc8f-bdb625390204";
  const tenantRow = {
    id: TID,
    slug: "acme",
    display_name: "Acme",
    tier: "operator",
    kind: "real",
    created_at: "2026-01-01T00:00:00Z",
    product_url: "https://acme.com",
    show_in_public_feed: false,
    rar_weekly_threshold: 3500,
  };

  it("non-staff → assertStaff throws before any DB read", async () => {
    assertStaffMock.mockImplementation(() => {
      throw new Error("not_staff");
    });
    await expect(staffTenantProfile(reqFor(TID), mockRes())).rejects.toThrow("not_staff");
    expect(cfg.calls).toEqual([]);
  });

  it("tenant not found → 404", async () => {
    cfg.tables["tenants"] = { data: null, error: null };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._status).toBe(404);
    expect(res._json.error.code).toBe("tenant_not_found");
  });

  it("happy path → 200, shape assembled, degraded empty, billing defaults", async () => {
    cfg.tables["tenants"] = { data: tenantRow, error: null };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._status).toBe(200);
    expect(res._json.tenant.slug).toBe("acme");
    expect(res._json.tenant.product_url).toEqual({ href: "https://acme.com/", label: "acme.com" });
    expect(res._json.primary_owner).toBeNull();
    expect(res._json.billing.plan).toBe("free");
    expect(res._json.usage.agents_enabled).toBe(2);
    expect(res._json.degraded).toEqual([]);
  });

  it("shows the recorded affiliate and scopes attribution reads to this tenant", async () => {
    cfg.tables.tenants = { data: tenantRow, error: null };
    cfg.tables.tenant_app_setting = { data: { value: { from: "cr-demo", utm_source: "newsletter" } }, error: null };
    cfg.tables.affiliate_referrals = { data: { member_id: "creator-1", code: "abcdefgh", clicked_at: "2026-01-01T00:00:00Z" }, error: null };
    cfg.tables.human_members = { data: { display_name: "Maya" }, error: null };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._json.attribution).toEqual({ source: "Maya", kind: "affiliate", creator_id: "creator-1", referral_code: "abcdefgh", clicked_at: "2026-01-01T00:00:00Z", source_tag: "cr-demo" });
    for (const table of ["tenant_app_setting", "affiliate_referrals"]) {
      expect(cfg.calls).toContainEqual({ table, op: "eq", args: ["tenant_id", TID] });
    }
    expect(cfg.calls).toContainEqual({ table: "tenant_app_setting", op: "eq", args: ["key", "signup_attribution"] });
    expect(cfg.calls).toContainEqual({ table: "human_members", op: "eq", args: ["id", "creator-1"] });
  });

  it("keeps recorded affiliate identity when its display name is unavailable", async () => {
    cfg.tables.tenants = { data: tenantRow, error: null };
    cfg.tables.affiliate_referrals = { data: { member_id: "creator-1", code: "abcdefgh", clicked_at: null }, error: null };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._json.attribution).toMatchObject({ source: "Creator", kind: "affiliate", creator_id: "creator-1", referral_code: "abcdefgh", clicked_at: null });
  });

  it.each([
    [{ from: "cr-demo", utm_source: "newsletter" }, { source: "cr-demo", kind: "from" }],
    [{ utm_source: "newsletter" }, { source: "newsletter", kind: "utm_source" }],
    [{ referrer_host: "example.com" }, { source: "example.com", kind: "referrer" }],
    [{ landing_path: "/" }, { source: "Direct", kind: "direct" }],
    [null, { source: "Unknown", kind: "unknown" }],
  ])("resolves non-affiliate source %j", async (value, expected) => {
    cfg.tables.tenants = { data: tenantRow, error: null };
    cfg.tables.tenant_app_setting = { data: { value }, error: null };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._json.attribution).toMatchObject({ ...expected, referral_code: null, clicked_at: null });
    expect(res._json.attribution.creator_id).toBeUndefined();
  });

  it.each(["affiliate_referrals", "tenant_app_setting", "human_members"])("reports a %s read failure rather than a false Unknown source", async table => {
    cfg.tables.tenants = { data: tenantRow, error: null };
    cfg.tables.affiliate_referrals = { data: { member_id: "creator-1", code: "abcdefgh", clicked_at: null }, error: null };
    cfg.tables[table] = { data: null, error: { message: "unavailable" } };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._json.attribution).toBeNull();
    expect(res._json.degraded).toContain("attribution");
    expect(res._status).toBe(200);
  });

  it("owner auth lookup failure → primary_owner email null, still 200, NOT degraded", async () => {
    cfg.tables["tenants"] = { data: tenantRow, error: null };
    cfg.tables["tenant_users"] = {
      data: [{ user_id: "u1", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
      error: null,
    };
    cfg.getUserById = async () => {
      throw new Error("auth down");
    };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._status).toBe(200);
    expect(res._json.primary_owner).toEqual({ user_id: "u1", email: null, name: null, joined_at: "2026-01-01T00:00:00Z" });
    expect(res._json.owner_count).toBe(1);
    expect(res._json.degraded).not.toContain("owner");
  });

  it("section query error → section null + key in degraded, page still 200", async () => {
    cfg.tables["tenants"] = { data: tenantRow, error: null };
    cfg.tables["connector_metadata"] = { data: null, error: { message: "boom" } };
    const res = mockRes();
    await staffTenantProfile(reqFor(TID), res);
    expect(res._status).toBe(200);
    expect(res._json.connectors).toEqual([]);
    expect(res._json.degraded).toContain("connectors");
  });
});
