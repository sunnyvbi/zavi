import { beforeEach, describe, expect, it, vi } from "vitest";

type Obj = { id: string; campaign_id: string; adgroup_id?: string; name: string; operation_status: string; budget: number; budget_mode: string };
const m = vi.hoisted(() => ({
  campaigns: new Map<string, Obj>(),
  adgroups: new Map<string, Obj>(),
  ads: new Map<string, Obj>(),
  posts: [] as Array<{ endpoint: string; body: Record<string, unknown> }>,
  fail: null as null | { endpoint: string; how: "transport" | "code40002" },
  calls: [] as string[],
  hold: { status: "held", tenant_id: "T", idem_key: "k", fresh: true } as Record<string, unknown>,
  commitThrows: false,
  role: "owner" as string | null,
  roleAfterReserve: null as string | null,
  ledger: [] as Array<{ account_id: string; level: string }>,
  lockAfterReserve: false,
  locked: false,
  planLocked: false,
}));

vi.mock("@/services/connectors/composio/account", () => ({ honestComposioToolError: async (_t: string, _k: string, _l: string, e: unknown) => e,
  resolveOwnedComposioAccount: async () => ({ tenant_id: "T", toolkit: "tiktok_ads", connected_account_id: "ca1", auth_config_id: "ac1" }),
}));
vi.mock("@/services/connectors/composio/api", async (orig) => ({
  ...(await orig<typeof import("@/services/connectors/composio/api")>()),
  composioProxy: async (a: { method: string; endpoint: string; body?: Record<string, unknown> }) => {
    const url = new URL(a.endpoint, "https://x.test");
    const ok = (data: unknown) => ({ ok: true, status: 200, json: { code: 0, message: "OK", data } });
    if (a.method === "GET") {
      const filtering = JSON.parse(url.searchParams.get("filtering") ?? "{}") as Record<string, string[]>;
      const pick = (map: Map<string, Obj>, key: string) =>
        [...map.values()].filter((o) => (!filtering[key] || filtering[key].includes(o.id)) && (!filtering.campaign_ids || key === "campaign_ids" || filtering.campaign_ids.includes(o.campaign_id)));
      if (url.pathname === "/campaign/get/") {
        return ok({ list: pick(m.campaigns, "campaign_ids").map((c) => ({ campaign_id: c.id, campaign_name: c.name, operation_status: c.operation_status, budget: c.budget, budget_mode: c.budget_mode })), page_info: { total_page: 1 } });
      }
      if (url.pathname === "/adgroup/get/") return ok({ list: pick(m.adgroups, "adgroup_ids").map((g) => ({ adgroup_id: g.id, adgroup_name: g.name, campaign_id: g.campaign_id, operation_status: g.operation_status, budget: g.budget, budget_mode: g.budget_mode })), page_info: { total_page: 1 } });
      if (url.pathname === "/ad/get/") return ok({ list: pick(m.ads, "ad_ids").map((x) => ({ ad_id: x.id, ad_name: x.name, adgroup_id: x.adgroup_id, campaign_id: x.campaign_id, operation_status: x.operation_status })), page_info: { total_page: 1 } });
      return { ok: false, status: 404, json: {} };
    }
    const b = a.body ?? {};
    m.posts.push({ endpoint: a.endpoint, body: b });
    if (m.fail?.endpoint === a.endpoint) {
      const how = m.fail.how;
      m.fail = null;
      return how === "transport" ? { ok: false, status: 0, json: {} } : { ok: true, status: 200, json: { code: 40002, message: "bad params" } };
    }
    const set = (map: Map<string, Obj>, ids: unknown) => { for (const id of ids as string[]) { const o = map.get(id); if (o) o.operation_status = String(b.operation_status); } };
    if (a.endpoint === "/campaign/status/update/") set(m.campaigns, b.campaign_ids);
    if (a.endpoint === "/adgroup/status/update/") set(m.adgroups, b.adgroup_ids);
    if (a.endpoint === "/ad/status/update/") set(m.ads, b.ad_ids);
    return ok({});
  },
}));
vi.mock("../ad-accounts", () => ({
  ensureAdAccounts: async () => ({ connected: true, accounts: [{ advertiser_id: "111", name: "Main", currency: "USD", status: "ENABLE", timezone: "UTC", source: "business_center" }], selected_id: "111", needs: "nothing", checked_at: "x" }),
}));
vi.mock("@/services/decisions/ad-budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/decisions/ad-budget")>()),
  reserveAdSpend: vi.fn(async (_d: unknown, a: { op: string; object_id: string | null; daily_delta_usd: number }) => {
    m.calls.push(`reserve:${a.op}:${a.object_id}:${a.daily_delta_usd}`);
    if (m.lockAfterReserve) m.locked = true;
    if (m.roleAfterReserve) m.role = m.roleAfterReserve;
    return m.hold;
  }),
  commitAdSpend: vi.fn(async (_h: unknown, id: string) => { m.calls.push(`commit:${id}`); if (m.commitThrows) throw new Error("db down"); }),
  dropAdSpendHold: vi.fn(async (h: { status: string }) => { m.calls.push(`drop:${h.status}`); }),
  rebaseAdSpendForObject: vi.fn(async () => {}),
  releaseAdSpendForObject: vi.fn(async (_t: string, _p: string, id: string) => { m.calls.push(`release:${id}`); }),
}));
vi.mock("@/services/decisions/ad-changes", () => ({ recordZaviAdChange: vi.fn(async () => {}) }));
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: async () => m.role }));
vi.mock("@/services/channels/lock", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/lock")>()),
  assertSpendWritesOn: async () => {
    m.calls.push("lock-check");
    if (m.locked) {
      const { ExpectedToolError } = await import("@/services/tools/types");
      throw new ExpectedToolError("tiktok_ads_write_disabled", "TikTok Ads changes are switched off");
    }
  },
}));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: async () => (m.planLocked ? { slug: "tiktok_ads", required_tier: "pro" } : null) }));
vi.mock("@/services/tenant-client", () => {
  const q = { select: () => q, eq: () => q, limit: async () => ({ data: m.ledger, error: null }) };
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: () => q }), tenantRpc: vi.fn(async () => ({ data: null, error: null })) };
});
vi.mock("@/services/channels/exec-emit", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/exec-emit")>()),
  resolveChannelExecEmit: async (_c: unknown, ctx: { emit_decision?: unknown }) => ctx.emit_decision,
}));

