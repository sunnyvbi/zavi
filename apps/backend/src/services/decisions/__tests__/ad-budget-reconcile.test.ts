import { describe, it, expect, vi, beforeEach } from "vitest";

const redditReads = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/reddit-ads/budget-ledger", () => ({ readRedditAccounts: redditReads }));
const redditMonitor = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/reddit-ads/monitor", () => ({ monitorRedditAds: redditMonitor }));
const xReads = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/x-ads/budget-ledger", () => ({ readXAccountsForBudget: xReads }));
const xMonitor = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/x-ads/budget-stop", () => ({ enforceXBudget: xMonitor }));
const extraReads = vi.hoisted(() => ({
  tiktok: vi.fn(), pinterest: vi.fn(), snapchat: vi.fn(), microsoft: vi.fn(), apple: vi.fn(), spotify: vi.fn(), linkedin: vi.fn(),
}));
vi.mock("@/services/connectors/tiktok-ads/budget-ledger", () => ({ readTiktokAccountsForBudget: extraReads.tiktok }));
vi.mock("@/services/connectors/pinterest-ads/budget-ledger", () => ({ readPinterestAccountsForBudget: extraReads.pinterest }));
vi.mock("@/services/connectors/snapchat-ads/budget-ledger", () => ({ readSnapchatAccountsForBudget: extraReads.snapchat }));
vi.mock("@/services/connectors/microsoft-ads/budget-ledger", () => ({ readMicrosoftAccountsForBudget: extraReads.microsoft }));
vi.mock("@/services/connectors/apple-ads/budget-ledger", () => ({ readAppleAccountsForBudget: extraReads.apple }));
vi.mock("@/services/connectors/spotify-ads/budget-ledger", () => ({ readSpotifyAccountsForBudget: extraReads.spotify }));
vi.mock("@/services/connectors/linkedin-ads/budget-ledger", () => ({ readLinkedinAccountsForBudget: extraReads.linkedin }));
const moneyBook = vi.hoisted(() => ({ on: false, store: vi.fn(async (_a: unknown) => ({ status: "stored" })) }));
vi.mock("@/services/decisions/ad-money-book-flag", () => ({ moneyBookShadowEnabled: () => moneyBook.on }));
vi.mock("@/services/decisions/ad-money-book-store", () => ({ storeMonthSnapshot: moneyBook.store }));
const founderAlerts = vi.hoisted(() => vi.fn(async () => ({ sent: 1, urgent_ids: [] })));
vi.mock("@/services/growth/cgo-blockers", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-blockers")>()),
  alertFounderSafely: founderAlerts,
}));

type Budget = {
  id: string;
  tenant_id: string;
  monthly_usd: number;
  month_cap_usd: number;
  spent_usd: number;
  month_start: string;
  created_at: string;
  status: "active" | "stopped";
  alarm_90_sent_at: string | null;
  read_failed?: Record<string, string>;
  read_failure_kinds?: Record<string, string>;
};
type LedgerCall = {
  tenant: string;
  platform: string;
  account: string;
  campaigns: Array<Record<string, unknown>>;
  spend: Array<{ object_id: string; spend_date: string; amount_usd: number; provisional: boolean }>;
};

const chatgptRead = vi.hoisted(() => vi.fn());
vi.mock("@/services/ads-wallet/chatgpt-ledger", () => ({ readChatgptAccountsForBudget: chatgptRead }));
const db = {
  budgets: [] as Budget[],
  today: "2026-10-05",
  rpcCalls: [] as string[],
  ledger: [] as LedgerCall[],
  ledgerFails: false,
  monthAccounts: [] as Array<{ platform: string; account_id: string; amount_usd?: number }>,
  monthAccountsFail: false,
  monthAccountPages: 0,
  connected: [] as Array<{ tenant_id: string; slug: string }>,
  accountBindings: [] as Array<{ tenant_id: string }>,
  stored: [] as Array<Record<string, unknown>>,
  zaviActs: [] as Array<Record<string, unknown>>,
  outside: [] as Array<{ tenant: string; rows: Array<Record<string, unknown>> }>,
  liveSync: [] as Array<{ tenant: string; platforms: string[]; readStartedAt?: unknown }>,
  dbNow: "2026-10-12T10:07:00.000Z" as string | Error,
  tenantName: "Acme Rentals" as string | null | Error,
};
const monthOf = (d: string) => `${d.slice(0, 7)}-01`;

function startMonth(args: Record<string, unknown>) {
  const b = db.budgets.find((x) => x.id === args.p_budget_id && x.tenant_id === args.p_tenant_id);
  if (!b) return { status: "not_found" };
  if (b.status !== "active") return { status: b.status };
  const month = monthOf(db.today);
  let rolled = false;
  if (b.month_start < month) {
    Object.assign(b, { month_start: month, spent_usd: 0, alarm_90_sent_at: null, month_cap_usd: b.monthly_usd });
    rolled = true;
  }
  return {
    status: "active",
    rolled,
    month_start: b.month_start,
    month_cap_usd: b.month_cap_usd,
    monthly_usd: b.monthly_usd,
    pause: [],
    paused_before: [],
    note_due: false,
  };
}

function recordActual(args: Record<string, unknown>) {
  const b = db.budgets.find((x) => x.id === args.p_budget_id && x.tenant_id === args.p_tenant_id);
  if (!b) return { status: "not_found", alarm: false };
  if (b.status !== "active") return { status: b.status, spent_usd: b.spent_usd, month_cap_usd: b.month_cap_usd, alarm: false };
  if (b.month_start !== monthOf(db.today)) return { status: "month_not_started", alarm: false };
  if (args.p_actual_usd !== null && args.p_actual_usd !== undefined && args.p_month === b.month_start) {
    b.spent_usd = Math.max(b.spent_usd, Math.ceil(Number(args.p_actual_usd) * 100) / 100);
  }
  let alarm = false;
  if (b.alarm_90_sent_at === null && b.spent_usd >= b.month_cap_usd * 0.9) {
    b.alarm_90_sent_at = "now";
    alarm = true;
  }
  return { status: b.status, spent_usd: b.spent_usd, month_cap_usd: b.month_cap_usd, alarm };
}

