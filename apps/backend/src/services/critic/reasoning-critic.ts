
import {
  getAnthropic,
  estimateCostUsd,
  heliconePropertyHeaders,
} from "@/services/anthropic";
import {
  getOpenAi,
  estimateOpenAiCostUsd,
  OPENAI_CRITIC_MODEL,
} from "@/services/openai";

export type ReasoningLaneStatus =
  | { status: "ok" }
  | { status: "unavailable"; error: string; reason?: string }
  | { status: "skipped" };

export type ParsedReasoningCritic<F> =
  | {
      ok: true;
      verdict: "revise" | "ok";
      findings: F[];
      reversal_triggers_present?: boolean;
    }
  | { ok: false; error: string };

export interface ReasoningCriticConfig<F> {
  userMsg: string;
  systemPrompt: string;
  anthropicModel: string;
  maxTokens: number;
  openAiJsonSchema: Record<string, unknown>;
  openAiSchemaName: string;
  parseResult: (raw: string) => ParsedReasoningCritic<F>;
  tags: { tenantId: string; agentSlug: string; runId: string };
  signal: AbortSignal;
  findingCap: number;
  allowOpenAi?: boolean;
  deriveVerdict?: (okVerdicts: Array<"revise" | "ok">) => "revise" | "ok";
}

export interface ReasoningCriticResult<F> {
  verdict: "revise" | "ok";
  findings: Array<F & { reviewer: "anthropic" | "openai" }>;
  reversal_triggers_present?: boolean;
  lanes: { anthropic: ReasoningLaneStatus; openai: ReasoningLaneStatus };
  cost_usd: number;
}

type LaneOk<F> = {
  lane: "anthropic" | "openai";
  status: "ok";
  verdict: "revise" | "ok";
  findings: F[];
  reversal_triggers_present?: boolean;
  cost_usd: number;
};
type LaneUnavailable = {
  lane: "anthropic" | "openai";
  status: "unavailable";
  error: string;
};
type LaneSkipped = { lane: "openai"; status: "skipped" };

export function laneFailureReason(err: string | undefined): string {
  const e = (err ?? "").toLowerCase();
  if (!e) return "unknown";
  if (e.includes("malformed_json")) return "malformed_json";
  if (e.includes("schema_invalid")) return "schema_invalid";
  if (e.includes("abort") || e.includes("timeout") || e.includes("timed out")) return "timeout";
  if (e.includes("rate") || e.includes("429")) return "rate_limited";
  if (e.includes("overloaded") || e.includes("529")) return "overloaded";
  if (e.includes("auth") || e.includes("401") || e.includes("api key")) return "auth";
  if (e.startsWith("lane_threw")) return "lane_threw";
  return "provider_error";
}
type LaneResult<F> = LaneOk<F> | LaneUnavailable | LaneSkipped;

async function runAnthropicLane<F>(
  cfg: ReasoningCriticConfig<F>,
): Promise<LaneResult<F>> {
  try {
    const anthropic = getAnthropic();
    const resp = await anthropic.messages.create(
      {
        model: cfg.anthropicModel,
        max_tokens: cfg.maxTokens,
        system: cfg.systemPrompt,
        messages: [{ role: "user", content: cfg.userMsg }],
      },
      {
        signal: cfg.signal,
        headers: heliconePropertyHeaders({
          tenantId: cfg.tags.tenantId,
          agentSlug: cfg.tags.agentSlug,
          runId: cfg.tags.runId,
        }),
      },
    );
    const textBlock = resp.content.find((c) => c.type === "text");
    const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const parsed = cfg.parseResult(raw);
    if (!parsed.ok) {
      return { lane: "anthropic", status: "unavailable", error: parsed.error };
    }
    return {
      lane: "anthropic",
      status: "ok",
      verdict: parsed.verdict,
      findings: parsed.findings,
      reversal_triggers_present: parsed.reversal_triggers_present,
      cost_usd: estimateCostUsd(cfg.anthropicModel, {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
      }),
    };
  } catch (e) {
    return {
      lane: "anthropic",
      status: "unavailable",
      error: `anthropic_error: ${(e as Error).message}`,
    };
  }
}

