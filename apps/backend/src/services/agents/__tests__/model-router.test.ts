import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/settings", () => ({
  getAppSetting: async () => undefined,
}));

import {
  resolveModelForRun,
  routingDecisionForPersist,
  defaultRouterDeps,
  type RouterDeps,
  type ModelRoutingPolicy,
  type ClassifyResult,
} from "@/services/agents/model-router";
import { MODELS } from "@/services/llm/models";
import type { AgentContext } from "@/services/agents/types";
import { listGlobalAgentSlugs, loadGlobalAgentDefinition } from "@/services/agents/registry";

const OPUS = MODELS.anthropic.opus;
const SONNET = MODELS.anthropic.sonnet;

function makeCtx(opts: {
  slug?: string;
  model?: string;
  policy?: ModelRoutingPolicy | null;
  thread_id?: string;
  trigger?: string;
}): AgentContext {
  return {
    agent: {
      slug: opts.slug ?? "engineer",
      metadata_praxis: {
        model: opts.model ?? OPUS,
        ...(opts.policy ? { model_routing: opts.policy } : {}),
      },
    },
    thread_id: opts.thread_id,
    ...(opts.trigger ? { trigger: opts.trigger } : {}),
  } as unknown as AgentContext;
}

const POLICY: ModelRoutingPolicy = {
  base: "sonnet",
  escalate_to: "opus",
  floor_payload_stage: true,
  floor_keywords: ["implement", "fix"],
  classifier: true,
};

function makeDeps(over: Partial<RouterDeps> = {}): RouterDeps {
  const classifyLow = vi.fn(
    async (_slug: string, _text: string): Promise<ClassifyResult> => ({
      level: "light",
      reason_code: "classifier_low",
      classifier_ms: 12,
      cost_usd: 0.0003,
    }),
  );
  return {
    flagEnabled: () => true,
    mode: () => "live",
    classify: classifyLow,
    readThreadRouting: vi.fn(async () => ({ routed_model: null, sdk_session_id: null })),
    writeSticky: vi.fn(async () => {}),
    readChatMessage: vi.fn(async () => "loaded chat body"),
    readPriorClassifyTier: vi.fn(async () => null),
    costV2Enabled: () => false,
    ...over,
  };
}

