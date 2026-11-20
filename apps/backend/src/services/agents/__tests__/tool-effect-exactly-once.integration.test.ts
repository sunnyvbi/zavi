
import { describe, it, expect } from "vitest";
import { recordCheckpoint, loadResumeState, type CheckpointDeps, type LoadResumeDeps } from "../checkpoint";
import { runWithToolEffectGuard, type ToolEffectDeps } from "@/services/mcp/tool-effect-ledger";
import type { CallMcpContext } from "@/services/mcp/execute";
import type { McpCallResult } from "@/services/mcp/types";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

function makeLedger() {
  const store = new Map<string, { status: "pending" | "committed"; result?: McpCallResult }>();
  const key = (r: string, t: string) => `${r}:${t}`;
  const deps: ToolEffectDeps = {
    async lookupCommitted(run_id, tool_use_id) {
      const row = store.get(key(run_id, tool_use_id));
      return row?.status === "committed" ? (row.result ?? null) : null;
    },
    async claimPending(input) {
      const k = key(input.run_id, input.tool_use_id);
      if (!store.has(k)) store.set(k, { status: "pending" });
    },
    async commit(run_id, tool_use_id, result) {
      store.set(key(run_id, tool_use_id), { status: "committed", result });
    },
  };
  return { deps, store };
}

function makeCheckpoints() {
  const store = new Map<string, { iter: number; messages_jsonb: unknown; last_stop_reason: string | null }>();
  const writeDeps: CheckpointDeps = {
    async upsertLatest(input) {
      store.set(input.run_id, {
        iter: input.iter,
        messages_jsonb: JSON.parse(JSON.stringify(input.messages)),
        last_stop_reason: input.last_stop_reason ?? null,
      });
    },
    async pruneOlder() {
    },
  };
  const readDeps: LoadResumeDeps = {
    async fetchLatest(run_id) {
      return store.get(run_id) ?? null;
    },
  };
  return { writeDeps, readDeps, store };
}

const TENANT = "t1";
const RUN = "run-1";
const TOOL_USE_ID = "toolu_X";

const assistantTurn: MessageParam = {
  role: "assistant",
  content: [{ type: "tool_use", id: TOOL_USE_ID, name: "slack__post_message", input: { ch: "C1", text: "hi" } }],
};
const messagesAtCheckpoint: MessageParam[] = [{ role: "user", content: "post to slack" }, assistantTurn];

const ctx: CallMcpContext = { tenant_id: TENANT, run_id: RUN, tool_use_id: TOOL_USE_ID, iter: 0 };

function okResult(): McpCallResult {
  return { ok: true, is_error: false, content: '{"posted":true,"ts":"123"}', ms: 7 };
}

describe("F-1 exactly-once across a crash (3d)", () => {
  it("a side-effecting tool that ran before a crash is NOT re-executed on resume", async () => {
    const ledger = makeLedger();
    const ckpt = makeCheckpoints();
    let sideEffectCount = 0;
    const dispatch = async (): Promise<McpCallResult> => {
      sideEffectCount += 1;
      return okResult();
    };

    await recordCheckpoint(
      { run_id: RUN, tenant_id: TENANT, iter: 0, messages: messagesAtCheckpoint, last_stop_reason: "tool_use" },
      ckpt.writeDeps,
    );
    const firstResult = await runWithToolEffectGuard(ctx, "post_message", { ch: "C1" }, dispatch, ledger.deps);
    expect(firstResult.ok).toBe(true);
    expect(sideEffectCount).toBe(1);

    const resume = await loadResumeState(RUN, ckpt.readDeps);
    expect(resume).not.toBeNull();
    expect(resume!.startIter).toBe(0);
    expect(resume!.replayStopReason).toBe("tool_use");
    const replayResult = await runWithToolEffectGuard(ctx, "post_message", { ch: "C1" }, dispatch, ledger.deps);

    expect(sideEffectCount).toBe(1);
    expect(replayResult.content).toBe(firstResult.content);
  });

  it("a crash BEFORE commit (pending only) DOES re-execute on resume (no permanent block)", async () => {
    const ledger = makeLedger();
    let sideEffectCount = 0;
    await ledger.deps.claimPending({
      run_id: RUN, tenant_id: TENANT, tool_use_id: TOOL_USE_ID, iter: 0,
      tool_name: "post_message", input_hash: "h",
    });
    const dispatch = async (): Promise<McpCallResult> => { sideEffectCount += 1; return okResult(); };
    const out = await runWithToolEffectGuard(ctx, "post_message", { ch: "C1" }, dispatch, ledger.deps);
    expect(out.ok).toBe(true);
    expect(sideEffectCount).toBe(1);
  });
});
