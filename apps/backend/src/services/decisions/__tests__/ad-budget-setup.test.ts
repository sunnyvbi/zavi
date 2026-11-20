import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const selects: Array<{ table: string; cols: string; ors: string[] }> = [];

const SCHEMA: Record<string, readonly string[]> = {
  decisions: ["id", "tenant_id", "decision_class", "status", "body", "approved_by", "approved_by_source", "dispatched_at"],
  channel_actions: ["id", "tenant_id", "exec_class", "exec_payload", "body", "approved_by", "approved_by_source", "exec_status", "executed_at", "channel_slug", "exec_progress"],
};

function query(tid: string, table: string) {
  let rows = (tables[table] ?? []).filter((r) => r.tenant_id === tid);
  const rec = { table, cols: "", ors: [] as string[] };
  selects.push(rec);
  let unknown: string | null = null;
  const check = (col: string) => {
    const known = SCHEMA[table];
    if (known && !known.includes(col)) unknown ??= col;
  };
  const b = {
    select(cols: string) {
      rec.cols = cols;
      for (const c of cols.split(",").map((x) => x.trim()).filter(Boolean)) {
        const m = /^\w+:(\w+)(?:->\w+)*->>\w+$/.exec(c);
        check(m ? m[1] : c);
      }
      return b;
    },
    eq(c: string, v: unknown) {
      const [col, key] = c.split("->>");
      check(col);
      rows = rows.filter((r) => (key === undefined ? r[c] : (r[col] as Record<string, unknown> | null | undefined)?.[key]) === v);
      return b;
    },
    in(c: string, vs: unknown[]) {
      rows = rows.filter((r) => vs.includes(r[c]));
      return b;
    },
    not(c: string, op: string, v: unknown) {
      if (op === "is" && v === null) rows = rows.filter((r) => r[c] !== null && r[c] !== undefined);
      return b;
    },
    or(expr: string) {
      rec.ors.push(expr);
      const parts = expr.split(",").map((p) => {
        const [col, op, ...rest] = p.split(".");
        return { col, op, val: rest.join(".") };
      });
      for (const p of parts) check(p.col);
      rows = rows.filter((r) =>
        parts.some((p) => p.op === "like" && String(r[p.col] ?? "").startsWith(p.val.replace(/\*$/, ""))),
      );
      return b;
    },
    order(c: string, o?: { ascending?: boolean }) {
      const asc = o?.ascending !== false;
      rows = [...rows].sort((x, y) => (String(x[c]) < String(y[c]) ? (asc ? -1 : 1) : asc ? 1 : -1));
      return b;
    },
    limit(n: number) {
      rows = rows.slice(0, n);
      return b;
    },
    maybeSingle() {
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    then(res: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) {
      if (unknown) return Promise.resolve({ data: null, error: { message: `column ${table}.${unknown} does not exist` } }).then(res);
      const cols = rec.cols.split(",").map((c) => c.trim()).filter(Boolean);
      const pick = (r: Row, c: string): [string, unknown] => {
        const m = /^(\w+):(\w+)((?:->\w+)*)->>(\w+)$/.exec(c);
        if (!m) return [c, r[c]];
        let j = r[m[2]] as Record<string, unknown> | null | undefined;
        for (const k of m[3].split("->").filter(Boolean)) j = j?.[k] as Record<string, unknown> | null | undefined;
        return [m[1], j && j[m[4]] !== undefined ? String(j[m[4]]) : null];
      };
      const out = rows.map((r) => Object.fromEntries(cols.map((c) => pick(r, c))));
      return Promise.resolve({ data: out, error: null }).then(res);
    },
  };
  return b;
}

const rpcCalls: Array<{ fn: string; tid: string; args: Record<string, unknown> }> = [];
let rpcImpl: (fn: string, args: Record<string, unknown>, tid: string) => { data: unknown; error: { message: string } | null };

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({ from: (t: string) => query(tid, t) }),
  tenantRpc: (tid: string, fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, tid, args });
    return Promise.resolve(rpcImpl(fn, args, tid));
  },
}));

const metaPauses: string[] = [];
const metaFail = new Set<string>();
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({
  metaSetStatus: vi.fn(async (_t: string, input: { object_id: string; status: string }) => {
    if (metaFail.has(input.object_id)) throw new Error("Meta Ads write failed: 500 upstream");
    metaPauses.push(`${input.object_id}:${input.status}`);
    return { id: input.object_id, status: input.status };
  }),
}));
const googlePauses: string[] = [];
const redditPause = vi.hoisted(() => vi.fn());
vi.mock("@/services/connectors/reddit-ads/spend-controls", () => ({ pauseRedditBudgetObject: redditPause }));
vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsGetCampaignBudget: vi.fn(async (_t: string, id: string) => ({
    campaign_resource: `customers/1/campaigns/${id}`,
    campaign_status: "ENABLED",
    budget_resource: "b",
    amount_micros: 1,
    channel_type: id.startsWith("video-") ? "VIDEO" : "SEARCH",
  })),
}));
const linkedin = vi.hoisted(() => ({
  request: vi.fn(async (): Promise<string> => "paused"),
  legacy: vi.fn(async (): Promise<string | null> => "paused"),
  bindings: {} as Record<string, { provider_campaign_id: string; funding_source: "wallet" | "provider" }>,
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({
  requestLinkedinPause: linkedin.request,
  pauseLinkedinBoundCampaign: linkedin.legacy,
}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getCampaignBinding: vi.fn(async (_t: string, id: string) => {
    const b = linkedin.bindings[id];
    if (!b) throw new Error("binding unreadable");
    return { id, tenant_id: T, account_binding_id: "acct", account_id: "a", platform: "linkedin", ...b };
  }),
}));
vi.mock("@/services/tools/google-ads/write/set_status", () => ({
  googleSetCampaignStatus: vi.fn(async (_t: string, input: { campaign_resource: string; status: string }) => {
    googlePauses.push(`${input.campaign_resource}:${input.status}`);
    return { resource_name: input.campaign_resource, status: input.status };
  }),
}));

import {
  adObjectLabel,
  byLabel,
  eventRow,
  parseBudgetInput,
  parseHumanAction,
  readAdBudgetLedger,
  readAdBudgetView,
  reservationAction,
  reservationResult,
  stopAdBudget,
  VIDEO_PAUSE_REFUSED,
} from "../ad-budget-setup";

const T = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const B = "bbbbbbbb-0000-0000-0000-000000000001";
const META_DEC = "d0000000-0000-0000-0000-000000000001";
const CGO_ACT = "a0000000-0000-0000-0000-000000000002";
const DISPUTE_DEC = "d0000000-0000-0000-0000-00000000dead";

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  selects.length = 0;
  rpcCalls.length = 0;
  metaPauses.length = 0;
  googlePauses.length = 0;
  redditPause.mockReset();
  metaFail.clear();
  linkedin.request.mockReset().mockResolvedValue("paused");
  linkedin.legacy.mockReset().mockResolvedValue("paused");
  linkedin.bindings = {};
  rpcImpl = () => ({ data: null, error: null });
});

