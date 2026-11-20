import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
  inngest: {
    createFunction: (config: unknown, triggers: unknown, handler: unknown) => ({ config, triggers, handler }),
    send: vi.fn(),
  },
}));
const opsRpc = vi.hoisted(() => vi.fn());
vi.mock("@/services/tenant-client", () => ({ opsRpc }));
const drain = vi.fn(async () => ({ claimed: 0, sent: 0, failed: 0, gave_up: 0, fenced: 0 }));
vi.mock("@/services/logging/ops-alert-outbox", async (orig) => {
  const actual = await orig<typeof import("@/services/logging/ops-alert-outbox")>();
  return { ...actual, drainOpsAlerts: () => drain() };
});

import { opsAlertOutboxDrainFn } from "../ops-alert-outbox-drain";
import { drainOpsAlerts as realDrain, type OutboxRow } from "@/services/logging/ops-alert-outbox";

const fn = opsAlertOutboxDrainFn as unknown as {
  config: { id: string; concurrency: number };
  triggers: Array<{ event?: string; cron?: string }>;
  handler: (ctx: unknown) => Promise<unknown>;
};
const ctx = { step: { run: (_n: string, f: () => unknown) => f() }, logger: { info: vi.fn(), warn: vi.fn() } };

afterEach(() => {
  delete process.env.PRAXIS_CONTAINER_ROLE;
  drain.mockClear();
});

describe("ops-alert-outbox-drain function", () => {
  it("wakes on the nudge and a 10-minute cron, one at a time", () => {
    expect(fn.config).toMatchObject({ id: "ops-alert-outbox-drain", concurrency: 1 });
    expect(fn.triggers).toEqual([{ event: "ops/alert.enqueued" }, { cron: "*/10 * * * *" }]);
  });
  it("does nothing off the prod container (a laptop against prod data must not drain real alerts)", async () => {
    await expect(fn.handler(ctx)).resolves.toEqual({ skipped: "not_canonical" });
    expect(drain).not.toHaveBeenCalled();
  });
  it("drains on the prod container", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    await fn.handler(ctx);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

const row = (id: number, attempts = 1): OutboxRow => ({ id, dedupe_key: `blocked:${id}`, source: "channel_actions.exec", code: "exec_blocked_on_us", tenant_id: "t", msg: `m${id}`, attempts });

describe("drainOpsAlerts (actual)", () => {
  const load = async () => (await vi.importActual<typeof import("@/services/logging/ops-alert-outbox")>("@/services/logging/ops-alert-outbox")).drainOpsAlerts;

  it("delivers each claimed row once and records the outcome with its attempt as the fencing token", async () => {
    const drainOpsAlerts = await load();
    const claim = vi.fn(async () => ({ data: [row(1), row(2, 3)], error: null }));
    const deliver = vi.fn(async (i: { msg: string }) => (i.msg === "m1" ? { ok: true } : { ok: false, error: "webhook 503" }));
    const finish = vi.fn(async () => ({ data: true, error: null }));
    const out = await drainOpsAlerts({ claim, deliver, finish, log: vi.fn() as never });
    expect(claim).toHaveBeenCalledWith(50);
    expect(finish.mock.calls).toEqual([[1, 1, true, null], [2, 3, false, "webhook 503"]]);
    expect(deliver.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ log: true }, { log: false }]);
    expect(out).toEqual({ claimed: 2, sent: 1, failed: 1, gave_up: 0, fenced: 0 });
  });

  it("a claim error throws so Inngest retries", async () => {
    const drainOpsAlerts = await load();
    await expect(drainOpsAlerts({ claim: async () => ({ data: null, error: { message: "db down" } }) })).rejects.toThrow(/claim_ops_alerts failed: db down/);
  });

  it("a delivery that throws is a failed attempt, not a crash; the other rows still go", async () => {
    const drainOpsAlerts = await load();
    const finish = vi.fn(async () => ({ data: true, error: null }));
    const deliver = vi.fn().mockRejectedValueOnce(new Error("kaboom")).mockResolvedValueOnce({ ok: true });
    const out = await drainOpsAlerts({ claim: async () => ({ data: [row(1), row(2)], error: null }), deliver, finish, log: vi.fn() as never });
    expect(finish.mock.calls).toEqual([[1, 1, false, "kaboom"], [2, 1, true, null]]);
    expect(out.sent).toBe(1);
  });

  it("a fenced finish (lease taken over) is counted, not double-counted as sent", async () => {
    const drainOpsAlerts = await load();
    const out = await drainOpsAlerts({ claim: async () => ({ data: [row(1)], error: null }), deliver: async () => ({ ok: true }), finish: async () => ({ data: false, error: null }), log: vi.fn() as never });
    expect(out).toMatchObject({ sent: 0, fenced: 1 });
  });

  it("the 10th failed attempt is logged as a give-up", async () => {
    const drainOpsAlerts = await load();
    const log = vi.fn();
    const out = await drainOpsAlerts({ claim: async () => ({ data: [row(7, 10)], error: null }), deliver: async () => ({ ok: false, error: "webhook 500" }), finish: async () => ({ data: true, error: null }), log: log as never });
    expect(out.gave_up).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "ops_alert_gave_up", tenant_id: "t" }));
  });

  it("a finish error still records the other rows, then throws so the run retries", async () => {
    const drainOpsAlerts = await load();
    const finish = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "timeout" } }).mockResolvedValueOnce({ data: true, error: null });
    await expect(drainOpsAlerts({ claim: async () => ({ data: [row(1), row(2)], error: null }), deliver: async () => ({ ok: true }), finish, log: vi.fn() as never })).rejects.toThrow(/finish_ops_alert failed for 1 row/);
    expect(finish).toHaveBeenCalledTimes(2);
  });

  it("the mocked module still exposes the real function to other importers", () => {
    expect(typeof realDrain).toBe("function");
  });

  it("the default doors are the ops RPC escape (claim, then finish with the fencing token)", async () => {
    const drainOpsAlerts = await load();
    opsRpc.mockResolvedValueOnce({ data: [row(1)], error: null }).mockResolvedValueOnce({ data: true, error: null });
    const out = await drainOpsAlerts({ deliver: async () => ({ ok: true }), log: vi.fn() as never });
    expect(opsRpc.mock.calls).toEqual([
      ["claim_ops_alerts", { p_limit: 50 }],
      ["finish_ops_alert", { p_id: 1, p_attempt: 1, p_ok: true, p_error: null }],
    ]);
    expect(out.sent).toBe(1);
  });
});
