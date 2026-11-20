import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const rpcCalls: Array<{ tid: string; fn: string; args: Record<string, unknown> }> = [];
const failReads = new Set<string>();

function query(tid: string, table: string) {
  let rows = (tables[table] ?? []).filter((r) => r.tenant_id === tid);
  const b = {
    select: () => b,
    eq(c: string, v: unknown) {
      rows = rows.filter((r) => r[c] === v);
      return b;
    },
    gt(c: string, v: string) {
      rows = rows.filter((r) => String(r[c]) > v);
      return b;
    },
    gte(c: string, v: string) {
      rows = rows.filter((r) => r[c] !== null && r[c] !== undefined && String(r[c]) >= v);
      return b;
    },
    like(c: string, v: string) {
      rows = rows.filter((r) => String(r[c] ?? "").startsWith(v.replace(/%$/, "")));
      return b;
    },
    or: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then(res: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
      if (failReads.has(table)) return Promise.resolve({ data: null, error: { message: `${table} down` } }).then(res);
      return Promise.resolve({ data: rows, error: null }).then(res);
    },
  };
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (t: string) => query(tid, t) }),
  tenantRpc: async (tid: string, fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ tid, fn, args });
    if (fn === "record_ad_object_changes") return { data: { status: "recorded", inserted: (args.p_changes as unknown[]).length }, error: null };
    if (fn === "emit_decision") return { data: "dec-new", error: null };
    return { data: null, error: { message: `unexpected ${fn}` } };
  },
}));

import {
  describeChange,
  diffOutsideChanges,
  freedPerDay,
  inverseOf,
  logOutsideChanges,
  onOff,
  outsideChangeLine,
  stageUndo,
  type AdChangeRow,
  type StoredCampaign,
} from "../ad-changes";
import type { LedgerCampaign } from "../ad-budget-reconcile";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-05T12:00:00Z");

const stored = (over: Partial<StoredCampaign> & { object_id: string; platform?: string; account_id?: string }): StoredCampaign & Row => ({
  tenant_id: T,
  platform: "meta",
  account_id: "act_1",
  level: "ad_set",
  campaign_id: "c1",
  name: "Awareness",
  budget_kind: "daily",
  budget_usd: "40.00",
  status: "ACTIVE",
  ...over,
});
const read = (over: Partial<LedgerCampaign> & { object_id: string }): LedgerCampaign => ({
  level: "ad_set",
  campaign_id: "c1",
  name: "Awareness",
  budget_kind: "daily",
  budget_usd: 40,
  status: "ACTIVE",
  currency: "USD",
  ...over,
});
const change = (over: Partial<AdChangeRow>): AdChangeRow => ({
  id: "ch-1",
  platform: "meta",
  object_id: "as1",
  level: "ad_set",
  campaign_id: "c1",
  object_name: "Awareness",
  source: "zavi",
  action_table: "channel_actions",
  action_id: "act-1",
  change_kind: "status",
  before_status: "ACTIVE",
  after_status: "PAUSED",
  before_daily_usd: "40.00",
  after_daily_usd: "40.00",
  occurred_at: "2026-10-05T10:00:00Z",
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  rpcCalls.length = 0;
  failReads.clear();
});

describe("onOff", () => {
  it("reads Meta effective statuses and Google statuses; anything else is neither", () => {
    expect(onOff("meta", "ACTIVE")).toBe("on");
    expect(onOff("meta", "CAMPAIGN_PAUSED")).toBe("off");
    expect(onOff("meta", "IN_PROCESS")).toBeNull();
    expect(onOff("google", "ENABLED")).toBe("on");
    expect(onOff("google", "PAUSED")).toBe("off");
    expect(onOff("google", "removed")).toBeNull();
  });
});

