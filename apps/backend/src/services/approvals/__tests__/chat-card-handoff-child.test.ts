import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failReads: new Set<string>(),
  emitFailures: 0,
}));

function pathValue(row: Row, path: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(path);
  if (!m) return row[path];
  const v = (row[m[1]] as Row | null)?.[m[2]];
  return v === undefined ? undefined : String(v);
}

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  const run = () => {
    if (db.failReads.has(table)) return { data: null, error: { message: `${table} down` } };
    return { data: (db.tables[table] ?? []).filter((r) => filters.every(([k, v]) => pathValue(r, k) === v)), error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => {
      filters.push([k, v]);
      return b;
    },
    order: () => b,
    limit: async () => run(),
    maybeSingle: async () => {
      const r = run();
      return r.error ? r : { data: r.data![0] ?? null, error: null };
    },
  };
  return b;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: (t: string) => query(t) }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/agents/thread-event", () => ({
  emitThreadEvent: vi.fn(async (e: Row) => {
    if (db.emitFailures > 0) {
      db.emitFailures -= 1;
      throw new Error("thread_event write failed");
    }
    (db.tables.thread_event ??= []).push({ id: `te-${(db.tables.thread_event ?? []).length + 1}`, ...e });
  }),
}));
const founderOrder = vi.hoisted(() => vi.fn(async () => ({ founder: false, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id: null })));
vi.mock("@/services/growth/founder-order", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/founder-order")>()),
  resolveFounderChatOrder: founderOrder,
}));

import { attachCardToChat, chatCardTarget } from "../chat-card-attach";
import { chatRunForCard } from "../chat-card-delivery";
import { maybeEmitInlineConfirmCard, type MaybeEmitInlineCardDeps } from "@/services/agents/build-inline-decision";

const TENANT = "tenant-a";
const OTHER = "tenant-b";
const THREAD = "1151c191-fa4e-4d56-8094-e270b7de12d1";
const ROOT = "root-run";
const CHILD = "d7c76302-14d9-47ae-a77c-8708c2179809";
const CARD = "5d470527-c205-466b-88ee-0cd329a112d7";
const FOUNDER = "founder-user";

const rootRun = (over: Row = {}): Row => ({
  id: ROOT,
  tenant_id: TENANT,
  agent_slug: "operator",
  trigger: "chat",
  enqueued_by: FOUNDER,
  payload: { thread_id: THREAD, user_message_id: "msg-1" },
  ...over,
});
const childRun = (payload: Row = {}, over: Row = {}): Row => ({
  id: CHILD,
  tenant_id: TENANT,
  agent_slug: "email_marketing",
  trigger: "handoff",
  enqueued_by: null,
  payload: {
    operator_thread_id: THREAD,
    founder_message_ref: { kind: "chat", id: "msg-1", author_user_id: FOUNDER, run_id: ROOT },
    ...payload,
  },
  ...over,
});
const card = (over: Row = {}): Row => ({
  id: CARD,
  tenant_id: TENANT,
  decision_class: "bulk_outbound.send",
  body: { title: "Reply test" },
  status: "proposed",
  autonomy_at_emit: "approval",
  home: "channel",
  home_channel: "email_marketing",
  emitted_at: "2026-11-02T10:00:00.000Z",
  agent_run_id: CHILD,
  ...over,
});

const input = (decision_class = "bulk_outbound.send", run_trigger = "handoff") => ({
  decision_id: CARD,
  decision_class,
  body: { title: "Reply test" },
  run_trigger,
  thread_id: null,
  agent_run_id: CHILD,
  agent_slug: "email_marketing",
  tenant_id: TENANT,
});

const deps = (over: Partial<Omit<MaybeEmitInlineCardDeps, "emit">> = {}): MaybeEmitInlineCardDeps & { emit: Mock<Parameters<MaybeEmitInlineCardDeps["emit"]>, ReturnType<MaybeEmitInlineCardDeps["emit"]>> } => ({
  isSpendFlagOn: async () => true,
  isUrgentCardsFlagOn: async () => false,
  emit: vi.fn<Parameters<MaybeEmitInlineCardDeps["emit"]>, ReturnType<MaybeEmitInlineCardDeps["emit"]>>(async () => undefined),
  showInChat: (id) => attachCardToChat({ tenant_id: TENANT, run_id: CHILD, card_id: id, table: "decisions" }),
  ...over,
});

