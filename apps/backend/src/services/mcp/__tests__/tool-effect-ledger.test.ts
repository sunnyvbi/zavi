import { describe, it, expect, vi } from "vitest";
import {
  runWithToolEffectGuard,
  hashToolInput,
  isToolEffectLedgerEnabled,
  type ToolEffectDeps,
} from "../tool-effect-ledger";
import type { CallMcpContext } from "../execute";
import type { McpCallResult } from "../types";

const ctx: CallMcpContext = {
  tenant_id: "t1",
  run_id: "r1",
  tool_use_id: "toolu_ABC",
  iter: 3,
};

const okResult: McpCallResult = { ok: true, is_error: false, content: '{"posted":true}', ms: 12 };

function deps(overrides: Partial<ToolEffectDeps> = {}): ToolEffectDeps {
  return {
    lookupCommitted: vi.fn(async () => null),
    claimPending: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("isToolEffectLedgerEnabled", () => {
  it("is OFF unless env flag is exactly '1'", () => {
    const prev = process.env.PRAXIS_TOOL_EFFECT_LEDGER;
    delete process.env.PRAXIS_TOOL_EFFECT_LEDGER;
    expect(isToolEffectLedgerEnabled()).toBe(false);
    process.env.PRAXIS_TOOL_EFFECT_LEDGER = "true";
    expect(isToolEffectLedgerEnabled()).toBe(false);
    process.env.PRAXIS_TOOL_EFFECT_LEDGER = "1";
    expect(isToolEffectLedgerEnabled()).toBe(true);
    if (prev === undefined) delete process.env.PRAXIS_TOOL_EFFECT_LEDGER;
    else process.env.PRAXIS_TOOL_EFFECT_LEDGER = prev;
  });
});

describe("hashToolInput", () => {
  it("is stable across key order (deterministic)", () => {
    expect(hashToolInput({ a: 1, b: 2 })).toBe(hashToolInput({ b: 2, a: 1 }));
  });
  it("differs on different input", () => {
    expect(hashToolInput({ a: 1 })).not.toBe(hashToolInput({ a: 2 }));
  });
});

describe("runWithToolEffectGuard — exactly-once on resume", () => {
  it("SKIPS dispatch + returns the stored result when a committed effect exists", async () => {
    const prior: McpCallResult = { ok: true, is_error: false, content: '{"replayed":true}', ms: 0 };
    const d = deps({ lookupCommitted: vi.fn(async () => prior) });
    const dispatch = vi.fn(async () => okResult);

    const out = await runWithToolEffectGuard(ctx, "post_message", { ch: "x" }, dispatch, d);

    expect(out).toBe(prior);
    expect(dispatch).not.toHaveBeenCalled();
    expect(d.claimPending).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
  });

  it("on a MISS: claims pending, dispatches, commits the successful result", async () => {
    const d = deps();
    const dispatch = vi.fn(async () => okResult);

    const out = await runWithToolEffectGuard(ctx, "post_message", { ch: "x" }, dispatch, d);

    expect(out).toBe(okResult);
    expect(d.claimPending).toHaveBeenCalledOnce();
    expect(d.claimPending).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: "r1", tenant_id: "t1", tool_use_id: "toolu_ABC", iter: 3, tool_name: "post_message" }),
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(d.commit).toHaveBeenCalledWith("r1", "toolu_ABC", okResult);
  });

  it("does NOT commit an errored result (stays pending → re-dispatchable on resume)", async () => {
    const errResult: McpCallResult = { ok: false, is_error: true, content: '{"error":"x"}', ms: 5 };
    const d = deps();
    const dispatch = vi.fn(async () => errResult);

    const out = await runWithToolEffectGuard(ctx, "post_message", {}, dispatch, d);

    expect(out).toBe(errResult);
    expect(d.commit).not.toHaveBeenCalled();
  });

  it("FAIL-OPEN: a lookup error still dispatches the tool (never blocks a call)", async () => {
    const d = deps({ lookupCommitted: vi.fn(async () => { throw new Error("db down"); }) });
    const dispatch = vi.fn(async () => okResult);

    const out = await runWithToolEffectGuard(ctx, "post_message", {}, dispatch, d);

    expect(out).toBe(okResult);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("FAIL-OPEN: a claim error still dispatches + still attempts commit", async () => {
    const d = deps({ claimPending: vi.fn(async () => { throw new Error("conflict storm"); }) });
    const dispatch = vi.fn(async () => okResult);

    const out = await runWithToolEffectGuard(ctx, "post_message", {}, dispatch, d);

    expect(out).toBe(okResult);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(d.commit).toHaveBeenCalledOnce();
  });

  it("FAIL-OPEN: a commit error does not throw (call result still returned)", async () => {
    const d = deps({ commit: vi.fn(async () => { throw new Error("update lost"); }) });
    const dispatch = vi.fn(async () => okResult);

    const out = await runWithToolEffectGuard(ctx, "post_message", {}, dispatch, d);

    expect(out).toBe(okResult);
  });

  it("input-hash MISMATCH: never returns the other call's stored result; dispatches plainly", async () => {
    const stored: McpCallResult = { ok: true, is_error: false, content: '{"url":"A"}', ms: 0 };
    const d = deps({
      lookupCommitted: vi.fn(async () => ({ result: stored, input_hash: hashToolInput({ url: "A" }) })),
    });
    const dispatch = vi.fn(async () => okResult);

    const out = await runWithToolEffectGuard(ctx, "task", { url: "B" }, dispatch, d);

    expect(out).toBe(okResult);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(d.claimPending).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
  });

  it("input-hash MATCH still replays the stored result", async () => {
    const stored: McpCallResult = { ok: true, is_error: false, content: '{"url":"A"}', ms: 0 };
    const d = deps({
      lookupCommitted: vi.fn(async () => ({ result: stored, input_hash: hashToolInput({ url: "A" }) })),
    });
    const dispatch = vi.fn(async () => okResult);
    const out = await runWithToolEffectGuard(ctx, "task", { url: "A" }, dispatch, d);
    expect(out).toBe(stored);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("CONCURRENT: claim finds the key held and nothing committed → busy, no second dispatch", async () => {
    const d = deps({ claimPending: vi.fn(async () => false) });
    const dispatch = vi.fn(async () => okResult);
    const busy: McpCallResult = { ok: true, is_error: false, content: "busy", ms: 0 };

    const out = await runWithToolEffectGuard(ctx, "task", {}, dispatch, d, () => busy);

    expect(out).toBe(busy);
    expect(dispatch).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
  });

  it("CONCURRENT: default busy result is a retryable error", async () => {
    const d = deps({ claimPending: vi.fn(async () => false) });
    const out = await runWithToolEffectGuard(ctx, "task", {}, vi.fn(async () => okResult), d);
    expect(out.is_error).toBe(true);
    expect(out.content).toContain("tool_call_in_progress");
  });

  it("CONCURRENT: the other attempt committed meanwhile (same input) → replay it", async () => {
    const stored: McpCallResult = { ok: true, is_error: false, content: "theirs", ms: 0 };
    const lookup = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ result: stored, input_hash: hashToolInput({}) });
    const d = deps({ lookupCommitted: lookup, claimPending: vi.fn(async () => false) });
    const dispatch = vi.fn(async () => okResult);
    const out = await runWithToolEffectGuard(ctx, "task", {}, dispatch, d);
    expect(out).toBe(stored);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("an errored dispatch releases its pending row so a retry can re-dispatch", async () => {
    const release = vi.fn(async () => {});
    const d = deps({ release });
    const errResult: McpCallResult = { ok: false, is_error: true, content: "x", ms: 0 };
    await runWithToolEffectGuard(ctx, "task", {}, vi.fn(async () => errResult), d);
    expect(release).toHaveBeenCalledWith("r1", "toolu_ABC");
  });
});

describe("takeover: false (extension__browser_task)", () => {
  it("a stale pending claim is never re-dispatched: staleResult answers", async () => {
    const d = deps({ claimPending: vi.fn(async () => "stale" as const) });
    const dispatch = vi.fn(async () => okResult);
    const stale: McpCallResult = { ok: true, is_error: false, content: '{"blocked_reason":"outcome_unknown"}', ms: 0 };
    const r = await runWithToolEffectGuard(ctx, "browser_task", {}, dispatch, d, undefined, { takeover: false, staleResult: () => stale });
    expect(r).toBe(stale);
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.mocked(d.claimPending).mock.calls[0][0]).toMatchObject({ takeover: false });
  });

  it("other tools keep the default (no takeover flag sent)", async () => {
    const d = deps({ claimPending: vi.fn(async () => true) });
    await runWithToolEffectGuard(ctx, "post", {}, async () => okResult, d);
    expect(vi.mocked(d.claimPending).mock.calls[0][0]).not.toHaveProperty("takeover");
  });
});