describe("model-router resolveModelForRun", () => {
  it("returns null when the flag is OFF (no routing, no record) even with a policy", async () => {
    const ctx = makeCtx({ policy: POLICY });
    const out = await resolveModelForRun(ctx, { task: "anything" }, makeDeps({ flagEnabled: () => false }));
    expect(out).toBeNull();
  });

  it("returns null when the agent has NO model_routing policy (flag on)", async () => {
    const ctx = makeCtx({ policy: null });
    const out = await resolveModelForRun(ctx, { task: "x" }, makeDeps());
    expect(out).toBeNull();
  });

  it("deterministic floor: payload.stage present → Opus, classifier NOT called", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ policy: POLICY });
    const out = await resolveModelForRun(ctx, { stage: "build", target: {} }, deps);
    expect(out?.model).toBe(OPUS);
    expect(out?.picked_tier).toBe("opus");
    expect(out?.reason_code).toBe("floor_payload_stage");
    expect(out?.effective).toBe(true);
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("deterministic floor: keyword match → Opus, classifier NOT called", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "please IMPLEMENT a new endpoint" }, deps);
    expect(out?.model).toBe(OPUS);
    expect(out?.reason_code).toBe("floor_keyword");
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("classifier LOW → Sonnet (cost-first downgrade)", async () => {
    const ctx = makeCtx({ policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "what does this function do?" }, makeDeps());
    expect(out?.model).toBe(SONNET);
    expect(out?.picked_tier).toBe("sonnet");
    expect(out?.reason_code).toBe("classifier_low");
    expect(out?.classifier_cost_usd).toBeGreaterThan(0);
  });

  it("classifier HIGH → Opus", async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({
        level: "deep" as const,
        reason_code: "classifier_high" as const,
        classifier_ms: 30,
        cost_usd: 0.0004,
      })),
    });
    const ctx = makeCtx({ policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "design the whole multi-tenant sync seam" }, deps);
    expect(out?.model).toBe(OPUS);
    expect(out?.reason_code).toBe("classifier_high");
  });

  it("classifier ERROR/timeout → Opus (fail safe to quality)", async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    const ctx = makeCtx({ policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "question" }, deps);
    expect(out?.model).toBe(OPUS);
    expect(out?.reason_code).toBe("classifier_error_opus");
    expect(out?.classifier_ms).toBeNull();
  });

  it("classifier disabled → stays on base (policy_base)", async () => {
    const ctx = makeCtx({ policy: { ...POLICY, classifier: false } });
    const out = await resolveModelForRun(ctx, { current_message: "anything" }, makeDeps());
    expect(out?.model).toBe(SONNET);
    expect(out?.reason_code).toBe("policy_base");
  });

  describe("light_payload_stages + default_depth", () => {
    const CGO: ModelRoutingPolicy = {
      base: "sonnet",
      escalate_to: "opus",
      floor_payload_stage: false,
      floor_keywords: [],
      classifier: false,
      light_payload_stages: ["own_goals"],
      default_depth: "deep",
    };

    it("a listed stage runs on base, before any floor", async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ slug: "cgo", policy: { ...CGO, floor_payload_stage: true } });
      const out = await resolveModelForRun(ctx, { stage: "own_goals" }, deps);
      expect(out?.model).toBe(SONNET);
      expect(out?.reason_code).toBe("light_payload_stage");
      expect(deps.classify).not.toHaveBeenCalled();
    });

    it("an unlisted stage and a chat turn stay deep with default_depth deep", async () => {
      const ctx = makeCtx({ slug: "cgo", policy: CGO });
      const draft = await resolveModelForRun(ctx, { stage: "draft_strategy" }, makeDeps());
      expect(draft?.model).toBe(OPUS);
      expect(draft?.reason_code).toBe("policy_default_deep");
      const chat = await resolveModelForRun(ctx, { current_message: "what should we do next?" }, makeDeps());
      expect(chat?.model).toBe(OPUS);
    });

    it("the shipped cgo frontmatter has no routing: every run, goal reviews included, uses its own model (Opus 5.5)", async () => {
      const def = await loadGlobalAgentDefinition("cgo");
      const meta = def!.metadata_praxis as { model_routing?: ModelRoutingPolicy; model?: string };
      expect(meta.model_routing ?? null).toBeNull();
      expect(meta.model).toBe("claude-opus-5-5");
    });
  });

  it("SHADOW mode: records the pick but leaves the model unchanged (declared)", async () => {
    const deps = makeDeps({
      mode: () => "shadow",
      classify: vi.fn(async () => ({
        level: "light" as const,
        reason_code: "classifier_low" as const,
        classifier_ms: 10,
        cost_usd: 0.0002,
      })),
    });
    const ctx = makeCtx({ model: OPUS, policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "easy q" }, deps);
    expect(out?.effective).toBe(false);
    expect(out?.model).toBe(OPUS);
    expect(out?.picked_tier).toBe("sonnet");
    expect(out?.picked_model).toBe(SONNET);
    expect(deps.writeSticky).not.toHaveBeenCalled();
  });

  it("thread-sticky: reuses the stored model + skips the classifier", async () => {
    const deps = makeDeps({
      readThreadRouting: vi.fn(async () => ({ routed_model: OPUS, sdk_session_id: "sess-x" })),
    });
    const ctx = makeCtx({ policy: POLICY, thread_id: "thread-1" });
    const out = await resolveModelForRun(ctx, { current_message: "a simple follow-up" }, deps);
    expect(out?.model).toBe(OPUS);
    expect(out?.reason_code).toBe("thread_sticky");
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("thread-sticky: writes the resolved model on turn 1 (live)", async () => {
    const writeSticky = vi.fn(async () => {});
    const deps = makeDeps({
      readThreadRouting: vi.fn(async () => ({ routed_model: null, sdk_session_id: null })),
      writeSticky,
    });
    const ctx = makeCtx({ policy: POLICY, thread_id: "thread-2" });
    const out = await resolveModelForRun(ctx, { current_message: "what does X mean?" }, deps);
    expect(out?.model).toBe(SONNET);
    expect(writeSticky).toHaveBeenCalledWith("thread-2", SONNET);
  });

  it("existing-session guard (codex P1): pre-routing thread (session set, routed_model null) sticks to DECLARED, never mutates", async () => {
    const deps = makeDeps({
      readThreadRouting: vi.fn(async () => ({ routed_model: null, sdk_session_id: "old-opus-session" })),
    });
    const ctx = makeCtx({ model: OPUS, policy: POLICY, thread_id: "legacy-thread" });
    const out = await resolveModelForRun(ctx, { current_message: "easy follow-up" }, deps);
    expect(out?.model).toBe(OPUS);
    expect(out?.effective).toBe(false);
    expect(out?.reason_code).toBe("existing_session_declared");
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.writeSticky).not.toHaveBeenCalled();
  });

  it("chat path (codex P1): loads the real message body by user_message_id for the classifier", async () => {
    const readChatMessage = vi.fn(async () => "please implement the payout webhook");
    const deps = makeDeps({ readChatMessage });
    const ctx = makeCtx({ policy: POLICY, thread_id: "t-chat" });
    const out = await resolveModelForRun(ctx, { thread_id: "t-chat", user_message_id: "msg-123" }, deps);
    expect(readChatMessage).toHaveBeenCalledWith("msg-123");
    expect(out?.model).toBe(OPUS);
    expect(out?.reason_code).toBe("floor_keyword");
  });

  it("routingDecisionForPersist emits ONLY whitelist-safe keys (no user text)", async () => {
    const ctx = makeCtx({ policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "secret user content here" }, makeDeps());
    const persisted = routingDecisionForPersist(out!);
    expect(Object.keys(persisted).sort()).toEqual(
      ["classifier_ms", "picked_depth", "reason_code", "shadow", "tier"].sort(),
    );
    expect(JSON.stringify(persisted)).not.toContain("secret user content");
  });

  it("light classify pick → picked_depth 'light' (persisted alongside tier)", async () => {
    const ctx = makeCtx({ slug: "research", policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "what does X mean?" }, makeDeps());
    expect(out?.picked_tier).toBe("sonnet");
    expect(out?.picked_depth).toBe("light");
    expect(routingDecisionForPersist(out!).picked_depth).toBe("light");
  });

  it("escalated pick → picked_depth 'deep'", async () => {
    const deps = makeDeps({
      classify: vi.fn(async () => ({
        level: "deep" as const,
        reason_code: "classifier_high" as const,
        classifier_ms: 20,
        cost_usd: 0.0004,
      })),
    });
    const ctx = makeCtx({ slug: "research", policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "reconcile these conflicting sources" }, deps);
    expect(out?.picked_depth).toBe("deep");
  });

  it("depth:'deep' payload forces escalate on a fresh run (user_depth_override, classifier NOT called)", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ slug: "research", policy: POLICY, thread_id: "fresh-thread" });
    const out = await resolveModelForRun(
      ctx,
      { thread_id: "fresh-thread", user_message_id: "m1", depth: "deep" },
      deps,
    );
    expect(out?.model).toBe(OPUS);
    expect(out?.picked_tier).toBe("opus");
    expect(out?.picked_depth).toBe("deep");
    expect(out?.reason_code).toBe("user_depth_override");
    expect(out?.effective).toBe(true);
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.writeSticky).toHaveBeenCalledWith("fresh-thread", OPUS);
  });

  it("depth:'deep' does NOT re-route an already-sticky thread (SDK-resume safety — thread-sticky wins)", async () => {
    const deps = makeDeps({
      readThreadRouting: vi.fn(async () => ({ routed_model: SONNET, sdk_session_id: "sess-1" })),
    });
    const ctx = makeCtx({ slug: "research", policy: POLICY, thread_id: "routed-thread" });
    const out = await resolveModelForRun(
      ctx,
      { thread_id: "routed-thread", user_message_id: "m2", depth: "deep" },
      deps,
    );
    expect(out?.model).toBe(SONNET);
    expect(out?.reason_code).toBe("thread_sticky");
  });

  it("no depth param → normal routing (override inert)", async () => {
    const ctx = makeCtx({ slug: "research", policy: POLICY });
    const out = await resolveModelForRun(ctx, { current_message: "quick lookup" }, makeDeps());
    expect(out?.reason_code).not.toBe("user_depth_override");
  });

  it("fresh run + NL 'go deep' text → escalate/deep (user_depth_nl_override, classifier NOT called)", async () => {
    const deps = makeDeps({ readChatMessage: vi.fn(async () => "please go deep on this") });
    const ctx = makeCtx({ slug: "research", policy: POLICY, thread_id: "fresh-nl-thread" });
    const out = await resolveModelForRun(
      ctx,
      { thread_id: "fresh-nl-thread", user_message_id: "m-nl" },
      deps,
    );
    expect(out?.model).toBe(OPUS);
    expect(out?.picked_tier).toBe("opus");
    expect(out?.picked_depth).toBe("deep");
    expect(out?.reason_code).toBe("user_depth_nl_override");
    expect(out?.effective).toBe(true);
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.writeSticky).toHaveBeenCalledWith("fresh-nl-thread", OPUS);
  });

  it("STICKY-SAFETY: sticky thread + deep NL text → thread_sticky (NL override does NOT fire, model unchanged)", async () => {
    const deps = makeDeps({
      readThreadRouting: vi.fn(async () => ({ routed_model: SONNET, sdk_session_id: "sess-nl" })),
      readChatMessage: vi.fn(async () => "actually go deeper and be thorough"),
    });
    const ctx = makeCtx({ slug: "research", policy: POLICY, thread_id: "routed-nl-thread" });
    const out = await resolveModelForRun(
      ctx,
      { thread_id: "routed-nl-thread", user_message_id: "m-nl2" },
      deps,
    );
    expect(out?.model).toBe(SONNET);
    expect(out?.reason_code).toBe("thread_sticky");
    expect(out?.reason_code).not.toBe("user_depth_nl_override");
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("normal text → classifier path unchanged (NL override inert)", async () => {
    const deps = makeDeps({ readChatMessage: vi.fn(async () => "what does this function do?") });
    const ctx = makeCtx({ slug: "research", policy: POLICY, thread_id: "t-normal" });
    const out = await resolveModelForRun(
      ctx,
      { thread_id: "t-normal", user_message_id: "m-normal" },
      deps,
    );
    expect(out?.model).toBe(SONNET);
    expect(out?.reason_code).toBe("classifier_low");
    expect(out?.reason_code).not.toBe("user_depth_nl_override");
    expect(deps.classify).toHaveBeenCalled();
  });

  it("no policy + deep NL text → null (router does not apply)", async () => {
    const deps = makeDeps({ readChatMessage: vi.fn(async () => "go deep on this") });
    const ctx = makeCtx({ slug: "research", policy: null, thread_id: "t-nopolicy" });
    const out = await resolveModelForRun(
      ctx,
      { thread_id: "t-nopolicy", user_message_id: "m-np" },
      deps,
    );
    expect(out).toBeNull();
  });
});

