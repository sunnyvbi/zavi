import { describe, expect, it, vi } from "vitest";
import { EXEC_STAGES, recordExecProgress, sendMayHaveHappened, toExecProgress } from "../exec-progress";

describe("toExecProgress", () => {
  it("reads a stored campaign and stage", () => {
    expect(toExecProgress({ campaign_id: "c1", stage: "content_set" })).toEqual({ campaign_id: "c1", stage: "content_set" });
  });

  it("anything that is not a campaign id plus a known stage is no progress", () => {
    for (const raw of [null, undefined, "sent", [], {}, { campaign_id: "c1" }, { stage: "sent" }, { campaign_id: "", stage: "sent" }, { campaign_id: "c1", stage: "delivered" }, { campaign_id: 7, stage: "sent" }]) {
      expect(toExecProgress(raw)).toBeNull();
    }
  });

  it("the stages are in the order the SQL ranks them", () => {
    expect([...EXEC_STAGES]).toEqual(["created", "content_set", "send_requested", "sent"]);
  });
});

describe("sendMayHaveHappened", () => {
  it("is true from send_requested on, and false before it or with no progress", () => {
    expect(sendMayHaveHappened({ campaign_id: "c", stage: "send_requested" })).toBe(true);
    expect(sendMayHaveHappened({ campaign_id: "c", stage: "sent" })).toBe(true);
    expect(sendMayHaveHappened({ campaign_id: "c", stage: "created" })).toBe(false);
    expect(sendMayHaveHappened({ campaign_id: "c", stage: "content_set" })).toBe(false);
    expect(sendMayHaveHappened(null)).toBe(false);
  });
});

describe("recordExecProgress", () => {
  it("writes through the claim-checked RPC and reports whether the claim still held", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, stage: "created" }, error: null }));
    expect(await recordExecProgress("t1", "a1", "claim-1", { campaign_id: "c1", stage: "created" }, rpc as never)).toBe(true);
    expect(rpc).toHaveBeenCalledWith("t1", "record_channel_action_exec_progress", { p_action_id: "a1", p_claim_id: "claim-1", p_progress: { campaign_id: "c1", stage: "created" } });
  });

  it("a refused write (the claim was lost) is false, and an RPC error throws", async () => {
    const refused = vi.fn(async () => ({ data: { ok: false, code: "not_owner" }, error: null }));
    expect(await recordExecProgress("t1", "a1", "claim-1", { campaign_id: "c1", stage: "sent" }, refused as never)).toBe(false);
    const broken = vi.fn(async () => ({ data: null, error: { message: "db down" } }));
    await expect(recordExecProgress("t1", "a1", "claim-1", { campaign_id: "c1", stage: "sent" }, broken as never)).rejects.toThrow("db down");
  });
});
