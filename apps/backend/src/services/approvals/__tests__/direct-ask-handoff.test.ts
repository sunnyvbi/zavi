import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ enqueue: vi.fn(), record: vi.fn() }));
vi.mock("@/services/supabase", async () => {
  const { sharedDb } = await import("./fake-db");
  return { serviceClient: () => sharedDb.client };
});
vi.mock("@/services/agents/runner", () => ({ enqueueAgentRun: (...a: unknown[]) => m.enqueue(...a) }));
vi.mock("@/services/agents/visibility", () => ({ getVisibleAgentSlugs: async () => new Set(["operator", "performance-marketer", "pm"]) }));
vi.mock("@/services/agents/entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async () => ({ enforced: false, tier: "pro", required_tier: "free", allowed: true }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn().mockResolvedValue(undefined), LOG_META_KEYS: ["agent_slug"] }));
vi.mock("../../../../workers/client", () => ({ inngest: { send: vi.fn(async () => ({ ids: ["e"] })) } }));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: async () => true }));
vi.mock("@/services/ads-wallet/chatgpt-account-preview", () => ({ previewChatgptAccount: async () => ({ account: { currency_code: "USD" }, fundingSource: "wallet" }) }));
vi.mock("@/services/ads-wallet/funding-context", () => ({ readFundingContext: async () => ({ status: "unavailable", reason: "Wallet unavailable" }) }));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: (...a: unknown[]) => m.record(...a), approveChannelAction: vi.fn() }));
vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: async () => "chatgpt_ads" }));

import { sharedDb as db } from "./fake-db";
import { callPraxisTool } from "@/services/mcp/internal/praxis";
import { callChatgptAdsTool } from "@/services/mcp/internal/chatgpt-ads";
import { envelopeDoor } from "@/services/approvals/envelope-door";
import { readFounderAsk } from "@/services/approvals/approval-envelope";
import { stripReservedRunPayloadKeys } from "@/services/agents/reserved-payload";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const ASK = "Run a $25 ChatGPT ad for 1 day";
const iso = (ms: number) => new Date(ms).toISOString();

let children: Array<{ id: string; tenant_id: string; trigger: string; payload: Record<string, unknown>; agent_slug: string }>;

function seedChatTurn(opts: { by?: string; ageMs?: number; text?: string; run?: string; msg?: string } = {}) {
  const run = opts.run ?? "op-run";
  const msg = opts.msg ?? "msg-1";
  db.put("agent_runs", { id: run, tenant_id: T, trigger: "chat", enqueued_by: opts.by ?? OWNER, agent_slug: "operator", enqueued_at: iso(Date.now()), payload: { thread_id: "th1", user_message_id: msg } });
  db.put("agent_thread_messages", { id: msg, tenant_id: T, thread_id: "th1", sender_role: "user", body: opts.text ?? ASK, agent_run_id: run, source: "chat", created_at: iso(Date.now() - (opts.ageMs ?? 30_000)) });
}

const chatCtx = (run = "op-run", user = OWNER) => ({
  tenant_id: T,
  run_id: run,
  agent_slug: "operator",
  trigger: "chat",
  chat_thread_id: "th1",
  user_id: user,
  actor: { actor_user_id: user, actor_source: "chat", resolved_tenant_member: true, provenance_label: "signed-in user" },
});

const start = Math.floor(Date.now() / 1000);
const adInput = {
  summary: "Founder's direct ask",
  rationale: "The founder asked for exactly this",
  campaign: {
    name: "Founder ask",
    daily_budget_micros: 100e6,
    bidding_type: "clicks",
    start_time: start,
    end_time: start + 30 * 86400,
    targeting: { locations: { countries: ["US"] } },
  },
  group: { name: "One", context_hints: ["Compare options"], strategy: "fixed_bid", max_bid_micros: 1_000_000 },
  ads: [{ name: "Intent ad", title: "Compare", body: "See the choices", target_url: "https://example.com", image_url: "https://example.com/img.png" }],
};

async function handoffChild(ctx: Record<string, unknown>, args: Record<string, unknown> = {}) {
  const res = await callPraxisTool(ctx as never, "handoff", { target_agent_slug: "performance-marketer", intent: "Run a $500 ChatGPT ad for 30 days", ...args });
  expect(res.ok, res.content).toBe(true);
  return children[children.length - 1];
}

