import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { getAnthropic, heliconePropertyHeaders } from "@/services/anthropic";
import {
  researchReportSchema,
  researchReportEnvelopeSchema,
  type ResearchReport,
  type ResearchEnvelope,
} from "./output-schema";
import { normalizeResearchReport, detectWeakSynthesis } from "./post-run";
import {
  renderResearchReportMarkdown,
  renderResearchClarificationMarkdown,
  detectProseOnly,
} from "./render-markdown";
import { extractAskText } from "./persist-evidence";
import { buildResearchPdfInput } from "./pdf-input";
import { deliverPdf } from "@/services/reports/deliver-pdf";
import { lintArtifactSections } from "@/services/reports/placeholder-lint";
import { logEvent } from "@/services/logging/logEvent";
import { groundResearchClaims, isFetchTrace, type ClaimGroundingFlags } from "./claim-grounding";
import { guardUnrenderedSources } from "./unrendered-source-guard";
import { unverifiedCaptures } from "@/services/agents/engine/capture-ledger";
import { parseHumanNumbers, numberAppearsInText } from "./human-number";
import { RESEARCH_UNVERIFIED_FALLBACK } from "./self-abort";
import { detectToolNoOutput } from "@/services/agents/outcome-model";

const ADJUDICATE_MODEL = "claude-haiku-4-5-20251001";
const ADJUDICATE_TIMEOUT_MS = 4000;

const EMPTY_FLAGS: ClaimGroundingFlags = {
  grounded: 0,
  downgraded: 0,
  stripped: 0,
  truncation_hedges: 0,
  contested_downgrades: 0,
  chips_synthesized: 0,
  adjudicate_calls: 0,
  stale_hedges: 0,
};

function groundingDisabled(): boolean {
  const v = process.env.RESEARCH_GROUNDING_DISABLED;
  return v === "1" || v === "true";
}

function b2ReconstructDisabled(): boolean {
  const v = process.env.RESEARCH_B2_RECONSTRUCT_DISABLED;
  return v === "1" || v === "true";
}

const RECONSTRUCT_TIMEOUT_MS = 6000;
const MIN_RECONSTRUCT_FETCH_CHARS = 200;

function substantiveFetchedText(
  toolCalls: readonly { name: string; output_preview?: string; status?: string }[],
): string {
  return toolCalls
    .filter(
      (tc) => isFetchTrace(tc.name) && tc.status !== "tool_error" && tc.status !== "throw",
    )
    .map((tc) => tc.output_preview ?? "")
    .filter((t) => t.trim())
    .join("\n\n---\n\n");
}

const RECONSTRUCT_CLARIFICATION: ResearchEnvelope = {
  kind: "clarification",
  questions: [
    {
      question: "The sources I pulled were thin or conflicted — which angle should I weight?",
      why: "I fetched data but couldn't reconcile it into a confident, cited report.",
    },
    {
      question: "Do you want a best-effort summary of what I did find, flagged as unverified?",
      why: "I can share the partial findings with risk tiers instead of a full report.",
    },
  ],
};

