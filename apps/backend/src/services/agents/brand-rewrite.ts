
const BRAND_REWRITE_RULES: Array<{ re: RegExp; repl: string }> = [
  { re: /\bPraxis\s+(?:platform|workspace|app|dashboard)\b/g, repl: "Zavi" },
  { re: /\bPraxis\b/g, repl: "Zavi" },
];

export function rewriteBrandLeak(text: string): { text: string; hits: number } {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const { re, repl } of BRAND_REWRITE_RULES) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      hits++;
      return repl;
    });
  }
  return { text: out, hits };
}

const ZAVI_ARCHITECTURE_LEAK_RE: RegExp[] = [
  /\bfleet of \d+\s+(?:core\s+|specialist\s+)?agents?\b/i,
  /\b\d+\s+core\s+(?:specialist\s+)?agents?\b/i,
  /\b\d+\s+(?:additional|specialist|hidden|disabled)\s+agents?\b/i,
  /\bvisibility API\b/i,
  /\brow[- ]?flip\b/i,
  /\btenant_agents\b/i,
  /praxis__/i,
  /\bcompany brain\b/i,
  /\bdream[- ]?cycle\b/i,
  /\bautonomy tier\b/i,
  /\bstaff visibility\b/i,
  /\bagent fleet\b/i,
  /\bAI cofounder (?:team|agent)\b/i,
  /\b(?:connect|connects|connected|integrat\w+)\b[^.]*?\b(?:Slack|GitHub|Jira|Stripe|Google Ads|Meta Ads|operator database)\b[^.]*?\b(?:Slack|GitHub|Jira|Stripe|Google Ads|Meta Ads|operator database)\b[^.]*?\b(?:Slack|GitHub|Jira|Stripe|Google Ads|Meta Ads|operator database)\b[^.]*?\b(?:Slack|GitHub|Jira|Stripe|Google Ads|Meta Ads|operator database)\b/i,
];

export const ARCHITECTURE_LEAK_FALLBACK =
  "Happy to help. I can put together things like a product overview, an onboarding starter doc, updates, or research, grounded in your team's own context. What would you like me to start with?";

export function scrubZaviArchitectureLeak(text: string): {
  text: string;
  blocked: boolean;
  hits: string[];
} {
  if (!text) return { text, blocked: false, hits: [] };
  const hits: string[] = [];
  for (const re of ZAVI_ARCHITECTURE_LEAK_RE) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  if (hits.length === 0) return { text, blocked: false, hits };
  return { text: ARCHITECTURE_LEAK_FALLBACK, blocked: true, hits };
}

const ZAVI_INTERNAL_TELLS_REDACT_RE: RegExp[] = [
  /\bfleet of \d+\s+(?:core\s+|specialist\s+)?agents?\b/gi,
  /\b\d+\s+core\s+(?:specialist\s+)?agents?\b/gi,
  /\b\d+\s+(?:additional|specialist|hidden|disabled)\s+agents?\b/gi,
  /\bvisibility API\b/gi,
  /\brow[- ]?flip\b/gi,
  /\btenant_agents\b/gi,
  /praxis__[a-z_]*/gi,
  /\bcompany brain\b/gi,
  /\bdream[- ]?cycle\b/gi,
  /\bautonomy tier\b/gi,
  /\bstaff visibility\b/gi,
];

export function redactZaviArchitectureLeak(text: string): {
  text: string;
  hits: number;
} {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const re of ZAVI_INTERNAL_TELLS_REDACT_RE) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      hits++;
      return "[internal]";
    });
  }
  return { text: out, hits };
}
