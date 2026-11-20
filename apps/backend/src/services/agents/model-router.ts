
import type { AgentContext } from "./types";
import { MODELS } from "@/services/llm/models";
import { callModel } from "@/services/llm/call-model";
import { estimateCostUsd } from "@/services/anthropic";
import { serviceClient } from "@/services/supabase";
import { getAppSetting, getBoolSettingStrictResolved } from "@/services/settings";
import { pickProvider } from "./engine/pick-engine";
import { resolveDepthModel, type DepthLevel } from "./engine/depth-resolver";
import { loadEngineerCostV2Config, productBuildLane, type ProductBuildLane } from "./engineer-cost-v2";

export type RoutingTier = "opus" | "sonnet" | "haiku";

export type ModelRoutingPolicy = {
  base: RoutingTier;
  escalate_to: RoutingTier;
  floor_payload_stage: boolean;
  floor_keywords: string[];
  classifier: boolean;
  light_payload_stages?: string[];
  default_depth?: "light" | "deep";
  light_model?: string;
  deep_model?: string;
  floor_keywords_v1?: string[];
};

export type RoutingReasonCode =
  | "thread_sticky"
  | "existing_session_declared"
  | "floor_payload_stage"
  | "floor_keyword"
  | "floor_operator_tier3"
  | "floor_perfmkt_weekly_digest"
  | "user_depth_override"
  | "user_depth_nl_override"
  | "classifier_low"
  | "classifier_high"
  | "classifier_uncertain_opus"
  | "classifier_error_opus"
  | "policy_base"
  | "light_payload_stage"
  | "policy_default_deep"
  | "product_build_small_edit"
  | "product_build_scaffold_light";

export type PickedDepth = DepthLevel;

export type RoutingDecision = {
  model: string;
  picked_tier: RoutingTier;
  picked_depth: PickedDepth;
  picked_model: string;
  reason_code: RoutingReasonCode;
  classifier_ms: number | null;
  classifier_cost_usd: number;
  effective: boolean;
};

export function routingDecisionForPersist(d: RoutingDecision): {
  tier: RoutingTier;
  picked_depth: PickedDepth;
  reason_code: RoutingReasonCode;
  classifier_ms: number | null;
  shadow: boolean;
} {
  return {
    tier: d.picked_tier,
    picked_depth: d.picked_depth,
    reason_code: d.reason_code,
    classifier_ms: d.classifier_ms,
    shadow: !d.effective,
  };
}

const HAIKU_MODEL = MODELS.anthropic.haiku;
const CLASSIFIER_TIMEOUT_MS = 2000;
const CLASSIFIER_MAX_TOKENS = 64;

function tierForModel(model: string): RoutingTier {
  if (/^claude-sonnet-/.test(model)) return "sonnet";
  if (/^claude-haiku-/.test(model)) return "haiku";
  return "opus";
}

function anthropicDepthForModel(model: string): DepthLevel {
  return tierForModel(model) === "opus" ? "deep" : "light";
}

function chatUserMessageId(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const id = (payload as Record<string, unknown>).user_message_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function extractInlineRequestText(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 4000);
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const k of ["current_message", "task", "objective", "message", "prompt", "input"]) {
      if (typeof p[k] === "string" && (p[k] as string).length > 0) {
        return (p[k] as string).slice(0, 4000);
      }
    }
    try {
      return JSON.stringify(p).slice(0, 4000);
    } catch {
      return "";
    }
  }
  return "";
}

function payloadDepthDeep(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as Record<string, unknown>).depth === "deep"
  );
}

const DEEP_INTENT_PHRASES: readonly string[] = [
  "go deep",
  "go deeper",
  "dig deep",
  "deep dive",
  "deep-dive",
  "be thorough",
  "thorough analysis",
  "in depth",
  "in-depth",
  "full analysis",
  "comprehensive analysis",
  "take your time",
];

function textRequestsDeep(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return DEEP_INTENT_PHRASES.some((p) => lower.includes(p));
}

function payloadStage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const s = (payload as Record<string, unknown>).stage;
  return typeof s === "string" && s.length > 0 ? s : null;
}

function payloadHasStage(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).stage === "string" &&
    ((payload as Record<string, unknown>).stage as string).length > 0
  );
}

