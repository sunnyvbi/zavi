
import { MODELS } from "@/services/llm/models";
import { z } from "zod";
import type { PostProcessorFn } from "@/agents/index";
import { synthMarkdown } from "@/services/llm/synthMarkdown";
import { deliverPdf } from "@/services/reports/deliver-pdf";
import { deliberateAdviceEnvelope } from "./deliberation";

function stripSlackMailto(s: string): string {
  return s.replace(/<mailto:([^|>]+)(?:\|[^>]+)?>/gi, "$1");
}

function extractEmailAddress(text: string): string | null {
  const cleaned = stripSlackMailto(text);

  const intent = cleaned.match(/\b(?:email|send)\b/i);
  if (!intent) return null;

  const region = cleaned.slice(intent.index! + intent[0].length);

  const angled = region.match(/<([^<>]*@[^<>]+)>/);
  if (angled) {
    const parsed = z.string().email().safeParse(angled[1].trim());
    if (parsed.success) return parsed.data;
  }

  for (const rawTok of region.split(/[\s,;]+/)) {
    if (!rawTok.includes("@")) continue;
    let tok = rawTok;
    tok = tok.replace(/^[("'`<]+/, "");
    tok = tok.replace(/[.,;:!?)\]}>"'`]+$/, "");
    const parsed = z.string().email().safeParse(tok);
    if (parsed.success) return parsed.data;
  }

  return null;
}

function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}

const LYING_PHRASES = [
  /answer the questions above/gi,
  /answer the questions below/gi,
  /the questions above/gi,
  /the questions below/gi,
  /answer (?:them|these) and i['']ll/gi,
];

function scrubLyingQuestionPromise(advice: AdviceShape): boolean {
  const cl = advice.clarifications_needed;
  const questions =
    cl && typeof cl === "object" && Array.isArray((cl as { questions?: unknown }).questions)
      ? (cl as { questions: unknown[] }).questions.filter(
          (q): q is string => typeof q === "string" && q.trim().length > 0,
        )
      : [];
  const hasRealQuestions = questions.length > 0;

  const rm = advice.rendered_markdown ?? "";
  const promisesQuestions = LYING_PHRASES.some((re) => {
    re.lastIndex = 0;
    return re.test(rm);
  });

  if (hasRealQuestions) {
    const firstQ = questions[0].slice(0, 24);
    const alreadyInMarkdown = rm.includes(firstQ);
    if (promisesQuestions && !alreadyInMarkdown) {
      const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
      advice.rendered_markdown = `${rm.trimEnd()}\n\n${numbered}`;
      return true;
    }
    return false;
  }

  if (!promisesQuestions) return false;

  const decideToday =
    advice.recommendations?.decide_today?.map((r) => r.title + " " + r.rationale).join(" ") ??
    "";
  if (decideToday.includes("?")) return false;

  let scrubbed = rm;
  for (const re of LYING_PHRASES) {
    scrubbed = scrubbed.replace(
      re,
      "I need a few specifics before I can help — reply with more context",
    );
  }
  advice.rendered_markdown = scrubbed;
  return true;
}

const DISPATCH_CLAIM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:i(?:'|’)?ve|i have|i)\s+(?:just\s+)?(?:queued|dispatched|sent|kicked off|handed off|filed|submitted|scheduled|assigned)\s+(?:that|this|it|the|a|an)?\s*(?:as\s+(?:a|an)\s+)?(?:dispatch\s+)?(?:proposal|brief|dispatch|handoff)(?:\s+(?:below|above))?/gi,
    "I recommend handing this off",
  ],
  [
    /\b(?:queued|dispatched|kicked off|handed off)\s+(?:a|an|the)\s+(?:dispatch\s+)?(?:proposal|brief|dispatch|handoff)(?:\s+(?:below|above))?/gi,
    "Recommended handoff",
  ],
  [
    /\b(?:(?:click|hit|press|tap)\s+(?:the\s+)?)?approve\b[^.\n]*?\b(?:proposal|brief|dispatch|handoff)\b[^.\n]*/gi,
    "dispatch it from that agent's own form when you want it run",
  ],
];