async function proposeAndDoor(childRunId: string, actionId: string) {
  m.record.mockClear();
  const result = await callChatgptAdsTool({ tenant_id: T, run_id: childRunId, run_trigger: "handoff", emit_decision: vi.fn() } as never, "propose_new_campaign", adInput);
  expect(result.ok, result.content).toBe(true);
  const filed = m.record.mock.calls[0][0] as { tenantId: string; runId: string; execClass: string; execPayload: Record<string, unknown> };
  db.put("channel_actions", { id: actionId, tenant_id: T, channel_slug: "chatgpt_ads", exec_class: filed.execClass, status: "pending", exec_status: null, title: "Founder ask", target_key: "campaign:founder ask" });
  const approve = vi.fn(async (_t: string, a: { actionId: string }) => {
    const r = db.tables.channel_actions.find((x) => x.id === a.actionId);
    if (r) r.exec_status = "queued";
    return { ok: true, attempt: 1, replayed: false };
  });
  const door = await envelopeDoor(filed, actionId, { approve, send: async () => undefined });
  return { result, filed, door, approve };
}

beforeEach(() => {
  db.reset();
  children = [];
  m.enqueue.mockReset();
  m.enqueue.mockImplementation(async (a: { tenant_id: string; agent_slug: string; trigger: string; payload: Record<string, unknown> }) => {
    const id = `child-${children.length + 1}`;
    const row = { id, tenant_id: a.tenant_id, trigger: a.trigger, enqueued_by: null, agent_slug: a.agent_slug, enqueued_at: iso(Date.now()), payload: a.payload };
    db.put("agent_runs", row);
    children.push(row);
    return { run_id: id };
  });
  m.record.mockReset();
  m.record.mockResolvedValue({ id: "action" });
  db.put("tenant_users", { user_id: OWNER, tenant_id: T, role: "owner" });
  db.put("tenant_users", { user_id: MEMBER, tenant_id: T, role: "member" });
  const claims = new Map<string, string>();
  db.rpcs.claim_approval_envelope = (a) => {
    const k = `${a.p_tenant_id}|${a.p_envelope_id}`;
    const h = claims.get(k);
    if (!h) claims.set(k, String(a.p_action_id));
    return h && h !== a.p_action_id ? { ok: false, code: "claimed" } : { ok: true };
  };
  db.rpcs.set_approval_envelope = () => ({ ok: true });
  db.rpcs.supersede_channel_actions_by_direct_ask = (a) => {
    const CREATES = new Set(["chatgpt_ads.create_and_launch", "tiktok_ads.create_launch", "meta_ads.launch_campaign", "google_ads.create_campaign", "x_ads.create_campaign", "linkedin_ads.launch_campaign"]);
    const rows = db.tables.channel_actions ?? [];
    const fresh = rows.find((r) => r.id === a.p_new_id && r.tenant_id === a.p_tenant_id);
    if (!fresh) return { ok: false, code: "not_found" };
    const same = (r: Record<string, unknown>) => r.id !== fresh.id && r.tenant_id === fresh.tenant_id && r.channel_slug === fresh.channel_slug && CREATES.has(String(r.exec_class));
    const flying = rows.find((r) => same(r) && (r.exec_status === "queued" || r.exec_status === "dispatching"));
    if (flying) return { ok: false, code: "duplicate_in_flight", holder: flying.id };
    const closed: Array<{ id: string; title: string }> = [];
    const note = `Replaced by your direct ask: ${String(fresh.title)}`;
    for (const r of rows) {
      if (same(r) && (r.status === "pending" || r.status === "snoozed") && r.exec_status == null) {
        r.status = "stale";
        r.note = note;
        closed.push({ id: String(r.id), title: String(r.title) });
        db.put("channel_action_events", { tenant_id: fresh.tenant_id, action_id: r.id, event: "stale_flagged", event_key: `direct_ask:${String(fresh.id)}`, note });
      }
    }
    return { ok: true, superseded: closed.map((c) => c.id), closed };
  };
  db.rpcs.lineage_tree_stats = () => [{ max_depth: 1, target_slugs: [], cumulative_cost: 0 }];
});

