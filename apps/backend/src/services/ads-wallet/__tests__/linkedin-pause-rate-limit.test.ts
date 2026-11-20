import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  lifecycle: {} as Record<string, unknown>,
  status: "ACTIVE",
  calls: [] as string[],
  dayLimited: new Set<string>(),
  postDayLimited: false,
  postBusy: false,
  failClaim: false,
  reads: 0,
  limitReadsAfter: Infinity,
  funding: "wallet",
}));

vi.mock("../bindings", () => ({
  getCampaignBinding: async () => ({
    id: "bound",
    tenant_id: "t",
    platform: "linkedin",
    provider_campaign_id: "123",
    account_binding_id: "account",
    funding_source: m.funding,
  }),
  getAccountBinding: async () => ({
    id: "account",
    tenant_id: "t",
    account_id: "canonical",
    platform: "linkedin",
    provider_account_id: "42",
    currency: "USD",
    verified_at: "now",
    credential_source: "platform",
    credential_ref: "linkedin_ads_managed_account1",
    credential_tenant_id: null,
    funding_source: "wallet",
    legacy_key: null,
  }),
  verifyAccountBinding: async () => undefined,
}));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  withLinkedInAdsToken: async () => {
    throw new Error("managed bindings never use the tenant connector");
  },
}));
vi.mock("../wallet", () => ({ readWallet: async () => ({ available_cents: 10000 }) }));
vi.mock("@/services/decisions/ad-budget", () => ({
  adBudgetIdemKey: (id: string, op: string) => `${id}:${op}`,
  commitAdSpend: async () => undefined,
  committedAdHoldIds: async () => [],
  releaseAdSpendHolds: async () => undefined,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  platformSecretRpc: async () => ({ data: "managed-token", error: null }),
  tenantRpc: async () => ({ data: null, error: null }),
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let write: null | "update" | "upsert" = null;
      let values: Record<string, unknown> = {};
      const run = async () => {
        if (table !== "ads_campaign_lifecycle") return { data: null, error: null };
        if (write === "upsert") return (Object.assign(m.lifecycle, values), { data: null, error: null });
        if (write === "update") {
          if (m.failClaim) return { data: [], error: null };
          if ("stop_requested_at" in filters && m.lifecycle.stop_requested_at !== filters.stop_requested_at) return { data: [], error: null };
          Object.assign(m.lifecycle, values);
          return { data: [{ campaign_binding_id: "bound" }], error: null };
        }
        return { data: { ...m.lifecycle }, error: null };
      };
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => ((filters[c] = v), q),
        in: () => q,
        upsert: (v: Record<string, unknown>) => ((write = "upsert"), (values = v), q),
        update: (v: Record<string, unknown>) => ((write = "update"), (values = v), q),
        maybeSingle: run,
        then: (ok: any, bad: any) => run().then(ok, bad),
      };
      return q;
    },
  }),
}));

import { linkedinAdsGet, LINKEDIN_ADS_DAILY_LIMIT, LINKEDIN_ADS_BUSY } from "@/services/connectors/linkedin-ads/http";
import { resetLinkedInAdsReadCache } from "@/services/connectors/linkedin-ads/read-cache";
import { LINKEDIN_PAUSE_DAILY_LIMIT, LINKEDIN_PAUSE_DAILY_LIMIT_WALLET, LINKEDIN_PAUSE_QUEUED, LINKEDIN_PAUSE_UNCONFIRMED, LINKEDIN_PAUSE_UNCONFIRMED_WALLET, pauseLinkedinBoundCampaign, requestLinkedinPause } from "../adapters/linkedin";

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
const limited = (message: string, headers: Record<string, string> = {}) => ({
  ok: false,
  status: 429,
  headers: new Headers(headers),
  json: async () => ({ message }),
  text: async () => JSON.stringify({ message }),
});

