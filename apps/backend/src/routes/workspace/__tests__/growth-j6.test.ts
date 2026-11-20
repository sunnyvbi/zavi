import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const HYP = "22222222-2222-4222-8222-222222222222";

const s = vi.hoisted(() => ({
  auth: null as null | { tenant_id: string; user_id: string; access_token: string; tenant_overridden?: boolean },
  role: "owner",
  rpc: [] as Array<{ tid: string; fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: { ok: true } as unknown, error: null as null | { message: string } },
  tables: {} as Record<string, unknown[]>,
  reads: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
  enqueued: [] as Array<Record<string, unknown>>,
  enqueueResult: { run_id: "run-1" } as { run_id: string } | Error,
  testsArgs: [] as unknown[],
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (s.auth) return s.auth;
    res.status(401).json({ error: { code: "unauthenticated" } });
    return null;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, allowed: readonly string[], res: Response) => {
    if (allowed.includes(s.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));

function builder(table: string) {
  const read = { table, filters: [] as Array<[string, string, unknown]> };
  s.reads.push(read);
  const q: Record<string, unknown> = {};
  const rec = (op: string) => (col: string, val: unknown) => {
    read.filters.push([op, col, val]);
    return q;
  };
  for (const op of ["eq", "in", "gte", "not", "is"]) q[op] = rec(op);
  for (const op of ["select", "order", "limit"]) q[op] = () => q;
  const rows = () =>
    (s.tables[table] ?? []).filter((row) =>
      read.filters.every(([op, col, val]) => op !== "eq" || !(row && typeof row === "object" && col in row) || (row as Record<string, unknown>)[col] === val),
    );
  q.then = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows(), error: null }).then(r, j);
  return q;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: builder }),
  tenantRpc: async (tid: string, fn: string, args: Record<string, unknown>) => {
    s.rpc.push({ tid, fn, args });
    return s.rpcResult;
  },
}));
vi.mock("@/services/supabase", () => ({ serverClientFromBearer: () => ({ from: builder }) }));
vi.mock("@/services/agents/runner", () => {
  class InsufficientCreditsError extends Error {}
  class FleetHaltedError extends Error {}
  return {
    InsufficientCreditsError,
    FleetHaltedError,
    enqueueAgentRun: vi.fn(async (input: Record<string, unknown>) => {
      s.enqueued.push(input);
      if (s.enqueueResult instanceof Error) throw s.enqueueResult;
      return s.enqueueResult;
    }),
  };
});
vi.mock("../growth-strategy-draft", () => ({
  draftDedupeKey: (t: string, d: Date) => `cgo:draft:${t}:${d.toISOString().slice(0, 10)}`,
  interviewPairs: () => [{ question: "q", answer: "a" }],
  researchForDraft: () => null,
}));
vi.mock("../growth-interview", () => ({ readNote: async () => ({ metadata: {} }) }));
vi.mock("../growth-intake-research", () => ({ readTodaysResearch: async () => null }));
const dfy = vi.hoisted(() => ({ state: "unavailable" as string, fail: false }));
vi.mock("../growth-done-for-you", () => ({
  readAndSettleDoneForYou: async () => {
    if (dfy.fail) throw new Error("db down");
    return {
      summary: {
        state: dfy.state,
        current: null,
        priorCantDo: new Set<string>(),
        attempts: [],
        winner: dfy.state === "done" ? { action_id: "r1" } : null,
        nextAttempt: 1,
      },
      rows: [],
      facts: { hasRecipe: () => true },
    };
  },
}));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: async () => false }));
const activity = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, outcome: "inserted" as string }));
vi.mock("@/services/activity/recordActivity", () => ({
  recordActivity: vi.fn(async (row: Record<string, unknown>) => {
    activity.rows.push(row);
    return activity.outcome;
  }),
}));
const flat = vi.hoisted(() => ({ on: true }));
vi.mock("@/services/billing/flat-pricing", async (orig) => ({
  ...(await orig<object>()),
  isFlatJobPricingOn: async () => flat.on,
}));
vi.mock("@/services/growth/goal-owner", () => ({ CGO_CARD_CLASS: "cgo.dispatch-specialist" }));
vi.mock("@/services/growth/cgo-tests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/growth/cgo-tests")>()),
  readTestsSummary: vi.fn(async (...args: unknown[]) => {
    s.testsArgs = args;
    return { won: 1, lost: 0, never_launched: 0, running: 0, next_read_on: null, items: [] };
  }),
}));

import { InsufficientCreditsError } from "@/services/agents/runner";
import { buildLinkedInExecCardBody, buildLinkedInLaunchCardBody } from "@/services/tools/linkedin-ads/_exec-action";
import { founderCampaignDraftStep } from "@/services/connectors/linkedin-ads/propose-campaign-draft";
import { recordBilledCredits } from "@/services/billing/flat-pricing";
import {
  budgetDelta,
  liveSnooze,
  openCardFromAction,
  openCardFromDecision,
  getGrowthDoneWeek,
  getGrowthOpenCards,
  getGrowthTests,
  postConstraintAgree,
  postConstraintFounder,
  postConstraintSwitch,
  postGrowthCardCopied,
} from "../growth-j6";