const cardEvents = () => db.tables.thread_event ?? [];

beforeEach(() => {
  db.failReads.clear();
  db.emitFailures = 0;
  founderOrder.mockClear();
  db.tables = {
    agent_runs: [rootRun(), childRun()],
    agent_threads: [{ id: THREAD, tenant_id: TENANT, agent_slug: "operator", user_id: FOUNDER }],
    decisions: [card()],
    thread_event: [],
  };
});

describe("a handoff child's card in the founder's chat", () => {
  it("Flow 82: the email card lands in the home thread, under the founder's own run, as the thread's agent", async () => {
    const d = deps();
    expect(await maybeEmitInlineConfirmCard(input(), d)).toBe(true);
    expect(cardEvents()).toHaveLength(1);
    expect(cardEvents()[0]).toMatchObject({
      tenant_id: TENANT,
      thread_id: THREAD,
      agent_run_id: ROOT,
      agent_slug: "operator",
      kind: "decision",
      body: { decision_id: CARD, decision_class: "bulk_outbound.send", full_card: true },
    });
    expect(cardEvents()[0].body).not.toHaveProperty("from_other_chat");
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("a tool retry of the same decision never shows a second card", async () => {
    await maybeEmitInlineConfirmCard(input(), deps());
    await maybeEmitInlineConfirmCard(input(), deps());
    expect(cardEvents()).toHaveLength(1);
  });

  it("a teammate's chat works the same: a member's card goes to the member's own thread", async () => {
    db.tables.agent_runs = [
      rootRun({ enqueued_by: "member-user" }),
      childRun({ founder_message_ref: { kind: "chat", id: "msg-1", author_user_id: "member-user", run_id: ROOT } }),
    ];
    expect(await chatCardTarget(TENANT, CHILD)).toEqual({ thread_id: THREAD, run_id: ROOT, agent_slug: "operator" });
  });

  it.each([
    ["a decided card", card({ status: "acted" })],
    ["an auto-class card", card({ autonomy_at_emit: "auto" })],
  ])("%s is not shown as waiting", async (_n, row) => {
    db.tables.decisions = [row];
    expect(await maybeEmitInlineConfirmCard(input(), deps())).toBe(false);
    expect(cardEvents()).toHaveLength(0);
  });

  it("another tenant's card id is not found and writes nothing", async () => {
    db.tables.decisions = [card({ tenant_id: OTHER })];
    expect(await attachCardToChat({ tenant_id: TENANT, run_id: CHILD, card_id: CARD, table: "decisions" })).toMatchObject({ shown: false, reason: "not_found" });
    expect(cardEvents()).toHaveLength(0);
  });

  it("a thread read failure throws so the runner retries, never reads as no chat", async () => {
    db.failReads.add("agent_threads");
    await expect(maybeEmitInlineConfirmCard(input(), deps())).rejects.toThrow(/thread read failed/);
  });

  it("a failed write throws, and the retry shows exactly one card", async () => {
    db.emitFailures = 1;
    await expect(maybeEmitInlineConfirmCard(input(), deps())).rejects.toThrow(/thread_event write failed/);
    expect(await maybeEmitInlineConfirmCard(input(), deps())).toBe(true);
    expect(cardEvents()).toHaveLength(1);
  });
});

describe("what stays out of the chat", () => {
  it.each([
    "meta_ads.update_ad_set_budget_review",
    "google_ads.update_campaign_budget_review",
  ])("a non-founder %s from a handoff child stays out: its hold still asks by email", async (cls) => {
    const showInChat = vi.fn(async () => ({ shown: true }));
    expect(await maybeEmitInlineConfirmCard(input(cls), deps({ showInChat }))).toBe(false);
    expect(showInChat).not.toHaveBeenCalled();
  });

  it("a class whose flag is off stays out", async () => {
    const showInChat = vi.fn(async () => ({ shown: true }));
    expect(await maybeEmitInlineConfirmCard(input("agent.urgent_advisory"), deps({ showInChat }))).toBe(false);
    expect(showInChat).not.toHaveBeenCalled();
  });

  it("a class with no card design stays out", async () => {
    const showInChat = vi.fn(async () => ({ shown: true }));
    expect(await maybeEmitInlineConfirmCard(input("channel.something_else"), deps({ showInChat, isUrgentCardsFlagOn: async () => true }))).toBe(false);
    expect(showInChat).not.toHaveBeenCalled();
  });

  it("a scheduled run never reaches the chat path", async () => {
    const showInChat = vi.fn(async () => ({ shown: true }));
    expect(await maybeEmitInlineConfirmCard(input("bulk_outbound.send", "scheduled"), deps({ showInChat }))).toBe(false);
    expect(showInChat).not.toHaveBeenCalled();
  });
});

describe("a child cannot aim its card at a thread it does not belong to", () => {
  const refused: Array<[string, () => void]> = [
    ["a user-enqueued run with a forged handoff payload", () => (db.tables.agent_runs[1] = childRun({}, { enqueued_by: "attacker" }))],
    ["no founder ref", () => (db.tables.agent_runs[1] = childRun({ founder_message_ref: undefined }))],
    ["no operator thread", () => (db.tables.agent_runs[1] = childRun({ operator_thread_id: undefined }))],
    ["a Slack root", () => (db.tables.agent_runs[1] = childRun({ founder_message_ref: { kind: "slack", id: "ev", author_user_id: FOUNDER, run_id: ROOT } }))],
    ["an operator thread that is not the root's", () => (db.tables.agent_runs[1] = childRun({ operator_thread_id: "99999999-9999-4999-8999-999999999999" }))],
    ["a ref naming another person", () => (db.tables.agent_runs[1] = childRun({ founder_message_ref: { kind: "chat", id: "msg-1", author_user_id: "someone-else", run_id: ROOT } }))],
    ["a root in another tenant", () => (db.tables.agent_runs[0] = rootRun({ tenant_id: OTHER }))],
    ["a thread in another tenant", () => (db.tables.agent_threads = [{ id: THREAD, tenant_id: OTHER, agent_slug: "operator" }])],
    ["a staff console root", () => (db.tables.agent_runs[0] = rootRun({ payload: { thread_id: THREAD, user_message_id: "msg-1", origin: "staff_console" } }))],
    ["a root that is not a chat", () => (db.tables.agent_runs[0] = rootRun({ trigger: "scheduled" }))],
    ["a child of another tenant", () => (db.tables.agent_runs[1] = childRun({}, { tenant_id: OTHER }))],
  ];

  it.each(refused)("%s", async (_n, arrange) => {
    arrange();
    expect(await chatCardTarget(TENANT, CHILD)).toBeNull();
    expect(await attachCardToChat({ tenant_id: TENANT, run_id: CHILD, card_id: CARD, table: "decisions" })).toMatchObject({ shown: false, reason: "not_chat" });
    expect(cardEvents()).toHaveLength(0);
  });
});

describe("durable delivery of a child's card", () => {
  it("a non-founder child's failed card is delivered under the chat's root run", async () => {
    expect(await chatRunForCard(TENANT, CHILD)).toBe(ROOT);
  });

  it("a founder child's card keeps the founder order's run", async () => {
    founderOrder.mockResolvedValueOnce({ founder: true, card_thread_id: THREAD, card_agent_slug: "operator", card_run_id: "founder-run", order_root_id: "founder-run" } as never);
    expect(await chatRunForCard(TENANT, CHILD)).toBe("founder-run");
  });

  it("a child with no chat stays not deliverable", async () => {
    db.tables.agent_runs[1] = childRun({ operator_thread_id: undefined });
    expect(await chatRunForCard(TENANT, CHILD)).toBeNull();
  });
});

describe("the runner's wiring", () => {
  it("hands the inline card path the attach for this run, in the claimed tenant", () => {
    const src = readFileSync(join(__dirname, "../../agents/runner.ts"), "utf8");
    expect(src).toMatch(/showInChat: async \(id: string\) => \{[\s\S]{0,200}attachCardToChat\(\{ tenant_id: claim\.tenant_id, run_id: runId, card_id: id, table: "decisions" \}\)/);
  });
});
