
import {
  getAnthropic,
  heliconePropertyHeaders,
  DEFAULT_MODEL,
} from "@/services/anthropic";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { productPmBacklogSchema, type ProductPmBacklog } from "./output-schema";
import { runPmDeliberationCritic, type PmCriticMode } from "./critic";

const REVISE_MODEL = DEFAULT_MODEL;
const REVISE_TIMEOUT_MS = 30_000;
const REVISE_MAX_TOKENS = 3000;

const DOCUMENT_REVISE_MAX_TOKENS = 8000;
const DOCUMENT_REVISE_TIMEOUT_MS = 90_000;

const PM_ENVELOPE_RE = /<product_pm_backlog>([\s\S]*?)<\/product_pm_backlog>/;

const REVISE_SYSTEM_PROMPT = `You are revising YOUR OWN PM envelope to address a critic's findings. Emit ONLY the corrected <product_pm_backlog>{...}</product_pm_backlog> JSON — same schema as the original, no tools, no prose outside the tags.

Address every finding:
- Strengthen weak/empty reasoning and proposed_fix; populate every structured field (backlog[] fields / strategy.reframe_options[]) instead of leaving substance in prose.
- For a single-sided tradeoff, add the other side: the downside / what NOT to do / who this hurts, AND the reversal triggers ("we'd abandon this if…"). Populate the structured reversal_trigger field on the top backlog item (and rank-1 reframe option in strategy mode).
- For an unmeasurable_criterion finding, rewrite the named acceptance_criteria entry into a binary, measurable condition (a reviewer can mark met/not-met with no debate).
- Drop or properly ground any item whose impact claim has no supporting evidence_source.
- Keep the same status. Do NOT add dollar figures. Do NOT invent evidence_sources that weren't in the original — if you can't ground an item, drop it instead.

Return the corrected envelope wrapped in <product_pm_backlog> and </product_pm_backlog> tags and nothing else.`;

const DOCUMENT_REVISE_SYSTEM_PROMPT = `You are revising YOUR OWN PM document to address a critic's findings. Emit ONLY the corrected <product_pm_backlog>{...}</product_pm_backlog> JSON — same schema as the original, no tools, no prose outside the tags.

The operator-facing content is in \`rendered_markdown\`. That is what you are fixing. Keep \`status\`, \`artifact_label\`, and every other field as-is unless a finding specifically requires a change.

Address every finding:
- Correct any claim about how the operator's OWN systems/repos/services are wired that the document does not actually evidence. If you cannot support the claim from what the run actually read, either state the uncertainty in the document text ("not verified: <what>") or remove the claim. Do NOT restate it with softer wording while keeping the same assertion.
- Where a finding says a claim is contradicted by something the run already read, fix the claim to match what was read. The read evidence wins over the draft.
- Fix unsupported quantitative claims (costs, rates, counts, "zero-X") — either ground them or drop them.
- Preserve the document's structure, headings, and length. This is a targeted correction pass, not a rewrite.

Do NOT invent new evidence, file paths, or sources that were not in the original. If a section cannot be supported, it is better to say so in the document than to assert it.

Return the corrected envelope wrapped in <product_pm_backlog> and </product_pm_backlog> tags and nothing else.`;

function extractRevisedEnvelope(raw: string): ProductPmBacklog | null {
  const m = raw.match(PM_ENVELOPE_RE);
  const inner = (m ? m[1] : raw).trim();
  if (!inner) return null;
  let json: unknown;
  try {
    json = JSON.parse(inner);
  } catch {
    return null;
  }
  const parsed = productPmBacklogSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data;
}

const MIN_ARTIFACT_MARKDOWN = 400;

function isDocumentArtifact(parsed: ProductPmBacklog): boolean {
  if (parsed.status !== "no_signal") return false;
  if (typeof parsed.artifact_label === "string" && parsed.artifact_label.trim().length > 0) {
    return true;
  }
  const md = parsed.rendered_markdown;
  return typeof md === "string" && md.trim().length >= MIN_ARTIFACT_MARKDOWN;
}

function shouldDeliberate(parsed: ProductPmBacklog): boolean {
  if (parsed.status === "actionable") return parsed.backlog.length >= 1;
  if (parsed.status === "strategy_memo") {
    const opts = parsed.strategy?.reframe_options;
    return Array.isArray(opts) && opts.length > 0;
  }
  if (isDocumentArtifact(parsed)) return true;
  return false;
}

export async function deliberatePmEnvelope(
  ctx: AgentContext,
  result: DispatcherResult,
): Promise<void> {
  try {
    if (!result.parse_ok && !result.parsed) return;
    if (!result.parsed) return;

    const initial = productPmBacklogSchema.safeParse(result.parsed);
    if (!initial.success) return;
    const draft = initial.data;

    if (!shouldDeliberate(draft)) return;

    const mode: PmCriticMode =
      draft.status === "strategy_memo"
        ? "strategy_memo"
        : isDocumentArtifact(draft)
          ? "document"
          : "delivery";

    let critic;
    try {
      critic = await runPmDeliberationCritic(draft, mode, {
        tenantId: ctx.tenant_id,
        agentSlug: "pm",
        runId: ctx.runId,
      });
    } catch {
      return;
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
            ...(("reason" in critic.lanes.anthropic && critic.lanes.anthropic.reason)
              ? { reason: critic.lanes.anthropic.reason }
              : {}),
          },
          openai: {
            status: critic.lanes.openai.status,
            ...(("reason" in critic.lanes.openai && critic.lanes.openai.reason)
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
        `[pm deliberation] verdict=${critic.verdict} findings=${critic.findings.length} revised=false${laneLog}`,
      );
      return;
    }

    let revised: ProductPmBacklog | null = null;
    try {
      const userMsg =
        "Original envelope:\n<product_pm_backlog>\n" +
        JSON.stringify(draft, null, 2) +
        "\n</product_pm_backlog>\n\nCritic findings:\n" +
        JSON.stringify({ findings: critic.findings }, null, 2);

      const isDocMode = mode === "document";
      const reviseSystemPrompt = isDocMode
        ? DOCUMENT_REVISE_SYSTEM_PROMPT
        : REVISE_SYSTEM_PROMPT;
      const reviseMaxTokens = isDocMode
        ? DOCUMENT_REVISE_MAX_TOKENS
        : REVISE_MAX_TOKENS;
      const reviseTimeoutMs = isDocMode
        ? DOCUMENT_REVISE_TIMEOUT_MS
        : REVISE_TIMEOUT_MS;

      const anthropic = getAnthropic();
      const resp = await anthropic.messages.create(
        {
          model: REVISE_MODEL,
          max_tokens: reviseMaxTokens,
          system: reviseSystemPrompt,
          messages: [{ role: "user", content: userMsg }],
        },
        {
          signal: AbortSignal.timeout(reviseTimeoutMs),
          headers: heliconePropertyHeaders({
            tenantId: ctx.tenant_id,
            agentSlug: "pm",
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
        `[pm deliberation] verdict=${critic.verdict} findings=${critic.findings.length} revised=false${laneLog}`,
      );
      return;
    }
    recordLanes(true);

    result.parsed = revised;
    console.log(
      `[pm deliberation] verdict=${critic.verdict} findings=${critic.findings.length} revised=true${laneLog}`,
    );
  } catch {
    return;
  }
}