function mockRes() {
  const res: Record<string, unknown> = { statusCode: 200, body: null };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((b: unknown) => {
    res.body = b;
    return res;
  });
  return res as unknown as Response & { statusCode: number; body: any };
}
const req = (body: unknown = {}, query: Record<string, string> = {}) => ({ body, query, params: {} }) as unknown as Request;

beforeEach(() => {
  s.auth = { tenant_id: TENANT, user_id: "user-1", access_token: "tok" };
  s.role = "owner";
  s.rpc.length = 0;
  s.rpcResult = { data: { ok: true }, error: null };
  s.tables = {};
  s.reads.length = 0;
  s.enqueued.length = 0;
  s.enqueueResult = { run_id: "run-1" };
  flat.on = true;
});

describe("the diagnosis writes", () => {
  it("agree: owner/admin only, with the session's tenant and actor, never the body's", async () => {
    s.role = "member";
    const denied = mockRes();
    await postConstraintAgree(req({ agreed: true }), denied);
    expect(denied.statusCode).toBe(403);
    expect(s.rpc).toHaveLength(0);

    s.role = "admin";
    s.rpcResult = { data: { ok: true, constraint_agreed_at: "2026-10-26T00:00:00Z" }, error: null };
    const res = mockRes();
    await postConstraintAgree(req({ tenant_id: "evil" }), res);
    expect(res.body).toEqual({ ok: true, constraint_agreed_at: "2026-10-26T00:00:00Z" });
    expect(s.rpc).toEqual([{ tid: TENANT, fn: "set_constraint_agreed", args: { p_actor: "user-1", p_agreed: true } }]);
  });

  it("agree: no live plan is 409 no_plan; a non-boolean is 400", async () => {
    s.rpcResult = { data: { ok: false, code: "no_plan" }, error: null };
    const res = mockRes();
    await postConstraintAgree(req({ agreed: false }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("no_plan");
    const bad = mockRes();
    await postConstraintAgree(req({ agreed: "yes" }), bad);
    expect(bad.statusCode).toBe(400);
  });

  it("founder: trims, refuses empty / over-long / non-string, and null clears", async () => {
    for (const text of ["   ", "x".repeat(301), 5, undefined]) {
      const res = mockRes();
      await postConstraintFounder(req(text === undefined ? {} : { text }), res);
      expect(res.statusCode).toBe(400);
    }
    expect(s.rpc).toHaveLength(0);

    s.rpcResult = { data: { ok: true, founder_constraint: "Hosts cancel", founder_constraint_at: "t" }, error: null };
    const res = mockRes();
    await postConstraintFounder(req({ text: "  Hosts cancel  " }), res);
    expect(s.rpc[0]).toEqual({ tid: TENANT, fn: "set_founder_constraint", args: { p_actor: "user-1", p_text: "Hosts cancel" } });
    expect(res.body).toMatchObject({ ok: true, founder_constraint: "Hosts cancel" });

    const clear = mockRes();
    await postConstraintFounder(req({ text: null }), clear);
    expect(s.rpc[1].args.p_text).toBeNull();
  });

  it("an overridden tenant writes nothing", async () => {
    s.auth = { ...s.auth!, tenant_overridden: true };
    const res = mockRes();
    await postConstraintFounder(req({ text: "x" }), res);
    expect(res.statusCode).toBe(403);
    expect(s.rpc).toHaveLength(0);
  });
});

describe("Switch to Zavi's", () => {
  it("clears the founder's view, then starts a draft that forces the hypothesis as the constraint", async () => {
    s.rpcResult = { data: { ok: true, claim: "Hosts cancel too often" }, error: null };
    const res = mockRes();
    await postConstraintSwitch(req({ hypothesis_id: HYP, tenant_id: "evil" }), res);
    expect(res.body).toEqual({ ok: true, run_id: "run-1" });
    expect(s.rpc).toEqual([{ tid: TENANT, fn: "switch_plan_constraint_to_hypothesis", args: { p_actor: "user-1", p_hypothesis_id: HYP } }]);
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0]).toMatchObject({
      agent_slug: "cgo",
      tenant_id: TENANT,
      trigger: "manual",
      payload: { stage: "draft_strategy", forced_constraint: "Hosts cancel too often", interview: [{ question: "q", answer: "a" }] },
      user_access_token: "tok",
    });
    expect(String(s.enqueued[0].cron_dedupe_key)).toMatch(new RegExp(`^cgo:draft:${TENANT}:\\d{4}-\\d{2}-\\d{2}:switch:${HYP}$`));
  });

  it("a guess that is not this tenant's standing hypothesis starts nothing", async () => {
    s.rpcResult = { data: { ok: false, code: "no_hypothesis" }, error: null };
    const res = mockRes();
    await postConstraintSwitch(req({ hypothesis_id: HYP }), res);
    expect(res.statusCode).toBe(404);
    expect(s.enqueued).toHaveLength(0);
    const bad = mockRes();
    await postConstraintSwitch(req({ hypothesis_id: "not-a-uuid" }), bad);
    expect(bad.statusCode).toBe(400);
  });

  it("a repeat press returns the redraft already started; out of credits is 402", async () => {
    s.rpcResult = { data: { ok: true, claim: "c" }, error: null };
    s.enqueueResult = { run_id: "" };
    s.tables.agent_runs = [{ id: "run-earlier" }];
    const res = mockRes();
    await postConstraintSwitch(req({ hypothesis_id: HYP }), res);
    expect(res.body).toEqual({ ok: true, run_id: "run-earlier" });

    s.enqueueResult = new InsufficientCreditsError("no");
    const broke = mockRes();
    await postConstraintSwitch(req({ hypothesis_id: HYP }), broke);
    expect(broke.statusCode).toBe(402);
  });
});

