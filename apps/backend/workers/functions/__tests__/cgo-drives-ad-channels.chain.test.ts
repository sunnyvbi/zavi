
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BUSINESS_CONTROL_DEFAULTS } from "@/services/growth/business-control-policy";
import { renderCgoBrief } from "@/services/growth/cgo-brief";

vi.mock("@/services/growth/cgo-hypotheses", async (orig) => ({
  ...((await orig()) as object),
  prepareHypotheses: async () => ({ rows: [], gate: undefined as never, refused: [], dropped: 0 }),
  refreshHypotheses: async () => [],
}));
import { makeAdBudgetFake, monthViewOf } from "./_ad-budget-fake";

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const rpcCalls: Array<{ fn: string; args: Row }> = [];
let fake = makeAdBudgetFake(null);
let autopilotOn = true;
let channelBudgetOk = true;
let failOpenCardsRead = false;

function field(row: Row, col: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) {
    const v = (row[m[1]] as Row | null | undefined)?.[m[2]];
    return v == null ? null : String(v);
  }
  return row[col];
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private single = false;
  private head = false;
  private lim = Infinity;
  private usedIn = false;
  constructor(private table: string) {}
  select(_c?: string, opts?: { head?: boolean }) {
    if (opts?.head) this.head = true;
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.patch = p;
    return this;
  }
  insert(r: Row | Row[]) {
    this.op = "insert";
    this.patch = Array.isArray(r) ? r[0] : r;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => field(r, c) === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => field(r, c) !== v);
    return this;
  }
  not(c: string, _o: string, v: unknown) {
    this.filters.push((r) => (field(r, c) ?? null) !== v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (field(r, c) ?? null) === v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.usedIn = true;
    this.filters.push((r) => vs.includes(field(r, c)));
    return this;
  }
  gte(c: string, v: string) {
    this.filters.push((r) => String(field(r, c) ?? "") >= v);
    return this;
  }
  or(expr?: string) {
    const terms = (expr ?? "").split(",");
    const parsed = terms.map((t) => /^([\w]+)\.(eq|gte)\.([^()]+)$/.exec(t));
    if (!expr || parsed.some((m) => !m)) return this;
    this.filters.push((r) => parsed.some((m) => (m![2] === "eq" ? String(field(r, m![1]) ?? "") === m![3] : String(field(r, m![1]) ?? "") >= m![3])));
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null; count?: number }) => A) | null, bad?: ((e: unknown) => B) | null) {
    if (this.op === "insert") {
      const row = { id: `${this.table}-${(db[this.table] ?? []).length + 1}`, ...this.patch };
      (db[this.table] ??= []).push(row);
      return Promise.resolve({ data: this.single ? row : [row], error: null }).then(ok, bad);
    }
    if (failOpenCardsRead && this.table === "channel_actions" && this.usedIn && this.op === "select") {
      return Promise.resolve({ data: null, error: { message: "read failed" } } as unknown as { data: unknown; error: null }).then(ok, bad);
    }
    const rows = (db[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.patch);
      return Promise.resolve({ data: rows, error: null }).then(ok, bad);
    }
    const out = rows.slice(0, this.lim);
    return Promise.resolve({ data: this.head ? null : this.single ? (out[0] ?? null) : out, error: null, count: rows.length }).then(ok, bad);
  }
}

async function rpc(fn: string, a: Row) {
  rpcCalls.push({ fn, args: a });
  switch (fn) {
    case "reserve_ad_spend":
    case "settle_ad_spend":
    case "note_ad_spend_ref":
    case "release_ad_spend_for_object":
      return fake.rpc(fn, a);
    case "ad_budget_month_view":
      return { data: monthViewOf(db.ad_budgets, a.p_tenant_id), error: null };
    case "ad_month_token":
      return { data: "month-token", error: null };
    case "channel_budget_allows":
      return { data: channelBudgetOk, error: null };
    case "channel_credits_30d":
      return { data: 0, error: null };
    case "stamp_channel_run": {
      const run = (db.agent_runs ?? []).find((r) => r.id === a.p_run_id && r.tenant_id === a.p_tenant_id);
      if (run && !run.channel_slug) run.channel_slug = a.p_channel_slug;
      return { data: !!run, error: null };
    }
    case "record_channel_run":
      return { data: null, error: null };
    case "record_channel_exec_action": {
      const run = (db.agent_runs ?? []).find((r) => r.id === a.p_run_id && r.tenant_id === a.p_tenant_id);
      const act = a.p_action as Row;
      const id = `act-${(db.channel_actions ?? []).length + 1}`;
      (db.channel_actions ??= []).push({
        id,
        tenant_id: a.p_tenant_id,
        run_id: a.p_run_id,
        channel_slug: run?.channel_slug ?? null,
        title: act.title,
        body: act.body,
        exec_class: act.exec_class,
        exec_payload: act.exec_payload,
        exec_status: null,
        status: "pending",
        approved_by: null,
        approved_by_source: null,
      });
      return { data: { ok: true, id }, error: null };
    }
    case "approve_channel_action": {
      const row = (db.channel_actions ?? []).find((r) => r.id === a.p_action_id);
      if (!row || row.tenant_id !== a.p_tenant_id) return { data: { ok: false, code: "not_found" }, error: null };
      if (row.exec_status === "queued") return { data: { ok: true, replayed: true, queued: true, attempt: 1, exec_status: "queued" }, error: null };
      Object.assign(row, { exec_status: "queued", approved_by: a.p_actor_user_id, approved_by_source: a.p_source ?? null });
      return { data: { ok: true, replayed: false, attempt: 1 }, error: null };
    }
  }
  throw new Error(`unexpected rpc ${fn}`);
}