vi.mock("@/services/tenant-client", () => {
  const query = (rows: () => Array<Record<string, unknown>>) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const q = {
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      maybeSingle: async () => ({ data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
      like: () => q,
      or: () => q,
      gte: () => q,
      gt: () => q,
      lt: () => q,
      order: () => q,
      limit: () => q,
      then: (ok: (v: unknown) => unknown) => ok({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return q;
  };
  return {
    asTenantId: (t: string) => t,
    globalClient: () => {
      throw new Error("globalClient not available in this test");
    },
    tenantStorage: () => {
      throw new Error("tenantStorage not available in this test");
    },
    preTenantRpc: async () => ({ data: null, error: { message: "preTenantRpc not mocked" } }),
    applySecretListEditRpc: async () => ({ data: null, error: { message: "applySecretListEditRpc not mocked" } }),
    tenantMarkerAt: async () => null,
    stampTenantMarker: async () => undefined,
    clearTenantMarker: async () => undefined,
    fleetSweepClient: () => ({
      from: (t: string) => {
        if (t === "ads_wallets") return { select: () => query(() => []) };
        if (t === "ads_account_bindings") return { select: () => query(() => db.accountBindings) };
        if (t === "connector_metadata") return { select: () => query(() => db.connected) };
        if (t !== "ad_budgets") throw new Error(`unexpected table ${t}`);
        return { select: () => query(() => db.budgets as unknown as Array<Record<string, unknown>>) };
      },
    }),
    tenantClient: (tid: string) => ({
      from: (t: string) => {
        if (t === "tenants")
          return {
            select: () => ({
              maybeSingle: async () => {
                if (db.tenantName instanceof Error) throw db.tenantName;
                return {
                  data: db.tenantName === null ? null : { display_name: db.tenantName, slug: `slug-${tid.slice(0, 4)}` },
                  error: null,
                };
              },
            }),
          };
        const rows =
          t === "ads_wallets" || t === "ads_campaign_funding" || t === "tenant_channels" ? [] : t === "ad_campaigns" ? db.stored : t === "channel_actions" ? db.zaviActs : t === "ad_object_changes" || t === "decisions" ? [] : null;
        if (t === "ad_budgets")
          return {
            select: () => query(() => db.budgets.filter((r) => r.tenant_id === tid) as unknown as Array<Record<string, unknown>>),
            update: (vals: Partial<Budget>) => ({
              eq: async (c: string, v: unknown) => {
                for (const r of db.budgets) if (r.tenant_id === tid && (r as unknown as Record<string, unknown>)[c] === v) Object.assign(r, vals);
                return { data: null, error: null };
              },
            }),
          };
        if (t === "ad_spend_daily") {
          const q: Record<string, unknown> = {};
          for (const m of ["eq", "gte", "gt", "lt", "order"]) q[m] = () => q;
          q.range = async (from: number, to: number) => {
            db.monthAccountPages++;
            return db.monthAccountsFail ? { data: null, error: { message: "ledger down" } } : { data: db.monthAccounts.slice(from, to + 1), error: null };
          };
          return { select: () => q };
        }
        if (!rows) throw new Error(`unexpected table ${t}`);
        return { select: () => query(() => rows.filter((r) => r.tenant_id === tid)) };
      },
    }),
    tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
      if (name === "ad_budget_read_start") {
        return db.dbNow instanceof Error ? { data: null, error: { message: db.dbNow.message } } : { data: db.dbNow, error: null };
      }
      if (name === "sync_ad_holds_to_live") {
        db.liveSync.push({ tenant: tid, platforms: args.p_platforms as string[], readStartedAt: args.p_read_started_at });
        return { data: { status: "done", released: 1, released_daily_usd: 136.12, lowered: 1 }, error: null };
      }
      db.rpcCalls.push(name);
      const full: Record<string, unknown> = { ...args, p_tenant_id: tid };
      const b = db.budgets.find((x) => x.id === full.p_budget_id && x.tenant_id === tid);
      if (name === "start_ad_budget_month") return { data: startMonth(full), error: null };
      if (name === "record_ad_budget_actual") return { data: recordActual(full), error: null };
      if (name === "record_ad_budget_partial_actual_v2") {
        const failed = full.p_failed_platforms as string[];
        const known = db.ledger.filter((l) => failed.includes(l.platform)).flatMap((l) => l.spend).reduce((a, x) => a + x.amount_usd, 0);
        if (b) {
          b.read_failed = Object.fromEntries(failed.map((p) => [p, b.read_failed?.[p] ?? NOW.toISOString()]));
          b.spent_usd = Math.max(b.spent_usd, Math.ceil((Number(full.p_actual_usd) + known) * 100) / 100);
        }
        return { data: recordActual({ ...full, p_actual_usd: null }), error: null };
      }
      if (name === "clear_ad_budget_read_failed_platforms") {
        if (b) b.read_failed = {};
        return { data: null, error: null };
      }
      if (name === "record_ad_ledger_read") {
        if (db.ledgerFails) return { data: null, error: { message: "boom" } };
        db.ledger.push({
          tenant: tid,
          platform: String(full.p_platform),
          account: String(full.p_account_id),
          campaigns: full.p_campaigns as LedgerCall["campaigns"],
          spend: full.p_spend as LedgerCall["spend"],
        });
        return { data: { status: "recorded" }, error: null };
      }
      if (name === "record_ad_object_changes") {
        db.outside.push({ tenant: tid, rows: full.p_changes as Array<Record<string, unknown>> });
        return { data: { status: "recorded", inserted: (full.p_changes as unknown[]).length }, error: null };
      }
      if (name === "release_ad_budget_alarm") {
        if (b) b.alarm_90_sent_at = null;
        return { data: { status: b ? "released" : "not_found" }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
});

class NotConnected extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const metaConnected = { on: true };
const metaFacts = vi.fn(async (): Promise<Record<string, unknown>> => ({ currency: "USD", timezone_offset_hours_utc: -7 }));
const metaCampaigns = vi.fn(async (): Promise<unknown[]> => []);
const metaAdSets = vi.fn(async (): Promise<unknown[]> => []);
const metaSeries = vi.fn();
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: async () => {
    if (!metaConnected.on) throw new NotConnected("meta_ads_not_connected");
    return { access_token: "t", ad_account_id: "act_1" };
  },
  fbGet: () => metaFacts(),
  fbGetAllPages: (_t: string, path: string) => {
    if (path !== "act_1/campaigns") throw new Error(`unexpected edge ${path}`);
    return metaCampaigns();
  },
}));
vi.mock("@/services/tools/meta-ads/list_ad_sets", () => ({
  enumerateAccountAdSets: () => metaAdSets(),
}));
vi.mock("@/services/tools/meta-ads/daily_series", () => ({
  fetchMetaDailySeries: (...a: unknown[]) => metaSeries(...a),
}));

const googleConnected = { on: true };
const googleConfigured = { on: true };
const vaultCustomerId = { value: "9" as string | null };
vi.mock("@/services/secrets/vault", () => ({ getSecret: async () => vaultCustomerId.value }));
const googleCurrency = { code: "USD" as string | null };
const googleCampaigns = vi.fn(async (): Promise<unknown[]> => []);
const googleCost = vi.fn(async (): Promise<unknown[]> => []);
const gadsSearch = vi.fn(async (_t: string, q: string, _opts?: unknown) =>
  q.includes("metrics.cost_micros") ? googleCost() : googleCampaigns(),
);
vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsCustomerId: async () => {
    if (!googleConfigured.on) throw new NotConnected("google_ads_not_configured");
    if (!googleConnected.on) throw new NotConnected("google_ads_not_connected");
    return "9";
  },
  gadsGetBudgetGuardFacts: async () => ({ currency_code: googleCurrency.code, budget_period: null }),
  gadsSearch: (...a: unknown[]) => (gadsSearch as (...x: unknown[]) => unknown)(...a),
}));
const googleClock = vi.fn(async () => ({ time_zone: "America/Los_Angeles", date: "2026-10-05" }));
vi.mock("@/services/tools/google-ads/_read-window", () => ({
  accountClock: () => googleClock(),
}));

const metaSetStatus = vi.fn();
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: (...a: unknown[]) => metaSetStatus(...a) }));
const googleSetStatus = vi.fn();
vi.mock("@/services/tools/google-ads/write/set_status", () => ({
  googleSetCampaignStatus: (...a: unknown[]) => googleSetStatus(...a),
}));

const sgSend = vi.fn(async () => undefined);
const ownerEmail = vi.fn(async (): Promise<string | null> => "founder@example.com");
vi.mock("@/email/sendAuthEmail", () => ({
  resolveTenantOwnerEmail: () => ownerEmail(),
  sgSend: (...a: unknown[]) => (sgSend as (...x: unknown[]) => Promise<void>)(...a),
}));

const brake = vi.fn(async (_b: unknown, _accounts: unknown, _deps: unknown) => ({ status: "on_track" as const, projected_usd: 0, cap_usd: 0 }));
const holdResolver = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../ad-hold-resolve", async (orig) => {
  const m = await orig<typeof import("../ad-hold-resolve")>();
  return { ...m, resolveUnknownAdHolds: (...a: Parameters<typeof m.resolveUnknownAdHolds>) => { holdResolver.calls += 1; return m.resolveUnknownAdHolds(...a); } };
});
vi.mock("../ad-budget-brake", () => ({ runBudgetBrake: (b: unknown, accounts: unknown, deps: unknown) => brake(b, accounts, deps) }));

import { AdAccountLostError } from "@/services/connectors/core/read-error-kind";
import { accountMonthWindow, monthReadStart, reconcileBudget, reconcileRetry, renderAdBudgetAlarm, runAdBudgetReconcile, listConnectedAdTenants, reconcileReadFailedBudgets, reconcileLedgerOnly } from "../ad-budget-reconcile";

const retryWaits = { n: 0 };
reconcileRetry.wait = async () => {
  retryWaits.n++;
};

it("discovers customer API-key advertisers without a connector or wallet",async()=>{
  db.accountBindings=[{tenant_id:"customer-only"},{tenant_id:"customer-only"}];
  expect(await listConnectedAdTenants()).toEqual(["customer-only"]);
});

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-05T12:00:00Z");

function budget(over: Partial<Budget> = {}): Budget {
  return {
    id: "b1",
    tenant_id: T,
    monthly_usd: 1000,
    month_cap_usd: 1000,
    spent_usd: 0,
    month_start: "2026-10-01",
    created_at: "2026-09-20T18:00:00Z",
    status: "active",
    alarm_90_sent_at: null,
    ...over,
  };
}

function metaRows(rows: Array<[string, string, number]>, truncated = false) {
  return {
    rows: rows.map(([ad_set_id, date, spend_usd]) => ({ ad_set_id, date, spend_usd, campaign_id: "c" })),
    time_range: {},
    truncated,
  };
}
const costRows = (rows: Array<[string, string, string]>) =>
  rows.map(([id, date, costMicros]) => ({ campaign: { id }, segments: { date }, metrics: { costMicros } }));
const notes = (subject: string) =>
  (sgSend.mock.calls as unknown as Array<[string, string, string, string]>).filter((c) => c[1] === subject);
const alarmNotes = () =>
  (sgSend.mock.calls as unknown as Array<[string, string, string, string]>).filter((c) =>
    /ad budget used \(\d+%\)$/.test(c[1]),
  );
const ledgerOf = (platform: string) => db.ledger.find((l) => l.platform === platform);

beforeEach(() => {
  retryWaits.n = 0;
  googleConfigured.on = true;
  vaultCustomerId.value = "9";
});
beforeEach(() => {
  chatgptRead.mockReset().mockResolvedValue(null);
  redditReads.mockReset();
  redditReads.mockResolvedValue([]);
  redditMonitor.mockReset();
  xReads.mockReset();
  xReads.mockResolvedValue([]);
  xMonitor.mockReset();
  for (const f of Object.values(extraReads)) f.mockReset().mockResolvedValue([]);
  founderAlerts.mockClear();
  db.budgets = [];
  db.today = "2026-10-05";
  db.rpcCalls = [];
  db.ledger = [];
  db.ledgerFails = false;
  db.monthAccounts = [];
  db.monthAccountsFail = false;
  db.monthAccountPages = 0;
  db.connected = [];
  db.accountBindings = [];
  db.stored = [];
  db.zaviActs = [];
  db.outside = [];
  db.liveSync = [];
  db.dbNow = "2026-10-12T10:07:00.000Z";
  db.tenantName = "Acme Rentals";
  metaConnected.on = true;
  googleConnected.on = true;
  googleCurrency.code = "USD";
  metaFacts.mockReset();
  metaFacts.mockImplementation(async () => ({ currency: "USD", timezone_offset_hours_utc: -7 }));
  metaCampaigns.mockReset();
  metaCampaigns.mockResolvedValue([]);
  metaAdSets.mockReset();
  metaAdSets.mockResolvedValue([]);
  metaSeries.mockReset();
  metaSeries.mockResolvedValue(metaRows([]));
  googleCampaigns.mockReset();
  googleCampaigns.mockResolvedValue([]);
  googleCost.mockReset();
  googleCost.mockResolvedValue([]);
  gadsSearch.mockClear();
  googleClock.mockReset();
  googleClock.mockImplementation(async () => ({ time_zone: "America/Los_Angeles", date: "2026-10-05" }));
  sgSend.mockReset();
  sgSend.mockImplementation(async () => undefined);
  ownerEmail.mockReset();
  ownerEmail.mockImplementation(async () => "founder@example.com");
  metaSetStatus.mockClear();
  googleSetStatus.mockClear();
  brake.mockClear();
});

