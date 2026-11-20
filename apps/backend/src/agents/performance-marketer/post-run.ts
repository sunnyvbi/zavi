
import type { PostProcessorFn } from "@/agents/index";
import { writeNote } from "@/services/memory";
import type { GrowthDigest } from "../growth-lead/output-schema";
import { isPerfmktTypedDigestEnabled } from "./typed-digest-flag";
import {
  hasGroundingTools,
  evaluateGroundingContract,
} from "@/services/tools/meta-ads/write/_grounding-guard";

export const adsManagerPostProcess: PostProcessorFn = async (ctx, result) => {
  try {
    await stampGroundingContract(ctx, result);
  } catch (e) {
    console.warn(
      `[performance-marketer post-run] grounding-contract stamp failed: ${(e as Error).message}`,
    );
  }

  if (!result.parse_ok || !result.parsed) {
    console.warn(
      `[performance-marketer post-run] envelope parse failed, no distill (run_id=${ctx.runId})`,
    );
    return;
  }

  const digest = result.parsed as Partial<GrowthDigest> | null;
  const rendered = digest?.rendered_markdown ?? "";

  let body: string | null = null;
  try {
    if (await isPerfmktTypedDigestEnabled(ctx.tenant_id)) {
      const sections = digest?.digest_sections;
      const summary = sections?.weekly_summary?.trim() ?? "";
      const realloc = sections?.proposed_reallocation?.trim() ?? "";
      const soWhat = sections?.so_what_trend?.trim() ?? "";
      if (summary && realloc && soWhat) {
        const anomalies = sections?.anomalies?.trim() ?? "";
        const newTests = sections?.new_tests?.trim() ?? "";
        const risks = sections?.risks?.trim() ?? "";
        const confidence = sections?.confidence?.trim() ?? "";
        const blindSpots = sections?.blind_spots?.trim() ?? "";
        body = [
          `## performance-marketer weekly distill — ${new Date().toISOString().slice(0, 10)}`,
          ``,
          `### Weekly summary`,
          summary.slice(0, 600),
          ``,
          `### Proposed reallocation`,
          realloc.slice(0, 600),
          ``,
          `### So-what + trend`,
          soWhat.slice(0, 600),
          ...(anomalies ? [``, `### Anomalies`, anomalies.slice(0, 600)] : []),
          ...(newTests ? [``, `### New tests`, newTests.slice(0, 600)] : []),
          ...(risks ? [``, `### Risks`, risks.slice(0, 600)] : []),
          ...(confidence ? [``, `### Confidence`, confidence.slice(0, 600)] : []),
          ...(blindSpots ? [``, `### Blind spots`, blindSpots.slice(0, 600)] : []),
        ].join("\n");
      }
    }
  } catch (e) {
    console.warn(
      `[performance-marketer post-run] typed-digest flag read failed, using regex path: ${(e as Error).message}`,
    );
  }

  if (body === null) {
    const summaryMatch = rendered.match(
      /###?\s*Weekly summary\s*\n([\s\S]*?)(?=\n###?\s|\n##\s|$)/i,
    );
    const reallocMatch = rendered.match(
      /###?\s*Proposed reallocation\s*\n([\s\S]*?)(?=\n###?\s|\n##\s|$)/i,
    );
    const soWhatMatch = rendered.match(
      /###?\s*So[- ]?what(?:\s*\+?\s*trend)?\s*\n([\s\S]*?)(?=\n###?\s|\n##\s|$)/i,
    );

    body = [
      `## performance-marketer weekly distill — ${new Date().toISOString().slice(0, 10)}`,
      ``,
      `### Weekly summary`,
      (summaryMatch?.[1] ?? "(not present in digest)").trim().slice(0, 600),
      ``,
      `### Proposed reallocation`,
      (reallocMatch?.[1] ?? "(none proposed)").trim().slice(0, 600),
      ``,
      `### So-what + trend`,
      (soWhatMatch?.[1] ?? "(not present in digest)").trim().slice(0, 600),
    ].join("\n");
  }

  try {
    await writeNote(ctx.tenant_id, {
      note_type: "ads_channel_perf",
      title: `Ads channel perf — ${new Date().toISOString().slice(0, 10)}`,
      body_markdown: body,
      source: "agent_run",
      source_ref: ctx.runId,
      tags: ["source-agent:performance-marketer", "growth-fan-in"],
    });
    console.log(
      `[performance-marketer post-run] ads_channel_perf note written (run_id=${ctx.runId})`,
    );
  } catch (e) {
    console.warn(
      `[performance-marketer post-run] writeNote(ads_channel_perf) failed: ${(e as Error).message}`,
    );
  }
};

const REC_VERB_RE =
  /\b(scal\w*|rais\w*|increas\w*|cut\w*|paus\w*|kill|double|triple|reallocat\w*|shift)\b/i;
const REC_NEGATIVE_RE =
  /insufficient signal|none proposed|no platform data|cannot propose|no reallocation/i;

function detectTextualRecommendation(rendered: string): boolean {
  if (!rendered) return false;
  const m = rendered.match(
    /###?\s*Proposed reallocation\s*\n([\s\S]*?)(?=\n###?\s|\n##\s|$)/i,
  );
  const section = (m?.[1] ?? "").trim();
  if (!section) return false;
  if (REC_NEGATIVE_RE.test(section)) return false;
  return REC_VERB_RE.test(section);
}

async function stampGroundingContract(
  ctx: Parameters<PostProcessorFn>[0],
  result: Parameters<PostProcessorFn>[1],
): Promise<void> {
  const toolNames = (result.tool_calls ?? []).map((t) => t.name);
  const proposedViaTool = toolNames.some((n) =>
    /propose_(budget|status)_change/i.test(n),
  );
  const digest = result.parsed as Partial<GrowthDigest> | null;
  const rendered =
    (digest?.rendered_markdown ?? "") || (result.output_text ?? "");
  const recommendedAction =
    proposedViaTool || detectTextualRecommendation(rendered);
  const grounded = hasGroundingTools(toolNames);

  const { grounding_contract_failed } = evaluateGroundingContract({
    recommendedAction,
    groundingToolsCalled: grounded,
  });
  result.grounding_contract_failed = grounding_contract_failed;

  if (grounding_contract_failed) {
    console.warn(
      `[performance-marketer post-run] grounding_contract_failed (run_id=${ctx.runId}) — scale/raise/cut without grounding tools`,
    );
    await ctx
      .emitProgress("completed", { code: "grounding_contract_failed" })
      .catch(() => undefined);
  }
}
