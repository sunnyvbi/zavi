import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => {
  type Row = { team_id: string; connected_at: string };
  const rows = new Map<string, Row>();
  let clock = 0;
  const authTenant = { id: "t1" };
  const linked = new Map<string, string>();
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === "disconnect_connector") {
      rows.delete(`${args.p_tenant_id}:${args.p_slug}`);
      linked.delete(String(args.p_tenant_id));
      return { data: null, error: null };
    }
    if (name === "set_connector_connection") {
      clock += 1;
      rows.set(`${args.p_tenant_id}:${args.p_slug}`, {
        team_id: String(args.p_team_id),
        connected_at: new Date(Date.UTC(2026, 9, 23, 0, 0, clock)).toISOString(),
      });
      linked.set(String(args.p_tenant_id), String(args.p_team_id));
      return { data: null, error: null };
    }
    if (name === "consume_oauth_state") return { data: [{ tenant_id: authTenant.id, user_id: "u1" }], error: null };
    return { data: null, error: null };
  };
  const from = (table: string) => {
    const f: Record<string, unknown> = {};
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        f[k] = v;
        return q;
      },
      maybeSingle: async () => {
        if (table !== "connector_metadata") return { data: null, error: null };
        return { data: rows.get(`${f.tenant_id}:${f.slug}`) ?? null, error: null };
      },
    };
    return q;
  };
  const client = { rpc, from };
  return { rows, linked, authTenant, client, exchangeTeam: { id: "acct-A" }, chosen: new Map<string, string>(), selectionFails: { on: false }, changes: new Map<string, Record<string, unknown[]>>(), changeFails: { table: "" } };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => h.client,
  serverClientFromBearer: () => h.client,
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ user_id: "u1", tenant_id: h.authTenant.id, access_token: "jwt" }),
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: async () => null }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRole: async () => "owner", loadTenantRoleFor: async () => "owner" }));
vi.mock("@/services/connectors/core/registry", () => ({
  isKnownConnector: (s: string) => s === "linkedin_ads",
  getConnector: (s: string) =>
    s === "linkedin_ads"
      ? {
          slug: s,
          serverId: "linkedin_ads",
          exchangeCode: async () => ({
            secrets: { access_token: "tok" },
            expiresInSec: 3600,
            metadata: { team_id: h.exchangeTeam.id, team_name: h.exchangeTeam.id, scopes: [] },
          }),
        }
      : null,
}));
vi.mock("@/services/connectors/core/token", () => ({ handleConnectorAccountSwap: async () => undefined }));
vi.mock("@/services/connectors/core/connector-events", () => ({ recordConnectorEvent: async () => undefined }));
vi.mock("@/services/tenants/active-tenant", () => ({ syncActiveTenant: async () => undefined }));
vi.mock("@/services/tenants/founder-activity-alert", () => ({ notifyFounderActivity: async () => undefined }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  listLinkedInAdAccounts: vi.fn(),
  listLinkedInCampaigns: vi.fn(),
  listLinkedInCampaignGroups: vi.fn(),
  readLinkedInAdAnalytics: vi.fn(),
  readLinkedInAdAnalyticsWithToken: vi.fn(),
  readLinkedInCreatives: vi.fn(),
  readLinkedInCreativesWithToken: vi.fn(),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ linkedinCampaign: vi.fn() }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  globalClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, in: () => q, range: async () => ({ data: [], error: null }) };
      return q;
    },
  }),
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const acct = h.linked.get(tenant);
      const chosen = h.chosen.get(tenant);
      const rows =
        table in (h.changes.get(tenant) ?? {})
          ? (h.changes.get(tenant) as Record<string, unknown[]>)[table]
          : table === "ads_account_binding_details" && acct
          ? [
              { id: "own", tenant_id: tenant, provider_account_id: acct, funding_source: "provider" },
              ...(chosen ? [{ id: "own-second", tenant_id: tenant, provider_account_id: "acct-second", funding_source: "provider" }] : []),
            ]
          : [];
      const selection = table === "ads_account_selections" && acct ? { account_binding_id: chosen ?? "own", tenant_id: tenant } : null;
      const failed = table === "ads_account_selections" && h.selectionFails.on;
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => q,
        range: async () => (table === h.changeFails.table ? { data: null, error: { message: "change read failed" } } : { data: rows, error: null }),
        maybeSingle: async () => (failed ? { data: null, error: { message: "selection read failed" } } : { data: selection, error: null }),
      };
      return q;
    },
  }),
}));

