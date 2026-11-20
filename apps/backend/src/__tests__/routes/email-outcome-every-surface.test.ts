import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const USER = "u-1";
const CARD = "eeeeeeee-9999-4222-8333-444455556666";

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const store: Record<string, Row[]> = {
    channel_runs: [],
    channel_actions: [],
    channel_action_events: [],
    decisions: [],
    email_bulk_sends: [],
    email_send_results: [],
  };
  function scoped(table: string, tenant: string) {
    if (!(table in store)) throw new Error(`tenantClient: '${table}' is not registered`);
    const filters: Array<{ op: "eq" | "in"; col: string; val: unknown }> = [{ op: "eq", col: "tenant_id", val: tenant }];
    let columns = "";
    let from = 0;
    let limit: number | null = null;
    const b = {
      select(c: string) {
        columns = c;
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push({ op: "eq", col, val });
        return b;
      },
      in(col: string, val: unknown[]) {
        filters.push({ op: "in", col, val });
        return b;
      },
      gte() {
        return b;
      },
      order() {
        return b;
      },
      limit(n: number) {
        limit = n;
        return b;
      },
      range(f: number, t: number) {
        from = f;
        limit = t - f + 1;
        return b;
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        let rows = store[table].filter((r) => filters.every((f) => (f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col]))));
        if (limit !== null) rows = rows.slice(from, from + limit);
        const cols = columns.split(",").map((c) => c.trim()).filter(Boolean);
        const pick = (r: Row, c: string): [string, unknown] => {
          const m = c.match(/^(\w+):(\w+)((?:->>?\w+)+)$/);
          if (!m) return [c, r[c] ?? null];
          let v: unknown = r[m[2]];
          for (const k of m[3].split(/->>?/).filter(Boolean)) v = v && typeof v === "object" ? (v as Row)[k] : undefined;
          return [m[1], v ?? null];
        };
        return resolve({ data: rows.map((r) => Object.fromEntries(cols.map((c) => pick(r, c)))), error: null });
      },
    };
    return b;
  }
  return {
    store,
    tenantClient: vi.fn((tid: string) => ({ from: (table: string) => scoped(table, tid) })),
    requireAuth: vi.fn(async () => ({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204", user_id: "u-1", access_token: "tok" })),
    reset() {
      for (const k of Object.keys(store)) store[k].length = 0;
    },
  };
});

vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: h.tenantClient }));
vi.mock("@/services/growth/channel-autorun", () => ({ readAutopilotState: async () => ({ enabled: false }) }));
vi.mock("@/services/email-plan/live", () => ({ weeklyBlock: async () => null }));

import { channelHistoryGet } from "../../routes/channels/history";
import { readCardOutcome, type CardDeps, type CardOutcome, type SendFacts } from "@/services/email-cards/cards";
import { withCardStatus } from "@/services/email-plan/card-status";
import { listSentEmailsPage, type EndedHold } from "@/services/email-results/view";
import { emailPlanHandlers } from "@/routes/workspace/email-plan";

type Bulk = NonNullable<NonNullable<SendFacts>["bulk"]>;
type Case = {
  name: string;
  decision: "acted" | "rejected";
  bulk: Bulk | null;
  want: Partial<CardOutcome>;
  inHistory: boolean;
  inResults: "result" | "in_flight" | "none";
};

const bulk = (o: Partial<Bulk>): Bulk => ({
  status: "done",
  hold_reason: null,
  total: 10,
  sent: 10,
  skipped: 0,
  failed: 0,
  unknown: 0,
  hard_bounces: 0,
  created_at: "2026-10-22T09:00:00Z",
  finished_at: "2026-10-22T09:20:00Z",
  next_run_at: null,
  ...o,
});

