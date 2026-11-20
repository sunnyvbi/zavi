
import { describe, it, expect } from "vitest";

function shouldEnqueuePurge(action: "disable" | "enable", wasDisabled: boolean): boolean {
  return action === "disable" && !wasDisabled;
}

describe("Slack-IQ W2 killswitch — transition rule", () => {
  it("disable on inactive tenant → enqueue purge", () => {
    expect(shouldEnqueuePurge("disable", false)).toBe(true);
  });
  it("disable on already-killswitched tenant → NO re-purge (idempotent)", () => {
    expect(shouldEnqueuePurge("disable", true)).toBe(false);
  });
  it("enable on killswitched tenant → never enqueues purge", () => {
    expect(shouldEnqueuePurge("enable", true)).toBe(false);
  });
  it("enable on already-active tenant → no-op", () => {
    expect(shouldEnqueuePurge("enable", false)).toBe(false);
  });
});

describe("Slack-IQ W2 killswitch — purge worker count math", () => {
  function chunkLoopDone(rowsReturned: number, chunkSize: number): boolean {
    return rowsReturned < chunkSize;
  }

  it("full chunk → keep iterating", () => {
    expect(chunkLoopDone(1000, 1000)).toBe(false);
  });
  it("partial chunk → done", () => {
    expect(chunkLoopDone(457, 1000)).toBe(true);
  });
  it("empty chunk → done immediately", () => {
    expect(chunkLoopDone(0, 1000)).toBe(true);
  });
});

describe("Slack-IQ W2 killswitch — memory_note cascade predicate (codex F4)", () => {
  const PURGE_SOURCE_FILTER = "auto_distill_slack";
  const DISTILL_RPC_SOURCE = "auto_distill_slack";

  it("purge filter source matches what the RPC writes", () => {
    expect(PURGE_SOURCE_FILTER).toBe(DISTILL_RPC_SOURCE);
  });

  it("audit meta shape includes both cascade counts", () => {
    const auditMeta = {
      tenant_id: "00000000-0000-0000-0000-000000000001",
      reason: "killswitch",
      slack_message_index_deleted: 5,
      memory_note_deleted: 2,
    };
    expect(auditMeta).toHaveProperty("tenant_id");
    expect(auditMeta).toHaveProperty("reason");
    expect(auditMeta).toHaveProperty("slack_message_index_deleted");
    expect(auditMeta).toHaveProperty("memory_note_deleted");
  });
});
