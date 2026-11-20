import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/supabase", async () => {
  const { sharedDb } = await import("./fake-db");
  return { serviceClient: () => sharedDb.client };
});
import { sharedDb as db } from "./fake-db";
import {
  buildEnvelope,
  createFitsEnvelope,
  createOf,
  parseEnvelope,
  resolveApprover,
  verifyEnvelope,
  type ApprovalEnvelope,
} from "@/services/approvals/approval-envelope";
import { envelopeDoor, EnvelopeSendError } from "@/services/approvals/envelope-door";
import { recordChannelExecAction } from "@/services/channels/exec-actions";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

const plan = { channel_slug: "chatgpt_ads", budget_type: "lifetime" as const, total_usd: 58, daily_usd: null, start: "2026-10-15", end: "2026-10-17", days: 2, switched_from: null };
const ENV: ApprovalEnvelope = buildEnvelope({ envelope_id: "ask:run-1", tenant_id: T, approver: { user_id: OWNER, role: "owner", surface: "chat" }, plan });
const chatgptPayload = (campaign: Record<string, unknown>) => ({ bundle: { campaign: { start_time: day("2026-10-15") + 3600, end_time: day("2026-10-17"), ...campaign } }, currency: "USD" });

describe("createFitsEnvelope", () => {
  it("a create inside the envelope fits; one cent over, a day longer, or another channel does not", () => {
    expect(createFitsEnvelope(ENV, createOf("chatgpt_ads.create_and_launch", chatgptPayload({ lifetime_budget_micros: 58_000_000 })))).toBe(true);
    expect(createFitsEnvelope(ENV, createOf("chatgpt_ads.create_and_launch", chatgptPayload({ lifetime_budget_micros: 58_010_000 })))).toBe(false);
    expect(createFitsEnvelope(ENV, createOf("chatgpt_ads.create_and_launch", chatgptPayload({ lifetime_budget_micros: 58_000_000, end_time: day("2026-10-18") })))).toBe(false);
    expect(createFitsEnvelope({ ...ENV, channel: "tiktok_ads" }, createOf("chatgpt_ads.create_and_launch", chatgptPayload({ lifetime_budget_micros: 58_000_000 })))).toBe(false);
  });
  it("a daily create fits only when factor x daily x days stays inside the total", () => {
    const daily = { ...ENV, max_total_usd: 150, max_daily_usd: 25 };
    expect(createFitsEnvelope(daily, createOf("chatgpt_ads.create_and_launch", chatgptPayload({ daily_budget_micros: 25_000_000, start_time: day("2026-10-15"), end_time: day("2026-10-17") })))).toBe(true);
    expect(createFitsEnvelope({ ...daily, max_total_usd: 149 }, createOf("chatgpt_ads.create_and_launch", chatgptPayload({ daily_budget_micros: 25_000_000, start_time: day("2026-10-15"), end_time: day("2026-10-17") })))).toBe(false);
  });
  it("TikTok: a launch with an end date fits; without one it never does", () => {
    const tt = { ...ENV, channel: "tiktok_ads", max_total_usd: 90, max_daily_usd: 30 };
    const body = { daily_budget_usd: 30, start_time: "2026-10-15T01:00:00Z", end_date: "2026-10-17" };
    expect(createFitsEnvelope(tt, createOf("tiktok_ads.create_launch", body))).toBe(true);
    expect(createFitsEnvelope(tt, createOf("tiktok_ads.create_launch", { ...body, end_date: undefined }))).toBe(false);
    expect(createFitsEnvelope(tt, createOf("tiktok_ads.create_launch", { ...body, daily_budget_usd: 30.01 }))).toBe(false);
  });
  it("non-USD, unbounded and unwired classes never fit", () => {
    expect(createOf("chatgpt_ads.create_and_launch", { ...chatgptPayload({ lifetime_budget_micros: 58_000_000 }), currency: "EUR" })).toBeNull();
    expect(createOf("meta_ads.launch_campaign", { daily_budget_usd: 10 })).toBeNull();
    expect(createFitsEnvelope(ENV, null)).toBe(false);
  });
  it("parseEnvelope refuses malformed rows", () => {
    expect(parseEnvelope(ENV)).toEqual(ENV);
    for (const bad of [null, { ...ENV, v: 2 }, { ...ENV, actor_role: "member" }, { ...ENV, ends_on: ENV.starts_on }, { ...ENV, max_total_usd: 0 }]) expect(parseEnvelope(bad)).toBeNull();
  });
});