function scrubDispatchClaimText(text: string): string | null {
  if (!text) return null;
  let scrubbed = text;
  for (const [re, replacement] of DISPATCH_CLAIM_PATTERNS) {
    re.lastIndex = 0;
    scrubbed = scrubbed.replace(re, replacement);
  }
  return scrubbed === text ? null : scrubbed;
}

function scrubDispatchSideEffectClaim(advice: AdviceShape, result?: { output_text?: string }): boolean {
  let changed = false;

  const rm = scrubDispatchClaimText(advice.rendered_markdown ?? "");
  if (rm !== null) {
    advice.rendered_markdown = rm;
    changed = true;
  }

  if (result) {
    const ot = scrubDispatchClaimText(result.output_text ?? "");
    if (ot !== null) {
      result.output_text = ot;
      changed = true;
    }
  }

  return changed;
}

const SUMMARY_SYSTEM_PROMPT = `You are an executive summarizer turning a structured strategic-advisor envelope into a focused email body for a startup founder.

Output rules:
- 500-800 words.
- Lead with the single most important "decide today" call.
- Then 2-3 "next 30 days" items.
- Then 1-2 "watch for" signals.
- Keep the founder's voice (concise, direct). No corporate hedge language.
- NO preamble like "Here is the summary".
- Plain markdown, no HTML.`;

async function buildEmailBody(
  advice: AdviceShape,
  tenant_id: string,
): Promise<string> {
  const rm = injectCaveatsIntoMarkdown(advice);
  const fallback = rm.slice(0, 20_000);
  if (!rm) return fallback;

  try {
    const out = await synthMarkdown({
      role: "advisor_email_summary",
      tenant_id,
      system_prompt: SUMMARY_SYSTEM_PROMPT,
      user_prompt: `Summarize this advice memo into an email body:\n\n${rm.slice(0, 24_000)}`,
      max_tokens: 1500,
      model: MODELS.anthropic.sonnet,
    });
    const summary = (out.markdown ?? "").trim();
    return summary.length > 0 ? summary.slice(0, 20_000) : fallback;
  } catch (e) {
    console.warn(
      `[advisor post-run] synthMarkdown summary failed (falling back to slice): ${(e as Error).message}`,
    );
    return fallback;
  }
}

function buildPdfInput(advice: AdviceShape): {
  title: string;
  sections: Array<{ heading: string; body_markdown: string }>;
  filename: string;
} {
  const date = new Date().toISOString().slice(0, 10);
  const title = `Zavi Advisor Memo — ${date}`;
  const filename = `advisor-memo-${date}.pdf`;
  const enrichedMarkdown = injectCaveatsIntoMarkdown(advice);
  const rm = enrichedMarkdown.slice(0, 40_000);
  const body = rm.length > 0 ? rm : "(No advice content available.)";
  return {
    title,
    sections: [{ heading: "Advice memo", body_markdown: body }],
    filename,
  };
}

async function renderArtifact(
  tenant_id: string,
  run_id: string,
  advice: AdviceShape,
): Promise<string | null> {
  try {
    const input = buildPdfInput(advice);
    const result = await deliverPdf({ tenant_id, run_id }, input);
    return result.artifact_id;
  } catch (e) {
    console.warn(
      `[advisor post-run] deliverPdf failed (sending body-only): ${(e as Error).message}`,
    );
    return null;
  }
}

type AdviceShape = {
  rendered_markdown?: string;
  clarifications_needed?:
    | false
    | { questions?: string[] }
    | null;
  recommendations?: {
    decide_today?: Array<{
      title?: string;
      rationale?: string;
      confidence?: string;
      disconfirming_signal?: string;
    }>;
    lead_priority?: string;
    deprioritize?: string[];
  };
  dissent?: { what_not_to_do?: string; why?: string };
};

const CONFIDENCE_LABEL: Record<string, string> = {
  evidence_grounded: "Evidence-grounded",
  inference: "Inference (not fully verified)",
  low_confidence_speculation: "Low-confidence speculation",
};

