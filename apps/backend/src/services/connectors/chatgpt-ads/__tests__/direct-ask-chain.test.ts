import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "acme";
const ACTION = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

const m = vi.hoisted(() => ({
  reserve: vi.fn(),
  commit: vi.fn(),
  drop: vi.fn(),
  release: vi.fn(),
  walletReserve: vi.fn(),
  walletHeld: false,
  bindings: new Map<string, Record<string, unknown>>(),
  envelope: null as unknown,
}));

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => true }));
vi.mock("@/services/ads-wallet/fx", () => ({ adsFx: async (currency: string) => ({ currency, units_per_usd: 1, as_of: "2026-10-17T00:00:00Z", source: "test" }), adsUsd: (v: number) => Math.round(v * 100) / 100, adsLocalMicros: (v: number) => Math.round(v * 1e6) }));
vi.mock("../key-provider", () => ({ getChatgptAdsApiKey: async () => "platform-key" }));
vi.mock("../tenant-scope", async (original) => ({ ...(await original<typeof import("../tenant-scope")>()), resolveTenantCampaignPrefix: async () => "zv-acme--" }));
vi.mock("../serving", () => ({ assertServingReady: async () => {} }));
vi.mock("../generated-image", () => ({ checkGeneratedAdImage: async () => {}, signGeneratedAdImage: async () => "https://signed.example/img.png", generatedAdImagePath: async () => "x" }));
vi.mock("../creative-upload", async () => {
  const { chatgptAdsPost } = await import("../http");
  return { stableCreativeUpload: async (_t: string, _k: string, _v: unknown, key: string, url: string) => chatgptAdsPost<{ file_id: string }>(key, "/upload", { image_url: url }) };
});
vi.mock("../growth-workspace-budget", async (original) => ({ ...(await original<typeof import("../growth-workspace-budget")>()), withWorkspaceGrowthBudget: async (_t: string, _p: unknown, _n: unknown, _o: string, write: () => Promise<unknown>) => write() }));
vi.mock("@/services/channels/chatgpt-ads/wallet", () => ({ fundingEnabled: () => true, reserveCampaign: m.walletReserve, reserveIfFunded: vi.fn() }));
vi.mock("@/services/channels/chatgpt-ads/funding-context", () => ({ readChatgptFundingContext: async () => ({ status: "read", available_cents: 100_000, currency: "USD" }) }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true }), planUpgradeMessage: () => "" }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: async () => false }));
vi.mock("@/services/decisions/ad-changes", () => ({ recordZaviAdChange: vi.fn() }));
vi.mock("@/services/decisions/ad-budget", async (original) => ({
  ...(await original<typeof import("@/services/decisions/ad-budget")>()),
  reserveAdSpend: m.reserve,
  commitAdSpend: m.commit,
  dropAdSpendHold: m.drop,
  noteAdSpendObject: vi.fn(),
  noteAdSpendRef: async () => null,
  releaseAdSpendForObject: m.release,
}));
const ACCOUNT = { id: "acct-binding", tenant_id: TENANT, platform: "chatgpt", account_id: "acct_1", provider_account_id: "acct_1", currency: "USD", credential_source: "platform", credential_ref: "chatgpt_ads_api_key", credential_tenant_id: null, funding_source: "wallet" };
vi.mock("@/services/ads-wallet/bindings", () => ({
  claimCampaignAccount: async () => ACCOUNT,
  getAccountBinding: async () => ACCOUNT,
  legacyChatgptAccount: async () => ACCOUNT,
  verifyAccountBinding: async () => {},
  getCampaignBinding: async (_t: string, id: string) => m.bindings.get(id),
  findCampaignBinding: async (_t: string, _p: string, campaignId: string) => [...m.bindings.values()].find((b) => b.provider_campaign_id === campaignId) ?? null,
  bindCampaign: async (_t: string, _a: unknown, campaignId: string) => {
    const existing = [...m.bindings.values()].find((b) => b.provider_campaign_id === campaignId);
    if (existing) return existing;
    const b = { id: `33333333-3333-4333-8333-00000000000${m.bindings.size}`, tenant_id: TENANT, platform: "chatgpt", account_binding_id: ACCOUNT.id, account_id: "acct_1", provider_campaign_id: campaignId, funding_source: "wallet" };
    m.bindings.set(b.id, b);
    return b;
  },
}));
vi.mock("@/services/ads-wallet/accounts", () => ({ assertAccountAvailableForNewCampaign: async () => {} }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: vi.fn(),
  tenantClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => table === "ads_campaign_funding"
        ? { data: { reserved_cents: m.walletHeld ? 2500 : 0, spent_cents: 0, daily_max_micros: null, coverage_start: null, coverage_end: null }, error: null }
        : { data: { approval_envelope: m.envelope, proposed_at: new Date().toISOString() }, error: null };
      return q;
    },
  }),
}));