describe("GET open-cards", () => {
  it("lists open and snoozed channel cards and open decisions, skipping work that is running or done", async () => {
    s.tables.channel_actions = [
      { id: "a1", channel_slug: "x_organic", status: "pending", snoozed_until: null, proposed_at: "2026-10-25T00:00:00Z", card_kind: "post", primary_label: "Copy & open", exec_class: null, exec_status: null, body: { step: { title: "Post the tip", body: "Why it matters", deliverable: { kind: "post", content: "The post text" }, effort: "minutes" } } },
      { id: "a2", channel_slug: "seo", status: "snoozed", snoozed_until: "2099-01-01T00:00:00Z", proposed_at: "2026-10-24T00:00:00Z", card_kind: "task", primary_label: "Do it", exec_class: null, exec_status: null, body: { intent: "answer", step: { title: "Which city first?" } } },
      { id: "a3", channel_slug: "meta_ads", status: "pending", snoozed_until: null, proposed_at: "2026-10-24T00:00:00Z", card_kind: "executes", primary_label: "Approve", exec_class: "meta_ads.update_ad_set_budget", exec_status: null, exec_payload: { ad_set_id: "1", verified_name: "Main", daily_budget_usd: 30, expected_current_daily_budget_usd: 20 }, body: { step: { title: "model words" } } },
      { id: "a4", channel_slug: "meta_ads", status: "pending", snoozed_until: null, proposed_at: "2026-10-24T00:00:00Z", card_kind: "executes", primary_label: "Approve", exec_class: "meta_ads.set_status", exec_status: "dispatching", body: {} },
      { id: "a5", channel_slug: "seo", status: "pending", snoozed_until: null, proposed_at: "2026-10-24T00:00:00Z", card_kind: "task", primary_label: "x", exec_class: null, exec_status: null, body: { step: { deliverable: { kind: "strategy", content: "x" } } } },
    ];
    s.tables.decisions = [
      { id: "d1", decision_class: "cgo.dispatch-specialist", status: "proposed", body: { intent: "Test a new hook", context_summary: "Clicks are cheap", target_agent_slug: "meta_ads" }, emitted_at: "2026-10-25T00:00:00Z", snoozed_until: null },
    ];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toEqual(["a1", "a2", "a3", "d1"]);
    expect(items[0].mins).toBe(5);
    expect(items[0]).toMatchObject({ source: "channel_action", kind: "post", title: "Post the tip", body: "The post text", why: "Why it matters", where: "X", snoozed_until: null });
    expect(items[1]).toMatchObject({ kind: "question", snoozed_until: "2099-01-01T00:00:00Z" });
    expect(items[2]).toMatchObject({ campaign_id: "1", platform: "meta_ads", account_id: null, can_redo: false });
    expect(items[0].can_redo).toBe(true);
    expect(items[3].can_redo).toBe(false);
    expect(items[0]).toMatchObject({ url: null, options: null });
    expect(items[2]).toMatchObject({ kind: "spend", amount: 10, title: "Raise “Main” from $20 to $30 a day", effect: "Raise “Main” from $20 to $30 a day" });
    expect(items[3]).toMatchObject({ source: "decision", kind: "plan", title: "Test a new hook", why: "Clicks are cheap", channel_slug: "meta_ads", primary_label: "Approve" });
    for (const r of s.reads) expect(r.filters).toContainEqual(["eq", "tenant_id", TENANT]);
  });

  it("leaves a held signup card off the list until it is let out or its date passes", async () => {
    const base = { channel_slug: "seo", proposed_at: "2026-10-25T00:00:00Z", card_kind: "task", primary_label: "Do it", exec_class: null, exec_status: null, body: { step: { title: "Fix the title" } } };
    s.tables.channel_actions = [
      { ...base, id: "held", status: "snoozed", snoozed_until: "2099-01-01T00:00:00Z", held_reason: "pacing" },
      { ...base, id: "due", status: "snoozed", snoozed_until: "2020-01-01T00:00:00Z", held_reason: "pacing" },
      { ...base, id: "released", status: "pending", snoozed_until: null, held_reason: "released" },
      { ...base, id: "later", status: "snoozed", snoozed_until: "2099-01-01T00:00:00Z", held_reason: null },
    ];
    s.tables.decisions = [];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id).sort()).toEqual(["due", "later", "released"]);
  });

  it("marks the cards Zavi may do for a Free workspace only while the offer is available, and fails closed", async () => {
    s.tables.channel_actions = [
      { id: "r1", channel_slug: "seo", status: "pending", snoozed_until: null, proposed_at: "2026-10-25T00:00:00Z", card_kind: "task", primary_label: "Do it", exec_class: null, exec_status: null, body: { step: { title: "Check /pricing" } } },
      { id: "p1", channel_slug: "x_organic", status: "pending", snoozed_until: null, proposed_at: "2026-10-25T00:00:00Z", card_kind: "post", primary_label: "Copy", exec_class: null, exec_status: null, body: { step: { title: "Post", deliverable: { kind: "post", content: "x" } } } },
    ];
    dfy.state = "available";
    let res = mockRes();
    await getGrowthOpenCards(req(), res);
    expect((res.body.items as Array<{ id: string; dfy: unknown }>).map((i) => [i.id, i.dfy])).toEqual([["r1", "research"], ["p1", null]]);
    expect(res.body.done_for_you).toMatchObject({ state: "available" });
    dfy.state = "done";
    res = mockRes();
    await getGrowthOpenCards(req(), res);
    expect((res.body.items as Array<{ dfy: unknown }>).every((i) => i.dfy === null)).toBe(true);
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual(["p1"]);
    dfy.fail = true;
    res = mockRes();
    await getGrowthOpenCards(req(), res);
    expect(res.body.done_for_you).toMatchObject({ state: "unavailable" });
    expect((res.body.items as Array<{ dfy: unknown }>).every((i) => i.dfy === null)).toBe(true);
    dfy.fail = false;
    dfy.state = "unavailable";
  });

  it("leaves out decisions for a channel the founder stopped", async () => {
    s.tables.tenant_channels = [{ channel_slug: "google_ads" }];
    const recent = new Date().toISOString();
    s.tables.decisions = [
      { id: "g1", dispatched_at: recent, decision_class: "google_ads.update_campaign_budget", status: "proposed", body: { campaign_id: "9" }, emitted_at: "2026-10-25T00:00:00Z", snoozed_until: null },
      { id: "g2", dispatched_at: recent, decision_class: "cgo.dispatch-specialist", status: "proposed", body: { intent: "Run search", target_agent_slug: "google_ads" }, emitted_at: "2026-10-25T00:00:00Z", snoozed_until: null },
      { id: "m1", dispatched_at: recent, decision_class: "cgo.dispatch-specialist", status: "proposed", body: { intent: "Test a hook", target_agent_slug: "meta_ads" }, emitted_at: "2026-10-25T00:00:00Z", snoozed_until: null },
    ];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    expect((res.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual(["m1"]);
    const stopRead = s.reads.find((r) => r.table === "tenant_channels");
    expect(stopRead?.filters).toContainEqual(["eq", "plan_selected_set_by", "founder_stopped"]);
  });

  it("a platform change stuck past its window becomes a check card", async () => {
    const stuckAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    s.tables.decisions = [
      { id: "d9", decision_class: "meta_ads.update_ad_set_budget", status: "dispatching", body: {}, emitted_at: stuckAt, dispatched_at: stuckAt, dispatch_error: null },
    ];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    const check = (res.body.items as Array<Record<string, unknown>>).find((i) => i.kind === "check");
    expect(check).toMatchObject({ id: "d9", tone: "danger", primary_label: "Check", channel_slug: "meta_ads" });
  });
});