describe("hourly read of EVERYTHING in the connected accounts", () => {
  it("no active budget: no platform call, no RPC", async () => {
    db.budgets = [budget({ status: "stopped" })];
    const out = await runAdBudgetReconcile(NOW);
    expect(out.budgets).toBe(0);
    expect(metaSeries).not.toHaveBeenCalled();
    expect(gadsSearch).not.toHaveBeenCalled();
    expect(db.rpcCalls).toEqual([]);
    expect(redditMonitor).not.toHaveBeenCalled();
  });

  it("a budget that holds nothing still reads both accounts, and every object's spend counts", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(
      metaRows([
        ["as1", "2026-10-01", 10],
        ["as1", "2026-10-02", 12.5],
        ["as-by-hand", "2026-10-05", 3.33],
      ]),
    );
    googleCost.mockResolvedValue(costRows([["42", "2026-10-04", "7250000"], ["77", "2026-10-05", "1000000"]]));

    const out = await runAdBudgetReconcile(NOW);

    expect(out).toMatchObject({ recorded: 1, read_failed: 0, ledger_failed: 0 });
    expect(metaSeries).toHaveBeenCalledTimes(1);
    const metaOpts = metaSeries.mock.calls[0][1] as Record<string, unknown>;
    expect(metaOpts).toMatchObject({ level: "adset", all_pages: true, time_range: { since: "2026-09-30", until: "2026-10-05" } });
    expect(metaOpts.filter).toBeUndefined();
    const costQuery = gadsSearch.mock.calls.map((c) => String(c[1])).find((q) => q.includes("metrics.cost_micros"))!;
    expect(costQuery).toContain("BETWEEN '2026-09-30' AND '2026-10-05'");
    expect(costQuery).not.toContain("campaign.id IN");
    for (const c of gadsSearch.mock.calls) expect(c[2]).toEqual({ complete: true });

    expect(db.budgets[0].spent_usd).toBe(34.08);
    expect(db.rpcCalls).toEqual(["start_ad_budget_month", "record_ad_ledger_read", "record_ad_ledger_read", "record_ad_budget_actual", "clear_ad_budget_read_failed_platforms"]);
    expect(ledgerOf("meta")!.spend).toEqual([
      { object_id: "as1", spend_date: "2026-10-01", amount_usd: 10, provisional: false },
      { object_id: "as1", spend_date: "2026-10-02", amount_usd: 12.5, provisional: false },
      { object_id: "as-by-hand", spend_date: "2026-10-05", amount_usd: 3.33, provisional: true },
    ]);
    expect(ledgerOf("google")).toMatchObject({ account: "9", tenant: T });
    expect(ledgerOf("google")!.spend).toEqual([
      { object_id: "42", spend_date: "2026-10-04", amount_usd: 7.25, provisional: false },
      { object_id: "77", spend_date: "2026-10-05", amount_usd: 1, provisional: true },
    ]);
  });

  it("the inventory: every ad set and campaign with its budget kind; an ad set under a campaign budget carries the campaign's daily budget", async () => {
    db.budgets = [budget()];
    metaCampaigns.mockResolvedValue([
      { id: "cbo", daily_budget: "50000" },
      { id: "abo", daily_budget: null, lifetime_budget: "0" },
    ]);
    metaAdSets.mockResolvedValue([
      { id: "as-daily", name: "Daily", campaign_id: "abo", daily_budget: "2500", effective_status: "ACTIVE" },
      { id: "as-life", name: "Life", campaign_id: "abo", lifetime_budget: "100000", effective_status: "PAUSED" },
      { id: "as-cbo", name: "On campaign", campaign_id: "cbo", effective_status: "ACTIVE" },
      { id: "as-none", campaign_id: "abo", effective_status: "ACTIVE" },
    ]);
    googleCampaigns.mockResolvedValue([
      { campaign: { id: "1", name: "Search", status: "ENABLED" }, campaignBudget: { amountMicros: "40000000", period: "DAILY" } },
      { campaign: { id: "2", name: "Shared", status: "ENABLED" }, campaignBudget: { amountMicros: "90000000", period: "DAILY", explicitlyShared: true } },
      { campaign: { id: "3", name: "Total", status: "PAUSED" }, campaignBudget: { totalAmountMicros: "500000000", period: "CUSTOM_PERIOD" } },
    ]);

    await runAdBudgetReconcile(NOW);

    expect(ledgerOf("meta")).toMatchObject({ account: "act_1" });
    expect(ledgerOf("meta")!.campaigns).toEqual([
      { object_id: "as-daily", level: "ad_set", campaign_id: "abo", name: "Daily", budget_kind: "daily", budget_usd: 25, campaign_budget_usd: null, status: "ACTIVE", currency: "USD" },
      { object_id: "as-life", level: "ad_set", campaign_id: "abo", name: "Life", budget_kind: "lifetime", budget_usd: 1000, campaign_budget_usd: null, status: "PAUSED", currency: "USD" },
      { object_id: "as-cbo", level: "ad_set", campaign_id: "cbo", name: "On campaign", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: 500, status: "ACTIVE", currency: "USD" },
      { object_id: "as-none", level: "ad_set", campaign_id: "abo", name: null, budget_kind: "none", budget_usd: null, campaign_budget_usd: null, status: "ACTIVE", currency: "USD" },
    ]);
    expect(ledgerOf("google")!.campaigns).toEqual([
      { object_id: "1", level: "campaign", campaign_id: "1", name: "Search", budget_kind: "daily", budget_usd: 40, status: "ENABLED", currency: "USD" },
      { object_id: "2", level: "campaign", campaign_id: "2", name: "Shared", budget_kind: "shared", budget_usd: null, status: "ENABLED", currency: "USD" },
      { object_id: "3", level: "campaign", campaign_id: "3", name: "Total", budget_kind: "lifetime", budget_usd: 500, status: "PAUSED", currency: "USD" },
    ]);
  });

  it("the month's sum counts only the month's own account days: a UTC-7 account's Sep 30 is not October", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(
      metaRows([
        ["as1", "2026-09-30", 302.91],
        ["as1", "2026-10-01", 1200],
        ["as1", "2026-10-02", 1308.17],
      ]),
    );
    googleCost.mockResolvedValue(costRows([["42", "2026-09-30", "50000000"]]));
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].spent_usd).toBe(2508.17);
    expect(ledgerOf("meta")!.spend.map((r) => r.spend_date)).toContain("2026-09-30");
    expect(ledgerOf("google")!.spend.map((r) => r.spend_date)).toEqual(["2026-09-30"]);
  });

  it("an account behind UTC still on Sep 30 when the UTC month turns adds nothing to October", async () => {
    db.budgets = [budget({ month_start: "2026-09-01", spent_usd: 900 })];
    db.today = "2026-10-01";
    googleClock.mockResolvedValue({ time_zone: "America/Los_Angeles", date: "2026-09-30" });
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-09-30", 40]]));
    googleCost.mockResolvedValue(costRows([["42", "2026-09-30", "10000000"]]));
    await runAdBudgetReconcile(new Date("2026-10-01T03:00:00Z"));
    expect(db.budgets[0]).toMatchObject({ month_start: "2026-10-01", spent_usd: 0 });
    expect(ledgerOf("meta")!.spend).toHaveLength(1);
  });

  it("an account ahead of UTC already on Nov 1 does not count Nov 1 in October", async () => {
    db.budgets = [budget()];
    db.today = "2026-10-31";
    metaFacts.mockResolvedValue({ currency: "USD", timezone_offset_hours_utc: 13 });
    googleClock.mockResolvedValue({ time_zone: "Pacific/Auckland", date: "2026-11-01" });
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-31", 70], ["as1", "2026-11-01", 15]]));
    await runAdBudgetReconcile(new Date("2026-10-31T20:00:00Z"));
    expect(db.budgets[0].spent_usd).toBe(70);
  });

  it("across a daylight-saving change the first-month read starts on the account's own day", async () => {
    db.budgets = [budget({ month_start: "2026-03-01", created_at: "2026-03-08T07:30:00Z" })];
    db.today = "2026-03-20";
    metaFacts.mockResolvedValue({ currency: "USD", timezone_name: "America/Los_Angeles", timezone_offset_hours_utc: -7 });
    googleClock.mockResolvedValue({ time_zone: "America/Los_Angeles", date: "2026-03-20" });
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-03-07", 5], ["as1", "2026-03-08", 6]]));
    await runAdBudgetReconcile(new Date("2026-03-20T12:00:00Z"));
    expect(metaSeries.mock.calls[0][1]).toMatchObject({ time_range: { since: "2026-03-07", until: "2026-03-20" } });
    expect(db.budgets[0].spent_usd).toBe(11);
  });

  it("accountMonthWindow: account dates clipped to the budget month", () => {
    expect(accountMonthWindow("2026-10-01", { since: "2026-09-30", until: "2026-10-05" })).toEqual({ since: "2026-10-01", until: "2026-10-05" });
    expect(accountMonthWindow("2026-10-01", { since: "2026-09-30", until: "2026-09-30" })).toBeNull();
    expect(accountMonthWindow("2026-10-01", { since: "2026-10-01", until: "2026-11-01" })).toEqual({ since: "2026-10-01", until: "2026-10-31" });
    expect(accountMonthWindow("2026-02-01", { since: "2026-02-10", until: "2026-03-01" })).toEqual({ since: "2026-02-10", until: "2026-02-28" });
    expect(() => accountMonthWindow("2026-10-05", { since: "2026-10-05", until: "2026-10-05" })).toThrow();
  });

  it("an account AHEAD of UTC starts on Oct 1 and reads through its own today", async () => {
    db.budgets = [budget()];
    metaFacts.mockResolvedValue({ currency: "USD", timezone_offset_hours_utc: 13 });
    googleClock.mockResolvedValue({ time_zone: "Pacific/Auckland", date: "2026-10-06" });
    await runAdBudgetReconcile(new Date("2026-10-05T20:00:00Z"));
    expect(metaSeries.mock.calls[0][1]).toMatchObject({ time_range: { since: "2026-10-01", until: "2026-10-06" } });
    expect(gadsSearch.mock.calls.map((c) => String(c[1])).join("\n")).toContain("BETWEEN '2026-10-01' AND '2026-10-06'");
  });

  it("in the budget's first month the read starts when the budget did", async () => {
    db.budgets = [budget({ created_at: "2026-10-03T18:00:00Z" })];
    await runAdBudgetReconcile(NOW);
    expect(metaSeries.mock.calls[0][1]).toMatchObject({ time_range: { since: "2026-10-03", until: "2026-10-05" } });
    expect(monthReadStart("2026-10-01", "2026-10-03T18:00:00Z").toISOString()).toBe("2026-10-03T18:00:00.000Z");
    expect(monthReadStart("2026-11-01", "2026-10-03T18:00:00Z").toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("a platform that is not connected is not read and adds nothing", async () => {
    db.budgets = [budget()];
    googleConnected.on = false;
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 20]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.recorded).toBe(1);
    expect(gadsSearch).not.toHaveBeenCalled();
    expect(db.ledger.map((l) => l.platform)).toEqual(["meta"]);
    expect(db.budgets[0].spent_usd).toBe(20);

    metaConnected.on = false;
    googleConnected.on = true;
    googleCost.mockResolvedValue(costRows([["42", "2026-10-02", "30000000"]]));
    await runAdBudgetReconcile(NOW);
    expect(metaSeries).toHaveBeenCalledTimes(1);
    expect(db.budgets[0].spent_usd).toBe(30);
  });

  it("Google settings missing on the deployment: a tenant that connected Google fails Google's read (Meta still counts), one that never did is skipped", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 20]]));
    googleConfigured.on = false;
    vaultCustomerId.value = "9";
    expect((await runAdBudgetReconcile(NOW)).read_failed).toBe(1);
    expect(db.budgets[0].spent_usd).toBe(20);
    expect(Object.keys(db.budgets[0].read_failed ?? {})).toEqual(["google"]);

    vaultCustomerId.value = null;
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].spent_usd).toBe(20);
    googleConfigured.on = true;
    vaultCustomerId.value = "9";
  });

  it("a failed page on one platform: the other platform still counts and writes its ledger; the failed one keeps its last ledger spend", async () => {
    db.budgets = [budget({ spent_usd: 300 })];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 500]]));
    googleCost.mockRejectedValue(Object.assign(new Error("Google Ads search returned more than 10 pages"), { code: "google_ads_query_truncated" }));
    const before = holdResolver.calls;
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(1);
    expect(holdResolver.calls).toBe(before + 1);
    expect(db.budgets[0].spent_usd).toBe(500);
    expect(db.ledger.map((l) => l.platform)).toEqual(["meta"]);
    expect(db.rpcCalls).toEqual(["start_ad_budget_month", "record_ad_ledger_read", "record_ad_budget_partial_actual_v2"]);
  });

  it("a Meta list that cannot be read whole fails the read", async () => {
    db.budgets = [budget({ spent_usd: 40 })];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 900]]));
    metaAdSets.mockRejectedValue(Object.assign(new Error("Meta act_1/adsets: more than 100 pages"), { code: "meta_ads_pagination_incomplete" }));
    expect((await runAdBudgetReconcile(NOW)).read_failed).toBe(1);

    metaAdSets.mockResolvedValue([]);
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 900]], true));
    expect((await runAdBudgetReconcile(NOW)).read_failed).toBe(1);

    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 900]]));
    metaFacts.mockResolvedValue({ currency: "USD" });
    expect((await runAdBudgetReconcile(NOW)).read_failed).toBe(1);

    expect(db.budgets[0].spent_usd).toBe(40);
    expect(db.ledger.filter((l) => l.platform === "meta")).toEqual([]);
  });

  it("an account that is not in USD fails the read", async () => {
    db.budgets = [budget({ spent_usd: 40 })];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 900]]));
    metaFacts.mockResolvedValue({ currency: "EUR", timezone_offset_hours_utc: 1 });
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(1);
    expect(metaSeries).not.toHaveBeenCalled();

    expect(db.ledger.map((l) => l.platform)).toEqual(["google"]);

    db.ledger = [];
    metaFacts.mockResolvedValue({ currency: "USD", timezone_offset_hours_utc: -7 });
    googleCurrency.code = "CAD";
    expect((await runAdBudgetReconcile(NOW)).read_failed).toBe(1);
    googleCurrency.code = null;
    expect((await runAdBudgetReconcile(NOW)).read_failed).toBe(1);
    expect(db.budgets[0].spent_usd).toBe(900);
    expect(db.ledger.filter((l) => l.platform === "google")).toEqual([]);
  });

  it("a ledger write that fails is reported but does not hold back spent", async () => {
    db.budgets = [budget()];
    db.ledgerFails = true;
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 60]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out).toMatchObject({ recorded: 1, ledger_failed: 2 });
    expect(db.budgets[0].spent_usd).toBe(60);
  });

  it("a lower reading never lowers spent; Google micro-dollars round UP", async () => {
    db.budgets = [budget({ spent_usd: 300 })];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 200]]));
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].spent_usd).toBe(300);

    db.budgets = [budget()];
    db.ledger = [];
    metaSeries.mockResolvedValue(metaRows([]));
    googleCost.mockResolvedValue(costRows([["42", "2026-10-02", "9004000"]]));
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].spent_usd).toBe(9.01);
    expect(ledgerOf("google")!.spend[0].amount_usd).toBe(9.01);
  });
});