import { shapeChatgptBundle, dispatchReadyBody } from "@/services/tools/chatgpt-ads/propose";
import { executeChatgptGrowthAction } from "../growth-execution";
import { ExpectedToolError } from "@/services/tools/types";
import { launchCampaign, launchSnapshot, launchTiming } from "../launch";
import { readCampaignTree } from "../workspace";
import { CHATGPT_CREATE } from "../growth-actions";
import { buildEnvelope } from "@/services/approvals/approval-envelope";
import { tellDirectAskOutcome } from "@/services/approvals/direct-ask-outcome";
import { classifyExecFailure } from "@/services/channels/exec-failure";
import { runChannelActionMutation, settleChannelActionOutcome } from "../../../../../workers/functions/dispatch-channel-action";
import { withBoundCampaign } from "@/services/ads-wallet/campaign-context";
import type { AdPlan } from "@/services/growth/ad-plan-shape";

type Row = Record<string, any>;
type FailStep = "create_group" | "save_ad" | "activate_campaign" | "activate_group" | "activate_ad" | "readback" | null;
class FakeAds {
  campaigns = new Map<string, Row>();
  groups = new Map<string, Row>();
  ads = new Map<string, Row>();
  idem = new Map<string, Row>();
  seq = 0;
  failAt: FailStep = null;
  archiveFails = false;
  archiveEchoOnly = false;
  archiveResponseLost = false;
  reviewStaysPending = true;
  listsLag = false;
  pointLag = 0;
  statusLag = 0;
  reviewAtCreate = "pending_review";
  pointReads = 0;
  pointErrors = 0;
  onRequest: (() => void) | null = null;
  bump(c: Row) { c.updated_at += 1; }
  ok(body: unknown) { return new Response(JSON.stringify(body), { status: 200 }); }
  err(status = 500) { return new Response(JSON.stringify({ error: { message: "upstream" } }), { status }); }
  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    this.onRequest?.();
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v\d+/, "").replace(/^\/ads\/v\d+/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const key = (init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"];
    if (key && this.idem.has(key)) return this.ok(this.idem.get(key));
    const remember = (row: Row) => { if (key) this.idem.set(key, row); return this.ok(row); };
    const seg = path.split("/").filter(Boolean).slice(-2);
    if (method === "GET" && path.endsWith("/ad_account")) return this.ok({ id: "acct_1", currency_code: "USD", timezone: "UTC" });
    if (method === "POST" && path.endsWith("/upload")) return this.ok({ file_id: `file_${++this.seq}` });
    if (method === "POST" && path.endsWith("/campaigns")) {
      const id = `cmpn_${++this.seq}`;
      const c = { ...body, id, object: "campaign", status: "paused", updated_at: 1000, created_at: Math.floor(Date.now() / 1000) };
      this.campaigns.set(id, c);
      return remember(structuredClone(c));
    }
    if (seg[0] === "campaigns" && seg[1]?.startsWith("cmpn_")) {
      const c = this.campaigns.get(seg[1]);
      if (!c) return this.err(404);
      if (method === "GET") {
        this.bump(c);
        if (c.status === "active" && this.statusLag > 0) { this.statusLag--; return this.ok({ ...structuredClone(c), status: "paused" }); }
        if (this.failAt === "readback" && c.status === "active") return this.ok({ ...structuredClone(c), status: "paused" });
        return this.ok(structuredClone(c));
      }
      if (body.status === "active" && this.failAt === "activate_campaign") return this.err(500);
      if (body.status === "archived" && this.archiveFails) return this.err(500);
      if (body.status === "archived" && this.archiveResponseLost) { c.status = "archived"; this.bump(c); return this.err(504); }
      if (body.status === "archived" && this.archiveEchoOnly) return this.ok({ ...structuredClone(c), status: "archived" });
      Object.assign(c, body.status ? { status: body.status } : {});
      this.bump(c);
      return this.ok(structuredClone(c));
    }
    if (method === "POST" && path.endsWith("/ad_groups")) {
      if (this.failAt === "create_group") return this.err(500);
      const id = `adgrp_${++this.seq}`;
      const g = { ...body, id, status: "paused" };
      this.groups.set(id, g);
      this.bump(this.campaigns.get(body.campaign_id)!);
      return remember(structuredClone(g));
    }
    if (method === "GET" && (seg[0] === "ad_groups" || seg[0] === "ads") && seg[1] && !seg[1].startsWith("v")) {
      this.pointReads++;
      if (this.pointErrors > 0) { this.pointErrors--; return this.err(503); }
      if (this.pointLag > 0) { this.pointLag--; return this.err(404); }
      const row = (seg[0] === "ad_groups" ? this.groups : this.ads).get(seg[1]);
      if (!row) return this.err(404);
      if (seg[0] === "ads" && !this.reviewStaysPending && row.review_status !== "rejected") row.review_status = "approved";
      return this.ok(structuredClone(row));
    }
    if (method === "GET" && path.endsWith("/ad_groups")) {
      if (this.listsLag) return this.ok({ data: [], has_more: false });
      return this.ok({ data: [...this.groups.values()].filter((g) => g.campaign_id === url.searchParams.get("campaign_id")).map((g) => structuredClone(g)), has_more: false });
    }
    if (seg[0] === "ad_groups" && method === "POST") {
      if (this.failAt === "activate_group") return this.err(500);
      const g = this.groups.get(seg[1])!;
      g.status = body.status;
      this.bump(this.campaigns.get(g.campaign_id)!);
      return this.ok(structuredClone(g));
    }
    if (method === "POST" && path.endsWith("/ads")) {
      if (this.failAt === "save_ad") return this.err(500);
      const id = `ad_${++this.seq}`;
      const g = this.groups.get(body.ad_group_id)!;
      const a = { ...body, id, campaign_id: g.campaign_id, status: "paused", review_status: this.reviewAtCreate };
      this.ads.set(id, a);
      this.bump(this.campaigns.get(g.campaign_id)!);
      return remember(structuredClone(a));
    }
    if (method === "GET" && path.endsWith("/ads")) {
      if (this.listsLag) return this.ok({ data: [], has_more: false });
      const rows = [...this.ads.values()].filter((a) => a.ad_group_id === url.searchParams.get("ad_group_id"));
      if (!this.reviewStaysPending) for (const a of rows) a.review_status = "approved";
      return this.ok({ data: rows.map((a) => structuredClone(a)), has_more: false });
    }
    if (seg[0] === "ads" && method === "POST") {
      if (this.failAt === "activate_ad") return this.err(500);
      const a = this.ads.get(seg[1])!;
      a.status = body.status;
      this.bump(this.campaigns.get(a.campaign_id)!);
      return this.ok(structuredClone(a));
    }
    return this.err(404);
  }
}

