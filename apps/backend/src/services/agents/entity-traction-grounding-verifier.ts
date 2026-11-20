
import type { ToolCallTrace } from "@/services/tools/types";

export const ENTITY_TRACTION_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "operator",
  "advisor",
  "chief-of-staff",
  "pm",
  "growth-lead",
]);

export type EntityTractionGuardMode = "off" | "shadow" | "hedge";

export function entityTractionGuardMode(): EntityTractionGuardMode {
  const raw = (process.env.ENTITY_TRACTION_GUARD_MODE ?? "").trim().toLowerCase();
  return raw === "shadow" || raw === "hedge" ? raw : "off";
}

const TRACTION_PATTERNS: readonly RegExp[] = [
  /\b\d+\s+(?:live\s+)?pilots?\b/i,
  /\b(?:we\s+have|we'?ve\s+got|there\s+are|secured|signed|landed|running)\b[^.?!]*\b(?:live\s+)?pilots?\b/i,
  /\breference\s+(?:customers?|calls?|accounts?)\b/i,
  /\b\d+\s+design\s+partners?\b/i,
  /\b(?:we\s+have|signed|onboarded|with)\b[^.?!]*\bdesign\s+partners?\b/i,
  /\b(?:\d+\s+)?(?:LOIs?|letters?\s+of\s+intent)\b/i,
  /\b(?:operators?|users?|customers?|they)\s+(?:don'?t|never)\s+(?:go\s+back|churn|leave|cancel)\b/i,
  /\b\d+\s+(?:paying\s+)?(?:customers?|users?|operators?|subscribers?)\b/i,
];

const INVESTOR_CONTEXT =
  /\b(angels?|investors?|venture\s+capital|\bVCs?\b|seed\s+round|cap\s+table|SAFE\b|fundrais\w*|\braise\b|term\s+sheet|check\s+size)\b/i;

const PROPER_NAME = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z'’]+){1,2}\b/g;

const HYPOTHETICAL =
  /\b(e\.g\.|i\.e\.|for\s+example|such\s+as|like\s+(?:a|an|the|people|ex-)|people\s+like|hypothetical|imagine|say\s+you|you'?d\s+want|could\s+(?:approach|target|reach)|might\s+(?:approach|target)|for\s+instance|the\s+kind\s+of)\b/i;

const ILLUSTRATIVE_ENUM =
  /\b(?:lenders?|investors?|angels?|vcs?|firms?|funds?|banks?|providers?|platforms?|competitors?|companies|players|tools?|vendors?|options?)\s+(?:like|such\s+as|including)\b/i;
const LIKE_PROPER = /\blike\s+[A-Z][a-z]/;
const PAREN_LIST = /\([^)]*[A-Z][a-z]+[^)]*,[^)]*\)/;

const TARGET_VERB =
  /\b(?:reach\s+out|target(?:ing)?|contact|email|intro(?:duce)?|pitch|ask|prioriti[sz]e|approach|hit\s+up|connect\s+with|dm|start\s+with|go\s+after|line\s+up)\b/i;

const RECOMMEND_FRAMING =
  /\b(?:strong\s+fits?|good\s+fits?|best\s+fits?|best\s+bets?|top\s+(?:picks?|targets?|angels?|choices?)|shortlist|short-list|recommend|suggest|your\s+(?:best|ideal)|ideal\s+(?:for|targets?)|worth\s+(?:approaching|targeting))\b/i;

function isIllustrativeNameList(sentence: string): boolean {
  if (TARGET_VERB.test(sentence) || RECOMMEND_FRAMING.test(sentence)) return false;
  return ILLUSTRATIVE_ENUM.test(sentence) || LIKE_PROPER.test(sentence) || PAREN_LIST.test(sentence);
}