import { executeTiktokAction, pauseTiktokBudgetObject } from "../execute";
import { isTiktokSpendWrite, tiktokStatusBody } from "../held-schema";
import { resolveTiktokAdsEmit } from "@/services/tools/tiktok-ads/_exec-action";
import { tiktokAdsProposeStatusChangeTool } from "@/services/tools/tiktok-ads/propose_changes";
import { callTikTokAdsTool, listTikTokAdsTools } from "@/services/mcp/internal/tiktok-ads";

const row = (cls: string, body: unknown, over: Record<string, unknown> = {}) => ({ id: "11111111-1111-4111-8111-111111111111", tenant_id: "T", decision_class: cls, body, approved_by: "u1", approved_by_source: null, exec_source: "decisions", agent_run_id: "r1", ...over });
const resume = { advertiser_id: "111", advertiser_name: "Main", rationale: "go", level: "campaign", object_id: "101", campaign_id: "101", name: "Spring", status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: 60 };
const pause = { ...resume, status: "PAUSED", expected_current_status: "ACTIVE" };

beforeEach(() => {
  m.campaigns = new Map([["101", { id: "101", campaign_id: "101", name: "Spring", operation_status: "ENABLE", budget: 60, budget_mode: "BUDGET_MODE_DAY" }]]);
  m.adgroups = new Map([["201", { id: "201", campaign_id: "101", name: "Group", operation_status: "ENABLE", budget: 0, budget_mode: "BUDGET_MODE_INFINITE" }]]);
  m.ads = new Map([["301", { id: "301", campaign_id: "101", adgroup_id: "201", name: "Ad", operation_status: "ENABLE", budget: 0, budget_mode: "" }]]);
  m.posts = [];
  m.fail = null;
  m.calls = [];
  m.hold = { status: "held", tenant_id: "T", idem_key: "k", fresh: true };
  m.commitThrows = false;
  m.role = "owner";
  m.roleAfterReserve = null;
  m.ledger = [];
  m.planLocked = false;
  m.lockAfterReserve = false;
  m.locked = false;
});