describe("model-router backward-compat (whole live fleet)", () => {
  const slugs = listGlobalAgentSlugs();

  it("flag OFF → every agent returns null (declared model unchanged)", async () => {
    const deps = makeDeps({ flagEnabled: () => false });
    for (const slug of slugs) {
      const def = loadGlobalAgentDefinition(slug);
      if (!def) continue;
      const ctx = { agent: def, thread_id: undefined } as unknown as AgentContext;
      const out = await resolveModelForRun(ctx, { current_message: "x" }, deps);
      expect(out, `agent ${slug} must be null when flag off`).toBeNull();
    }
  });

  it("flag ON → only agents WITH a model_routing policy route; the rest return null", async () => {
    delete process.env.OPERATOR_TIER3_OPUS_ENABLED;
    delete process.env.PERFMKT_WEEKLY_OPUS_ENABLED;
    const deps = makeDeps();
    const routed: string[] = [];
    for (const slug of slugs) {
      const def = loadGlobalAgentDefinition(slug);
      if (!def) continue;
      const ctx = { agent: def, thread_id: undefined } as unknown as AgentContext;
      const out = await resolveModelForRun(ctx, { current_message: "what is x?" }, deps);
      const hasPolicy = !!(def.metadata_praxis as { model_routing?: unknown }).model_routing;
      const evalGated = slug === "operator" || slug === "performance-marketer";
      if (hasPolicy && !evalGated) {
        expect(out, `agent ${slug} has a policy → must route`).not.toBeNull();
        routed.push(slug);
      } else {
        expect(out, `agent ${slug} routes null (no policy, or eval-gated OFF)`).toBeNull();
      }
    }
    expect(routed.sort()).toEqual([
      "advisor",
      "browser-operator",
      "chief-of-staff",
      "content-design",
      "dispute-response",
      "engineer",
      "fundraising",
      "pm",
      "qa",
      "research",
      "support-lead",
    ]);
  });

  it("operator routes ON the global ON path ONLY when OPERATOR_TIER3_OPUS_ENABLED=1", async () => {
    const def = loadGlobalAgentDefinition("operator");
    expect(def, "operator def must load").toBeTruthy();
    const ctx = { agent: def!, thread_id: undefined } as unknown as AgentContext;
    const deps = makeDeps();
    delete process.env.OPERATOR_TIER3_OPUS_ENABLED;
    expect(await resolveModelForRun(ctx, { current_message: "x?" }, deps)).toBeNull();
    process.env.OPERATOR_TIER3_OPUS_ENABLED = "1";
    const on = await resolveModelForRun(ctx, { current_message: "x?" }, deps);
    expect(on, "operator routes when its own flag is set").not.toBeNull();
    delete process.env.OPERATOR_TIER3_OPUS_ENABLED;
  });
});