describe("the 90% alarm, once per month", () => {
  it("fires once in a month, not on later hours, in plain English", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 850]]));
    await runAdBudgetReconcile(NOW);
    expect(sgSend).not.toHaveBeenCalled();

    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 905]]));
    const first = await runAdBudgetReconcile(NOW);
    expect(first.alarms).toBe(1);
    const [to, subject, html, text] = sgSend.mock.calls[0] as unknown as [string, string, string, string];
    expect(to).toBe("founder@example.com");
    expect(subject).toBe("Acme Rentals: $905 of your $1,000 ad budget used (90%)");
    expect(html).not.toMatch(/enforc/i);
    expect(text).toBe(
      [
        "Acme Rentals has used $905.00 of its $1,000.00 ad budget this month. Autopilot stops adding spend at the limit, but ads that are already running keep spending until you lower or pause them.",
        "",
        "The full amount comes back on the 1st.",
        "",
        `Lower or pause running ads: http://localhost:3000/workspace?tab=growth-strategy&company=${T}#ad-budget`,
      ].join("\n"),
    );

    await runAdBudgetReconcile(NOW);
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 950]]));
    await runAdBudgetReconcile(NOW);
    expect(alarmNotes()).toHaveLength(1);
  });

  it("fires again the next month: the rollover re-arms it", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 950]]));
    await runAdBudgetReconcile(NOW);
    expect(alarmNotes()).toHaveLength(1);

    db.today = "2026-11-28";
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-11-20", 920]]));
    const out = await runAdBudgetReconcile(new Date("2026-11-28T12:00:00Z"));
    expect(out.rolled).toBe(1);
    expect(db.budgets[0].month_start).toBe("2026-11-01");
    expect(db.budgets[0].spent_usd).toBe(920);
    expect(alarmNotes()).toHaveLength(2);
  });

  it("a failed send, or no owner email, gives the claim back so the next hour retries once", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 950]]));
    sgSend.mockRejectedValueOnce(new Error("sendgrid 503"));
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].alarm_90_sent_at).toBeNull();
    ownerEmail.mockResolvedValueOnce(null);
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].alarm_90_sent_at).toBeNull();
    await runAdBudgetReconcile(NOW);
    await runAdBudgetReconcile(NOW);
    expect(sgSend).toHaveBeenCalledTimes(2);
    expect(db.budgets[0].alarm_90_sent_at).not.toBeNull();
  });

  const URL = `http://localhost:3000/workspace?tab=growth-strategy&company=${T}#ad-budget`;

  it("the alarm names this month's cap, the company and the real percent", () => {
    const r = renderAdBudgetAlarm(22500, 25000, { companyName: "Acme Rentals", url: URL });
    expect(r.text).toContain("$22,500.00 of its $25,000.00 ad budget this month");
    expect(r.subject).toBe("Acme Rentals: $22,500 of your $25,000 ad budget used (90%)");
    expect(renderAdBudgetAlarm(970, 1000, { companyName: null, url: URL }).subject).toBe(
      "$970 of your $1,000 ad budget used (97%)",
    );
    const over = renderAdBudgetAlarm(1040, 1000, { companyName: null, url: URL });
    expect(over.subject).toContain("(104%)");
    expect(over.html).toContain("Your monthly budget is <em>used up</em>");
  });

  it("the alarm: a button to the real budget page, the 1st said once, the preheader is not the subject", () => {
    const r = renderAdBudgetAlarm(902.15, 1000, { companyName: "Acme Rentals", url: URL });
    expect(r.html).toContain(`href="${URL.replace(/&/g, "&amp;")}"`);
    expect(r.html).toContain(">Lower or pause running ads</a>");
    expect(r.html).toContain("Acme Rentals · 90% used");
    expect(r.html).toContain("ads that are already running keep spending until you lower or pause them");
    expect(r.html.match(/on the 1st/g)).toHaveLength(2);
    expect(r.html).not.toContain("The monthly amount resets on the 1st.");
    const pre = /display:none[^>]*>([^<]*)</.exec(r.html)?.[1];
    expect(pre).toBeTruthy();
    expect(pre).not.toBe(r.subject);
    expect(`${r.subject}\n${r.text}\n${r.html}`).not.toMatch(/[\u2013\u2014]|--/);
  });

  it("the alarm escapes a company name and keeps line breaks out of the subject", () => {
    const r = renderAdBudgetAlarm(950, 1000, { companyName: "A&B <Ads>\r\nBcc: x@y.z", url: URL });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.subject.startsWith("A&B <Ads> Bcc: x@y.z: ")).toBe(true);
    expect(r.html).toContain("A&amp;B &lt;Ads&gt; Bcc: x@y.z · 95% used");
    expect(r.html).not.toContain("<Ads>");
  });

  it("a blank display name falls back to the slug, the same name the CGO note uses", async () => {
    db.tenantName = "  ";
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 905]]));
    await runAdBudgetReconcile(NOW);
    const [, subject] = sgSend.mock.calls[0] as unknown as [string, string, string, string];
    expect(subject).toBe(`slug-${T.slice(0, 4)}: $905 of your $1,000 ad budget used (90%)`);
  });

  it("a company-name read that THROWS never holds up the alarm: it goes out without the company", async () => {
    db.tenantName = new Error("tenants read timed out");
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 905]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.alarms).toBe(1);
    expect(sgSend).toHaveBeenCalledTimes(1);
    const [, subject, html] = sgSend.mock.calls[0] as unknown as [string, string, string, string];
    expect(subject).toBe("$905 of your $1,000 ad budget used (90%)");
    expect(html).toContain(URL.replace(/&/g, "&amp;"));
    expect(db.budgets[0].alarm_90_sent_at).not.toBeNull();
  });

  it("no tenant row: the alarm still goes out, worded without a company", async () => {
    db.tenantName = null;
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 905]]));
    await runAdBudgetReconcile(NOW);
    const [, subject, , text] = sgSend.mock.calls[0] as unknown as [string, string, string, string];
    expect(subject).toBe("$905 of your $1,000 ad budget used (90%)");
    expect(text).toMatch(/^You have used \$905\.00 of your \$1,000\.00 ad budget this month\./);
    expect(text).toContain(URL);
  });
});

