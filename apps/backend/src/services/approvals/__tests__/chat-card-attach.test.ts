import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
let rows: Record<string, unknown> = {};
let updates: Array<{ table: string; patch: unknown }> = [];
function builder(table: string) {
  const b: Record<string, unknown> = {};
  const done = () => Promise.resolve({ data: rows[table] ?? null, error: null });
  for (const op of ["select", "eq", "gte", "lte", "is", "in", "or", "order", "not"]) {
    b[op] = (...args: unknown[]) => {
      calls.push({ table, op, args });
      return b;
    };
  }
  b.limit = (...args: unknown[]) => {
    calls.push({ table, op: "limit", args });
    return Object.assign(done(), b);
  };
  b.maybeSingle = () => done();
  b.update = (patch: unknown) => {
    updates.push({ table, patch });
    return b;
  };
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => done().then(res, rej);
  return b;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => builder(t) }),
}));
const chain = vi.fn();
vi.mock("@/services/agents/run-owner", () => ({ resolveChatTurnChain: (...a: unknown[]) => chain(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/agents/thread-event", () => ({ emitThreadEvent: vi.fn() }));

import { attachCardToChat, attachedCardBody, chatCardTarget, listOpenCards, type Card } from "../chat-card-attach";

const TARGET = { thread_id: "th-1", run_id: "root-run", agent_slug: "cgo" };
const heldCut: Card = {
  table: "decisions",
  id: "8af34774-0000-4000-8000-000000000001",
  decision_class: "google_ads.update_campaign_budget_review",
  waiting: true,
  approved_by_source: null,
  title: "Cut “Atlanta Search” from $20 to $10 a day",
  where: "under What needs you on the Your CGO page",
  channel_slug: null,
  growth_page_only: false,
  filed_at: "2026-10-18T04:15:36Z",
  run_id: null,
  move_key: null,
};

function deps(over: Partial<Parameters<typeof attachCardToChat>[1]> = {}) {
  return {
    target: vi.fn(async () => TARGET),
    read: vi.fn(async () => heldCut),
    shown: vi.fn(async () => null as { id: string; full: boolean } | null),
    emit: vi.fn(async () => undefined),
    rewrite: vi.fn(async () => undefined),
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  rows = {};
  updates = [];
  chain.mockReset();
});

describe("attachCardToChat", () => {
  it("must-catch (the incident): a held Google cut with no chat card is shown in this chat as the live card", async () => {
    const d = deps();
    const r = await attachCardToChat({ tenant_id: "t1", run_id: "resume-run", card_id: heldCut.id }, d);
    expect(r).toEqual({ shown: true, already: false, card_id: heldCut.id, table: "decisions", what: heldCut.title });
    expect(d.emit).toHaveBeenCalledWith({
      agent_run_id: "root-run",
      agent_slug: "cgo",
      tenant_id: "t1",
      thread_id: "th-1",
      kind: "decision",
      body: { decision_id: heldCut.id, decision_class: heldCut.decision_class, title: heldCut.title, full_card: true },
    });
  });

  it("the card id is read in the run's own tenant only: another tenant's id is 'not found', and nothing is written", async () => {
    const d = deps({ read: vi.fn(async () => null) });
    const r = await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, d);
    expect(r).toMatchObject({ shown: false, reason: "not_found" });
    expect(d.read).toHaveBeenCalledWith("t1", heldCut.id, undefined);
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("must-not-touch: a card no longer waiting (Autopilot approved it) is never shown as live", async () => {
    const d = deps({ read: vi.fn(async () => ({ ...heldCut, waiting: false, approved_by_source: "cgo" })) });
    expect(await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, d)).toMatchObject({ shown: false, reason: "not_waiting", approved_by_source: "cgo" });
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("must-not-touch: an Autopilot goal move stays on its goal, and a non-chat run shows nothing", async () => {
    const goal = deps({ read: vi.fn(async () => ({ ...heldCut, decision_class: "cgo.dispatch-specialist", growth_page_only: true })) });
    expect(await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, goal)).toMatchObject({ reason: "growth_page_only" });
    const review = deps({ target: vi.fn(async () => null) });
    expect(await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, review)).toMatchObject({ reason: "not_chat" });
    expect(goal.emit).not.toHaveBeenCalled();
    expect(review.emit).not.toHaveBeenCalled();
  });

  it("once per thread: a live card already here is not written again; an explicit show moves it down to now, under this turn's run", async () => {
    const d = deps({ shown: vi.fn(async () => ({ id: "te-9", full: true })) });
    expect(await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, d)).toMatchObject({ shown: true, already: true });
    expect(d.rewrite).not.toHaveBeenCalled();
    await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id, bringToLatest: true }, d);
    expect(d.rewrite).toHaveBeenCalledWith("t1", "te-9", { toTarget: TARGET });
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("an older plain confirm card for this decision becomes the live card (so it shows Autopilot's hold), never a second copy", async () => {
    const d = deps({ shown: vi.fn(async () => ({ id: "te-plain", full: false })) });
    expect(await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, d)).toMatchObject({ shown: true, already: true });
    expect(d.rewrite).toHaveBeenCalledWith("t1", "te-plain", { body: expect.objectContaining({ decision_id: heldCut.id, full_card: true }) });
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("a concurrent show (the unique index refuses) is 'already here' only when the card reads back; any other write error throws", async () => {
    const shown = vi.fn<[], Promise<{ id: string; full: boolean } | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "te-1", full: true });
    const raced = deps({ shown, emit: vi.fn(async () => { throw new Error("emitThreadEvent failed: duplicate key value"); }) });
    expect(await attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, raced)).toMatchObject({ shown: true, already: true });
    const down = deps({ emit: vi.fn(async () => { throw new Error("connection reset"); }) });
    await expect(attachCardToChat({ tenant_id: "t1", run_id: "r", card_id: heldCut.id }, down)).rejects.toThrow("connection reset");
  });

  it("a channel card is shown as a channel card (store + slug), so the web opens its tile", () => {
    const body = attachedCardBody({ id: heldCut.id, table: "channel_actions", decision_class: "channel.recipe_step", title: "Pause “Search A”", channel_slug: "google_ads" });
    expect(body).toEqual({ decision_id: heldCut.id, decision_class: "channel.recipe_step", title: "Pause “Search A”", full_card: true, store: "channel_action", channel_slug: "google_ads" });
  });
});

describe("chatCardTarget", () => {
  it("a chat turn's card goes to its thread, under the turn's root run, with the thread's agent", async () => {
    chain.mockResolvedValue({ ok: true, root_run_id: "root-run", chain: ["root-run", "resume"], payloads: [{}, {}], user_message_id: "m1", thread_id: "th-1", root_payload: {}, root_enqueued_by: "u1" });
    rows = { agent_threads: { agent_slug: "cgo" } };
    expect(await chatCardTarget("t1", "resume")).toEqual({ thread_id: "th-1", run_id: "root-run", agent_slug: "cgo" });
    expect(calls).toContainEqual({ table: "agent_threads", op: "eq", args: ["tenant_id", "t1"] });
  });

  it("must-not-touch: not a chat, or a staff console chat, gets no card; a captured-page chat still can (showing is rendering, not privilege)", async () => {
    chain.mockResolvedValue({ ok: false, reason: "not_chat" });
    expect(await chatCardTarget("t1", "r")).toBeNull();
    chain.mockResolvedValue({ ok: true, root_run_id: "r", chain: ["r"], payloads: [{ origin: "staff_console" }], user_message_id: "m", thread_id: "th", root_payload: { origin: "staff_console" }, root_enqueued_by: "u" });
    expect(await chatCardTarget("t1", "r")).toBeNull();
    chain.mockResolvedValue({ ok: true, root_run_id: "r", chain: ["r"], payloads: [{ captured_page_context: { url: "https://x" } }], user_message_id: "m", thread_id: "th", root_payload: {}, root_enqueued_by: "u" });
    rows = { agent_threads: { agent_slug: "cgo" } };
    expect(await chatCardTarget("t1", "r")).toEqual({ thread_id: "th", run_id: "r", agent_slug: "cgo" });
  });
});

describe("listOpenCards", () => {
  it("lists waiting decisions and channel cards newest first, with server-built words, never a goal move or a channel plan", async () => {
    rows = {
      decisions: [
        { id: "d-old", decision_class: "google_ads.update_campaign_budget_review", status: "proposed", autonomy_at_emit: "approval", snoozed_until: null, body: { campaign_id: "1", verified_name: "Atlanta Search", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 }, home: "growth", emitted_at: "2026-10-18T04:15:36Z" },
        { id: "d-goal", decision_class: "cgo.dispatch-specialist", status: "proposed", autonomy_at_emit: "approval", body: { title: "x" }, emitted_at: "2026-10-18T05:00:00Z" },
      ],
      channel_actions: [
        { id: "a-new", channel_slug: "google_ads", title: "Add 7 blocked search terms", body: { step: {} }, status: "pending", exec_status: null, proposed_at: "2026-10-18T06:00:00Z" },
        { id: "a-plan", channel_slug: "google_ads", title: "Plan", body: { step: { deliverable: { kind: "strategy" } } }, status: "pending", exec_status: null, proposed_at: "2026-10-18T07:00:00Z" },
      ],
    };
    const cards = await listOpenCards("t1");
    expect(cards.map((c) => c.card_id)).toEqual(["a-new", "d-old"]);
    expect(cards[1]).toMatchObject({ table: "decisions", what: expect.stringMatching(/^Cut .*Atlanta Search.* from \$20 to \$10 a day$/), where: "under What needs you on the Your CGO page" });
    expect(cards[0]).toMatchObject({ table: "channel_actions", where: "on the Google Ads channel page" });
    expect(calls).toContainEqual({ table: "channel_actions", op: "is", args: ["exec_status", null] });
  });
  it("must-catch (\"approve all three\"): cards of one move share a move_key, a card of another move gets a different one", async () => {
    const B = "bbbbbbbb-0000-4000-8000-000000000002";
    const leg = (id: string, group: string, at: string) => ({ id, decision_class: "meta_ads.set_status_review", status: "proposed", autonomy_at_emit: "approval", snoozed_until: null, body: { object_id: id, status: "PAUSED", founder_chat_order: true, move_group: group }, emitted_at: at, agent_run_id: null });
    rows = {
      decisions: [leg("a1", "run-root", "2026-10-20T18:00:00Z"), leg("a2", "run-root", "2026-10-20T18:00:01Z"), leg("b1", `raise:${B}`, "2026-10-23T18:00:00Z"), { ...leg("c1", "x", "2026-10-23T19:00:00Z"), body: { object_id: "c1" } }],
      channel_actions: [],
    };
    const cards = await listOpenCards("t1");
    const key = (id: string) => cards.find((c) => c.card_id === id)?.move_key;
    expect(key("a1")).toBe("run-root");
    expect(key("a2")).toBe(key("a1"));
    expect(key("b1")).not.toBe(key("a1"));
    expect(key("b1")).toBeTruthy();
    expect(key("c1")).toBeNull();
  });
});