describe("diffOutsideChanges (decision 6)", () => {
  it("a pause and a budget change nobody in Zavi made are logged, with the budget it had", () => {
    const out = diffOutsideChanges(
      "meta",
      [stored({ object_id: "as1" }), stored({ object_id: "as2", status: "PAUSED", budget_usd: "10.00" })],
      [read({ object_id: "as1", status: "PAUSED" }), read({ object_id: "as2", status: "PAUSED", budget_usd: 25 })],
      new Set(),
    );
    expect(out).toEqual([
      expect.objectContaining({ object_id: "as1", source: "outside", change_kind: "status", before_status: "ACTIVE", after_status: "PAUSED", before_daily_usd: 40, action_table: null }),
      expect.objectContaining({ object_id: "as2", change_kind: "budget", before_daily_usd: 10, after_daily_usd: 25 }),
    ]);
  });

  it("a change Zavi made on the object, or on its campaign, in the window is not the founder's", () => {
    const s = [stored({ object_id: "as1" }), stored({ object_id: "as2", campaign_id: "c2" })];
    const r = [read({ object_id: "as1", status: "PAUSED" }), read({ object_id: "as2", campaign_id: "c2", status: "CAMPAIGN_PAUSED" })];
    expect(diffOutsideChanges("meta", s, r, new Set(["as1", "c2"]))).toEqual([]);
  });

  it("a new object, an unreadable status, a lifetime budget and a same-cents budget are not changes", () => {
    const out = diffOutsideChanges(
      "meta",
      [stored({ object_id: "as1", status: "IN_PROCESS" }), stored({ object_id: "as2", budget_kind: "lifetime", budget_usd: "500.00" }), stored({ object_id: "as3", budget_usd: "40.001" })],
      [read({ object_id: "as1", status: "PAUSED" }), read({ object_id: "as2", budget_kind: "lifetime", budget_usd: 900 }), read({ object_id: "as3" }), read({ object_id: "new" })],
      new Set(),
    );
    expect(out).toEqual([]);
  });
});

describe("logOutsideChanges", () => {
  const acct = { platform: "meta" as const, account_id: "act_1", spend: [], window: { since: "2026-10-01", until: "2026-10-05" } };

  it("logs under the tenant only, against its own stored rows (a tenant with no budget too)", async () => {
    tables.ad_campaigns = [stored({ object_id: "as1" }), { ...stored({ object_id: "as1" }), tenant_id: OTHER, status: "PAUSED" }];
    const n = await logOutsideChanges(T, { ...acct, campaigns: [read({ object_id: "as1", status: "PAUSED" })] }, NOW);
    expect(n).toBe(1);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({ tid: T, fn: "record_ad_object_changes" });
    expect((rpcCalls[0].args.p_changes as Row[])[0]).toMatchObject({ object_id: "as1", source: "outside", after_status: "PAUSED" });
  });

  it("an executed Zavi change on the object in the last 2 hours explains the difference", async () => {
    tables.ad_campaigns = [stored({ object_id: "as1" })];
    tables.channel_actions = [{ tenant_id: T, exec_class: "meta_ads.set_status", exec_payload: { object_id: "as1", status: "PAUSED" } }];
    expect(await logOutsideChanges(T, { ...acct, campaigns: [read({ object_id: "as1", status: "PAUSED" })] }, NOW)).toBe(0);
    expect(rpcCalls).toEqual([]);
  });

  it("another tenant's Zavi change does not explain this tenant's difference", async () => {
    tables.ad_campaigns = [stored({ object_id: "as1" })];
    tables.channel_actions = [{ tenant_id: OTHER, exec_class: "meta_ads.set_status", exec_payload: { object_id: "as1" } }];
    expect(await logOutsideChanges(T, { ...acct, campaigns: [read({ object_id: "as1", status: "PAUSED" })] }, NOW)).toBe(1);
  });

  it("fails closed: an unreadable Zavi history logs nothing (a false 'outside' row is worse than none)", async () => {
    tables.ad_campaigns = [stored({ object_id: "as1" })];
    failReads.add("decisions");
    expect(await logOutsideChanges(T, { ...acct, campaigns: [read({ object_id: "as1", status: "PAUSED" })] }, NOW)).toBe(0);
    expect(rpcCalls).toEqual([]);
  });
});

