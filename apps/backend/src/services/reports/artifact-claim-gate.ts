
import { z } from "zod";
import { MODELS } from "@/services/llm/models";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";
import {
  runReasoningCritic,
  type ParsedReasoningCritic,
} from "@/services/critic/reasoning-critic";
import { isPmCriticXfamilyEnabled } from "@/agents/pm/pm-critic-xfamily-flag";
import type { PlanTextSurfaces } from "@/services/agents/plan-grounding-verifier";

const GATE_MODEL = MODELS.anthropic.haiku;
const GATE_MAX_TOKENS = 900;
const GATE_TIMEOUT_MS = 20_000;
const GATE_FINDING_CAP = 6;

const findingSchema = z.object({
  claim: z.string().min(1).max(300),
  why: z.string().min(1).max(400),
});
export type ArtifactClaimFinding = z.infer<typeof findingSchema> & {
  reviewer: "anthropic" | "openai";
};

const resultSchema = z.object({
  verdict: z.enum(["ok", "revise"]),
  findings: z.array(findingSchema).max(GATE_FINDING_CAP).default([]),
});

const SYSTEM_PROMPT = `You review a DRAFT document that is about to be rendered and delivered to the operator who requested it. You are the last check before it becomes a file they download.

Your ONLY job: find confident assertions about how the OPERATOR'S OWN systems, repositories, services, or products are wired that the document does not ground.

Flag a claim when ALL of these hold:
- It asserts something factual about the operator's own architecture — what lives in which repo or layer, whether two systems share infrastructure, what is or is not already built, what a component does.
- It is stated confidently, as established fact, not as an assumption or open question.
- The document does not say what established it — no cited file or path, no named source, no stated basis, and no acknowledgement that it is unverified.

The highest-risk shapes, flag these especially:
- "X and Y are independent / share nothing / are separate systems"
- "X lives in <repo/layer>" or "X is handled by <component>"
- "X is not built yet" / "there is no existing X"
Each is checkable, load-bearing for whatever the document recommends, and invisible to a reader who does not know the codebase.

Do NOT flag:
- Claims the document grounds (cites a file, names a source, or explicitly marks unverified).
- Recommendations, opinions, estimates, plans, or tradeoffs. Those are judgment, not fact.
- Claims about third parties, vendors, or the wider world. Only the operator's own systems.
- Vague or hedged statements ("likely", "probably", "we should check whether").

Return verdict "revise" ONLY if you found at least one flagged claim; otherwise "ok" with an empty findings array. Be conservative: a false refusal blocks a legitimate deliverable and costs the operator a retry. When genuinely unsure, return "ok".

Respond with ONLY this JSON, no prose:
{"verdict":"ok"|"revise","findings":[{"claim":"<the claim, quoted or closely paraphrased>","why":"<why the document fails to ground it>"}]}`;

const OPENAI_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["ok", "revise"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "why"],
        properties: {
          claim: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
};

function parseResult(raw: string): ParsedReasoningCritic<z.infer<typeof findingSchema>> {
  try {
    const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return { ok: false, error: "no_json_object" };
    }
    const parsed = resultSchema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
    if (!parsed.success) {
      return { ok: false, error: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
    }
    return {
      ok: true,
      verdict: parsed.data.verdict,
      findings: parsed.data.findings,
      reversal_triggers_present: undefined,
    };
  } catch (e) {
    return { ok: false, error: `parse_error: ${(e as Error).message}` };
  }
}

const MAX_REVIEW_CHARS = 24_000;

function buildDocText(surfaces: PlanTextSurfaces): string {
  const body = [surfaces.title, ...surfaces.sectionText].filter(Boolean).join("\n\n");
  return body.length > MAX_REVIEW_CHARS ? `${body.slice(0, MAX_REVIEW_CHARS)}\n…[truncated]` : body;
}

export type ArtifactClaimGateResult = {
  verdict: "ok" | "refuse";
  findings: ArtifactClaimFinding[];
  cost_usd: number;
  lanes?: { anthropic: string; openai: string };
};

const OK: ArtifactClaimGateResult = { verdict: "ok", findings: [], cost_usd: 0 };

export async function checkArtifactClaims(args: {
  surfaces: PlanTextSurfaces;
  claims: string[];
  tenantId: string;
  runId: string;
  agentSlug: string;
}): Promise<ArtifactClaimGateResult> {
  try {
    if (args.claims.length === 0) return OK;

    let allowOpenAi = false;
    try {
      allowOpenAi = await isPmCriticXfamilyEnabled(args.tenantId);
    } catch {
      allowOpenAi = false;
    }

    const docText = buildDocText(args.surfaces);
    if (!docText.trim()) return OK;

    const critic = await runReasoningCritic<z.infer<typeof findingSchema>>({
      userMsg:
        "Review this DRAFT document that is about to be delivered to the operator.\n\n" +
        renderUntrustedBlock("draft_document", docText),
      systemPrompt: SYSTEM_PROMPT,
      anthropicModel: GATE_MODEL,
      maxTokens: GATE_MAX_TOKENS,
      openAiJsonSchema: OPENAI_JSON_SCHEMA,
      openAiSchemaName: "artifact_claim_review",
      parseResult,
      tags: { tenantId: args.tenantId, agentSlug: args.agentSlug, runId: args.runId },
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
      findingCap: GATE_FINDING_CAP,
      allowOpenAi,
    });

    if (critic.verdict !== "revise" || critic.findings.length === 0) {
      return { verdict: "ok", findings: [], cost_usd: critic.cost_usd };
    }

    return {
      verdict: "refuse",
      findings: critic.findings as ArtifactClaimFinding[],
      cost_usd: critic.cost_usd,
      lanes: {
        anthropic: critic.lanes.anthropic.status,
        openai: critic.lanes.openai.status,
      },
    };
  } catch {
    return OK;
  }
}
