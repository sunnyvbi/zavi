import { describe, it, expect } from "vitest";
import {
  buildBatchControlBlocks,
  buildBatchValue,
  parseBatchValue,
  SLACK_ACTION_APPROVE_ALL,
  SLACK_ACTION_REJECT_ALL,
  SLACK_BLOCK_ID_BATCH,
} from "../slack-approval-blocks";

describe("batch value codec", () => {
  it("round-trips run_id|cutoff_ms", () => {
    const v = buildBatchValue("run-123", 1782636000000);
    expect(v).toBe("run-123|1782636000000");
    expect(parseBatchValue(v)).toEqual({ runId: "run-123", cutoffMs: 1782636000000 });
  });
  it("tolerates a missing/garbage cutoff", () => {
    expect(parseBatchValue("run-123")).toEqual({ runId: "run-123", cutoffMs: 0 });
    expect(parseBatchValue("run-123|nan")).toEqual({ runId: "run-123", cutoffMs: 0 });
  });
});

describe("buildBatchControlBlocks", () => {
  it("renders approve-all + reject-all buttons carrying run|cutoff, plus the money-skip note", () => {
    const blocks = buildBatchControlBlocks("run-9", 4, 1782636000000) as Array<{
      type: string;
      block_id?: string;
      elements?: Array<{ action_id?: string; value?: string }>;
      text?: { text?: string };
    }>;
    const actions = blocks.find((b) => b.type === "actions" && b.block_id === SLACK_BLOCK_ID_BATCH);
    expect(actions).toBeTruthy();
    const ids = (actions!.elements ?? []).map((e) => e.action_id);
    expect(ids).toContain(SLACK_ACTION_APPROVE_ALL);
    expect(ids).toContain(SLACK_ACTION_REJECT_ALL);
    expect((actions!.elements ?? [])[0].value).toBe("run-9|1782636000000");
    const ctx = blocks.find((b) => b.type === "context") as { elements?: Array<{ text?: string }> };
    expect(JSON.stringify(ctx)).toMatch(/skips money/i);
  });
});