describe("direct chat ask through a handoff child", () => {
  it("launches the founder's $25, 1-day ChatGPT ad with no card, approved as the owner", async () => {
    seedChatTurn();
    const child = await handoffChild(chatCtx(), { founder_message_ref: { kind: "chat", id: "victim", author_user_id: MEMBER, run_id: "x" } });
    expect(child.trigger).toBe("handoff");
    expect(child.payload.founder_message_ref).toEqual({ kind: "chat", id: "msg-1", author_user_id: OWNER, run_id: "op-run" });
    expect(child.payload.current_user_text_raw).toBe(ASK);

    const { result, filed, door, approve } = await proposeAndDoor(child.id, "act-1");
    const c = (filed.execPayload.bundle as { campaign: Record<string, number> }).campaign;
    expect(c.lifetime_budget_micros).toBe(25e6);
    expect(c.daily_budget_micros).toBeUndefined();
    const now = Date.now() / 1000;
    expect(c.end_time).toBeGreaterThan(now);
    expect(c.end_time - c.start_time).toBe(86400);
    expect(c.start_time).toBeLessThanOrEqual(now + 601);
    expect(JSON.parse(result.content).say_to_founder).toContain("$25");
    expect(JSON.parse(result.content).say_to_founder).toMatch(/It stops [A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2} UTC\./);
    expect(door).toEqual({ approved: true, actor_user_id: OWNER, envelope_id: "ask:op-run" });
    expect(approve).toHaveBeenCalledWith(T, { actionId: "act-1", eventKey: "env:act-1", actorUserId: OWNER });
  });

  it("one message launches at most one ad: a second create from the same message is a card", async () => {
    seedChatTurn();
    const a = await handoffChild(chatCtx());
    const b = await handoffChild(chatCtx());
    expect((await proposeAndDoor(a.id, "act-1")).door.approved).toBe(true);
    expect((await proposeAndDoor(b.id, "act-2")).door).toEqual({ approved: false, reason: "claim_claimed" });
  });

  it("batch fan-out: every sibling points at the same message and the claim holds across them", async () => {
    seedChatTurn();
    const res = await callPraxisTool(chatCtx() as never, "handoff_parallel", {
      targets: [
        { target_agent_slug: "performance-marketer", intent: "ChatGPT ad" },
        { target_agent_slug: "pm", intent: "write it up" },
      ],
    });
    expect(res.ok, res.content).toBe(true);
    expect(children).toHaveLength(2);
    for (const c of children) expect(c.payload.founder_message_ref).toEqual({ kind: "chat", id: "msg-1", author_user_id: OWNER, run_id: "op-run" });
    expect((await proposeAndDoor(children[0].id, "act-1")).door.approved).toBe(true);
    expect((await proposeAndDoor(children[1].id, "act-2")).door.approved).toBe(false);
  });

  it("a child of a child keeps the root's pointer", async () => {
    seedChatTurn();
    const child = await handoffChild(chatCtx());
    const grandchild = await handoffChild({ ...chatCtx(child.id), agent_slug: "operator" });
    expect(grandchild.payload.founder_message_ref).toEqual(child.payload.founder_message_ref);
    expect((await readFounderAsk(T, grandchild.id))?.approver).toEqual({ user_id: OWNER, role: "owner", surface: "chat" });
  });
});