describe("model-router behavior-preserving guard (existing routed agents)", () => {
  const LIVE_ROUTED = ["advisor", "engineer", "fundraising", "research"];
  const EVAL_GATED = ["operator", "performance-marketer"];

  function realCtx(slug: string, thread_id?: string): AgentContext {
    const def = loadGlobalAgentDefinition(slug);
    expect(def, `agent ${slug} must load`).toBeTruthy();
    return { agent: def!, thread_id } as unknown as AgentContext;
  }

  afterEach(() => {
    delete process.env.OPERATOR_TIER3_OPUS_ENABLED;
    delete process.env.PERFMKT_WEEKLY_OPUS_ENABLED;
  });

  for (const slug of LIVE_ROUTED) {
    it(`${slug}: light pick → SONNET, deep pick → OPUS (unchanged)`, async () => {
      const ctxLight = realCtx(slug);
      const light = await resolveModelForRun(ctxLight, { current_message: "a quick simple question" }, makeDeps());
      expect(light?.model, `${slug} light pick model`).toBe(SONNET);
      expect(light?.picked_tier).toBe("sonnet");
      expect(light?.picked_depth).toBe("light");

      const deepDeps = makeDeps({
        classify: vi.fn(async () => ({
          level: "deep" as const,
          reason_code: "classifier_high" as const,
          classifier_ms: 5,
          cost_usd: 0.0004,
        })),
      });
      const deep = await resolveModelForRun(realCtx(slug), { current_message: "deep synthesis" }, deepDeps);
      expect(deep?.model, `${slug} deep pick model`).toBe(OPUS);
      expect(deep?.picked_tier).toBe("opus");
      expect(deep?.picked_depth).toBe("deep");
    });

    it(`${slug}: thread-sticky reuses the stored model unchanged (SONNET & OPUS)`, async () => {
      const stickyS = makeDeps({
        readThreadRouting: vi.fn(async () => ({ routed_model: SONNET, sdk_session_id: "s" })),
      });
      const outS = await resolveModelForRun(realCtx(slug, "th-s"), { current_message: "follow up" }, stickyS);
      expect(outS?.model, `${slug} sticky sonnet`).toBe(SONNET);
      expect(outS?.reason_code).toBe("thread_sticky");

      const stickyO = makeDeps({
        readThreadRouting: vi.fn(async () => ({ routed_model: OPUS, sdk_session_id: "s" })),
      });
      const outO = await resolveModelForRun(realCtx(slug, "th-o"), { current_message: "follow up" }, stickyO);
      expect(outO?.model, `${slug} sticky opus`).toBe(OPUS);
    });
  }

  it("engineer: floor_keyword ('implement') → OPUS, classifier skipped (unchanged)", async () => {
    const deps = makeDeps();
    const out = await resolveModelForRun(
      realCtx("engineer"),
      { current_message: "please implement the payout endpoint" },
      deps,
    );
    expect(out?.model).toBe(OPUS);
    expect(out?.reason_code).toBe("floor_keyword");
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("engineer: floor_payload_stage (build payload) → OPUS, classifier skipped (unchanged)", async () => {
    const deps = makeDeps();
    const out = await resolveModelForRun(realCtx("engineer"), { stage: "build", target: {} }, deps);
    expect(out?.model).toBe(OPUS);
    expect(out?.reason_code).toBe("floor_payload_stage");
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("eval-gated operator/perfmkt: when their gate is ON, base/escalate resolve unchanged (SONNET/OPUS)", async () => {
    process.env.OPERATOR_TIER3_OPUS_ENABLED = "1";
    process.env.PERFMKT_WEEKLY_OPUS_ENABLED = "1";
    for (const slug of EVAL_GATED) {
      const light = await resolveModelForRun(realCtx(slug), { current_message: "simple q" }, makeDeps());
      expect(light?.model, `${slug} enabled light`).toBe(SONNET);
      const deepDeps = makeDeps({
        classify: vi.fn(async () => ({
          level: "deep" as const,
          reason_code: "classifier_high" as const,
          classifier_ms: 5,
          cost_usd: 0.0004,
        })),
      });
      if (slug === "operator") {
        const deep = await resolveModelForRun(realCtx(slug), { current_message: "multi-surface synthesis" }, deepDeps);
        expect(deep?.model, "operator deep").toBe(OPUS);
      } else {
        const ctxCron = { agent: loadGlobalAgentDefinition(slug)!, thread_id: undefined, trigger: "cron" } as unknown as AgentContext;
        const cron = await resolveModelForRun(ctxCron, {}, makeDeps());
        expect(cron?.model, "perfmkt cron floor").toBe(OPUS);
        expect(cron?.reason_code).toBe("floor_perfmkt_weekly_digest");
      }
    }
  });
});

describe("defaultRouterDeps env defaults (ON + LIVE by default, 2026-06-04 flip)", () => {
  const orig = {
    enabled: process.env.MODEL_ROUTING_ENABLED,
    mode: process.env.MODEL_ROUTING_MODE,
  };
  afterEach(() => {
    if (orig.enabled === undefined) delete process.env.MODEL_ROUTING_ENABLED;
    else process.env.MODEL_ROUTING_ENABLED = orig.enabled;
    if (orig.mode === undefined) delete process.env.MODEL_ROUTING_MODE;
    else process.env.MODEL_ROUTING_MODE = orig.mode;
  });

  it("enabled by default when the env var is unset", async () => {
    delete process.env.MODEL_ROUTING_ENABLED;
    expect(await defaultRouterDeps.flagEnabled()).toBe(true);
  });

  it("kill switch: MODEL_ROUTING_ENABLED=0 disables it", async () => {
    process.env.MODEL_ROUTING_ENABLED = "0";
    expect(await defaultRouterDeps.flagEnabled()).toBe(false);
  });

  it("live by default when the mode env var is unset", async () => {
    delete process.env.MODEL_ROUTING_MODE;
    expect(await defaultRouterDeps.mode()).toBe("live");
  });

  it("dry-run: MODEL_ROUTING_MODE=shadow forces shadow", async () => {
    process.env.MODEL_ROUTING_MODE = "shadow";
    expect(await defaultRouterDeps.mode()).toBe("shadow");
  });
});

const OPERATOR_POLICY: ModelRoutingPolicy = {
  base: "sonnet",
  escalate_to: "opus",
  floor_payload_stage: false,
  floor_keywords: [],
  classifier: true,
};

describe("operator tier-3 -> Opus routing (P1-3, eval-gated)", () => {
  afterEach(() => {
    delete process.env.OPERATOR_TIER3_OPUS_ENABLED;
  });

  it("flag OFF (default): router NO-OPS for operator (null) -> declared Sonnet", async () => {
    delete process.env.OPERATOR_TIER3_OPUS_ENABLED;
    const ctx = makeCtx({ slug: "operator", model: SONNET, policy: OPERATOR_POLICY, thread_id: "th-1" });
    const deps = makeDeps({
      readPriorClassifyTier: vi.fn(async () => "tier3" as const),
    });
    const out = await resolveModelForRun(ctx, { current_message: "synthesize everything" }, deps);
    expect(out).toBeNull();
    expect(deps.readPriorClassifyTier).not.toHaveBeenCalled();
  });

  it("flag ON + prior tier3: deterministic Opus floor (floor_operator_tier3)", async () => {
    process.env.OPERATOR_TIER3_OPUS_ENABLED = "1";
    const ctx = makeCtx({ slug: "operator", model: SONNET, policy: OPERATOR_POLICY, thread_id: "th-2" });
    const deps = makeDeps({
      readPriorClassifyTier: vi.fn(async () => "tier3" as const),
    });
    const out = await resolveModelForRun(ctx, { current_message: "multi-surface synthesis" }, deps);
    expect(out?.picked_model).toBe(OPUS);
    expect(out?.reason_code).toBe("floor_operator_tier3");
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("flag ON + prior tier1/2: stays Sonnet via classifier-low (no tier-3 floor)", async () => {
    process.env.OPERATOR_TIER3_OPUS_ENABLED = "1";
    const ctx = makeCtx({ slug: "operator", model: SONNET, policy: OPERATOR_POLICY, thread_id: "th-3" });
    const deps = makeDeps({
      readPriorClassifyTier: vi.fn(async () => "tier2" as const),
    });
    const out = await resolveModelForRun(ctx, { current_message: "what's our booking count?" }, deps);
    expect(out?.picked_model).toBe(SONNET);
    expect(out?.reason_code).not.toBe("floor_operator_tier3");
  });

  it("flag ON + turn 1 (no prior plan): falls through to classifier (HIGH -> Opus)", async () => {
    process.env.OPERATOR_TIER3_OPUS_ENABLED = "1";
    const ctx = makeCtx({ slug: "operator", model: SONNET, policy: OPERATOR_POLICY, thread_id: "th-4" });
    const classifyHigh = vi.fn(
      async (_s: string, _t: string): Promise<ClassifyResult> => ({
        level: "deep",
        reason_code: "classifier_high",
        classifier_ms: 9,
        cost_usd: 0.0002,
      }),
    );
    const deps = makeDeps({
      readPriorClassifyTier: vi.fn(async () => null),
      classify: classifyHigh,
    });
    const out = await resolveModelForRun(ctx, { current_message: "design the whole growth strategy" }, deps);
    expect(out?.picked_model).toBe(OPUS);
    expect(out?.reason_code).toBe("classifier_high");
  });
});

const PERFMKT_POLICY: ModelRoutingPolicy = {
  base: "sonnet",
  escalate_to: "opus",
  floor_payload_stage: false,
  floor_keywords: [],
  classifier: false,
};

describe("performance-marketer weekly-digest -> Opus pin (P2-8, eval-gated)", () => {
  afterEach(() => {
    delete process.env.PERFMKT_WEEKLY_OPUS_ENABLED;
  });

  it("flag OFF (default): router NO-OPS for perfmkt even on a cron run -> declared Sonnet", async () => {
    delete process.env.PERFMKT_WEEKLY_OPUS_ENABLED;
    const ctx = makeCtx({ slug: "performance-marketer", model: SONNET, policy: PERFMKT_POLICY, trigger: "cron" });
    const out = await resolveModelForRun(ctx, { stage: undefined }, makeDeps());
    expect(out).toBeNull();
  });

  it("flag ON + cron (weekly-digest): deterministic Opus floor (floor_perfmkt_weekly_digest)", async () => {
    process.env.PERFMKT_WEEKLY_OPUS_ENABLED = "1";
    const ctx = makeCtx({ slug: "performance-marketer", model: SONNET, policy: PERFMKT_POLICY, trigger: "cron" });
    const deps = makeDeps();
    const out = await resolveModelForRun(ctx, {}, deps);
    expect(out?.picked_model).toBe(OPUS);
    expect(out?.reason_code).toBe("floor_perfmkt_weekly_digest");
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it("flag ON + chat trigger: stays Sonnet (classifier off -> policy_base), NOT the weekly floor", async () => {
    process.env.PERFMKT_WEEKLY_OPUS_ENABLED = "1";
    const ctx = makeCtx({ slug: "performance-marketer", model: SONNET, policy: PERFMKT_POLICY, trigger: "chat" });
    const out = await resolveModelForRun(ctx, { current_message: "did the pause help?" }, makeDeps());
    expect(out?.picked_model).toBe(SONNET);
    expect(out?.reason_code).not.toBe("floor_perfmkt_weekly_digest");
  });

  it("flag ON + manual trigger: stays Sonnet (manual digest is NOT the weekly cron pin)", async () => {
    process.env.PERFMKT_WEEKLY_OPUS_ENABLED = "1";
    const ctx = makeCtx({ slug: "performance-marketer", model: SONNET, policy: PERFMKT_POLICY, trigger: "manual" });
    const out = await resolveModelForRun(ctx, {}, makeDeps());
    expect(out?.picked_model).toBe(SONNET);
    expect(out?.reason_code).not.toBe("floor_perfmkt_weekly_digest");
  });
});

describe("engineer cost v2 routing (real engineer policy)", () => {
  const OLD_IDS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-sonnet-5"];
  function engCtx(thread_id?: string): AgentContext {
    const def = loadGlobalAgentDefinition("engineer");
    return { agent: structuredClone(def!), thread_id } as unknown as AgentContext;
  }
  const deep = () =>
    vi.fn(async () => ({
      level: "deep" as const,
      reason_code: "classifier_high" as const,
      classifier_ms: 5,
      cost_usd: 0.0004,
    }));

  it("ON: light → Sonnet 5.5, deep → Opus 5.5, classifier gets the v2 prompt key", async () => {
    const lightDeps = makeDeps({ costV2Enabled: () => true });
    const light = await resolveModelForRun(engCtx(), { current_message: "change the banner copy" }, lightDeps);
    expect(light?.model).toBe(SONNET);
    expect(light?.picked_tier).toBe("sonnet");
    expect(light?.picked_depth).toBe("light");
    expect(lightDeps.classify).toHaveBeenCalledWith("engineer:v2", "change the banner copy");

    const d = await resolveModelForRun(
      engCtx(),
      { current_message: "rework the job queue" },
      makeDeps({ costV2Enabled: () => true, classify: deep() }),
    );
    expect(d?.model).toBe(OPUS);
    expect(d?.picked_tier).toBe("opus");
  });

  it("ON: loose verbs no longer floor; high-risk words still do", async () => {
    const deps = makeDeps({ costV2Enabled: () => true });
    const fix = await resolveModelForRun(engCtx(), { current_message: "fix the typo in the footer" }, deps);
    expect(fix?.reason_code).toBe("classifier_low");
    expect(fix?.model).toBe(SONNET);
    for (const text of ["update the Stripe webhook", "add a migration for users", "rotate the secret"]) {
      const out = await resolveModelForRun(engCtx(), { current_message: text }, makeDeps({ costV2Enabled: () => true }));
      expect(out?.reason_code, text).toBe("floor_keyword");
      expect(out?.model, text).toBe(OPUS);
    }
    const stage = await resolveModelForRun(
      engCtx(),
      { stage: "scaffold" },
      makeDeps({ costV2Enabled: () => true, productBuildLightEnabled: async () => false }),
    );
    expect(stage?.reason_code).toBe("floor_payload_stage");
    expect(stage?.model).toBe(OPUS);
  });

  it("ON: classifier error still fails safe to deep (Opus 5.5)", async () => {
    const out = await resolveModelForRun(
      engCtx(),
      { current_message: "something" },
      makeDeps({
        costV2Enabled: () => true,
        classify: vi.fn(async () => {
          throw new Error("timeout");
        }),
      }),
    );
    expect(out?.reason_code).toBe("classifier_error_opus");
    expect(out?.model).toBe(OPUS);
  });

  it("OFF: the pre-v2 routing (old floors, old prompt key)", async () => {
    const deps = makeDeps({ costV2Enabled: () => false });
    const fix = await resolveModelForRun(engCtx(), { current_message: "fix the typo in the footer" }, deps);
    expect(fix?.reason_code).toBe("floor_keyword");
    expect(fix?.model).toBe(OPUS);
    const q = await resolveModelForRun(engCtx(), { current_message: "what does this file do?" }, deps);
    expect(q?.model).toBe(SONNET);
    expect(deps.classify).toHaveBeenCalledWith("engineer", "what does this file do?");
  });

  it("thread-sticky keeps the exact stored model (old and new ids), switch ON or OFF", async () => {
    for (const costV2 of [true, false]) {
      for (const stored of [OPUS, SONNET, ...OLD_IDS]) {
        const out = await resolveModelForRun(
          engCtx("th"),
          { current_message: "follow up" },
          makeDeps({
            costV2Enabled: () => costV2,
            readThreadRouting: vi.fn(async () => ({ routed_model: stored, sdk_session_id: "s" })),
          }),
        );
        expect(out?.model, stored).toBe(stored);
        expect(out?.reason_code).toBe("thread_sticky");
      }
    }
  });
});
