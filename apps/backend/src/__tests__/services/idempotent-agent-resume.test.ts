import { describe, it, expect, vi } from "vitest";

import {
  tryIdempotentAgentResume,
  BOOT_REQUEUE_SETTLE_MS,
  type InfraRetryRow,
} from "@/services/agents/infra-retry";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));
import { reapOrphanedRunsOnBoot } from "@/services/agents/boot-reap";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(responses: {
  decisions?: Resp;
  cas?: Resp;
  orphans?: Resp;
  terminalize?: Resp;
  parked?: Resp;
}) {
  const calls: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const trace: Record<string, unknown> = {
      table,
      eq: [] as Array<[string, unknown]>,
      update: null as Record<string, unknown> | null,
      select: null as string | null,
      in: null as null | [string, unknown[]],
      single: false,
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
        (trace.eq as Array<[string, unknown]>).push([`neq:${c}`, v]);
        return b;
      },
      or() {
        return b;
      },
      lt() {
        return b;
      },
      gte() {
        return b;
      },
      lte() {
        return b;
      },
      in(c: string, v: unknown[]) {
        trace.in = [c, v];
        return b;
      },
      limit() {
        return b;
      },
      single() {
        trace.single = true;
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve: (r: Resp) => void) {
        let r: Resp;
        const eqs = trace.eq as Array<[string, unknown]>;
        if (table === "agent_runs" && trace.update && trace.in)
          r = responses.terminalize ?? { data: [], error: null };
        else if (table === "agent_runs" && trace.update)
          r = responses.cas ?? { data: [], error: null };
        else if (
          table === "agent_runs" &&
          eqs.some(([c, v]) => c === "status" && v === "queued")
        )
          r = responses.parked ?? { data: [], error: null };
        else if (table === "agent_runs") r = responses.orphans ?? { data: [], error: null };
        else if (table === "decisions") r = responses.decisions ?? { data: [], error: null };
        else r = { data: [], error: null };
        resolve(r);
      },
    };
    return b;
  }
  return { svc: { from } as never, calls };
}

const progressed = (over: Partial<InfraRetryRow> = {}): InfraRetryRow => ({
  id: "run-1",
  tenant_id: "t1",
  agent_slug: "fundraising",
  status: "running",
  error: null,
  infra_retry_count: 0,
  last_progress_at: "2026-06-13T09:36:00.000Z",
  trigger: "slack",
  ...over,
});

describe("tryIdempotentAgentResume", () => {
  it("resumes a progressed SLACK fundraising run with no decision (parks same run_id, dispatch deferred)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({
      decisions: { data: [], error: null },
      cas: { data: [{ id: "run-1" }], error: null },
    });
    const ok = await tryIdempotentAgentResume(svc, { send } as never, progressed());
    expect(ok).toBe(true);
    const cas = calls.find((c) => c.table === "agent_runs" && c.update) as Record<
      string,
      unknown
    >;
    expect((cas.update as Record<string, unknown>).status).toBe("queued");
    expect((cas.update as Record<string, unknown>).infra_retry_count).toBe(1);
    expect(cas.eq).toContainEqual(["status", "running"]);
    expect(cas.eq).toContainEqual(["infra_retry_count", 0]);
    expect(send).not.toHaveBeenCalled();
  });

  it("also resumes a progressed MANUAL fundraising run (slack/chat/manual all idempotent)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      decisions: { data: [], error: null },
      cas: { data: [{ id: "run-1" }], error: null },
    });
    const ok = await tryIdempotentAgentResume(
      svc,
      { send } as never,
      progressed({ trigger: "manual" }),
    );
    expect(ok).toBe(true);
  });

  it("REFUSES a CRON fundraising run (cron writes a cron-summary + may deliver standing-order Slack — outside the audited idempotent surface)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryIdempotentAgentResume(
      svc,
      { send } as never,
      progressed({ trigger: "cron" }),
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES an a2a fundraising run (conductor children are the tryBuildChildResume path)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryIdempotentAgentResume(
      svc,
      { send } as never,
      progressed({ trigger: "a2a" }),
    );
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES when a decision was already emitted (fail-closed dup-side-effect guard)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      decisions: { data: [{ id: "dec-1" }], error: null },
      cas: { data: [{ id: "run-1" }], error: null },
    });
    const ok = await tryIdempotentAgentResume(svc, { send } as never, progressed());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails CLOSED (no re-fire) when the decisions read errors", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      decisions: { data: null, error: { message: "boom" } },
    });
    const ok = await tryIdempotentAgentResume(svc, { send } as never, progressed());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES a non-allowlisted slug (pm — a dispatcher; re-run could re-dispatch)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryIdempotentAgentResume(
      svc,
      { send } as never,
      progressed({ agent_slug: "pm", trigger: "cron" }),
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES a money-path slug even if it were allowlisted (E3 firewall wins)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryIdempotentAgentResume(
      svc,
      { send } as never,
      progressed({ agent_slug: "performance-marketer" }),
    );
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES at the infra-retry cap (poison-loop bound)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryIdempotentAgentResume(
      svc,
      { send } as never,
      progressed({ infra_retry_count: 3 }),
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("reapOrphanedRunsOnBoot — idempotent-agent resume integration", () => {
  const BOOT = "2026-06-13T10:00:00.000Z";

  it("re-queues a progressed slack fundraising run instead of terminalizing it (dispatch after the settle window)", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn().mockResolvedValue(undefined);
      const { svc, calls } = makeSvc({
        orphans: { data: [progressed({ id: "run-1" })], error: null },
        decisions: { data: [], error: null },
        cas: { data: [{ id: "run-1" }], error: null },
        parked: {
          data: [
            { id: "run-1", tenant_id: "t1", agent_slug: "fundraising", infra_retry_count: 1 },
          ],
          error: null,
        },
      });
      const { reaped, requeued } = await reapOrphanedRunsOnBoot(
        BOOT,
        svc,
        { send } as never,
      );
      expect(requeued).toBe(1);
      expect(reaped).toBe(0);
      const term = calls.find((c) => c.table === "agent_runs" && c.update && c.in);
      expect(term).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(BOOT_REQUEUE_SETTLE_MS);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0].data.run_id).toBe("run-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still terminalizes a progressed fundraising run that already emitted a decision", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({
      orphans: { data: [progressed({ id: "run-1" })], error: null },
      decisions: { data: [{ id: "dec-1" }], error: null },
      terminalize: { data: [{ id: "run-1" }], error: null },
    });
    const { reaped, requeued } = await reapOrphanedRunsOnBoot(
      BOOT,
      svc,
      { send } as never,
    );
    expect(requeued).toBe(0);
    expect(reaped).toBe(1);
    const term = calls.find(
      (c) => c.table === "agent_runs" && c.update && c.in,
    ) as Record<string, unknown>;
    expect((term.update as Record<string, unknown>).status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
});