describe("stopAdBudget (T15)", () => {
  it("pauses held Reddit objects through the owned-account transport before releasing their reservations", async () => {
    rpcImpl = (fn) => fn === "stop_ad_budget"
      ? { data: { status: "stopped", objects: [{ platform: "reddit", object_id: "reddit-group" }] }, error: null }
      : { data: { status: "released", released_usd: 10 }, error: null };
    expect(await stopAdBudget(T, "owner-1", B)).toEqual({ status: "stopped", paused: [{ platform: "reddit", object_id: "reddit-group", released_usd: 10 }], failed: [] });
    expect(redditPause).toHaveBeenCalledWith(T, "reddit-group");
    expect(rpcCalls).toContainEqual({ fn: "release_ad_spend_for_object", tid: T, args: { p_platform: "reddit", p_object_id: "reddit-group", p_budget_id: B } });
  });
  it("retains a Reddit reservation when the emergency pause cannot be confirmed", async () => {
    redditPause.mockRejectedValue(new Error("pause outcome unknown"));
    rpcImpl = () => ({ data: { status: "stopped", objects: [{ platform: "reddit", object_id: "reddit-group" }] }, error: null });
    expect(await stopAdBudget(T, "owner-1", B)).toMatchObject({ paused: [], failed: [{ platform: "reddit", object_id: "reddit-group", error: "pause outcome unknown" }] });
    expect(rpcCalls.some((c) => c.fn === "release_ad_spend_for_object")).toBe(false);
  });
  it("pauses each held object via the platform clients, releases the paused ones, reports the failed one", async () => {
    metaFail.add("adset-2");
    rpcImpl = (fn) => {
      if (fn === "stop_ad_budget") {
        return {
          data: {
            status: "stopped",
            objects: [
              { platform: "google", object_id: "555" },
              { platform: "meta", object_id: "adset-1" },
              { platform: "meta", object_id: "adset-2" },
            ],
          },
          error: null,
        };
      }
      if (fn === "release_ad_spend_for_object") return { data: { status: "released", released_usd: "37.50" }, error: null };
      return { data: null, error: { message: "unexpected" } };
    };

    const out = await stopAdBudget(T, "owner-1", B);

    expect(rpcCalls[0]).toMatchObject({ fn: "stop_ad_budget", tid: T, args: { p_actor: "owner-1", p_budget_id: B } });
    expect(googlePauses).toEqual(["customers/1/campaigns/555:PAUSED"]);
    expect(metaPauses).toEqual(["adset-1:PAUSED"]);
    const releases = rpcCalls.filter((c) => c.fn === "release_ad_spend_for_object");
    expect(releases.map((c) => c.args)).toEqual([
      { p_platform: "google", p_object_id: "555", p_budget_id: B },
      { p_platform: "meta", p_object_id: "adset-1", p_budget_id: B },
    ]);
    expect(releases.every((c) => c.tid === T)).toBe(true);
    expect(out).toEqual({
      status: "stopped",
      paused: [
        { platform: "google", object_id: "555", released_usd: 37.5 },
        { platform: "meta", object_id: "adset-1", released_usd: 37.5 },
      ],
      failed: [{ platform: "meta", object_id: "adset-2", error: "Meta Ads write failed: 500 upstream", label: "Meta ad set …et-2", reason: "Pause it in Meta Ads, or press Stop again." }],
    });
  });

  it("a YouTube VIDEO campaign is not paused (Google refuses it): its hold stays and the founder is told to pause it in Google Ads", async () => {
    rpcImpl = (fn) =>
      fn === "stop_ad_budget"
        ? { data: { status: "stopped", objects: [{ platform: "google", object_id: "video-9" }] }, error: null }
        : { data: { status: "released", released_usd: "10" }, error: null };
    const out = await stopAdBudget(T, "owner-1", B);
    expect(googlePauses).toEqual([]);
    expect(rpcCalls.some((c) => c.fn === "release_ad_spend_for_object")).toBe(false);
    expect(out).toEqual({ status: "stopped", paused: [], failed: [{ platform: "google", object_id: "video-9", error: VIDEO_PAUSE_REFUSED, label: "Google campaign …eo-9", reason: VIDEO_PAUSE_REFUSED }] });
  });

  it("a pause that landed but whose release failed is still paused, with no released amount", async () => {
    rpcImpl = (fn) =>
      fn === "stop_ad_budget"
        ? { data: { status: "already_stopped", objects: [{ platform: "meta", object_id: "adset-1" }] }, error: null }
        : { data: null, error: { message: "db down" } };
    const out = await stopAdBudget(T, "owner-1", B);
    expect(out).toEqual({ status: "already_stopped", paused: [{ platform: "meta", object_id: "adset-1", released_usd: null }], failed: [] });
  });

  it("an object with a write still in flight is paused but never reported as paused, and its hold stays", async () => {
    rpcImpl = (fn) =>
      fn === "stop_ad_budget"
        ? { data: { status: "stopped", objects: [{ platform: "google", object_id: "777", in_flight: true }] }, error: null }
        : { data: { status: "released", released_usd: 0 }, error: null };
    const out = await stopAdBudget(T, "owner-1", B);
    expect(googlePauses).toEqual(["customers/1/campaigns/777:PAUSED"]);
    expect(rpcCalls.filter((c) => c.fn === "release_ad_spend_for_object")).toEqual([]);
    expect(out).toMatchObject({ paused: [], failed: [{ platform: "google", object_id: "777" }] });
  });

  it("a budget from another tenant is not found and nothing is paused", async () => {
    rpcImpl = (fn) => (fn === "stop_ad_budget" ? { data: { status: "not_found", objects: [] }, error: null } : { data: null, error: null });
    expect(await stopAdBudget(T, "owner-1", B)).toEqual({ status: "not_found" });
    expect(metaPauses).toEqual([]);
    expect(googlePauses).toEqual([]);
  });

  it("an RPC error throws: the route reports the stop failed, never that it stopped", async () => {
    rpcImpl = () => ({ data: null, error: { message: "boom" } });
    await expect(stopAdBudget(T, "owner-1", B)).rejects.toThrow(/stop_ad_budget failed/);
    expect(metaPauses).toEqual([]);
  });
});