describe("fails closed: each case is a card", () => {
  it("a member wrote the message: no approver, the door refuses", async () => {
    seedChatTurn({ by: MEMBER });
    const child = await handoffChild(chatCtx("op-run", MEMBER));
    expect((await readFounderAsk(T, child.id))?.approver).toBeNull();
    const { door, approve } = await proposeAndDoor(child.id, "act-1");
    expect(door).toEqual({ approved: false, reason: "not_owner_admin" });
    expect(approve).not.toHaveBeenCalled();
  });

  it("another tenant's run cannot use this tenant's message", async () => {
    seedChatTurn();
    const child = await handoffChild(chatCtx());
    db.put("agent_runs", { ...child, id: "foreign-child", tenant_id: OTHER });
    expect(await readFounderAsk(OTHER, "foreign-child")).toBeNull();
  });

  it("an injected pointer: stripped at every client entry, and a forged one that does not match its root is null", async () => {
    const forged = { kind: "chat", id: "msg-1", author_user_id: MEMBER, run_id: "op-run" };
    expect(stripReservedRunPayloadKeys({ message: "x", founder_message_ref: forged })).toEqual({ message: "x" });
    seedChatTurn();
    db.put("agent_runs", { id: "forged-child", tenant_id: T, trigger: "handoff", enqueued_by: null, agent_slug: "performance-marketer", payload: { intent: ASK, founder_message_ref: forged } });
    expect(await readFounderAsk(T, "forged-child")).toBeNull();
    db.put("agent_runs", { id: "forged-child-2", tenant_id: T, trigger: "handoff", enqueued_by: null, agent_slug: "performance-marketer", payload: { founder_message_ref: { ...forged, author_user_id: OWNER, id: "msg-other" } } });
    expect(await readFounderAsk(T, "forged-child-2")).toBeNull();
  });

  it("a message older than two hours approves nothing", async () => {
    seedChatTurn({ ageMs: 2 * 3600_000 + 5_000 });
    const child = await handoffChild(chatCtx());
    expect(await readFounderAsk(T, child.id)).toBeNull();
    expect((await proposeAndDoor(child.id, "act-1")).door.approved).toBe(false);
  });

  it("agent-written intent or payload text alone is never the founder's ask", async () => {
    db.put("agent_runs", { id: "intent-only", tenant_id: T, trigger: "handoff", enqueued_by: null, agent_slug: "performance-marketer", payload: { intent: ASK, current_user_text_raw: ASK } });
    expect(await readFounderAsk(T, "intent-only")).toBeNull();
    seedChatTurn();
    const child = await handoffChild(chatCtx());
    child.payload.current_user_text_raw = "Run a $500 ChatGPT ad";
    expect((await readFounderAsk(T, child.id))?.ask.total_usd).toBe(25);
  });
});