describe("verifyEnvelope", () => {
  const fits = chatgptPayload({ lifetime_budget_micros: 58_000_000 });
  it("the actor is re-read live: an owner passes, a demoted member or a read error is refused", async () => {
    expect(await verifyEnvelope(T, ENV, "chatgpt_ads.create_and_launch", fits, async () => "owner")).toEqual({ ok: true });
    expect(await verifyEnvelope(T, ENV, "chatgpt_ads.create_and_launch", fits, async () => "member")).toEqual({ ok: false, reason: "not_owner_admin" });
    expect(await verifyEnvelope(T, ENV, "chatgpt_ads.create_and_launch", fits, async () => { throw new Error("x"); })).toEqual({ ok: false, reason: "role_unavailable" });
  });
  it("cross-tenant: an envelope for tenant A on tenant B is refused; a user with no role in B is refused", async () => {
    expect(await verifyEnvelope(OTHER, ENV, "chatgpt_ads.create_and_launch", fits, async () => "owner")).toEqual({ ok: false, reason: "wrong_tenant" });
    expect(await verifyEnvelope(T, ENV, "chatgpt_ads.create_and_launch", fits, async (_u, t) => (t === OTHER ? "owner" : null))).toEqual({ ok: false, reason: "not_owner_admin" });
  });
});

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
type Run = { id: string; tenant_id: string; trigger: string; enqueued_by: string | null; payload: unknown; agent_slug?: string; enqueued_at?: string };
function chatRun(id: string, text: string, opts: { by?: string; tenant?: string; ageMs?: number; payload?: Record<string, unknown> } = {}): Run {
  const tenant = opts.tenant ?? T;
  const msg = `msg-${id}`;
  const run: Run = { id, tenant_id: tenant, trigger: "chat", enqueued_by: opts.by ?? OWNER, agent_slug: "operator", enqueued_at: iso(NOW), payload: { thread_id: "th-1", user_message_id: msg, ...opts.payload } };
  db.put("agent_runs", run);
  db.put("agent_thread_messages", { id: msg, tenant_id: tenant, thread_id: "th-1", sender_role: "user", body: text, agent_run_id: id, source: "chat", created_at: iso(NOW - (opts.ageMs ?? 60_000)) });
  return run;
}
function put(run: Run): Run {
  db.put("agent_runs", run);
  return run;
}

