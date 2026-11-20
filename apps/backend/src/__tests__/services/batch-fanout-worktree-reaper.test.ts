import { describe, it, expect, vi, beforeEach } from "vitest";

type AgentRunRow = {
  id: string;
  tenant_id: string;
  payload: { repo_hint?: string; batch_id?: string } | null;
  status: string;
  enqueued_at?: string;
};

type SandboxRow = {
  id: string;
  tenant_id: string;
  repo_full_name: string;
  e2b_sandbox_id: string;
  status: string;
};

const { state } = vi.hoisted(() => ({
  state: {
    recentRuns: [] as AgentRunRow[],
    sandboxRows: [] as SandboxRow[],
    liveChildren: [] as AgentRunRow[],
    reapCalls: [] as Array<{ sandbox_id: string; keepRunIds: string[] }>,
    reapReturn: [] as string[],
    reapThrowFor: new Set<string>(),
    resumeCalls: [] as string[],
    agentRunsCallNum: 0,
  },
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const innerSelect = () => {
        const builder = {
          not(_col: string, _op: string, _val: unknown) {
            return builder;
          },
          gte(_col: string, _val: unknown) {
            return builder;
          },
          eq(_col: string, _val: unknown) {
            return builder;
          },
          in(_col: string, _vals: unknown[]) {
            return builder;
          },
          or(_expr: string) {
            return builder;
          },
          limit(_n: number) {
            return builder;
          },
          then(resolve: (v: { data: unknown[]; error: null }) => void) {
            if (table === "agent_runs") {
              const n = state.agentRunsCallNum++;
              if (n === 0) {
                resolve({ data: state.recentRuns, error: null });
              } else {
                resolve({ data: state.liveChildren, error: null });
              }
            } else if (table === "tenant_sandbox") {
              resolve({ data: state.sandboxRows, error: null });
            } else {
              resolve({ data: [], error: null });
            }
          },
        };
        return builder;
      };
      return {
        select(_cols: string) {
          return innerSelect();
        },
      };
    },
  }),
}));

vi.mock("@/services/sandbox/run-worktree", () => ({
  reapOrphanWorktrees: vi.fn(async (args: { sandbox_id: string; keepRunIds?: string[] }) => {
    state.reapCalls.push({
      sandbox_id: args.sandbox_id,
      keepRunIds: [...(args.keepRunIds ?? [])],
    });
    if (state.reapThrowFor.has(args.sandbox_id)) {
      throw new Error(`simulated reap failure for ${args.sandbox_id}`);
    }
    return { removed: state.reapReturn };
  }),
}));

vi.mock("@/services/sandbox/e2b-client", () => ({
  resumeSandbox: vi.fn(async (sandbox_id: string) => {
    state.resumeCalls.push(sandbox_id);
  }),
}));

vi.mock("@/../workers/client", () => ({
  inngest: {
    createFunction: (_opts: unknown, _trigger: unknown, handler: (ctx: { logger: { info: (m: string) => void } }) => unknown) => ({
      __handler: handler,
    }),
  },
}));

import { batchFanoutWorktreeReaperFn } from "@/../workers/functions/batch-fanout-worktree-reaper";

const handler = (batchFanoutWorktreeReaperFn as unknown as {
  __handler: (ctx: { logger: { info: (m: string) => void } }) => Promise<{
    ok: boolean;
    sandboxes_swept: number;
    worktrees_removed: number;
    errors: number;
  }>;
}).__handler;

const logger = { info: () => undefined };

beforeEach(() => {
  state.recentRuns = [];
  state.sandboxRows = [];
  state.liveChildren = [];
  state.reapCalls = [];
  state.reapReturn = [];
  state.reapThrowFor = new Set();
  state.resumeCalls = [];
  state.agentRunsCallNum = 0;
});

describe("batchFanoutWorktreeReaperFn", () => {
  it("dark mode (no recent batch runs) → no resume, no reap, sandboxes_swept=0", async () => {
    state.recentRuns = [];

    const result = await handler({ logger });

    expect(result.ok).toBe(true);
    expect(result.sandboxes_swept).toBe(0);
    expect(result.worktrees_removed).toBe(0);
    expect(state.resumeCalls.length).toBe(0);
    expect(state.reapCalls.length).toBe(0);
  });

  it("recent batch activity → resumes paused sandboxes + reaps each, returns counts", async () => {
    state.recentRuns = [
      {
        id: "run-1",
        tenant_id: "tenant-A",
        payload: { repo_hint: "owner/repo-A", batch_id: "batch-A" },
        status: "done",
      },
    ];
    state.sandboxRows = [
      {
        id: "sbrow-A",
        tenant_id: "tenant-A",
        repo_full_name: "owner/repo-A",
        e2b_sandbox_id: "e2b-A",
        status: "paused",
      },
    ];
    state.reapReturn = ["/home/user/wt-orphan-1"];

    const result = await handler({ logger });

    expect(result.ok).toBe(true);
    expect(result.sandboxes_swept).toBe(1);
    expect(result.worktrees_removed).toBe(1);
    expect(state.resumeCalls).toEqual(["e2b-A"]);
    expect(state.reapCalls.length).toBe(1);
    expect(state.reapCalls[0].sandbox_id).toBe("e2b-A");
    expect(state.reapCalls[0].keepRunIds).toEqual([]);
  });

  it("live batch children → reaper called with keepRunIds=[their ids]", async () => {
    state.recentRuns = [
      {
        id: "run-1",
        tenant_id: "tenant-A",
        payload: { repo_hint: "owner/repo-A", batch_id: "batch-A" },
        status: "running",
      },
    ];
    state.sandboxRows = [
      {
        id: "sbrow-A",
        tenant_id: "tenant-A",
        repo_full_name: "owner/repo-A",
        e2b_sandbox_id: "e2b-A",
        status: "active",
      },
    ];
    state.liveChildren = [
      {
        id: "live-child-0",
        tenant_id: "tenant-A",
        payload: { repo_hint: "owner/repo-A", batch_id: "batch-A" },
        status: "running",
      },
      {
        id: "live-child-1",
        tenant_id: "tenant-A",
        payload: { repo_hint: "owner/repo-A", batch_id: "batch-A" },
        status: "queued",
      },
    ];

    const result = await handler({ logger });

    expect(result.sandboxes_swept).toBe(1);
    expect(state.reapCalls[0].keepRunIds.sort()).toEqual([
      "live-child-0",
      "live-child-1",
    ]);
    expect(state.resumeCalls.length).toBe(0);
  });

  it("reap throw → captured as error, doesn't break overall loop", async () => {
    state.recentRuns = [
      {
        id: "run-1",
        tenant_id: "tenant-A",
        payload: { repo_hint: "owner/repo-A", batch_id: "batch-A" },
        status: "done",
      },
    ];
    state.sandboxRows = [
      {
        id: "sbrow-A",
        tenant_id: "tenant-A",
        repo_full_name: "owner/repo-A",
        e2b_sandbox_id: "e2b-A",
        status: "active",
      },
    ];
    state.reapThrowFor = new Set(["e2b-A"]);

    const result = await handler({ logger });

    expect(result.ok).toBe(true);
    expect(result.sandboxes_swept).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.worktrees_removed).toBe(0);
  });
});
