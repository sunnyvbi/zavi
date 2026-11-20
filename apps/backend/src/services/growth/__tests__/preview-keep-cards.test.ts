
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: vi.fn() }) }));
vi.mock("@/services/agents/deepagent/engine", () => ({}));

import {
  asPreviewRunMode,
  planLockedChannels,
  previewRunMode,
  refuseIfChannelPlanLocked,
} from "../preview-plan";
import { makePreviewDryCtx } from "../preview-dry-run";
import { isPreviewAllowedTool } from "../preview-tools";
import { writesSuppressed } from "@/services/agents/generic-dispatcher";
import { makeDispatchTool, type MakeDispatchToolDeps } from "@/services/agents/engine/dispatch-tool";
import { preToolUsePolicyHook } from "@/services/agents/pre-tool-use-policy";
import type { AgentContext } from "@/services/agents/types";
import type { TierGateConfig } from "@/services/agents/entitlement";

const T = "11111111-1111-4111-8111-111111111111";
const preview = {
  tenant_id: T,
  agent_slug: "seo",
  trigger: "channel_recipe" as const,
  enqueued_by: null,
  cron_dedupe_key: `first-run-preview:${T}:seo`,
};
const cfg = (over: Partial<TierGateConfig> = {}): TierGateConfig => ({
  enforced: false,
  agentMin: { seo: "starter", x_organic: "starter", meta_ads: "pro" },
  proTenants: [],
  alwaysPro: [],
  ...over,
});
const free = { loadConfig: async () => cfg(), resolveTier: async () => "free" as const };
const starter = { loadConfig: async () => cfg(), resolveTier: async () => "starter" as const };

describe("previewRunMode", () => {
  it("switch ON: a preview run the plan lacks is dry AND keeps its cards", async () => {
    expect(await previewRunMode(preview, { ...free, realCards: async () => true })).toEqual({ dry: true, keepCards: true });
  });

  it("switch OFF: the same run is the count-only dry run", async () => {
    expect(await previewRunMode(preview, { ...free, realCards: async () => false })).toEqual({ dry: true, keepCards: false });
  });

  it("an unreadable switch means OFF", async () => {
    const realCards = async () => {
      throw new Error("db down");
    };
    expect(await previewRunMode(preview, { ...free, realCards })).toEqual({ dry: true, keepCards: false });
  });

  it("a plan that includes the channel is a real run: not dry, and the switch is never read", async () => {
    const realCards = vi.fn(async () => true);
    expect(await previewRunMode(preview, { ...starter, realCards })).toEqual({ dry: false, keepCards: false });
    expect(realCards).not.toHaveBeenCalled();
  });

  it("any other run is neither, and reads nothing", async () => {
    const realCards = vi.fn(async () => true);
    const loadConfig = vi.fn(async () => cfg());
    expect(await previewRunMode({ ...preview, cron_dedupe_key: null }, { loadConfig, realCards })).toEqual({
      dry: false,
      keepCards: false,
    });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(realCards).not.toHaveBeenCalled();
  });

  it("an unreadable plan is dry (fail closed) and may still keep cards", async () => {
    expect(
      await previewRunMode(preview, { loadConfig: async () => cfg({ deferred: true }), realCards: async () => true }),
    ).toEqual({ dry: true, keepCards: true });
  });
});

describe("asPreviewRunMode (a memoized step value, old or new)", () => {
  it("a bare boolean from a run claimed before keep-cards is that dry-or-not, never keep-cards", () => {
    expect(asPreviewRunMode(true)).toEqual({ dry: true, keepCards: false });
    expect(asPreviewRunMode(false)).toEqual({ dry: false, keepCards: false });
  });

  it("keepCards never survives without dry", () => {
    expect(asPreviewRunMode({ dry: false, keepCards: true })).toEqual({ dry: false, keepCards: false });
    expect(asPreviewRunMode({ dry: true, keepCards: true })).toEqual({ dry: true, keepCards: true });
    expect(asPreviewRunMode(null)).toEqual({ dry: false, keepCards: false });
  });
});

