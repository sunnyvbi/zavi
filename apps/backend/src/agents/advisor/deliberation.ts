
import {
  DEFAULT_MODEL,
  getAnthropic,
  heliconePropertyHeaders,
} from "@/services/anthropic";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { adviceSchema, type Advice } from "./output-schema";
import { runAdviceCritic } from "./critic";
import { isAdvisorCriticXfamilyEnabled } from "./advisor-critic-xfamily-flag";

const REVISE_MODEL = DEFAULT_MODEL;
const REVISE_TIMEOUT_MS = 30_000;
const REVISE_MAX_TOKENS = 8000;
const ADVICE_ENVELOPE_RE = /<advice>([\s\S]*?)<\/advice>/;

const REVISE_SYSTEM_PROMPT = `You are revising YOUR OWN strategic-advice envelope to address a critic's findings. Emit ONLY the corrected <advice>{...}</advice> JSON — same schema as the original, no tools, no prose outside the tags. Keep everything that was already good; only fix what the findings call out (ground a recommendation, add the missing dissent, add a kill-condition / disconfirming_signal, fix the lead_priority, make a vague rec concrete, add the missing downside/watch_for). IMPORTANT: rendered_markdown MUST be regenerated to stay consistent with any structured changes you make — do not leave it describing the old version.`;

function extractRevisedEnvelope(raw: string): Advice | null {
  const m = raw.match(ADVICE_ENVELOPE_RE);
  const inner = (m ? m[1] : raw).trim();
  if (!inner) return null;
  let json: unknown;
  try {
    json = JSON.parse(inner);
  } catch {
    return null;
  }
  const parsed = adviceSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data;
}

export async function deliberateAdviceEnvelope(
  ctx: AgentContext,
  result: DispatcherResult,
): Promise<boolean> {
  try {
    if (!result.parsed) return false;

    const initial = adviceSchema.safeParse(result.parsed);
    if (!initial.success) return false;
    const draft = initial.data;

    if (draft.clarifications_needed !== false) return false;

    let xfamilyOn = false;
    try {
      xfamilyOn = await isAdvisorCriticXfamilyEnabled(ctx.tenant_id);
    } catch {
      xfamilyOn = false;
    }
    if (!xfamilyOn) return false;

    let critic;
    try {
      critic = await runAdviceCritic(draft, {
        tenantId: ctx.tenant_id,
        agentSlug: "advisor",
        runId: ctx.runId,
      });
    } catch {
      return false;
    }

    const laneLog = critic.lanes
      ? ` lanes=a:${critic.lanes.anthropic.status}/o:${critic.lanes.openai.status}` +
        (critic.cost_usd != null
          ? ` xfam_cost=$${critic.cost_usd.toFixed(4)}`
          : "")
      : "";

    const recordLanes = (revise_applied: boolean) => {
      if (critic.lanes) {
        result.critic_lanes = {
          anthropic: {
            status: critic.lanes.anthropic.status,
            ...("reason" in critic.lanes.anthropic && critic.lanes.anthropic.reason
              ? { reason: critic.lanes.anthropic.reason }
              : {}),
          },
          openai: {
            status: critic.lanes.openai.status,
            ...("reason" in critic.lanes.openai && critic.lanes.openai.reason
              ? { reason: critic.lanes.openai.reason }
              : {}),
          },
          revise_applied,
          critic_cost_usd: critic.cost_usd,
        };
      }
    };

    if (critic.verdict !== "revise") {
      recordLanes(false);
      console.log(
        `[advisor deliberation] verdict=${critic.verdict} findings=${critic.findings.length} revised=false${laneLog}`,
      );
      return false;
    }

    let revised: Advice | null = null;
    try {
      const userMsg =
        "Original envelope:\n<advice>\n" +
        JSON.stringify(draft, null, 2) +
        "\n</advice>\n\nCritic findings:\n" +
        JSON.stringify({ findings: critic.findings }, null, 2);

      const anthropic = getAnthropic();
      const resp = await anthropic.messages.create(
        {
          model: REVISE_MODEL,
          max_tokens: REVISE_MAX_TOKENS,
          system: REVISE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMsg }],
        },
        {
          signal: AbortSignal.timeout(REVISE_TIMEOUT_MS),
          headers: heliconePropertyHeaders({
            tenantId: ctx.tenant_id,
            agentSlug: "advisor",
            runId: ctx.runId,
          }),
        },
      );
      const textBlock = resp.content.find((c) => c.type === "text");
      const rawText =
        textBlock && textBlock.type === "text" ? textBlock.text : "";
      revised = extractRevisedEnvelope(rawText);
    } catch {
      revised = null;
    }

    if (!revised) {
      recordLanes(false);
      console.log(
        `[advisor deliberation] verdict=${critic.verdict} findings=${critic.findings.length} revised=false${laneLog}`,
      );
      return false;
    }
    recordLanes(true);

    result.parsed = revised;
    result.output_text = revised.rendered_markdown;
    console.log(
      `[advisor deliberation] verdict=${critic.verdict} findings=${critic.findings.length} revised=true${laneLog}`,
    );
    return true;
  } catch {
    return false;
  }
}
