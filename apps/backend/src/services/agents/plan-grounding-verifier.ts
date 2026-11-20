
import type { GroundingReceiptKind } from "@/services/agents/engine/grounding-receipt-ledger";

export type PlanTextSurfaces = {
  title: string;
  sectionText: string[];
};

export type PlanGroundingVerdict = "ok" | "ungrounded" | "needs_disclosure";

export type PlanGroundingResult = {
  verdict: PlanGroundingVerdict;
  claims: string[];
};

const OWN_SYSTEM_CLAIM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:the\s+)?existing\s+[`'"]?[\w.$-]+[`'"]?\s+(?:tool|pipeline|function|endpoint|service|module)\b[^.]*\bwould\s+need\b/i,
    "existing-X-would-need",
  ],
  [
    /\b[`'"]?[\w]+[`'"]?\s+(?:needs?|requires?|would\s+require)\s+(?:a\s+)?(?:new\s+)?(?:`?video_type`?|branch|param(?:eter)?|flag|column|field|endpoint|migration)\b/i,
    "X-needs-a-new-Y",
  ],
  [
    /\badd\s+(?:a\s+new\s+)?[`'"]?(?:video_type|param|flag|branch|column|field|endpoint)[`'"]?[^.]*\bto\s+[`'"]?[\w]+/i,
    "add-Y-to-X",
  ],
  [
    /\bconnect\s+(?:the\s+)?[\w.\s-]{0,40}?(?:MCP|connector)\b/i,
    "connect-the-X",
  ],
  [
    /\balready\s+(?:shipped|built|wired|exists?|integrated|live|connected|implemented)\b/i,
    "already-built",
  ],
  [
    /\b(?:is\s+)?not\s+(?:yet\s+)?(?:built|wired|integrated|connected|implemented|shipped)\b|\b(?:isn'?t|aren'?t)\s+(?:built|wired|integrated|connected|implemented)\b/i,
    "not-built",
  ],
  [
    /\bwe\s+(?:just\s+)?need\s+to\s+(?:build|wire|add|implement|create|integrate)\b/i,
    "we-need-to-build",
  ],
  [
    /\b(?:hours?|days?|weeks?)\s+of\s+(?:engineering\s+)?(?:work|effort|build)\b/i,
    "effort-estimate",
  ],
  [
    /\bnothing\s+(?:needs?\s+to\s+be\s+built|to\s+build)\b/i,
    "nothing-to-build",
  ],
];

const DISCLOSURE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnot\s+code[-\s]?grounded\b/i,
  /\bnot\s+(?:verified|grounded)\s+against\s+(?:your|the)\s+(?:code|codebase|repo|repository)\b/i,
  /\brepo(?:sitory)?\s+(?:is\s+)?not\s+connected\b/i,
  /\bcould\s+not\s+(?:verify|check)\s+(?:this\s+)?against\s+(?:your|the)\s+code\b/i,
];

function flatten(surfaces: PlanTextSurfaces): string {
  return [surfaces.title, ...surfaces.sectionText].join("\n");
}

export function detectOwnSystemClaims(surfaces: PlanTextSurfaces): string[] {
  const text = flatten(surfaces);
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const [re] of OWN_SYSTEM_CLAIM_PATTERNS) {
    const m = text.match(re);
    if (m && !seen.has(m[0].toLowerCase())) {
      seen.add(m[0].toLowerCase());
      hits.push(m[0].trim());
    }
  }
  return hits;
}

function hasDisclosure(surfaces: PlanTextSurfaces): boolean {
  const text = flatten(surfaces);
  return DISCLOSURE_PATTERNS.some((re) => re.test(text));
}

export function verifyPlanGrounding(args: {
  surfaces: PlanTextSurfaces;
  receipts: ReadonlySet<GroundingReceiptKind>;
  hasRepoConnector: boolean;
}): PlanGroundingResult {
  const { surfaces, receipts, hasRepoConnector } = args;
  const claims = detectOwnSystemClaims(surfaces);
  if (claims.length === 0) return { verdict: "ok", claims: [] };

  if (receipts.has("repo_read")) return { verdict: "ok", claims };

  if (!hasRepoConnector) {
    return hasDisclosure(surfaces)
      ? { verdict: "ok", claims }
      : { verdict: "needs_disclosure", claims };
  }

  return { verdict: "ungrounded", claims };
}