const CASES: Case[] = [
  {
    name: "held by a pause Zavi may resume",
    decision: "acted",
    bulk: bulk({ status: "held", hold_reason: "email_paused", sent: 4, finished_at: null }),
    want: { status: "held", sent: 4, total: 10, unknown: 0, may_have_sent: false },
    inHistory: false,
    inResults: "in_flight",
  },
  {
    name: "sent to everyone",
    decision: "acted",
    bulk: bulk({}),
    want: { status: "sent", sent: 10, total: 10, unknown: 0, may_have_sent: false, reason: null },
    inHistory: true,
    inResults: "result",
  },
  {
    name: "partially failed",
    decision: "acted",
    bulk: bulk({ sent: 7, failed: 3 }),
    want: { status: "partially_sent", sent: 7, total: 10, unknown: 0, may_have_sent: false },
    inHistory: true,
    inResults: "result",
  },
  {
    name: "stopped by the founder with people the provider never confirmed",
    decision: "acted",
    bulk: bulk({ status: "held", hold_reason: "stopped", sent: 3, unknown: 2 }),
    want: { status: "outcome_unknown", sent: 3, total: 10, unknown: 2, may_have_sent: true },
    inHistory: true,
    inResults: "result",
  },
  {
    name: "stopped by Zavi with people the provider never confirmed",
    decision: "acted",
    bulk: bulk({ status: "held", hold_reason: "list_archived", sent: 5, unknown: 1 }),
    want: { status: "outcome_unknown", sent: 5, total: 10, unknown: 1, may_have_sent: true },
    inHistory: true,
    inResults: "result",
  },
  {
    name: "refused by the founder",
    decision: "rejected",
    bulk: null,
    want: { status: "rejected", sent: null, total: null, unknown: null, may_have_sent: false },
    inHistory: true,
    inResults: "none",
  },
];

function factsOf(c: Case): SendFacts {
  const b = c.bulk;
  return {
    card: { status: c.decision, approved: c.decision === "acted", dispatched_at: "2026-10-22T09:00:00Z", error: null },
    bulk: b,
    results: b && b.sent > 0 && c.inResults === "result" ? { sent_count: b.sent, finished_at: b.finished_at!, h1: {}, d7: {}, d7_published: false } : null,
  };
}