async function reconstructFromFetchedData(
  ctx: AgentContext,
  rawText: string,
  toolCalls: readonly { name: string; output_preview?: string; status?: string }[],
): Promise<ResearchEnvelope | null> {
  if (b2ReconstructDisabled()) return null;
  const fetchedText = substantiveFetchedText(toolCalls);
  if (fetchedText.trim().length < MIN_RECONSTRUCT_FETCH_CHARS) return null;

  const system = [
    "You are a research report formatter. You are given (a) a partial/raw draft and",
    "(b) the actual fetched source excerpts from this run. Wrap ONLY what the source",
    "excerpts support into a single valid <research_report> JSON envelope.",
    "Rules: do NOT invent numbers or facts not present in the excerpts; mark any shaky,",
    "single-source, or conflicting claim as a high-risk/assumption validation chip and",
    "name the conflict; if two sources disagree, say so in a block. Output ONLY the JSON",
    "object (kind:'report', template, title, query, blocks[], lenses[], sources[],",
    "validation[], failed_lenses[], generated_at) — no prose, no <research_report> tags.",
  ].join("\n");
  const user = [
    `RAW DRAFT (may be empty or a bail):\n${(rawText ?? "").slice(0, 4000)}`,
    `\nFETCHED SOURCE EXCERPTS:\n${fetchedText.slice(0, 18000)}`,
  ].join("\n");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = getAnthropic().messages.create(
      {
        model: ADJUDICATE_MODEL,
        max_tokens: 4096,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      },
      {
        headers: heliconePropertyHeaders({
          tenantId: ctx.tenant_id,
          agentSlug: "research",
          runId: ctx.runId,
        }),
      },
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`research reconstruct timeout after ${RECONSTRUCT_TIMEOUT_MS}ms`)),
        RECONSTRUCT_TIMEOUT_MS,
      );
    });
    const resp = await Promise.race([call, timeout]);
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = researchReportEnvelopeSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? (parsed.data as ResearchEnvelope) : null;
  } catch (err) {
    console.warn(
      `[research dispatcher] B2 reconstruct failed — falling through: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stalenessMonths(): number {
  const n = Number(process.env.RESEARCH_STALENESS_MONTHS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function pdfRenderDisabled(): boolean {
  const v = process.env.RESEARCH_PDF_DISABLED;
  return v === "1" || v === "true";
}

const PDF_MIN_BLOCKS = 2;

async function renderReportPdf(ctx: AgentContext, report: ResearchReport): Promise<void> {
  if (pdfRenderDisabled() || !ctx.runId) return;
  if (report.blocks.length < PDF_MIN_BLOCKS) return;
  try {
    const input = buildResearchPdfInput(report);
    const linted = lintArtifactSections(input.sections);
    if (linted.flags.stub_lines > 0 || linted.flags.empty_sections > 0) {
      void logEvent({
        level: "warn",
        source: "research",
        code: "artifact_placeholder_stripped",
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        message: `stub_lines=${linted.flags.stub_lines} empty_sections=${linted.flags.empty_sections}`,
      });
    }
    if (linted.sections.length === 0) {
      console.warn(
        "[research dispatcher] PDF skipped — all sections were placeholder stubs/empty",
      );
      return;
    }
    await deliverPdf(
      { tenant_id: ctx.tenant_id, run_id: ctx.runId },
      { ...input, sections: linted.sections },
    );
  } catch (err) {
    console.warn(
      `[research dispatcher] PDF render soft-failed (text answer already shipped): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

const REFUSAL_MAX_CHARS = 4000;
const QUICK_ANSWER_MAX_CHARS = 1500;

const REFUSAL_MARKER_RE = new RegExp(
  [
    "\\bhard[ -]stop\\b",
    "\\bproduction secret",
    "\\btenant boundar",
    "\\bcross[ -]tenant\\b",
    "\\bi can['’]t\\b",
    "\\bi cannot\\b",
    "\\bi won['’]t\\b",
    "\\bi will not\\b",
    "\\bi['’]m unable\\b",
    "\\bi am unable\\b",
    "\\bi['’]m not able\\b",
    "\\bi am not able\\b",
    "\\bi must decline\\b",
    "\\bi refuse\\b",
  ].join("|"),
  "i",
);

const STAT_CLAIM_RE =
  /\$\s?\d|\d(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:million|billion|trillion|bn|mn|[kmb])\b|\d{1,3}(?:,\d{3})+/i;

const TOOL_FAILURE_MAX_CHARS = 1500;
const TOOL_FAILURE_MARKER_RE = new RegExp(
  [
    "not_enough_credits",
    "\\bout of credits\\b",
    "\\bno image was produced\\b",
    "\\b(?:could ?n[o']?t|could not|unable to|failed to)\\s+(?:generate|render|create|produce)\\b",
    "\\bgeneration failed\\b",
    "\\brate.?limit",
    "\\bquota\\b",
  ].join("|"),
  "i",
);

export function toolFailureNotice(z: { tool: string; reason: string }): string {
  const raw = (z.tool.split("__").pop() || z.tool).toLowerCase();
  const what = /video/.test(raw)
    ? "video"
    : /audio|speech|voice/.test(raw)
      ? "audio"
      : /pdf|report/.test(raw)
        ? "document"
        : "image";

  const r = (z.reason || "").toLowerCase();
  const cause = /not_enough_credits|insufficient_credit|quota|billing/.test(r)
    ? `The ${what} service is unavailable on our side right now, and we are on it.`
    : /rate.?limit|429|too many/.test(r)
      ? `The ${what} service is rate-limiting us at the moment.`
      : /timeout|timed out/.test(r)
        ? `The ${what} service timed out.`
        : /unauthor|forbidden|401|invalid_grant|credential/.test(r)
          ? `The ${what} service rejected our connection, and we are on it.`
          : `The ${what} step failed.`;

  return `No ${what} was produced. ${cause} Nothing was generated, so there is nothing to show — ask again once it is back.`;
}

const QUICK_ANSWER_SUFFIX =
  "\n\n_Quick answer from live sources — not a full cited research report. " +
  "Ask me to go deeper if you want sources and validation tiers._";

export function salvageRawResearchOutput(
  rawText: string,
  toolCalls: readonly { name: string; output_preview?: string; status?: string }[],
): { text: string; kind: "refusal" | "quick_answer" | "tool_failure" } | null {
  const raw = (rawText ?? "").trim();
  if (!raw) return null;
  if (raw.includes("<research_report>") || raw.includes('"kind"')) return null;

  if (raw.length <= REFUSAL_MAX_CHARS && REFUSAL_MARKER_RE.test(raw) && !STAT_CLAIM_RE.test(raw)) {
    return { text: raw, kind: "refusal" };
  }

  if (
    raw.length <= TOOL_FAILURE_MAX_CHARS &&
    TOOL_FAILURE_MARKER_RE.test(raw) &&
    !STAT_CLAIM_RE.test(raw)
  ) {
    const zeroOutput = detectToolNoOutput(
      (toolCalls ?? []).map((tc) => ({
        name: tc.name,
        status: tc.status,
        output_preview: tc.output_preview,
      })) as Parameters<typeof detectToolNoOutput>[0],
    );
    if (zeroOutput) {
      return { text: toolFailureNotice(zeroOutput), kind: "tool_failure" };
    }
  }

  if (raw.length > QUICK_ANSWER_MAX_CHARS) return null;
  const fetchedText = toolCalls
    .filter(
      (tc) => isFetchTrace(tc.name) && tc.status !== "tool_error" && tc.status !== "throw",
    )
    .map((tc) => tc.output_preview ?? "")
    .join("\n");
  if (!fetchedText.trim()) return null;
  const numbers = parseHumanNumbers(raw);
  if (numbers.length === 0) return null;
  if (!numbers.every((n) => numberAppearsInText(n, fetchedText))) return null;
  return { text: `${raw}${QUICK_ANSWER_SUFFIX}`, kind: "quick_answer" };
}

function makeAdjudicator(ctx: AgentContext) {
  return async (pairs: { claim: string; sourceText: string }[]): Promise<boolean[]> => {
    if (pairs.length === 0) return [];
    const system = [
      "For each {claim, source_text} pair, answer ONLY whether the source text",
      "supports the claim's specific number/fact. A claim is supported only if",
      "the source text contains that number (or an equivalent form) or directly",
      "states the fact. Do not infer beyond what the text says.",
      `Return a JSON array of exactly ${pairs.length} booleans, in order, nothing else.`,
    ].join("\n");
    const user = pairs
      .map(
        (p, i) =>
          `[${i}] CLAIM: ${p.claim.slice(0, 600)}\nSOURCE_TEXT: ${p.sourceText.slice(0, 6000)}`,
      )
      .join("\n\n");

    const call = getAnthropic().messages.create(
      {
        model: ADJUDICATE_MODEL,
        max_tokens: 256,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      },
      {
        headers: heliconePropertyHeaders({
          tenantId: ctx.tenant_id,
          agentSlug: "research",
          runId: ctx.runId,
        }),
      },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`research adjudicate timeout after ${ADJUDICATE_TIMEOUT_MS}ms`)),
        ADJUDICATE_TIMEOUT_MS,
      );
    });

    try {
      const resp = await Promise.race([call, timeout]);
      const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("research adjudicate: no JSON array in output");
      const arr = JSON.parse(match[0]) as unknown;
      if (!Array.isArray(arr)) throw new Error("research adjudicate: not an array");
      return pairs.map((_, i) => arr[i] === true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

async function applyResearchDiscipline(
  ctx: AgentContext,
  result: DispatcherResult,
  ask = "",
  _reconstructed = false,
): Promise<void> {
  if (result.parse_ok && result.parsed) {
    const parsed = researchReportSchema.safeParse(result.parsed);
    if (parsed.success && parsed.data.kind === "clarification") {
      result.output_text = renderResearchClarificationMarkdown(parsed.data.questions);
      return;
    }
    if (parsed.success && parsed.data.kind === "report") {
      let grounded = parsed.data;
      let groundingFlags: ClaimGroundingFlags = EMPTY_FLAGS;
      if (!groundingDisabled()) {
        try {
          const g = await groundResearchClaims(grounded, result.tool_calls ?? [], {
            adjudicate: makeAdjudicator(ctx),
            stalenessMonths: stalenessMonths(),
            now: new Date(),
          });
          grounded = g.report;
          groundingFlags = g.flags;
        } catch (err) {
          console.warn(
            `[research dispatcher] claim-grounding threw — using ungrounded report: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          grounded = parsed.data;
        }
      }

      try {
        if (ctx.runId) {
          const unverified = unverifiedCaptures(ctx.runId);
          if (unverified.length > 0) {
            const ug = guardUnrenderedSources(grounded, unverified);
            grounded = ug.report;
            if (ug.flags.unrendered_sources > 0) {
              console.log(
                `[research dispatcher] unrendered-source-guard: sources=${ug.flags.unrendered_sources} ` +
                  `chips_downgraded=${ug.flags.chips_downgraded} cites_stripped=${ug.flags.citations_stripped} ` +
                  `disclosure_chips=${ug.flags.disclosure_chips_added}`,
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          `[research dispatcher] unrendered-source-guard threw — using prior report: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const { report, droppedCitations, downgradedChips } = normalizeResearchReport(grounded);
      result.parsed = report;
      result.output_text = renderResearchReportMarkdown(report, { proseOnly: detectProseOnly(ask) });
      const weakSynthesis = detectWeakSynthesis(report) ? 1 : 0;
      console.log(
        `[research dispatcher] dropped_cites=${droppedCitations} downgraded_chips=${downgradedChips} ` +
          `failed_lenses=${report.failed_lenses.length} grounding_downgraded=${groundingFlags.downgraded} ` +
          `grounding_stripped=${groundingFlags.stripped} truncation_hedges=${groundingFlags.truncation_hedges} ` +
          `contested=${groundingFlags.contested_downgrades} chips_synth=${groundingFlags.chips_synthesized} ` +
          `adjudicate_calls=${groundingFlags.adjudicate_calls} stale_hedges=${groundingFlags.stale_hedges} ` +
          `weak_synthesis=${weakSynthesis}`,
      );
      await renderReportPdf(ctx, report);
      return;
    }
    console.warn(
      `[research dispatcher] envelope schema mismatch — refusing to ship raw research prose: ${
        !parsed.success ? parsed.error.message : "unexpected envelope kind"
      }`,
    );
  } else {
    console.warn(
      `[research dispatcher] no valid research envelope (parse_ok=${result.parse_ok}) — refusing to ship raw research prose`,
    );
  }

  const salvaged = salvageRawResearchOutput(result.output_text ?? "", result.tool_calls ?? []);
  if (salvaged) {
    console.log(
      `[research dispatcher] salvaged raw output as ${salvaged.kind} — shipping without envelope`,
    );
    result.output_text = salvaged.text;
    result.parsed = null;
    result.parse_ok = false;
    return;
  }

  if (!_reconstructed && !b2ReconstructDisabled()) {
    const reconstructed = await reconstructFromFetchedData(
      ctx,
      result.output_text ?? "",
      result.tool_calls ?? [],
    );
    if (reconstructed) {
      void logEvent({
        level: "info",
        source: "research",
        code: "research.b2_bail_with_usable_data",
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        message: "reconstructed",
      });
      result.parsed = reconstructed;
      result.parse_ok = true;
      await applyResearchDiscipline(ctx, result, ask, true);
      return;
    }
    const hadFetched =
      substantiveFetchedText(result.tool_calls ?? []).trim().length >= MIN_RECONSTRUCT_FETCH_CHARS;
    if (hadFetched) {
      void logEvent({
        level: "info",
        source: "research",
        code: "research.b2_bail_with_usable_data",
        tenant_id: ctx.tenant_id,
        run_id: ctx.runId,
        message: "clarified",
      });
      result.parsed = RECONSTRUCT_CLARIFICATION;
      result.parse_ok = true;
      await applyResearchDiscipline(ctx, result, ask, true);
      return;
    }
    void logEvent({
      level: "info",
      source: "research",
      code: "research.b2_bail_with_usable_data",
      tenant_id: ctx.tenant_id,
      run_id: ctx.runId,
      message: "stub",
    });
  }

  result.output_text = RESEARCH_UNVERIFIED_FALLBACK;
  result.parsed = null;
  result.parse_ok = false;
}

function isClarificationResult(result: DispatcherResult): boolean {
  return (result.parsed as { kind?: unknown } | null)?.kind === "clarification";
}

const NO_CLARIFY_RETRY_FLAG = "_research_no_clarify_retry";

function isNoClarifyRetry(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>)[NO_CLARIFY_RETRY_FLAG] === true
  );
}

function withNoClarifyRetry(payload: unknown): unknown {
  const base =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : { ask: extractAskText(payload) };
  return { ...base, [NO_CLARIFY_RETRY_FLAG]: true };
}

export async function researchDispatcher(ctx: AgentContext, payload: unknown): Promise<DispatcherResult> {
  const result = await runGeneric(ctx, payload);
  await applyResearchDiscipline(ctx, result, extractAskText(payload));

  if (
    ctx.trigger !== "chat" &&
    isClarificationResult(result) &&
    !isNoClarifyRetry(payload)
  ) {
    const retryPayload = withNoClarifyRetry(payload);
    const retry = await runGeneric(ctx, retryPayload);
    await applyResearchDiscipline(ctx, retry, extractAskText(retryPayload));
    return retry;
  }
  return result;
}

export async function researchChatPostProcess(
  ctx: AgentContext,
  result: DispatcherResult,
  payload?: unknown,
): Promise<void> {
  await applyResearchDiscipline(ctx, result, extractAskText(payload));
}