describe("Stop names each LinkedIn campaign it could not pause and says why", () => {
  const WALLET = "c1000000-0000-4000-8000-0000000000aa";
  const OWN = "c1000000-0000-4000-8000-0000000000bb";
  const stopWith = (objects: Array<Record<string, unknown>>) => {
    rpcImpl = (fn) => (fn === "stop_ad_budget" ? { data: { status: "stopped", objects }, error: null } : { data: { status: "released", released_usd: 5 }, error: null });
  };
  beforeEach(() => {
    linkedin.bindings = {
      [WALLET]: { provider_campaign_id: "7001", funding_source: "wallet" },
      [OWN]: { provider_campaign_id: "7002", funding_source: "provider" },
    };
    tables.channel_actions = [
      { id: "act-1", tenant_id: T, exec_class: "linkedin_ads.create_campaign_bundle", exec_progress: { campaign_id: "7001" }, exec_payload: { campaign: { name: "Spring launch" } } },
      { id: "act-2", tenant_id: T, exec_class: "linkedin_ads.create_campaign_bundle", exec_progress: { campaign_id: "7002" }, exec_payload: { campaign: { name: "Founder webinar" } } },
      { id: "act-3", tenant_id: OTHER, exec_class: "linkedin_ads.create_campaign_bundle", exec_progress: { campaign_id: "7001" }, exec_payload: { campaign: { name: "Someone else's" } } },
    ];
  });

  it("must-catch: a saved, retrying pause is named and carries its own reason, never 'Google campaign' or the internal id", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    linkedin.request.mockRejectedValue(new ExpectedToolError("ads_pause_queued", "Zavi saved your pause request and will keep retrying it. Check back in a few minutes."));
    stopWith([{ platform: "linkedin", object_id: WALLET }]);
    const out = await stopAdBudget(T, "owner-1", B);
    expect(out).toMatchObject({ paused: [], failed: [{ platform: "linkedin", object_id: WALLET, label: 'LinkedIn campaign "Spring launch"', reason: "Zavi saved your pause request and will keep retrying it. Check back in a few minutes." }] });
    expect(JSON.stringify(out)).not.toMatch(/Google/);
    expect(rpcCalls.some((c) => c.fn === "release_ad_spend_for_object")).toBe(false);
  });

  it("must-catch: a wallet campaign's unexplained failure never sends the founder to an account they cannot open", async () => {
    linkedin.request.mockRejectedValue(new Error("LinkedIn pause receipt could not be saved"));
    stopWith([{ platform: "linkedin", object_id: WALLET }]);
    const out = await stopAdBudget(T, "owner-1", B);
    const f = (out as { failed: Array<{ reason: string }> }).failed[0];
    expect(f.reason).toBe("It runs on Zavi's shared ads account, so Zavi pauses it for you. Press Stop again in a minute.");
    expect(f.reason).not.toMatch(/receipt|Campaign Manager|ad platform/);
  });

  it("an own-billing campaign's unexplained failure points to LinkedIn Campaign Manager, not the raw error", async () => {
    linkedin.request.mockRejectedValue(new Error("LinkedIn pause receipt could not be saved"));
    stopWith([{ platform: "linkedin", object_id: OWN }]);
    const out = await stopAdBudget(T, "owner-1", B);
    expect(out).toMatchObject({ failed: [{ label: 'LinkedIn campaign "Founder webinar"', reason: "Pause it in LinkedIn Campaign Manager, or press Stop again." }] });
  });

  it("must-catch: an in-flight LinkedIn pause keeps its own 'Press Stop again in a minute' reason", async () => {
    stopWith([{ platform: "linkedin", object_id: OWN, in_flight: true }]);
    const out = await stopAdBudget(T, "owner-1", B);
    expect(out).toMatchObject({ paused: [], failed: [{ label: 'LinkedIn campaign "Founder webinar"', reason: expect.stringContaining("Press Stop again in a minute") }] });
  });

  it("must-catch: a campaign relaunched while Stop paused it is reported as not paused, never as paused", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    linkedin.legacy.mockResolvedValue(null);
    linkedin.request.mockRejectedValue(new ExpectedToolError("ads_pause_superseded", "This campaign was relaunched while Zavi was pausing it, so Zavi left it running. Pause it again if you still want it stopped."));
    stopWith([{ platform: "linkedin", object_id: OWN }]);
    const out = await stopAdBudget(T, "owner-1", B);
    expect(out).toMatchObject({ paused: [], failed: [{ reason: expect.stringContaining("relaunched") }] });
  });

  it("an unreadable binding still reads as a LinkedIn campaign, with no internal id", async () => {
    linkedin.request.mockRejectedValue(new Error("x"));
    const lost = "c1000000-0000-4000-8000-0000000000cc";
    stopWith([{ platform: "linkedin", object_id: lost }]);
    const out = await stopAdBudget(T, "owner-1", B);
    expect(out).toMatchObject({ failed: [{ label: "LinkedIn campaign", reason: "Pause it in LinkedIn Campaign Manager, or press Stop again." }] });
    expect(JSON.stringify((out as { failed: Array<{ label: string }> }).failed[0].label)).not.toContain("00cc");
  });

  it("a stopped budget's LinkedIn campaign that still holds money is named on the read too", async () => {
    rpcImpl = viewRpc({ status: "stopped", stopped_at: "2026-09-27T00:00:00Z" });
    tables.ad_budget_reservations = [{ tenant_id: T, budget_id: B, platform: "linkedin", object_id: WALLET, status: "committed" }];
    expect(await readAdBudgetView(T)).toMatchObject({ still_running: [{ platform: "linkedin", object_id: WALLET, label: 'LinkedIn campaign "Spring launch"' }] });
  });
});

