
import type { ToolCallTrace } from "@/services/tools/types";

export const ROAS_SAMPLE_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "performance-marketer",
]);

const ROAS_TOKEN =
  /\b(?:roas|return\s+on\s+ad\s+spend)\b[^.!?:\n]{0,20}?\b\d+(?:\.\d+)?\s?(?:x\b|×)|\d+(?:\.\d+)?\s?(?:x\b|×)[^.!?:\n]{0,12}?\b(?:roas|return\s+on\s+ad\s+spend)\b/i;

const ACTION_KEYWORD =
  /\b(?:scale|scaling|scale\s+up|raise|increase|boost|ramp|pour|double|kill|pause|cut|stop|turn\s+off|defund|reallocat\w*|shift\s+budget|move\s+budget)\b/i;

const PURCHASE_COUNT =
  /\b(?:n\s*=\s*\d+|\d+\s+purchases?)\b/i;

const RAISE_KEYWORD =
  /\b(?:raise|raising|increase|increasing|boost|ramp|ramping|pour|double|scale|scaling|bump|shift\s+budget\s+toward|move\s+budget\s+toward)\b(?!\s+(?:down|back))/i;

const MIN_PURCHASES_FOR_RAISE = 10;
const MAX_RAISE_STEP_PCT = 0.3;
const MIN_RAISE_STEP_ABS_USD = 10;

function budgetStepInProposeToolInputs(
  step: { from: number; to: number },
  toolCalls: readonly ToolCallTrace[],
): boolean {
  const PROPOSE_TOOLS = [
    "meta_ads__propose_budget_change",
    "google_ads__propose_budget_change",
    "meta_ads_propose_budget_change",
    "google_ads_propose_budget_change",
  ];
  return toolCalls
    .filter((t) =>
      PROPOSE_TOOLS.some((p) => t.name.toLowerCase().includes("propose_budget")),
    )
    .some((t) => {
      const inp = t.input_preview ?? "";
      return inp.includes(String(step.from)) && inp.includes(String(step.to));
    });
}

function purchaseCountValue(sentence: string): number | null {
  const m = sentence.match(/\bn\s*=\s*(\d+)\b|\b(\d+)\s+purchases?\b/i);
  if (!m) return null;
  const v = parseInt(m[1] ?? m[2], 10);
  return Number.isFinite(v) ? v : null;
}

function budgetStep(sentence: string): { from: number; to: number } | null {
  const m = sentence.match(
    /\$\s*(\d+(?:\.\d+)?)\s*(?:\/\s*day)?\s*(?:->|→|=>|\bto\b)\s*\$?\s*(\d+(?:\.\d+)?)/i,
  );
  if (!m) return null;
  const from = parseFloat(m[1]);
  const to = parseFloat(m[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return { from, to };
}

export type RoasSampleFlags = {
  has_scale_roas_claim: boolean;
  ungrounded_sentences: string[];
  low_sample_raises: string[];
  oversized_step_raises: string[];
};

export type RoasSampleVerificationResult = {
  hedged: boolean;
  text: string;
  flags: RoasSampleFlags;
};

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?:])\s+|\n+|\s*\|\s*/);
}

const RETRO_NARRATION =
  /\b(?:rejected|improved|fell|deteriorated|materiali[sz]ed|bounced|hypothesis|readout|measured|confirmed|prior\s+(?:week|period|settled)|last\s+(?:week|period)|→)\b/i;

function hasAdjacentPurchaseCount(sentences: string[], i: number): boolean {
  return [i - 1, i, i + 1]
    .filter((j) => j >= 0 && j < sentences.length)
    .some((j) => PURCHASE_COUNT.test(sentences[j]));
}

function buildHedgeBanner(): string {
  return [
    "> ⚠️ **Sample-size caution** — this reply recommends scaling / killing / reallocating budget off a ROAS with no stated purchase count (n).",
    "> A ROAS on a thin window (a 1–2 purchase week) is noise, not signal. Treat the recommendation as directional only; confirm the purchase count and window (prefer 30-day) before moving spend.",
    "",
    "",
  ].join("\n");
}

function buildRaiseRiskBanner(reasons: {
  lowSample: boolean;
  oversized: boolean;
}): string {
  const lines = [
    "> ⚠️ **Raise caution** — a senior ads manager would not approve this budget increase as written:",
  ];
  if (reasons.lowSample) {
    lines.push(
      "> • The attributed sample is under ~10 purchases — too thin to scale on. Hold and re-check at n≥10.",
    );
  }
  if (reasons.oversized) {
    lines.push(
      "> • The step is larger than +30% of current daily budget — that resets the learning phase. Scale in +30% steps instead.",
    );
  }
  lines.push("", "");
  return lines.join("\n");
}

export function verifyRoasSampleGrounding(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
}): RoasSampleVerificationResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const sentences = splitSentences(reply);
  const ungrounded: string[] = [];
  let anyCandidate = false;

  const lowSampleRaises: string[] = [];
  const oversizedRaises: string[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];

    if (
      ROAS_TOKEN.test(s) &&
      ACTION_KEYWORD.test(s) &&
      !RETRO_NARRATION.test(s)
    ) {
      anyCandidate = true;
      if (!hasAdjacentPurchaseCount(sentences, i)) ungrounded.push(s.trim());
    }

    if (!RAISE_KEYWORD.test(s)) continue;

    for (const j of [i - 1, i, i + 1]) {
      if (j < 0 || j >= sentences.length) continue;
      const n = purchaseCountValue(sentences[j]);
      if (n !== null && n < MIN_PURCHASES_FOR_RAISE) {
        lowSampleRaises.push(s.trim());
        break;
      }
    }

    const step = budgetStep(s);
    if (step) {
      const delta = step.to - step.from;
      if (
        delta > step.from * MAX_RAISE_STEP_PCT &&
        delta > MIN_RAISE_STEP_ABS_USD &&
        !budgetStepInProposeToolInputs(step, args.toolCalls ?? [])
      ) {
        oversizedRaises.push(s.trim());
      }
    }
  }

  const flags: RoasSampleFlags = {
    has_scale_roas_claim: anyCandidate,
    ungrounded_sentences: ungrounded,
    low_sample_raises: lowSampleRaises,
    oversized_step_raises: oversizedRaises,
  };

  const raiseRisk = lowSampleRaises.length > 0 || oversizedRaises.length > 0;

  if (ungrounded.length === 0 && !raiseRisk) {
    return { hedged: false, text: reply, flags };
  }

  let banner = "";
  if (ungrounded.length > 0) banner += buildHedgeBanner();
  if (raiseRisk) {
    banner += buildRaiseRiskBanner({
      lowSample: lowSampleRaises.length > 0,
      oversized: oversizedRaises.length > 0,
    });
  }
  return {
    hedged: true,
    text: reply.replace(/\s+$/, "") + "\n\n" + banner.replace(/\n+$/, "") + "\n",
    flags,
  };
}
