
import { createHash } from "node:crypto";

export const PATTERNS_MAX_PER_CALL = 5;
export const PATTERNS_MIN_RUNS = 10;
export const PATTERNS_MAX_RUNS = 100;
export const PATTERNS_TITLE_MAX = 80;
export const PATTERNS_BODY_MAX = 2000;
export const PATTERNS_DEDUP_WINDOW_DAYS = 30;
export const PATTERNS_COST_CAP_USD = 0.20;
export const PATTERNS_DAILY_COST_HARD_CAP_USD = 0.50;

export function hashPatternTitle(title: string): string {
  const norm = title.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16);
}

export type PatternArtifact = {
  title: string;
  body_markdown: string;
  evidence_run_ids: string[];
  theme_recurrence: number;
};

export function validatePatternArtifact(x: unknown): x is PatternArtifact {
  if (!x || typeof x !== "object") return false;
  const a = x as Partial<PatternArtifact>;
  if (typeof a.title !== "string" || a.title.length === 0) return false;
  if (a.title.length > PATTERNS_TITLE_MAX) return false;
  if (typeof a.body_markdown !== "string" || a.body_markdown.length === 0) return false;
  if (a.body_markdown.length > PATTERNS_BODY_MAX) return false;
  if (!Array.isArray(a.evidence_run_ids)) return false;
  if (a.evidence_run_ids.length === 0) return false;
  for (const id of a.evidence_run_ids) if (typeof id !== "string" || id.length === 0) return false;
  if (typeof a.theme_recurrence !== "number") return false;
  if (!Number.isFinite(a.theme_recurrence) || a.theme_recurrence < 1) return false;
  return true;
}

export function parsePatternArtifacts(raw: string): {
  artifacts: PatternArtifact[];
  invalid: number;
} {
  if (!raw || typeof raw !== "string") return { artifacts: [], invalid: 0 };

  let body = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(body);
  if (fence) body = fence[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { artifacts: [], invalid: 0 };
  }

  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { patterns?: unknown }).patterns)
    ? ((parsed as { patterns: unknown[] }).patterns)
    : [];

  const artifacts: PatternArtifact[] = [];
  let invalid = 0;
  for (const c of candidates) {
    if (validatePatternArtifact(c)) {
      artifacts.push(c);
      if (artifacts.length >= PATTERNS_MAX_PER_CALL) break;
    } else {
      invalid++;
    }
  }
  return { artifacts, invalid };
}

export type AgentRunSnippet = {
  run_id: string;
  agent_slug: string;
  finished_at: string;
  output_text: string;
};

const PER_RUN_SNIPPET_CHARS = 1000;

export function buildPatternsPrompt(runs: AgentRunSnippet[]): string {
  const blocks = runs.map((r, i) => {
    const trimmed = r.output_text.length > PER_RUN_SNIPPET_CHARS
      ? r.output_text.slice(0, PER_RUN_SNIPPET_CHARS) + "[truncated]"
      : r.output_text;
    return `<run idx="${i}" run_id="${r.run_id}" agent="${r.agent_slug}" finished_at="${r.finished_at}">\n${trimmed}\n</run>`;
  }).join("\n\n");

  return `You are analyzing ${runs.length} agent_run outputs from the last 30 days for one tenant.

Identify cross-session THEMES that recur >=3 times across these runs. A theme is a
recurring problem class, decision pattern, or operational concern that the operator
would benefit from seeing called out.

Return JSON only. No prose. Format:

{
  "patterns": [
    {
      "title": "<= 80 chars, present-tense, specific",
      "body_markdown": "<= 2000 chars; 2-4 sentences describing the pattern + 1-2 example specifics",
      "evidence_run_ids": ["run_id_a", "run_id_b", ...],
      "theme_recurrence": <number, 3 or more, count of runs this pattern was observed in>
    }
  ]
}

Hard rules:
- Maximum ${PATTERNS_MAX_PER_CALL} patterns.
- Each pattern's evidence_run_ids must be from the provided run_id list.
- theme_recurrence must be >= 3.
- Skip themes you only see once or twice - those are noise.
- If no theme recurs >=3 times, return {"patterns": []}.

THE RUNS:

${blocks}`;
}

export const SONNET_INPUT_PRICE_PER_M = 2;
export const SONNET_OUTPUT_PRICE_PER_M = 10;
const ASSUMED_OUTPUT_TOKENS = 5000;

export function estimatePatternCostUsd(promptChars: number): number {
  const inputTokens = Math.ceil(promptChars / 4);
  const inputCost = (inputTokens / 1_000_000) * SONNET_INPUT_PRICE_PER_M;
  const outputCost = (ASSUMED_OUTPUT_TOKENS / 1_000_000) * SONNET_OUTPUT_PRICE_PER_M;
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

export function maxRunsUnderCostCap(
  runs: AgentRunSnippet[],
  capUsd: number = PATTERNS_COST_CAP_USD,
): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const prompt = buildPatternsPrompt(runs.slice(0, mid));
    const cost = estimatePatternCostUsd(prompt.length);
    if (cost <= capUsd) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