function cardDeps(c: Case): Partial<CardDeps> {
  return {
    rpc: (async (_t: string, name: string) => {
      if (name === "email_card_view_state") return { ok: true, class: "bulk_outbound.send", body: { list_name: "Spring buyers" }, open: false, status: c.decision, role: "owner", versions: 1, tests: [] };
      if (name === "email_card_send_facts") return factsOf(c);
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    paused: async () => false,
    senderStop: async () => "running",
  };
}

function seed(c: Case) {
  h.store.decisions.push({
    id: CARD,
    tenant_id: TENANT,
    agent_run_id: null,
    decision_class: "bulk_outbound.send",
    status: c.decision,
    emitted_at: "2026-10-22T08:00:00Z",
    dispatched_at: c.decision === "acted" ? "2026-10-22T09:00:00Z" : null,
    rejected_at: c.decision === "rejected" ? "2026-10-22T09:00:00Z" : null,
    archived_at: null,
    dispatch_error: null,
    body: { list_name: "Spring buyers", template: { subject: "Spring sale", body_text: "x" } },
  });
  if (c.bulk) h.store.email_bulk_sends.push({ tenant_id: TENANT, decision_id: CARD, ...c.bulk });
}

async function historyRow(): Promise<Record<string, unknown> | undefined> {
  const r = { _status: 200, _body: undefined as unknown, status(n: number) { r._status = n; return r; }, json(b: unknown) { r._body = b; return r; } };
  await channelHistoryGet({ params: { slug: "email_marketing" } } as unknown as Request, r as unknown as Response);
  expect(r._status).toBe(200);
  return (r._body as { closed: Array<Record<string, unknown>> }).closed.find((x) => x.id === CARD);
}

async function resultsRow(c: Case) {
  const b = c.bulk;
  const hold: EndedHold | null = b ? { decision_id: CARD, ...b } : null;
  const page = await listSentEmailsPage(TENANT, 50, {
    zone: async () => "UTC",
    results: async () =>
      c.inResults === "result" && b
        ? [{ rail: "decisions", card_id: CARD, route: "zavi_list", subject: "Spring sale", list_id: null, list_name: "Spring buyers", campaign_slug: null, shared_tag: false, sent_count: b.sent, total_count: b.total, started_at: b.created_at, finished_at: b.finished_at!, win_line: {}, h1: {}, d7: {}, d7_published_at: null, verdict: null, note: null }]
        : [],
    inFlight: async () => (c.inResults === "in_flight" && hold ? [{ ...hold, sent: b!.sent, total: b!.total, created_at: b!.created_at, subject: "Spring sale", list_id: null, list_name: "Spring buyers" }] : []),
    holds: async (_t, ids) => (hold && ids.includes(CARD) ? [hold] : []),
  });
  return page.emails.find((e) => e.card.id === CARD);
}

describe("one send outcome for a card on every surface (ROI #3, #4)", () => {
  beforeEach(() => h.reset());

  for (const c of CASES) {
    it(`${c.name}: the card, Coming up, channel history and Sent emails agree`, async () => {
      seed(c);
      const card = await readCardOutcome(TENANT, "decisions", CARD, USER, cardDeps(c));
      expect(card).toMatchObject(c.want);
      const shared = { ...card!, pause_hold: null };

      const plan = await withCardStatus(TENANT, USER, { ok: true, items: [{ id: "p1", status: "sent", card: { rail: "decisions", id: CARD } }], holds: [{ rail: "decisions", card_id: CARD }] }, cardDeps(c));
      expect(plan.items[0].card_status).toEqual(card);
      expect(plan.holds[0].card_status).toEqual(card);

      const hist = await historyRow();
      if (c.inHistory) {
        expect(hist?.outcome).toEqual(shared);
        const note = (hist?.sent as { note?: string } | undefined)?.note;
        if (card!.may_have_sent) expect(note).toBe(card!.reason);
      } else {
        expect(hist).toBeUndefined();
      }

      const row = await resultsRow(c);
      if (c.inResults === "none") {
        expect(row).toBeUndefined();
      } else {
        expect(row?.outcome).toEqual(shared);
        if (card!.may_have_sent) {
          expect(row?.stop_note).toBe(card!.reason);
          expect(row?.stop_note).toContain("may have");
          expect(row?.stop_note).not.toContain("were not emailed");
        }
      }
    });
  }

  it("GET Coming up serves the card's own outcome when its first batch went and the founder stopped the rest", async () => {
    const c = CASES[3];
    seed(c);
    const { rpc, paused, senderStop } = cardDeps(c);
    const planRpc = (async (t: string, name: string, args: Record<string, unknown>) => {
      if (name === "list_email_planned_sends") {
        return { ok: true, role: "owner", next_plan_at: null, items: [{ id: "p1", status: "sent", status_reason: null, route: "zavi_list", planned_at: "2026-10-22T09:00:00Z", timezone: "UTC", card: { rail: "decisions", id: CARD } }], holds: [] };
      }
      return rpc!(t, name, args);
    }) as CardDeps["rpc"];
    const r = { statusCode: 200, body: undefined as any, status(n: number) { r.statusCode = n; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() { return r; } };
    await emailPlanHandlers({ rpc: planRpc, zone: async () => "UTC" } as never, undefined, { paused, senderStop }).list({} as Request, r as unknown as Response);
    expect(r.statusCode).toBe(200);
    const item = r.body.items[0];
    expect(item.status).toBe("sent");
    expect(item.card_status).toEqual(await readCardOutcome(TENANT, "decisions", CARD, USER, cardDeps(c)));
    expect(item.card_status.status).toBe("outcome_unknown");
    expect(item.card_status.reason).toContain("3 people got it, and 2 more may have");
  });
});
