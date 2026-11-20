import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));

import { writeAutopilotGoal } from "../goal-write";

beforeEach(() => rpc.mockReset());

describe("writeAutopilotGoal", () => {
  it("sends who and why with the tenant injected; only cgo sends a run, only a founder a user", async () => {
    rpc.mockResolvedValue({ data: { status: "written", id: "g-1" }, error: null });
    expect(
      await writeAutopilotGoal("t-1", { op: "update", goal_id: "g-1", values: { priority: 60 }, expect: { status: "active" }, actor: { source: "cgo", run_id: "r-1", why: "On pace" } }),
    ).toEqual({ status: "written", id: "g-1" });
    expect(rpc).toHaveBeenCalledWith("write_autopilot_goal", {
      p_tenant_id: "t-1",
      p_op: "update",
      p_goal_id: "g-1",
      p_values: { priority: 60 },
      p_expect: { status: "active" },
      p_status_not_in: null,
      p_actor_source: "cgo",
      p_actor_user_id: null,
      p_run_id: "r-1",
      p_why: "On pace",
    });
    await writeAutopilotGoal("t-1", { op: "delete", goal_id: "g-1", actor: { source: "founder", user_id: "u-1" } });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_actor_source: "founder", p_actor_user_id: "u-1", p_run_id: null, p_why: null, p_values: null });
  });

  it("not_matched, an RPC error, a throw and an unknown answer never read as written", async () => {
    rpc.mockResolvedValueOnce({ data: { status: "not_matched", id: null }, error: null });
    expect(await writeAutopilotGoal("t-1", { op: "update", goal_id: "g", values: { a: 1 }, actor: { source: "system" } })).toEqual({ status: "not_matched" });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "a cgo write needs its run and why" } });
    expect(await writeAutopilotGoal("t-1", { op: "update", goal_id: "g", values: { a: 1 }, actor: { source: "system" } })).toEqual({ status: "error", error: "a cgo write needs its run and why" });
    rpc.mockRejectedValueOnce(new Error("down"));
    expect((await writeAutopilotGoal("t-1", { op: "update", goal_id: "g", values: { a: 1 }, actor: { source: "system" } })).status).toBe("error");
    rpc.mockResolvedValueOnce({ data: { status: "written" }, error: null });
    expect((await writeAutopilotGoal("t-1", { op: "update", goal_id: "g", values: { a: 1 }, actor: { source: "system" } })).status).toBe("error");
  });
});
