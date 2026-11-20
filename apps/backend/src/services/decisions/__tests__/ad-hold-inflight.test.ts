import { describe, it, expect, vi, beforeEach } from "vitest";

const chatgpt = vi.hoisted(() => ({ tree: vi.fn() }));
vi.mock("@/services/connectors/chatgpt-ads/workspace", () => ({ readCampaignTree: chatgpt.tree }));
const tiktok = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/services/connectors/tiktok-ads/campaign-settings", () => ({ resolveSettingsHold: tiktok.resolve }));
const tiktokStatus = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/services/connectors/tiktok-ads/status-budget", () => ({ resolveTiktokStatusHold: tiktokStatus.resolve }));

const db = vi.hoisted(() => ({
  holds: [] as Array<Record<string, unknown>>,
  cards: {} as Record<string, Record<string, unknown>>,
  ledger: [] as Array<Record<string, unknown>>,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  filters: [] as string[],
}));

vi.mock("@/services/tenant-client", () => {
  const table = (name: string) => {
    const q: Record<string, unknown> = {};
    let id: unknown = null;
    for (const m of ["select", "in", "not", "lt", "order", "or"]) q[m] = (...a: unknown[]) => (db.filters.push(`${name}.${m}:${JSON.stringify(a)}`), q);
    q.eq = (c: string, v: unknown) => {
      if (c === "id") id = v;
      db.filters.push(`${name}.eq:${c}=${String(v)}`);
      return q;
    };
    q.limit = async () => ({ data: name === "ad_budget_reservations" ? db.holds : db.ledger, error: null });
    q.maybeSingle = async () => ({ data: db.cards[String(id)] ?? null, error: null });
    return q;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: table }),
    tenantRpc: async (_t: string, name: string, args: Record<string, unknown>) => {
      db.rpcs.push({ name, args });
      return { data: { status: args.p_outcome === "landed" ? "committed" : "released" }, error: null };
    },
  };
});

import { inflightOutcome, resolveInflightAdHolds, type LedgerRow } from "../ad-hold-resolve";

const NOW = new Date("2026-10-07T12:00:00Z");
const HOLD = { id: "h1", op: "raise", platform: "google", object_id: "777", updated_at: "2026-10-07T08:00:00.000Z" };
const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  object_id: "777",
  campaign_id: "777",
  level: "campaign",
  budget_kind: "daily",
  budget_usd: 45,
  campaign_budget_usd: null,
  status: "ENABLED",
  as_of: "2026-10-07T11:30:00.000Z",
  ...over,
});
const doubleIt = { exec_class: "google_ads.update_campaign_budget", body: { campaign_id: "777", daily_budget_usd: 90, expected_current_daily_budget_usd: 45 } };

describe("inflightOutcome", () => {
  it('"double the budget" that never took ($45 still live) is not_landed; one that did ($90) is landed', () => {
    expect(inflightOutcome(HOLD, doubleIt, [row()], NOW)).toBe("not_landed");
    expect(inflightOutcome(HOLD, doubleIt, [row({ budget_usd: 90 })], NOW)).toBe("landed");
    expect(inflightOutcome(HOLD, { ...doubleIt, exec_class: "google_ads.update_campaign_budget_review" }, [row({ budget_usd: 90 })], NOW)).toBe("landed");
  });

  it("cannot tell: no card, a card with no stated target, a row read before the change or over 3 hours ago, no row", () => {
    expect(inflightOutcome(HOLD, null, [row()], NOW)).toBeNull();
    expect(inflightOutcome(HOLD, { exec_class: "meta_ads.create_ad_set", body: { daily_budget_usd: 90 } }, [row()], NOW)).toBeNull();
    expect(inflightOutcome(HOLD, doubleIt, [row({ as_of: "2026-10-07T07:59:00.000Z" })], NOW)).toBeNull();
    expect(inflightOutcome(HOLD, doubleIt, [row({ as_of: "2026-10-07T08:30:00.000Z" })], NOW)).toBeNull();
    expect(inflightOutcome(HOLD, doubleIt, [], NOW)).toBeNull();
    expect(inflightOutcome(HOLD, doubleIt, [row({ budget_kind: "shared", budget_usd: null })], NOW)).toBeNull();
  });

  it("a Meta campaign budget is read from its ad sets' campaign_budget_usd", () => {
    const h = { ...HOLD, platform: "meta", object_id: "c1" };
    const card = { exec_class: "meta_ads.update_ad_set_budget", body: { ad_set_id: "c1", daily_budget_usd: 200 } };
    const kids = [row({ object_id: "as1", campaign_id: "c1", level: "ad_set", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: 120 })];
    expect(inflightOutcome(h, card, kids, NOW)).toBe("not_landed");
    expect(inflightOutcome(h, card, [{ ...kids[0], campaign_budget_usd: 200 }], NOW)).toBe("landed");
  });

  it("a resume: on is landed, paused is not, a Meta campaign judged by its ad sets", () => {
    const h = { ...HOLD, op: "resume" };
    const on = { exec_class: "google_ads.set_status_review", body: { campaign_id: "777", status: "ENABLED" } };
    expect(inflightOutcome(h, on, [row()], NOW)).toBe("landed");
    expect(inflightOutcome(h, on, [row({ status: "PAUSED" })], NOW)).toBe("not_landed");
    expect(inflightOutcome(h, { ...on, body: { status: "PAUSED" } }, [row()], NOW)).toBeNull();
    const mh = { ...h, platform: "meta", object_id: "c1" };
    const mon = { exec_class: "meta_ads.set_status", body: { object_id: "c1", level: "campaign", status: "ACTIVE" } };
    const kid = (status: string) => row({ object_id: `as-${status}`, campaign_id: "c1", level: "ad_set", status });
    expect(inflightOutcome(mh, mon, [kid("CAMPAIGN_PAUSED"), kid("CAMPAIGN_PAUSED")], NOW)).toBe("not_landed");
    expect(inflightOutcome(mh, mon, [kid("ACTIVE")], NOW)).toBe("landed");
    expect(inflightOutcome(mh, mon, [kid("ARCHIVED")], NOW)).toBeNull();
  });
});