const MONTH_VIEW = {
  id: B,
  status: "active",
  monthly_usd: "3000.00",
  daily_limit_usd: null,
  started_on: "2026-09-20",
  created_at: "2026-09-26T10:00:00Z",
  stopped_at: null,
  month_start: "2026-09-01",
  next_month_start: "2026-10-01",
  days_left: 5,
  days_in_month: 30,
  month_cap_usd: "1100.00",
  spent_usd: "400.00",
  held_usd: "187.50",
  left_usd: "512.50",
};
const viewRpc = (over: Record<string, unknown> = {}) => (fn: string, _args: Record<string, unknown>, tid: string) =>
  fn === "ad_budget_month_view"
    ? { data: tid === T ? { ...MONTH_VIEW, ...over } : null, error: null }
    : { data: null, error: { message: `unexpected ${fn}` } };

describe("readAdBudgetLedger (T12)", () => {
  beforeEach(() => {
    rpcImpl = viewRpc();
    tables.ad_budget_reservations = [
      { tenant_id: T, budget_id: B, idem_key: `${META_DEC}:raise`, platform: "meta", object_id: "adset-1", op: "raise", daily_delta_usd: "20.00", amount_usd: "125.00", status: "committed", reason: null, created_at: "2026-09-26T11:00:00Z" },
      { tenant_id: T, budget_id: B, idem_key: `${CGO_ACT}:create`, platform: "google", object_id: "555", op: "create", daily_delta_usd: "10.00", amount_usd: "62.50", status: "committed", reason: null, created_at: "2026-09-26T12:00:00Z" },
      { tenant_id: T, budget_id: B, idem_key: `${DISPUTE_DEC}:raise`, platform: "meta", object_id: "adset-9", op: "raise", daily_delta_usd: "5.00", amount_usd: "30.00", status: "refused", reason: "over_month", created_at: "2026-09-26T13:00:00Z" },
      { tenant_id: T, budget_id: B, idem_key: `${META_DEC}:resume`, platform: "meta", object_id: "adset-3", op: "resume", daily_delta_usd: "50.00", amount_usd: "312.50", status: "released", reason: "month_rollover", created_at: "2026-09-26T13:30:00Z" },
      { tenant_id: OTHER, budget_id: B, idem_key: "x:raise", platform: "meta", object_id: "theirs", op: "raise", daily_delta_usd: "1.00", amount_usd: "1.00", status: "committed", reason: null, created_at: "2026-09-26T14:00:00Z" },
    ];
    tables.decisions = [
      { id: META_DEC, tenant_id: T, decision_class: "meta_ads.update_ad_set_budget", approved_by: "user-1", approved_by_source: null, body: { name: "Spring promo", targeting: { geo_locations: ["SECRET-GEO"] } } },
      { id: DISPUTE_DEC, tenant_id: T, decision_class: "dispute-response.triage", approved_by: "user-1", approved_by_source: null, body: { name: "DISPUTE-NAME", evidence: "CARDHOLDER-EVIDENCE", customer_email: "guest@example.com" } },
    ];
    tables.channel_actions = [
      { id: CGO_ACT, tenant_id: T, exec_class: "google_ads.create_campaign", approved_by: "owner-1", approved_by_source: "cgo", body: { keywords: ["SECRET-KW"] } },
    ];
    tables.ad_budget_human_actions = [
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-26", note: "Raised in Ads Manager", amount_usd: "40.00", created_at: "2026-09-26T15:00:00Z", created_by: "user-1" },
    ];
    tables.ad_budget_events = [
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-26T10:00:00Z", kind: "setup", monthly_usd: "3000.00", daily_limit_usd: null, backfilled: false, actor: "user-2" },
    ];
  });

  it("carries no decision body, targeting, or dispute field, and joins only ad classes", async () => {
    const rows = await readAdBudgetLedger(T, "user-1");
    const flat = JSON.stringify(rows);
    for (const secret of ["SECRET-GEO", "SECRET-KW", "CARDHOLDER-EVIDENCE", "DISPUTE-NAME", "guest@example.com", "dispute", "targeting", "body"]) {
      expect(flat).not.toContain(secret);
    }
    expect(flat).not.toContain("theirs");

    const DISPLAY = /(\w+):(body|exec_payload)->>(name|object_id|ad_set_id|campaign_id|status|level|daily_budget_usd|expected_current_daily_budget_usd|cgo_order_origin)\b/g;
    for (const s of selects) {
      for (const m of s.cols.matchAll(/(\w+):(body|exec_payload)->>(\w+)/g)) expect(m[1]).toBe(m[3]);
      const withoutDisplay = s.cols.replace(DISPLAY, "");
      expect(withoutDisplay).not.toMatch(/body|targeting|evidence|payload/);
    }
    const dec = selects.find((s) => s.table === "decisions")!;
    const act = selects.find((s) => s.table === "channel_actions")!;
    expect(dec.cols).toBe("id, approved_by, approved_by_source, name:body->>name");
    expect(act.cols).toBe("id, approved_by, approved_by_source, name:exec_payload->>name");
    expect(dec.ors).toEqual(["decision_class.like.meta_ads.*,decision_class.like.google_ads.*,decision_class.like.chatgpt_ads.*,decision_class.like.reddit_ads.*,decision_class.like.x_ads.*,decision_class.like.tiktok_ads.*"]);
    expect(act.ors).toEqual(["exec_class.like.meta_ads.*,exec_class.like.google_ads.*,exec_class.like.chatgpt_ads.*,exec_class.like.reddit_ads.*,exec_class.like.x_ads.*,exec_class.like.tiktok_ads.*"]);

    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(byAction['Raised Meta ad set "Spring promo" by $20.00 a day']).toMatchObject({ kind: "hold", amount_usd: 125, amount_label: "$125.00 set aside", result: "Held", source: "person", by: "You" });
    expect(byAction["Created Google campaign 555 at $10.00 a day"]).toMatchObject({ amount_usd: 62.5, source: "cgo", by: "Autopilot" });
    expect(byAction["Raised Meta ad set …et-9 by $5.00 a day"]).toMatchObject({
      result: "Refused: over this month's budget",
      source: "automation",
      by: "Automatic",
      amount_label: "$30.00 asked for, not set aside",
    });
    expect(byAction['Turned on Meta ad set "Spring promo" ($50.00 a day)']).toMatchObject({
      result: "Paused at the start of the month: over the monthly budget",
      amount_label: "$312.50 set aside, then given back",
    });
    expect(byAction["Logged by hand: Raised in Ads Manager"]).toMatchObject({
      kind: "hand",
      date: "2026-09-26",
      amount_usd: 40,
      amount_label: "$40.00 (logged by hand)",
      result: "Logged",
      source: "person",
      by: "You",
    });
    expect(byAction["Budget set up: $3,000.00 a month"]).toMatchObject({
      kind: "event",
      date: null,
      amount_label: null,
      result: "Set up",
      at: "2026-09-26T10:00:00Z",
      source: "person",
      by: "A teammate",
    });
    expect(flat).not.toMatch(/until|ends|end date/i);
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort().reverse());
  });

  it("a hand log for the day it was logged sorts at the moment it was logged, above that day's earlier events", async () => {
    tables.ad_budget_events.push(
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-26T16:00:00+00:00", kind: "stop", monthly_usd: "3000.00", daily_limit_usd: null, backfilled: false },
    );
    const actions = (await readAdBudgetLedger(T)).map((r) => r.action);
    expect(actions.slice(0, 3)).toEqual([
      "Budget stopped ($3,000.00 a month)",
      "Logged by hand: Raised in Ads Manager",
      'Turned on Meta ad set "Spring promo" ($50.00 a day)',
    ]);
  });

  it("a backdated hand log sorts at the end of the date it names", async () => {
    tables.ad_budget_human_actions = [
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-25", note: "Paused last week", amount_usd: null, created_at: "2026-09-26T15:00:00Z" },
    ];
    tables.ad_budget_events.push(
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-25T09:00:00Z", kind: "edit", monthly_usd: "2000.00", daily_limit_usd: null, backfilled: false },
    );
    const rows = await readAdBudgetLedger(T);
    const hand = rows.find((r) => r.kind === "hand")!;
    expect(hand).toMatchObject({ at: "2026-09-25T23:59:59.999Z", date: "2026-09-25", amount_label: null });
    const actions = rows.map((r) => r.action);
    expect(actions.indexOf("Logged by hand: Paused last week")).toBe(actions.length - 2);
    expect(actions[actions.length - 1]).toBe("Budget changed to $2,000.00 a month, daily limit none");
  });

  it("a tenant with no budget has an empty ledger", async () => {
    expect(await readAdBudgetLedger("33333333-3333-3333-3333-333333333333")).toEqual([]);
  });

  it("an edit keeps the set-up amount and shows old → new; the budget's current amount is never read", async () => {
    rpcImpl = viewRpc({ monthly_usd: "2400.00" });
    tables.ad_budget_events.push(
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-27T09:00:00Z", kind: "edit", monthly_usd: "2400.00", daily_limit_usd: null, backfilled: false },
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-27T10:00:00Z", kind: "edit", monthly_usd: "2400.00", daily_limit_usd: "80.00", backfilled: false },
    );
    const rows = await readAdBudgetLedger(T);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("Budget set up: $3,000.00 a month");
    expect(actions).not.toContain("Budget set up: $2,400.00 a month");
    expect(rows.find((r) => r.at === "2026-09-27T09:00:00Z")).toMatchObject({
      action: "Budget changed: $3,000.00 → $2,400.00 a month",
      result: "Changed",
      source: "person",
      amount_usd: null,
    });
    expect(rows.find((r) => r.at === "2026-09-27T10:00:00Z")!.action).toBe("Budget changed: daily limit none → $80.00");
    expect(rpcCalls.filter((c) => c.fn === "ad_budget_month_view")).toEqual([]);
  });

  it("is company-wide: a stopped budget and the new one both show, newest first", async () => {
    const B2 = "bbbbbbbb-0000-0000-0000-000000000002";
    tables.ad_budget_events.push(
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-26T16:00:00Z", kind: "stop", monthly_usd: "3000.00", daily_limit_usd: null, backfilled: false },
      { tenant_id: T, budget_id: B2, occurred_at: "2026-09-27T08:00:00Z", kind: "setup", monthly_usd: "500.00", daily_limit_usd: "25.00", backfilled: false },
      { tenant_id: T, budget_id: B2, occurred_at: "2026-09-27T11:00:00Z", kind: "edit", monthly_usd: "600.00", daily_limit_usd: "30.00", backfilled: false },
    );
    tables.ad_budget_reservations.push(
      { tenant_id: T, budget_id: B2, idem_key: "k:create", platform: "meta", object_id: "adset-new", op: "create", daily_delta_usd: "5.00", amount_usd: "25.00", status: "committed", reason: null, created_at: "2026-09-27T09:30:00Z" },
    );
    const rows = await readAdBudgetLedger(T);
    const events = rows.filter((r) => /^Budget /.test(r.action)).map((r) => r.action);
    expect(events).toEqual([
      "Budget changed: $500.00 → $600.00 a month; daily limit $25.00 → $30.00",
      "Budget set up: $500.00 a month, up to $25.00 a day",
      "Budget stopped ($3,000.00 a month)",
      "Budget set up: $3,000.00 a month",
    ]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining([
      "Created Meta ad set …-new at $5.00 a day",
      'Raised Meta ad set "Spring promo" by $20.00 a day',
    ]));
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort().reverse());
  });

  it("never shows another tenant's events, even for the same budget id", async () => {
    tables.ad_budget_events.push(
      { tenant_id: OTHER, budget_id: B, occurred_at: "2026-09-27T12:00:00Z", kind: "edit", monthly_usd: "999.00", daily_limit_usd: null, backfilled: false },
      { tenant_id: OTHER, budget_id: "cccccccc-0000-0000-0000-000000000003", occurred_at: "2026-09-27T11:00:00Z", kind: "setup", monthly_usd: "777.00", daily_limit_usd: null, backfilled: false },
    );
    const flat = JSON.stringify(await readAdBudgetLedger(T));
    expect(flat).not.toContain("999");
    expect(flat).not.toContain("777");
    const theirs = await readAdBudgetLedger(OTHER);
    expect(theirs.filter((r) => /^Budget /.test(r.action)).map((r) => r.action)).toEqual(["Budget changed to $999.00 a month, daily limit none", "Budget set up: $777.00 a month"]);
  });

  it("a backfilled set up says it was recorded after the fact", async () => {
    tables.ad_budget_events = [
      { tenant_id: T, budget_id: B, occurred_at: "2026-09-26T10:00:00Z", kind: "setup", monthly_usd: "2400.00", daily_limit_usd: null, backfilled: true },
    ];
    const rows = await readAdBudgetLedger(T);
    expect(rows.find((r) => r.result === "Set up")!.action).toBe(
      "Budget set up: $2,400.00 a month (recorded after the fact: the amount on file when this history began)",
    );
  });
});