const HONEST_NEGATION =
  /\b(no\s+(?:paying\s+)?(?:pilots?|customers?|traction|design\s+partners?|revenue)|zero\s+\w+|pre-?revenue|don'?t\s+have|haven'?t\s+\w+\s+yet|can'?t\s+(?:pull|state|verify|ground|confirm)|won'?t\s+(?:state|claim)|isn'?t\s+connected|not\s+connected|no\s+verified)\b/i;

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function buildEvidenceHaystack(
  toolCalls: readonly ToolCallTrace[],
  userMessage: string,
): string {
  const parts: string[] = [lc(userMessage)];
  for (const t of toolCalls) {
    if (typeof t?.name !== "string" || t.name.startsWith("memory__")) continue;
    parts.push(lc(t.output_preview));
  }
  return parts.join("\n");
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+|(?=^\s*(?:[-*]|\d+[.)])\s)/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type EntityTractionFlags = {
  classes: string[];
  samples: string[];
};

export type EntityTractionResult = {
  hedged: boolean;
  text: string;
  flags: EntityTractionFlags;
};

function buildBanner(flags: EntityTractionFlags, mergeFigure?: string | null): string {
  const lines: string[] = [];
  const names = flags.classes.includes("named_entity_list")
    ? flags.samples.filter((s) => !s.includes(" ") || /^[A-Z][a-z'’]*(\s+[A-Z][a-z'’]+){0,2}$/.test(s))
    : [];
  const figure = mergeFigure?.trim() || null;
  if (figure || names.length > 0) {
    const items = [figure, names.join(", ")].filter(Boolean).join("; ");
    const qualifier = figure ? "not from your live data" : "illustrative, not from your data";
    lines.push(`> ⚠️ **Unverified** (${qualifier}): ${items}.`);
  }
  if (flags.classes.includes("traction")) {
    const claim = flags.samples.find((s) => !names.includes(s));
    if (claim) lines.push(`> ⚠️ **Unverified claim** (not from your live data): ${claim.trim()}.`);
  }
  if (lines.length === 0) {
    lines.push("> ⚠️ **Unverified** (illustrative, not from your data).");
  }
  return lines.join("\n");
}

function sentenceNumberGrounded(sentence: string, haystack: string): boolean {
  const nums = sentence.match(/\b\d[\d,]*\b/g) ?? [];
  return nums.some((n) => n.length >= 1 && haystack.includes(n.replace(/,/g, "")));
}

export function verifyEntityTractionGrounding(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
  userMessage?: string;
  mergeFigure?: string | null;
}): EntityTractionResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = args.toolCalls ?? [];
  const haystack = buildEvidenceHaystack(toolCalls, args.userMessage ?? "");

  const classes = new Set<string>();
  const samples: string[] = [];

  if (INVESTOR_CONTEXT.test(reply)) {
    const names = Array.from(
      new Set((reply.match(PROPER_NAME) ?? []).map((n) => n.trim())),
    );
    if (names.length >= 3) {
      const ungrounded = names.filter((n) => !haystack.includes(n.toLowerCase()));
      if (ungrounded.length >= Math.ceil(names.length / 2)) {
        const assertedNames = ungrounded.filter((n) => {
          const host = splitSentences(reply).find((s) => s.includes(n)) ?? reply;
          return !HYPOTHETICAL.test(host) && !isIllustrativeNameList(host);
        });
        if (assertedNames.length >= 3) {
          classes.add("named_entity_list");
          samples.push(...assertedNames.slice(0, 3));
        }
      }
    }
  }

  for (const sentence of splitSentences(reply)) {
    if (HYPOTHETICAL.test(sentence) || HONEST_NEGATION.test(sentence)) continue;
    const hit = TRACTION_PATTERNS.find((p) => p.test(sentence));
    if (!hit) continue;
    const phrase = (sentence.match(hit) ?? [""])[0].toLowerCase();
    if (sentenceNumberGrounded(sentence, haystack)) continue;
    if (phrase && haystack.includes(phrase)) continue;
    classes.add("traction");
    samples.push(sentence.slice(0, 80));
    break;
  }

  const flags: EntityTractionFlags = {
    classes: Array.from(classes),
    samples: samples.slice(0, 5),
  };

  if (classes.size === 0) {
    return { hedged: false, text: reply, flags };
  }
  return { hedged: true, text: `${reply}\n\n${buildBanner(flags, args.mergeFigure)}`, flags };
}