const send = vi.fn(async (_e: Row) => ({}));
const enqueueAgentRun = vi.fn();
const decide = vi.fn();
const metaCreateAdSet = vi.fn();
const metaSetStatus = vi.fn();
const fbGet = vi.fn();
const logEventSpy = vi.fn(async (_e: Row) => {});
const metaDailySeries = vi.fn();
const googleRemoveResource = vi.fn();
const gateLogs = () => logEventSpy.mock.calls.map((c) => String((c[0] as Row).code)).filter((c) => c.startsWith("cgo.unattended_"));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}), send: (e: Row) => send(e) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: (t: string) => new Query(t), rpc }) }));
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async (k: string) => (k === "cgo_autopilot_enabled" ? autopilotOn : false),
}));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: async () => new Set(["research", "engineer", "pm", "content-design"]) }));
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: (...a: unknown[]) => enqueueAgentRun(...a) }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: (...a: unknown[]) => decide(...a) }));
const proDecision = { enforced: true, tier: "pro", required_tier: "starter", allowed: true };
vi.mock("@/services/agents/entitlement", () => ({
  checkAgentTier: async () => proDecision,
  createTierGate: () => ({ decide: async () => proDecision }),
  planUpgradeMessage: () => "upgrade",
}));
vi.mock("@/services/analytics/action-events", () => ({
  trackChannelRunStarted: vi.fn(),
  trackChannelActionProposed: vi.fn(),
  trackChannelActionExecuted: vi.fn(),
}));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (e: Row) => logEventSpy(e), LOG_META_KEYS: [] }));
const claimDecisionSpy = vi.fn();
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: (id: string) => claimDecisionSpy(id), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/waiver-resolve", () => ({ resolveWaiverState: vi.fn(async () => ({ state: "none" })) }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("../dispatch-notice", () => ({ buildDispatchNotice: vi.fn(), buildOpenPrNotice: vi.fn(), extractChatThreadId: vi.fn(() => null), extractSlackRouting: vi.fn(() => null), postDispatchNotice: vi.fn(), HANDLER_LABELS: {} }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: (...a: unknown[]) => metaCreateAdSet(...a) }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: (...a: unknown[]) => metaSetStatus(...a) }));
vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: (...a: unknown[]) => fbGet(...a), getAdAccountCurrency: async () => "USD" }));
vi.mock("@/services/channels/exec-kill-switch", async (orig) => ({
  ...(await orig<typeof import("@/services/channels/exec-kill-switch")>()),
  platformWriteEnabled: async () => true,
}));
let linkedinReasons: string[] = [];
let linkedinRunGo = true;
vi.mock("@/services/growth/linkedin-run-verdict", () => ({
  linkedinRunSaidGo: async () => linkedinRunGo,
}));
vi.mock("@/services/growth/linkedin-unattended", async (orig) => ({
  ...((await orig()) as object),
  loadLinkedinUnattended: async () => ({ reasons: linkedinReasons }),
}));
vi.mock("@/services/tools/meta-ads/daily_series", () => ({ fetchMetaDailySeries: (...a: unknown[]) => metaDailySeries(...a) }));
vi.mock("@/services/tools/meta-ads/pixel_health", () => ({ metaPixelHealthTool: { execute: async () => ({ overall_status: "healthy" }) } }));
vi.mock("@/services/tools/google-ads/write/remove_resource", () => ({ googleRemoveResource: (...a: unknown[]) => googleRemoveResource(...a) }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: async () => ({ cap: null, today_total_change_usd: 0, cap_row_absent: true }) }));

import { __testOnly_handlers as HANDLERS, __testOnly_executeDispatch as executeDispatch } from "../dispatch-decision";
import { buildExecDecisionRow } from "../dispatch-channel-action";
import { applyGoalMoves, type GoalMoves } from "@/services/growth/goal-owner";
import { resolveMetaAdsEmit } from "@/services/tools/meta-ads/write/_exec-action";
import { cgoApproveAdDecision, cgoApproveChannelAction } from "@/services/growth/cgo-ads";
import type { ClaimedExecAction } from "@/services/channels/exec-actions";

const T = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const G1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-09-26T12:00:00Z");
const acts = { kind: "scheduled" as const, alarm_keys: [], autopilot: true };

const createBody = {
  campaign_id: "camp-1",
  name: "Spring promo",
  daily_budget_usd: 40,
  optimization_goal: "LINK_CLICKS",
  billing_event: "IMPRESSIONS",
  targeting: { geo_locations: { countries: ["US"] } },
  rationale: "the best creative, tested small",
};

function withBudget(total: number) {
  fake = makeAdBudgetFake({ cap: total, days: 10 });
  db.ad_budgets = [
    { id: "budget-1", tenant_id: T, status: "active", monthly_usd: total, daily_limit_usd: null, actual_read_at: new Date().toISOString(), read_failed: {} },
  ];
}

function emitCard(cls: string, body: unknown): Promise<string> {
  const id = `dec-${db.decisions.length + 1}`;
  db.decisions.push({ id, tenant_id: T, agent_run_id: "cgo-run", decision_class: cls, status: "proposed", body });
  return Promise.resolve(id);
}

const metaMove = (): GoalMoves => ({
  goals: [{ goal_id: G1, status_line: "6 of 20 signups", moves: [{ target_agent_slug: "meta_ads", intent: "test a $40/day ad set on the best creative", why: "" }] }],
  goal_changes: [],
  channel_changes: [],
});

function allowCgo(slug: string) {
  db.tenant_channels.push({ tenant_id: T, channel_slug: slug, autorun: true, autorun_set_by: "founder", plan_selected: true, plan_selected_set_by: "plan" });
}

function cardRow(id: string) {
  const d = db.decisions.find((r) => r.id === id)!;
  return { ...d, handler: "praxis.dispatch_specialist" } as Parameters<(typeof HANDLERS)["praxis.dispatch_specialist"]>[0];
}

function execRow(actionId: string) {
  const a = db.channel_actions.find((r) => r.id === actionId)!;
  if (a.exec_status === "queued") a.exec_status = "dispatching";
  const claimed: ClaimedExecAction = {
    claim_id: "claim-1",
    tenant_id: String(a.tenant_id),
    channel_slug: String(a.channel_slug),
    exec_class: String(a.exec_class),
    exec_payload: a.exec_payload as Record<string, unknown>,
    approved_by: (a.approved_by as string | null) ?? null,
    approved_by_source: (a.approved_by_source as string | null) ?? null,
    agent_run_id: String(a.run_id),
  };
  return buildExecDecisionRow(actionId, claimed) as unknown as Parameters<(typeof HANDLERS)["meta_ads.create_ad_set"]>[0];
}

async function proposeOnRun(run_id: string, cls: string, body: Row): Promise<string> {
  const legacy = vi.fn(async () => "legacy-decision");
  const emit = await resolveMetaAdsEmit({ tenant_id: T, run_id, emit_decision: legacy });
  const id = await emit!(cls, body);
  expect(legacy).not.toHaveBeenCalled();
  return id;
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.autopilot_goals = [
    { id: G1, tenant_id: T, objective: "Get 20 signups", target_metric: "weekly_signups", target_value: 20, current_value: 6, current_value_at: new Date().toISOString(), due_date: "2026-10-31", status: "active", priority: 50, measurement_mode: "manual_reported" },
  ];
  db.decisions = [];
  db.agent_runs = [];
  db.channel_actions = [];
  db.cgo_notes = [];
  db.tenant_channels = [];
  db.ad_budgets = [];
  db.tenant_users = [{ tenant_id: T, user_id: OWNER, role: "owner" }];
  db.cgo_questions = [];
  db.ad_budget_reservations = [];
  failOpenCardsRead = false;
  logEventSpy.mockClear();
  metaDailySeries.mockReset();
  metaDailySeries.mockResolvedValue({ rows: [], truncated: false, time_range: { since: "2026-09-19", until: "2026-09-26" } });
  googleRemoveResource.mockReset();
  rpcCalls.length = 0;
  fake = makeAdBudgetFake(null);
  autopilotOn = true;
  channelBudgetOk = true;
  send.mockClear();
  enqueueAgentRun.mockReset();
  enqueueAgentRun.mockImplementation(async (input: { agent_slug: string; tenant_id: string; trigger: string; payload: Row }) => {
    const id = `run-${db.agent_runs.length + 1}`;
    db.agent_runs.push({ id, tenant_id: input.tenant_id, agent_slug: input.agent_slug, trigger: input.trigger, payload: input.payload, channel_slug: null });
    return { run_id: id };
  });
  decide.mockReset();
  decide.mockImplementation(async (a: { decision_id: string; tenant_id: string; actor: { user_id: string }; approver_source?: string }) => {
    const row = db.decisions.find((r) => r.id === a.decision_id && r.tenant_id === a.tenant_id);
    if (!row || row.status !== "proposed") return { ok: true, changed: false };
    Object.assign(row, { status: "approved", approved_by: a.actor.user_id, approved_by_source: a.approver_source ?? null });
    return { ok: true, changed: true };
  });
  metaCreateAdSet.mockReset();
  metaCreateAdSet.mockResolvedValue({ id: "new-as", status: "PAUSED" });
  metaSetStatus.mockReset();
  metaSetStatus.mockResolvedValue(undefined);
  fbGet.mockReset();
  fbGet.mockImplementation(async (_t: string, p: string, q: { fields: string }) =>
    q.fields.startsWith("id,optimization_goal,learning_stage_info")
      ? { id: p, optimization_goal: "OFFSITE_CONVERSIONS", learning_stage_info: { status: "SUCCESS" }, updated_time: "2026-08-01T00:00:00+0000", campaign: { objective: "OUTCOME_SALES" } }
      : q.fields === "campaign_id,lifetime_budget"
      ? { campaign_id: "camp-1", lifetime_budget: "0" }
      : q.fields === "daily_budget,lifetime_budget"
        ? { daily_budget: null, lifetime_budget: null }
        : { daily_budget: "4000" },
  );
});