describe("Slack and email children", () => {
  it("slack: the child (routing only, no text) points at the root event; the linked owner approves", async () => {
    db.put("agent_runs", {
      id: "slack-root", tenant_id: T, trigger: "slack", enqueued_by: null, agent_slug: "operator", enqueued_at: iso(Date.now()),
      payload: { slack: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "Ev1", team_id: "TEAM", user: "U1", text: `> earlier\n${ASK}` }, ingested_event_id: "ie1" },
    });
    db.rpcs.resolve_slack_approver = (a) => (a.p_team_id === "TEAM" && a.p_slack_user_id === "U1" ? OWNER : null);
    const child = await handoffChild({
      tenant_id: T, run_id: "slack-root", agent_slug: "operator", trigger: "slack",
      slack_routing: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "Ev1", team_id: "TEAM" },
    });
    expect(child.trigger).toBe("slack");
    expect((child.payload.slack as Record<string, unknown>).text).toBeUndefined();
    expect(child.payload.founder_message_ref).toEqual({ kind: "slack", id: "Ev1", author_user_id: "U1", run_id: "slack-root" });
    const fa = await readFounderAsk(T, child.id);
    expect(fa?.approver).toEqual({ user_id: OWNER, role: "owner", surface: "slack" });
    expect(fa?.envelope_id).toBe("ask:slack-root");
    expect(fa?.ask.total_usd).toBe(25);
  });

  it("email: the verified reply is checked on the ROOT run's thread owner, not the child's slug", async () => {
    const now = Date.now();
    db.put("agent_runs", { id: "email-root", tenant_id: T, trigger: "email", enqueued_by: null, agent_slug: "operator", enqueued_at: iso(now), payload: { email: { thread_id: "thr-1", email_message_id: "em-in", rfc_message_id: "<in@x>", from: "owner@acme.com", envelope_to: "operator@acme.inbox.zaviagent.com", identity_id: "id-1" } } });
    db.put("email_threads", { id: "thr-1", tenant_id: T, owner_agent_slug: "operator", root_message_id: "<root@zavi>" });
    db.put("email_messages", { id: "em-root", tenant_id: T, thread_id: "thr-1", direction: "out", rfc_message_id: "<root@zavi>", to_addresses: ["owner@acme.com"] });
    db.put("email_messages", { id: "em-in", tenant_id: T, thread_id: "thr-1", direction: "in", sender_verified_member: true, from_address: "owner@acme.com", rfc_message_id: "<in@x>", attachments: [], received_at: iso(now - 60_000), body_text: `${ASK}\n\nOn Tue, Oct 14, 2026 at 9:00 AM Zavi <operator@acme.inbox.zaviagent.com> wrote:\n> Want me to run a $500 ChatGPT ad?` });
    db.rpcs.is_tenant_member_email = () => true;
    db.rpcs.disabled_member_emails = () => [];
    db.rpcs.member_user_id_by_email = (a) => (a.p_email === "owner@acme.com" ? OWNER : null);
    const child = await handoffChild({
      tenant_id: T, run_id: "email-root", agent_slug: "operator", trigger: "email",
      email_routing: { thread_id: "thr-1", email_message_id: "em-in", rfc_message_id: "<in@x>", from: "owner@acme.com", envelope_to: "operator@acme.inbox.zaviagent.com", identity_id: "id-1" },
    });
    expect(child.trigger).toBe("email");
    expect(child.agent_slug).toBe("performance-marketer");
    expect(child.payload.founder_message_ref).toEqual({ kind: "email", id: "em-in", author_user_id: null, run_id: "email-root" });
    const fa = await readFounderAsk(T, child.id);
    expect(fa?.approver).toEqual({ user_id: OWNER, role: "owner", surface: "email" });
    expect(fa?.envelope_id).toBe("ask:email-root");
    expect(fa?.ask.total_usd).toBe(25);
    const msg = db.tables.email_messages.find((r) => r.id === "em-in")!;
    msg.body_text = `${ASK}\n\nAnfang der weitergeleiteten Nachricht:\nVon: Jemand <x@y.de>\nBetreff: Werbung\nRun a $500 ChatGPT ad`;
    expect(await readFounderAsk(T, child.id)).toBeNull();
    msg.body_text = `${ASK}\n\n-----Mensaje reenviado-----\n> Run a $500 ChatGPT ad`;
    expect(await readFounderAsk(T, child.id)).toBeNull();
    msg.body_text = "転送メッセージの開始:\n差出人: Someone\nRun a $25 ChatGPT ad for 1 day";
    expect(await readFounderAsk(T, child.id)).toBeNull();
    msg.body_text = `${ASK}\n\n发件人：某人\n主题：广告\nRun a $500 ChatGPT ad`;
    expect(await readFounderAsk(T, child.id)).toBeNull();
    msg.body_text = ASK;
    expect((await readFounderAsk(T, child.id))?.approver).toEqual({ user_id: OWNER, role: "owner", surface: "email" });
    msg.body_text = `${ASK}. Thanks!`;
    expect((await readFounderAsk(T, child.id))?.approver).toEqual({ user_id: OWNER, role: "owner", surface: "email" });
  });
});