describe("the keep-cards context is the dry context plus one flag", () => {
  const base = { tenant_id: T, runId: "r-1", agent: { slug: "seo" }, emitDecision: async () => "real" } as unknown as AgentContext;

  it("still draft, still preview_dry, writes still suppressed, decisions still no-ops", async () => {
    const ctx = makePreviewDryCtx(base, { keepCards: true });
    expect(ctx.preview_dry).toBe(true);
    expect(ctx.draft_mode).toBe(true);
    expect(ctx.preview_keep_cards).toBe(true);
    expect(writesSuppressed(ctx)).toBe(true);
    expect(await ctx.emitDecision("channel.recipe_step", {})).toBe("best_of_n_draft_noop");
  });

  it("a plain dry context carries no keep-cards flag", () => {
    expect("preview_keep_cards" in makePreviewDryCtx(base)).toBe(false);
    expect("preview_keep_cards" in makePreviewDryCtx(base, { keepCards: false })).toBe(false);
  });
});

const STILL_DENIED = [
  "report__render_blog",
  "report__generate_image",
  "social__propose_post",
  "slack__send_message",
];

const KEEP_CARDS_ONLY = ["memory__search", "report__render_social_image"];

describe("tool gates on a keep-cards run: every denied tool is still denied", () => {
  const ctx = makePreviewDryCtx({ tenant_id: "t1", runId: "r1", agent: { slug: "seo" } } as unknown as AgentContext, {
    keepCards: true,
  });

  it.each(STILL_DENIED)("the gate predicate (legacy loop) denies %s, bare and SDK-wrapped", (tool) => {
    expect(ctx.preview_dry === true && !isPreviewAllowedTool(tool)).toBe(true);
    expect(ctx.preview_dry === true && !isPreviewAllowedTool(`mcp__praxis-server__${tool}`)).toBe(true);
  });

  it.each(STILL_DENIED)("engine funnel: %s is denied and never called", async (tool) => {
    const callSpy = vi.fn().mockResolvedValue({ ok: true, content: "{}", is_error: false, ms: 1 });
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
    };
    const res = await makeDispatchTool(deps)({ tool_name: tool, input: {}, tool_use_id: "tu-1" });
    expect(res.denied).toBe(true);
    expect(callSpy).not.toHaveBeenCalled();
  });

  it.each(STILL_DENIED)("SDK PreToolUse hook: %s is denied as preview_readonly", async (tool) => {
    const out = await preToolUsePolicyHook({
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
      },
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_name: `mcp__praxis-server__${tool}`,
        tool_input: {},
        tool_use_id: "tu-4",
        cwd: "/tmp",
        permission_mode: "default",
        session_id: "s",
        transcript_path: "/tmp/t",
      },
    } as never);
    expect((out.hookSpecificOutput as { permissionDecision?: string }).permissionDecision).toBe("deny");
    expect(out.reason).toBe("preview_readonly");
  });

  it("a named read still runs through the funnel", async () => {
    const callSpy = vi.fn().mockResolvedValue({ ok: true, content: "{}", is_error: false, ms: 1 });
    const dispatchTool = makeDispatchTool({
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
      preview_dry: ctx.preview_dry,
    });
    await dispatchTool({ tool_name: "web_fetch__fetch", input: { url: "https://example.com" }, tool_use_id: "tu-2" });
    expect(callSpy).toHaveBeenCalledTimes(1);
  });
});

function funnelDeps(ctx: AgentContext, callSpy: ReturnType<typeof vi.fn>): MakeDispatchToolDeps {
  return {
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
  };
}

async function hookDecision(ctx: AgentContext, tool: string) {
  const out = await preToolUsePolicyHook({
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
    },
    hookInput: {
      hook_event_name: "PreToolUse",
      tool_name: `mcp__praxis-server__${tool}`,
      tool_input: {},
      tool_use_id: "tu-5",
      cwd: "/tmp",
      permission_mode: "default",
      session_id: "s",
      transcript_path: "/tmp/t",
    },
  } as never);
  return out;
}

