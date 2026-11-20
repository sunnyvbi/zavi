import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn(), tokens: [] as string[], delays: [] as number[] }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: async () => ({ tenant_id: "tenant", user_id: "owner" }) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "allowed" }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: async () => {
    const wait = m.delays.shift();
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return m.tokens.shift() ?? "tok";
  }, forceRefreshConnector: vi.fn() }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ enforced: true, allowed: true }) }));
vi.mock("@/services/channels/lock", async (original) => ({
  ...(await original<typeof import("@/services/channels/lock")>()),
  isChannelLockedStrict: async () => false,
}));
vi.mock("@/services/tools/linkedin-ads/write/_flag-check", async (original) => ({
  ...(await original<typeof import("@/services/tools/linkedin-ads/write/_flag-check")>()),
  isLinkedInAdsWriteEnabled: async () => true,
}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getCampaignBinding: async () => ({ id: BINDING, tenant_id: "tenant", account_binding_id: "ab", account_id: "acc", platform: "linkedin", provider_campaign_id: "500", funding_source: "provider" }),
  getAccountBinding: async () => ({
    id: "ab",
    tenant_id: "tenant",
    account_id: "acc",
    platform: "linkedin",
    provider_account_id: "11",
    currency: "USD",
    verified_at: null,
    credential_source: "tenant_connector",
    credential_ref: "linkedin_ads.access_token",
    credential_tenant_id: "tenant",
    funding_source: "provider",
    legacy_key: null,
  }),
  verifyAccountBinding: async () => undefined,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  platformSecretRpc: vi.fn(),
  tenantClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: { provider_group_id: "7", provider_creative_ids: ["8"], stop_requested_at: null }, error: null }),
      });
      return q;
    },
  }),
}));

import type { Request, Response } from "express";
import { adsCampaignLaunch, adsCampaignLaunchSummary } from "../campaigns";
import { countLinkedInAdsCalls, resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";

const BINDING = "10000000-0000-4000-8000-0000000000aa";
const DAY_AGO = Date.now() - 86400_000;
const fetchMock = vi.fn();
const sent: string[] = [];
const state = { role: "CAMPAIGN_MANAGER", campaignStatus: "PAUSED" };
const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });

function route(href: string): string {
  const u = new URL(href);
  const path = decodeURIComponent(u.pathname.replace(/^\/rest\//, ""));
  if (path === "adAccounts/11") return "account";
  if (path === "adAccountUsers") return "users";
  if (path === "adAccounts/11/adCampaigns/500") return "campaign";
  if (path === "adAccounts/11/adCampaigns") return "siblings";
  if (path === "adAccounts/11/adCampaignGroups/7") return "group";
  if (path === "adAccounts/11/creatives/urn:li:sponsoredCreative:8") return "creative";
  if (path === "adAnalytics") return "analytics";
  return `unexpected:${path}`;
}

function answer(kind: string): unknown {
  if (kind === "account") return { id: 11, name: "Acme", currency: "USD", status: "ACTIVE", servingStatuses: ["RUNNABLE"] };
  if (kind === "users") return { elements: [{ account: "urn:li:sponsoredAccount:11", role: state.role }] };
  if (kind === "campaign")
    return {
      id: 500,
      account: "urn:li:sponsoredAccount:11",
      name: "Launch me",
      status: state.campaignStatus,
      campaignGroup: "urn:li:sponsoredCampaignGroup:7",
      runSchedule: { start: DAY_AGO },
      changeAuditStamps: { created: { time: DAY_AGO }, lastModified: { time: DAY_AGO } },
    };
  if (kind === "siblings") return { elements: [{ id: 500, campaignGroup: "urn:li:sponsoredCampaignGroup:7" }] };
  if (kind === "group") return { id: 7, account: "urn:li:sponsoredAccount:11", status: "PAUSED" };
  if (kind === "creative") return { id: "urn:li:sponsoredCreative:8", campaign: "urn:li:sponsoredCampaign:500", intendedStatus: "PAUSED" };
  if (kind === "analytics") return { elements: [{ pivotValues: ["urn:li:sponsoredCampaign:500"], costInLocalCurrency: "0" }] };
  throw new Error(kind);
}

function reply() {
  const out: { status: number; body: any } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, out };
}

async function open() {
  const { res, out } = reply();
  const before = sent.length;
  const run = countLinkedInAdsCalls(() => adsCampaignLaunchSummary({ params: { bindingId: BINDING }, query: {}, body: {} } as unknown as Request, res));
  await run.result;
  return { out, calls: run.calls, sent: sent.slice(before) };
}

async function launch(snapshot: string) {
  const { res, out } = reply();
  const before = sent.length;
  const body = { request_id: "10000000-0000-4000-8000-000000000001", snapshot, total_budget_cents: 5000, end_time: Date.now() + 7 * 86400_000 };
  const run = countLinkedInAdsCalls(() => adsCampaignLaunch({ params: { bindingId: BINDING }, query: {}, body } as unknown as Request, res));
  await run.result;
  return { out, calls: run.calls, sent: sent.slice(before) };
}

const count = (list: string[], kind: string) => list.filter((k) => k === kind).length;

beforeEach(() => {
  resetLinkedInAdsReadCache();
  sent.length = 0;
  m.tokens = [];
  m.delays = [];
  state.role = "CAMPAIGN_MANAGER";
  state.campaignStatus = "PAUSED";
  m.rpc.mockReset().mockResolvedValue({ data: 0, error: null });
  fetchMock.mockReset().mockImplementation(async (href: string) => {
    const kind = route(href);
    sent.push(kind);
    return json(answer(kind));
  });
  vi.stubGlobal("fetch", fetchMock);
});

it("reads the ad account and its users once for one Review launch open, even when the spend read reaches LinkedIn first", async () => {
  m.delays = [25];
  const first = await open();
  expect(first.out.status).toBe(200);
  expect(first.out.body).toMatchObject({ campaign_id: "500", account_id: "11", status: "PAUSED", observed_spend_cents: 0 });
  expect(first.sent.filter((k) => k.startsWith("unexpected"))).toEqual([]);
  expect(count(first.sent, "account")).toBe(1);
  expect(count(first.sent, "users")).toBe(1);
  expect(first.calls.length).toBe(first.sent.length);
  expect(first.calls.filter((c) => c === "GET adAccountUsers")).toHaveLength(1);
  expect([...first.sent].sort()).toEqual(["account", "analytics", "campaign", "campaign", "creative", "group", "siblings", "users"]);
});

it("makes no ad account or account user call on a second open inside the cache window", async () => {
  await open();
  const second = await open();
  expect(second.out.status).toBe(200);
  expect({ account: count(second.sent, "account"), users: count(second.sent, "users") }).toEqual({ account: 0, users: 0 });
  expect(second.calls).not.toContain("GET adAccountUsers");
  expect(second.out.body.snapshot).toBe((await open()).out.body.snapshot);
});

it("keeps account reads cached across a token refresh only when the token is the same", async () => {
  await open();
  m.tokens = ["tok2", "tok2", "tok2", "tok2"];
  const other = await open();
  expect(count(other.sent, "account")).toBe(1);
  expect(count(other.sent, "users")).toBe(1);
});

it("still re-reads the account, the role and the campaign live on Launch right after a cached review", async () => {
  const review = await open();
  expect(review.out.status).toBe(200);
  state.role = "VIEWER";
  const refused = await launch(review.out.body.snapshot);
  expect(refused.out.status).toBe(403);
  expect(refused.out.body.error.code).toBe("ads_account_read_only");
  expect(count(refused.sent, "account")).toBe(1);
  expect(count(refused.sent, "users")).toBe(1);
  state.role = "CAMPAIGN_MANAGER";
  state.campaignStatus = "ACTIVE";
  const changed = await launch(review.out.body.snapshot);
  expect(count(changed.sent, "account")).toBe(1);
  expect(count(changed.sent, "users")).toBe(1);
  expect(count(changed.sent, "campaign")).toBeGreaterThanOrEqual(1);
  expect(changed.out.status).toBe(409);
  expect(changed.out.body.error.message).toBe("Only a paused campaign can be launched here.");
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