describe("the rollover on the 1st", () => {
  const NOV1 = new Date("2026-11-01T00:07:00Z");
  beforeEach(() => {
    db.today = "2026-11-01";
  });

  it("a new month at spent 0 with the alarm re-armed, read after the reset", async () => {
    db.budgets = [budget({ monthly_usd: 3000, month_cap_usd: 1100, spent_usd: 1050, month_start: "2026-10-01", alarm_90_sent_at: "x" })];
    googleClock.mockResolvedValue({ time_zone: "America/Los_Angeles", date: "2026-10-31" });
    const out = await runAdBudgetReconcile(NOV1);
    expect(out.rolled).toBe(1);
    expect(db.budgets[0]).toMatchObject({ month_start: "2026-11-01", spent_usd: 0, month_cap_usd: 3000, alarm_90_sent_at: null });
    expect(db.rpcCalls[0]).toBe("start_ad_budget_month");
  });

  it("the month does not fit the live ads: nothing is paused and no note is sent (the brake lowers, never pauses)", async () => {
    db.budgets = [budget({ monthly_usd: 500, month_start: "2026-10-01" })];
    metaAdSets.mockResolvedValue([
      { id: "big", campaign_id: "c", daily_budget: "3000", effective_status: "ACTIVE" },
      { id: "small", campaign_id: "c", daily_budget: "1000", effective_status: "ACTIVE" },
    ]);
    const out = await runAdBudgetReconcile(NOV1);
    expect(out).toMatchObject({ rolled: 1, recorded: 1 });
    expect(metaSetStatus).not.toHaveBeenCalled();
    expect(googleSetStatus).not.toHaveBeenCalled();
    expect(sgSend).not.toHaveBeenCalled();
    expect(db.rpcCalls).not.toContain("release_ad_spend_for_object");
    expect(db.rpcCalls).not.toContain("claim_ad_budget_month_note");
  });
});

describe("the brake's daily check runs after a recorded read", () => {
  it("a whole read: the brake runs once for the budget, with the owner-email sender", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 60]]));
    brake.mockResolvedValueOnce({ status: "warned", projected_usd: 2000, cap_usd: 1000, cuts: 1 } as never);
    const out = await runAdBudgetReconcile(NOW);
    expect(brake).toHaveBeenCalledTimes(1);
    expect(brake.mock.calls[0][0]).toMatchObject({ id: "b1", tenant_id: T });
    expect(brake.mock.calls[0][1]).toEqual([
      { platform: "meta", account_id: "act_1" },
      { platform: "google", account_id: "9" },
    ]);
    expect(typeof (brake.mock.calls[0][2] as { send?: unknown }).send).toBe("function");
    expect(out).toMatchObject({ recorded: 1, brake_warned: 1, brake_due: 0 });
    expect(db.rpcCalls.slice(-2)).toEqual(["record_ad_budget_actual", "clear_ad_budget_read_failed_platforms"]);
  });

  it("a ChatGPT failure preserves unknown spend while Meta/Google advance and the partial brake still runs", async () => {
    db.budgets = [budget()];
    chatgptRead.mockRejectedValue(new Error("incomplete inventory"));
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 60]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(1);
    expect(db.rpcCalls).toContain("record_ad_budget_partial_actual_v2");
    expect(db.budgets[0].spent_usd).toBeGreaterThanOrEqual(60);
    expect(brake).toHaveBeenCalledWith(expect.anything(), [
      { platform: "meta", account_id: "act_1" }, { platform: "google", account_id: "9" },
    ], expect.objectContaining({ incompletePlatforms: ["ChatGPT Ads"] }));
  });

  it("a failed platform read: the brake runs on what was read, naming the platform it could not read", async () => {
    db.budgets = [budget()];
    googleCurrency.code = "CAD";
    expect((await runAdBudgetReconcile(NOW)).read_failed).toBe(1);
    expect(brake).toHaveBeenCalledWith(expect.anything(), [{ platform: "meta", account_id: "act_1" }], expect.objectContaining({ incompletePlatforms: ["Google Ads"] }));
  });

  it("a ledger write that failed: no brake this hour (it reads the ledger)", async () => {
    db.budgets = [budget()];
    db.ledgerFails = true;
    await runAdBudgetReconcile(NOW);
    expect(brake).not.toHaveBeenCalled();
  });
});

describe("holds follow the live ledger after the read (20261031190000)", () => {
  it("a whole read: the sync runs once, after the ledger, for Meta and Google, and its answer is returned", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 60]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(db.liveSync).toEqual([{ tenant: T, platforms: ["meta", "google"], readStartedAt: "2026-10-12T10:07:00.000Z" }]);
    expect(db.ledger.map((l) => l.platform)).toEqual(expect.arrayContaining(["meta", "google"]));
    expect(out).toMatchObject({ recorded: 1, holds_released: 1, holds_lowered: 1 });
  });

  it("a platform that failed its read is left out: only Google's holds are judged", async () => {
    db.budgets = [budget()];
    metaFacts.mockImplementation(async () => ({ currency: "EUR", timezone_offset_hours_utc: 0 }));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(1);
    expect(db.liveSync).toEqual([{ tenant: T, platforms: ["google"], readStartedAt: "2026-10-12T10:07:00.000Z" }]);
    expect(out).toMatchObject({ holds_released: 1, holds_lowered: 1 });
  });

  it("the database read start cannot be read: no sync this hour (holds stay)", async () => {
    db.budgets = [budget()];
    db.dbNow = new Error("db down");
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 60]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(db.liveSync).toEqual([]);
    expect(out).toMatchObject({ recorded: 1 });
  });

  it("a ledger write that failed: that platform is not judged on last hour's rows", async () => {
    db.budgets = [budget()];
    db.ledgerFails = true;
    await runAdBudgetReconcile(NOW);
    expect(db.liveSync).toEqual([]);
  });

  it("no active budget: nothing is synced", async () => {
    db.budgets = [budget({ status: "stopped" })];
    await runAdBudgetReconcile(NOW);
    expect(db.liveSync).toEqual([]);
  });
});

describe("S7: outside-Zavi changes, for every tenant with a connected ad account", () => {
  const NB = "33333333-3333-4333-8333-333333333333";
  const adSet = (id: string, status: string, daily_budget: string) => ({ id, name: `Set ${id}`, campaign_id: "c1", daily_budget, lifetime_budget: null, effective_status: status });
  const storedRow = (tenant_id: string, object_id: string, status: string, budget_usd: string) => ({
    tenant_id,
    platform: "meta",
    account_id: "act_1",
    object_id,
    level: "ad_set",
    campaign_id: "c1",
    name: `Set ${object_id}`,
    budget_kind: "daily",
    budget_usd,
    status,
  });

  it("a tenant with NO budget is read, its outside change logged BEFORE the read replaces the rows; no cap work", async () => {
    db.connected = [{ tenant_id: NB, slug: "meta_ads" }];
    db.stored = [storedRow(NB, "as1", "PAUSED", "25.00"), storedRow(NB, "as2", "ACTIVE", "10.00")];
    metaAdSets.mockResolvedValue([adSet("as1", "ACTIVE", "2500"), adSet("as2", "ACTIVE", "1500")]);
    googleConnected.on = false;

    const out = await runAdBudgetReconcile(NOW);

    expect(out).toMatchObject({ budgets: 0, ledger_only: 1, ledger_only_failed: 0 });
    expect(redditMonitor).toHaveBeenCalledWith(NB, NOW);
    expect(db.outside).toHaveLength(1);
    expect(db.outside[0].tenant).toBe(NB);
    expect(db.outside[0].rows).toEqual([
      expect.objectContaining({ object_id: "as1", source: "outside", change_kind: "status", before_status: "PAUSED", after_status: "ACTIVE", before_daily_usd: 25 }),
      expect.objectContaining({ object_id: "as2", source: "outside", change_kind: "budget", before_daily_usd: 10, after_daily_usd: 15 }),
    ]);
    expect(db.rpcCalls).toEqual(["record_ad_object_changes", "record_ad_ledger_read"]);
    expect(ledgerOf("meta")!.tenant).toBe(NB);
    expect(brake).not.toHaveBeenCalled();
  });

  it("a budgeted tenant is read once (not again as a connected one), and a Zavi change explains its difference", async () => {
    db.budgets = [budget()];
    db.connected = [{ tenant_id: T, slug: "meta_ads" }, { tenant_id: T, slug: "google_ads" }];
    db.stored = [storedRow(T, "as1", "ACTIVE", "25.00"), storedRow(T, "as9", "ACTIVE", "5.00")];
    db.zaviActs = [{ tenant_id: T, exec_payload: { object_id: "as1", status: "PAUSED" } }];
    metaAdSets.mockResolvedValue([adSet("as1", "PAUSED", "2500"), adSet("as9", "PAUSED", "500")]);

    const out = await runAdBudgetReconcile(NOW);

    expect(out).toMatchObject({ recorded: 1, ledger_only: 0 });
    expect(redditMonitor).toHaveBeenCalledTimes(1);
    expect(redditMonitor).toHaveBeenCalledWith(T, NOW);
    expect(metaAdSets).toHaveBeenCalledTimes(1);
    expect(db.outside.flatMap((o) => o.rows).map((r) => r.object_id)).toEqual(["as9"]);
  });

  it("a stored row from another tenant is never diffed against this tenant's read", async () => {
    db.connected = [{ tenant_id: NB, slug: "meta_ads" }];
    db.stored = [storedRow(T, "as1", "PAUSED", "25.00")];
    metaAdSets.mockResolvedValue([adSet("as1", "ACTIVE", "2500")]);
    googleConnected.on = false;
    await runAdBudgetReconcile(NOW);
    expect(db.outside).toEqual([]);
  });
});

