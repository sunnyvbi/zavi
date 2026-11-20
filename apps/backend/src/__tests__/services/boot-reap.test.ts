import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

import { reapOrphanedRunsOnBoot } from "@/services/agents/boot-reap";
import { BOOT_REQUEUE_SETTLE_MS } from "@/services/agents/infra-retry";

const BOOT = "2026-06-03T01:00:00.000Z";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(opts: {
  orphans: Resp;
  cas?: Resp;
  terminalize?: Resp;
  parked?: Resp;
}) {
  const calls: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const trace: Record<string, unknown> = {
      table,
      eq: [] as Array<[string, unknown]>,
      neq: [] as Array<[string, unknown]>,
      or: [] as string[],
      lt: [] as Array<[string, unknown]>,
      gte: [] as Array<[string, unknown]>,
      lte: [] as Array<[string, unknown]>,
      in: null as null | [string, unknown[]],
      update: null as Record<string, unknown> | null,
      select: null as string | null,
    };
    calls.push(trace);
    const b: Record<string, unknown> = {
      select(c: string) {
        trace.select = c;
        return b;
      },
      update(p: Record<string, unknown>) {
        trace.update = p;
        return b;
      },
      eq(c: string, v: unknown) {
        (trace.eq as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      neq(c: string, v: unknown) {
        (trace.neq as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      or(f: string) {
        (trace.or as string[]).push(f);
        return b;
      },
      lt(c: string, v: unknown) {
        (trace.lt as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      gte(c: string, v: unknown) {
        (trace.gte as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      lte(c: string, v: unknown) {
        (trace.lte as Array<[string, unknown]>).push([c, v]);
        return b;
      },
      in(c: string, v: unknown[]) {
        trace.in = [c, v];
        return b;
      },
      then(resolve: (r: Resp) => void) {
        let r: Resp;
        const eqs = trace.eq as Array<[string, unknown]>;
        if (trace.update && trace.in) r = opts.terminalize ?? { data: [], error: null };
        else if (trace.update) r = opts.cas ?? { data: [], error: null };
        else if (eqs.some(([c, v]) => c === "status" && v === "queued"))
          r = opts.parked ?? { data: [], error: null };
        else r = opts.orphans;
        resolve(r);
      },
    };
    return b;
  }
  return { svc: { from } as never, calls };
}

const orphan = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "r1",
  tenant_id: "t1",
  agent_slug: "engineer",
  status: "running",
  error: null,
  infra_retry_count: 0,
  last_progress_at: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reapOrphanedRunsOnBoot", () => {
  it("no inngest injected → terminalizes every orphan (failed + needs_run_end_emit)", async () => {
    const { svc, calls } = makeSvc({
      orphans: { data: [orphan({ id: "r1" }), orphan({ id: "r2" })], error: null },
      terminalize: { data: [{ id: "r1" }, { id: "r2" }], error: null },
    });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc);
    expect(reaped).toBe(2);
    expect(requeued).toBe(0);
    const termCall = calls.find((c) => c.update && c.in) as Record<string, unknown>;
    expect((termCall.update as Record<string, unknown>).status).toBe("failed");
    expect((termCall.update as Record<string, unknown>).needs_run_end_emit).toBe(true);
    expect((termCall.update as Record<string, unknown>).finished_at).toBe(BOOT);
    expect(termCall.eq).toContainEqual(["status", "running"]);
  });

  it("pins the orphan SELECT predicate: status='running' AND started_at < bootTs", async () => {
    const { svc, calls } = makeSvc({ orphans: { data: [], error: null } });
    await reapOrphanedRunsOnBoot(BOOT, svc);
    const sel = calls[0];
    expect(sel.table).toBe("agent_runs");
    expect(sel.eq).toContainEqual(["status", "running"]);
    expect(sel.lt).toEqual([["started_at", BOOT]]);
    expect(sel.neq).toContainEqual(["agent_definition_hash", "local"]);
  });

  it("eligible orphan + inngest → parked (same run_id), dispatch DEFERRED past the settle window", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      orphans: { data: [orphan({ id: "r9", infra_retry_count: 0 })], error: null },
      cas: { data: [{ id: "r9" }], error: null },
      parked: {
        data: [{ id: "r9", tenant_id: "t1", agent_slug: "engineer", infra_retry_count: 1 }],
        error: null,
      },
    });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
    expect(requeued).toBe(1);
    expect(reaped).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].id).toBe("r9-infra-retry-1");
    expect(send.mock.calls[0][0].data.run_id).toBe("r9");
  });

  it("resweep: a row parked by an EARLIER boot in the same window (its settle timer died with its container) is re-dispatched after the settle window", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({
      orphans: { data: [], error: null },
      parked: {
        data: [
          { id: "rp", tenant_id: "t1", agent_slug: "pm", infra_retry_count: 2 },
        ],
        error: null,
      },
    });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
    expect(reaped).toBe(0);
    expect(requeued).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].id).toBe("rp-infra-retry-2");
    expect(send.mock.calls[0][0].data.run_id).toBe("rp");
    const resweep = calls.find((c) =>
      (c.eq as Array<[string, unknown]>).some(([k, v]) => k === "status" && v === "queued"),
    ) as Record<string, unknown>;
    expect(resweep.gte).toContainEqual(["infra_retry_count", 1]);
  });

  it("money-path orphan is NEVER re-queued → terminalized even with inngest (no send even after settle)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      orphans: { data: [orphan({ id: "rm", agent_slug: "dispute-response" })], error: null },
      terminalize: { data: [{ id: "rm" }], error: null },
    });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
    expect(requeued).toBe(0);
    expect(reaped).toBe(1);
    await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it("orphan already at the retry cap is terminalized — no park, no send", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      orphans: { data: [orphan({ id: "rc", infra_retry_count: 3 })], error: null },
      terminalize: { data: [{ id: "rc" }], error: null },
    });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
    expect(requeued).toBe(0);
    expect(reaped).toBe(1);
    await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns zeros and swallows a DB select error (boot-reap is non-fatal)", async () => {
    const { svc } = makeSvc({ orphans: { data: null, error: { message: "boom" } } });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc);
    expect(reaped).toBe(0);
    expect(requeued).toBe(0);
  });

  describe("crash-loop quarantine", () => {
    it("quarantine=true → zero DB touches, zero dispatches, returns zeros", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc, calls } = makeSvc({
        orphans: { data: [orphan({ id: "rq" })], error: null },
        cas: { data: [{ id: "rq" }], error: null },
        parked: {
          data: [{ id: "rq", tenant_id: "t1", agent_slug: "engineer", infra_retry_count: 1 }],
          error: null,
        },
      });
      const { reaped, requeued } = await reapOrphanedRunsOnBoot(
        BOOT,
        svc,
        { send } as never,
        { quarantine: true },
      );
      expect(reaped).toBe(0);
      expect(requeued).toBe(0);
      expect(calls.length).toBe(0);
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).not.toHaveBeenCalled();
    });

    it("quarantine=false → normal reap path unchanged (orphan parked + deferred dispatch)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc } = makeSvc({
        orphans: { data: [orphan({ id: "rn" })], error: null },
        cas: { data: [{ id: "rn" }], error: null },
        parked: {
          data: [{ id: "rn", tenant_id: "t1", agent_slug: "engineer", infra_retry_count: 1 }],
          error: null,
        },
      });
      const { requeued } = await reapOrphanedRunsOnBoot(
        BOOT,
        svc,
        { send } as never,
        { quarantine: false },
      );
      expect(requeued).toBe(1);
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).toHaveBeenCalledOnce();
    });
  });

  describe("progressed chat-run replay allowlist", () => {
    const progressedChat = (slug: string, trigger: string | null) =>
      orphan({
        id: "rc1",
        agent_slug: slug,
        trigger,
        last_progress_at: "2026-06-03T00:59:00.000Z",
      });

    it("progressed CHAT research run IS re-queued (added 2026-06-11 — read-only tools, run-keyed writes)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc } = makeSvc({
        orphans: { data: [progressedChat("research", "chat")], error: null },
        cas: { data: [{ id: "rc1" }], error: null },
        parked: {
          data: [{ id: "rc1", tenant_id: "t1", agent_slug: "research", infra_retry_count: 1 }],
          error: null,
        },
      });
      await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
      expect(send).not.toHaveBeenCalled();
    });

    it("progressed CRON research run is still TERMINALIZED (allowlist is chat-trigger only)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc, calls } = makeSvc({
        orphans: { data: [progressedChat("research", "cron")], error: null },
      });
      await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
      expect(send).not.toHaveBeenCalled();
      const terminalize = calls.find((c) => c.update && c.in);
      expect(terminalize).toBeTruthy();
    });

    it("progressed CHAT advisor run IS re-queued (allowlisted), dispatch deferred", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc } = makeSvc({
        orphans: { data: [progressedChat("advisor", "chat")], error: null },
        cas: { data: [{ id: "rc1" }], error: null },
        parked: {
          data: [{ id: "rc1", tenant_id: "t1", agent_slug: "advisor", infra_retry_count: 1 }],
          error: null,
        },
      });
      const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
      expect(requeued).toBe(1);
      expect(reaped).toBe(0);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).toHaveBeenCalledOnce();
    });

    it("progressed CHAT engineer run is NOT re-queued (write-heavy, not allowlisted)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc } = makeSvc({
        orphans: { data: [progressedChat("engineer", "chat")], error: null },
        terminalize: { data: [{ id: "rc1" }], error: null },
      });
      const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
      expect(requeued).toBe(0);
      expect(reaped).toBe(1);
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).not.toHaveBeenCalled();
    });

    it("progressed NON-chat (cron) advisor run is NOT re-queued (post-run side effects possible)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc } = makeSvc({
        orphans: { data: [progressedChat("advisor", "cron")], error: null },
        terminalize: { data: [{ id: "rc1" }], error: null },
      });
      const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
      expect(requeued).toBe(0);
      expect(reaped).toBe(1);
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).not.toHaveBeenCalled();
    });

    it("progressed CHAT money-path run is NOT re-queued (E3 firewall wins over allowlist)", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc } = makeSvc({
        orphans: { data: [progressedChat("performance-marketer", "chat")], error: null },
        terminalize: { data: [{ id: "rc1" }], error: null },
      });
      const { reaped, requeued } = await reapOrphanedRunsOnBoot(BOOT, svc, { send } as never);
      expect(requeued).toBe(0);
      expect(reaped).toBe(1);
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