beforeEach(() => {
  resetLinkedInAdsReadCache();
  m.lifecycle = { stop_requested_at: null, stop_confirmed_at: null };
  m.status = "ACTIVE";
  m.calls = [];
  m.dayLimited = new Set();
  m.postDayLimited = false;
  m.postBusy = false;
  m.failClaim = false;
  m.reads = 0;
  m.limitReadsAfter = Infinity;
  m.funding = "wallet";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (href: string, init?: { method?: string }) => {
      const url = new URL(href);
      const where = url.pathname.replace(/^\/rest\//, "");
      m.calls.push(`${init?.method ?? "GET"} ${where}`);
      if (init?.method === "POST") {
        if (m.postDayLimited) return limited("Resource level throttle APPLICATION DAY limit for calls to this resource is reached.");
        if (m.postBusy) return limited("Too many requests");
        m.status = "PAUSED";
        return { ok: true, status: 204, headers: new Headers(), json: async () => ({}), text: async () => "" };
      }
      m.reads += 1;
      if (m.reads > m.limitReadsAfter) return limited("Resource level throttle APPLICATION DAY limit for calls to this resource is reached.");
      if (m.dayLimited.has(where)) return limited("Resource level throttle APPLICATION DAY limit for calls to this resource is reached.");
      if (where === "adAccountUsers") return ok({ elements: [{ account: "urn:li:sponsoredAccount:42", role: "CAMPAIGN_MANAGER" }] });
      if (where === "adAccounts/42") return ok({ id: 42, currency: "USD", status: "ACTIVE" });
      if (where === "adAccounts/42/adCampaigns/123")
        return ok({
          id: 123,
          account: "urn:li:sponsoredAccount:42",
          name: "Live campaign",
          status: m.status,
          campaignGroup: "urn:li:sponsoredCampaignGroup:7",
          totalBudget: { amount: "100.00", currencyCode: "USD" },
          runSchedule: { start: 1, end: Date.now() + 10 * 86400_000 },
          changeAuditStamps: { created: { time: 1 }, lastModified: { time: 1 } },
        });
      throw new Error(`unrouted ${where}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("a LinkedIn day-limit block on the account-role read does not stop a pause: the role read rides the pause-critical lane", async () => {
  m.dayLimited.add("adAccountUsers");
  await expect(linkedinAdsGet("managed-token", "adAccountUsers", { q: "authenticatedUser", count: 1000 }, {}, { fresh: true })).rejects.toMatchObject({
    message: LINKEDIN_ADS_DAILY_LIMIT,
  });
  m.dayLimited.clear();
  await expect(linkedinAdsGet("managed-token", "adAccountUsers", { q: "authenticatedUser", count: 1000 }, {}, { fresh: true })).rejects.toMatchObject({
    message: LINKEDIN_ADS_DAILY_LIMIT,
  });
  m.calls = [];
  expect(await requestLinkedinPause("t", "bound")).toBe("paused");
  expect(m.status).toBe("PAUSED");
  expect(m.calls).toContain("GET adAccountUsers");
  expect(m.calls).toContain("POST adAccounts/42/adCampaigns/123");
  expect(m.lifecycle.stop_confirmed_at).toEqual(expect.any(String));
});

it("a token in a 429 cool-down on every ordinary read still pauses through account, role and campaign reads", async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => limited("Too many requests", { "retry-after": "3600" }) as never);
  await expect(linkedinAdsGet("managed-token", "adAccounts/42", {}, {}, { fresh: true })).rejects.toMatchObject({ message: LINKEDIN_ADS_BUSY });
  await expect(linkedinAdsGet("managed-token", "adAccountUsers", { q: "authenticatedUser", count: 1000 })).rejects.toMatchObject({ message: LINKEDIN_ADS_BUSY });
  m.calls = [];
  expect(await requestLinkedinPause("t", "bound")).toBe("paused");
  expect(m.calls).toEqual([
    "GET adAccounts/42",
    "GET adAccountUsers",
    "GET adAccounts/42/adCampaigns/123",
    "POST adAccounts/42/adCampaigns/123",
    "GET adAccounts/42",
    "GET adAccounts/42/adCampaigns/123",
  ]);
});

it("the pause reads the role fresh even when a stale 'manager' answer is cached", async () => {
  await linkedinAdsGet("managed-token", "adAccountUsers", { q: "authenticatedUser", count: 1000 });
  m.calls = [];
  expect(await requestLinkedinPause("t", "bound")).toBe("paused");
  expect(m.calls.filter((c) => c === "GET adAccountUsers")).toHaveLength(1);
});

const dayLimitAllReads = () => {
  m.limitReadsAfter = 0;
};

it("LinkedIn itself refuses every pause read for the day: the pause is still sent, and the words say what is known", async () => {
  dayLimitAllReads();
  const e = await requestLinkedinPause("t", "bound").catch((x) => x);
  expect(e).toMatchObject({ code: "ads_pause_queued", message: LINKEDIN_PAUSE_UNCONFIRMED_WALLET, meta: { accepted: true } });
  expect(m.calls).toContain("POST adAccounts/42/adCampaigns/123");
  expect(m.status).toBe("PAUSED");
  expect(e.message).not.toContain("few minutes");
  expect(m.lifecycle.stop_confirmed_at).toBeNull();
});

it("a day limit on the campaign read alone still sends the pause with the bound ids", async () => {
  m.dayLimited.add("adAccounts/42/adCampaigns/123");
  await expect(requestLinkedinPause("t", "bound")).rejects.toMatchObject({ meta: { accepted: true } });
  expect(m.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST adAccounts/42/adCampaigns/123"]);
});

it("the same pause settles as soon as LinkedIn answers again: the hold is confirmed, not left open", async () => {
  dayLimitAllReads();
  await requestLinkedinPause("t", "bound").catch(() => undefined);
  m.limitReadsAfter = Infinity;
  resetLinkedInAdsReadCache();
  expect(await pauseLinkedinBoundCampaign("t", "bound", false)).toBe("already_paused");
  expect(m.lifecycle.stop_confirmed_at).toEqual(expect.any(String));
});

it("a day limit on the pause write itself says the campaign can keep spending until 00:00 UTC, never a few minutes", async () => {
  m.postDayLimited = true;
  const e = await requestLinkedinPause("t", "bound").catch((x) => x);
  expect(e.code).toBe("ads_pause_queued");
  expect(e.message).toBe(LINKEDIN_PAUSE_DAILY_LIMIT_WALLET);
  expect(e.message).toContain("can keep spending until the limit resets at 00:00 UTC");
  expect(e.message).not.toContain("Campaign Manager");
  expect(e.message).not.toContain("few minutes");
  expect(m.lifecycle.stop_confirmed_at).toBeNull();
});

it("a campaign billed to the founder's own LinkedIn account is told to stop it in Campaign Manager; a shared-wallet one never is", async () => {
  m.postDayLimited = true;
  m.funding = "provider";
  const own = await requestLinkedinPause("t", "bound").catch((x) => x);
  expect(own.message).toBe(LINKEDIN_PAUSE_DAILY_LIMIT);
  expect(own.message).toContain("pause it in LinkedIn Campaign Manager");
  m.postDayLimited = false;
  dayLimitAllReads();
  resetLinkedInAdsReadCache();
  const unread = await requestLinkedinPause("t", "bound").catch((x) => x);
  expect(unread.message).toBe(LINKEDIN_PAUSE_UNCONFIRMED);
  m.funding = "wallet";
  m.status = "ACTIVE";
  resetLinkedInAdsReadCache();
  const wallet = await requestLinkedinPause("t", "bound").catch((x) => x);
  expect(wallet.message).toBe(LINKEDIN_PAUSE_UNCONFIRMED_WALLET);
  expect(wallet.message).not.toContain("Campaign Manager");
});
it("a day limit on both the reads and the write says the same, on the worker's door too", async () => {
  dayLimitAllReads();
  m.postDayLimited = true;
  await expect(pauseLinkedinBoundCampaign("t", "bound")).rejects.toMatchObject({ message: LINKEDIN_PAUSE_DAILY_LIMIT_WALLET, meta: { daily_limit: true } });
  expect(m.status).toBe("ACTIVE");
});

it("a pause write accepted with only the confirming read limited is reported as unconfirmed, not as paused", async () => {
  m.limitReadsAfter = 3;
  await expect(requestLinkedinPause("t", "bound")).rejects.toMatchObject({ message: LINKEDIN_PAUSE_UNCONFIRMED_WALLET });
  expect(m.status).toBe("PAUSED");
  expect(m.lifecycle.stop_confirmed_at).toBeNull();
});

it("a relaunch that took the claim keeps the unread pause from being sent", async () => {
  dayLimitAllReads();
  m.failClaim = true;
  await expect(requestLinkedinPause("t", "bound")).rejects.toMatchObject({ code: "ads_pause_queued", message: LINKEDIN_PAUSE_QUEUED });
  expect(m.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
});

it("an ordinary short 429 on the write stays the few-minutes wait, because that one is true", async () => {
  m.postBusy = true;
  await expect(requestLinkedinPause("t", "bound")).rejects.toMatchObject({ code: "ads_pause_queued", message: LINKEDIN_PAUSE_QUEUED });
});