describe("readAdBudgetView", () => {
  it("an active budget shows this month's cap, spent, held and left from the SQL view", async () => {
    rpcImpl = viewRpc();
    const v = await readAdBudgetView(T);
    expect(v).toEqual({
      id: B,
      status: "active",
      monthly_usd: 3000,
      daily_limit_usd: null,
      started_on: "2026-09-20",
      stopped_at: null,
      month_start: "2026-09-01",
      next_month_start: "2026-10-01",
      days_left: 5,
      days_in_month: 30,
      month_cap_usd: 1100,
      spent_usd: 400,
      held_usd: 187.5,
      left_usd: 512.5,
      creator_held_usd: 0,
      creator_spent_usd: 0,
      still_running: [],
    });
    expect(selects.filter((s) => s.table === "ad_budget_reservations")).toEqual([]);
  });

  it("a stopped budget lists what still holds; another tenant has none", async () => {
    rpcImpl = viewRpc({ status: "stopped", stopped_at: "2026-09-26T16:00:00Z" });
    tables.ad_budget_reservations = [
      { tenant_id: T, budget_id: B, platform: "meta", object_id: "adset-2", status: "committed" },
      { tenant_id: T, budget_id: B, platform: "meta", object_id: "adset-2", status: "reserved" },
      { tenant_id: T, budget_id: B, platform: "meta", object_id: "adset-1", status: "released" },
    ];
    expect(await readAdBudgetView(T)).toMatchObject({ status: "stopped", still_running: [{ platform: "meta", object_id: "adset-2" }] });
    expect(await readAdBudgetView(OTHER)).toBeNull();
  });

  it("an unreadable view throws rather than showing a wrong number", async () => {
    rpcImpl = viewRpc({ status: "ended" });
    await expect(readAdBudgetView(T)).rejects.toThrow(/unreadable/);
  });
});

