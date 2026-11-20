import { describe, expect, it, vi } from "vitest";
import { approveChannelAction } from "../exec-actions";

const args = (source: "cgo" | "staff" | null) => ({ actionId: "a-1", eventKey: "k", actorUserId: "owner", source });
const okRpc = () => vi.fn(async () => ({ data: { ok: true, attempt: 1 }, error: null })) as never;

describe("approveChannelAction and a founder order", () => {
  it("refuses a cgo approval of a founder-ordered card and never calls the RPC", async () => {
    for (const origin of ["user_initiated_chat", "user_initiated_ledger"]) {
      const rpc = okRpc();
      const r = await approveChannelAction("t-1", args("cgo"), rpc, async () => ({ origin }));
      expect(r).toEqual({ ok: false, code: "founder_order" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("an unreadable payload refuses a cgo approval (fail closed)", async () => {
    const rpc = okRpc();
    expect(await approveChannelAction("t-1", args("cgo"), rpc, async () => Promise.reject(new Error("down")))).toEqual({ ok: false, code: "founder_order_unreadable" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the founder's own approve and Autopilot on an agent card are unchanged", async () => {
    const read = vi.fn(async () => ({ origin: "user_initiated_chat" }));
    expect((await approveChannelAction("t-1", args(null), okRpc(), read)).ok).toBe(true);
    expect((await approveChannelAction("t-1", args("cgo"), okRpc(), async () => ({ origin: "agent" }))).ok).toBe(true);
  });
});

describe("approveChannelAction and a founder's paired move", () => {
  const leg = { origin: "user_initiated_chat", founder_chat_order: true, move_group: "run-root" };

  it("must-catch: a waiting leg is refused with the founder's words and nothing is queued", async () => {
    const rpc = okRpc();
    const r = await approveChannelAction("t-1", args(null), rpc, async () => leg, async () => ({ kind: "wait", why: "cut_untapped", legs: [] }));
    expect(r).toMatchObject({ ok: false, code: "paired_move_waits" });
    expect((r as { detail?: string }).detail).toMatch(/Approve the matching cut first/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("must-not-touch: a leg cleared to go, and a card that is not part of a move, approve as before", async () => {
    const check = vi.fn(async () => ({ kind: "go" as const }));
    expect((await approveChannelAction("t-1", args(null), okRpc(), async () => leg, check)).ok).toBe(true);
    expect((await approveChannelAction("t-1", args(null), okRpc(), async () => ({ origin: "agent" }), check)).ok).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("an unreadable payload refuses a person's approve too (fail closed)", async () => {
    const rpc = okRpc();
    expect(await approveChannelAction("t-1", args(null), rpc, async () => Promise.reject(new Error("down")))).toEqual({ ok: false, code: "paired_move_unreadable" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
