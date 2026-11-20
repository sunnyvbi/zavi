
export const LENS_CITATION_AGENTS: ReadonlySet<string> = new Set([]);

const LENS_ALIASES: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  "growth-lead": [
    ["vanity-vs-actionable", "vanity metric"],
    ["cac:ltv", "ltv:cac", "cac/ltv", "ltv/cac"],
    ["leaky-bucket", "leaky bucket", "retention-before-acquisition", "retention before acquisition"],
    ["aarrr", "pirate funnel"],
    ["north-star", "north star"],
    ["bullseye"],
    ["quick ratio", "growth accounting"],
    ["sean ellis"],
    ["power-user curve", "power user curve", "l28"],
    ["retention curve", "retention-curve", "curve flatten"],
  ],
  "performance-marketer": [
    ["mer", "marketing efficiency ratio"],
    ["incrementality", "geo-holdout", "geo holdout", "lift test", "holdout"],
    ["sample sufficiency", "statistical significance"],
    ["marginal roas", "marginal (not average)", "marginal dollar"],
    ["above-click", "below-click", "below the click", "above the click"],
    ["attribution-window", "attribution window", "prospecting lag"],
    ["pixel health", "pixel/tracking health", "tracking health"],
    ["correlation-vs-causation", "correlation vs causation", "correlation-vs.-causation"],
    ["creative fatigue", "frequency cap"],
    ["scope-honesty", "active-in-window"],
  ],
};

const JUDGMENT_MARKERS =
  /\b(bet|recommend|propos|prioriti|diagnos|scale|cut|pause|reallocat|constraint|hypothes|scoreboard|new tests|funnel|tier\s*1|digest)\b/i;
const MIN_JUDGMENT_CHARS = 400;

export interface LensCitationResult {
  judgmentClass: boolean;
  cited: boolean;
  hitCount: number;
}

export function isJudgmentClassOutput(reply: string): boolean {
  if (typeof reply !== "string") return false;
  if (reply.trim().length < MIN_JUDGMENT_CHARS) return false;
  return JUDGMENT_MARKERS.test(reply);
}

export function checkLensCitation(agentSlug: string, reply: string): LensCitationResult {
  const lenses = LENS_ALIASES[agentSlug];
  const judgmentClass = isJudgmentClassOutput(reply);
  if (!lenses || !judgmentClass) {
    return { judgmentClass, cited: false, hitCount: 0 };
  }
  const hay = reply.toLowerCase();
  let hitCount = 0;
  for (const aliases of lenses) {
    if (aliases.some((a) => hay.includes(a))) hitCount++;
  }
  return { judgmentClass, cited: hitCount > 0, hitCount };
}