describe("every ad platform counts toward the budget (TikTok ... LinkedIn)", () => {
  const read = (platform: string, rows: Array<[string, string, number]>) => [{
    platform, account_id: `${platform}_acct`,
    campaigns: rows.map(([object_id]) => ({ object_id, level: "campaign", campaign_id: object_id, name: object_id, budget_kind: "daily", budget_usd: 50, status: "ACTIVE", currency: "USD" })),
    spend: rows.map(([object_id, spend_date, amount_usd]) => ({ object_id, spend_date, amount_usd, provisional: false })),
    window: { since: "2026-10-01", until: "2026-10-05" },
  }];

  it("a connected TikTok account's spend is added to Meta's and written to the ledger", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 100]]));
    extraReads.tiktok.mockResolvedValue(read("tiktok", [["tt1", "2026-10-02", 50]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.recorded).toBe(1);
    expect(db.budgets[0].spent_usd).toBe(150);
    expect(ledgerOf("tiktok")?.spend).toEqual([{ object_id: "tt1", spend_date: "2026-10-02", amount_usd: 50, provisional: false }]);
    expect(db.liveSync).toEqual(expect.arrayContaining([expect.objectContaining({ platforms: expect.arrayContaining(["tiktok"]) })]));
    expect(db.rpcCalls).toContain("clear_ad_budget_read_failed_platforms");
  });

  it("a whole LinkedIn read hands LinkedIn holds to the live sync for that tenant, from the one read it already made", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 10]]));
    const li = read("linkedin", [["binding-1", "2026-10-02", 3]]);
    li[0].campaigns[0].status = "PAUSED";
    extraReads.linkedin.mockResolvedValue(li);
    await runAdBudgetReconcile(NOW);
    expect(extraReads.linkedin).toHaveBeenCalledTimes(1);
    expect(db.liveSync).toEqual([{ tenant: T, platforms: ["meta", "google", "linkedin"], readStartedAt: "2026-10-12T10:07:00.000Z" }]);
  });

  it("a failed LinkedIn read keeps LinkedIn out of the live sync", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 10]]));
    extraReads.linkedin.mockRejectedValue(new Error("LinkedIn Ads read failed (HTTP 500)."));
    await runAdBudgetReconcile(NOW);
    expect(db.liveSync.every((call) => !call.platforms.includes("linkedin"))).toBe(true);
  });

  it("all seven readers run for a budget, and an unconnected one ([]) is no error", async () => {
    db.budgets = [budget()];
    const out = await runAdBudgetReconcile(NOW);
    for (const f of Object.values(extraReads)) expect(f).toHaveBeenCalledTimes(1);
    expect(out.read_failed).toBe(0);
  });

  it("Pinterest fails: Meta and Google still count, Pinterest keeps its last ledger spend, it is marked unread, the founder is told", async () => {
    db.budgets = [budget()];
    db.ledger = [{ tenant: T, platform: "pinterest", account: "p1", campaigns: [], spend: [{ object_id: "pc1", spend_date: "2026-10-03", amount_usd: 40, provisional: false }] }];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 100]]));
    extraReads.pinterest.mockRejectedValue(new Error("token expired"));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(1);
    expect(db.rpcCalls).toContain("record_ad_budget_partial_actual_v2");
    expect(db.budgets[0].spent_usd).toBe(140);
    expect(db.budgets[0].read_failed).toEqual({ pinterest: NOW.toISOString() });
    expect(founderAlerts).toHaveBeenCalledWith(T, "ad spend read failed", [expect.objectContaining({
      id: "ad_read_failed:b1:pinterest:2026-10", what: expect.stringContaining("Reconnect Pinterest Ads"),
    })]);
    expect(brake).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ incompletePlatforms: ["Pinterest Ads"] }));
  });

  it("a platform still failing keeps the time its failure began (the founder is not re-told)", async () => {
    db.budgets = [budget({ read_failed: { pinterest: "2026-10-04T08:00:00.000Z" } })];
    extraReads.pinterest.mockRejectedValue(new Error("token expired"));
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].read_failed).toEqual({ pinterest: "2026-10-04T08:00:00.000Z" });
    expect(founderAlerts).toHaveBeenCalledWith(T, "ad spend read failed", [expect.objectContaining({ since: "2026-10-04T08:00:00.000Z" })]);
  });

  it("the next whole read clears the unread mark", async () => {
    db.budgets = [budget({ read_failed: { pinterest: "2026-10-04T08:00:00.000Z" } })];
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].read_failed).toEqual({});
    expect(founderAlerts).not.toHaveBeenCalled();
  });

  it("Meta failing is partial now too: Google still counts and only Meta is marked unread", async () => {
    db.budgets = [budget()];
    metaSeries.mockRejectedValue(new Error("graph down"));
    googleCost.mockResolvedValue(costRows([["42", "2026-10-02", "30000000"]]));
    await runAdBudgetReconcile(NOW);
    expect(db.rpcCalls).toContain("record_ad_budget_partial_actual_v2");
    expect(Object.keys(db.budgets[0].read_failed ?? {})).toEqual(["meta"]);
    expect(db.budgets[0].spent_usd).toBe(30);
  });
});