describe("GET done-week", () => {
  it("says who did each: an executed change and an Autopilot close are Zavi's, a founder's mark is theirs", async () => {
    s.tables.channel_actions = [
      { id: "c1", channel_slug: "x_organic", status: "acted", status_at: "2026-10-25T00:00:00Z", exec_class: null, exec_status: null, body: { step: { title: "Posted" } } },
      { id: "c2", channel_slug: "meta_ads", status: "acted", status_at: "2026-10-24T00:00:00Z", exec_class: "meta_ads.set_status", exec_status: "executed", body: { step: { title: "Paused" } } },
      { id: "c3", channel_slug: "seo", status: "acted", status_at: "2026-10-23T00:00:00Z", exec_class: null, exec_status: null, body: { step: { title: "Closed by cgo" } } },
    ];
    s.tables.channel_action_events = [
      { action_id: "c1", actor_kind: "founder" },
      { action_id: "c3", actor_kind: "system" },
    ];
    s.tables.decisions = [{ id: "d1", decision_class: "cgo.dispatch-specialist", status: "acted", body: { intent: "Ran a test" }, emitted_at: "x", approved_at: "2026-10-26T00:00:00Z" }];
    const res = mockRes();
    await getGrowthDoneWeek(req(), res);
    expect(res.body.items.map((i: { id: string; by: string }) => [i.id, i.by])).toEqual([
      ["d1", "zavi"],
      ["c1", "founder"],
      ["c2", "zavi"],
      ["c3", "zavi"],
    ]);
  });
});