let vendor: FakeAds;
const PLAN: AdPlan = { channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: 25, daily_usd: null, start: new Date().toISOString().slice(0, 10), end: "2099-01-01", days: 1, switched_from: null };

function filedBody() {
  const modelInput = {
    summary: "A one-day intent test",
    rationale: "The founder asked for a $25 one-day ChatGPT ad directly.",
    campaign: { name: "Founder ask", bidding_type: "clicks", daily_budget_micros: 900e6, start_time: 1, end_time: 2, targeting: { locations: { countries: ["US"] } } },
    group: { name: "Intent", context_hints: ["Compare rental cars"], strategy: "fixed_bid", max_bid_micros: 2_000_000 },
    ads: [{ name: "Intent ad", title: "Rent a car nearby", body: "Hosts near you, fair prices", target_url: "https://example.com/cars", image_url: "https://example.com/img.png" }],
  };
  const bundle = shapeChatgptBundle(modelInput, PLAN, Date.now());
  return dispatchReadyBody({ bundle, name: bundle.campaign.name, origin: "user_initiated_chat", currency: "USD", lifetime_budget_usd: 25 });
}

const decision = (body: Record<string, unknown>) => ({ id: ACTION, tenant_id: TENANT, decision_class: CHATGPT_CREATE, body, exec_source: "channel_actions", approved_by: OWNER, approved_by_source: null });