function matchesFloorKeyword(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

const DEFAULT_CLASSIFIER_PROMPT =
  "You are a routing classifier. Decide whether the request below needs a top-tier " +
  "reasoning model (HIGH) or can be handled well by a fast mid-tier model (LOW). " +
  "HIGH = deep multi-step reasoning, novel synthesis, multi-file/complex code, or high-stakes judgment. " +
  "LOW = a simple question, lookup, summary, small/mechanical change, or routine answer. " +
  'When in doubt, answer HIGH. Reply with ONLY this JSON: {"complexity":"low"} or {"complexity":"high"}.';

const CLASSIFIER_PROMPTS: Record<string, string> = {
  engineer:
    "You are a routing classifier for a coding agent. Decide if the request needs a top-tier " +
    "model (HIGH) or a fast mid-tier model (LOW). HIGH = implementing/refactoring/debugging code, " +
    "multi-file changes, architecture, or anything that will edit a repo. LOW = a simple code/repo " +
    'QUESTION, reading/explaining existing code, or a trivial one-line lookup with no edit. When in ' +
    'doubt, answer HIGH. Reply with ONLY: {"complexity":"low"} or {"complexity":"high"}.',
  "engineer:v2":
    "You are a routing classifier for a coding agent. Decide if the request needs a top-tier " +
    "model (HIGH) or a fast mid-tier model (LOW). LOW = a question about code, reading/explaining " +
    "code, or a 1-3 file mechanical change: UI, copy/text, a condition, a constant, a style or " +
    "config value. HIGH = anything touching auth, login, permissions, money/payments/Stripe/billing, " +
    "database migrations or schema, security or secrets, a change spanning several services, the " +
    "build/deploy pipeline, a new feature across many files, or debugging an unclear failure. When in " +
    'doubt, answer HIGH. Reply with ONLY: {"complexity":"low"} or {"complexity":"high"}.',
  research:
    "You are a routing classifier for a research agent. HIGH = multi-source synthesis, comparing/" +
    "reconciling conflicting sources, or a nuanced analytical report. LOW = a single-fact lookup, a " +
    'definition, or a quick summary of one source. When in doubt, answer HIGH. Reply with ONLY: ' +
    '{"complexity":"low"} or {"complexity":"high"}.',
  advisor:
    "You are a routing classifier for a strategy advisor. HIGH = novel strategic synthesis, weighing " +
    "trade-offs, or a high-stakes judgment call. LOW = a routine/factual question or restating known " +
    'guidance. When in doubt, answer HIGH. Reply with ONLY: {"complexity":"low"} or {"complexity":"high"}.',
  "support-lead":
    "You are a routing classifier for a customer-support lead. HIGH = a multi-part or ambiguous " +
    "customer issue, a policy/trust-&-safety judgment, a chargeback/dispute triage, or reconciling " +
    "conflicting account signals. LOW = a simple FAQ, an order/status lookup, or a routine templated " +
    'reply. When in doubt, answer HIGH. Reply with ONLY: {"complexity":"low"} or {"complexity":"high"}.',
  pm:
    "You are a routing classifier for a product manager. HIGH = prioritization/roadmap synthesis, a " +
    "spec with real trade-offs, or reconciling multiple signal sources into a backlog. LOW = a simple " +
    'status question, a definition, or restating a known decision. When in doubt, answer HIGH. Reply ' +
    'with ONLY: {"complexity":"low"} or {"complexity":"high"}.',
  qa:
    "You are a routing classifier for a QA agent. HIGH = designing a multi-flow test plan, root-causing " +
    "a failure across surfaces, or adversarial edge-case reasoning. LOW = a single check, a status " +
    'question, or a trivial one-step verification. When in doubt, answer HIGH. Reply with ONLY: ' +
    '{"complexity":"low"} or {"complexity":"high"}.',
  "dispute-response":
    "You are a routing classifier for a payment-dispute agent. HIGH = assembling compelling chargeback " +
    "evidence, a multi-factor dispute, or a nuanced policy/liability judgment. LOW = a simple status " +
    'lookup or restating a known dispute fact. When in doubt, answer HIGH. Reply with ONLY: ' +
    '{"complexity":"low"} or {"complexity":"high"}.',
};

export type ClassifyResult = {
  level: DepthLevel;
  reason_code: Extract<
    RoutingReasonCode,
    "classifier_low" | "classifier_high" | "classifier_uncertain_opus"
  >;
  classifier_ms: number;
  cost_usd: number;
};

export async function classifyComplexity(
  agentSlug: string,
  requestText: string,
): Promise<ClassifyResult> {
  const startedMs = performance.now();
  const system = CLASSIFIER_PROMPTS[agentSlug] ?? DEFAULT_CLASSIFIER_PROMPT;
  const res = await callModel({
    provider: "anthropic",
    model: HAIKU_MODEL,
    system,
    messages: [{ role: "user", content: requestText || "(empty request)" }],
    max_tokens: CLASSIFIER_MAX_TOKENS,
    temperature: 0,
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
  });
  const classifier_ms = Math.round(performance.now() - startedMs);
  const cost_usd = estimateCostUsd(HAIKU_MODEL, {
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cache_creation_input_tokens: res.usage.cache_creation_input_tokens,
    cache_read_input_tokens: res.usage.cache_read_input_tokens,
  });

  const text = res.text.toLowerCase();
  const low = /"?complexity"?\s*:?\s*"?low"?/.test(text) || /\blow\b/.test(text);
  const high = /"?complexity"?\s*:?\s*"?high"?/.test(text) || /\bhigh\b/.test(text);

  if (low && !high) {
    return { level: "light", reason_code: "classifier_low", classifier_ms, cost_usd };
  }
  if (high && !low) {
    return { level: "deep", reason_code: "classifier_high", classifier_ms, cost_usd };
  }
  return { level: "deep", reason_code: "classifier_uncertain_opus", classifier_ms, cost_usd };
}

export type ThreadRouting = {
  routed_model: string | null;
  sdk_session_id: string | null;
};

async function readThreadRouting(threadId: string): Promise<ThreadRouting> {
  try {
    const { data } = await serviceClient()
      .from("agent_threads")
      .select("routed_model, sdk_session_id")
      .eq("id", threadId)
      .maybeSingle();
    const row = data as { routed_model?: string | null; sdk_session_id?: string | null } | null;
    return {
      routed_model: typeof row?.routed_model === "string" && row.routed_model.length > 0 ? row.routed_model : null,
      sdk_session_id: typeof row?.sdk_session_id === "string" && row.sdk_session_id.length > 0 ? row.sdk_session_id : null,
    };
  } catch {
    return { routed_model: null, sdk_session_id: null };
  }
}

async function writeStickyModel(threadId: string, model: string): Promise<void> {
  try {
    await serviceClient()
      .from("agent_threads")
      .update({ routed_model: model })
      .eq("id", threadId);
  } catch {
  }
}

async function readChatMessage(userMessageId: string): Promise<string> {
  try {
    const { data } = await serviceClient()
      .from("agent_thread_messages")
      .select("body")
      .eq("id", userMessageId)
      .maybeSingle();
    const body = (data as { body?: string | null } | null)?.body;
    return typeof body === "string" ? body.slice(0, 4000) : "";
  } catch {
    return "";
  }
}

async function readPriorClassifyTier(
  threadId: string,
): Promise<"tier1" | "tier2" | "tier3" | null> {
  try {
    const { data } = await serviceClient()
      .from("thread_event")
      .select("body")
      .eq("thread_id", threadId)
      .eq("kind", "plan")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const tier = (data as { body?: { classify?: { tier?: unknown } } } | null)
      ?.body?.classify?.tier;
    if (tier === "tier1" || tier === "tier2" || tier === "tier3") return tier;
    return null;
  } catch {
    return null;
  }
}

export type RouterDeps = {
  flagEnabled: () => boolean | Promise<boolean>;
  mode: () => ("shadow" | "live") | Promise<"shadow" | "live">;
  classify: (agentSlug: string, requestText: string) => Promise<ClassifyResult>;
  readThreadRouting: (threadId: string) => Promise<ThreadRouting>;
  writeSticky: (threadId: string, model: string) => Promise<void>;
  readChatMessage: (userMessageId: string) => Promise<string>;
  readPriorClassifyTier: (threadId: string) => Promise<"tier1" | "tier2" | "tier3" | null>;
  costV2Enabled?: () => boolean | Promise<boolean>;
  productBuildLightEnabled?: (lane: ProductBuildLane, tenantId: string) => Promise<boolean>;
};

const PRODUCT_BUILD_LANE_SETTING = {
  small_edit: "product_build_small_edit_light_model",
  scaffold: "product_build_scaffold_light_model",
} as const;

const PRODUCT_BUILD_LANE_REASON: Record<ProductBuildLane, RoutingReasonCode> = {
  small_edit: "product_build_small_edit",
  scaffold: "product_build_scaffold_light",
};

async function productBuildLightOn(
  lane: ProductBuildLane,
  tenantId: string,
  read: (lane: ProductBuildLane, tenantId: string) => Promise<boolean>,
): Promise<boolean> {
  try {
    return (await read(lane, tenantId)) === true;
  } catch (e) {
    console.warn(
      `[model-router] product-build ${lane} setting read failed, keeping the build floor: ${(e as Error).message}`,
    );
    return false;
  }
}

export const defaultRouterDeps: RouterDeps = {
  flagEnabled: async () => {
    const v = await getAppSetting("model_routing_enabled");
    if (v !== undefined) return v === true;
    return process.env.MODEL_ROUTING_ENABLED !== "0";
  },
  mode: async () => {
    const v = await getAppSetting("model_routing_mode");
    const s = v !== undefined ? String(v) : process.env.MODEL_ROUTING_MODE;
    return s === "shadow" ? "shadow" : "live";
  },
  classify: classifyComplexity,
  readThreadRouting,
  writeSticky: writeStickyModel,
  readChatMessage,
  readPriorClassifyTier,
  costV2Enabled: async () => (await loadEngineerCostV2Config()).enabled,
  productBuildLightEnabled: (lane, tenantId) =>
    getBoolSettingStrictResolved(PRODUCT_BUILD_LANE_SETTING[lane], tenantId),
};

function policyHasCostV2(p: ModelRoutingPolicy): boolean {
  return p.light_model !== undefined || p.deep_model !== undefined || p.floor_keywords_v1 !== undefined;
}

function effectivePolicy(p: ModelRoutingPolicy, costV2: boolean): ModelRoutingPolicy {
  if (costV2) return p;
  return {
    ...p,
    light_model: undefined,
    deep_model: undefined,
    floor_keywords: p.floor_keywords_v1 ?? p.floor_keywords,
  };
}

function operatorTier3OpusEnabled(): boolean {
  return process.env.OPERATOR_TIER3_OPUS_ENABLED === "1";
}

function perfmktWeeklyOpusEnabled(): boolean {
  return process.env.PERFMKT_WEEKLY_OPUS_ENABLED === "1";
}

function readPolicy(ctx: AgentContext): ModelRoutingPolicy | null {
  const p = (ctx.agent.metadata_praxis as { model_routing?: ModelRoutingPolicy })
    .model_routing;
  if (!p) return null;
  if (ctx.agent.slug === "operator" && !operatorTier3OpusEnabled()) return null;
  if (ctx.agent.slug === "performance-marketer" && !perfmktWeeklyOpusEnabled()) {
    return null;
  }
  return p;
}

export async function resolveModelForRun(
  ctx: AgentContext,
  payload: unknown,
  deps: RouterDeps = defaultRouterDeps,
): Promise<RoutingDecision | null> {
  if (!(await deps.flagEnabled())) return null;
  const declaredPolicy = readPolicy(ctx);
  if (!declaredPolicy) return null;
  const costV2 = policyHasCostV2(declaredPolicy)
    ? await (deps.costV2Enabled ?? defaultRouterDeps.costV2Enabled!)()
    : false;
  const policy = effectivePolicy(declaredPolicy, costV2);
  const classifierKey =
    costV2 && CLASSIFIER_PROMPTS[`${ctx.agent.slug}:v2`] ? `${ctx.agent.slug}:v2` : ctx.agent.slug;

  const live = (await deps.mode()) === "live";
  const provider = pickProvider(ctx.agent.metadata_praxis);
  const agentBaseModel = policy.light_model ?? MODELS.anthropic[policy.base];
  const agentDeepModel = policy.deep_model;

  const declaredModel = ctx.agent.metadata_praxis.model;
  const finalize = (
    level: PickedDepth,
    reason_code: RoutingReasonCode,
    classifier_ms: number | null,
    classifier_cost_usd: number,
    stickyModel?: string,
  ): RoutingDecision => {
    const picked_model =
      stickyModel ?? resolveDepthModel(provider, level, agentBaseModel, agentDeepModel);
    return {
      model: live ? picked_model : declaredModel,
      picked_tier: tierForModel(picked_model),
      picked_depth: level,
      picked_model,
      reason_code,
      classifier_ms,
      classifier_cost_usd,
      effective: live,
    };
  };

  const threadId = ctx.thread_id;
  if (threadId) {
    const { routed_model, sdk_session_id } = await deps.readThreadRouting(threadId);
    if (routed_model) {
      return finalize(
        anthropicDepthForModel(routed_model),
        "thread_sticky",
        null,
        0,
        provider === "anthropic" ? routed_model : undefined,
      );
    }
    if (sdk_session_id) {
      return {
        model: declaredModel,
        picked_tier: tierForModel(declaredModel),
        picked_depth: anthropicDepthForModel(declaredModel),
        picked_model: declaredModel,
        reason_code: "existing_session_declared",
        classifier_ms: null,
        classifier_cost_usd: 0,
        effective: false,
      };
    }
  }

  if (payloadDepthDeep(payload)) {
    const d = finalize("deep", "user_depth_override", null, 0);
    if (threadId && live) await deps.writeSticky(threadId, d.picked_model);
    return d;
  }

  const userMessageId = chatUserMessageId(payload);
  const requestText = userMessageId
    ? await deps.readChatMessage(userMessageId)
    : extractInlineRequestText(payload);

  if (textRequestsDeep(requestText) && !payloadDepthDeep(payload)) {
    const d = finalize("deep", "user_depth_nl_override", null, 0);
    if (threadId && live) await deps.writeSticky(threadId, d.picked_model);
    return d;
  }

  const stage = payloadStage(payload);
  if (stage && (policy.light_payload_stages ?? []).includes(stage)) {
    return finalize("light", "light_payload_stage", null, 0);
  }

  if (policy.floor_payload_stage && payloadHasStage(payload)) {
    const lane = productBuildLane(payload);
    if (
      lane &&
      costV2 &&
      provider === "anthropic" &&
      (await productBuildLightOn(
        lane,
        ctx.tenant_id,
        deps.productBuildLightEnabled ?? defaultRouterDeps.productBuildLightEnabled!,
      ))
    ) {
      return finalize("light", PRODUCT_BUILD_LANE_REASON[lane], null, 0, MODELS.anthropic.sonnet);
    }
    const d = finalize("deep", "floor_payload_stage", null, 0);
    if (threadId && live) await deps.writeSticky(threadId, d.picked_model);
    return d;
  }
  if (matchesFloorKeyword(requestText, policy.floor_keywords)) {
    const d = finalize("deep", "floor_keyword", null, 0);
    if (threadId && live) await deps.writeSticky(threadId, d.picked_model);
    return d;
  }

  if (ctx.agent.slug === "operator" && threadId) {
    const priorTier = await deps.readPriorClassifyTier(threadId);
    if (priorTier === "tier3") {
      const d = finalize("deep", "floor_operator_tier3", null, 0);
      if (live) await deps.writeSticky(threadId, d.picked_model);
      return d;
    }
  }

  if (ctx.agent.slug === "performance-marketer" && ctx.trigger === "cron") {
    return finalize("deep", "floor_perfmkt_weekly_digest", null, 0);
  }

  let decision: RoutingDecision;
  if (policy.classifier) {
    try {
      const c = await deps.classify(classifierKey, requestText);
      decision = finalize(c.level, c.reason_code, c.classifier_ms, c.cost_usd);
    } catch {
      decision = finalize("deep", "classifier_error_opus", null, 0);
    }
  } else if (policy.default_depth === "deep") {
    decision = finalize("deep", "policy_default_deep", null, 0);
  } else {
    decision = finalize("light", "policy_base", null, 0);
  }

  if (threadId && live) await deps.writeSticky(threadId, decision.picked_model);
  return decision;
}