import { ExpectedToolError } from "@/services/tools/types";
import {
  listLinkedInAdAccounts,
  listLinkedInCampaignGroups,
  listLinkedInCampaigns,
  readLinkedInAdAnalytics,
  readLinkedInCreatives,
} from "@/services/connectors/linkedin-ads/client";
import { connectorCallback, connectorDisconnect } from "@/routes/connectors/connector";
import { build, type LinkedinAdsPayload } from "../linkedin-ads";

const accounts = vi.mocked(listLinkedInAdAccounts);
const campaigns = vi.mocked(listLinkedInCampaigns);
const analytics = vi.mocked(readLinkedInAdAnalytics);
const adStates = vi.mocked(readLinkedInCreatives);

const SPEND: Record<string, number> = { "acct-A": 111, "acct-B": 222, "acct-T2": 333, "acct-second": 444 };

function wireVendor() {
  accounts.mockImplementation(async (tenant) => {
    const acct = h.linked.get(tenant);
    if (!acct) throw new ExpectedToolError("linkedin_ads_not_connected", "LinkedIn Ads is not connected");
    return [acct, ...(h.chosen.has(tenant) ? ["acct-second"] : [])].map((id) => ({ id, name: `Name ${id}`, currency: "USD", status: "ACTIVE" }));
  });
  campaigns.mockImplementation(async (_t, acct) => [
    { id: `c-${acct}`, name: `Camp ${acct}`, status: "ACTIVE", objective: null, budget: null, campaign_group_id: null },
  ]);
  analytics.mockImplementation(async (_t, acct) => [
    { pivot: `urn:li:sponsoredCampaign:c-${acct}`, impressions: 1000, clicks: 10, spend: SPEND[acct], conversions: 1, leads: 0 },
  ]);
  adStates.mockImplementation(async (_t, acct) => [{ id: null, name: null, created_at: null, last_modified_at: null, campaign_id: `c-${acct}`, intended_status: "ACTIVE", is_serving: true, hold_reasons: [], review_status: "APPROVED" }]);
}

const open = async (tenantId: string, rangeDays = 30) =>
  (await build({
    tenantId,
    accessToken: "jwt",
    sb: h.client,
    rangeDays,
    refresh: false,
    meteredRefresh: false,
  } as unknown as Parameters<typeof build>[0])) as LinkedinAdsPayload;

function res() {
  const r: Record<string, unknown> & { statusCode: number } = { statusCode: 0 };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = () => ((r.statusCode ||= 200), r);
  r.redirect = (c: number) => ((r.statusCode = c), r);
  return r as unknown as Response & { statusCode: number };
}

async function connectAs(tenant: string, team: string) {
  h.authTenant.id = tenant;
  h.exchangeTeam.id = team;
  const r = res();
  await connectorCallback({ params: { connector: "linkedin_ads" }, query: { code: "c", state: "s" }, headers: {} } as unknown as Request, r);
  expect(r.statusCode).toBe(302);
}

async function disconnect(tenant: string) {
  h.authTenant.id = tenant;
  const r = res();
  await connectorDisconnect({ params: { connector: "linkedin_ads" }, headers: {} } as unknown as Request, r);
  expect(r.statusCode).toBe(200);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.rows.clear();
  h.linked.clear();
  h.chosen.clear();
  h.selectionFails.on = false;
  h.changes.clear();
  h.changeFails.table = "";
  process.env.BACKEND_PUBLIC_URL = "http://backend.test";
  vi.mocked(listLinkedInCampaignGroups).mockResolvedValue([]);
  wireVendor();
});

