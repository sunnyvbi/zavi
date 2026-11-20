import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sends: [] as Row[],
  recipients: [] as Row[],
  reads: [] as Array<{ tenant: string; table: string; head: boolean }>,
  failCount: false,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));
vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<typeof import("@/services/tenant-client")>()),
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [["tenant_id", tenant]];
      const rows = () => (table === "email_bulk_sends" ? mocks.sends : mocks.recipients).filter((r) => filters.every(([c, v]) => r[c] === v));
      const q = {
        select: (_cols: string, o?: { head?: boolean }) => {
          mocks.reads.push({ tenant, table, head: o?.head === true });
          return q;
        },
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (done: (v: { count: number | null; error: unknown }) => unknown) =>
          done(mocks.failCount ? { count: null, error: { message: "down" } } : { count: rows().length, error: null }),
      };
      return q;
    },
  }),
}));

import { emailCardHandlers } from "@/routes/email-cards";
import { readSentSoFar } from "@/services/comms/bulk-outbound/progress";
import { cardOutcome, cardSendFacts, cardSendState, SENT_SO_FAR_WAIT_MS, type CardDeps, type SendFacts, type ViewState } from "../cards";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "33333333-3333-4333-8333-333333333333";
const D1 = "22222222-2222-4222-8222-222222222222";

const bulk = (over: Row = {}) => ({
  status: "sending", hold_reason: null, total: 30, sent: 0, skipped: 0, failed: 0, unknown: 0, hard_bounces: 0,
  created_at: "2026-11-02T00:00:00Z", finished_at: null, next_run_at: null, ...over,
});
const facts = (b: Row): SendFacts => ({ card: { status: "dispatching", approved: true }, bulk: b, results: null }) as unknown as SendFacts;
const view = { ok: true, class: "bulk_outbound.send", status: "dispatching", open: false, role: "owner", versions: 1, tests: [], body: { list_name: "Testing", est_recipient_count: 30, from_address: "a@b.test", variants: [] } } as unknown as ViewState;
const rows = (tenant: string, sendId: string, sent: number, pending: number) => [
  ...Array.from({ length: sent }, (_, i) => ({ tenant_id: tenant, send_id: sendId, contact_id: `s${i}`, status: "sent" })),
  ...Array.from({ length: pending }, (_, i) => ({ tenant_id: tenant, send_id: sendId, contact_id: `p${i}`, status: "pending" })),
];
const never = <V,>() => new Promise<V>(() => undefined);
const rpcOf = (b: Row) => (async () => facts(b)) as never;

beforeEach(() => {
  mocks.sends = [{ id: "S1", tenant_id: T1, decision_id: D1 }];
  mocks.recipients = rows(T1, "S1", 26, 4);
  mocks.reads = [];
  mocks.failCount = false;
  mocks.requireAuth.mockResolvedValue({ tenant_id: T1, user_id: "u-owner" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the sent count while a batch runs", () => {
  it("the reported bug: ledger 0, 26 of 30 rows sent, the card JSON says 26 on both counts", async () => {
    const deps: Partial<CardDeps> = {
      rpc: (async (_t: string, name: string) => {
        if (name === "email_card_view_state") return view;
        if (name === "email_card_send_facts") return facts(bulk());
        if (name === "email_planned_for_card") return null;
        throw new Error(`unexpected rpc ${name}`);
      }) as CardDeps["rpc"],
      liveCount: async () => 30,
      groupName: async () => null,
      suppression: async () => null,
      confirmedEmail: async () => "o@b.test",
      paused: async () => false,
    };
    const h = emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never);
    const r = { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    await h.view({ params: { rail: "decisions", id: D1 }, body: {} } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(r.body.card).toMatchObject({ status: "sending", sent_count: 26, outcome: { sent: 26, total: 30, status: "sending" } });
  });

  it("each read sees more: 26, then 30, with no ledger write", async () => {
    const read = () => cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk()) });
    expect((await read())?.bulk?.sent).toBe(26);
    mocks.recipients = rows(T1, "S1", 30, 0);
    expect((await read())?.bulk?.sent).toBe(30);
  });

  it("another tenant's rows on the same send id and decision are never counted", async () => {
    mocks.sends = [{ id: "S1", tenant_id: T1, decision_id: D1 }, { id: "S2", tenant_id: T2, decision_id: "D2" }];
    mocks.recipients = [...rows(T1, "S1", 3, 0), ...rows(T2, "S1", 500, 0), ...rows(T2, "S2", 500, 0)];
    expect(await readSentSoFar(T1, D1)).toBe(3);
    expect(await readSentSoFar(T2, D1)).toBeNull();
    expect(mocks.reads.every((r) => r.tenant === T1 || r.tenant === T2)).toBe(true);
    expect(mocks.reads.filter((r) => r.table === "email_bulk_send_recipients").every((r) => r.head)).toBe(true);
  });

  it("failed, unknown, skipped and in-flight rows are not called sent", async () => {
    mocks.recipients = [
      ...rows(T1, "S1", 2, 0),
      ...["failed", "unknown", "skipped", "sending", "pending"].map((status, i) => ({ tenant_id: T1, send_id: "S1", contact_id: `x${i}`, status })),
    ];
    expect(await readSentSoFar(T1, D1)).toBe(2);
  });

  it("a ledger ahead of the read never moves the card backwards", async () => {
    const f = await cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk({ sent: 28 })) });
    expect(f?.bulk?.sent).toBe(28);
  });

  it("a failed count falls back to the ledger", async () => {
    mocks.failCount = true;
    expect(await readSentSoFar(T1, D1)).toBeNull();
    const f = await cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk({ sent: 10 })) });
    expect(cardSendState("decisions", view, f)).toMatchObject({ status: "sending", sent_count: 10 });
  });

  it("a thrown count falls back to the ledger", async () => {
    const f = await cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk({ sent: 10 })), sentSoFar: async () => { throw new Error("down"); } });
    expect(f?.bulk?.sent).toBe(10);
  });

  it("a count that never answers cannot hold the card past its bound", async () => {
    vi.useFakeTimers();
    let done: SendFacts | undefined;
    void cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk({ sent: 10 })), sentSoFar: never }).then((f) => { done = f; });
    await vi.advanceTimersByTimeAsync(SENT_SO_FAR_WAIT_MS - 1);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done?.bulk?.sent).toBe(10);
  });

  it.each(["done", "held", "failed", "waiting_for_tomorrow"])("a %s send pays for no count and keeps the ledger number", async (status) => {
    const sentSoFar = vi.fn(async () => 999);
    const f = await cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk({ status, sent: 12 })), leftOut: async () => 0, sentSoFar });
    expect(sentSoFar).not.toHaveBeenCalled();
    expect(f?.bulk?.sent).toBe(12);
  });

  it("a settled read touches no recipient table through the card", async () => {
    await cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk({ status: "done", sent: 30 })), leftOut: async () => 0 });
    expect(mocks.reads).toEqual([]);
  });

  it("left-out stays a settled-only read and still reaches the card", async () => {
    const leftOut = vi.fn(async () => 2);
    await cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk()), leftOut });
    expect(leftOut).not.toHaveBeenCalled();
    const done = await cardSendFacts(T1, "decisions", D1, { rpc: rpcOf(bulk({ status: "done", sent: 28 })), leftOut });
    const state = cardSendState("decisions", view, done);
    expect(state).toMatchObject({ status: "sent", sent_count: 28, left_out_count: 2 });
    expect(cardOutcome(state, done).sent).toBe(28);
  });
});
