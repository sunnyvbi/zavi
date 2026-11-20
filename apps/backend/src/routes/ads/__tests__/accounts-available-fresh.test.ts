import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  tier: vi.fn(),
  lock: vi.fn(),
  token: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: m.role }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "blocked" }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.lock }));
vi.mock("@/services/connectors/core/token", () => ({ getConnectorToken: m.token, forceRefreshConnector: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
import { adsAvailableAccounts } from "../accounts";
import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/http";
import { listLinkedInAdAccounts } from "@/services/connectors/linkedin-ads/client";

const fetchMock = vi.fn();
const OLD = { id: 501, name: "Acme main", currency: "USD", status: "ACTIVE" };
const INVITED = { id: 777, name: "Acme invited today", currency: "EUR", status: "ACTIVE" };
const page = (elements: unknown[]) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ elements, metadata: {} }) });
const req = (query: Record<string, string> = {}) => ({ params: { platform: "linkedin" }, method: "GET", query }) as unknown as Request;
const refresh = () => req({ refresh: "1" });
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};
const adAccountCalls = () => fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/adAccounts")).length;

beforeEach(async () => {
  vi.resetAllMocks();
  resetLinkedInAdsReadCache();
  vi.stubGlobal("fetch", fetchMock);
  m.auth.mockResolvedValue({ tenant_id: "verified", user_id: "owner" });
  m.role.mockResolvedValue(true);
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.token.mockResolvedValue("tok-verified");
  fetchMock.mockResolvedValueOnce(page([OLD]));
  await listLinkedInAdAccounts("verified");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([OLD, INVITED]));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.LINKEDIN_ADS_CACHE_FILE;
});
const body = (r: { json: ReturnType<typeof vi.fn> }) => r.json.mock.calls[0][0] as { accounts: Array<{ id: string; name: string }>; fetched_at: string; just_refreshed: boolean };
const T0 = new Date("2026-10-30T09:00:00.000Z").getTime();
const at = (ms: number) => vi.setSystemTime(T0 + ms);
const load = async (request = req()) => {
  const r = res();
  await adsAvailableAccounts(request, r);
  expect(r.status).not.toHaveBeenCalled();
  return body(r);
};

it("shows an ad account invited after the list was cached, asking LinkedIn exactly once, and says when it was fetched", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  const r = res();
  await adsAvailableAccounts(req(), r);
  expect(r.status).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({
    accounts: [
      { id: "501", name: "Acme main", currency: "USD", status: "ACTIVE" },
      { id: "777", name: "Acme invited today", currency: "EUR", status: "ACTIVE" },
    ],
    fetched_at: "2026-10-30T09:00:00.000Z",
    just_refreshed: false,
  });
  expect(adAccountCalls()).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-verified");
});