describe("GET tests", () => {
  it("passes the session's tenant and a bounded window", async () => {
    const res = mockRes();
    await getGrowthTests(req({}, { days: "500" }), res);
    expect(s.testsArgs[0]).toBe(TENANT);
    expect(s.testsArgs[3]).toBe(30);
    expect(res.body).toMatchObject({ won: 1 });
  });
});

describe("budgetDelta", () => {
  it("is the daily difference, or null without both amounts", () => {
    expect(budgetDelta({ daily_budget_usd: 12.5, expected_current_daily_budget_usd: 20 })).toBe(-7.5);
    expect(budgetDelta({ daily_budget_usd: 12.5 })).toBeNull();
  });
});

describe("OpenCard redo and LinkedIn account", () => {
  it("a channel.recipe_step decision with its run can be redone; a LinkedIn card carries its ad account", async () => {
    s.tables.channel_actions = [
      { id: "l1", channel_slug: "linkedin_ads", status: "pending", snoozed_until: null, proposed_at: "2026-10-25T00:00:00Z", card_kind: "executes", primary_label: "Approve", exec_class: "linkedin_ads.update_campaign", exec_status: null, exec_payload: { campaign_id: "123", account_id: "987" }, body: { step: { title: "t" } } },
    ];
    s.tables.decisions = [
      { id: "d2", agent_run_id: "run-9", decision_class: "channel.recipe_step", status: "proposed", body: { title: "Rewrite the bio" }, emitted_at: "2026-10-25T00:00:00Z", snoozed_until: null },
    ];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    const byId = new Map((res.body.items as Array<Record<string, unknown>>).map((i) => [`${i.source}:${i.id}`, i]));
    expect(byId.get("channel_action:l1")).toMatchObject({ campaign_id: "123", account_id: "987", platform: "linkedin_ads", can_redo: false });
    expect(byId.get("decision:d2")).toMatchObject({ can_redo: true, account_id: null });
  });
});

describe("an expired snooze is an open card again", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  it("returns snoozed_until only while it is in the future, for channel cards and decisions", () => {
    expect(liveSnooze("2026-10-27T00:00:00Z", now)).toBe("2026-10-27T00:00:00Z");
    expect(liveSnooze("2026-10-26T11:59:59Z", now)).toBeNull();
    expect(liveSnooze(null, now)).toBeNull();
    const card = { id: "a", channel_slug: "seo", status: "snoozed", snoozed_until: "2026-10-25T00:00:00Z", proposed_at: "x", body: {}, exec_class: null, exec_status: null, exec_payload: null, card_kind: "task", primary_label: null };
    expect(openCardFromAction({ ...card, exec_status: "failed", exec_claimed_at: "2026-10-27T00:00:00Z" }, now).exec_failed_at).toBe("2026-10-27T00:00:00Z");
    expect(openCardFromAction({ ...card, exec_status: "executed", exec_claimed_at: "2026-10-27T00:00:00Z" }, now).exec_failed_at).toBeNull();
    expect(openCardFromAction(card, now).snoozed_until).toBeNull();
    expect(openCardFromAction({ ...card, snoozed_until: "2026-10-28T00:00:00Z" }, now).snoozed_until).toBe("2026-10-28T00:00:00Z");
    const dec = { id: "d", decision_class: "internal.x", status: "proposed", body: {}, emitted_at: "x", snoozed_until: "2026-10-25T00:00:00Z" };
    expect(openCardFromDecision(dec, false, now).snoozed_until).toBeNull();
    expect(openCardFromDecision({ ...dec, snoozed_until: "2026-10-30T00:00:00Z" }, false, now).snoozed_until).toBe("2026-10-30T00:00:00Z");
  });
});

