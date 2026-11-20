import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitThreadEvent } = vi.hoisted(() => ({
  emitThreadEvent: vi.fn(async () => {}),
}));
vi.mock("@/services/agents/thread-event", () => ({ emitThreadEvent }));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/team-notes/emit-run-end", () => ({ emitTeamNoteRunEnd: vi.fn(async () => {}) }));

const { runMayUseThread } = vi.hoisted(() => ({ runMayUseThread: vi.fn(async () => true) }));
vi.mock("../run-owner", () => ({ runMayUseThread }));

import { reapOrphanedRunsOnBoot } from "../boot-reap";

type Orphan = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  error: string | null;
  infra_retry_count: number;
  last_progress_at: string | null;
  trigger: string | null;
  payload: unknown;
};

const flagClears: string[] = [];
const bubbleRpcs: Array<{ run_id: string; meta: unknown }> = [];

function fakeSvc(
  orphans: Orphan[],
  existingReply: { id: string } | null = null,
  bubbleRpcFails = false,
) {
  function builder(table: string) {
    const state: { update?: Record<string, unknown>; eqId?: string } = {};
    const b: Record<string, unknown> = {};
    const chain = (k: string) => (...args: unknown[]) => {
      if (k === "update") state.update = args[0] as Record<string, unknown>;
      if (k === "eq" && args[0] === "id") state.eqId = args[1] as string;
      return b;
    };
    for (const m of ["select", "eq", "neq", "or", "lt", "in", "gte", "lte", "update", "limit"]) {
      b[m] = chain(m);
    }
    b.maybeSingle = async () => ({ data: existingReply, error: null });
    (b as { then: unknown }).then = (
      resolve: (v: { data?: unknown; error: null }) => void,
    ) => {
      if (table === "agent_runs" && state.update && "status" in state.update) {
        return resolve({
          data: orphans.map((o) => ({
            id: o.id,
            tenant_id: o.tenant_id,
            agent_slug: o.agent_slug,
            payload: o.payload,
            trigger: o.trigger,
          })),
          error: null,
        });
      }
      if (table === "agent_runs" && state.update) {
        if (state.eqId) flagClears.push(state.eqId);
        return resolve({ error: null });
      }
      return resolve({ data: orphans, error: null });
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "record_agent_chat_reply") {
        bubbleRpcs.push({ run_id: args.p_run_id as string, meta: args.p_meta });
        if (bubbleRpcFails) return { error: { message: "rpc boom" } };
      }
      return { error: null };
    },
  } as never;
}

const BOOT_TS = "2026-06-11T00:00:00.000Z";