describe("words and the freed amount", () => {
  it("a pause frees its captured budget only when it was on and the budget is known", () => {
    expect(freedPerDay({ platform: "meta", change_kind: "status", before_status: "ACTIVE", after_status: "PAUSED", before_daily_usd: 40 })).toBe(40);
    expect(freedPerDay({ platform: "meta", change_kind: "status", before_status: "ACTIVE", after_status: "PAUSED", before_daily_usd: null })).toBeNull();
    expect(freedPerDay({ platform: "meta", change_kind: "status", before_status: "PAUSED", after_status: "PAUSED", before_daily_usd: 40 })).toBeNull();
    expect(freedPerDay({ platform: "meta", change_kind: "budget", before_status: null, after_status: null, before_daily_usd: 40 })).toBeNull();
  });

  it("says what changed, before and after", () => {
    expect(describeChange(change({}))).toBe('Paused Meta ad set "Awareness" (was on)');
    expect(describeChange(change({ change_kind: "budget", before_daily_usd: "50", after_daily_usd: "30" }))).toBe(
      'Changed the daily budget of Meta ad set "Awareness": $50.00 → $30.00',
    );
    expect(outsideChangeLine(change({ source: "outside", before_status: "PAUSED", after_status: "ACTIVE" }))).toBe(
      '2026-10-05: Turned on Meta ad set "Awareness" (was off) outside Zavi. The founder\'s decision: do not reverse it without asking.',
    );
  });
});