describe("ledger joins name real columns", () => {
  it("a join on a column the table does not have fails the read, never a silent pass", async () => {
    tables.decisions = [{ id: META_DEC, tenant_id: T, decision_class: "meta_ads.x", approved_by: null, approved_by_source: null }];
    const q = query(T, "decisions").select("id").or("class.like.meta_ads.*");
    const { error } = await new Promise<{ error: { message: string } | null }>((r) => q.then(r));
    expect(error?.message).toBe("column decisions.class does not exist");
  });
});

describe("ledger labels", () => {
  it("names an ad set or campaign from the approved action, else by the last 4 digits of its id", () => {
    expect(adObjectLabel("meta", "120212345678907890", "Spring  promo ")).toBe('Meta ad set "Spring promo"');
    expect(adObjectLabel("meta", "120212345678907890", null)).toBe("Meta ad set …7890");
    expect(adObjectLabel("google", "555", undefined)).toBe("Google campaign 555");
    expect(adObjectLabel("google", null, "")).toBe("Google campaign");
    expect(adObjectLabel("meta", "1", "x".repeat(200))).toBe(`Meta ad set "${"x".repeat(80)}"`);
  });
  it("a stop row carries the monthly amount at the time it stopped", () => {
    const row = eventRow({ budget_id: B, occurred_at: "2026-09-27T10:00:00Z", kind: "stop", monthly_usd: "2400.00", daily_limit_usd: null, backfilled: false }, undefined);
    expect(row).toMatchObject({ action: "Budget stopped ($2,400.00 a month)", result: "Stopped" });
  });
  it("By reads You, A teammate, Autopilot or Automatic", () => {
    expect(byLabel("person", "u1", "u1")).toBe("You");
    expect(byLabel("person", "u2", "u1")).toBe("A teammate");
    expect(byLabel("person", null, "u1")).toBe("A teammate");
    expect(byLabel("cgo", "u1", "u1")).toBe("Autopilot");
    expect(byLabel("automation", null, "u1")).toBe("Automatic");
  });
});

describe("input rules", () => {
  const today = "2026-09-26";
  it("accepts a monthly amount and an optional daily limit up to it; no end date", () => {
    expect(parseBudgetInput({ monthly_usd: 25000 })).toEqual({ ok: true, value: { monthly_usd: 25000, daily_limit_usd: null } });
    expect(parseBudgetInput({ monthly_usd: 100, daily_limit_usd: 100 }).ok).toBe(true);
    expect(parseBudgetInput({ monthly_usd: 100, ends_on: "2026-10-01" })).toEqual({ ok: true, value: { monthly_usd: 100, daily_limit_usd: null } });
  });
  it.each([
    [{ monthly_usd: "100" }, "Enter a monthly amount in dollars."],
    [{ total_usd: 100 }, "Enter a monthly amount in dollars."],
    [{ monthly_usd: 0 }, "The monthly budget must be at least $1."],
    [{ monthly_usd: -5 }, "The monthly budget must be at least $1."],
    [{ monthly_usd: 0.005 }, "The monthly budget must be at least $1."],
    [{ monthly_usd: 0.99 }, "The monthly budget must be at least $1."],
    [{ monthly_usd: 10_000_000 }, "The monthly budget must be less than $10,000,000."],
    [{ monthly_usd: 9_999_999.999 }, "The monthly budget must be less than $10,000,000."],
    [{ monthly_usd: 1e9 }, "The monthly budget must be less than $10,000,000."],
    [{ monthly_usd: 1e12 }, "The monthly budget must be less than $10,000,000."],
    [{ monthly_usd: 100, daily_limit_usd: 101 }, "The daily limit can't be more than the monthly amount."],
    [{ monthly_usd: 100, daily_limit_usd: 0 }, "The daily limit must be at least $1, or left empty."],
    [{ monthly_usd: 100, daily_limit_usd: 0.5 }, "The daily limit must be at least $1, or left empty."],
  ])("refuses %j with its own message", (body, msg) => {
    expect(parseBudgetInput(body)).toEqual({ ok: false, message: msg });
  });
  it("accepts the edges: $1 a month, a $1 daily limit, just under the maximum", () => {
    expect(parseBudgetInput({ monthly_usd: 1, daily_limit_usd: 1 })).toEqual({ ok: true, value: { monthly_usd: 1, daily_limit_usd: 1 } });
    expect(parseBudgetInput({ monthly_usd: 9_999_999.99 }).ok).toBe(true);
  });
  it("a human action needs a date, a short note, and an optional non-negative amount", () => {
    expect(parseHumanAction({ occurred_at: "2026-09-25", note: " Paused in Ads Manager ", amount_usd: null }, today)).toEqual({
      ok: true,
      value: { occurred_at: "2026-09-25", note: "Paused in Ads Manager", amount_usd: null },
    });
    expect(parseHumanAction({ occurred_at: "2026-09-25", note: "x".repeat(501) }, today).ok).toBe(false);
    expect(parseHumanAction({ occurred_at: "2026-10-05", note: "x" }, today).ok).toBe(false);
    expect(parseHumanAction({ occurred_at: "2026-09-25", note: "x", amount_usd: -1 }, today).ok).toBe(false);
  });
});