describe("boot-reap inline chat recovery (run_end + failure bubble)", () => {
  beforeEach(() => {
    emitThreadEvent.mockClear();
    runMayUseThread.mockReset();
    runMayUseThread.mockResolvedValue(true);
    flagClears.length = 0;
    bubbleRpcs.length = 0;
  });

  it("for a reaped CHAT run that won't be retried: posts the bubble, emits run_end, clears the flag", async () => {
    const orphan: Orphan = {
      id: "run-chat",
      tenant_id: "tenant-1",
      agent_slug: "pm",
      status: "running",
      error: null,
      infra_retry_count: 0,
      last_progress_at: "2026-06-10T23:59:00.000Z",
      trigger: "chat",
      payload: { thread_id: "thread-1" },
    };
    const res = await reapOrphanedRunsOnBoot(BOOT_TS, fakeSvc([orphan]));
    expect(res.reaped).toBe(1);
    expect(bubbleRpcs).toHaveLength(1);
    expect(bubbleRpcs[0].run_id).toBe("run-chat");
    expect(emitThreadEvent).toHaveBeenCalledTimes(1);
    expect(emitThreadEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_run_id: "run-chat",
        thread_id: "thread-1",
        kind: "run_end",
        body: { status: "error", cost_usd: 0 },
      }),
    );
    expect(flagClears).toEqual(["run-chat"]);
  });

  it("writes nothing into a thread that is not the run owner's (a refused teammate run)", async () => {
    runMayUseThread.mockResolvedValue(false);
    const orphan: Orphan = {
      id: "run-forged",
      tenant_id: "tenant-1",
      agent_slug: "pm",
      status: "running",
      error: null,
      infra_retry_count: 0,
      last_progress_at: "2026-06-10T23:59:00.000Z",
      trigger: "chat",
      payload: { thread_id: "thread-teammate" },
    };
    const res = await reapOrphanedRunsOnBoot(BOOT_TS, fakeSvc([orphan]));
    expect(res.reaped).toBe(1);
    expect(runMayUseThread).toHaveBeenCalledWith(expect.anything(), "tenant-1", "run-forged", "thread-teammate");
    expect(bubbleRpcs).toHaveLength(0);
    expect(emitThreadEvent).not.toHaveBeenCalled();
  });

  it("does NOT write a SECOND bubble if an assistant reply already exists", async () => {
    const orphan: Orphan = {
      id: "run-chat-dup",
      tenant_id: "tenant-1",
      agent_slug: "pm",
      status: "running",
      error: null,
      infra_retry_count: 0,
      last_progress_at: "2026-06-10T23:59:00.000Z",
      trigger: "chat",
      payload: { thread_id: "thread-1" },
    };
    const res = await reapOrphanedRunsOnBoot(
      BOOT_TS,
      fakeSvc([orphan], { id: "existing-reply" }),
    );
    expect(res.reaped).toBe(1);
    expect(bubbleRpcs).toHaveLength(0);
    expect(emitThreadEvent).toHaveBeenCalledTimes(1);
  });

  it("SKIPS inline recovery for a chat run the scan will still infra-retry", async () => {
    const retryable: Orphan = {
      id: "run-retryable",
      tenant_id: "tenant-1",
      agent_slug: "pm",
      status: "running",
      error: null,
      infra_retry_count: 0,
      last_progress_at: null,
      trigger: "chat",
      payload: { thread_id: "thread-1" },
    };
    const res = await reapOrphanedRunsOnBoot(BOOT_TS, fakeSvc([retryable]));
    expect(res.reaped).toBe(1);
    expect(bubbleRpcs).toHaveLength(0);
    expect(emitThreadEvent).not.toHaveBeenCalled();
    expect(flagClears).toEqual([]);
  });

  it("if the bubble RPC fails: still emits run_end + clears the flag (Path 4 backfills the bubble)", async () => {
    const orphan: Orphan = {
      id: "run-bubble-fail",
      tenant_id: "tenant-1",
      agent_slug: "pm",
      status: "running",
      error: null,
      infra_retry_count: 0,
      last_progress_at: "2026-06-10T23:59:00.000Z",
      trigger: "chat",
      payload: { thread_id: "thread-1" },
    };
    const res = await reapOrphanedRunsOnBoot(
      BOOT_TS,
      fakeSvc([orphan], null,  true),
    );
    expect(res.reaped).toBe(1);
    expect(bubbleRpcs).toHaveLength(1);
    expect(emitThreadEvent).toHaveBeenCalledTimes(1);
    expect(flagClears).toEqual(["run-bubble-fail"]);
  });

  it("does NOT touch a slack/email reaped run (Path 0 still owns it)", async () => {
    const slack: Orphan = {
      id: "run-slack",
      tenant_id: "tenant-1",
      agent_slug: "engineer",
      status: "running",
      error: null,
      infra_retry_count: 0,
      last_progress_at: "2026-06-10T23:59:00.000Z",
      trigger: "slack",
      payload: { thread_id: "thread-2" },
    };
    const res = await reapOrphanedRunsOnBoot(BOOT_TS, fakeSvc([slack]));
    expect(res.reaped).toBe(1);
    expect(bubbleRpcs).toHaveLength(0);
    expect(emitThreadEvent).not.toHaveBeenCalled();
    expect(flagClears).toEqual([]);
  });

  it("does NOT recover a chat run with no thread_id in payload", async () => {
    const noThread: Orphan = {
      id: "run-no-thread",
      tenant_id: "tenant-1",
      agent_slug: "pm",
      status: "running",
      error: null,
      infra_retry_count: 0,
      last_progress_at: "2026-06-10T23:59:00.000Z",
      trigger: "chat",
      payload: {},
    };
    const res = await reapOrphanedRunsOnBoot(BOOT_TS, fakeSvc([noThread]));
    expect(res.reaped).toBe(1);
    expect(bubbleRpcs).toHaveLength(0);
    expect(emitThreadEvent).not.toHaveBeenCalled();
    expect(flagClears).toEqual([]);
  });
});
