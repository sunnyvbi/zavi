import { beforeEach, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const m = vi.hoisted(() => ({
  lifecycle: {} as Record<string, unknown>,
  operation: null as null | { id: string; created_at: string },
  holds: new Map<string, string>(),
  status: "ACTIVE",
  campaignGone: false,
  readFailures: [] as Array<"404" | "500">,
  posts: 0,
  beforeCampaignRead: [] as Array<() => Promise<void>>,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  wallet: { available_cents: 10000 },
  goneMarkers: [] as Array<Record<string, unknown>>,
  seen404: [] as Array<Record<string, unknown>>,
}));

vi.mock("../bindings", () => ({
  getCampaignBinding: async () => ({
    id: "bound",
    tenant_id: "t",
    platform: "linkedin",
    provider_campaign_id: "123",
    account_binding_id: "account",
    funding_source: "wallet",
  }),
  getAccountBinding: async () => ({ id: "account" }),
}));
vi.mock("../adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({ token: "fixture-token", account: { id: "42", currency: "USD" } }),
}));
vi.mock("../wallet", () => ({ readWallet: async () => m.wallet }));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({
  linkedinAdsGet: async (_token: string, path: string) => {
    if (path === "adAnalytics") return { elements: [] };
    const seen = m.status;
    const gate = m.beforeCampaignRead.shift();
    if (gate) await gate();
    const fail = m.readFailures.shift();
    if (fail === "500") throw new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads could not answer that request.", { status: 500, http_status: 500 });
    if (fail === "404" || m.campaignGone) throw new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads could not answer that request.", { status: 404, http_status: 404 });
    return {
      id: 123,
      account: "urn:li:sponsoredAccount:42",
      name: "Live campaign",
      status: seen,
      campaignGroup: "urn:li:sponsoredCampaignGroup:7",
      totalBudget: { amount: "100.00", currencyCode: "USD" },
      runSchedule: { start: 1, end: Date.now() + 10 * 86400_000 },
      changeAuditStamps: { created: { time: Date.now() - 1000 }, lastModified: { time: Date.now() - 1000 } },
    };
  },
  linkedinAdsPost: async () => {
    m.posts++;
    m.status = "PAUSED";
    return { id: null };
  },
}));
vi.mock("@/services/decisions/ad-budget", () => ({
  adBudgetIdemKey: (id: string, op: string) => `${id}:${op}`,
  commitAdSpend: async (hold: { idem_key: string }) => {
    if (m.holds.get(hold.idem_key) === "reserved") m.holds.set(hold.idem_key, "committed");
  },
  committedAdHoldIds: async () => [...m.holds].filter(([, s]) => s === "committed").map(([k]) => k),
  releaseAdSpendHolds: async (_t: string, _p: string, _o: string, ids: string[]) => {
    for (const id of ids) if (m.holds.get(id) === "committed") m.holds.set(id, "released");
  },
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: async (_t: string, fn: string, args: Record<string, unknown>) => {
    m.rpcs.push({ fn, args });
    return { data: fn === "ads_observe_linkedin_spend" ? false : null, error: null };
  },
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let write: null | "update" | "upsert" | "insert" | "delete" = null;
      let values: Record<string, unknown> = {};
      const run = async () => {
        await Promise.resolve();
        if (table === "ads_campaign_operations") {
          if (filters.kind === "pause") {
            if (write === "delete") m.seen404 = [];
            return { data: m.seen404, error: null };
          }
          if (write === "insert" && values.kind === "pause") {
            m.seen404.push({ ...values, created_at: new Date().toISOString() });
            return { data: null, error: null };
          }
          if (write === "insert") {
            m.goneMarkers.push({ ...values, created_at: new Date().toISOString() });
            return { data: null, error: null };
          }
          if (filters.kind === "finalize") return { data: m.goneMarkers, error: null };
          if (write === "update") {
            if (m.operation) m.operation = null;
            return { data: null, error: null };
          }
          return { data: m.operation, error: null };
        }
        if (table === "ads_campaign_reservations") return { data: { reserved_cents: 10000, spent_cents: 0 }, error: null };
        if (table !== "ads_campaign_lifecycle") return { data: null, error: null };
        if (write === "upsert") {
          Object.assign(m.lifecycle, values);
          return { data: null, error: null };
        }
        if (write === "update") {
          if ("stop_requested_at" in filters && m.lifecycle.stop_requested_at !== filters.stop_requested_at) return { data: [], error: null };
          Object.assign(m.lifecycle, values);
          return { data: [{ campaign_binding_id: "bound" }], error: null };
        }
        return { data: { ...m.lifecycle }, error: null };
      };
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => ((filters[col] = v), q),
        in: () => q,
        order: () => q,
        insert: (v: Record<string, unknown>) => ((write = "insert"), (values = v), q),
        delete: () => ((write = "delete"), q),
        upsert: (v: Record<string, unknown>) => ((write = "upsert"), (values = v), q),
        update: (v: Record<string, unknown>) => ((write = "update"), (values = v), q),
        maybeSingle: run,
        then: (ok: any, bad: any) => run().then(ok, bad),
      };
      return q;
    },
  }),
}));