const posted: string[] = [];
const tell = (o: Parameters<typeof tellDirectAskOutcome>[0]) => {
  const claims = tellClaims;
  return tellDirectAskOutcome(o, {
    readAction: async () => ({ channel_slug: "chatgpt_ads", exec_class: CHATGPT_CREATE, approval_envelope: m.envelope }),
    readRun: async () => ({ id: "root-run", trigger: "chat", payload: { thread_id: "thread-1", user_message_id: "msg-1" }, agent_slug: "operator" }),
    claim: async (_t, key) => (claims.has(key) ? "taken" : (claims.add(key), "claimed")),
    release: async (_t, key) => claims.delete(key),
    done: async () => true,
    chat: async (_t, _thread, body) => { posted.push(body); return true; },
    waitForFilingRun: async () => {},
  });
};
let tellClaims = new Set<string>();

async function dispatch(body: Record<string, unknown>) {
  const deps = {
    claim: async () => ({ ok: true as const, row: { tenant_id: TENANT, agent_run_id: "child-run", channel_slug: "chatgpt_ads", exec_class: CHATGPT_CREATE, exec_payload: body, approved_by: OWNER, approved_by_source: null, claim_id: "claim-1" } }),
    settle: async () => ({ ok: true }),
    loadHandler: async () => (d: any) => executeChatgptGrowthAction(d),
    writeEnabled: async () => true,
    channelLock: async () => null,
    envelopeSwitchedOff: async () => false,
    tenantDisabled: async () => false,
    tellOutcome: tell,
  } as never;
  const mutation = await runChannelActionMutation(ACTION, deps);
  await settleChannelActionOutcome(ACTION, mutation, deps);
  return mutation;
}