describe("resolveApprover (prod row shapes)", () => {
  beforeEach(() => db.reset());
  it("chat -> the run's typing user when owner/admin; member, page capture, cron -> null", async () => {
    const run = chatRun("run-c1", "run a $50 ChatGPT ad");
    expect(await resolveApprover(T, run, { loadRole: async () => "admin" })).toEqual({ user_id: OWNER, role: "admin", surface: "chat" });
    expect(await resolveApprover(T, run, { loadRole: async () => "member" })).toBeNull();
    const captured = chatRun("run-c2", "run a $50 ChatGPT ad", { payload: { page_context: { mode: "dom", text: "x" } } });
    expect(await resolveApprover(T, captured, { loadRole: async () => "owner" })).toBeNull();
    expect(await resolveApprover(T, { ...run, trigger: "cron" }, { loadRole: async () => "owner" })).toBeNull();
  });
  it("the role is re-read live from tenant_users", async () => {
    const run = chatRun("run-c3", "run a $50 ChatGPT ad");
    db.put("tenant_users", { user_id: OWNER, tenant_id: T, role: "owner" });
    expect(await resolveApprover(T, run)).toEqual({ user_id: OWNER, role: "owner", surface: "chat" });
    db.tables.tenant_users[0].role = "member";
    expect(await resolveApprover(T, run)).toBeNull();
  });
  it("slack -> the linked owner/admin of the sender's team, else null", async () => {
    const run = put({ id: "run-s1", tenant_id: T, trigger: "slack", enqueued_by: null, agent_slug: "operator", enqueued_at: iso(NOW), payload: { slack: { user: "U1", team_id: "TEAM", event_id: "Ev1", text: "run a $50 ChatGPT ad" } } });
    db.rpcs.resolve_slack_approver = (a) => (a.p_team_id === "TEAM" && a.p_slack_user_id === "U1" ? OWNER : null);
    expect(await resolveApprover(T, run, { loadRole: async () => "owner" })).toEqual({ user_id: OWNER, role: "owner", surface: "slack" });
    db.rpcs.resolve_slack_approver = () => null;
    expect(await resolveApprover(T, run, { loadRole: async () => "owner" })).toBeNull();
    db.rpcs.resolve_slack_approver = () => OWNER;
    const memberRow = put({ ...run, id: "run-s1b", enqueued_by: "member-1" });
    expect(await resolveApprover(T, memberRow, { loadRole: async () => "owner" })).toBeNull();
  });
});

describe("envelopeDoor", () => {
  const input = { tenantId: T, runId: "run-1", execClass: "chatgpt_ads.create_and_launch", execPayload: chatgptPayload({ lifetime_budget_micros: 58_000_000 }) };
  const ask = { approver: { user_id: OWNER, role: "owner" as const, surface: "chat" as const }, envelope_id: "ask:run-1", ask: { channel_slug: "chatgpt_ads", total_usd: 58, daily_usd: null, days: null }, shape: { kind: "plan" as const, plan, line: "x", reshaped: false } };
  let claims: Map<string, string>;
  let sent: string[];
  let stored: Map<string, ApprovalEnvelope>;
  const deps = () => ({
    enabled: async () => true,
    readEnvelope: async (_t: string, _tb: string, id: string) => stored.get(id) ?? null,
    setEnvelope: vi.fn(async (_t: string, _tb: string, id: string, e: ApprovalEnvelope) => (stored.set(id, e), { ok: true })),
    readFounderAsk: async () => ask,
    sourceDecisionEnvelope: async () => null,
    verify: (t: string, e: ApprovalEnvelope, c: string, p: unknown) => verifyEnvelope(t, e, c, p, async () => "owner"),
    claim: async (_t: string, envId: string, action: string) => {
      const h = claims.get(envId);
      if (!h) claims.set(envId, action);
      return h && h !== action ? { ok: false, code: "claimed" } : { ok: true };
    },
    approve: vi.fn(async () => ({ ok: true, attempt: 1, replayed: false })),
    send: async (ev: { id: string }) => void sent.push(ev.id),
    supersede: vi.fn(async () => ({ ok: true, superseded: [] as string[] })),
  });
  beforeEach(() => {
    claims = new Map();
    sent = [];
    stored = new Map();
  });

  it("approves a fitting create as the person who asked, with the usual event id", async () => {
    const d = deps();
    expect(await envelopeDoor(input, "act-1", d)).toEqual({ approved: true, actor_user_id: OWNER, envelope_id: "ask:run-1" });
    expect(d.approve).toHaveBeenCalledWith(T, { actionId: "act-1", eventKey: "env:act-1", actorUserId: OWNER });
    expect(sent).toEqual(["approve:act-1:1"]);
    expect(stored.get("act-1")).toMatchObject({ envelope_id: "ask:run-1", max_total_usd: 58 });
  });
  it("single use: two different creates under one ask -> the first is approved, the second refused and never carries it", async () => {
    const d = deps();
    expect((await envelopeDoor(input, "act-1", d)).approved).toBe(true);
    expect(await envelopeDoor(input, "act-2", d)).toEqual({ approved: false, reason: "claim_claimed" });
    expect(stored.has("act-2")).toBe(false);
  });
  it("a create that does not fit is left for a person", async () => {
    const d = deps();
    const over = { ...input, execPayload: chatgptPayload({ lifetime_budget_micros: 60_000_000 }) };
    expect(await envelopeDoor(over, "act-3", d)).toEqual({ approved: false, reason: "create_not_the_ask" });
    expect(d.approve).not.toHaveBeenCalled();
  });
  it("a member's ask approves nothing", async () => {
    const d = { ...deps(), readFounderAsk: async () => ({ ...ask, approver: null }) };
    expect(await envelopeDoor(input, "act-4", d)).toEqual({ approved: false, reason: "not_owner_admin" });
  });
  it("kill switch off: the door does nothing", async () => {
    const d = { ...deps(), enabled: async () => false };
    expect(await envelopeDoor(input, "act-5", d)).toEqual({ approved: false, reason: "switch_off" });
  });
  it("a lost event after the approval committed is thrown, so the retry re-sends it", async () => {
    const d = { ...deps(), send: async () => { throw new Error("inngest down"); } };
    await expect(envelopeDoor(input, "act-6", d)).rejects.toBeInstanceOf(EnvelopeSendError);
  });
});