describe("an ad account that recorded spend this month must still be read (reconnect with another login)", () => {
  it("Meta reads, but an account with spend this month is gone: Meta is unread, its ledger spend stays counted, Google still counts", async () => {
    db.budgets = [budget()];
    db.monthAccounts = [{ platform: "meta", account_id: "act_old" }, { platform: "meta", account_id: "act_1" }];
    db.ledger = [{ tenant: T, platform: "meta", account: "act_old", campaigns: [], spend: [{ object_id: "as9", spend_date: "2026-10-02", amount_usd: 70, provisional: false }] }];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-03", 100]]));
    googleCost.mockResolvedValue(costRows([["42", "2026-10-02", "30000000"]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(1);
    expect(Object.keys(db.budgets[0].read_failed ?? {})).toEqual(["meta"]);
    expect(db.budgets[0].spent_usd).toBe(200);
    expect(founderAlerts).toHaveBeenCalledWith(T, "ad spend read failed", [expect.objectContaining({ id: "ad_read_failed:b1:meta:2026-10" })]);
  });

  describe("LinkedIn: one account the read kept only as recorded spend", () => {
    const recordedRead = { platform: "linkedin", account_id: "li_old", recorded_only: true, campaigns: [], spend: [{ object_id: "lc1", spend_date: "2026-10-02", amount_usd: 70, provisional: false }], window: { since: "2026-10-01", until: "2026-10-05" } };
    const liveRead = { platform: "linkedin", account_id: "li_live", campaigns: [{ object_id: "lc2", level: "campaign", campaign_id: "lc2", name: "c", budget_kind: "daily", budget_usd: 50, status: "ACTIVE", currency: "USD" }], spend: [{ object_id: "lc2", spend_date: "2026-10-03", amount_usd: 30, provisional: false }], window: { since: "2026-10-01", until: "2026-10-05" } };
    it("must catch: LinkedIn is not marked read-failed, no Reconnect alert goes out, and the historic spend still counts in a whole read", async () => {
      db.budgets = [budget()];
      db.monthAccounts = [{ platform: "linkedin", account_id: "li_old", amount_usd: 70 }, { platform: "linkedin", account_id: "li_live", amount_usd: 30 }];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      const out = await runAdBudgetReconcile(NOW);
      expect(out.read_failed).toBe(0);
      expect(db.budgets[0].read_failed ?? {}).toEqual({});
      expect(db.budgets[0].read_failure_kinds ?? {}).toEqual({});
      expect(founderAlerts).not.toHaveBeenCalled();
      expect(db.budgets[0].spent_usd).toBe(100);
      expect(db.rpcCalls).toContain("clear_ad_budget_read_failed_platforms");
    });
    it("must catch: its campaigns are never marked removed, because its empty inventory is not written to the ledger", async () => {
      db.budgets = [budget()];
      db.monthAccounts = [{ platform: "linkedin", account_id: "li_old", amount_usd: 70 }];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      await runAdBudgetReconcile(NOW);
      expect(db.ledger.map((l) => l.account)).toContain("li_live");
      expect(db.ledger.map((l) => l.account)).not.toContain("li_old");
    });
    it("must catch: the brake projects only accounts really read, so a stale campaign on the lost account never projects spend", async () => {
      db.budgets = [budget()];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      await runAdBudgetReconcile(NOW);
      const accounts = brake.mock.calls.flatMap((c) => c[1] as Array<{ account_id: string }>).map((a) => a.account_id);
      expect(accounts).toContain("li_live");
      expect(accounts).not.toContain("li_old");
    });
    it("must catch: the no-budget sweep does not rewrite its rows or wipe its campaigns either", async () => {
      db.budgets = [];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      await reconcileLedgerOnly(T, NOW);
      expect(db.ledger.map((l) => l.account)).not.toContain("li_old");
    });
    it("must catch (Review 10): a stopped account the reader cleared does not read as could-not-be-read: the brake still runs its check, and the outcome names the account", async () => {
      db.budgets = [budget()];
      db.monthAccounts = [{ platform: "linkedin", account_id: "li_old", amount_usd: 70 }, { platform: "linkedin", account_id: "li_live", amount_usd: 30 }];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      const out = await reconcileBudget(budget() as never, NOW);
      expect(brake.mock.calls[0][2]).toMatchObject({ incompletePlatforms: [] });
      expect(out).toMatchObject({ outcome: "recorded", recorded_only_accounts: ["li_old"] });
    });
    it("must catch (Review 10): a platform that really failed beside a stopped LinkedIn account is the only one named incomplete", async () => {
      db.budgets = [budget()];
      db.monthAccounts = [{ platform: "linkedin", account_id: "li_old", amount_usd: 70 }, { platform: "linkedin", account_id: "li_live", amount_usd: 30 }];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      extraReads.pinterest.mockRejectedValue(new Error("Pinterest 500"));
      await reconcileBudget(budget() as never, NOW);
      expect(brake.mock.calls[0][2]).toMatchObject({ incompletePlatforms: ["Pinterest Ads"] });
    });
    it("must catch (Review 10): an overspend alert beside a stopped account never tells the founder LinkedIn could not be read", async () => {
      db.budgets = [budget()];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      brake.mockImplementationOnce(async (_b: unknown, _a: unknown, deps: unknown) => {
        await (deps as { alertFounder: (t: string, o: unknown) => Promise<void> }).alertFounder(T, { budget_id: "b1", day: "2026-10-05", projected_usd: 200, cap_usd: 100 });
        return { status: "on_track" as const, projected_usd: 0, cap_usd: 0 };
      });
      await runAdBudgetReconcile(NOW);
      const [, , blockers] = founderAlerts.mock.calls.find((c: unknown[]) => c[1] === "overspend brake") as unknown as [string, string, Array<{ what: string }>];
      expect(blockers[0].what).toMatch(/^Your ads are on track/);
      expect(blockers[0].what).not.toContain("could not be read");
    });
    it("must catch: the money book is told LinkedIn is unread, so its snapshot never treats the frozen account as read", async () => {
      moneyBook.on = true;
      moneyBook.store.mockClear();
      db.budgets = [budget()];
      extraReads.linkedin.mockResolvedValue([liveRead, recordedRead]);
      await runAdBudgetReconcile(NOW);
      moneyBook.on = false;
      const arg = moneyBook.store.mock.calls[0][0] as { unread_platforms: string[]; accounts: Array<{ account_id: string }> };
      expect(arg.unread_platforms).toEqual(["linkedin"]);
      expect(arg.accounts.map((x) => x.account_id)).not.toContain("li_old");
    });
    it("must catch: a whole read with no recorded-only account stays complete", async () => {
      db.budgets = [budget()];
      extraReads.linkedin.mockResolvedValue([liveRead]);
      const out = await reconcileBudget(budget() as never, NOW);
      expect(brake.mock.calls[0][2]).toMatchObject({ incompletePlatforms: [] });
      expect(out).not.toHaveProperty("recorded_only_accounts");
    });
    it("must catch (Review 8): a lost account the reader refuses tells the founder to reconnect now, with no retry and no 'keep trying'", async () => {
      db.budgets = [budget()];
      extraReads.linkedin.mockRejectedValue(new AdAccountLostError("LinkedIn Ads cannot see an ad account that runs Zavi campaigns; spend is unknown."));
      const out = await runAdBudgetReconcile(NOW);
      expect(out.read_failed).toBe(1);
      expect(extraReads.linkedin).toHaveBeenCalledTimes(1);
      expect(db.budgets[0].read_failure_kinds).toEqual({ linkedin: "account_gone" });
      const [, , blockers] = founderAlerts.mock.calls.find((c: unknown[]) => c[1] === "ad spend read failed") as unknown as [string, string, Array<{ id: string; what: string }>];
      expect(blockers).toHaveLength(1);
      expect(blockers[0].id).toBe("ad_read_failed:b1:linkedin:2026-10");
      expect(blockers[0].what).toMatch(/^Reconnect LinkedIn Ads with a login that can see all your ad accounts/);
      expect(blockers[0].what).not.toMatch(/keep trying|hasn't answered/);
    });
    it("must catch: still lost four hours on, the founder is told to reconnect, never that LinkedIn hasn't answered", async () => {
      db.budgets = [budget({ read_failed: { linkedin: "2026-10-05T08:00:00.000Z" }, read_failure_kinds: { linkedin: "account_gone" } })];
      extraReads.linkedin.mockRejectedValue(new AdAccountLostError("LinkedIn Ads cannot see an ad account that runs Zavi campaigns; spend is unknown."));
      await runAdBudgetReconcile(NOW);
      const ids = founderAlerts.mock.calls.filter((c: unknown[]) => c[1] === "ad spend read failed").flatMap((c: unknown[]) => (c[2] as Array<{ id: string }>).map((b) => b.id));
      expect(ids).toEqual(["ad_read_failed:b1:linkedin:2026-10"]);
    });
    it("must not catch: a plain unknown failure four hours on still waits with 'hasn't answered', no Reconnect", async () => {
      db.budgets = [budget({ read_failed: { linkedin: "2026-10-05T08:00:00.000Z" }, read_failure_kinds: { linkedin: "unknown" } })];
      extraReads.linkedin.mockRejectedValue(new Error("LinkedIn Ads period spend is missing; spend is unknown."));
      await runAdBudgetReconcile(NOW);
      const ids = founderAlerts.mock.calls.filter((c: unknown[]) => c[1] === "ad spend read failed").flatMap((c: unknown[]) => (c[2] as Array<{ id: string }>).map((b) => b.id));
      expect(ids).toEqual(["ad_read_slow:b1:linkedin:2026-10"]);
    });
    it("must not catch: an account that recorded spend and is absent from the read stays gone, and LinkedIn stays unread", async () => {
      db.budgets = [budget()];
      db.monthAccounts = [{ platform: "linkedin", account_id: "li_old", amount_usd: 70 }, { platform: "linkedin", account_id: "li_live", amount_usd: 30 }];
      db.ledger = [{ tenant: T, platform: "linkedin", account: "li_old", campaigns: [], spend: [{ object_id: "lc1", spend_date: "2026-10-02", amount_usd: 70, provisional: false }] }];
      extraReads.linkedin.mockResolvedValue([liveRead]);
      const out = await runAdBudgetReconcile(NOW);
      expect(out.read_failed).toBe(1);
      expect(db.budgets[0].read_failure_kinds).toEqual({ linkedin: "account_gone" });
    });
  });

  it("every account that spent is still read: a whole read, nothing marked", async () => {
    db.budgets = [budget()];
    db.monthAccounts = [{ platform: "meta", account_id: "act_1" }, { platform: "google", account_id: "9" }];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-03", 100]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(0);
    expect(db.budgets[0].read_failed ?? {}).toEqual({});
  });

  it("a platform that spent this month and is now disconnected stays counted when another platform's spend rises, with one FYI", async () => {
    db.budgets = [budget({ spent_usd: 100 })];
    db.monthAccounts = [{ platform: "linkedin", account_id: "li1", amount_usd: 100 }];
    db.ledger = [{ tenant: T, platform: "linkedin", account: "li1", campaigns: [], spend: [{ object_id: "lc1", spend_date: "2026-10-02", amount_usd: 100, provisional: false }] }];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-03", 150]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].spent_usd).toBe(250);
    expect(out.read_failed).toBe(1);
    expect(Object.keys(db.budgets[0].read_failed ?? {})).toEqual(["linkedin"]);
    expect(db.budgets[0].read_failure_kinds).toEqual({ linkedin: "disconnected" });
    expect(founderAlerts).toHaveBeenCalledTimes(1);
    expect(founderAlerts).toHaveBeenCalledWith(T, "ad spend read failed", [expect.objectContaining({
      id: "ad_disconnected:b1:linkedin:2026-10",
      what: "LinkedIn Ads was disconnected. Zavi last saw $100 spent on it this month, and that still counts toward your cap",
      at_risk_now: false,
    })]);
    expect(JSON.stringify(founderAlerts.mock.calls)).not.toMatch(/Reconnect/);
  });

  it("must catch (Flow 35): LinkedIn disconnected while a Zavi-wallet campaign runs reads as disconnected, not ad account gone, and the wallet spend is not counted twice", async () => {
    db.budgets = [budget({ spent_usd: 100 })];
    db.monthAccounts = [{ platform: "linkedin", account_id: "li1", amount_usd: 100 }, { platform: "linkedin", account_id: "zavi_managed", amount_usd: 20 }];
    db.ledger = [{ tenant: T, platform: "linkedin", account: "li1", campaigns: [], spend: [{ object_id: "lc1", spend_date: "2026-10-02", amount_usd: 100, provisional: false }] }];
    extraReads.linkedin.mockResolvedValue([{ platform: "linkedin", managed: true, account_id: "zavi_managed", campaigns: [], spend: [{ object_id: "bind1", spend_date: "2026-10-01", amount_usd: 20, provisional: true }], window: { since: "2026-10-01", until: "2026-10-05" } }]);
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-03", 150]]));
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].read_failure_kinds).toEqual({ linkedin: "disconnected" });
    expect(db.budgets[0].spent_usd).toBe(270);
    const calls = JSON.stringify(founderAlerts.mock.calls);
    expect(calls).toContain("ad_disconnected:b1:linkedin:2026-10");
    expect(calls).not.toMatch(/Reconnect|ad_read_failed/);
  });

  it("must not catch: a connected LinkedIn login that no longer sees an account that spent stays ad account gone, even beside a wallet campaign", async () => {
    db.budgets = [budget()];
    db.monthAccounts = [{ platform: "linkedin", account_id: "li1", amount_usd: 70 }, { platform: "linkedin", account_id: "li_live", amount_usd: 30 }];
    extraReads.linkedin.mockResolvedValue([
      { platform: "linkedin", managed: true, account_id: "zavi_managed", campaigns: [], spend: [], window: { since: "2026-10-01", until: "2026-10-05" } },
      { platform: "linkedin", account_id: "li_live", campaigns: [], spend: [{ object_id: "lc2", spend_date: "2026-10-03", amount_usd: 30, provisional: false }], window: { since: "2026-10-01", until: "2026-10-05" } },
    ]);
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].read_failure_kinds).toEqual({ linkedin: "account_gone" });
  });

  it("every platform disconnected (nothing read at all): the spend that was read before still counts", async () => {
    db.budgets = [budget({ spent_usd: 100 })];
    metaConnected.on = false;
    googleConnected.on = false;
    db.monthAccounts = [{ platform: "linkedin", account_id: "li1", amount_usd: 100 }];
    db.ledger = [{ tenant: T, platform: "linkedin", account: "li1", campaigns: [], spend: [{ object_id: "lc1", spend_date: "2026-10-02", amount_usd: 100, provisional: false }] }];
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].spent_usd).toBe(100);
    expect(Object.keys(db.budgets[0].read_failed ?? {})).toEqual(["linkedin"]);
  });

  it("reads every page of the ledger: a dropped account past the first 1,000 rows is still found", async () => {
    db.budgets = [budget()];
    db.monthAccounts = [...Array.from({ length: 1000 }, () => ({ platform: "meta", account_id: "act_1" })), { platform: "meta", account_id: "act_old" }];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-03", 100]]));
    await runAdBudgetReconcile(NOW);
    expect(db.monthAccountPages).toBe(2);
    expect(Object.keys(db.budgets[0].read_failed ?? {})).toEqual(["meta"]);
  });

  it("a budget in its first, partial month is not checked (the ledger holds spend from before it began)", async () => {
    db.budgets = [budget({ created_at: "2026-10-04T10:00:00Z" })];
    db.monthAccounts = [{ platform: "meta", account_id: "act_old" }];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-04", 100]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(0);
    expect(db.monthAccountPages).toBe(0);
    expect(db.budgets[0].read_failed ?? {}).toEqual({});
  });

  it("the ledger account check failing keeps the whole month unknown (never a whole read)", async () => {
    db.budgets = [budget({ spent_usd: 40 })];
    db.monthAccountsFail = true;
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-03", 100]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.read_failed).toBe(1);
    expect(db.budgets[0].spent_usd).toBe(40);
    expect(db.rpcCalls).not.toContain("clear_ad_budget_read_failed_platforms");
  });
});