async function runOpenAiLane<F>(
  cfg: ReasoningCriticConfig<F>,
): Promise<LaneResult<F>> {
  try {
    if (cfg.allowOpenAi === false) return { lane: "openai", status: "skipped" };
    const client = getOpenAi();
    if (!client) return { lane: "openai", status: "skipped" };
    const resp = await client.chat.completions.create(
      {
        model: OPENAI_CRITIC_MODEL,
        max_completion_tokens: cfg.maxTokens,
        messages: [
          { role: "developer", content: cfg.systemPrompt },
          { role: "user", content: cfg.userMsg },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: cfg.openAiSchemaName,
            strict: true,
            schema: cfg.openAiJsonSchema,
          },
        },
      },
      { signal: cfg.signal },
    );
    const raw = resp.choices[0]?.message?.content ?? "";
    const parsed = cfg.parseResult(raw);
    if (!parsed.ok) {
      return { lane: "openai", status: "unavailable", error: parsed.error };
    }
    const u = resp.usage;
    return {
      lane: "openai",
      status: "ok",
      verdict: parsed.verdict,
      findings: parsed.findings,
      reversal_triggers_present: parsed.reversal_triggers_present,
      cost_usd: estimateOpenAiCostUsd(OPENAI_CRITIC_MODEL, {
        input_tokens: u?.prompt_tokens ?? 0,
        output_tokens: u?.completion_tokens ?? 0,
      }),
    };
  } catch (e) {
    return {
      lane: "openai",
      status: "unavailable",
      error: `openai_error: ${(e as Error).message}`,
    };
  }
}

export async function runReasoningCritic<F>(
  cfg: ReasoningCriticConfig<F>,
): Promise<ReasoningCriticResult<F>> {
  const [aSettled, oSettled] = await Promise.allSettled([
    runAnthropicLane(cfg),
    runOpenAiLane(cfg),
  ]);
  const a: LaneResult<F> =
    aSettled.status === "fulfilled"
      ? aSettled.value
      : {
          lane: "anthropic",
          status: "unavailable",
          error: `lane_threw: ${String(aSettled.reason)}`,
        };
  const o: LaneResult<F> =
    oSettled.status === "fulfilled"
      ? oSettled.value
      : {
          lane: "openai",
          status: "unavailable",
          error: `lane_threw: ${String(oSettled.reason)}`,
        };

  const okLanes = [a, o].filter((l): l is LaneOk<F> => l.status === "ok");

  const lanes = {
    anthropic:
      a.status === "unavailable"
        ? ({
            status: "unavailable",
            error: a.error,
            reason: laneFailureReason(a.error),
          } as ReasoningLaneStatus)
        : ({ status: "ok" } as ReasoningLaneStatus),
    openai:
      o.status === "unavailable"
        ? ({
            status: "unavailable",
            error: o.error,
            reason: laneFailureReason(o.error),
          } as ReasoningLaneStatus)
        : o.status === "skipped"
          ? ({ status: "skipped" } as ReasoningLaneStatus)
          : ({ status: "ok" } as ReasoningLaneStatus),
  };

  if (okLanes.length === 0) {
    return {
      verdict: "ok",
      findings: [],
      reversal_triggers_present: undefined,
      lanes,
      cost_usd: 0,
    };
  }

  const aFindings = (a.status === "ok" ? a.findings : []).map((f) => ({
    ...f,
    reviewer: "anthropic" as const,
  }));
  const oFindings = (o.status === "ok" ? o.findings : []).map((f) => ({
    ...f,
    reviewer: "openai" as const,
  }));
  const merged: Array<F & { reviewer: "anthropic" | "openai" }> = [];
  const maxLen = Math.max(aFindings.length, oFindings.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < aFindings.length) merged.push(aFindings[i]);
    if (i < oFindings.length) merged.push(oFindings[i]);
  }
  const findings = merged.slice(0, cfg.findingCap);

  const okVerdicts = okLanes.map((l) => l.verdict);
  const verdict = cfg.deriveVerdict
    ? cfg.deriveVerdict(okVerdicts)
    : okVerdicts.some((v) => v === "revise")
      ? "revise"
      : "ok";

  const reportedReversals = okLanes
    .map((l) => l.reversal_triggers_present)
    .filter((r): r is boolean => typeof r === "boolean");
  const reversal_triggers_present =
    reportedReversals.length === okLanes.length && reportedReversals.length > 0
      ? reportedReversals.every(Boolean)
      : undefined;

  const cost_usd = okLanes.reduce((sum, l) => sum + l.cost_usd, 0);

  return { verdict, findings, reversal_triggers_present, lanes, cost_usd };
}
