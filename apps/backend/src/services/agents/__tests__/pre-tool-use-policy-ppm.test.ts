import { describe, it, expect, vi } from "vitest";
import { preToolUsePolicyHook } from "../pre-tool-use-policy";
import type {
  PreToolUsePolicyCtx,
  PreToolUsePolicyDeps,
} from "../pre-tool-use-policy";

function makeCtx(o?: Partial<PreToolUsePolicyCtx>): PreToolUsePolicyCtx {
  return {
    tenant_id: "11111111-1111-1111-1111-111111111111",
    agent: { slug: "pm" },
    runId: "run_x",
    thread_id: null,
    killed: { value: false },
    iter: { value: 0 },
    ...o,
  };
}
function deps(
  ctx: PreToolUsePolicyCtx,
  tool_name: string,
): PreToolUsePolicyDeps {
  return {
    isAgentKilled: vi.fn(async () => false),
    emitThreadEvent: vi.fn(async () => {}),
    ctx,
    hookInput: { tool_name, tool_input: {}, tool_use_id: "t1" } as never,
  };
}
const isDeny = (r: { continue?: boolean; hookSpecificOutput?: unknown }) =>
  r.continue === undefined &&
  (r.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";

describe("pm web_search PreToolUse gate", () => {
  it("delivery mode → DENY web_search", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ run_mode: "delivery", webSearchCounter: { n: 0 } }), "web_search__search"),
    );
    expect(isDeny(r)).toBe(true);
    expect((r as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason).toMatch(/strategy-only/);
  });

  it("missing run_mode (defaults delivery) → DENY web_search", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ webSearchCounter: { n: 0 } }), "web_search__search"),
    );
    expect(isDeny(r)).toBe(true);
  });

  it("strategy mode, calls 1-3 → ALLOW + increments counter", async () => {
    const counter = { n: 0 };
    const ctx = makeCtx({ run_mode: "strategy_memo", webSearchCounter: counter });
    for (let i = 1; i <= 3; i++) {
      const r = await preToolUsePolicyHook(deps(ctx, "web_search__search"));
      expect(r).toEqual({ continue: true });
      expect(counter.n).toBe(i);
    }
  });

  it("strategy mode, 4th call → DENY (cap 3)", async () => {
    const ctx = makeCtx({ run_mode: "strategy_memo", webSearchCounter: { n: 3 } });
    const r = await preToolUsePolicyHook(deps(ctx, "web_search__search"));
    expect(isDeny(r)).toBe(true);
    expect((r as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason).toMatch(/cap of 3/);
  });

  it("pm non-web tool → ALLOW (unchanged)", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ run_mode: "delivery" }), "memory__search"),
    );
    expect(r).toEqual({ continue: true });
  });

  it("OTHER agent + web_search → ALLOW (gate is pm-scoped)", async () => {
    const r = await preToolUsePolicyHook(
      deps(makeCtx({ agent: { slug: "advisor" }, run_mode: "delivery" }), "web_search__search"),
    );
    expect(r).toEqual({ continue: true });
  });
});