let clock = 0;
beforeEach(() => {
  clock = Date.now();
  launchTiming.now = () => clock;
  launchTiming.sleep = async (ms: number) => { clock += ms; };
  vendor = new FakeAds();
  vi.stubGlobal("fetch", (u: string | URL, i?: RequestInit) => vendor.fetch(u, i));
  m.bindings.clear();
  m.reserve.mockReset().mockResolvedValue({ status: "held", hold_id: "hold-1", over_cap: false });
  m.commit.mockReset().mockResolvedValue(undefined);
  m.drop.mockReset().mockResolvedValue(undefined);
  m.release.mockReset().mockResolvedValue(true);
  m.walletHeld = false;
  m.walletReserve.mockReset().mockImplementation(async () => { m.walletHeld = true; });
  posted.length = 0;
  tellClaims = new Set();
  m.envelope = buildEnvelope({ envelope_id: "ask:root-run", tenant_id: TENANT, approver: { user_id: OWNER, role: "owner", surface: "chat" }, plan: { ...PLAN, end: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a founder's direct ask: '$25 ChatGPT ad for 1 day', the real chain", () => {
  it("launches despite version and review drift, capped at the ask, 24h, verified on readback, one founder line", async () => {
    const body = filedBody();
    const r = await dispatch(body);
    expect(r.outcome, JSON.stringify(r.settle)).toMatchObject({ ok: true });
    expect(vendor.campaigns.size).toBe(1);
    const c = [...vendor.campaigns.values()][0];
    expect(c.budget).toEqual({ lifetime_spend_limit_micros: 25_000_000 });
    expect(c.end_time - c.start_time).toBe(86_400);
    const tree = await withBoundCampaign([...m.bindings.values()][0] as never, () => readCampaignTree(TENANT, c.id));
    expect(tree.campaign.status).toBe("active");
    expect(tree.groups.every((g) => g.status === "active")).toBe(true);
    expect(tree.ads.every((a) => a.status === "active")).toBe(true);
    expect(m.commit).toHaveBeenCalled();
    expect(m.release).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Your ChatGPT ad is on");
    expect(posted[0]).toContain("at most $25.00 in total");
    expect(posted[0]).toMatch(/stops [A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2} UTC/);
    expect(posted[0]).toContain("once ChatGPT finishes reviewing the ad");
  });

  it("a replay of the same action makes no second campaign and tells no second line", async () => {
    const body = filedBody();
    await dispatch(body);
    await dispatch(body);
    expect(vendor.campaigns.size).toBe(1);
    expect(vendor.groups.size).toBe(1);
    expect(vendor.ads.size).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it("an approved review is reported as on with no review caveat", async () => {
    vendor.reviewStaysPending = false;
    await dispatch(filedBody());
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain("reviewing");
  });

  it.each(["create_group", "save_ad", "activate_campaign", "activate_group", "activate_ad", "readback"] as const)(
    "a failure at %s archives the campaign, releases the hold and tells the founder once",
    async (step) => {
      vendor.failAt = step;
      const r = await dispatch(filedBody());
      expect(r.outcome.ok).toBe(false);
      expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
      expect(classifyExecFailure(r.settle?.result)?.bucket).toBe("blocked_on_us");
      expect(vendor.campaigns.size).toBe(1);
      const c = [...vendor.campaigns.values()][0];
      expect(c.status).toBe("archived");
      const binding = [...m.bindings.values()][0] as { id: string };
      expect(m.release).toHaveBeenCalledWith(TENANT, "chatgpt", c.id === binding.id ? c.id : expect.any(String), { confirm: true });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("Your ChatGPT ad didn't finish setting up.");
      expect(posted[0]).toContain(`created ChatGPT campaign ${c.id}`);
      expect(posted[0]).toContain("archived");
      await settleChannelActionOutcome(ACTION, r, { settle: async () => ({ ok: true, replayed: true }), tellOutcome: tell } as never);
      expect(posted).toHaveLength(1);
    },
  );

  it("launches when the lists lag the create: the children are read by id", async () => {
    vendor.listsLag = true;
    const r = await dispatch(filedBody());
    expect(r.outcome, JSON.stringify(r.settle)).toMatchObject({ ok: true });
    const c = [...vendor.campaigns.values()][0];
    expect(c.status).toBe("active");
    expect([...vendor.groups.values()].every((g) => g.status === "active")).toBe(true);
    expect([...vendor.ads.values()].every((a) => a.status === "active")).toBe(true);
    expect(vendor.pointReads).toBeGreaterThan(0);
    expect(posted).toEqual([expect.stringContaining("Your ChatGPT ad is on")]);
  });

  it("waits out a short point-read lag and a stale status read, inside the deadline", async () => {
    vendor.listsLag = true;
    vendor.pointLag = 3;
    vendor.statusLag = 2;
    const start = clock;
    const r = await dispatch(filedBody());
    expect(r.outcome, JSON.stringify(r.settle)).toMatchObject({ ok: true });
    expect(clock - start).toBeLessThan(45_000 + 2 * 20_000);
    expect(posted[0]).toContain("Your ChatGPT ad is on");
  });

  it("the deadline counts the reads themselves, and a brief 503 is read again", async () => {
    vendor.listsLag = true;
    vendor.pointLag = 10_000;
    vendor.pointErrors = 1;
    vendor.onRequest = () => { clock += 3000; };
    const start = clock;
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    expect(posted[0]).toContain("did not show the ad group and ad Zavi just made");
    expect(clock - start).toBeLessThan(45_000 + 20_000 + 60_000);
  });

  it("a child archived before launch stops it at once, without waiting out the deadline", async () => {
    vendor.listsLag = true;
    const realFetch = vendor.fetch.bind(vendor);
    vendor.fetch = async (u, i) => {
      const res = await realFetch(u, i);
      for (const a of vendor.ads.values()) a.status = "archived";
      return res;
    };
    const start = clock;
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    expect(posted[0]).toContain("was archived before launch");
    expect(clock - start).toBeLessThan(5_000);
    expect([...vendor.campaigns.values()][0].status).toBe("archived");
  });

  it("a campaign paused under the launch never has its ads switched on", async () => {
    vendor.listsLag = true;
    const realFetch = vendor.fetch.bind(vendor);
    let readsAfterOn = 0;
    vendor.fetch = async (u, i) => {
      const res = await realFetch(u, i);
      const c = [...vendor.campaigns.values()][0];
      if (c?.status === "active" && (i?.method ?? "GET") === "GET" && ++readsAfterOn === 1) c.status = "paused";
      return res;
    };
    const r = await dispatch(filedBody());
    expect(r.outcome.ok).toBe(false);
    expect([...vendor.ads.values()].every((a) => a.status !== "active")).toBe(true);
  });

  it("an ad ChatGPT rejected stops the launch before anything is switched on", async () => {
    vendor.listsLag = true;
    vendor.reviewAtCreate = "rejected";
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    const c = [...vendor.campaigns.values()][0];
    expect(c.status).toBe("archived");
    expect([...vendor.groups.values(), ...vendor.ads.values()].every((o) => o.status === "paused")).toBe(true);
    expect(posted[0]).toContain("ChatGPT rejected the ad in its review");
    expect(posted[0]).not.toContain("ads balance may keep");
  });

  it("children that never show stop the launch at the deadline; nothing is switched on", async () => {
    vendor.listsLag = true;
    vendor.pointLag = 10_000;
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    expect([...vendor.campaigns.values()][0].status).toBe("archived");
    expect([...vendor.groups.values(), ...vendor.ads.values()].every((o) => o.status === "paused")).toBe(true);
    expect(posted[0]).toContain("did not show the ad group and ad Zavi just made");
  });

  it("only the children this action made are switched on, never another ad in the campaign", async () => {
    vendor.listsLag = true;
    const body = filedBody();
    const realFetch = vendor.fetch.bind(vendor);
    let planted = false;
    vendor.fetch = async (u, i) => {
      const res = await realFetch(u, i);
      if (!planted && vendor.ads.size === 1) {
        planted = true;
        const own = [...vendor.ads.values()][0];
        vendor.ads.set("ad_other", { ...structuredClone(own), id: "ad_other", status: "paused" });
      }
      return res;
    };
    const r = await dispatch(body);
    expect(r.outcome, JSON.stringify(r.settle)).toMatchObject({ ok: true });
    expect(vendor.ads.get("ad_other")?.status).toBe("paused");
  });

  it("a budget raised on the paused campaign before launch is refused, never launched on the old hold", async () => {
    const realFetch = vendor.fetch.bind(vendor);
    let raised = false;
    vendor.fetch = async (u, i) => {
      const res = await realFetch(u, i);
      if (!raised && vendor.ads.size === 1) {
        raised = true;
        [...vendor.campaigns.values()][0].budget = { lifetime_spend_limit_micros: 2_500_000_000 };
      }
      return res;
    };
    const r = await dispatch(filedBody());
    expect(r.outcome.ok).toBe(false);
    expect(posted[0]).toContain("budget or schedule changed after Zavi made it");
    expect([...vendor.campaigns.values()][0].status).toBe("archived");
    expect([...vendor.ads.values(), ...vendor.groups.values()].every((o) => o.status !== "active")).toBe(true);
  });

  it("another ad already switched on in the campaign stops the launch: it would serve the moment the campaign is on", async () => {
    const realFetch = vendor.fetch.bind(vendor);
    let planted = false;
    vendor.fetch = async (u, i) => {
      const res = await realFetch(u, i);
      if (!planted && vendor.ads.size === 1) {
        planted = true;
        const own = [...vendor.ads.values()][0];
        vendor.ads.set("ad_other", { ...structuredClone(own), id: "ad_other", status: "active" });
      }
      return res;
    };
    const r = await dispatch(filedBody());
    expect(r.outcome.ok).toBe(false);
    expect(posted[0]).toContain("Another ad in this campaign is switched on");
    expect([...vendor.campaigns.values()][0].status).toBe("archived");
  });

  it("a switch-on the wallet refused (balance short) never claims a reservation (Grok F2)", async () => {
    vendor.listsLag = true;
    m.walletReserve.mockRejectedValue(new ExpectedToolError("ads_balance_insufficient", "Available ads balance must cover the campaign’s reserved campaign budget."));
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    expect(posted[0]).not.toContain("ads balance may keep");
  });

  it("a campaign that was switched on and then could not be proven says the ads balance keeps its reservation", async () => {
    vendor.listsLag = true;
    vendor.statusLag = 10_000;
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    expect(posted[0]).toContain("ads balance may keep a reservation for this campaign for 48 hours");
    expect(posted[0]).not.toMatch(/nothing was charged/i);
  });

  it("a campaign Zavi could not archive stays partial risk: part of it may be on", async () => {
    vendor.failAt = "activate_group";
    vendor.archiveFails = true;
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("exec_partial");
    expect(classifyExecFailure(r.settle?.result)?.bucket).toBe("partial_risk");
    expect(m.release).not.toHaveBeenCalled();
    expect(posted[0]).toContain("could not archive it either");
  });

  it("an archive the platform only echoes is not trusted: the read-back still shows it on, so it stays partial risk", async () => {
    vendor.failAt = "activate_group";
    vendor.archiveEchoOnly = true;
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("exec_partial");
    expect([...vendor.campaigns.values()][0].status).not.toBe("archived");
    expect(m.release).not.toHaveBeenCalled();
  });

  it("an archive whose response was lost is proved by the read-back: the card closes and the retry is free", async () => {
    vendor.failAt = "save_ad";
    vendor.archiveResponseLost = true;
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    expect([...vendor.campaigns.values()][0].status).toBe("archived");
  });

  it("the founder is never told 'nothing was charged': a failure after activation may have served", async () => {
    vendor.failAt = "readback";
    await dispatch(filedBody());
    expect(posted[0]).not.toMatch(/nothing was charged/i);
    expect(posted[0]).toContain("within 48 hours");
  });

  it("a hold that could not be released is never called released (Codex F3)", async () => {
    vendor.failAt = "activate_group";
    m.release.mockResolvedValue(false);
    const r = await dispatch(filedBody());
    expect((r.settle?.result as { code?: string } | undefined)?.code).toBe("chatgpt_ads_launch_undone");
    expect(m.release).toHaveBeenCalledTimes(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("so it was archived. It is not running.");
    expect(posted[0]).toContain("could not confirm its budget hold was released");
    expect(posted[0]).not.toContain("hold released");
  });

  it("an undelivered founder line fails the settle step so Inngest retries it (Codex F1)", async () => {
    const r = await runChannelActionMutation(ACTION, { claim: async () => ({ ok: true, row: { tenant_id: TENANT, agent_run_id: "child-run", channel_slug: "chatgpt_ads", exec_class: CHATGPT_CREATE, exec_payload: filedBody(), approved_by: OWNER, approved_by_source: null, claim_id: "claim-1" } }), loadHandler: async () => (d: any) => executeChatgptGrowthAction(d), writeEnabled: async () => true, channelLock: async () => null, envelopeSwitchedOff: async () => false, tenantDisabled: async () => false } as never);
    const settle = async () => ({ ok: true });
    await expect(settleChannelActionOutcome(ACTION, r, { settle, tellOutcome: async () => "failed" } as never)).rejects.toThrow("not delivered");
    for (const told of ["told", "already_told", "no_surface", "not_a_direct_ask"]) {
      await expect(settleChannelActionOutcome(ACTION, r, { settle, tellOutcome: async () => told } as never)).resolves.toBeTruthy();
    }
  });

  it("the human launch card keeps its lock: drift since the confirm is refused", async () => {
    vendor.failAt = "activate_campaign";
    await dispatch(filedBody());
    vendor.failAt = null;
    const c = [...vendor.campaigns.values()][0];
    c.status = "paused";
    const b = [...m.bindings.values()][0] as never;
    const seen = await withBoundCampaign(b, () => readCampaignTree(TENANT, c.id));
    await expect(withBoundCampaign(b, () => launchCampaign(TENANT, c.id, { expected_updated_at: seen.campaign.updated_at, snapshot: launchSnapshot(seen) }))).rejects.toThrow("changed since you opened it");
    expect(c.status).toBe("paused");
  });
});
