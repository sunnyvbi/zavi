import { describe, it, expect, vi } from "vitest";
import {
  recordCheckpoint,
  loadResumeState,
  buildCheckpointSummary,
  type CheckpointDeps,
  type CheckpointInput,
  type LoadResumeDeps,
} from "../checkpoint";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

const messages: MessageParam[] = [
  { role: "user", content: "hi" },
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
];

const input: CheckpointInput = {
  run_id: "r1",
  tenant_id: "t1",
  iter: 5,
  messages,
  usage: { input_tokens: 10, output_tokens: 20 },
  last_stop_reason: "tool_use",
};

function deps(overrides: Partial<CheckpointDeps> = {}): CheckpointDeps {
  return {
    upsertLatest: vi.fn(async () => {}),
    pruneOlder: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("recordCheckpoint", () => {
  it("upserts the latest snapshot then prunes older rows for the run", async () => {
    const d = deps();
    await recordCheckpoint(input, d);
    expect(d.upsertLatest).toHaveBeenCalledOnce();
    expect(d.upsertLatest).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: "r1", tenant_id: "t1", iter: 5, last_stop_reason: "tool_use" }),
    );
    expect(d.pruneOlder).toHaveBeenCalledWith("r1", 5);
  });

  it("FAIL-OPEN: upsert error does not throw AND skips prune (don't drop the only good row)", async () => {
    const d = deps({ upsertLatest: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(recordCheckpoint(input, d)).resolves.toBeUndefined();
    expect(d.pruneOlder).not.toHaveBeenCalled();
  });

  it("FAIL-OPEN: prune error does not throw (latest row already persisted)", async () => {
    const d = deps({ pruneOlder: vi.fn(async () => { throw new Error("delete blocked"); }) });
    await expect(recordCheckpoint(input, d)).resolves.toBeUndefined();
    expect(d.upsertLatest).toHaveBeenCalledOnce();
  });
});

describe("loadResumeState", () => {
  const assistantTurn: MessageParam = {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_X", name: "slack__post", input: {} }],
  };
  type CheckpointRow = Awaited<ReturnType<LoadResumeDeps["fetchLatest"]>>;
  function rdeps(row: CheckpointRow): LoadResumeDeps {
    return { fetchLatest: vi.fn(async () => row) };
  }

  it("returns resume state when the latest checkpoint ends in an assistant turn", async () => {
    const d = rdeps({
      iter: 7,
      messages_jsonb: [{ role: "user", content: "go" }, assistantTurn],
      last_stop_reason: "tool_use",
    });
    const rs = await loadResumeState("r1", d);
    expect(rs).not.toBeNull();
    expect(rs!.startIter).toBe(7);
    expect(rs!.replayStopReason).toBe("tool_use");
    expect(rs!.messages).toHaveLength(2);
    expect(rs!.replayContent).toEqual(assistantTurn.content);
  });

  it("returns null when there is no checkpoint (fresh run)", async () => {
    expect(await loadResumeState("r1", rdeps(null))).toBeNull();
  });

  it("returns null when the snapshot is empty", async () => {
    const d = rdeps({ iter: 0, messages_jsonb: [], last_stop_reason: null });
    expect(await loadResumeState("r1", d)).toBeNull();
  });

  it("returns null when the last turn is NOT an assistant turn (not replayable)", async () => {
    const d = rdeps({
      iter: 3,
      messages_jsonb: [assistantTurn, { role: "user", content: "follow-up" }],
      last_stop_reason: null,
    });
    expect(await loadResumeState("r1", d)).toBeNull();
  });

  it("FAIL-OPEN: a fetch error → null (resume skipped, run starts fresh)", async () => {
    const d: LoadResumeDeps = { fetchLatest: vi.fn(async () => { throw new Error("db down"); }) };
    expect(await loadResumeState("r1", d)).toBeNull();
  });
});

describe("buildCheckpointSummary (F-3)", () => {
  it("includes iter, objective, and the next tool names", () => {
    const s = buildCheckpointSummary("Refund trip 123", 4, ["stripe__refund", "slack__post"]);
    expect(s).toBe("iter 4 | Refund trip 123 | next: stripe__refund, slack__post");
  });

  it("omits the tool clause when there are no tools", () => {
    expect(buildCheckpointSummary("Draft the brief", 0, [])).toBe("iter 0 | Draft the brief");
  });

  it("is deterministic (same inputs → same output)", () => {
    const a = buildCheckpointSummary("obj", 2, ["t1", "t2"]);
    const b = buildCheckpointSummary("obj", 2, ["t1", "t2"]);
    expect(a).toBe(b);
  });

  it("collapses whitespace and caps at 500 chars", () => {
    const s = buildCheckpointSummary("a\n\n   b   c", 1, []);
    expect(s).toBe("iter 1 | a b c");
    const long = buildCheckpointSummary("x".repeat(1000), 9, ["y".repeat(1000)]);
    expect(long.length).toBeLessThanOrEqual(500);
  });
});

describe("recordCheckpoint passes summary through", () => {
  it("writes the summary on the upsert", async () => {
    const upsertLatest = vi.fn(async () => {});
    const withSummary: CheckpointInput = { ...input, summary: "iter 5 | do the thing" };
    await recordCheckpoint(withSummary, { upsertLatest, pruneOlder: vi.fn(async () => {}) });
    expect(upsertLatest).toHaveBeenCalledWith(expect.objectContaining({ summary: "iter 5 | do the thing" }));
  });
});
