
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  captured: { config: null as unknown, handler: null as unknown },
  google: { calls: [] as unknown[] },
  handlerResult: { ok: true, notice: "done" } as { ok: boolean; error?: string; notice?: string; created?: Record<string, unknown> },
  lastSettleResult: null as Record<string, unknown> | null,
  row: {
    exec_status: "queued" as null | "queued" | "dispatching" | "executed" | "failed",
    exec_claim_id: null as string | null,
    events: [] as string[],
  },
  settleFailuresLeft: 0,
  claimSeq: 0,
}));

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/disabled", () => ({ readTenantDisabled: vi.fn(async () => false) }));

vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({
  isGoogleAdsWriteEnabled: vi.fn(async () => true),
}));

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (config: unknown, _trigger: unknown, handler: unknown) => {
      h.captured.config = config;
      h.captured.handler = handler;
      return { id: (config as { id: string }).id };
    },
    send: vi.fn(),
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (name: string) => {
      if (name !== "claim_channel_action_exec") throw new Error(`unexpected rpc ${name}`);
      if (h.row.exec_status === "queued") {
        h.row.exec_status = "dispatching";
        h.row.exec_claim_id = `claim-${++h.claimSeq}`;
        return {
          data: {
            ok: true,
            claim_id: h.row.exec_claim_id,
            tenant_id: "11111111-1111-4111-8111-111111111111",
            channel_slug: "google_ads",
            exec_class: "google_ads.update_campaign_budget",
            exec_payload: { campaign_id: "1", daily_budget_usd: 150 },
            approved_by: "aaaaaaaa-0000-4000-8000-000000000001",
            approved_by_source: null,
            agent_run_id: "run-1",
          },
          error: null,
        };
      }
      return {
        data: {
          ok: false,
          code: "not_queued",
          tenant_id: "11111111-1111-4111-8111-111111111111",
          exec_status: h.row.exec_status,
          lease_expired: false,
        },
        error: null,
      };
    },
  }),
}));

vi.mock("@/services/channels/exec-actions", async () => {
  const actual = await vi.importActual<typeof import("@/services/channels/exec-actions")>(
    "@/services/channels/exec-actions",
  );
  return {
    ...actual,
    settleChannelActionExec: vi.fn(
      async (_t: string, a: { ok: boolean; claimId?: string | null; result?: Record<string, unknown> }) => {
        h.lastSettleResult = a.result ?? null;
        if (h.settleFailuresLeft > 0) {
          h.settleFailuresLeft -= 1;
          throw new Error("settle_channel_action_exec failed: supabase unavailable");
        }
        if (h.row.exec_claim_id !== (a.claimId ?? null)) return { ok: false, code: "not_owner" };
        if (h.row.exec_status === (a.ok ? "executed" : "failed")) return { ok: true };
        if (h.row.exec_status !== "dispatching") return { ok: false, code: "not_dispatching" };
        h.row.exec_status = a.ok ? "executed" : "failed";
        h.row.events.push(a.ok ? "executed" : "exec_failed");
        return { ok: true };
      },
    ),
  };
});

vi.mock("../dispatch-decision", () => ({
  DECISION_HANDLERS: {
    "google_ads.update_campaign_budget": async (d: { body: unknown }) => {
      h.google.calls.push(d.body);
      return h.handlerResult;
    },
  },
}));

import "../dispatch-channel-action";

vi.mock("@/services/growth/preview-plan", () => ({
  channelPlanLock: vi.fn(async () => null),
  planIncludesChannel: vi.fn(async () => true),
}));

const ACTION = "99999999-9999-4999-8999-999999999999";

type Attempted = { ok: boolean; skipped?: string; error?: string };

async function runFunctionWithRetries(maxAttempts: number): Promise<{
  result: Attempted | null;
  attempts: number;
  stepCalls: string[];
  lastError: Error | null;
}> {
  const memo = new Map<string, unknown>();
  const stepCalls: string[] = [];
  const handler = h.captured.handler as (a: {
    event: { data: { action_id: string } };
    step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> };
    logger: { warn: (m: string) => void };
  }) => Promise<Attempted>;

  const step = {
    run: async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(id)) return memo.get(id) as T;
      stepCalls.push(id);
      const out = await fn();
      memo.set(id, out);
      return out;
    },
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await handler({
        event: { data: { action_id: ACTION } },
        step,
        logger: { warn: () => undefined },
      });
      return { result, attempts: attempt, stepCalls, lastError };
    } catch (e) {
      lastError = e as Error;
    }
  }
  return { result: null, attempts: maxAttempts, stepCalls, lastError };
}

beforeEach(() => {
  h.google.calls = [];
  h.handlerResult = { ok: true, notice: "done" };
  h.row = { exec_status: "queued", exec_claim_id: null, events: [] };
  h.settleFailuresLeft = 0;
  h.claimSeq = 0;
});

describe("a create's structured record reaches exec_result (Top 10 #7 recheck)", () => {
  it("exec_result carries created exactly as the handler returned it, beside the notice", async () => {
    const created = { platform: "meta", object_type: "ad_set", id: "222222222222222", status: "PAUSED" };
    h.handlerResult = { ok: true, notice: "Created ad set — PAUSED", created };
    await runFunctionWithRetries(1);
    expect(h.lastSettleResult).toEqual({ notice: "Created ad set — PAUSED", created });
  });
  it("no created on the result: exec_result stays { notice } only", async () => {
    await runFunctionWithRetries(1);
    expect(h.lastSettleResult).toEqual({ notice: "done" });
  });
});

describe("the Inngest function runs the mutation and the settlement as SEPARATE steps", () => {
  it("names them, in order", async () => {
    const run = await runFunctionWithRetries(1);
    expect(run.stepCalls).toEqual(["execute", "settle"]);
    expect(run.result).toMatchObject({ ok: true });
  });

  it("allows enough retries for a settlement to land", async () => {
    expect((h.captured.config as { retries: number }).retries).toBeGreaterThanOrEqual(3);
  });
});

describe("a retried run re-enters the SETTLEMENT, never the Google call", () => {
  it("two settle failures then success: ONE Google call, row executed", async () => {
    h.settleFailuresLeft = 2;

    const run = await runFunctionWithRetries(3);

    expect(h.google.calls).toHaveLength(1);
    expect(run.stepCalls.filter((s) => s === "execute")).toHaveLength(1);
    expect(run.stepCalls.filter((s) => s === "settle")).toHaveLength(3);
    expect(run.attempts).toBe(3);
    expect(h.row.exec_status).toBe("executed");
    expect(h.row.events).toEqual(["executed"]);
    expect(run.result).toMatchObject({ ok: true });
  });

  it("a settlement that never lands FAILS THE RUN instead of reporting success", async () => {
    h.settleFailuresLeft = 99;

    const run = await runFunctionWithRetries(3);

    expect(run.result).toBeNull();
    expect(run.lastError?.message).toMatch(/supabase unavailable/);
    expect(h.google.calls).toHaveLength(1);
    expect(h.row.exec_status).toBe("dispatching");
  });
});