describe("resolveInflightAdHolds", () => {
  beforeEach(() => {
    tiktok.resolve.mockReset();
    tiktokStatus.resolve.mockReset();
    db.holds = [];
    db.cards = {};
    db.ledger = [];
    db.rpcs = [];
    db.filters = [];
  });

  it("judges a child-budget hold from its approved parent or ad switch, not the budget owner's status", async () => {
    db.holds = [{ ...HOLD, platform: "tiktok", op: "resume", object_id: "201", decision_id: null, channel_action_id: "resume" }];
    const body = { object_id: "301", level: "ad", status: "ACTIVE", resume_plan: { sources: [{ object_id: "201" }] } };
    db.cards = { resume: { exec_class: "tiktok_ads.set_status", exec_payload: body } };
    db.ledger = [row({ object_id: "201", status: "ACTIVE" })];
    tiktokStatus.resolve.mockResolvedValue("not_landed");
    expect(await resolveInflightAdHolds("t1", NOW)).toMatchObject({ released: 1 });
    expect(tiktokStatus.resolve).toHaveBeenCalledWith("t1", "201", body);
    tiktokStatus.resolve.mockResolvedValue(null);
    expect(await resolveInflightAdHolds("t1", NOW)).toMatchObject({ kept: 1, released: 0 });
  });

  it("resolves TikTok schedule exposure only from a fresh settings read, never the daily-budget ledger", async () => {
    db.holds = [{ ...HOLD, platform: "tiktok", object_id: "201", decision_id: null, channel_action_id: "settings" }];
    const body = { object_id: "201", advertiser_id: "111", changes: { schedule_end_time: "2099-05-20T15:00:00.000Z" } };
    db.cards = { settings: { exec_class: "tiktok_ads.update_settings", exec_payload: body } };
    db.ledger = [row({ object_id: "201", budget_usd: 30 })];
    tiktok.resolve.mockResolvedValue("landed");
    expect(await resolveInflightAdHolds("t1", NOW, { platforms: ["tiktok"] })).toMatchObject({ found: 1, released: 0 });
    expect(tiktok.resolve).toHaveBeenCalledWith("t1", "201", body);
    tiktok.resolve.mockResolvedValue("not_landed");
    expect(await resolveInflightAdHolds("t1", NOW)).toMatchObject({ released: 1 });
    tiktok.resolve.mockResolvedValue(null);
    expect(await resolveInflightAdHolds("t1", NOW)).toMatchObject({ kept: 1, released: 0 });
    tiktok.resolve.mockRejectedValue(new Error("TikTok unavailable"));
    expect(await resolveInflightAdHolds("t1", NOW)).toMatchObject({ failed: 1, released: 0 });
  });

  it("reads only this tenant's reserved raise / resume holds on an object, 2+ hours since their last change; releases one that never took", async () => {
    db.holds = [{ ...HOLD, decision_id: "d1", channel_action_id: null }];
    db.cards = { d1: { decision_class: doubleIt.exec_class, body: doubleIt.body } };
    db.ledger = [row()];
    const out = await resolveInflightAdHolds("t1", NOW);
    expect(out).toEqual({ found: 0, released: 1, kept: 0, failed: 0 });
    expect(db.rpcs).toEqual([{ name: "resolve_inflight_ad_hold", args: { p_hold_id: "h1", p_outcome: "not_landed", p_seen_updated_at: HOLD.updated_at } }]);
    expect(db.filters).toEqual(expect.arrayContaining([
      "ad_budget_reservations.eq:tenant_id=t1",
      "ad_budget_reservations.eq:status=reserved",
      `ad_budget_reservations.in:${JSON.stringify(["op", ["raise", "resume"]])}`,
      `ad_budget_reservations.not:${JSON.stringify(["object_id", "is", null])}`,
      `ad_budget_reservations.lt:${JSON.stringify(["updated_at", "2026-10-07T10:00:00.000Z"])}`,
    ]));
  });

  it("a channel card is read from its exec payload; a landed change is committed", async () => {
    db.holds = [{ ...HOLD, decision_id: null, channel_action_id: "a1" }];
    db.cards = { a1: { exec_class: doubleIt.exec_class, exec_payload: doubleIt.body } };
    db.ledger = [row({ budget_usd: 90 })];
    expect(await resolveInflightAdHolds("t1", NOW)).toEqual({ found: 1, released: 0, kept: 0, failed: 0 });
  });

  it("nothing judged after a failed spend read, and an odd object id never reaches a filter", async () => {
    db.holds = [{ ...HOLD, decision_id: "d1", channel_action_id: null }];
    expect(await resolveInflightAdHolds("t1", NOW, { allowRelease: false })).toEqual({ found: 0, released: 0, kept: 0, failed: 0 });
    db.holds = [{ ...HOLD, object_id: "1,campaign_id.eq.2", decision_id: "d1", channel_action_id: null }];
    expect(await resolveInflightAdHolds("t1", NOW)).toEqual({ found: 0, released: 0, kept: 1, failed: 0 });
    expect(db.rpcs).toEqual([]);
  });

  it("a hold on a platform whose ledger was not rewritten this hour is kept, never judged on an older row", async () => {
    db.holds = [{ ...HOLD, decision_id: "d1", channel_action_id: null }];
    db.cards = { d1: { decision_class: doubleIt.exec_class, body: doubleIt.body } };
    db.ledger = [row()];
    expect(await resolveInflightAdHolds("t1", NOW, { platforms: ["meta"] })).toEqual({ found: 0, released: 0, kept: 1, failed: 0 });
    expect(await resolveInflightAdHolds("t1", NOW, { platforms: [] })).toEqual({ found: 0, released: 0, kept: 1, failed: 0 });
    expect(db.rpcs).toEqual([]);
    expect(await resolveInflightAdHolds("t1", NOW, { platforms: ["google"] })).toEqual({ found: 0, released: 1, kept: 0, failed: 0 });
  });
  it("ChatGPT recovery commits coverage for a partially active launch without marking the action successful", async () => {
    db.holds = [{...HOLD,platform:"chatgpt",op:"resume",object_id:"cmpn_test",decision_id:null,channel_action_id:"a1"}];
    db.cards = {a1:{exec_class:"chatgpt_ads.set_status",exec_payload:{campaign_id:"cmpn_test",status:"ACTIVE"}}};
    db.ledger = [row({object_id:"cmpn_test",status:"ACTIVE"})];
    const tree={campaign:{id:"cmpn_test",status:"active"},groups:[{status:"active"}],ads:[{status:"paused"}]};
    chatgpt.tree.mockResolvedValue(tree);
    expect(await resolveInflightAdHolds("t1",NOW,{platforms:["chatgpt"]})).toMatchObject({kept:0,found:1,released:0});
    expect(db.rpcs[0].name).toBe("resolve_inflight_ad_hold");
    chatgpt.tree.mockResolvedValue({...tree,ads:[{status:"active"}]});
    expect(await resolveInflightAdHolds("t1",NOW,{platforms:["chatgpt"]})).toMatchObject({found:1,released:0});
    expect(chatgpt.tree).toHaveBeenCalledWith("t1","cmpn_test");
  });

  it.each([false, true])("releases a definitely paused ChatGPT resume, including old cardless UI holds (%s)", async cardless => {
    db.holds = [{ ...HOLD, platform: "chatgpt", op: "resume", object_id: "cmpn_test", decision_id: null, channel_action_id: cardless ? null : "a1" }];
    db.cards = { a1: { exec_class: "chatgpt_ads.set_status", exec_payload: { campaign_id: "cmpn_test", status: "ACTIVE" } } };
    chatgpt.tree.mockResolvedValue({ campaign: { id: "cmpn_test", status: "paused" }, groups: [], ads: [] });
    expect(await resolveInflightAdHolds("t1", NOW, { platforms: ["chatgpt"] })).toMatchObject({ released: 1 });
  });
  it("resolves a UI budget raise from its saved target, and retains an unreadable resume", async () => {
    db.holds = [{ ...HOLD, platform: "chatgpt", object_id: "cmpn_test", decision_id: null, channel_action_id: null, provider_ref: { kind: "chatgpt_workspace", campaign_id: "cmpn_test", daily_budget_usd: 90 } }];
    db.ledger = [row({ object_id: "cmpn_test", budget_usd: 45 })];
    expect(await resolveInflightAdHolds("t1", NOW)).toMatchObject({ released: 1 });
    db.holds[0].op = "resume";
    chatgpt.tree.mockRejectedValue(new Error("offline"));
    expect(await resolveInflightAdHolds("t1", NOW)).toMatchObject({ failed: 1, released: 0 });
  });

});