describe("a direct ask supersedes a pending duplicate card", () => {
  const approveRpc = (id: string) => {
    const r = (db.tables.channel_actions ?? []).find((x) => x.id === id);
    return r && (r.status === "pending" || r.status === "snoozed") ? { ok: true } : { ok: false, code: "not_pending" };
  };
  it("the ask is approved as its own ad, the old card is closed and can no longer be approved", async () => {
    seedChatTurn();
    db.put("channel_actions", { id: "old-card", tenant_id: T, channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", status: "pending", exec_status: null, title: "Create and launch Founder ask", target_key: "campaign:founder ask" });
    db.put("channel_actions", { id: "distinct-card", tenant_id: T, channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", status: "pending", exec_status: null, title: "Spring sale", target_key: "campaign:spring sale" });
    db.put("channel_actions", { id: "meta-card", tenant_id: T, channel_slug: "meta_ads", exec_class: "meta_ads.launch_campaign", status: "pending", exec_status: null, title: "Meta" });
    db.put("channel_actions", { id: "other-tenant", tenant_id: OTHER, channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", status: "pending", exec_status: null, title: "x" });
    const child = await handoffChild(chatCtx());
    const { door } = await proposeAndDoor(child.id, "act-1");
    expect(door).toMatchObject({ approved: true, actor_user_id: OWNER });
    const old = db.tables.channel_actions.find((r) => r.id === "old-card")!;
    expect(old.status).toBe("stale");
    expect(old.note).toMatch(/^Replaced by your direct ask/);
    expect(approveRpc("old-card")).toEqual({ ok: false, code: "not_pending" });
    expect(db.tables.channel_actions.find((r) => r.id === "distinct-card")!.status).toBe("stale");
    const { directAskSay } = await import("@/services/approvals/envelope-door");
    const say = await directAskSay(T, "act-1", "Running $25 on ChatGPT as one total.", "ChatGPT");
    expect(say).toContain("Running $25 on ChatGPT as one total.");
    expect(say).toContain("I also closed 2 older ChatGPT launch cards:");
    expect(say).toContain("'Create and launch Founder ask'");
    expect(say).toContain("'Spring sale'");
    expect(say).not.toContain("Meta");
    expect(db.tables.channel_actions.find((r) => r.id === "meta-card")!.status).toBe("pending");
    expect(db.tables.channel_actions.find((r) => r.id === "other-tenant")!.status).toBe("pending");
  });
  it("the supersede fails: the ask is NOT approved, both stay cards for a person", async () => {
    seedChatTurn();
    db.put("channel_actions", { id: "old-card", tenant_id: T, channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", status: "pending", exec_status: null, title: "old", target_key: "campaign:founder ask" });
    db.rpcs.supersede_channel_actions_by_direct_ask = () => { throw new Error("db down"); };
    const child = await handoffChild(chatCtx());
    const { door, approve } = await proposeAndDoor(child.id, "act-1");
    expect(door).toEqual({ approved: false, reason: "supersede_failed" });
    expect(approve).not.toHaveBeenCalled();
    expect(db.tables.channel_actions.find((r) => r.id === "old-card")!.status).toBe("pending");
    const { directAskSay } = await import("@/services/approvals/envelope-door");
    const say = await directAskSay(T, "act-1", "Running $25 on ChatGPT as one total.", "ChatGPT");
    expect(say).toBe("I couldn't close the older ChatGPT card, so this one is waiting for your approval.");
    expect(say).not.toContain("Running");
  });
  it("the duplicate is already approved and launching: nothing closes, the ask stays a card, and the founder is told", async () => {
    seedChatTurn();
    db.put("channel_actions", { id: "old-card", tenant_id: T, channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", status: "pending", exec_status: "queued", title: "old", target_key: "campaign:founder ask" });
    const child = await handoffChild(chatCtx());
    const { door, approve } = await proposeAndDoor(child.id, "act-1");
    expect(door).toEqual({ approved: false, reason: "supersede_duplicate_in_flight" });
    expect(approve).not.toHaveBeenCalled();
    expect(db.tables.channel_actions.find((r) => r.id === "old-card")!.exec_status).toBe("queued");
    const { directAskOutcome, directAskSay } = await import("@/services/approvals/envelope-door");
    expect(await directAskOutcome(T, "act-1")).toEqual({ closed: [], inFlight: true, approved: false, olderOpen: false, uncertain: null });
    expect(await directAskSay(T, "act-1", "Running $25 on ChatGPT.", "ChatGPT")).toMatch(/^Your earlier ChatGPT ad is already launching/);
    db.tables.channel_actions.find((r) => r.id === "old-card")!.channel_slug = "meta_ads";
    expect((await directAskOutcome(T, "act-1")).inFlight).toBe(false);
  });
  it("without a direct ask nothing is superseded: the duplicate rule is unchanged", async () => {
    db.put("channel_actions", { id: "old-card", tenant_id: T, channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", status: "pending", exec_status: null, title: "old" });
    db.put("agent_runs", { id: "plain-run", tenant_id: T, trigger: "handoff", enqueued_by: null, agent_slug: "performance-marketer", payload: { intent: ASK } });
    const { door } = await proposeAndDoor("plain-run", "act-1");
    expect(door.approved).toBe(false);
    expect(db.tables.channel_actions.find((r) => r.id === "old-card")!.status).toBe("pending");
    expect(db.rpcCalls.some((c) => c.fn === "supersede_channel_actions_by_direct_ask")).toBe(false);
  });
});
