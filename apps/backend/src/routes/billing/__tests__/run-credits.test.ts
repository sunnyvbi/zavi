import { describe, it, expect, vi, beforeEach } from "vitest";

type LedgerRow = { tenant_id: string; run_id: string | null; kind: string; amount: number | null; attempt?: number; debited?: number | null };
type ChildRunRow = { tenant_id: string; id: string; conductor_id: string | null; status?: string; cost_usd?: number | string | null };
type ChargeRow = { tenant_id: string; run_id: string; refunded_daily: number; refunded_included: number; refunded_purchased: number };

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  ledger: [] as LedgerRow[],
  childRuns: [] as ChildRunRow[],
  charges: [] as ChargeRow[],
  ledgerErr: null as { message: string } | null,
  queries: [] as { table: string; tenant?: string; ids?: string[]; kinds?: string[]; columns?: string }[],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (tid: string) => tid,
  tenantClient: (tid: string) => ({
    from(table: string) {
      const state: { tenant?: string; ids?: string[]; kinds?: string[]; columns?: string } = { tenant: tid };
      const resolve = () => {
        mocks.queries.push({ table, ...state });
        if (table === "agent_runs") {
          const rows = mocks.childRuns
            .filter(
              (r) =>
                (state.tenant === undefined || r.tenant_id === state.tenant) &&
                (state.ids ?? []).includes(r.conductor_id ?? ""),
            )
            .map(({ id, conductor_id, status, cost_usd }) => ({ id, conductor_id, status: status ?? null, cost_usd: cost_usd ?? null }));
          return Promise.resolve({ data: rows, error: null });
        }
        if (table === "tool_charges") {
          const rows = mocks.charges
            .filter((r) => r.tenant_id === state.tenant && (state.ids ?? []).includes(r.run_id))
            .map(({ tenant_id: _t, ...rest }) => rest);
          return Promise.resolve({ data: rows, error: null });
        }
        if (mocks.ledgerErr) return Promise.resolve({ data: null, error: mocks.ledgerErr });
        const rows = mocks.ledger
          .filter(
            (r) =>
              (state.tenant === undefined || r.tenant_id === state.tenant) &&
              (state.kinds ?? []).includes(r.kind) &&
              (state.ids ?? []).includes(r.run_id ?? ""),
          )
          .map(({ run_id, kind, amount, attempt, debited }) => ({ run_id, kind, amount, attempt: attempt ?? 0, debited: debited ?? null }));
        return Promise.resolve({ data: rows, error: null });
      };
      const chain = {
        select: (cols: string) => {
          state.columns = cols;
          return chain;
        },
        eq: (col: string, val: string) => {
          if (col === "tenant_id") state.tenant = val;
          return chain;
        },
        in: (col: string, vals: string[]) => {
          if (col === "run_id" || col === "payload->>build_conductor_run_id") {
            state.ids = vals;
            return resolve();
          }
          if (col === "kind") state.kinds = vals;
          return chain;
        },
      };
      return chain;
    },
  }),
}));

import { billingRunCredits, parseRunIds, summarizeLedger, RUN_CREDITS_MAX_IDS } from "../run-credits";
import { creditsToUsd } from "@/services/agents/credits";

const T1 = "tnt-1";
const T2 = "tnt-2";
const CHAT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const BUILD = "33333333-3333-4333-8333-333333333333";
const STAGE_A = "44444444-4444-4444-8444-444444444444";
const STAGE_B = "55555555-5555-4555-8555-555555555555";
const OTHER_TENANT = "66666666-6666-4666-8666-666666666666";
const RUNNING = "77777777-7777-4777-8777-777777777777";
const FAILED = "88888888-8888-4888-8888-888888888888";

function call(ids: unknown) {
  const req = { query: { ids } } as unknown as import("express").Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { json, status } as unknown as import("express").Response;
  return { req, res, json, status };
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: T1 });
  mocks.ledger = [];
  mocks.childRuns = [];
  mocks.charges = [];
  mocks.ledgerErr = null;
  mocks.queries = [];
});

describe("parseRunIds", () => {
  it("rejects empty, non-uuid, and oversized lists", () => {
    expect(parseRunIds(undefined)).toBeNull();
    expect(parseRunIds("")).toBeNull();
    expect(parseRunIds("not-a-uuid")).toBeNull();
    expect(parseRunIds(`${CHAT},'; drop table tenant_credit_ledger; --`)).toBeNull();
    const tooMany = Array.from({ length: RUN_CREDITS_MAX_IDS + 1 }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    ).join(",");
    expect(parseRunIds(tooMany)).toBeNull();
  });

  it("dedupes and lowercases", () => {
    expect(parseRunIds(`${CHAT.toUpperCase()}, ${CHAT}`)).toEqual([CHAT]);
  });
});