describe("POST cards/:id/copied (the Copy button is recorded server-side)", () => {
  const CARD = "33333333-3333-4333-8333-333333333333";
  const copied = (body: unknown, id = CARD) => ({ body, query: {}, params: { id } }) as unknown as Request;

  beforeEach(() => {
    activity.rows.length = 0;
    activity.outcome = "inserted";
  });

  it("records card.copy_clicked for this tenant's card, by the signed-in member, once per card per person", async () => {
    s.tables = { channel_actions: [{ id: CARD }] };
    const res = mockRes();
    await postGrowthCardCopied(copied({ source: "channel_action" }), res);
    expect(res.body).toEqual({ ok: true, recorded: true });
    expect(s.reads.at(-1)).toEqual({
      table: "channel_actions",
      filters: [["eq", "tenant_id", TENANT], ["eq", "id", CARD]],
    });
    expect(activity.rows).toEqual([
      expect.objectContaining({
        tenant_id: TENANT,
        verb: "card.copy_clicked",
        actor_type: "operator",
        actor_id: "user-1",
        object_type: "channel_action",
        object_id: CARD,
        source: "web",
        dedupe_key: `card.copy_clicked:${CARD}:user-1`,
      }),
    ]);
  });

  it("checks a decision card in decisions", async () => {
    s.tables = { decisions: [{ id: CARD }] };
    await postGrowthCardCopied(copied({ source: "decision" }), mockRes());
    expect(s.reads.at(-1)?.table).toBe("decisions");
    expect(activity.rows).toHaveLength(1);
  });

  it("a repeat press is reported as not newly recorded; a failed write is an error", async () => {
    s.tables = { channel_actions: [{ id: CARD, tenant_id: TENANT }] };
    activity.outcome = "duplicate";
    const dup = mockRes();
    await postGrowthCardCopied(copied({ source: "channel_action" }), dup);
    expect(dup.body).toEqual({ ok: true, recorded: false });
    activity.outcome = "failed";
    const failed = mockRes();
    await postGrowthCardCopied(copied({ source: "channel_action" }), failed);
    expect(failed.statusCode).toBe(500);
  });

  it("does not record a card that is not this tenant's", async () => {
    s.tables = { channel_actions: [{ id: CARD, tenant_id: "99999999-9999-4999-8999-999999999999" }] };
    const res = mockRes();
    await postGrowthCardCopied(copied({ source: "channel_action" }), res);
    expect(res.statusCode).toBe(404);
    expect(activity.rows).toHaveLength(0);
  });

  it("never counts staff viewing a tenant, and refuses a bad id or source", async () => {
    s.tables = { channel_actions: [{ id: CARD }] };
    s.auth = { ...s.auth!, tenant_overridden: true };
    const res = mockRes();
    await postGrowthCardCopied(copied({ source: "channel_action" }), res);
    expect(res.body).toEqual({ ok: true, recorded: false });
    s.auth = { tenant_id: TENANT, user_id: "user-1", access_token: "tok" };
    const bad = mockRes();
    await postGrowthCardCopied(copied({ source: "channel_action" }, "nope"), bad);
    expect(bad.statusCode).toBe(400);
    const badSource = mockRes();
    await postGrowthCardCopied(copied({ source: "other" }), badSource);
    expect(badSource.statusCode).toBe(400);
    expect(activity.rows).toHaveLength(0);
  });
});

