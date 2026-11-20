import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const T = "11111111-2222-3333-4444-555555555555";
const h = vi.hoisted(() => ({
  resolved: null as Row | null,
  ledger: [] as Row[],
  granted: new Set<string>(),
  answer: null as null | ((attempt: number) => Record<string, unknown>),
  rpcCalls: [] as Array<Record<string, unknown>>,
  rpcError: null as { message: string } | null,
  resolverCalls: [] as unknown[],
  inCalls: [] as unknown[],
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  preTenantRpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    h.resolverCalls.push({ name, ...args });
    return { data: h.resolved ? [h.resolved] : [], error: null };
  }),
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const q: Record<string, any> = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        in: (c: string, v: unknown[]) => { h.inCalls.push([table, c, v]); return q; },
        like: () => q,
        limit: () => q,
        then: (ok: (x: unknown) => unknown) =>
          Promise.resolve({
            data: table === "tenant_credit_ledger" ? h.ledger.filter((r) => filters.every((f) => f(r))) : table === "agent_runs" ? [{ id: "run-1" }] : [],
            error: null,
          }).then(ok),
      };
      return q;
    },
  }),
  tenantRpc: vi.fn(async (_t: string, name: string, args: Record<string, unknown>) => {
    h.rpcCalls.push({ name, ...args });
    if (h.rpcError) return { data: null, error: h.rpcError };
    const key = `${args.p_run_id}:${args.p_attempt}`;
    if (h.granted.has(key)) return { data: { status: "already", credits: 0 }, error: null };
    h.granted.add(key);
    const row = h.ledger.find((r) => r.kind === "settle" && (r.attempt ?? 0) === args.p_attempt);
    const out = h.answer ? h.answer(Number(args.p_attempt)) : { status: "refunded", credits: Number(row?.debited ?? 0) };
    return { data: out, error: null };
  }),
}));

import { reconcileSetupDraftRefunds, refundSetupDraftRun } from "../setup-draft-refund";

const resolved = (over: Row = {}): Row => ({
  tenant_id: T, agent_slug: "cgo", trigger: "a2a", enqueued_by_is_null: true,
  status: "success", cron_dedupe_key: `cgo:draft:${T}:setup`, attempt: 1, ...over,
});

beforeEach(() => {
  h.resolved = resolved();
  h.ledger = [{ run_id: "run-1", kind: "settle", amount: 483, debited: 483, attempt: 0 }];
  h.granted = new Set();
  h.answer = null;
  h.rpcCalls = [];
  h.rpcError = null;
  h.resolverCalls = [];
});

describe("refundSetupDraftRun (tenant from the persisted row, never the event)", () => {
  it("resolves the tenant by run_id and refunds each settle through the bucket-aware RPC", async () => {
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 483 });
    expect(h.resolverCalls).toEqual([{ name: "setup_draft_resolve_run", p_run_id: "run-1" }]);
    expect(h.rpcCalls).toEqual([{ name: "refund_setup_draft_settle", p_run_id: "run-1", p_attempt: 0 }]);
  });
  it("never mints purchased credits: grant_promo_credits is not called", async () => {
    await refundSetupDraftRun("run-1");
    expect(h.rpcCalls.map((c) => c.name)).not.toContain("grant_promo_credits");
  });
  it("counts only what the RPC actually gave back (a rolled daily window is forfeited)", async () => {
    h.answer = () => ({ status: "refunded", credits: 0, daily: 0, included: 0, purchased: 0, forfeited: 483 });
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 0 });
  });
  it.each(["already", "untracked", "no_settle", "not_setup_draft"])("an RPC answer of %s counts as nothing granted", async (status) => {
    h.answer = () => ({ status, credits: 483 });
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 0 });
  });
  it("an unknown or NOT-ADMITTED run (a lookalike on a reserved key) does nothing", async () => {
    h.resolved = null;
    expect(await refundSetupDraftRun("run-x")).toEqual({ granted: 0, skipped: "not_setup_draft" });
    expect(h.rpcCalls).toEqual([]);
  });
  it("is idempotent: a replay grants nothing more", async () => {
    await refundSetupDraftRun("run-1");
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 0 });
    expect([...h.granted]).toEqual(["run-1:0"]);
  });
  it("a refunded (cost 0) run grants nothing: there is no settle row", async () => {
    h.ledger = [{ run_id: "run-1", kind: "reserve", amount: 320, attempt: 0 }, { run_id: "run-1", kind: "refund", amount: 320, attempt: 0 }];
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 0 });
    expect(h.rpcCalls).toEqual([]);
  });
  it("a failed run that settled a partial cost gets exactly that back, nothing extra", async () => {
    h.resolved = resolved({ status: "error" });
    h.ledger = [{ run_id: "run-1", kind: "settle", amount: 57, debited: 57, attempt: 0 }];
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 57 });
  });
  it("an infra-retried run that settled twice gets two grants, each once", async () => {
    h.ledger = [
      { run_id: "run-1", kind: "settle", amount: 100, debited: 100, attempt: 0 },
      { run_id: "run-1", kind: "settle", amount: 400, debited: 320, attempt: 1 },
    ];
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 420 });
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 0 });
  });
  it("never refunds a run that is still in flight", async () => {
    h.resolved = resolved({ status: "running" });
    expect(await refundSetupDraftRun("run-1")).toEqual({ granted: 0, skipped: "not_terminal" });
  });
  it.each([
    ["a user-written run", { enqueued_by_is_null: false }],
    ["a manual trigger", { trigger: "manual" }],
    ["a PAID try (attempt 4)", { cron_dedupe_key: `cgo:draft:${T}:setup:paid:4` }],
    ["a dated (normal) draft", { cron_dedupe_key: `cgo:draft:${T}:2026-09-24` }],
  ])("never refunds %s", async (_n, over) => {
    h.resolved = resolved(over as Row);
    expect((await refundSetupDraftRun("run-1")).granted).toBe(0);
    expect(h.rpcCalls).toEqual([]);
  });
  it("reconcile reads EXACTLY the three refundable keys (unlimited paid tries can't crowd one out)", async () => {
    h.inCalls = [];
    await reconcileSetupDraftRefunds(T);
    expect(h.inCalls).toEqual([["agent_runs", "cron_dedupe_key", [`cgo:draft:${T}:setup`, `cgo:draft:${T}:setup:2`, `cgo:draft:${T}:setup:3`]]]);
    expect(h.granted.has("run-1:0")).toBe(true);
  });
  it("a refund error throws so the event retries (the key keeps the retry safe)", async () => {
    h.rpcError = { message: "db down" };
    await expect(refundSetupDraftRun("run-1")).rejects.toThrow(/db down/);
  });
});