describe("recordChannelExecAction strips an agent-supplied envelope", () => {
  it("approval_envelope in the payload or body never reaches the RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, id: "act-9" }, error: null }));
    const log = vi.fn(async () => undefined);
    await recordChannelExecAction(
      { tenantId: T, runId: "run-9", channelSlug: "meta_ads", execClass: "meta_ads.pause", execPayload: { a: 1, approval_envelope: ENV }, actionType: "account_change" as never, title: "t", body: { approval_envelope: ENV } },
      rpc as never,
      { runChannel: async () => null, log: log as never },
    );
    const sentAction = (rpc.mock.calls[0] as unknown as [unknown, string, { p_action: Record<string, unknown> }])[2].p_action;
    expect(sentAction.exec_payload).toEqual({ a: 1 });
    expect(JSON.stringify(sentAction.body)).not.toContain("approval_envelope");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ code: "channel.envelope_field_stripped" }));
  });
});

describe("the create must match the founder's own words", () => {
  it("another channel, or more than asked, mints nothing", async () => {
    const { createMatchesAsk } = await import("@/services/approvals/approval-envelope");
    const life = createOf("chatgpt_ads.create_and_launch", chatgptPayload({ lifetime_budget_micros: 58_000_000 }));
    expect(createMatchesAsk({ channel_slug: "chatgpt_ads", total_usd: 58 }, life)).toBe(true);
    expect(createMatchesAsk({ channel_slug: "chatgpt_ads", total_usd: 57.99 }, life)).toBe(false);
    expect(createMatchesAsk({ channel_slug: "tiktok_ads", total_usd: 58 }, life)).toBe(false);
    const daily = createOf("chatgpt_ads.create_and_launch", chatgptPayload({ daily_budget_micros: 25_000_000, start_time: day("2026-10-15"), end_time: day("2026-10-17") }));
    expect(createMatchesAsk({ channel_slug: "chatgpt_ads", total_usd: 149 }, daily)).toBe(false);
    expect(createMatchesAsk({ channel_slug: "chatgpt_ads", total_usd: 150 }, daily)).toBe(true);
  });
});