describe("linkedin_ads dashboard cache across disconnect and reconnect", () => {
  it("drops account A's numbers on disconnect, shows B after reconnect, and leaves another tenant's cache alone", async () => {
    await connectAs("t1", "acct-A");
    await connectAs("t2", "acct-T2");

    const a = await open("t1");
    expect(a.connected).toBe(true);
    expect(a.totals?.spend).toBe(111);
    const t2 = await open("t2");
    expect(t2.totals?.spend).toBe(333);
    expect((await open("t1")).totals?.spend).toBe(111);
    const callsWarm = accounts.mock.calls.length;
    expect(callsWarm).toBe(2);

    await disconnect("t1");
    const gone = await open("t1");
    expect(gone.connected).toBe(false);
    expect(gone.totals).toBeNull();
    expect(gone.account).toBeNull();
    expect(gone.campaigns).toEqual([]);

    await connectAs("t1", "acct-B");
    const b = await open("t1");
    expect(b.connected).toBe(true);
    expect(b.totals?.spend).toBe(222);
    expect(b.account?.name).toBe("Name acct-B");
    expect(b.campaigns.map((x) => x.ad_account_id)).toEqual(["acct-B"]);

    const t2Again = await open("t2");
    expect(t2Again.totals?.spend).toBe(333);
    expect(accounts.mock.calls.filter(([t]) => t === "t2")).toHaveLength(1);
  });

  it("a reconnect straight over the old row, with no disconnect between, still serves the new account", async () => {
    await connectAs("t1", "acct-A");
    expect((await open("t1")).totals?.spend).toBe(111);
    await connectAs("t1", "acct-B");
    const b = await open("t1");
    expect(b.totals?.spend).toBe(222);
    expect(b.campaigns.map((x) => x.ad_account_id)).toEqual(["acct-B"]);
  });

  it("choosing another ad account on the same connection serves that account at once, not the cached one", async () => {
    await connectAs("t1", "acct-A");
    const before = await open("t1");
    expect(before.totals?.spend).toBe(111);
    expect(before.campaigns.map((x) => x.ad_account_id)).toEqual(["acct-A"]);
    h.chosen.set("t1", "own-second");
    const after = await open("t1");
    expect(after.totals?.spend).toBe(444);
    expect(after.campaigns.map((x) => x.ad_account_id)).toEqual(["acct-second"]);
    expect((await open("t1")).totals?.spend).toBe(444);
    expect(accounts).toHaveBeenCalledTimes(2);
    h.chosen.delete("t1");
    expect((await open("t1")).totals?.spend).toBe(111);
  });

  it("an unreadable selection bypasses the cache instead of serving a possibly wrong account", async () => {
    await connectAs("t1", "acct-A");
    await open("t1");
    expect(accounts).toHaveBeenCalledTimes(1);
    h.selectionFails.on = true;
    await open("t1");
    expect(accounts).toHaveBeenCalledTimes(2);
  });

  it("a failed ad read is not cached: the next poll reads again and shows the rejection instead of a stale unknown", async () => {
    await connectAs("t1", "acct-A");
    adStates.mockRejectedValueOnce(new Error("creatives read failed"));
    const failed = await open("t1");
    expect(failed.campaigns.map((x) => x.ad_delivery)).toEqual(["unread"]);
    expect(adStates).toHaveBeenCalledTimes(1);

    adStates.mockResolvedValueOnce([{ id: null, name: null, created_at: null, last_modified_at: null, campaign_id: "c-acct-A", intended_status: "ACTIVE", is_serving: false, hold_reasons: [], review_status: "REJECTED" }]);
    const next = await open("t1");
    expect(adStates).toHaveBeenCalledTimes(2);
    expect(next.campaigns.map((x) => x.ad_delivery)).toEqual(["rejected"]);
    expect(next.account?.active_count).toBe(0);

    expect((await open("t1")).campaigns.map((x) => x.ad_delivery)).toEqual(["rejected"]);
    expect(adStates).toHaveBeenCalledTimes(2);
  });

  it("still serves a warm read from cache while the connection is unchanged", async () => {
    await connectAs("t1", "acct-A");
    await open("t1");
    await open("t1");
    expect(accounts).toHaveBeenCalledTimes(1);
  });
});