function injectCaveatsIntoMarkdown(advice: AdviceShape): string {
  const rm = advice.rendered_markdown ?? "";
  const recs = advice.recommendations;

  const parts: string[] = [];

  if (recs?.lead_priority) {
    parts.push(`> **Zavi: #1 priority right now** — ${recs.lead_priority}`);
  }

  const decide = recs?.decide_today ?? [];
  if (decide.length > 0) {
    parts.push("**Calibrated confidence on today's decisions:**");
    for (const item of decide) {
      if (!item.title) continue;
      const conf = item.confidence
        ? (CONFIDENCE_LABEL[item.confidence] ?? item.confidence)
        : null;
      const confLine = conf ? ` _(${conf})_` : "";
      parts.push(`- **${item.title}**${confLine}`);
      if (item.disconfirming_signal) {
        parts.push(`  - Would change my mind if: ${item.disconfirming_signal}`);
      }
    }
  }

  if (advice.dissent?.what_not_to_do) {
    parts.push(
      `**What NOT to do:** ${advice.dissent.what_not_to_do}` +
        (advice.dissent.why ? `\n_Why: ${advice.dissent.why}_` : ""),
    );
  }

  if (parts.length === 0) {
    return rm;
  }

  const caveatBlock =
    "---\n" +
    parts.join("\n\n") +
    "\n\n---\n\n";

  return caveatBlock + rm;
}

export const advisorPostProcess: PostProcessorFn = async (
  ctx,
  result,
  payload,
) => {
  if (!result.parse_ok || !result.parsed) return;

  const deliberationRevised = await deliberateAdviceEnvelope(ctx, result);

  const advice = result.parsed as AdviceShape;

  const scrubbed = scrubLyingQuestionPromise(advice);
  if (scrubbed) {
    console.log(
      `[advisor post-run] scrubbed lying question-promise sentence (run_id=${ctx.runId})`,
    );
    if (deliberationRevised && advice.rendered_markdown) {
      result.output_text = advice.rendered_markdown;
    }
  }

  const dispatchScrubbed = scrubDispatchSideEffectClaim(advice, result);
  if (dispatchScrubbed) {
    console.log(
      `[advisor post-run] scrubbed false dispatch side-effect claim (run_id=${ctx.runId})`,
    );
  }

  if (ctx.trigger !== "chat") return;

  const cl = advice.clarifications_needed;
  if (
    cl &&
    typeof cl === "object" &&
    Array.isArray((cl as { questions?: unknown }).questions) &&
    ((cl as { questions: unknown[] }).questions.length ?? 0) > 0
  ) {
    return;
  }

  const raw =
    (payload as { current_user_text_raw?: string } | undefined)
      ?.current_user_text_raw ?? "";
  if (!raw) return;

  const to = extractEmailAddress(raw);
  if (!to) {
    return;
  }

  const body_text = await buildEmailBody(advice, ctx.tenant_id);
  if (!body_text) return;

  const subject = `Zavi Advisor — ${new Date().toISOString().slice(0, 10)}`;

  const artifact_id = await renderArtifact(ctx.tenant_id, ctx.runId, advice);

  const body: {
    to: string;
    subject: string;
    body_text: string;
    artifact_id?: string;
  } = { to, subject, body_text };
  if (artifact_id) body.artifact_id = artifact_id;

  try {
    const decisionId = await ctx.emitDecision("send_email", body);
    console.log(
      `[advisor post-run] send_email decision emitted (run_id=${ctx.runId} decision_id=${decisionId} to=${redactEmail(to)} artifact_id=${artifact_id ?? "none"})`,
    );
  } catch (e) {
    console.warn(
      `[advisor post-run] emitDecision('send_email') failed: ${(e as Error).message}`,
    );
  }
};

export const __test__ = {
  extractEmailAddress,
  redactEmail,
  scrubLyingQuestionPromise,
  scrubDispatchSideEffectClaim,
  scrubDispatchClaimText,
  buildEmailBody,
  buildPdfInput,
  injectCaveatsIntoMarkdown,
};