describe("keep-cards tools: allowed on a keep-cards round, denied on a count-only dry round", () => {
  const base = { tenant_id: "t1", runId: "r1", agent: { slug: "seo" } } as unknown as AgentContext;
  const keep = makePreviewDryCtx(base, { keepCards: true });
  const dry = makePreviewDryCtx(base);

  it.each(KEEP_CARDS_ONLY)("gate predicate: %s, bare and SDK-wrapped", (tool) => {
    for (const name of [tool, `mcp__praxis-server__${tool}`]) {
      expect(isPreviewAllowedTool(name, { keepCards: keep.preview_keep_cards === true })).toBe(true);
      expect(isPreviewAllowedTool(name, { keepCards: dry.preview_keep_cards === true })).toBe(false);
      expect(isPreviewAllowedTool(name)).toBe(false);
    }
  });

  it.each(KEEP_CARDS_ONLY)("engine funnel: %s runs on keep-cards, is denied on count-only", async (tool) => {
    const keepSpy = vi.fn().mockResolvedValue({ ok: true, content: "{}", is_error: false, ms: 1 });
    const keepRes = await makeDispatchTool(funnelDeps(keep, keepSpy))({ tool_name: tool, input: {}, tool_use_id: "tu-6" });
    expect(keepRes.denied).not.toBe(true);
    expect(keepSpy).toHaveBeenCalledTimes(1);

    const drySpy = vi.fn().mockResolvedValue({ ok: true, content: "{}", is_error: false, ms: 1 });
    const dryRes = await makeDispatchTool(funnelDeps(dry, drySpy))({ tool_name: tool, input: {}, tool_use_id: "tu-7" });
    expect(dryRes.denied).toBe(true);
    expect(drySpy).not.toHaveBeenCalled();
  });

  it.each(KEEP_CARDS_ONLY)("SDK PreToolUse hook: %s is not preview-denied on keep-cards, is on count-only", async (tool) => {
    const keepOut = await hookDecision(keep, tool);
    expect(keepOut.reason).not.toBe("preview_readonly");
    expect(keepOut.reason).not.toBe("best_of_n_draft_readonly");
    const dryOut = await hookDecision(dry, tool);
    expect(dryOut.reason).toBe("preview_readonly");
  });
});

describe("refuseIfChannelPlanLocked", () => {
  it("Free on a Starter channel: the 403 body and its message", async () => {
    const r = await refuseIfChannelPlanLocked(T, "x_organic", free);
    expect(r?.required_tier).toBe("starter");
    expect(r?.body.error.code).toBe("plan_upgrade_required");
    expect(r?.body.error.required_tier).toBe("starter");
    expect(r?.message).toBe(r?.body.error.message);
    expect(r?.message).toMatch(/Starter plan/);
  });

  it("Starter on a Starter channel passes; Starter on a Pro channel is refused", async () => {
    expect(await refuseIfChannelPlanLocked(T, "x_organic", starter)).toBeNull();
    expect((await refuseIfChannelPlanLocked(T, "meta_ads", starter))?.required_tier).toBe("pro");
  });

  it("a slug that is not a channel is never blocked, and costs no plan read", async () => {
    const loadConfig = vi.fn(async () => cfg());
    expect(await refuseIfChannelPlanLocked(T, "operator", { loadConfig })).toBeNull();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on an unreadable plan", async () => {
    expect(await refuseIfChannelPlanLocked(T, "x_organic", { loadConfig: async () => cfg({ deferred: true }) })).not.toBeNull();
    const resolveTier = async () => {
      throw new Error("db down");
    };
    expect(await refuseIfChannelPlanLocked(T, "x_organic", { loadConfig: async () => cfg(), resolveTier })).not.toBeNull();
  });

  it("strict (a worker that can retry): an unreadable plan THROWS, a known plan answers", async () => {
    await expect(
      refuseIfChannelPlanLocked(T, "x_organic", { strict: true, loadConfig: async () => cfg({ deferred: true }) }),
    ).rejects.toThrow(/unreadable/);
    await expect(
      refuseIfChannelPlanLocked(T, "x_organic", {
        strict: true,
        loadConfig: async () => cfg(),
        resolveTier: async () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow(/db down/);
    expect(await refuseIfChannelPlanLocked(T, "x_organic", { ...starter, strict: true })).toBeNull();
    expect((await refuseIfChannelPlanLocked(T, "x_organic", { ...free, strict: true }))?.required_tier).toBe("starter");
  });
});

describe("planLockedChannels", () => {
  it("one plan read for the whole list", async () => {
    const loadConfig = vi.fn(async () => cfg());
    const resolveTier = vi.fn(async () => "starter" as const);
    const locked = await planLockedChannels(T, ["seo", "meta_ads", "seo", "x_organic"], { loadConfig, resolveTier });
    expect([...locked]).toEqual(["meta_ads"]);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(resolveTier).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED: an unreadable plan locks every slug; no slugs reads nothing", async () => {
    expect([...(await planLockedChannels(T, ["seo", "x_organic"], { loadConfig: async () => cfg({ deferred: true }) }))]).toEqual([
      "seo",
      "x_organic",
    ]);
    const loadConfig = vi.fn(async () => cfg());
    expect((await planLockedChannels(T, [], { loadConfig })).size).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