describe("the ledger names a cut's rebase (20260930030000)", () => {
  it("the new hold reads as a lowered budget, the replaced one as replaced", () => {
    expect(reservationAction({ platform: "meta", object_id: "123456", op: "rebase", daily_delta_usd: "80.00" }, "Spring promo")).toBe(
      'Lowered Meta ad set "Spring promo" to $80.00 a day',
    );
    expect(reservationResult({ status: "released", reason: "rebased" })).toBe("Replaced after a lower budget");
  });
});

describe("readAdBudgetLedger: executed ad changes (S7)", () => {
  const ACT_PAUSE = "a0000000-0000-0000-0000-00000000a001";
  const ACT_RAISE = "a0000000-0000-0000-0000-00000000a002";
  const DEC_PAUSE = "d0000000-0000-0000-0000-00000000d003";
  const DEC_AUTO = "d0000000-0000-0000-0000-00000000d004";
  const change = (over: Record<string, unknown>) => ({
    tenant_id: T,
    platform: "meta",
    object_id: "as1",
    level: "ad_set",
    campaign_id: "c1",
    object_name: "Awareness",
    source: "zavi",
    action_table: "channel_actions",
    action_id: ACT_PAUSE,
    change_kind: "status",
    before_status: "ACTIVE",
    after_status: "PAUSED",
    before_daily_usd: "19.00",
    after_daily_usd: "19.00",
    occurred_at: "2026-09-28T08:25:00Z",
    ...over,
  });

  beforeEach(() => {
    rpcImpl = viewRpc();
    tables.channel_actions = [
      { id: ACT_PAUSE, tenant_id: T, exec_class: "meta_ads.set_status", exec_status: "executed", executed_at: "2026-09-28T08:25:00Z", channel_slug: "meta_ads", approved_by: "owner-1", approved_by_source: "cgo", exec_payload: { object_id: "as1", level: "adset", status: "PAUSED", name: "Awareness", targeting: "SECRET-GEO" } },
      { id: ACT_RAISE, tenant_id: T, exec_class: "meta_ads.update_ad_set_budget", exec_status: "executed", executed_at: "2026-09-28T09:00:00Z", channel_slug: "meta_ads", approved_by: "user-1", approved_by_source: null, exec_payload: { ad_set_id: "as2", daily_budget_usd: 35, expected_current_daily_budget_usd: 20, name: "Spring" } },
      { id: "a0000000-0000-0000-0000-00000000a009", tenant_id: T, exec_class: "meta_ads.set_status", exec_status: null, channel_slug: "meta_ads", approved_by: null, approved_by_source: null, exec_payload: { object_id: "as7", status: "PAUSED" } },
      { id: "a0000000-0000-0000-0000-00000000a0ff", tenant_id: OTHER, exec_class: "meta_ads.set_status", exec_status: "executed", executed_at: "2026-09-28T09:30:00Z", channel_slug: "meta_ads", approved_by: "x", approved_by_source: null, exec_payload: { object_id: "theirs", status: "PAUSED", name: "THEIRS" } },
    ];
    tables.decisions = [
      { id: DEC_PAUSE, tenant_id: T, decision_class: "google_ads.set_status_review", status: "acted", dispatched_at: "2026-09-28T07:00:00Z", approved_by: "user-2", approved_by_source: null, body: { campaign_id: "42", status: "PAUSED", name: "Search" } },
      { id: DEC_AUTO, tenant_id: T, decision_class: "meta_ads.update_ad_set_budget", status: "acted", dispatched_at: "2026-09-28T06:00:00Z", approved_by: null, approved_by_source: null, body: { ad_set_id: "as3", daily_budget_usd: 10, expected_current_daily_budget_usd: 15 } },
    ];
    tables.ad_budget_reservations = [
      { tenant_id: T, budget_id: B, idem_key: `${ACT_RAISE}:raise`, platform: "meta", object_id: "as2", op: "raise", daily_delta_usd: "15.00", amount_usd: "93.75", status: "committed", reason: null, created_at: "2026-09-28T08:59:59Z" },
      { tenant_id: T, budget_id: B, idem_key: `${DEC_AUTO}:rebase`, platform: "meta", object_id: "as3", op: "rebase", daily_delta_usd: "10.00", amount_usd: "62.50", status: "committed", reason: null, created_at: "2026-09-28T06:00:01Z" },
      { tenant_id: T, budget_id: B, idem_key: "a0000000-0000-0000-0000-00000000a009:resume", platform: "meta", object_id: "as7", op: "resume", daily_delta_usd: "5.00", amount_usd: "30.00", status: "refused", reason: "over_month", created_at: "2026-09-28T05:00:00Z" },
    ];
    tables.ad_object_changes = [
      change({}),
      change({ id: "ch-out", source: "outside", action_table: null, action_id: null, object_id: "as5", object_name: "40% to Turo", before_status: "PAUSED", after_status: "ACTIVE", before_daily_usd: "25.00", occurred_at: "2026-09-28T10:00:00Z" }),
      change({ id: "ch-out2", source: "outside", action_table: null, action_id: null, object_id: "as6", object_name: "Brand", before_daily_usd: null, occurred_at: "2026-09-28T10:30:00Z" }),
      { ...change({ id: "ch-theirs", source: "outside", action_table: null, action_id: null, object_name: "THEIRS" }), tenant_id: OTHER },
    ].map((r, i) => ({ id: `ch-${i}`, ...r }));
    tables.ad_budget_human_actions = [];
    tables.ad_budget_events = [];
  });

  it("names the spend controller on its own orders, still under Autopilot", async () => {
    tables.channel_actions.push(
      { id: "a0000000-0000-0000-0000-00000000a010", tenant_id: T, exec_class: "meta_ads.update_ad_set_budget", exec_status: "executed", executed_at: "2026-09-28T09:10:00Z", channel_slug: "meta_ads", approved_by: "owner-1", approved_by_source: "cgo", body: { cgo_order_origin: "ad_spend_controller" }, exec_payload: { ad_set_id: "as8", daily_budget_usd: 45, expected_current_daily_budget_usd: 30, name: "Weekday Promo" } },
    );
    const rows = await readAdBudgetLedger(T, "user-1");
    const raise = rows.find((r) => r.action === 'Changed the daily budget of Meta ad set "Weekday Promo": $30.00 → $45.00');
    expect(raise).toMatchObject({ source: "cgo", by: "Autopilot spend controller" });
    expect(rows.find((r) => r.action === 'Paused Meta ad set "Awareness" (was on)')).toMatchObject({ source: "cgo", by: "Autopilot" });
  });

  it("one row per executed change: holds folded in (no double count), $ only from holds or a captured pause budget", async () => {
    const rows = await readAdBudgetLedger(T, "user-1");
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));

    expect(byAction['Paused Meta ad set "Awareness" (was on)']).toMatchObject({
      kind: "change",
      amount_usd: 19,
      amount_label: "about $19.00/day freed",
      result: "Done",
      source: "cgo",
      by: "Autopilot",
      undo: { change_id: "ch-0", change: 'Turn on Meta ad set "Awareness" again' },
    });
    expect(byAction['Changed the daily budget of Meta ad set "Spring": $20.00 → $35.00']).toMatchObject({
      kind: "change",
      amount_usd: 15,
      amount_label: "+$15.00/day set aside",
      result: "Held",
      source: "person",
      by: "You",
      undo: null,
    });
    expect(byAction['Paused Google campaign "Search"']).toMatchObject({ amount_usd: null, amount_label: "amount unknown", by: "A teammate", undo: null });
    expect(byAction["Changed the daily budget of Meta ad set as3: $15.00 → $10.00"]).toMatchObject({
      source: "channel",
      by: "Meta Ads channel",
      amount_usd: 10,
      amount_label: "now held at $10.00/day",
    });
    expect(byAction['Turned on Meta ad set "40% to Turo" (was off), outside Zavi']).toMatchObject({
      kind: "outside",
      source: "outside",
      by: "Outside Zavi",
      amount_usd: null,
      amount_label: null,
      undo: null,
    });
    expect(byAction['Paused Meta ad set "Brand" (was on), outside Zavi']).toMatchObject({ amount_label: "amount unknown", amount_usd: null });

    const holds = rows.filter((r) => r.kind === "hold");
    expect(holds.map((r) => r.action)).toEqual(["Turned on Meta ad set as7 ($5.00 a day)"]);
    expect(rows.filter((r) => r.kind === "change")).toHaveLength(4);
    const figures = rows.filter((r) => r.kind !== "hold" && r.amount_usd !== null).map((r) => r.amount_usd);
    expect(figures.sort()).toEqual([10, 15, 19]);
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort().reverse());
  });

  it("never another tenant's changes or payload fields beyond the display keys", async () => {
    const flat = JSON.stringify(await readAdBudgetLedger(T, "user-1"));
    expect(flat).not.toContain("THEIRS");
    expect(flat).not.toContain("theirs");
    expect(flat).not.toContain("SECRET-GEO");
    const theirs = await readAdBudgetLedger(OTHER);
    expect(theirs.map((r) => r.action)).toEqual(['Paused Meta ad set "THEIRS"', 'Paused Meta ad set "THEIRS" (was on), outside Zavi']);
  });

  it("Undo only on the newest change of its object", async () => {
    tables.ad_object_changes.unshift({ ...change({ id: "ch-new", source: "outside", action_table: null, action_id: null, before_status: "PAUSED", after_status: "ACTIVE", occurred_at: "2026-09-28T11:00:00Z" }) });
    const rows = await readAdBudgetLedger(T, "user-1");
    expect(rows.find((r) => r.action === 'Paused Meta ad set "Awareness" (was on)')!.undo).toBeNull();
  });
});

describe("stopAdBudget records its pauses as Zavi's (S7)", () => {
  it("each paused object gets a budget_stop record, so the hourly check never logs it as the founder's", async () => {
    rpcImpl = (fn) =>
      fn === "stop_ad_budget"
        ? { data: { status: "stopped", objects: [{ platform: "meta", object_id: "adset-1" }] }, error: null }
        : { data: { status: "released", released_usd: 0, inserted: 1 }, error: null };
    await stopAdBudget(T, "owner-1", B);
    const rec = rpcCalls.find((c) => c.fn === "record_ad_object_changes")!;
    expect(rec.tid).toBe(T);
    expect((rec.args.p_changes as Array<Record<string, unknown>>)[0]).toMatchObject({ object_id: "adset-1", source: "zavi", action_table: "budget_stop", after_status: "PAUSED" });
  });
});

it("labels doubled ChatGPT reservations as coverage, not the campaign's daily budget", async () => {
  const { reservationAction } = await import("../ad-budget-setup");
  expect(reservationAction({ platform: "chatgpt", object_id: "cmpn_test", op: "create", daily_delta_usd: 50 })).toContain("$50.00/day set aside (2× campaign rate)");
});