it("refills the cache so the review path then sees the invited account without asking LinkedIn", async () => {
  await adsAvailableAccounts(req(), res());
  fetchMock.mockClear();
  const cached = await listLinkedInAdAccounts("verified");
  expect(cached.map((a) => a.id)).toEqual(["501", "777"]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("leaves the cached review path cached until someone asks to find accounts", async () => {
  const cached = await listLinkedInAdAccounts("verified");
  expect(cached.map((a) => a.id)).toEqual(["501"]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("a second page open within 24 hours asks LinkedIn nothing and serves the same list and time", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  const first = await load();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([{ id: 999, name: "Should not be read" }]));
  at(24 * 3600_000 - 1);
  const second = await load();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(second).toEqual(first);
  expect(second.fetched_at).toBe("2026-10-30T09:00:00.000Z");
});

it("a page open after 24 hours asks LinkedIn exactly once and serves the new list", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  await load();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([INVITED]));
  at(24 * 3600_000);
  const later = await load();
  expect(adAccountCalls()).toBe(1);
  expect(later.accounts.map((a) => a.id)).toEqual(["777"]);
  expect(later.fetched_at).toBe("2026-10-31T09:00:00.000Z");
  fetchMock.mockClear();
  await load();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("a manual refresh within 5 minutes asks LinkedIn nothing and returns the cached list with its real age, not flagged as just refreshed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  await load(refresh());
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([{ id: 999, name: "Should not be read" }]));
  at(5 * 60_000 - 1);
  const again = await load(refresh());
  expect(fetchMock).not.toHaveBeenCalled();
  expect(again.accounts.map((a) => a.id)).toEqual(["501", "777"]);
  expect(again.just_refreshed).toBe(false);
  expect(again.fetched_at).toBe("2026-10-30T09:00:00.000Z");
});

it("a manual refresh after 5 minutes bypasses the 24-hour cache and asks LinkedIn once", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  await load();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([INVITED]));
  at(5 * 60_000);
  const fresh = await load(refresh());
  expect(adAccountCalls()).toBe(1);
  expect(fresh).toEqual({ accounts: [{ id: "777", name: "Acme invited today", currency: "EUR", status: "ACTIVE" }], fetched_at: "2026-10-30T09:05:00.000Z", just_refreshed: true });
  fetchMock.mockClear();
  expect((await load()).accounts.map((a) => a.id)).toEqual(["777"]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("two opens racing on a cold cache share one LinkedIn call", async () => {
  const [a, b] = await Promise.all([load(), load()]);
  expect(adAccountCalls()).toBe(1);
  expect(a).toEqual(b);
});

it("never serves tenant A's cached list to tenant B, even when both connected the same LinkedIn login", async () => {
  await load();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([{ id: 5353, name: "Gamma only", currency: "USD", status: "ACTIVE" }]));
  m.auth.mockResolvedValue({ tenant_id: "third", user_id: "owner-c" });
  const c = await load();
  expect(c.accounts.map((a) => a.id)).toEqual(["5353"]);
  expect(adAccountCalls()).toBe(1);
  expect(m.token.mock.calls.map(([tenant]) => tenant)).toContain("third");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([{ id: 4242, name: "Beta only", currency: "USD", status: "ACTIVE" }]));
  m.auth.mockResolvedValue({ tenant_id: "other", user_id: "owner-b" });
  m.token.mockImplementation(async (tenant: string) => (tenant === "other" ? "tok-other" : "tok-verified"));
  const b = await load();
  expect(b.accounts.map((a) => a.id)).toEqual(["4242"]);
  expect(adAccountCalls()).toBe(1);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-other");
  fetchMock.mockReset();
  m.auth.mockResolvedValue({ tenant_id: "verified", user_id: "owner" });
  expect((await load()).accounts.map((a) => a.id)).toEqual(["501", "777"]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("a reconnected LinkedIn login drops the cached list on the next open", async () => {
  await load();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(page([INVITED]));
  m.token.mockResolvedValue("tok-reconnected");
  const after = await load();
  expect(adAccountCalls()).toBe(1);
  expect(after.accounts.map((a) => a.id)).toEqual(["777"]);
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-reconnected");
});

it("a disconnected LinkedIn login gets the connect error, not the cached list", async () => {
  await load();
  fetchMock.mockReset();
  m.token.mockResolvedValue(null);
  const r = res();
  await adsAvailableAccounts(req(), r);
  expect(r.status).toHaveBeenCalledWith(502);
  expect(r.json.mock.calls[0][0]).toMatchObject({ error: { code: "linkedin_ads_not_connected" } });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("a failed LinkedIn read is not cached: the next open asks again", async () => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers(), json: async () => ({}), text: async () => "" });
  const r = res();
  await adsAvailableAccounts(req(), r);
  expect(r.status).toHaveBeenCalledWith(502);
  fetchMock.mockResolvedValue(page([OLD]));
  expect((await load()).accounts.map((a) => a.id)).toEqual(["501"]);
});

it("keeps the cached list across a backend restart, so a restart does not spend a LinkedIn call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "li-list-"));
  try {
    process.env.LINKEDIN_ADS_CACHE_FILE = join(dir, "cache.json");
    resetLinkedInAdsReadCache();
    const first = await load();
    await new Promise((r) => setTimeout(r, 700));
    resetLinkedInAdsReadCache();
    fetchMock.mockReset();
    expect(await load()).toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses a member before asking LinkedIn", async () => {
  m.role.mockImplementation(async (_a: unknown, _r: unknown, out: Response) => { out.status(403).json({ error: { code: "forbidden" } }); return false; });
  const r = res();
  await adsAvailableAccounts(req(), r);
  expect(r.status).toHaveBeenCalledWith(403);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("the list the founder picks from leaves out accounts LinkedIn closed", async () => {
  fetchMock.mockResolvedValue(page([OLD, { ...INVITED, status: "CANCELED" }]));
  const r = res();
  await adsAvailableAccounts(req(), r);
  expect(body(r).accounts.map((a) => a.id)).toEqual(["501"]);
});

it.each([
  ["below Pro", () => m.tier.mockResolvedValue({ allowed: false, enforced: true })],
  ["with the tier gate unread", () => m.tier.mockResolvedValue({ allowed: true, enforced: false })],
  ["under Coming soon", () => m.lock.mockResolvedValue(true)],
  ["in staff view", () => {
    m.auth.mockResolvedValue({ tenant_id: "verified", user_id: "staff", tenant_overridden: true });
    m.role.mockImplementation(async (_a: unknown, _r: unknown, out: Response) => (out.status(403).json({ error: { code: "forbidden" } }), false));
  }],
])("lists and refreshes the connected ad accounts %s, because reading them changes nothing", async (_label, arrange) => {
  arrange();
  const listed = await load();
  expect(listed.accounts.map((a) => a.id)).toEqual(["501", "777"]);
  const refreshed = await load(refresh());
  expect(refreshed.accounts.map((a) => a.id)).toEqual(["501", "777"]);
});