describe("summarizeLedger", () => {
  it("is pending while any reserve has no settle or refund", () => {
    const out = summarizeLedger([
      { run_id: STAGE_A, kind: "reserve", amount: 300 },
      { run_id: STAGE_A, kind: "settle", amount: 120 },
      { run_id: STAGE_B, kind: "reserve", amount: 300 },
    ]);
    expect(out).toEqual({ credits: 120, usd: 0.3, status: "pending" });
  });

  it("keeps an infra-retried run pending: attempt 0 refunded, attempt 1 still held", () => {
    expect(
      summarizeLedger([
        { run_id: CHAT, kind: "reserve", amount: 200, attempt: 0 },
        { run_id: CHAT, kind: "refund", amount: 200, attempt: 0 },
        { run_id: CHAT, kind: "reserve", amount: 200, attempt: 1 },
      ]),
    ).toEqual({ credits: 0, usd: 0, status: "pending" });
  });

  it("settles a retried run on its second attempt without double counting the first", () => {
    expect(
      summarizeLedger([
        { run_id: CHAT, kind: "reserve", amount: 200, attempt: 0 },
        { run_id: CHAT, kind: "refund", amount: 200, attempt: 0 },
        { run_id: CHAT, kind: "reserve", amount: 200, attempt: 1 },
        { run_id: CHAT, kind: "settle", amount: 41, attempt: 1 },
      ]),
    ).toEqual({ credits: 41, usd: 0.1025, status: "settled" });
  });

  it("reports refunded, not zero-settled, when a run was held and released", () => {
    const out = summarizeLedger([
      { run_id: FAILED, kind: "reserve", amount: 300 },
      { run_id: FAILED, kind: "refund", amount: 300 },
    ]);
    expect(out).toEqual({ credits: 0, usd: 0, status: "refunded" });
  });

  it("reads a settle that debited nothing (overrun Zavi absorbed) as settled, not none", () => {
    expect(
      summarizeLedger([
        { run_id: CHAT, kind: "reserve", amount: 200, attempt: 0 },
        { run_id: CHAT, kind: "settle", amount: 180, debited: 0, attempt: 0 },
      ]),
    ).toEqual({ credits: 0, usd: 0, status: "settled", covered: 180 });
  });

  it("never lets a refund amount count as spend", () => {
    const out = summarizeLedger([
      { run_id: STAGE_A, kind: "settle", amount: 40 },
      { run_id: STAGE_B, kind: "refund", amount: 300 },
    ]);
    expect(out.credits).toBe(40);
    expect(out.status).toBe("settled");
  });

  it("reports what the tenant was charged, not the nominal cost, when Zavi absorbed an overrun", () => {
    const out = summarizeLedger([
      { run_id: CHAT, kind: "reserve", amount: 1000 },
      { run_id: CHAT, kind: "settle", amount: 1500, debited: 1000 },
    ]);
    expect(out).toEqual({ credits: 1000, usd: Number(creditsToUsd(1000).toFixed(4)), status: "settled", covered: 500 });
    expect(out.credits).not.toBe(1500);
  });

  it("nets late-check refunds per run and never below zero", () => {
    const out = summarizeLedger(
      [
        { run_id: STAGE_A, kind: "settle", amount: 284, debited: 284 },
        { run_id: STAGE_B, kind: "settle", amount: 50, debited: 50 },
      ],
      new Map([
        [STAGE_A, 160],
        [STAGE_B, 80],
      ]),
    );
    expect(out.credits).toBe(124);
    expect(out.status).toBe("settled");
  });

  it("reports the daily-grant share of the debit, net of a daily refund, never more than the debit", () => {
    const out = summarizeLedger(
      [{ run_id: CHAT, kind: "settle", amount: 1500, debited: 1000, debited_daily: 1000 }],
      new Map([[CHAT.toLowerCase(), 100]]),
      0,
      new Map([[CHAT.toLowerCase(), 100]]),
    );
    expect(out).toMatchObject({ credits: 900, covered: 500, daily: 900 });
    const none = summarizeLedger([{ run_id: CHAT, kind: "settle", amount: 300, debited: 300, debited_daily: 0 }]);
    expect(none.daily).toBeUndefined();
  });

  it("falls back to amount on settle rows written before debited existed", () => {
    const out = summarizeLedger([
      { run_id: CHAT, kind: "reserve", amount: 200 },
      { run_id: CHAT, kind: "settle", amount: 41, debited: null },
    ]);
    expect(out).toEqual({ credits: 41, usd: 0.1025, status: "settled" });
  });
});