import {
  LINKEDIN_PAUSE_SUPERSEDED,
  pauseLinkedinBoundCampaign,
  reconcileLinkedinOperation,
  requestLinkedinPause,
  settleLinkedinBoundCampaign,
} from "../adapters/linkedin";

beforeEach(() => {
  m.lifecycle = { stop_requested_at: null, stop_confirmed_at: null };
  m.operation = null;
  m.holds = new Map();
  m.status = "ACTIVE";
  m.campaignGone = false;
  m.goneMarkers = [];
  m.seen404 = [];
  m.readFailures = [];
  m.posts = 0;
  m.beforeCampaignRead = [];
  m.rpcs = [];
  m.wallet = { available_cents: 10000 };
});

const stuckLaunch = () => {
  m.operation = { id: "op-1", created_at: new Date(Date.now() - 11 * 60_000).toISOString() };
  m.holds.set("op-1:resume", "reserved");
};

it("a stuck launch the worker pauses gets its monthly budget hold released by that pause, not committed as if it launched", async () => {
  stuckLaunch();
  await reconcileLinkedinOperation("t", "bound");
  expect(m.posts).toBe(1);
  expect(m.status).toBe("PAUSED");
  expect(m.lifecycle.stop_confirmed_at).toEqual(expect.any(String));
  expect(m.holds.get("op-1:resume")).toBe("released");
  expect(m.operation).toBeNull();
});

it("the settle tick that reconciles a stuck launch leaves no committed hold behind on the paused campaign", async () => {
  stuckLaunch();
  await settleLinkedinBoundCampaign("t", "bound");
  expect(m.status).toBe("PAUSED");
  expect([...m.holds.values()]).toEqual(["released"]);
  expect(m.rpcs.map((r) => r.fn)).toContain("ads_wallet_settle_bound");
});

it("a stuck launch whose pause cannot be confirmed keeps its hold counted, never released", async () => {
  stuckLaunch();
  m.campaignGone = false;
  m.readFailures = [];
  const failing = new Error("LinkedIn 503");
  m.beforeCampaignRead.push(async () => {
    throw failing;
  });
  await expect(reconcileLinkedinOperation("t", "bound")).rejects.toBe(failing);
  expect(m.holds.get("op-1:resume")).toBe("committed");
  expect(m.operation).not.toBeNull();
});

it("two pausers at once: the one whose claim was overtaken reports the campaign paused, never that Zavi left it running", async () => {
  m.holds.set("launch:resume", "committed");
  let releaseFirst!: () => void;
  const firstRead = new Promise<void>((r) => (releaseFirst = r));
  m.beforeCampaignRead.push(() => firstRead);
  const first = requestLinkedinPause("t", "bound");
  await vi.waitFor(() => expect(m.lifecycle.stop_requested_at).toEqual(expect.any(String)));
  const firstIntent = m.lifecycle.stop_requested_at;
  await new Promise((r) => setTimeout(r, 2));
  const second = requestLinkedinPause("t", "bound");
  await vi.waitFor(() => expect(m.lifecycle.stop_requested_at).not.toBe(firstIntent));
  releaseFirst();
  const results = await Promise.allSettled([first, second]);
  for (const r of results) {
    expect(r.status).toBe("fulfilled");
    if (r.status === "fulfilled") expect(["paused", "already_paused"]).toContain(r.value);
  }
  expect(JSON.stringify(results)).not.toContain(LINKEDIN_PAUSE_SUPERSEDED);
  expect(m.status).toBe("PAUSED");
  expect(m.lifecycle.stop_confirmed_at).toEqual(expect.any(String));
  expect(m.holds.get("launch:resume")).toBe("released");
});