const SPRING_VIDEO = { name: "Spring video", channel_type: "SEARCH", daily_budget_usd: 20, bidding: { strategy: "MANUAL_CPC" }, location_ids: [2840] };

describe("the CGO drives the Meta channel under an ad budget", () => {
  it("review -> cgo card -> channel run via direct-run -> action -> cgo approval -> held and created", async () => {
    withBudget(1000);
    allowCgo("meta_ads");

    await applyGoalMoves(T, "cgo-run", metaMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    expect(db.decisions).toHaveLength(1);
    expect(db.decisions[0]).toMatchObject({ decision_class: "cgo.dispatch-specialist", status: "approved", approved_by: OWNER, approved_by_source: "cgo" });

    const started = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(started.ok).toBe(true);
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(enqueueAgentRun.mock.calls[0][0]).toMatchObject({
      agent_slug: "meta_ads",
      tenant_id: T,
      trigger: "a2a",
      payload: { intent: "test a $40/day ad set on the best creative", message: "test a $40/day ad set on the best creative", dispatched_by: "cgo", goal_id: G1 },
    });
    expect(rpcCalls.some((c) => c.fn === "channel_budget_allows")).toBe(true);
    expect(db.agent_runs[0].channel_slug).toBe("meta_ads");

    const actionId = await proposeOnRun("run-1", "meta_ads.create_ad_set", createBody);
    expect(db.channel_actions[0]).toMatchObject({ id: actionId, channel_slug: "meta_ads", exec_status: "queued", approved_by: OWNER, approved_by_source: "cgo" });
    expect(send).toHaveBeenCalledWith({ id: `approve:${actionId}:1`, name: "channel-action.approved", data: { action_id: actionId } });

    const r = await HANDLERS["meta_ads.create_ad_set"](execRow(actionId));
    expect(r.ok).toBe(true);
    expect(r.created).toEqual({ platform: "meta", object_type: "ad_set", id: "new-as", status: "PAUSED" });
    expect(metaCreateAdSet).toHaveBeenCalledTimes(1);
    expect(metaCreateAdSet.mock.calls[0][1]).toMatchObject({ name: "Zavi · Spring promo", status: "PAUSED" });
    expect(metaCreateAdSet.mock.calls[0][1]).not.toHaveProperty("end_time");
    expect(fake.calls.find((c) => c.name === "reserve_ad_spend")?.args.p_paused).toBe(true);
    expect(fake.res.get(`${actionId}:create`)).toMatchObject({ status: "committed", amount: 50, paused: true });
  });

  it("S5: the channel run carries a structured brief built from the move and the goal as read at dispatch", async () => {
    withBudget(1000);
    const move: GoalMoves = {
      goals: [
        {
          goal_id: G1,
          moves: [
            {
              target_agent_slug: "meta_ads",
              intent: "test a $40/day ad set on the best creative",
              why: "Signups are flat and the best creative has not been tested on its own.",
              problem: "traffic",
              moves_metric: "cost per signup",
              boundaries: "Do not touch the Turo campaign.",
              expected_output: "The new ad set and what you expect it to cost per signup.",
            },
          ],
        },
      ],
      goal_changes: [],
      channel_changes: [],
    };
    await applyGoalMoves(T, "cgo-run", move, { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    db.autopilot_goals[0].current_value = 7;
    const started = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(started.ok).toBe(true);
    const payload = enqueueAgentRun.mock.calls[0][0].payload;
    expect(payload.cgo_brief).toEqual({
      goal: { objective: "Get 20 signups", target_metric: "weekly_signups", target_value: 20, current_value: 7, number_trusted: true, due_date: "2026-10-31" },
      judged_on: "cost per signup",
      problem: "traffic",
      boundaries: [
        "New daily ad budget for this order, all new ad sets together: at most $100. Do not touch the Turo campaign.",
        expect.stringMatching(/^Spend only inside the founder's ad budget: \$\d+ left this month\.$/),
        "Submit budget and status changes through the approval gate; saved owner controls decide unattended authority.",
        "If this order goes against one of your own open cards, do not do it: reply rejected.",
      ],
      expected_output: "The new ad set and what you expect it to cost per signup.",
      why: "Signups are flat and the best creative has not been tested on its own.",
      test: null,
    });
    expect(payload.goal_rev).toEqual(expect.any(String));
  });

  it("Top 10 #7: a move's test survives review -> card -> dispatch into the specialist's brief, budget held to the order's spend", async () => {
    withBudget(1000);
    const move: GoalMoves = {
      goals: [{
        goal_id: G1,
        moves: [{
          target_agent_slug: "meta_ads",
          intent: "test a new opening hook in one ad set",
          why: "One variable, so the result means something.",
          problem: "traffic",
          moves_metric: "cost per signup",
          test: { variable: "the opening hook", budget_usd: 5000, baseline: "$52 per signup", success_if: "under $40 per signup", stop_if: "over $80 after 5 days", readout_on: "2026-10-03" },
        }],
      }],
      goal_changes: [],
      channel_changes: [],
    };
    await applyGoalMoves(T, "cgo-run", move, { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    const started = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(started.ok).toBe(true);
    const brief = enqueueAgentRun.mock.calls[0][0].payload.cgo_brief;
    expect(brief.test).toMatchObject({ variable: "the opening hook", success_if: "under $40 per signup", stop_if: "over $80 after 5 days" });
    expect(brief.test.envelope).toBe("server");
    expect(renderCgoBrief(brief)).toContain("Zavi sets the stop from what runs");
    expect(renderCgoBrief(brief)).not.toContain("Test budget: $5000");
    expect(brief.boundaries.join(" ")).toMatch(/New daily ad budget for this order, all new ad sets together: at most \$\d+/);
  });

  it("an action from the channel's own scheduled run is approved by cgo too, and a resume is held", async () => {
    withBudget(5000);
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    db.channel_actions.push({ id: "old-pause", tenant_id: T, run_id: "old", channel_slug: "meta_ads", exec_class: "meta_ads.set_status", exec_payload: { object_id: "as-old", level: "adset", status: "PAUSED" }, exec_status: "executed", executed_at: "2026-08-01T00:00:00Z", status: "acted", approved_by_source: "cgo" });
    const actionId = await proposeOnRun("sched-1", "meta_ads.set_status", { object_id: "as-old", level: "adset", status: "ACTIVE", over_cap: false });
    expect(db.channel_actions.find((r) => r.id === actionId)).toMatchObject({ exec_status: "queued", approved_by_source: "cgo" });
    const r = await HANDLERS["meta_ads.set_status"](execRow(actionId));
    expect(r.ok).toBe(true);
    expect(metaSetStatus).toHaveBeenCalledTimes(1);
    expect(fake.res.get(`${actionId}:resume`)).toMatchObject({ status: "committed" });
  });

  it("the budget refuses through the auto-approval: approved by cgo, then refused before Meta, nothing held", async () => {
    withBudget(40);
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    const actionId = await proposeOnRun("sched-1", "meta_ads.create_ad_set", createBody);
    expect(db.channel_actions[0].approved_by_source).toBe("cgo");
    const r = await HANDLERS["meta_ads.create_ad_set"](execRow(actionId));
    expect(r).toMatchObject({ ok: false, error: "cap_refuse: ad_budget_over_month" });
    expect(metaCreateAdSet).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("an action queued by cgo does not run once Autopilot is switched off", async () => {
    withBudget(1000);
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    const actionId = await proposeOnRun("sched-1", "meta_ads.create_ad_set", createBody);
    expect(db.channel_actions[0].exec_status).toBe("queued");
    autopilotOn = false;
    const r = await HANDLERS["meta_ads.create_ad_set"](execRow(actionId));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/^cgo_not_authorized/);
    expect(metaCreateAdSet).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
  });

  it("an approval whose event is lost throws, and the retry re-sends the same event", async () => {
    withBudget(1000);
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    send.mockRejectedValueOnce(new Error("inngest down"));
    await expect(proposeOnRun("sched-1", "meta_ads.create_ad_set", createBody)).rejects.toThrow("inngest down");
    const actionId = String(db.channel_actions[0].id);
    expect(db.channel_actions[0].exec_status).toBe("queued");
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    expect(await cgoApproveChannelAction(T, actionId)).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ id: `approve:${actionId}:1`, name: "channel-action.approved", data: { action_id: actionId } });
  });

  it("a channel credit cap that is spent refuses the cgo channel run", async () => {
    withBudget(1000);
    channelBudgetOk = false;
    await applyGoalMoves(T, "cgo-run", metaMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(r.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe("T13: no budget, or Autopilot off, changes nothing", () => {
  it("no budget: the review makes no channel card and a scheduled action waits for the founder", async () => {
    await applyGoalMoves(T, "cgo-run", metaMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    expect(db.decisions).toHaveLength(0);

    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    await proposeOnRun("sched-1", "meta_ads.create_ad_set", createBody);
    expect(db.channel_actions[0]).toMatchObject({ exec_status: null, approved_by: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("a budget with Autopilot off: nothing is approved", async () => {
    withBudget(1000);
    autopilotOn = false;
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    await proposeOnRun("sched-1", "meta_ads.create_ad_set", createBody);
    expect(db.channel_actions[0].exec_status).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("a meta_ads card approved after the founder stopped the channel starts no channel run (Growth J6)", async () => {
    withBudget(1000);
    allowCgo("meta_ads");
    await applyGoalMoves(T, "cgo-run", metaMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    Object.assign(db.tenant_channels[0], { plan_selected: false, plan_selected_set_by: "founder_stopped" });
    const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(r.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("a leftover meta_ads card approved after the budget stopped starts no channel run", async () => {
    withBudget(1000);
    allowCgo("meta_ads");
    await applyGoalMoves(T, "cgo-run", metaMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    db.ad_budgets[0].status = "stopped";
    const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(r).toMatchObject({ ok: false, error: "cgo_not_authorized: target_not_allowed" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("a youtube_ads action (google classes) is cgo's while the budget is on", async () => {
    withBudget(1000);
    db.channel_actions.push({ id: "yt-1", tenant_id: T, channel_slug: "youtube_ads", exec_class: "google_ads.create_campaign", exec_payload: SPRING_VIDEO, exec_status: null, status: "pending" });
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    expect(await cgoApproveChannelAction(T, "yt-1")).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ id: "approve:yt-1:1", name: "channel-action.approved", data: { action_id: "yt-1" } });
  });

  it("a LinkedIn launch of a bound paused campaign is cgo's only when LinkedIn's own gate passes", async () => {
    withBudget(1000);
    const launch = (id: string, origin: string) =>
      db.channel_actions.push({ id, tenant_id: T, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.launch_campaign", exec_payload: { origin }, exec_status: null, status: "pending" });
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    linkedinReasons = ["linkedin_paid_consent_required"];
    launch("li-held", "agent");
    expect(await cgoApproveChannelAction(T, "li-held")).toBe(false);
    expect(db.channel_actions.find((r) => r.id === "li-held")?.exec_status).toBeNull();
    linkedinReasons = [];
    launch("li-ok", "agent");
    expect(await cgoApproveChannelAction(T, "li-ok")).toBe(true);
    expect(send).toHaveBeenLastCalledWith({ id: "approve:li-ok:1", name: "channel-action.approved", data: { action_id: "li-ok" } });
    launch("li-ask", "user_initiated_chat");
    expect(await cgoApproveChannelAction(T, "li-ask")).toBe(false);
    expect(db.channel_actions.find((r) => r.id === "li-ask")?.exec_status).toBeNull();
  });

  it("a LinkedIn launch waits while its run has no recorded go verdict, however the model answered the tool", async () => {
    withBudget(1000);
    linkedinReasons = [];
    linkedinRunGo = false;
    db.channel_actions.push({ id: "li-no-go", tenant_id: T, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.launch_campaign", exec_payload: { origin: "agent", fit_verdict: "here" }, exec_status: null, status: "pending" });
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    expect(await cgoApproveChannelAction(T, "li-no-go")).toBe(false);
    expect(db.channel_actions.find((r) => r.id === "li-no-go")?.exec_status).toBeNull();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ data: { action_id: "li-no-go" } }));
    expect(await cgoApproveChannelAction(T, "li-no-go", { runSaidGo: true })).toBe(true);
    linkedinRunGo = true;
  });

  it("a LinkedIn launch LinkedIn's own gate passes is still held while the founder's business controls are on", async () => {
    withBudget(1000);
    db.growth_business_policies = [{ tenant_id: T, policy: { ...BUSINESS_CONTROL_DEFAULTS, enabled: true }, revision: 1, updated_at: new Date().toISOString() }];
    linkedinReasons = [];
    db.channel_actions.push({ id: "li-controlled", tenant_id: T, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.launch_campaign", exec_payload: { origin: "agent" }, exec_status: null, status: "pending" });
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    expect(await cgoApproveChannelAction(T, "li-controlled")).toBe(false);
    expect(db.channel_actions.find((r) => r.id === "li-controlled")?.exec_status).toBeNull();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ data: { action_id: "li-controlled" } }));
    expect(logEventSpy.mock.calls.map((c) => (c[0] as Row).meta)).toContainEqual({ hold_reasons: "business_controls_no_linkedin" });
  });

  it("a youtube_ads action with no budget is left for the founder", async () => {
    db.channel_actions.push({ id: "yt-2", tenant_id: T, channel_slug: "youtube_ads", exec_class: "google_ads.set_status", exec_payload: {}, exec_status: null, status: "pending" });
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    expect(await cgoApproveChannelAction(T, "yt-2")).toBe(false);
    expect(db.channel_actions[0].exec_status).toBeNull();
  });

  it("an action on a channel cgo does not drive is never cgo's, even with an ads class", async () => {
    withBudget(1000);
    db.channel_actions.push({ id: "li-1", tenant_id: T, channel_slug: "seo", exec_class: "google_ads.set_status", exec_payload: {}, exec_status: null, status: "pending" });
    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    expect(await cgoApproveChannelAction(T, "li-1")).toBe(false);
    expect(db.channel_actions[0].exec_status).toBeNull();
  });
});

describe("the decisions door", () => {
  function decision(id: string, cls: string, body: Row = {}, status = "proposed") {
    db.decisions.push({ id, tenant_id: T, decision_class: cls, status, body });
  }

  it("approves an unstamped youtube_ads run's google_ads decision as cgo", async () => {
    withBudget(1000);
    decision("d-6", "google_ads.create_campaign", SPRING_VIDEO);
    expect(await cgoApproveAdDecision(T, "d-6", "google_ads.create_campaign", SPRING_VIDEO, "youtube_ads")).toBe(true);
    expect(decide.mock.calls[0][0]).toMatchObject({ decision_id: "d-6", action: "approve", approver_source: "cgo" });
  });

  it("review Q6: a Google create the founder asked for in chat is stamped and left to the founder; the same body from a cron run is approved", async () => {
    const { withFounderOrigin } = await import("@/services/tools/google-ads/write/_propose-guard");
    const base = { tenant_id: T, log: () => {} };
    withBudget(1000);
    const founder = withFounderOrigin({ ...base, run_trigger: "chat" }, SPRING_VIDEO);
    expect(founder).toMatchObject({ origin: "user_initiated_chat" });
    decision("d-7", "google_ads.create_campaign", founder);
    expect(await cgoApproveAdDecision(T, "d-7", "google_ads.create_campaign", founder, "youtube_ads")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    const cron = withFounderOrigin({ ...base, run_trigger: "cron" }, SPRING_VIDEO);
    expect(cron).toEqual(SPRING_VIDEO);
    decision("d-8", "google_ads.create_campaign", cron);
    expect(await cgoApproveAdDecision(T, "d-8", "google_ads.create_campaign", cron, "youtube_ads")).toBe(true);
  });

  it("approves a proposed Meta/Google ads decision as cgo while the budget is on", async () => {
    withBudget(1000);
    decision("d-1", "google_ads.create_ad_group", { campaign_id: "1234567890" });
    expect(await cgoApproveAdDecision(T, "d-1", "google_ads.create_ad_group", { campaign_id: "1234567890" })).toBe(true);
    expect(decide.mock.calls[0][0]).toMatchObject({ decision_id: "d-1", action: "approve", actor: { user_id: OWNER }, approver_source: "cgo" });
  });

  it("GS05: the same $55 -> $110 raise gets the same answer on the plain and the review class", async () => {
    withBudget(1000);
    const raise = { ad_set_id: "123456789012345", daily_budget_usd: 110, expected_current_daily_budget_usd: 55, over_cap: true, rationale: "" };
    const raise2 = { ...raise, ad_set_id: "123456789012346" };
    decision("g5-plain", "meta_ads.update_ad_set_budget", raise);
    decision("g5-review", "meta_ads.update_ad_set_budget_review", raise2);
    const plain = await cgoApproveAdDecision(T, "g5-plain", "meta_ads.update_ad_set_budget", raise);
    const review = await cgoApproveAdDecision(T, "g5-review", "meta_ads.update_ad_set_budget_review", raise2);
    expect(review).toBe(plain);
    expect(review).toBe(true);
    const big = { ...raise, ad_set_id: "123456789012347", daily_budget_usd: 300 };
    decision("g5-big", "meta_ads.update_ad_set_budget_review", big);
    expect(await cgoApproveAdDecision(T, "g5-big", "meta_ads.update_ad_set_budget_review", big)).toBe(false);
    expect(decide.mock.calls.map((c) => (c[0] as { decision_id: string }).decision_id)).not.toContain("g5-big");
  });

  it("GS05 spacing: a chained second raise within 24 hours goes to the founder, at the door and at dispatch; a founder-approved one is unaffected", async () => {
    withBudget(1000);
    const AS = "123456789012345";
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    decision("g5-first", "meta_ads.update_ad_set_budget_review", { ad_set_id: AS, daily_budget_usd: 110, expected_current_daily_budget_usd: 55, over_cap: true, rationale: "" }, "acted");
    db.decisions.find((r) => r.id === "g5-first")!.dispatched_at = tenMinAgo;
    const second = { ad_set_id: AS, daily_budget_usd: 220, expected_current_daily_budget_usd: 110, over_cap: true, rationale: "" };
    decision("g5-second", "meta_ads.update_ad_set_budget_review", second);
    expect(await cgoApproveAdDecision(T, "g5-second", "meta_ads.update_ad_set_budget_review", second)).toBe(false);
    expect(decide.mock.calls.map((c) => (c[0] as { decision_id: string }).decision_id)).not.toContain("g5-second");
    const row = (source: string) =>
      ({ id: "g5-second", tenant_id: T, agent_run_id: "run-x", decision_class: "meta_ads.update_ad_set_budget_review", body: second, status: "dispatching", approved_by_source: source }) as unknown as Parameters<(typeof HANDLERS)["meta_ads.update_ad_set_budget_review"]>[0];
    const held = await HANDLERS["meta_ads.update_ad_set_budget_review"](row("cgo"));
    expect(held).toMatchObject({ ok: false, held_for_founder: true });
    expect(String(held.error)).toContain("already raised this budget in the last 24 hours");
    const founder = await HANDLERS["meta_ads.update_ad_set_budget_review"](row("founder"));
    expect((founder as { held_for_founder?: boolean }).held_for_founder).not.toBe(true);
    expect(String(founder.error ?? "")).not.toMatch(/cgo_not_authorized|Autopilot left this/);
    db.decisions.find((r) => r.id === "g5-first")!.dispatched_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
    expect(await cgoApproveAdDecision(T, "g5-second", "meta_ads.update_ad_set_budget_review", second)).toBe(true);
  });

  it("leaves alone: no budget, a non-ads class, an auto row, and a change the founder asked for in chat", async () => {
    decision("d-1", "meta_ads.create_ad_set");
    expect(await cgoApproveAdDecision(T, "d-1", "meta_ads.create_ad_set", {})).toBe(false);
    withBudget(1000);
    decision("d-2", "slack.post_message");
    expect(await cgoApproveAdDecision(T, "d-2", "slack.post_message", {})).toBe(false);
    decision("d-3", "meta_ads.update_ad_set_budget", {}, "auto");
    expect(await cgoApproveAdDecision(T, "d-3", "meta_ads.update_ad_set_budget", {})).toBe(false);
    decision("d-4", "meta_ads.update_ad_set_budget_review");
    expect(await cgoApproveAdDecision(T, "d-4", "meta_ads.update_ad_set_budget_review", { origin: "user_initiated_chat" })).toBe(false);
    decision("d-5", "google_ads.set_status");
    expect(await cgoApproveAdDecision(T, "d-5", "google_ads.set_status", {}, "email_marketing")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("the open-advice invariant (2026-09-28 regression)", () => {
  const TURO = "120259468814150059";
  const pauseTuro = { object_id: TURO, level: "campaign", name: "40% to Turo", status: "PAUSED", over_cap: false };
  const pauseAwareness = { object_id: "120200000000000001", level: "campaign", name: "Upcar - All States - Awareness", status: "PAUSED", over_cap: false };

  function adviceCard(over: Row = {}) {
    db.channel_actions.push({
      id: "advice-1",
      tenant_id: T,
      run_id: "meta-run-0921",
      channel_slug: "meta_ads",
      title: "Rebuild 40% to Turo as a conversion campaign",
      body: { step: { title: "Rebuild", body: "It optimizes for reach; bookings need a conversion objective." } },
      exec_class: null,
      exec_payload: null,
      exec_status: null,
      status: "pending",
      ...over,
    });
  }

  it("cgo orders the pause, the channel proposes it: NOT auto-approved, and the card carries the hold", async () => {
    withBudget(1000);
    adviceCard();
    const order: GoalMoves = {
      goals: [{ goal_id: G1, moves: [{ target_agent_slug: "meta_ads", intent: "Pause the Turo and Awareness campaigns: zero bookings, signups or leads", why: "" }] }],
      goal_changes: [],
      channel_changes: [],
    };
    const set = (id: string, name: string) => ({ id, name, goal: null, learning: false, days_since_edit: 30, spend_7d_usd: 100, conversions_7d: 0, tracking: "ok" as const, label: "judged on cost per conversion" as const });
    const evidence = {
      paid: [{ channel_slug: "meta_ads", status: "read" as const, campaigns: [{ id: TURO, name: "Turo", objective: null, label: "judged on cost per conversion" as const, ad_sets: [set("t1", "Turo")] }, { id: "aw", name: "Awareness", objective: null, label: "judged on cost per conversion" as const, ad_sets: [set("a1", "Awareness")] }] }],
      organic: [],
      own_moves: [],
    };
    await applyGoalMoves(T, "cgo-run", order, { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts, evidence });
    const started = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(started.ok).toBe(true);

    const turoId = await proposeOnRun("run-1", "meta_ads.set_status", pauseTuro);
    const awarenessId = await proposeOnRun("run-1", "meta_ads.set_status", pauseAwareness);
    const turo = db.channel_actions.find((r) => r.id === turoId)!;
    const awareness = db.channel_actions.find((r) => r.id === awarenessId)!;
    expect(turo).toMatchObject({ exec_status: null, approved_by: null, approved_by_source: null, status: "pending" });
    expect(awareness).toMatchObject({ exec_status: null, approved_by: null, approved_by_source: null, status: "pending" });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ name: "channel-action.approved" }));
    expect(metaSetStatus).not.toHaveBeenCalled();
    expect(db.channel_actions.find((r) => r.id === "advice-1")).toMatchObject({ status: "pending" });

    expect(db.cgo_questions).toHaveLength(0);
    expect(turo.cgo_hold).toMatchObject({ reasons: expect.arrayContaining(["pause_needs_founder", "open_advice_conflict"]) });
    expect(awareness.cgo_hold).toMatchObject({ reasons: ["pause_needs_founder"] });
    expect(gateLogs()).toEqual(["cgo.unattended_ask_founder", "cgo.unattended_ask_founder"]);

    const { cgoApproveChannelAction } = await import("@/services/growth/cgo-ads");
    expect(await cgoApproveChannelAction(T, turoId)).toBe(false);
    expect(await cgoApproveChannelAction(T, awarenessId)).toBe(false);
    expect(db.cgo_questions).toHaveLength(0);
  });

  it("a cgo move that names the card's object is refused at the review; the card is the ask, no question (cgo-log 2026-10-23)", async () => {
    withBudget(1000);
    adviceCard({ title: "Rebuild “40% to Turo” as a conversion campaign" });
    const order: GoalMoves = {
      goals: [{ goal_id: G1, moves: [{ target_agent_slug: "meta_ads", intent: "Pause 40% to Turo: zero bookings in 14 days", why: "" }] }],
      goal_changes: [],
      channel_changes: [],
    };
    await applyGoalMoves(T, "cgo-run", order, { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    expect(db.decisions).toHaveLength(0);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(db.cgo_questions).toHaveLength(0);
    const note = db.cgo_notes.find((n) => n.run_id === "cgo-run")!;
    expect(note.refused).toEqual(expect.arrayContaining([expect.stringContaining("names the object of the channel's open card")]));
  });

  it("the decisions door: the same pause proposed as a decision is not approved", async () => {
    withBudget(1000);
    adviceCard();
    db.decisions.push({ id: "d-9", tenant_id: T, agent_run_id: "meta-run-0928", decision_class: "meta_ads.set_status", status: "proposed", body: pauseTuro });
    expect(await cgoApproveAdDecision(T, "d-9", "meta_ads.set_status", pauseTuro, "meta_ads")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(db.cgo_questions).toHaveLength(0);
  });

  const createTuro = { ...createBody, campaign_id: TURO, name: "40% to Turo" };

  it("an unreadable open-cards read fails closed: nothing approved, the card carries the hold", async () => {
    withBudget(1000);
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    failOpenCardsRead = true;
    const id = await proposeOnRun("sched-1", "meta_ads.create_ad_set", createTuro);
    expect(db.channel_actions.find((r) => r.id === id)).toMatchObject({ exec_status: null, approved_by_source: null });
    expect(db.cgo_questions).toHaveLength(0);
    expect(db.channel_actions.find((r) => r.id === id)?.cgo_hold).toMatchObject({ reasons: expect.arrayContaining(["open_advice_unreadable"]), words: expect.arrayContaining([expect.stringContaining("could not check the channel's other cards")]) });
    db.decisions.push({ id: "d-10", tenant_id: T, agent_run_id: "x", decision_class: "meta_ads.create_ad_set", status: "proposed", body: createTuro });
    expect(await cgoApproveAdDecision(T, "d-10", "meta_ads.create_ad_set", createTuro, "meta_ads")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });

  it("another tenant's card, a closed card, or the run's own same-direction envelope card does not block", async () => {
    withBudget(1000);
    adviceCard({ id: "other-tenant", tenant_id: "99999999-9999-4999-8999-999999999999" });
    adviceCard({ id: "closed", status: "rejected" });
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    adviceCard({ id: "same-run", run_id: "sched-1", title: "Create a 40% to Turo ad set", body: { step: { title: "Create", body: "Test it small first." } } });
    const id = await proposeOnRun("sched-1", "meta_ads.create_ad_set", createTuro);
    expect(db.channel_actions.find((r) => r.id === id)).toMatchObject({ exec_status: "queued", approved_by_source: "cgo" });
    expect(db.cgo_questions).toHaveLength(0);
  });

  it("S1: a card from the SAME run that says something else about the object (rebuild) does block", async () => {
    withBudget(1000);
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    adviceCard({ id: "same-run-rebuild", run_id: "sched-1" });
    const id = await proposeOnRun("sched-1", "meta_ads.create_ad_set", createTuro);
    expect(db.channel_actions.find((r) => r.id === id)).toMatchObject({ exec_status: null, approved_by_source: null });
    expect(db.cgo_questions).toHaveLength(0);
  });
});

describe("S1: the unattended gate sits on every door", () => {
  const TURO = "120259468814150059";
  const pause = { object_id: TURO, level: "adset", name: "40% to Turo", status: "PAUSED", over_cap: false };
  const createTuro = { ...createBody, campaign_id: TURO, name: "40% to Turo" };
  const removal = { level: "campaign", campaign_id: "1234567890", rationale: "gone", name: "Old search" };

  function advice(run_id = "meta-run-0921") {
    db.channel_actions.push({
      id: "advice-1", tenant_id: T, run_id, channel_slug: "meta_ads",
      title: "Rebuild 40% to Turo as a conversion campaign",
      body: { step: { body: "It optimizes for reach; bookings need a conversion objective." } },
      exec_class: null, exec_payload: null, exec_status: null, status: "pending",
    });
  }
  function queuedByCgo(id: string, exec_class: string, exec_payload: Row, channel_slug = "meta_ads") {
    db.channel_actions.push({ id, tenant_id: T, run_id: "sched-1", channel_slug, title: "x", exec_class, exec_payload, exec_status: "queued", status: "pending", approved_by: OWNER, approved_by_source: "cgo" });
  }

  it("decision row door: google_ads.remove_resource is denied, never approved", async () => {
    withBudget(1000);
    db.decisions.push({ id: "d-rm", tenant_id: T, agent_run_id: null, decision_class: "google_ads.remove_resource", status: "proposed", body: removal });
    expect(await cgoApproveAdDecision(T, "d-rm", "google_ads.remove_resource", removal, "google_ads")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(gateLogs()).toEqual(["cgo.unattended_deny"]);
  });

  it("channel action door: a pause stays the founder's card, and the card carries the hold", async () => {
    withBudget(1000);
    db.agent_runs.push({ id: "sched-1", tenant_id: T, agent_slug: "meta_ads", trigger: "cron", channel_slug: "meta_ads" });
    const id = await proposeOnRun("sched-1", "meta_ads.set_status", pause);
    expect(db.channel_actions.find((r) => r.id === id)).toMatchObject({ exec_status: null, status: "pending" });
    expect(gateLogs()).toEqual(["cgo.unattended_ask_founder"]);
    expect(db.channel_actions.find((r) => r.id === id)?.cgo_hold).toMatchObject({ reasons: ["pause_needs_founder"] });
    expect(db.cgo_questions).toHaveLength(0);
    expect(metaSetStatus).not.toHaveBeenCalled();
  });

  it("dispatch-specialist auto-run: a card for a target cgo may not start is not auto-run", async () => {
    withBudget(1000);
    const { autoRunCgoCard } = await import("@/services/growth/cgo-auto-run");
    db.decisions.push({ id: "d-eng", tenant_id: T, agent_run_id: "cgo-run", decision_class: "cgo.dispatch-specialist", status: "proposed", body: { target_agent_slug: "engineer", intent: "ship it", goal_id: G1 } });
    expect(await autoRunCgoCard(T, "d-eng")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(gateLogs()).toEqual(["cgo.unattended_deny"]);
  });

  it("dispatch-specialist executor: an order naming an open card's object is held, no channel run", async () => {
    withBudget(1000);
    db.channel_actions.push({ id: "advice-q", tenant_id: T, run_id: "r0", channel_slug: "meta_ads", title: "Rebuild “40% to Turo”", body: {}, exec_class: null, exec_payload: null, exec_status: null, status: "pending" });
    db.decisions.push({ id: "d-ord", tenant_id: T, agent_run_id: "cgo-run", decision_class: "cgo.dispatch-specialist", status: "dispatching", approved_by_source: "cgo", body: { target_agent_slug: "meta_ads", intent: "Pause 40% to Turo now", goal_id: G1 } });
    const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("d-ord"));
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(gateLogs()).toEqual(["cgo.unattended_ask_founder"]);
  });

  it("queued, then new advice arrives: the executor re-check holds it for the founder (channel action)", async () => {
    withBudget(1000);
    queuedByCgo("act-q", "meta_ads.create_ad_set", createTuro);
    advice();
    const r = await HANDLERS["meta_ads.create_ad_set"](execRow("act-q"));
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(metaCreateAdSet).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
    expect(gateLogs()).toEqual(["cgo.unattended_ask_founder"]);
    expect(db.cgo_questions).toHaveLength(0);
  });

  it("a cgo pause queued before S1 is held at the executor, never sent", async () => {
    withBudget(1000);
    queuedByCgo("act-p", "meta_ads.set_status", pause);
    const r = await HANDLERS["meta_ads.set_status"](execRow("act-p"));
    expect(r).toMatchObject({ ok: false, held_for_founder: true });
    expect(metaSetStatus).not.toHaveBeenCalled();
    expect(gateLogs()).toEqual(["cgo.unattended_ask_founder"]);
  });

  it("a cgo-approved remove_resource is denied at the executor: terminal, nothing removed", async () => {
    withBudget(1000);
    queuedByCgo("act-rm", "google_ads.remove_resource", removal, "google_ads");
    const r = await HANDLERS["google_ads.remove_resource"](execRow("act-rm"));
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("held_for_founder");
    expect(String(r.error)).toMatch(/^cgo_not_authorized/);
    expect(googleRemoveResource).not.toHaveBeenCalled();
    expect(gateLogs()).toEqual(["cgo.unattended_deny"]);
  });

  it("missing refs: an ad change whose own object cannot be named is the founder's", async () => {
    withBudget(1000);
    db.decisions.push({ id: "d-norefs", tenant_id: T, agent_run_id: null, decision_class: "google_ads.create_campaign", status: "proposed", body: {} });
    expect(await cgoApproveAdDecision(T, "d-norefs", "google_ads.create_campaign", {}, "google_ads")).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(gateLogs()).toEqual(["cgo.unattended_ask_founder"]);
  });

  it("read error: the goal behind the run cannot be read, so nothing is approved", async () => {
    withBudget(1000);
    db.agent_runs.push({ id: "run-x", tenant_id: T, agent_slug: "meta_ads", trigger: "a2a", channel_slug: "meta_ads", payload: { goal_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } });
    const id = await proposeOnRun("run-x", "meta_ads.create_ad_set", createTuro);
    expect(db.channel_actions.find((r) => r.id === id)).toMatchObject({ exec_status: null });
    expect(gateLogs()).toEqual(["cgo.unattended_ask_founder"]);
  });

  it("a typed-in goal number older than 14 days is a note, not a hold, on a spend-up under the budget (rule f, C4)", async () => {
    withBudget(1000);
    db.autopilot_goals[0].current_value_at = "2026-09-01T00:00:00Z";
    db.agent_runs.push({ id: "run-g", tenant_id: T, agent_slug: "meta_ads", trigger: "a2a", channel_slug: "meta_ads", payload: { goal_id: G1 } });
    const id = await proposeOnRun("run-g", "meta_ads.create_ad_set", createTuro);
    expect(db.channel_actions.find((r) => r.id === id)).toMatchObject({ exec_status: "queued", approved_by_source: "cgo" });
    expect(db.cgo_questions).toHaveLength(0);
    expect(gateLogs()).toContain("cgo.unattended_allow_noted");
  });

  it("decisions executor: ask_founder durably returns the row to the founder's queue, CGO approval cleared", async () => {
    withBudget(1000);
    advice();
    const row = { id: "d-held", tenant_id: T, agent_run_id: "sched-9", decision_class: "meta_ads.create_ad_set", status: "dispatching", handler: "meta_ads.create_ad_set", body: createTuro, approved_by: OWNER, approved_by_source: "cgo" };
    db.decisions.push({ ...row });
    claimDecisionSpy.mockResolvedValueOnce({ ...row });
    const res = await executeDispatch("d-held");
    expect(res).toMatchObject({ ok: false, error: "held_for_founder" });
    expect(db.decisions.find((r) => r.id === "d-held")).toMatchObject({ status: "proposed", approved_by: null, approved_by_source: null });
    expect(String(db.decisions.find((r) => r.id === "d-held")!.dispatch_error)).toContain("waiting for you");
    expect(metaCreateAdSet).not.toHaveBeenCalled();
    expect(db.cgo_questions).toHaveLength(0);
  });
});

describe("R2: cgo directs an organic channel; publishing stays the founder's click", () => {
  const organicMove = (): GoalMoves => ({
    goals: [{ goal_id: G1, status_line: "6 of 20 signups", moves: [{ target_agent_slug: "x_organic", intent: "Draft three X posts from host earnings stories", why: "" }] }],
    goal_changes: [],
    channel_changes: [],
  });

  it("review -> cgo card started by cgo -> x_organic run (direct-run, stamped) -> its publish proposals are NOT approved", async () => {
    allowCgo("x_organic");
    await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    expect(db.decisions[0]).toMatchObject({ decision_class: "cgo.dispatch-specialist", status: "approved", approved_by_source: "cgo", body: expect.objectContaining({ target_agent_slug: "x_organic" }) });

    const started = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(started.ok).toBe(true);
    expect(enqueueAgentRun.mock.calls[0][0]).toMatchObject({ agent_slug: "x_organic", trigger: "a2a", payload: { message: "Draft three X posts from host earnings stories", dispatched_by: "cgo", goal_id: G1 } });
    expect(rpcCalls.some((c) => c.fn === "channel_budget_allows")).toBe(true);
    expect(db.agent_runs[0].channel_slug).toBe("x_organic");

    db.decisions.push({ id: "pub-1", tenant_id: T, agent_run_id: "run-1", decision_class: "social.publish.v2", status: "proposed", body: { channel: "x", text: "Phoenix hosts earned $1,900 in September." } });
    expect(await cgoApproveAdDecision(T, "pub-1", "social.publish.v2", db.decisions[1].body, "x_organic")).toBe(false);
    expect(db.decisions[1].status).toBe("proposed");
    db.channel_actions.push({ id: "post-1", tenant_id: T, run_id: "run-1", channel_slug: "x_organic", title: "X post", exec_class: null, exec_payload: null, exec_status: null, status: "pending", body: {} });
    expect(await cgoApproveChannelAction(T, "post-1")).toBe(false);
    expect(db.channel_actions[0]).toMatchObject({ status: "pending", exec_status: null });
    expect(db.channel_actions[0].approved_by_source).not.toBe("cgo");
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("the founder stopped the channel before the dispatch (Growth J6): the organic run does not start", async () => {
    allowCgo("x_organic");
    await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    Object.assign(db.tenant_channels[0], { plan_selected: false, plan_selected_set_by: "founder_stopped" });
    const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("you stopped x_organic") });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("the founder took the channel out of the plan before the dispatch: the organic run does not start", async () => {
    allowCgo("x_organic");
    await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    expect(db.decisions[0].approved_by_source).toBe("cgo");
    Object.assign(db.tenant_channels[0], { plan_selected: false, plan_selected_set_by: "founder" });
    const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("out of the plan") });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("Autopilot switched off before the dispatch: the organic run does not start", async () => {
    allowCgo("x_organic");
    await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
    expect(db.decisions[0].approved_by_source).toBe("cgo");
    autopilotOn = false;
    const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
    expect(r.ok).toBe(false);
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  function founderAsksFirst(slug: string) {
    const row = db.tenant_channels.find((r) => r.channel_slug === slug);
    const ask = { autorun: false, autorun_set_by: "founder", autorun_set_at: "2026-10-12T10:00:00.000000Z" };
    if (row) Object.assign(row, ask);
    else db.tenant_channels.push({ tenant_id: T, channel_slug: slug, plan_selected: true, plan_selected_set_by: "plan", ...ask });
  }

  describe("the founder's switch (ask first under Autopilot, 2026-10-12)", () => {
    it("an untouched channel under Autopilot: cgo approves and starts its own card", async () => {
      await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
      expect(db.decisions[0]).toMatchObject({ decision_class: "cgo.dispatch-specialist", status: "approved", approved_by_source: "cgo" });
    });

    it("founder set ask first: cgo files the card and does not start it", async () => {
      founderAsksFirst("x_organic");
      await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
      expect(db.decisions).toHaveLength(1);
      expect(db.decisions[0]).toMatchObject({ decision_class: "cgo.dispatch-specialist", status: "proposed" });
      expect(db.decisions[0].approved_by_source).toBeUndefined();
      expect(decide).not.toHaveBeenCalled();
      expect(enqueueAgentRun).not.toHaveBeenCalled();
    });

    it("switched off after cgo approved its card: dispatch hands it back to the founder, in plain words", async () => {
      allowCgo("x_organic");
      await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
      expect(db.decisions[0].approved_by_source).toBe("cgo");
      founderAsksFirst("x_organic");
      const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
      expect(r).toMatchObject({ ok: false, held_for_founder: true, error: expect.stringContaining("You set X to ask first, so cgo does not run it.") });
      expect(enqueueAgentRun).not.toHaveBeenCalled();
    });

    it("ask first, the founder approves the card: it runs (the switch only binds cgo)", async () => {
      founderAsksFirst("x_organic");
      await applyGoalMoves(T, "cgo-run", organicMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
      Object.assign(db.decisions[0], { status: "approved", approved_by: OWNER, approved_by_source: null });
      const r = await HANDLERS["praxis.dispatch_specialist"](cardRow("dec-1"));
      expect(r.ok).toBe(true);
      expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    });

    it("an ad channel under a budget obeys it too: ask first, the Meta card waits for the founder", async () => {
      withBudget(1000);
      founderAsksFirst("meta_ads");
      await applyGoalMoves(T, "cgo-run", metaMove(), { emitDecision: emitCard, resolveRepo: async () => null, now: NOW, meta: acts });
      expect(db.decisions[0]).toMatchObject({ status: "proposed", body: expect.objectContaining({ target_agent_slug: "meta_ads" }) });
      expect(enqueueAgentRun).not.toHaveBeenCalled();
    });
  });
});