describe("GET /api/billing/run-credits", () => {
  it("400s on a bad ids param without touching the DB", async () => {
    const { req, res, status, json } = call("nope");
    await billingRunCredits(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "bad_request" }) }),
    );
    expect(mocks.queries).toHaveLength(0);
  });

  it("sums a chat run with its handoff child only when the client lists the child", async () => {
    mocks.ledger = [
      { tenant_id: T1, run_id: CHAT, kind: "reserve", amount: 200 },
      { tenant_id: T1, run_id: CHAT, kind: "settle", amount: 37 },
      { tenant_id: T1, run_id: CHILD, kind: "reserve", amount: 200 },
      { tenant_id: T1, run_id: CHILD, kind: "settle", amount: 5 },
    ];
    const { req, res, json } = call(`${CHAT},${CHILD}`);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: {
        [CHAT]: { credits: 37, usd: 0.0925, status: "settled" },
        [CHILD]: { credits: 5, usd: 0.0125, status: "settled" },
      },
    });
  });

  it("folds a build run's stage children into the conductor id the client knows", async () => {
    mocks.childRuns = [
      { tenant_id: T1, id: STAGE_A, conductor_id: BUILD },
      { tenant_id: T1, id: STAGE_B, conductor_id: BUILD },
      { tenant_id: T1, id: CHILD, conductor_id: CHAT },
    ];
    mocks.ledger = [
      { tenant_id: T1, run_id: STAGE_A, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_A, kind: "settle", amount: 1400 },
      { tenant_id: T1, run_id: STAGE_B, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_B, kind: "settle", amount: 600 },
    ];
    const { req, res, json } = call(BUILD);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [BUILD]: { credits: 2000, usd: 5, status: "settled" } },
    });
    const ledgerQuery = mocks.queries.find((q) => q.table === "tenant_credit_ledger");
    expect(ledgerQuery?.ids).toEqual(expect.arrayContaining([BUILD, STAGE_A, STAGE_B]));
  });

  it("counts a repaired stage's first attempt, which the goal graph no longer points at", async () => {
    mocks.childRuns = [
      { tenant_id: T1, id: STAGE_A, conductor_id: BUILD },
      { tenant_id: T1, id: STAGE_B, conductor_id: BUILD },
    ];
    mocks.ledger = [
      { tenant_id: T1, run_id: STAGE_A, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_A, kind: "settle", amount: 1400 },
      { tenant_id: T1, run_id: STAGE_B, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_B, kind: "settle", amount: 900 },
    ];
    const { req, res, json } = call(BUILD);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [BUILD]: { credits: 2300, usd: 5.75, status: "settled" } },
    });
    const childQuery = mocks.queries.find((q) => q.table === "agent_runs");
    expect(childQuery?.tenant).toBe(T1);
    expect(childQuery?.ids).toEqual([BUILD]);
  });

  it("marks a build still working as pending even though one stage already settled", async () => {
    mocks.childRuns = [
      { tenant_id: T1, id: STAGE_A, conductor_id: RUNNING },
      { tenant_id: T1, id: STAGE_B, conductor_id: RUNNING },
    ];
    mocks.ledger = [
      { tenant_id: T1, run_id: STAGE_A, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_A, kind: "settle", amount: 900 },
      { tenant_id: T1, run_id: STAGE_B, kind: "reserve", amount: 2000 },
    ];
    const { req, res, json } = call(RUNNING);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [RUNNING]: { credits: 900, usd: 2.25, status: "pending" } },
    });
  });

  it("answers the debited credits, not the nominal cost, for a run whose overrun Zavi absorbed", async () => {
    mocks.ledger = [
      { tenant_id: T1, run_id: CHAT, kind: "reserve", amount: 300 },
      { tenant_id: T1, run_id: CHAT, kind: "settle", amount: 900, debited: 300 },
    ];
    const { req, res, json } = call(CHAT);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [CHAT]: { credits: 300, usd: 0.75, status: "settled", covered: 600 } },
    });
    const ledgerQuery = mocks.queries.find((q) => q.table === "tenant_credit_ledger");
    expect(ledgerQuery?.columns).toContain("debited");
  });

  it("reports a build whose stages settled with no debit as covered work, not none", async () => {
    mocks.childRuns = [
      { tenant_id: T1, id: STAGE_A, conductor_id: BUILD, status: "success", cost_usd: 3.5 },
      { tenant_id: T1, id: STAGE_B, conductor_id: BUILD, status: "success", cost_usd: 1.5 },
    ];
    mocks.ledger = [
      { tenant_id: T1, run_id: STAGE_A, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_A, kind: "settle", amount: 1400, debited: 0 },
      { tenant_id: T1, run_id: STAGE_B, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_B, kind: "settle", amount: 600, debited: 0 },
    ];
    const { req, res, json } = call(BUILD);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [BUILD]: { credits: 0, usd: 0, status: "settled", covered: 2000 } },
    });
  });

  it("counts a build's finished stages that never reserved (free first build, credits off) as covered work", async () => {
    mocks.childRuns = [
      { tenant_id: T1, id: STAGE_A, conductor_id: BUILD, status: "success", cost_usd: "4.0001" },
      { tenant_id: T1, id: STAGE_B, conductor_id: BUILD, status: "paused_awaiting_approval", cost_usd: 0.5 },
      { tenant_id: T1, id: FAILED, conductor_id: BUILD, status: "failed", cost_usd: 9 },
      { tenant_id: T1, id: RUNNING, conductor_id: BUILD, status: "running", cost_usd: 9 },
    ];
    const { req, res, json } = call(BUILD);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [BUILD]: { credits: 0, usd: 0, status: "settled", covered: 1601 + 200 } },
    });
  });

  it("never counts a stage twice when it has ledger rows and a recorded cost", async () => {
    mocks.childRuns = [
      { tenant_id: T1, id: STAGE_A, conductor_id: BUILD, status: "success", cost_usd: 3.5 },
      { tenant_id: T1, id: STAGE_B, conductor_id: BUILD, status: "success", cost_usd: 0.25 },
    ];
    mocks.ledger = [
      { tenant_id: T1, run_id: STAGE_A, kind: "reserve", amount: 2000 },
      { tenant_id: T1, run_id: STAGE_A, kind: "settle", amount: 1400, debited: 1400 },
    ];
    const { req, res, json } = call(BUILD);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [BUILD]: { credits: 1400, usd: 3.5, status: "settled", covered: 100 } },
    });
  });

  it("never leaks another tenant's charge for the same run id", async () => {
    mocks.childRuns = [{ tenant_id: T2, id: STAGE_A, conductor_id: OTHER_TENANT }];
    mocks.ledger = [
      { tenant_id: T2, run_id: OTHER_TENANT, kind: "settle", amount: 999 },
      { tenant_id: T2, run_id: STAGE_A, kind: "settle", amount: 999 },
    ];
    const { req, res, json } = call(OTHER_TENANT);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [OTHER_TENANT]: { credits: 0, usd: 0, status: "none" } },
    });
    for (const q of mocks.queries) expect(q.tenant).toBe(T1);
    const ledgerQuery = mocks.queries.find((q) => q.table === "tenant_credit_ledger");
    expect(ledgerQuery?.ids).not.toContain(STAGE_A);
  });

  it("answers every requested id, including ones with no ledger rows at all", async () => {
    mocks.ledger = [
      { tenant_id: T1, run_id: FAILED, kind: "reserve", amount: 200 },
      { tenant_id: T1, run_id: FAILED, kind: "refund", amount: 200 },
    ];
    mocks.ledger.push({ tenant_id: T1, run_id: RUNNING, kind: "reserve", amount: 200, attempt: 0 });
    mocks.ledger.push({ tenant_id: T1, run_id: RUNNING, kind: "refund", amount: 200, attempt: 0 });
    mocks.ledger.push({ tenant_id: T1, run_id: RUNNING, kind: "reserve", amount: 200, attempt: 1 });
    const { req, res, json } = call(`${FAILED},${CHAT.toUpperCase()},${RUNNING}`);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: {
        [FAILED]: { credits: 0, usd: 0, status: "refunded" },
        [CHAT]: { credits: 0, usd: 0, status: "none" },
        [RUNNING]: { credits: 0, usd: 0, status: "pending" },
      },
    });
  });

  it("nets a late-check refund out of the run's settle (284 settled, 160 refunded -> 124)", async () => {
    mocks.ledger = [
      { tenant_id: T1, run_id: CHAT, kind: "reserve", amount: 300 },
      { tenant_id: T1, run_id: CHAT, kind: "settle", amount: 284, debited: 284 },
    ];
    mocks.charges = [
      { tenant_id: T1, run_id: CHAT, refunded_daily: 0, refunded_included: 0, refunded_purchased: 160 },
      { tenant_id: T2, run_id: CHAT, refunded_daily: 0, refunded_included: 0, refunded_purchased: 100 },
    ];
    const { req, res, json } = call(CHAT);
    await billingRunCredits(req, res);
    expect(json).toHaveBeenCalledWith({
      runs: { [CHAT]: { credits: 124, usd: Number(creditsToUsd(124).toFixed(4)), status: "settled" } },
    });
    for (const q of mocks.queries) expect(q.tenant).toBe(T1);
  });

  it("500s with the DB error instead of returning zeros that read as free", async () => {
    mocks.ledgerErr = { message: "boom" };
    const { req, res, status, json } = call(CHAT);
    await billingRunCredits(req, res);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: { code: "internal", message: "boom" } });
  });

  it("does nothing when auth fails", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const { req, res, json } = call(CHAT);
    await billingRunCredits(req, res);
    expect(json).not.toHaveBeenCalled();
    expect(mocks.queries).toHaveLength(0);
  });
});
