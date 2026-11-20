import { describe, it, expect, vi } from "vitest";

import {
  tryEngineerResume,
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

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(responses: { decisions?: Resp; cas?: Resp }) {
  const calls: Array<Record<string, unknown>> = [];
  function from(table: string) {
    const trace: Record<string, unknown> = {
      table,
      eq: [] as Array<[string, unknown]>,
      update: null as Record<string, unknown> | null,
      select: null as string | null,
      in: null as null | [string, unknown[]],
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
      neq() {
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
      then(resolve: (r: Resp) => void) {
        let r: Resp;
        if (table === "agent_runs" && trace.update)
          r = responses.cas ?? { data: [], error: null };
        else if (table === "decisions") r = responses.decisions ?? { data: [], error: null };
        else r = { data: [], error: null };
        resolve(r);
      },
    };
    return b;
  }
  return { svc: { from } as never, calls };
}

const engineerRun = (over: Partial<InfraRetryRow> = {}): InfraRetryRow => ({
  id: "run-1",
  tenant_id: "t1",
  agent_slug: "engineer",
  status: "running",
  error: null,
  infra_retry_count: 0,
  last_progress_at: "2026-06-28T07:59:00.000Z",
  trigger: "slack",
  ...over,
});

describe("tryEngineerResume", () => {
  it("resumes a progressed SLACK engineer run with no decision yet (parks same run_id, dispatch deferred)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({
      decisions: { data: [], error: null },
      cas: { data: [{ id: "run-1" }], error: null },
    });
    const ok = await tryEngineerResume(svc, { send } as never, engineerRun());
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

  it("also resumes a progressed CHAT engineer run", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      decisions: { data: [], error: null },
      cas: { data: [{ id: "run-1" }], error: null },
    });
    const ok = await tryEngineerResume(
      svc,
      { send } as never,
      engineerRun({ trigger: "chat" }),
    );
    expect(ok).toBe(true);
  });

  it("REFUSES once a ship decision was already emitted (decision-queue + PR upsert own that case)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      decisions: { data: [{ id: "dec-1" }], error: null },
      cas: { data: [{ id: "run-1" }], error: null },
    });
    const ok = await tryEngineerResume(svc, { send } as never, engineerRun());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails CLOSED (no re-fire) when the decisions read errors", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({
      decisions: { data: null, error: { message: "boom" } },
    });
    const ok = await tryEngineerResume(svc, { send } as never, engineerRun());
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES a CRON engineer run (writes a cron summary — outside the resume surface)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryEngineerResume(
      svc,
      { send } as never,
      engineerRun({ trigger: "cron" }),
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES an a2a engineer run (conductor children are the tryBuildChildResume path)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryEngineerResume(
      svc,
      { send } as never,
      engineerRun({ trigger: "a2a" }),
    );
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES a non-engineer slug (this path is engineer-only)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryEngineerResume(
      svc,
      { send } as never,
      engineerRun({ agent_slug: "operator" }),
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("REFUSES at the infra-retry cap (poison-loop bound)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc, calls } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryEngineerResume(
      svc,
      { send } as never,
      engineerRun({ infra_retry_count: 3 }),
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("REFUSES a non-running row (boot-reap only acts on pre-terminal orphans)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { svc } = makeSvc({ decisions: { data: [], error: null } });
    const ok = await tryEngineerResume(
      svc,
      { send } as never,
      engineerRun({ status: "failed" }),
    );
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