describe("linkedin_ads dashboard cache after a launch or a pause", () => {
  const setStatus = (status: string) =>
    campaigns.mockImplementation(async (_t, acct) => [{ id: `c-${acct}`, name: `Camp ${acct}`, status, objective: null, budget: null, campaign_group_id: null }]);
  const shown = (p: LinkedinAdsPayload) => p.campaigns.map((c) => c.status);

  it.each([
    ["a launch recorded by another process", { ads_campaign_operations: [{ updated_at: "2026-10-30T10:00:00Z" }] }],
    ["a launch attempt stamped on the lifecycle", { ads_campaign_lifecycle: [{ campaign_binding_id: "b1", activation_attempted_at: "2026-10-30T10:00:00Z", stop_requested_at: null, stop_confirmed_at: null }] }],
    ["a pause confirmed on the lifecycle", { ads_campaign_lifecycle: [{ campaign_binding_id: "b1", activation_attempted_at: null, stop_requested_at: "2026-10-30T10:00:00Z", stop_confirmed_at: "2026-10-30T10:00:01Z" }] }],
    ["a card that executed on the channel", { channel_actions: [{ executed_at: "2026-10-30T10:00:00Z" }] }],
  ])("%s shows on the next plain open, and the read after that is cached again", async (_label, change) => {
    await connectAs("t-change", "acct-A");
    setStatus("PAUSED");
    expect(shown(await open("t-change"))).toEqual(["PAUSED"]);
    expect(accounts).toHaveBeenCalledTimes(1);
    setStatus("ACTIVE");
    expect(shown(await open("t-change"))).toEqual(["PAUSED"]);
    expect(accounts).toHaveBeenCalledTimes(1);
    h.changes.set("t-change", change);
    expect(shown(await open("t-change"))).toEqual(["ACTIVE"]);
    expect(accounts).toHaveBeenCalledTimes(2);
    expect(shown(await open("t-change"))).toEqual(["ACTIVE"]);
    expect(accounts).toHaveBeenCalledTimes(2);
  });

  it("one operation moving from pending to succeeded invalidates again, so a read taken mid-launch is not kept", async () => {
    await connectAs("t-mid", "acct-A");
    setStatus("PAUSED");
    h.changes.set("t-mid", { ads_campaign_operations: [{ updated_at: "2026-10-30T10:00:00Z" }] });
    expect(shown(await open("t-mid"))).toEqual(["PAUSED"]);
    setStatus("ACTIVE");
    h.changes.set("t-mid", { ads_campaign_operations: [{ updated_at: "2026-10-30T10:00:05Z" }] });
    expect(shown(await open("t-mid"))).toEqual(["ACTIVE"]);
  });

  it("must catch: a slow read begun before the launch lands after it and cannot be served as the current state", async () => {
    await connectAs("t-race", "acct-A");
    let release: (rows: unknown[]) => void = () => {};
    setStatus("PAUSED");
    campaigns.mockImplementationOnce(() => new Promise((r) => { release = r as (rows: unknown[]) => void; }) as never);
    const slow = open("t-race");
    await vi.waitFor(() => expect(campaigns).toHaveBeenCalledTimes(1));
    h.changes.set("t-race", { ads_campaign_operations: [{ updated_at: "2026-10-30T10:00:00Z" }] });
    setStatus("ACTIVE");
    expect(shown(await open("t-race"))).toEqual(["ACTIVE"]);
    release([{ id: "c-acct-A", name: "Camp", status: "PAUSED", objective: null, budget: null, campaign_group_id: null }]);
    expect(shown(await slow)).toEqual(["PAUSED"]);
    const reads = accounts.mock.calls.length;
    expect(shown(await open("t-race"))).toEqual(["ACTIVE"]);
    expect(accounts).toHaveBeenCalledTimes(reads);
  });

  it("non-regression guard: another tenant's launch does not throw this tenant's cache away", async () => {
    await connectAs("t-mine", "acct-A");
    await open("t-mine");
    h.changes.set("t-other", { ads_campaign_operations: [{ updated_at: "2026-10-30T10:00:00Z" }] });
    await open("t-mine");
    expect(accounts).toHaveBeenCalledTimes(1);
  });

  it.each(["ads_campaign_lifecycle", "ads_campaign_operations", "channel_actions"])("an unreadable %s bypasses the cache rather than risking a stale launch", async (table) => {
    await connectAs(`t-down-${table}`, "acct-A");
    h.changeFails.table = table;
    await open(`t-down-${table}`);
    await open(`t-down-${table}`);
    expect(accounts).toHaveBeenCalledTimes(2);
  });

  it("a tenant past the lifecycle page bypasses the cache: an unread row could be the launch", async () => {
    await connectAs("t-many", "acct-A");
    h.changes.set("t-many", { ads_campaign_lifecycle: Array.from({ length: 1000 }, (_, i) => ({ campaign_binding_id: `b${i}` })) });
    await open("t-many");
    await open("t-many");
    expect(accounts).toHaveBeenCalledTimes(2);
  });

  it("non-regression guard: with nothing changed the 5 minute cache still holds and then expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
      await connectAs("t-ttl", "acct-A");
      await open("t-ttl");
      vi.setSystemTime(new Date("2026-10-30T12:04:59Z"));
      await open("t-ttl");
      expect(accounts).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-10-30T12:05:01Z"));
      await open("t-ttl");
      expect(accounts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("linkedin_ads dashboard window", () => {
  it("compares complete days ending yesterday with the same number of complete days before, so an unfinished today never reads as a drop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-30T15:00:00Z"));
      await connectAs("t-today", "acct-A");
      analytics.mockImplementation(async (_t, acct, q) => {
        const { start, end } = q as { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } };
        const days = (Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000 + 1;
        const partial = end.month === 10 && end.day === 30 ? 0.4 : 1;
        return [{ pivot: `urn:li:sponsoredCampaign:c-${acct}`, impressions: 100 * days * partial, clicks: 10 * days * partial, spend: 5 * days * partial, conversions: days, leads: 0 }];
      });
      const p = await open("t-today");
      expect(p.period).toEqual({ from: "2026-09-30", to: "2026-10-29" });
      expect(p.prev_period).toEqual({ from: "2026-08-31", to: "2026-09-29" });
      expect(analytics.mock.calls[0][2]).toMatchObject({ start: { year: 2026, month: 9, day: 30 }, end: { year: 2026, month: 10, day: 29 } });
      expect(analytics.mock.calls[1][2]).toMatchObject({ start: { year: 2026, month: 8, day: 31 }, end: { year: 2026, month: 9, day: 29 } });
      expect(p.totals).toMatchObject({ spend: 150, clicks: 300, impressions: 3000 });
      expect(p.prev_totals).toMatchObject({ spend: 150, clicks: 300, impressions: 3000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("every range compares two windows of the same number of days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-30T15:00:00Z"));
      for (const rangeDays of [7, 14, 30]) {
        await connectAs(`t-len-${rangeDays}`, "acct-A");
        const p = await open(`t-len-${rangeDays}`, rangeDays);
        const len = (w: { from: string; to: string }) => (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000 + 1;
        expect([len(p.period), len(p.prev_period), p.period.to]).toEqual([rangeDays, rangeDays, "2026-10-29"]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("non-regression guard: makes exactly the same number of LinkedIn analytics reads as before", async () => {
    await connectAs("t-count", "acct-A");
    await open("t-count");
    expect(analytics).toHaveBeenCalledTimes(2);
    expect(adStates).toHaveBeenCalledTimes(1);
  });

  it("the window moves at UTC midnight so a warm read from yesterday cannot hide the day that just finished", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-30T23:59:00Z"));
      await connectAs("t-midnight", "acct-A");
      expect((await open("t-midnight")).period.to).toBe("2026-10-29");
      vi.setSystemTime(new Date("2026-10-31T00:01:00Z"));
      expect((await open("t-midnight")).period.to).toBe("2026-10-30");
      expect(accounts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