describe("ad-level pause", () => {
  const adPause = { advertiser_id: "111", advertiser_name: "Main", rationale: "r", level: "ad", object_id: "301", campaign_id: "101", ad_group_id: "201", ad_id: "301", name: "Ad", status: "PAUSED", expected_current_status: "ACTIVE", daily_budget_usd: null };

  it("pauses one ad, confirms it and leaves every hold alone", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.set_status", adPause));
    expect(r).toMatchObject({ ok: true });
    expect(m.ads.get("301")!.operation_status).toBe("DISABLE");
    expect(m.posts).toEqual([{ endpoint: "/ad/status/update/", body: { advertiser_id: "111", ad_ids: ["301"], operation_status: "DISABLE" } }]);
    expect(m.calls.filter((c) => c.startsWith("release") || c.startsWith("reserve"))).toEqual([]);
  });

  it("an ad can never be turned back on through a card", () => {
    expect(tiktokStatusBody.safeParse({ ...adPause, status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: 10 }).success).toBe(false);
  });

  it("the status tool files an ad pause with its ad group", async () => {
    const emitted: unknown[] = [];
    await tiktokAdsProposeStatusChangeTool.execute({ tenant_id: "T", log: () => {}, emit_decision: async (_c, b) => { emitted.push(b); return "d1"; } }, { level: "ad", object_id: "301", status: "PAUSED", rationale: "r" });
    expect(emitted[0]).toMatchObject({ level: "ad", object_id: "301", ad_id: "301", ad_group_id: "201", campaign_id: "101" });
  });
});