describe("inverseOf (Undo)", () => {
  it("a Zavi pause undoes to a resume on the review class (raises spend: the hold applies)", () => {
    expect(inverseOf(change({}))).toMatchObject({
      decision_class: "meta_ads.set_status_review",
      body: { object_id: "as1", level: "adset", status: "ACTIVE", over_cap: true, name: "Awareness", origin: "user_initiated_ledger" },
      change: 'Turn on Meta ad set "Awareness" again',
      raises_spend: true,
    });
  });

  it("a budget cut undoes to the old budget, drift-checked against what Zavi set", () => {
    const inv = inverseOf(change({ change_kind: "budget", before_status: null, after_status: null, before_daily_usd: "50", after_daily_usd: "30" }))!;
    expect(inv.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(inv.body).toMatchObject({ ad_set_id: "as1", daily_budget_usd: 50, expected_current_daily_budget_usd: 30, origin: "user_initiated_ledger" });
    expect(inv.raises_spend).toBe(true);
    expect(inv.change).toBe('Set the daily budget of Meta ad set "Awareness" back to $50.00 (from $30.00)');
  });

  it("a Meta CAMPAIGN budget (CBO) undoes on the campaign class, never as an ad set", () => {
    const inv = inverseOf(change({ level: "campaign", object_id: "c77", change_kind: "budget", before_status: null, after_status: null, before_daily_usd: "100", after_daily_usd: "150" }))!;
    expect(inv.decision_class).toBe("meta_ads.update_campaign_budget_review");
    expect(inv.body).toMatchObject({ campaign_id: "c77", daily_budget_usd: 100, expected_current_daily_budget_usd: 150, origin: "user_initiated_ledger" });
    expect(inv.body.ad_set_id).toBeUndefined();
    expect(inv.raises_spend).toBe(false);
  });

  it("Google campaign status and budget undo; a raise undoes to a cut that raises nothing", () => {
    expect(inverseOf(change({ platform: "google", level: "campaign", object_id: "42", before_status: "ENABLED", after_status: "PAUSED" }))).toMatchObject({
      decision_class: "google_ads.set_status_review",
      body: { campaign_id: "42", level: "campaign", status: "ENABLED", origin: "user_initiated_ledger" },
    });
    expect(inverseOf(change({ platform: "google", level: "campaign", object_id: "42", change_kind: "budget", before_daily_usd: "20", after_daily_usd: "35" }))).toMatchObject({
      decision_class: "google_ads.update_campaign_budget_review",
      body: { campaign_id: "42", daily_budget_usd: 20, expected_current_daily_budget_usd: 35, origin: "user_initiated_ledger" },
      raises_spend: false,
    });
  });

  it("never: an outside or Stop row, an unknown side, no change, a Google ad group", () => {
    expect(inverseOf(change({ source: "outside", action_table: null, action_id: null }))).toBeNull();
    expect(inverseOf(change({ action_table: "budget_stop", action_id: null }))).toBeNull();
    expect(inverseOf(change({ before_status: "IN_PROCESS" }))).toBeNull();
    expect(inverseOf(change({ before_status: "PAUSED" }))).toBeNull();
    expect(inverseOf(change({ change_kind: "budget", before_daily_usd: null }))).toBeNull();
    expect(inverseOf(change({ platform: "google", level: "ad_set", before_status: "ENABLED" }))).toBeNull();
  });
});

describe("stageUndo", () => {
  const deps = (pro = true, write = true) => ({ isPro: async () => pro, writeEnabled: async () => write });

  it("stages the inverse as a review decision and returns the exact change", async () => {
    tables.ad_object_changes = [{ ...change({}), tenant_id: T }];
    const out = await stageUndo(T, "ch-1", deps());
    expect(out).toEqual({ status: "staged", decision_id: "dec-new", change: 'Turn on Meta ad set "Awareness" again', raises_spend: true });
    const emit = rpcCalls.find((c) => c.fn === "emit_decision")!;
    expect(emit.tid).toBe(T);
    expect(emit.args).toMatchObject({ p_agent_run_id: null, p_decision_class: "meta_ads.set_status_review", p_body: { status: "ACTIVE", object_id: "as1" } });
  });

  it("another tenant's change id is not found (nothing staged)", async () => {
    tables.ad_object_changes = [{ ...change({}), tenant_id: OTHER }];
    expect(await stageUndo(T, "ch-1", deps())).toEqual({ status: "not_found" });
    expect(rpcCalls).toEqual([]);
  });

  it("refuses when the object changed again since, or it cannot be undone", async () => {
    tables.ad_object_changes = [
      { ...change({}), tenant_id: T },
      { ...change({ id: "ch-2", source: "outside", action_table: null, action_id: null, occurred_at: "2026-10-05T11:00:00Z" }), tenant_id: T },
    ];
    expect(await stageUndo(T, "ch-1", deps())).toEqual({ status: "changed_since" });
    expect(await stageUndo(T, "ch-2", deps())).toEqual({ status: "not_undoable" });
    expect(rpcCalls).toEqual([]);
  });

  it("an undo that raises spend needs Pro; one that lowers it does not; a switched-off platform stages nothing", async () => {
    tables.ad_object_changes = [
      { ...change({}), tenant_id: T },
      { ...change({ id: "ch-3", object_id: "as9", before_status: "PAUSED", after_status: "ACTIVE" }), tenant_id: T },
    ];
    expect(await stageUndo(T, "ch-1", deps(false))).toEqual({ status: "plan_upgrade_required" });
    expect(await stageUndo(T, "ch-3", deps(false))).toMatchObject({ status: "staged", raises_spend: false });
    expect(await stageUndo(T, "ch-1", deps(true, false))).toEqual({ status: "write_disabled" });
  });
});

describe("cgo evidence: the founder's own ad changes (decision 6)", () => {
  it("lists this tenant's outside changes of the last 14 days as founder decisions, never another tenant's", async () => {
    const { readFounderAdChanges } = await import("@/services/growth/cgo-evidence");
    tables.ad_object_changes = [
      { ...change({ id: "o1", source: "outside", action_table: null, action_id: null, before_status: "PAUSED", after_status: "ACTIVE", object_name: "40% to Turo", occurred_at: "2026-10-04T09:00:00Z" }), tenant_id: T },
      { ...change({ id: "o2", source: "outside", action_table: null, action_id: null, occurred_at: "2026-09-01T09:00:00Z" }), tenant_id: T },
      { ...change({ id: "z1" }), tenant_id: T },
      { ...change({ id: "o3", source: "outside", action_table: null, action_id: null, object_name: "THEIRS" }), tenant_id: OTHER },
    ];
    expect(await readFounderAdChanges(T, NOW)).toEqual([
      '2026-10-04: Turned on Meta ad set "40% to Turo" (was off) outside Zavi. The founder\'s decision: do not reverse it without asking.',
    ]);
  });
});

describe("a TikTok launch recorded as Zavi's change is never logged as the founder's", () => {
  const acct = { platform: "tiktok" as const, account_id: "7689989546330849300", spend: [], window: { since: "2026-10-01", until: "2026-10-05" } };
  const card = { tenant_id: T, exec_class: "tiktok_ads.create_launch", exec_status: "executed", executed_at: "2026-10-05T11:30:00Z", exec_payload: { advertiser_id: "7689989546330849300", name: "Spring" } };
  const storedOff = () => [
    stored({ object_id: "c9", platform: "tiktok", account_id: "7689989546330849300", level: "campaign", campaign_id: "c9", budget_kind: "none", budget_usd: null, status: "PAUSED" }),
    stored({ object_id: "g9", platform: "tiktok", account_id: "7689989546330849300", level: "ad_group", campaign_id: "c9", budget_usd: "25.00", status: "PAUSED" }),
  ];
  const readOn = () => ({
    ...acct,
    campaigns: [
      read({ object_id: "c9", level: "campaign", campaign_id: "c9", budget_kind: "none", budget_usd: null, status: "ACTIVE" }),
      read({ object_id: "g9", level: "ad_group", campaign_id: "c9", budget_usd: 25, status: "ACTIVE" }),
    ],
  });

  it("without the record, the switch-on of an ad group Zavi created reads as an outside change (the founder's)", async () => {
    tables.ad_campaigns = storedOff();
    tables.channel_actions = [card];
    expect(await logOutsideChanges(T, readOn(), NOW)).toBe(2);
  });

  it("with the launch's Zavi rows, nothing is logged as outside", async () => {
    tables.ad_campaigns = storedOff();
    tables.channel_actions = [card];
    tables.ad_object_changes = [
      { tenant_id: T, platform: "tiktok", source: "zavi", object_id: "c9", campaign_id: "c9", change_kind: "status", occurred_at: "2026-10-05T11:30:00Z" },
      { tenant_id: T, platform: "tiktok", source: "zavi", object_id: "g9", campaign_id: "c9", change_kind: "budget", occurred_at: "2026-10-05T11:30:00Z" },
    ];
    expect(await logOutsideChanges(T, readOn(), NOW)).toBe(0);
    expect(rpcCalls).toEqual([]);
  });

  it("an ad group Zavi did not create, changed outside Zavi, is still the founder's", async () => {
    tables.ad_campaigns = [stored({ object_id: "g7", platform: "tiktok", account_id: "7689989546330849300", level: "ad_group", campaign_id: "c7", budget_usd: "30.00" })];
    tables.ad_object_changes = [{ tenant_id: T, platform: "tiktok", source: "zavi", object_id: "g9", campaign_id: "c9", change_kind: "budget", occurred_at: "2026-10-05T11:30:00Z" }];
    const n = await logOutsideChanges(T, { ...acct, campaigns: [read({ object_id: "g7", level: "ad_group", campaign_id: "c7", budget_usd: 45 })] }, NOW);
    expect(n).toBe(1);
    expect((rpcCalls[0].args.p_changes as Row[])[0]).toMatchObject({ object_id: "g7", source: "outside", change_kind: "budget", before_daily_usd: 30, after_daily_usd: 45 });
  });
});