it("a pause overtaken by a relaunch that cleared the stop still reports that Zavi left it running", async () => {
  m.beforeCampaignRead.push(async () => {
    m.lifecycle.stop_requested_at = null;
  });
  await expect(requestLinkedinPause("t", "bound")).rejects.toMatchObject({ code: "ads_pause_superseded", message: LINKEDIN_PAUSE_SUPERSEDED });
  expect(m.posts).toBe(0);
});

it("a pause that keeps being overtaken gives up with the queued answer, not a false 'left it running'", async () => {
  for (let i = 0; i < 3; i++)
    m.beforeCampaignRead.push(async () => {
      m.lifecycle.stop_requested_at = new Date(Date.now() + 60_000 * (i + 1)).toISOString();
    });
  await expect(requestLinkedinPause("t", "bound")).rejects.toMatchObject({ code: "ads_pause_queued" });
});

it.each(["PENDING_DELETION", "REMOVED"])("a %s campaign is reported as ended, with no PAUSED write sent to LinkedIn", async (status) => {
  m.status = status;
  expect(await pauseLinkedinBoundCampaign("t", "bound")).toBe("ended");
  expect(m.posts).toBe(0);
});

it("a single transient 404 on the pause read is not reported as ended: the confirming read finds the campaign running and it is paused", async () => {
  m.readFailures = ["404"];
  m.holds.set("old:resume", "committed");
  expect(await pauseLinkedinBoundCampaign("t", "bound")).toBe("paused");
  expect(m.posts).toBe(1);
  expect(m.status).toBe("PAUSED");
  expect(m.lifecycle.stop_confirmed_at).toEqual(expect.any(String));
  expect(m.holds.get("old:resume")).toBe("released");
});

it("a 404 followed by an unreadable confirming read is unknown, never ended, and nothing is written", async () => {
  m.readFailures = ["404", "500"];
  m.holds.set("old:resume", "committed");
  await expect(pauseLinkedinBoundCampaign("t", "bound")).rejects.toMatchObject({ meta: { status: 500 } });
  expect(m.posts).toBe(0);
  expect(m.holds.get("old:resume")).toBe("committed");
  expect(m.lifecycle.stop_confirmed_at ?? null).toBeNull();
});

it("a first 404 is not ended: nothing is written but the time it was seen, and the error says Zavi is checking", async () => {
  m.campaignGone = true;
  m.lifecycle.stop_requested_at = new Date().toISOString();
  m.holds.set("old:resume", "committed");
  await expect(pauseLinkedinBoundCampaign("t", "bound", false)).rejects.toMatchObject({ code: "ads_pause_queued", meta: { checking: true } });
  expect(m.lifecycle.stop_confirmed_at ?? null).toBeNull();
  expect(m.holds.get("old:resume")).toBe("committed");
  expect(m.goneMarkers).toEqual([]);
  expect(m.seen404).toEqual([expect.objectContaining({ kind: "pause", status: "refused", payload: { reason: "provider_404_seen" } })]);
});

it("a campaign LinkedIn no longer has (404 five minutes after the first) is reported as ended, with a receipt and a gone record, and its holds stay until the settle or the 72 hour re-read", async () => {
  m.campaignGone = true;
  m.lifecycle.stop_requested_at = new Date().toISOString();
  m.holds.set("old:resume", "committed");
  m.seen404 = [{ created_at: new Date(Date.now() - 5 * 60_000 - 1000).toISOString() }];
  expect(await pauseLinkedinBoundCampaign("t", "bound")).toBe("ended");
  expect(m.posts).toBe(0);
  expect(m.lifecycle.stop_confirmed_at).toEqual(expect.any(String));
  expect(m.holds.get("old:resume")).toBe("committed");
  expect(m.goneMarkers).toEqual([expect.objectContaining({ kind: "finalize", status: "succeeded", payload: { reason: "provider_gone" } })]);
});
