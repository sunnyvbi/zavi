import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const op of ["select", "eq"]) q[op] = () => q;
      q.maybeSingle = async () => ({ data: table === "system_config" ? { blob: { tier_gate_enforced: true } } : null, error: null });
      return q;
    },
  }),
}));
vi.mock("@/services/agents/deepagent/engine", () => ({}));

import { makeDoneForYouCtx } from "../done-for-you-ctx";
import { writesSuppressed } from "@/services/agents/generic-dispatcher";
import { makeDispatchTool, type MakeDispatchToolDeps } from "@/services/agents/engine/dispatch-tool";
import { preToolUsePolicyHook } from "@/services/agents/pre-tool-use-policy";
import { createTierGate } from "@/services/agents/entitlement";
import type { AgentContext } from "@/services/agents/types";
import { doneForYouKey } from "@/services/billing/tiers";

const T = "11111111-1111-4111-8111-111111111111";
const base = { tenant_id: T, agent: { slug: "seo" }, runId: "r1", emitDecision: vi.fn(async () => "real"), emitProgress: vi.fn() } as unknown as AgentContext;
const ctx = makeDoneForYouCtx(base);

function funnel(callSpy: ReturnType<typeof vi.fn>) {
  const deps: MakeDispatchToolDeps = {
    isToolAllowed: async () => ({ allowed: true }),
    evaluateToolCallPolicy: () => ({ allow: true, reason: "ok" }),
    shouldDenyPmOperatorDb: () => false,
    isAgentKilled: async () => false,
    callMcpTool: callSpy as unknown as MakeDispatchToolDeps["callMcpTool"],
    tenant_id: "t1",
    agent_slug: "seo",
    baseCallCtx: { tenant_id: "t1", run_id: "r1" },
    onEvent: () => {},
    iter: { value: 1 },
    draft_mode: ctx.draft_mode,
    preview_dry: ctx.preview_dry,
    preview_keep_cards: ctx.preview_keep_cards,
    done_for_you: ctx.done_for_you,
  };
  return makeDispatchTool(deps);
}

async function hook(tool: string) {
  return preToolUsePolicyHook({
    isAgentKilled: async () => false,
    emitThreadEvent: vi.fn(),
    ctx: {
      tenant_id: "t1",
      agent: { slug: "seo" },
      runId: "r1",
      thread_id: null,
      killed: { value: false },
      iter: { value: 1 },
      draft_mode: ctx.draft_mode,
      preview_dry: ctx.preview_dry,
      preview_keep_cards: ctx.preview_keep_cards,
      done_for_you: ctx.done_for_you,
    },
    hookInput: {
      hook_event_name: "PreToolUse",
      tool_name: `mcp__praxis-server__${tool}`,
      tool_input: {},
      tool_use_id: "tu-1",
      cwd: "/tmp",
      permission_mode: "default",
      session_id: "s",
      transcript_path: "/tmp/t",
    },
  } as never);
}

describe("makeDoneForYouCtx", () => {
  it("is a draft context that writes nothing durable, not a preview (the result is kept)", async () => {
    expect(ctx.done_for_you).toBe(true);
    expect(ctx.draft_mode).toBe(true);
    expect(writesSuppressed(ctx)).toBe(true);
    expect(ctx.preview_dry).toBeUndefined();
    expect(ctx.preview_keep_cards).toBeUndefined();
    expect(await ctx.emitDecision("channel.recipe_step", {} as never)).not.toBe("real");
  });

  it.each(["social__propose_post", "memory__write", "seo__propose_pr", "report__generate_image", "report__render_pdf", "praxis__remind"])(
    "%s is denied by the engine funnel and the SDK hook",
    async (tool) => {
      const spy = vi.fn().mockResolvedValue({ ok: true, content: "{}", is_error: false, ms: 1 });
      const res = await funnel(spy)({ tool_name: tool, input: {}, tool_use_id: "tu-1" });
      expect(res.denied).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const out = await hook(tool);
      expect((out.hookSpecificOutput as { permissionDecision?: string }).permissionDecision).toBe("deny");
    },
  );

  it.each(["web_fetch__fetch", "report__render_social_image", "memory__search"])("%s runs", async (tool) => {
    const spy = vi.fn().mockResolvedValue({ ok: true, content: "{}", is_error: false, ms: 1 });
    await funnel(spy)({ tool_name: tool, input: {}, tool_use_id: "tu-2" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("tier gate", () => {
  const gate = () => createTierGate();

  it("lets the done-for-you identity run a Starter channel on Free with the gate enforced", async () => {
    const d = await gate().decide(T, "seo", {
      run: { trigger: "channel_recipe", enqueuedByUser: false, payload: null, cronDedupeKey: doneForYouKey(T, 1) },
    } as never);
    expect(d).toMatchObject({ allowed: true });
    expect(d).not.toHaveProperty("unverified");
  });

  it("still refuses a plain channel run, a user-written one, or another tenant's key", async () => {
    for (const run of [
      { trigger: "channel_recipe", enqueuedByUser: false, payload: null, cronDedupeKey: null },
      { trigger: "channel_recipe", enqueuedByUser: true, payload: null, cronDedupeKey: doneForYouKey(T, 1) },
      { trigger: "channel_recipe", enqueuedByUser: false, payload: null, cronDedupeKey: doneForYouKey("22222222-2222-4222-8222-222222222222", 1) },
    ]) {
      const d = await gate().decide(T, "seo", { run } as never);
      expect(d).toMatchObject({ enforced: true, tier: "free", required_tier: "starter", allowed: false });
    }
    const pro = await gate().decide(T, "meta_ads", {
      run: { trigger: "channel_recipe", enqueuedByUser: false, payload: null, cronDedupeKey: doneForYouKey(T, 1) },
    } as never);
    expect(pro).toMatchObject({ allowed: false });
  });
});