describe("Today's LinkedIn cards", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const launch = { name: "CFO Checklist", total_budget_cents: 50000, currency: "USD", end_time: Date.UTC(2026, 10, 30, 17, 0), total_budget_usd: 500, campaign_binding_id: "b1", rationale: "It earned its clicks.", origin: "agent" };
  const SAID = "Launch “CFO Checklist”: $500 total, ends Nov 30, 2026, 5:00 PM UTC";
  const row = (over: Record<string, unknown>) => ({ id: "a1", channel_slug: "linkedin_ads", status: "pending", snoozed_until: null, proposed_at: "2026-10-25T00:00:00Z", body: {}, exec_class: null, exec_status: null, exec_payload: null, card_kind: null, primary_label: null, ...over });
  const dec = (decision_class: string, body: Record<string, unknown>) => ({ id: "d1", decision_class, status: "proposed", body, emitted_at: "2026-10-25T00:00:00Z" });

  describe("a launch starts spend", () => {
    it("on the decision rail, whose body has no title, it says which campaign, how much and until when", () => {
      const c = openCardFromDecision(dec("linkedin_ads.launch_campaign", launch), false, now);
      expect(c).toMatchObject({ kind: "spend", title: SAID, effect: SAID, approve_blocked: null, primary_label: "Approve" });
    });

    it("on the channel rail, the real stored card's bare title gives way to the same facts", () => {
      const { card } = buildLinkedInLaunchCardBody(launch as never);
      const c = openCardFromAction(row({ exec_class: "linkedin_ads.launch_campaign", exec_payload: launch, body: card, card_kind: "executes", primary_label: "Approve" }), now);
      expect(c).toMatchObject({ kind: "spend", title: SAID, effect: SAID, approve_blocked: null });
    });

    it.each([
      ["no name", { name: undefined }],
      ["no budget", { total_budget_cents: undefined }],
      ["no currency", { currency: undefined }],
      ["no end", { end_time: undefined }],
      ["an unusable end", { end_time: 8.65e15 }],
    ])("with %s the card cannot be approved, on either rail, whatever its stored title says", (_l, over) => {
      const body = { ...launch, ...over };
      for (const c of [
        openCardFromDecision(dec("linkedin_ads.launch_campaign", { ...body, title: "Approve this small tweak" }), false, now),
        openCardFromAction(row({ exec_class: "linkedin_ads.launch_campaign", exec_payload: body, body: { step: { title: "Approve this small tweak" } } }), now),
      ]) {
        expect(c.kind).toBe("spend");
        expect(c.title).toMatch(/would start spending/);
        expect(c.title).not.toMatch(/tweak|decision for you/);
        expect(c.approve_blocked).toMatch(/won't start this spend/);
        expect(c.effect).toBeNull();
      }
    });

    it("must-catch: carries the launch's dollar total and end on both rails, so Today's forecast can count it", () => {
      const { card } = buildLinkedInLaunchCardBody(launch as never);
      for (const c of [
        openCardFromDecision(dec("linkedin_ads.launch_campaign", launch), false, now),
        openCardFromAction(row({ exec_class: "linkedin_ads.launch_campaign", exec_payload: launch, body: card, card_kind: "executes", primary_label: "Approve" }), now),
      ]) {
        expect(c).toMatchObject({ launch_usd: 500, launch_ends_at: launch.end_time, amount: null });
      }
      expect(openCardFromDecision(dec("linkedin_ads.launch_campaign", { ...launch, name: undefined }), false, now)).toMatchObject({ launch_usd: null, launch_ends_at: null });
      expect(openCardFromDecision(dec("google_ads.update_campaign_budget", { campaign_id: "1", daily_budget_usd: 120, expected_current_daily_budget_usd: 110 }), false, now)).toMatchObject({ launch_usd: null, launch_ends_at: null });
    });

    it("other channels' launch and budget cards read as they did and stay approvable", () => {
      expect(openCardFromDecision(dec("meta_ads.launch_campaign", { title: "Launch the spring ads" }), false, now)).toMatchObject({ kind: "spend", title: "Launch the spring ads", effect: null, approve_blocked: null, stops_live_spend: false, opens_review: false });
      expect(openCardFromDecision(dec("google_ads.update_campaign_budget", { campaign_id: "1", verified_name: "Search", daily_budget_usd: 120, expected_current_daily_budget_usd: 110 }), false, now)).toMatchObject({ title: "Raise “Search” from $110 to $120 a day", amount: 10, approve_blocked: null });
    });
  });

  describe("a campaign draft", () => {
    const step = founderCampaignDraftStep("CFO Checklist", "2026-10-25");

    it("a row stored with the old Copy ad words opens the review, keyed on what the card is", () => {
      const c = openCardFromAction(row({ body: { step }, card_kind: "ad_manual", primary_label: "Copy ad" }), now);
      expect(c).toMatchObject({ kind: "task", opens_review: true, primary_label: "Review and create", title: "Review and create your LinkedIn campaign" });
    });

    it("a draft the model typed as an answer is still a draft", () => {
      expect(openCardFromAction(row({ body: { step, intent: "answer" }, card_kind: "task" }), now)).toMatchObject({ kind: "task", opens_review: true });
    });

    it("once it is bound for execution, or on any other channel, it is not this card", () => {
      expect(openCardFromAction(row({ body: { step }, exec_class: "linkedin_ads.create_campaign_bundle", card_kind: "executes", primary_label: "Approve" }), now)).toMatchObject({ kind: "spend", opens_review: false, primary_label: "Approve" });
      const chatgpt = { ...step, deliverable: { ...step.deliverable, presentation: { type: "campaign_draft", channel: "chatgpt_ads" } } };
      expect(openCardFromAction(row({ channel_slug: "chatgpt_ads", body: { step: chatgpt }, card_kind: "task", primary_label: "Review and create" }), now)).toMatchObject({ opens_review: false, primary_label: "Review and create" });
      expect(openCardFromAction(row({ channel_slug: "reddit_ads", body: { step: { title: "Run this ad", deliverable: { kind: "ad", content: "Buy" } } }, card_kind: "ad_manual", primary_label: "Copy ad" }), now)).toMatchObject({ opens_review: false, primary_label: "Copy ad" });
    });
  });

  describe("a pause of live spend", () => {
    const pause = { campaign_id: "123", account_id: "456", status: "PAUSED", name: "CFO Checklist", rationale: "You asked." };

    it("the real stored card is flagged, named, and says what approving does", () => {
      const { card } = buildLinkedInExecCardBody(pause as never);
      expect(openCardFromAction(row({ exec_class: "linkedin_ads.set_status", exec_payload: pause, body: card, card_kind: "executes" }), now)).toMatchObject({
        kind: "spend",
        stops_live_spend: true,
        title: 'Pause the LinkedIn campaign "CFO Checklist"',
        effect: expect.stringContaining("It stops spending until someone turns it back on"),
        campaign_id: "123",
      });
    });

    it("a row that lost its stored title is still titled, never a generic job", () => {
      expect(openCardFromAction(row({ exec_class: "linkedin_ads.set_status", exec_payload: pause, body: {} }), now).title).toBe('Pause the LinkedIn campaign "CFO Checklist"');
      expect(openCardFromAction(row({ exec_class: "linkedin_ads.set_status", exec_payload: { status: "PAUSED" }, body: {} }), now).title).toBe("Pause a live LinkedIn campaign");
    });

    it("a Meta pause is not flagged, so its card behaves as it did", () => {
      expect(openCardFromAction(row({ channel_slug: "meta_ads", exec_class: "meta_ads.set_status", exec_payload: { status: "PAUSED", level: "campaign", object_id: "9", verified_name: "Spring" }, body: {} }), now)).toMatchObject({ title: "Pause “Spring”", stops_live_spend: false });
    });
  });

  it("the read route carries all of it to the page", async () => {
    s.tables.channel_actions = [
      row({ id: "draft", body: { step: founderCampaignDraftStep("CFO Checklist", "2026-10-25") }, card_kind: "ad_manual", primary_label: "Copy ad" }),
      row({ id: "pause", exec_class: "linkedin_ads.set_status", exec_payload: { campaign_id: "123", account_id: "456", status: "PAUSED", name: "CFO Checklist" }, body: {} }),
    ];
    s.tables.decisions = [dec("linkedin_ads.launch_campaign", launch)];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    const byId = new Map((res.body.items as Array<Record<string, unknown>>).map((i) => [i.id, i]));
    expect(byId.get("draft")).toMatchObject({ opens_review: true, primary_label: "Review and create" });
    expect(byId.get("pause")).toMatchObject({ stops_live_spend: true });
    expect(byId.get("d1")).toMatchObject({ title: SAID, approve_blocked: null });
  });
});

