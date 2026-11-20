
import { callModel } from "@/services/llm/call-model";
import { MODELS } from "@/services/llm/models";

export type CitedSource = { url: string; note: string | null };

export interface DraftToJudge {
  slug: string;
  body_markdown: string;
  cited_sources: CitedSource[];
}

export type JudgeVerdict = {
  verdict: "promote" | "hold";
  reason: string;
  unsupported_claims: string[];
};

export type JudgeFn = (prompt: string) => Promise<string>;

const MAX_BODY_CHARS = 4000;
const MAX_SOURCES = 12;
const MAX_NOTE_CHARS = 600;

export function buildJudgePrompt(draft: DraftToJudge): string {
  const sources =
    draft.cited_sources.length === 0
      ? "(NO sources were cited.)"
      : draft.cited_sources
          .slice(0, MAX_SOURCES)
          .map(
            (s, i) =>
              `[${i + 1}] ${s.url}\n    what the run read there: ${(s.note ?? "(no note recorded)").slice(0, MAX_NOTE_CHARS)}`,
          )
          .join("\n");

  return `You are verifying whether a COMPANY-BRAIN anchor is SUPPORTED by its cited sources BEFORE it becomes canonical truth that autonomous agents will act on (write ads, answer customers, file disputes). A wrong anchor here poisons every agent for this company, so your bias is SKEPTICAL.

ANCHOR ("${draft.slug}"):
${draft.body_markdown.slice(0, MAX_BODY_CHARS)}

CITED SOURCES (url + what the discovery run actually read on that page):
${sources}

Decide PROMOTE vs HOLD:
- Go claim by claim through the anchor. A "material claim" = a number, price, fee, policy, guarantee, timeframe, contact detail, or a specific factual assertion about the company.
- PROMOTE only if EVERY material claim is clearly backed by at least one cited source note above.
- HOLD if ANY material claim is unsupported, if a number/policy in the body appears in no citation, if the body INFERS a conclusion the sources do not state, or if there are NO cited sources.
- When in doubt, HOLD. A false PROMOTE is far worse than a false HOLD (a held draft just waits for a human).

Respond with ONLY a JSON object, no prose:
{"verdict":"promote"|"hold","reason":"<one sentence>","unsupported_claims":["<claim>", ...]}`;
}

export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const hold = (reason: string): JudgeVerdict => ({ verdict: "hold", reason, unsupported_claims: [] });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return hold("judge returned no JSON — held (fail-closed)");
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return hold("judge returned invalid JSON — held (fail-closed)");
  }
  const o = obj as Record<string, unknown>;
  const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : "(no reason given)";
  if (o.verdict !== "promote") {
    return { verdict: "hold", reason, unsupported_claims: [] };
  }
  if (!Array.isArray(o.unsupported_claims)) {
    return { verdict: "hold", reason: "promote verdict missing unsupported_claims — malformed, held (fail-closed)", unsupported_claims: [] };
  }
  const unsupported = o.unsupported_claims.filter((c): c is string => typeof c === "string");
  if (unsupported.length > 0) {
    return { verdict: "hold", reason: `promote claimed but ${unsupported.length} unsupported claim(s) listed — held`, unsupported_claims: unsupported };
  }
  return { verdict: "promote", reason, unsupported_claims: [] };
}

export async function judgeDraftWith(draft: DraftToJudge, judge: JudgeFn): Promise<JudgeVerdict> {
  if (draft.cited_sources.length === 0) {
    return { verdict: "hold", reason: "no cited sources to verify against", unsupported_claims: [] };
  }
  if (!draft.body_markdown.trim()) {
    return { verdict: "hold", reason: "empty draft body", unsupported_claims: [] };
  }
  let raw: string;
  try {
    raw = await judge(buildJudgePrompt(draft));
  } catch (e) {
    return { verdict: "hold", reason: `judge call failed: ${(e as Error).message}`, unsupported_claims: [] };
  }
  return parseJudgeVerdict(raw);
}

export const claudeJudge: JudgeFn = async (prompt: string) => {
  const res = await callModel({
    provider: "anthropic",
    model: MODELS.anthropic.haiku,
    system:
      "You are a strict fact-checker for a company knowledge base. You verify claims against sources and default to rejecting anything not clearly supported. You reply with only JSON.",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 700,
    temperature: 0,
    maxAttempts: 2,
  });
  return res.text;
};

export function judgeDraft(draft: DraftToJudge): Promise<JudgeVerdict> {
  return judgeDraftWith(draft, claudeJudge);
}