describe("chat proposals", () => {
  it("a chat proposal lands on the decisions rail stamped as the founder's own ask", async () => {
    const legacy = vi.fn(async () => "dec-1");
    const emit = await resolveTiktokAdsEmit({ tenant_id: "T", run_id: "r1", emit_decision: legacy }, { chatEdit: true });
    await emit!("tiktok_ads.set_status", { level: "campaign", origin: "specialist" });
    expect(legacy).toHaveBeenCalledWith("tiktok_ads.set_status", { level: "campaign", origin: "user_initiated_chat" });
  });

  it("renders an in-chat card for each class", async () => {
    const { buildInlineDecisionBody } = await import("@/services/agents/build-inline-decision");
    const id = "22222222-2222-4222-8222-222222222222";
    expect(buildInlineDecisionBody({ decision_id: id, decision_class: "tiktok_ads.set_status", body: { status: "PAUSED", level: "ad", object_id: "301" } })).toMatchObject({ title: "TikTok Ads: pause an ad", subject: "301" });
    expect(buildInlineDecisionBody({ decision_id: id, decision_class: "tiktok_ads.update_budget", body: { object_id: "101" } })).toMatchObject({ title: "TikTok Ads: change a daily budget", subject: "101" });
  });

  it("a new launch is never filed from chat: one create path, the TikTok Ads channel", async () => {
    const legacy = vi.fn(async () => "dec-1");
    const emit = await resolveTiktokAdsEmit({ tenant_id: "T", run_id: "r1", emit_decision: legacy }, { chatEdit: true });
    await expect(emit!("tiktok_ads.create_launch", { name: "Spring" })).rejects.toMatchObject({ code: "tiktok_ads_launch_channel_only" });
    await expect(emit!("tiktok_ads.create_campaign", { name: "Spring" })).rejects.toMatchObject({ code: "tiktok_ads_launch_channel_only" });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("outside a TikTok Ads channel run the launch tool gets no card writer, so it refuses before any upload", async () => {
    const legacy = vi.fn(async () => "dec-1");
    expect(await resolveTiktokAdsEmit({ tenant_id: "T", run_id: "r1", emit_decision: legacy })).toBeUndefined();
    const r = await callTikTokAdsTool({ tenant_id: "T", run_id: "r1", emit_decision: legacy }, "propose_launch", {
      campaign_type: "TRAFFIC", name: "Spring", location_ids: ["6252001"], daily_budget_usd: 30, video_url: "https://cdn.test/clip.mp4",
      identity_id: "tt-1", ad_text: "Try it", call_to_action: "LEARN_MORE", landing_url: "https://zavi.test", rationale: "founder asked",
    });
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.content).error).toBe("tiktok_ads_propose_not_channel_run");
    expect(m.posts).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("the TikTok tools expose account and targeting reads plus only the governed edit and launch writers", () => {
    expect(listTikTokAdsTools().map((t) => t.tool_name)).toEqual(["list_accounts", "list_campaigns", "list_ad_groups", "search_locations", "targeting_options", "propose_budget_change", "propose_status_change", "launch_readiness", "propose_launch"]);
  });

  it("Composio's Smart+ writes stay refused", () => {
    expect(isTiktokSpendWrite("TIKTOK_ADS_CREATE_SMART_PLUS_CAMPAIGN")).toBe(true);
    expect(isTiktokSpendWrite("TIKTOK_ADS_UPDATE_SMART_PLUS_CAMPAIGN_STATUS")).toBe(true);
  });
});

describe("chat edit guards", () => {
  it("Stop pauses a campaign the hourly ledger has not seen yet", async () => {
    await pauseTiktokBudgetObject("T", "101");
    expect(m.campaigns.get("101")!.operation_status).toBe("DISABLE");
  });

  it("a body that went through the emit seam (brain citations, playbook id, goal hint, an older row's framing and review stamp) still runs", async () => {
    const { mergeBrainProvenance } = await import("@/services/agents/brain-provenance");
    const { stampPlaybookRunId } = await import("@/playbooks/stamp");
    const cited = new Map([["n1", { title: "Company", score: 1 }]]);
    let body = stampPlaybookRunId(mergeBrainProvenance({ ...pause }, cited as never), "p1") as Record<string, unknown>;
    body = {
      ...body,
      tone: "calm", summary: "s", confidence: 0.8, label: "l", caveat: "c", note: "n", framing: "f", headline: "h", severity: "low", rationale: "reworded", disclaimer: "d",
      metadata: { critic_review: { required: true, reason: "cross_family_critic", verdict: "refute", internal: true } },
      on_goal_hint: { goal: null },
    };
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["brain_citations", "playbook_run_id", "metadata", "on_goal_hint", "summary"]));
    expect(await executeTiktokAction(row("tiktok_ads.set_status", body))).toMatchObject({ ok: true });
  });

  it("an unknown field is still refused, nothing sent", async () => {
    const r = await executeTiktokAction(row("tiktok_ads.set_status", { ...pause, surprise: 1 }));
    expect(r).toMatchObject({ ok: false, code: "tiktok_ads_body_invalid" });
    expect(m.posts).toEqual([]);
  });

  it("a workspace below the TikTok plan cannot turn anything on from chat", async () => {
    m.planLocked = true;
    m.campaigns.get("101")!.operation_status = "DISABLE";
    expect(await executeTiktokAction(row("tiktok_ads.set_status", resume))).toMatchObject({ ok: false, code: "plan_upgrade_required" });
    expect(m.posts).toEqual([]);
  });

  it("a pause still works below the plan", async () => {
    m.planLocked = true;
    expect(await executeTiktokAction(row("tiktok_ads.set_status", pause))).toMatchObject({ ok: true });
  });

  it("the staff lock stops a resume before anything is sent", async () => {
    m.locked = true;
    m.campaigns.get("101")!.operation_status = "DISABLE";
    expect(await executeTiktokAction(row("tiktok_ads.set_status", resume))).toMatchObject({ ok: false, code: "tiktok_ads_write_disabled" });
    expect(m.posts).toEqual([]);
  });

  it("a member cannot approve a resume", async () => {
    m.role = "member";
    m.campaigns.get("101")!.operation_status = "DISABLE";
    expect(await executeTiktokAction(row("tiktok_ads.set_status", resume))).toMatchObject({ ok: false, code: "tiktok_ads_admin_required" });
    expect(m.posts).toEqual([]);
  });
});