describe("GET open-cards: what Change it costs", () => {
  const card = (id: string, channel_slug: string, extra: Record<string, unknown> = {}) => ({
    id,
    channel_slug,
    status: "pending",
    snoozed_until: null,
    proposed_at: "2026-10-25T00:00:00Z",
    card_kind: "post",
    primary_label: "Copy & open",
    exec_class: null,
    exec_status: null,
    body: { step: { title: "Post the tip", deliverable: { kind: "post", content: "x" } } },
    ...extra,
  });

  async function charged(channel_slug: string): Promise<number | null> {
    let written: number | null = null;
    const db = {
      runs: () => ({
        update: (v: Record<string, unknown>) => {
          written = v.billed_credits as number;
          const chain = { eq: () => chain, is: async () => ({ error: null }) };
          return chain;
        },
        select: () => ({}),
      }),
      config: () => ({ select: () => ({}) }),
    };
    await recordBilledCredits(
      {
        runId: "run-1",
        tenantId: TENANT,
        agentSlug: channel_slug,
        trigger: "channel_recipe",
        payload: { action_key: "a1", action_title: "Post the tip", note: "shorter", redo_of_action_id: "a1", origin_run_id: "r0", origin_position: 1 },
        cronDedupeKey: null,
      },
      db as never,
    );
    return written;
  }

  it("shows the flat price the redo run is charged, per channel", async () => {
    s.tables.channel_actions = [card("a1", "reddit_organic"), card("a2", "x_organic")];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    const items = res.body.items as Array<{ id: string; can_redo: boolean; redo_credits: number | null }>;
    expect(items.every((i) => i.can_redo)).toBe(true);
    const reddit = await charged("reddit_organic");
    const x = await charged("x_organic");
    expect(reddit).toBeGreaterThan(0);
    expect(x).toBeGreaterThan(0);
    expect(reddit).not.toBe(x);
    expect(items.map((i) => [i.id, i.redo_credits])).toEqual([["a1", reddit], ["a2", x]]);
  });

  it("shows no price when flat pricing is off, since the charge is then real cost", async () => {
    flat.on = false;
    s.tables.channel_actions = [card("a1", "reddit_organic")];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    expect(res.body.items[0]).toMatchObject({ can_redo: true, redo_credits: null });
  });

  it("shows no price where Change it is not offered, nor on a decision, nor for a job with no flat row", async () => {
    s.tables.channel_actions = [
      card("a1", "reddit_organic", { status: "pending", exec_class: "meta_ads.set_status", card_kind: "executes" }),
      card("a2", "not_a_channel"),
    ];
    s.tables.decisions = [
      { id: "d1", agent_run_id: "r9", decision_class: "channel.recipe_step", status: "proposed", body: { channel_slug: "reddit_organic", step: { title: "x" } }, emitted_at: "2026-10-25T00:00:00Z", snoozed_until: null },
    ];
    const res = mockRes();
    await getGrowthOpenCards(req(), res);
    const byId = Object.fromEntries((res.body.items as Array<{ id: string; redo_credits?: number | null }>).map((i) => [i.id, i.redo_credits ?? null]));
    expect(byId).toEqual({ a1: null, a2: null, d1: null });
  });
});
