
export const ASSISTANT_TRIGGER = "mcp";

export function isAssistantRun(trigger: string | null | undefined): boolean {
  return trigger === ASSISTANT_TRIGGER;
}

export function isAdDecisionClass(decision_class: string): boolean {
  return /^(perfmkt|[a-z]+_ads)\./.test(decision_class);
}

export const ASSISTANT_AD_CHANGE = "assistant_run_change";

export function assistantAdChangeNeedsPerson(trigger: string | null | undefined, decision_class: string): boolean {
  return isAssistantRun(trigger) && isAdDecisionClass(decision_class);
}

export const ASSISTANT_BLOCKED_MESSAGE =
  "Not available on runs started from an AI assistant: Zavi does not generate AI images, video or audio, or move money, from Claude or ChatGPT. Do it in the Zavi app instead.";

export const ASSISTANT_BUILD_BLOCKED_MESSAGE =
  "Building or editing the app is not available from an AI assistant, because a build adds AI-generated images. Start it in the Zavi app instead.";

export const ASSISTANT_BLOCKED_AGENTS: ReadonlySet<string> = new Set(["generated_video"]);

const BLOCKED_TOOLS: Readonly<Record<string, ReadonlySet<string> | "*">> = {
  report: new Set(["generate_image", "render_social_image"]),
  generated_video: "*",
  praxis: new Set(["render_video", "render_launch_video"]),
  higgsfield: new Set(["generate_video", "generate_image", "generate_audio"]),
  stripe: new Set(["create_payment", "remit_to_tenant"]),
};

const MEDIA_TOOL_RE =
  /(generate|create|make|render)_?(an?_)?(image|video|audio|speech|voice|music|song)|text_?to_?(image|video|speech|audio)|image_?to_?video|(^|_)tts(_|$)/;
const MONEY_TOOL_RE =
  /(create|send|initiate|execute|make|issue|capture)_?[a-z0-9_]{0,24}?(payment|payout|transfer|refund|charge)|(^|_)remit/;

export function assistantBlockedToolReason(server_id: string, tool_name: string): string | null {
  const blocked = BLOCKED_TOOLS[server_id];
  if (blocked === "*" || blocked?.has(tool_name)) return ASSISTANT_BLOCKED_MESSAGE;
  const name = tool_name.toLowerCase().replace(/-/g, "_");
  if (MEDIA_TOOL_RE.test(name) || MONEY_TOOL_RE.test(name)) return ASSISTANT_BLOCKED_MESSAGE;
  return null;
}

export function withoutAssistantAiImages(server_id: string, tool_name: string, args: unknown): unknown {
  if (server_id !== "report" || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const a = args as Record<string, unknown>;
  if (tool_name === "render_blog" && "image_concepts" in a) {
    const { image_concepts: _dropped, ...rest } = a;
    return rest;
  }
  if (tool_name === "render_pdf" && Array.isArray(a.sections)) {
    return {
      ...a,
      sections: a.sections.map((s) => {
        if (!s || typeof s !== "object" || !("image_concept" in s)) return s;
        const { image_concept: _dropped, ...rest } = s as Record<string, unknown>;
        return rest;
      }),
    };
  }
  return args;
}

const OUT_OF_CREDITS_FOR_ASSISTANT =
  "The workspace is out of credits for now, so this was not run and nothing was charged.";
const NOT_IN_PLAN_FOR_ASSISTANT =
  "This isn't included in the workspace's current Zavi plan, so it was not run.";
const COMMERCE_REFUSALS: Readonly<Record<string, string>> = {
  insufficient_credits: OUT_OF_CREDITS_FOR_ASSISTANT,
  out_of_credits: OUT_OF_CREDITS_FOR_ASSISTANT,
  insufficient_credits_for_build: OUT_OF_CREDITS_FOR_ASSISTANT,
  build_credits_exhausted: OUT_OF_CREDITS_FOR_ASSISTANT,
  plan_upgrade_required: NOT_IN_PLAN_FOR_ASSISTANT,
};
const COMMERCE_ERRORS: Readonly<Record<string, { code: string; message: string }>> = {
  InsufficientCreditsError: { code: "insufficient_credits", message: OUT_OF_CREDITS_FOR_ASSISTANT },
  BuildCreditsExhaustedError: { code: "build_credits_exhausted", message: OUT_OF_CREDITS_FOR_ASSISTANT },
  PlanUpgradeRequiredError: { code: "plan_upgrade_required", message: NOT_IN_PLAN_FOR_ASSISTANT },
  BudgetExceededError: {
    code: "budget_exceeded",
    message: "The workspace has reached its spending limit for today, so this was not run. It resets tomorrow.",
  },
};

export function assistantRefusalForError(e: unknown): { code: string; message: string } | null {
  const name = e instanceof Error ? e.name : "";
  return COMMERCE_ERRORS[name] ?? null;
}

const REFUSAL_CODE_KEYS = ["error", "code", "reason"] as const;
const KEPT_REFUSAL_FIELDS = ["status", "required_tier", "retryable"] as const;

export function withoutPurchasePrompts(content: string, isError: boolean): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return content;
  const obj = parsed as Record<string, unknown>;
  if (!isError && obj.status !== "refused") return content;
  const key = REFUSAL_CODE_KEYS.find((k) => typeof obj[k] === "string" && (obj[k] as string) in COMMERCE_REFUSALS);
  if (!key) return content;
  const code = obj[key] as string;
  const out: Record<string, unknown> = { [key]: code, message: COMMERCE_REFUSALS[code] };
  for (const f of KEPT_REFUSAL_FIELDS) {
    const v = obj[f];
    if (typeof v === "string" || typeof v === "boolean") out[f] = v;
  }
  return JSON.stringify(out);
}

export function assistantSafeRunError(error: string): string {
  if (/^blocked at execution: (plan_upgrade_required|not_in_plan)\b/.test(error)) return NOT_IN_PLAN_FOR_ASSISTANT;
  if (/^blocked at execution: staff_model_refused — daily \?model= test cap reached \(/.test(error)) {
    return "blocked at execution: staff_model_refused — the daily test-run limit is reached.";
  }
  const inner = error.replace(/^dispatch_inner: /, "");
  if (/^Agent "[^"]+" rejected: (out of credits — top up to keep running|no build credits remaining this period)$/.test(inner)) {
    return OUT_OF_CREDITS_FOR_ASSISTANT;
  }
  if (/^Agent "[^"]+" rejected: tenant daily budget cap \(\$[\d.]+\) reached$/.test(inner)) {
    return COMMERCE_ERRORS.BudgetExceededError.message;
  }
  return error;
}