describe("a busy or down platform is retried once and is not a Reconnect", () => {
  const read1 = (platform: string, amount: number) => [{
    platform, account_id: `${platform}_acct`,
    campaigns: [{ object_id: `${platform}_c`, level: "campaign", campaign_id: `${platform}_c`, name: "c", budget_kind: "daily", budget_usd: 50, status: "ACTIVE", currency: "USD" }],
    spend: [{ object_id: `${platform}_c`, spend_date: "2026-10-02", amount_usd: amount, provisional: false }],
    window: { since: "2026-10-01", until: "2026-10-05" },
  }];

  it("TikTok HTTP 500 and Reddit composio 500 at one tick, both fine on the retry: counted, no alert, nothing marked", async () => {
    db.budgets = [budget()];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 100]]));
    extraReads.tiktok.mockRejectedValueOnce(new Error("TikTok read failed (HTTP 500).")).mockResolvedValueOnce(read1("tiktok", 40));
    redditReads.mockRejectedValueOnce(new Error("composio list HTTP 500")).mockResolvedValueOnce(read1("reddit", 10));
    const out = await runAdBudgetReconcile(NOW);
    expect(retryWaits.n).toBe(1);
    expect(extraReads.tiktok).toHaveBeenCalledTimes(2);
    expect(redditReads).toHaveBeenCalledTimes(2);
    expect(out.recorded).toBe(1);
    expect(db.budgets[0].spent_usd).toBe(150);
    expect(db.budgets[0].read_failed ?? {}).toEqual({});
    expect(founderAlerts).not.toHaveBeenCalled();
  });

  it("Google times out once and reads on the retry: counted, no alert", async () => {
    db.budgets = [budget()];
    googleCost.mockRejectedValueOnce(new Error("Google Ads API did not respond within 15s")).mockResolvedValue(costRows([["42", "2026-10-02", "30000000"]]));
    const out = await runAdBudgetReconcile(NOW);
    expect(out.recorded).toBe(1);
    expect(db.budgets[0].spent_usd).toBe(30);
    expect(founderAlerts).not.toHaveBeenCalled();
  });

  it("a retry that fails again keeps the first failure: marked unread with its kind, no alert before 3 hours", async () => {
    db.budgets = [budget()];
    extraReads.tiktok.mockRejectedValue(new Error("TikTok read failed (HTTP 500)."));
    const out = await runAdBudgetReconcile(NOW);
    expect(extraReads.tiktok).toHaveBeenCalledTimes(2);
    expect(out.read_failed).toBe(1);
    expect(db.budgets[0].read_failed).toEqual({ tiktok: NOW.toISOString() });
    expect(db.budgets[0].read_failure_kinds).toEqual({ tiktok: "vendor_error" });
    expect(db.liveSync.every((call) => !call.platforms.includes("tiktok"))).toBe(true);
    expect(founderAlerts).not.toHaveBeenCalled();
  });

  it("the retry's partial answer is never merged with the first: only a whole retry counts", async () => {
    db.budgets = [budget()];
    extraReads.tiktok.mockRejectedValueOnce(new Error("TikTok read failed (HTTP 503).")).mockRejectedValueOnce(new Error("TikTok read failed (HTTP 502)."));
    await runAdBudgetReconcile(NOW);
    expect(db.ledger.filter((l) => l.platform === "tiktok")).toEqual([]);
    expect(Object.keys(db.budgets[0].read_failed ?? {})).toEqual(["tiktok"]);
  });

  it("still failing 3 hours after it began: ONE 'hasn't answered' note, no Reconnect", async () => {
    db.budgets = [budget({ read_failed: { meta: "2026-10-05T08:59:00.000Z" } })];
    metaSeries.mockRejectedValue(new Error('Meta Ads request failed: 400 {"error":{"message":"User request limit reached","code":17,"error_subcode":2446079}}'));
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].read_failure_kinds).toEqual({ meta: "rate_limited" });
    expect(founderAlerts).toHaveBeenCalledWith(T, "ad spend read failed", [expect.objectContaining({
      id: "ad_read_slow:b1:meta:2026-10",
      what: "Meta Ads hasn't answered for 3 hours. I'll keep trying",
      meanwhile: "budget raises on Meta Ads wait",
      since: "2026-10-05T08:59:00.000Z",
    })]);
    expect(JSON.stringify(founderAlerts.mock.calls)).not.toMatch(/Reconnect/);
  });

  it("a login problem is told at once, with Reconnect, and is not retried", async () => {
    db.budgets = [budget()];
    redditReads.mockRejectedValue(new Error('Reddit Ads read failed: {"reason":"UNAUTHORIZED"}'));
    await runAdBudgetReconcile(NOW);
    expect(redditReads).toHaveBeenCalledTimes(1);
    expect(retryWaits.n).toBe(0);
    expect(db.budgets[0].read_failure_kinds).toEqual({ reddit: "auth" });
    expect(founderAlerts).toHaveBeenCalledWith(T, "ad spend read failed", [expect.objectContaining({
      id: "ad_read_failed:b1:reddit:2026-10",
      what: "Reconnect Reddit Ads: Reddit Ads connection stopped working",
      at_risk_now: true,
    })]);
  });

  it("a Composio account that stopped working: the alert says so, neutrally, with the date", async () => {
    db.budgets = [budget()];
    const { ExpectedToolError } = await import("@/services/tools/types");
    redditReads.mockRejectedValue(new ExpectedToolError("reddit_ads_connection_stopped", "Reddit Ads connection stopped working on Oct 15. Reconnect it.", { founder_reason: "Reddit Ads connection stopped working on Oct 15" }));
    await runAdBudgetReconcile(NOW);
    expect(redditReads).toHaveBeenCalledTimes(1);
    expect(db.budgets[0].read_failure_kinds).toEqual({ reddit: "auth" });
    expect(founderAlerts).toHaveBeenCalledWith(T, "ad spend read failed", [expect.objectContaining({
      id: "ad_read_failed:b1:reddit:2026-10",
      what: "Reconnect Reddit Ads: Reddit Ads connection stopped working on Oct 15",
    })]);
  });

  it("a whole read empties the stored kinds with the unread mark", async () => {
    db.budgets = [budget({ read_failed: { tiktok: "2026-10-05T11:00:00.000Z" }, read_failure_kinds: { tiktok: "timeout" } })];
    await runAdBudgetReconcile(NOW);
    expect(db.budgets[0].read_failed).toEqual({});
    expect(db.budgets[0].read_failure_kinds).toEqual({});
  });
});

describe("reconcile after a reconnect: only this tenant's flagged budgets", () => {
  it("clears the flag the moment the read succeeds again", async () => {
    db.budgets = [budget({ read_failed: { meta: "2026-10-05T09:00:00.000Z" }, read_failure_kinds: { meta: "auth" } })];
    metaSeries.mockResolvedValue(metaRows([["as1", "2026-10-02", 25]]));
    const out = await reconcileReadFailedBudgets(T, NOW);
    expect(out).toMatchObject({ flagged: 1, recorded: 1, read_failed: 0, errors: 0 });
    expect(db.budgets[0].read_failed).toEqual({});
    expect(db.budgets[0].read_failure_kinds).toEqual({});
    expect(db.budgets[0].spent_usd).toBe(25);
    expect(db.liveSync).toEqual([]);
  });

  it("a tenant with no flagged budget is a no-op: no platform call, no RPC", async () => {
    db.budgets = [budget()];
    const out = await reconcileReadFailedBudgets(T, NOW);
    expect(out).toMatchObject({ flagged: 0, recorded: 0 });
    expect(metaSeries).not.toHaveBeenCalled();
    expect(gadsSearch).not.toHaveBeenCalled();
    expect(db.rpcCalls).toEqual([]);
  });

  it("does not touch another tenant's flagged budget", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    db.budgets = [
      budget({ read_failed: { meta: "2026-10-05T09:00:00.000Z" }, read_failure_kinds: { meta: "auth" } }),
      budget({ id: "b2", tenant_id: OTHER, read_failed: { meta: "2026-10-05T09:00:00.000Z" }, read_failure_kinds: { meta: "auth" } }),
    ];
    metaSeries.mockResolvedValue(metaRows([]));
    const out = await reconcileReadFailedBudgets(T, NOW);
    expect(out).toMatchObject({ flagged: 1 });
    expect(db.budgets[0].read_failed).toEqual({});
    expect(db.budgets[1].read_failed).toEqual({ meta: "2026-10-05T09:00:00.000Z" });
  });

  it("a login that is still dead keeps the flag and when it began", async () => {
    db.budgets = [budget({ read_failed: { meta: "2026-10-05T09:00:00.000Z" }, read_failure_kinds: { meta: "auth" } })];
    const { ExpectedToolError } = await import("@/services/tools/types");
    metaFacts.mockRejectedValue(new ExpectedToolError("meta_ads_token_expired", "Meta Ads needs to be reconnected."));
    const out = await reconcileReadFailedBudgets(T, NOW);
    expect(out).toMatchObject({ flagged: 1, recorded: 0, read_failed: 1 });
    expect(db.budgets[0].read_failed?.meta).toBe("2026-10-05T09:00:00.000Z");
  });
});