describe("founderOwnText: only the founder's own new words count", () => {
  beforeEach(() => db.reset());
  it("chat: the stored thread message the founder typed; never payload text or an agent brief", async () => {
    const { founderOwnText } = await import("@/services/approvals/approval-envelope");
    const run = chatRun("run-t1", "run a $50 ChatGPT ad", { payload: { current_user_text_raw: "run a $500 ChatGPT ad" } });
    expect(await founderOwnText(run)).toBe("run a $50 ChatGPT ad");
    expect(await founderOwnText({ id: "x", tenant_id: T, trigger: "chat", enqueued_by: OWNER, payload: { current_user_text_raw: "run a $50 ChatGPT ad" } })).toBeNull();
    expect(await founderOwnText({ id: "x", tenant_id: T, trigger: "chat", enqueued_by: OWNER, payload: { intent: "run a $500 ChatGPT ad" } })).toBeNull();
    expect(await founderOwnText({ id: "x", tenant_id: T, trigger: "a2a", enqueued_by: null, payload: { current_user_text_raw: "run a $50 ChatGPT ad" } })).toBeNull();
  });
  it("chat: a message older than two hours, another run's message or another tenant's counts for nothing", async () => {
    const { founderOwnText } = await import("@/services/approvals/approval-envelope");
    const old = chatRun("run-t2", "run a $50 ChatGPT ad", { ageMs: 2 * 3600_000 + 1000 });
    expect(await founderOwnText(old)).toBeNull();
    const mine = chatRun("run-t3", "run a $50 ChatGPT ad");
    db.tables.agent_thread_messages.find((m) => m.id === "msg-run-t3")!.agent_run_id = "someone-else";
    expect(await founderOwnText(mine)).toBeNull();
    const theirs = chatRun("run-t4", "run a $50 ChatGPT ad", { tenant: OTHER });
    expect(await founderOwnText({ ...theirs, tenant_id: T })).toBeNull();
  });
  it("slack: quoted lines are dropped", async () => {
    const { founderOwnText } = await import("@/services/approvals/approval-envelope");
    const run = put({ id: "run-s2", tenant_id: T, trigger: "slack", enqueued_by: null, enqueued_at: iso(NOW), payload: { slack: { user: "U1", team_id: "TEAM", event_id: "Ev2", text: "> run a $500 ChatGPT ad\nok" } } });
    expect(await founderOwnText(run)).toBe("ok");
  });
  it("email: the reply above the quoted history; a forward counts for nothing", async () => {
    const { founderOwnText } = await import("@/services/approvals/approval-envelope");
    const quoted = "Run a $50 ChatGPT ad\n\nOn Tue, Oct 14, 2026 at 9:00 AM Zavi <cgo@zaviagent.com> wrote:\n> Should I run a $500 ChatGPT ad?";
    const run = put({ id: "run-e1", tenant_id: T, trigger: "email", enqueued_by: null, agent_slug: "cgo", enqueued_at: iso(NOW), payload: { email: { email_message_id: "m1", thread_id: "thr" } } });
    db.put("email_messages", { id: "m1", tenant_id: T, from_address: "o@x.com", body_text: quoted, received_at: iso(NOW - 60_000) });
    expect(await founderOwnText(run)).toBe("Run a $50 ChatGPT ad");
    db.tables.email_messages[0].body_text = "fyi\n\n---------- Forwarded message ---------\nFrom: someone\nRun a $500 ChatGPT ad";
    expect(await founderOwnText(run)).toBeNull();
  });
  it("email approver: a verified owner or admin sender only", async () => {
    const run = put({ id: "run-e2", tenant_id: T, trigger: "email", enqueued_by: null, agent_slug: "cgo", enqueued_at: iso(NOW), payload: { email: { email_message_id: "m2", thread_id: "thr" } } });
    db.put("email_messages", { id: "m2", tenant_id: T, from_address: "o@x.com", body_text: "Run a $50 ChatGPT ad", received_at: iso(NOW - 60_000) });
    const msg = { ref: { kind: "email" as const, id: "m2", author_user_id: null, run_id: "run-e2" }, text: "Run a $50 ChatGPT ad" };
    expect(await resolveApprover(T, run, { loadRole: async () => "admin", message: async () => ({ ...msg, author_user_id: OWNER }) })).toEqual({ user_id: OWNER, role: "admin", surface: "email" });
    expect(await resolveApprover(T, run, { loadRole: async () => "member", message: async () => ({ ...msg, author_user_id: OWNER }) })).toBeNull();
    expect(await resolveApprover(T, run, { loadRole: async () => "owner" })).toBeNull();
  });
});
