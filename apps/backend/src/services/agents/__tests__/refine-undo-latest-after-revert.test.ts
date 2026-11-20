import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  conductorRows: [] as unknown[],
  agentRunReads: [] as string[],
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        const api: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order"]) api[m] = () => api;
        api.limit = async () => ({ data: mocks.conductorRows, error: null });
        return api;
      }
      if (table === "agent_runs") {
        let id = "";
        const api: Record<string, unknown> = {};
        api.select = () => api;
        api.eq = (col: string, v: string) => {
          if (col === "id") id = v;
          return api;
        };
        api.maybeSingle = async () => {
          mocks.agentRunReads.push(id);
          return { data: { output_text: null, parsed: { commit_sha: "a".repeat(40) } }, error: null };
        };
        return api;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { realRefineUndoDeps } from "@/services/agents/refine-undo";

const edit = (id: string, status = "done") => ({
  id,
  status,
  goal_graph: [{ child_run_id: `ar-${id}`, payload: { stage: "build", refine_mode: true } }],
});
const revert = (id: string, stage: "undo" | "restore") => ({
  id,
  status: "done",
  goal_graph: [{ payload: { stage, parent_conductor_run_id: "edit-2" } }],
});

beforeEach(() => {
  mocks.conductorRows = [];
  mocks.agentRunReads = [];
});

describe("DEL-1323 B29: refine-undo never reverts the same edit twice", () => {
  it("picks the newest live edit when nothing was undone since", async () => {
    mocks.conductorRows = [edit("edit-2"), edit("edit-1")];
    const latest = await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga");
    expect(latest?.conductor_run_id).toBe("edit-2");
    expect(mocks.agentRunReads).toEqual(["ar-edit-2"]);
  });

  it("a second Undo press after the first went through finds nothing to undo", async () => {
    mocks.conductorRows = [revert("undo-1", "undo"), edit("edit-2"), edit("edit-1")];
    expect(await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga")).toBeNull();
    expect(mocks.agentRunReads).toEqual([]);
  });

  it("after restoring an older version there is no edit to undo", async () => {
    mocks.conductorRows = [revert("restore-1", "restore"), edit("edit-2")];
    expect(await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga")).toBeNull();
  });

  it("an edit made after an undo is the one undone next", async () => {
    mocks.conductorRows = [edit("edit-3"), revert("undo-1", "undo"), edit("edit-2")];
    expect((await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga"))?.conductor_run_id).toBe("edit-3");
  });

  it("failed edits are skipped, as before", async () => {
    mocks.conductorRows = [edit("edit-3", "failed"), edit("edit-2")];
    expect((await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga"))?.conductor_run_id).toBe("edit-2");
  });
});

describe("DEL-1323 B29 review: a stuck undo claim does not lock the edit forever", () => {
  const claim = (minutesAgo: number, undo_claim = true) => ({
    id: "claim-1",
    status: "proposed",
    created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    goal_graph: [{ payload: { stage: "undo", undo_claim, parent_conductor_run_id: "edit-2" } }],
  });

  it("a claim still inside UNDO_CLAIM_STALE_MS counts as an undo in flight", async () => {
    mocks.conductorRows = [claim(9), edit("edit-2")];
    expect(await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga")).toBeNull();
  });

  it("a claim older than UNDO_CLAIM_STALE_MS is ignored, so the retry reaches claimUndoRun and releases it", async () => {
    mocks.conductorRows = [claim(11), edit("edit-2")];
    expect((await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga"))?.conductor_run_id).toBe("edit-2");
  });

  it("an old proposed undo row that is not a claim still blocks", async () => {
    mocks.conductorRows = [claim(60, false), edit("edit-2")];
    expect(await realRefineUndoDeps.loadLatestShippedRefine("tnt-yoga")).toBeNull();
  });
});
