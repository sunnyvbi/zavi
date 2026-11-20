
import type { ToolCallTrace } from "@/services/tools/types";

export const EXTERNAL_ARTIFACT_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "operator",
  "content-design",
  "growth-lead",
  "performance-marketer",
  "support-lead",
]);

export type ExternalArtifactGuardMode = "off" | "shadow" | "warn";

export function externalArtifactGuardMode(): ExternalArtifactGuardMode {
  const raw = (process.env.EXTERNAL_ARTIFACT_GUARD_MODE ?? "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "shadow") return "shadow";
  return "warn";
}

export type ExternalClaimClass =
  | "launch_state"
  | "geo_rollout"
  | "product_capability"
  | "plan_pricing";

export interface ExternalClaimFlag {
  claimClass: ExternalClaimClass;
  sentence: string;
  ungrounded: string[];
}

export interface ExternalArtifactVerdict {
  hedged: boolean;
  text: string;
  flags: ExternalClaimFlag[];
}

const ARTIFACT_REQUEST =
  /\b(?:draft|write|prepare|compose|create|make|revise|rewrite|punch\s+up)\b[^.?!]{0,80}\b(?:e-?mail|announcement|newsletter|blast|campaign|press\s+release|blog\s+post|social\s+post|linkedin\s+post|push\s+notification)\b/i;

const ARTIFACT_SHAPE =
  /^\s*(?:\*\*)?subject(?:\s+line)?(?:\*\*)?\s*:/im;

export function looksLikeExternalArtifact(reply: string, userMessage: string): boolean {
  return ARTIFACT_REQUEST.test(userMessage) || ARTIFACT_SHAPE.test(reply);
}

const LAUNCH_STATE =
  /\b(?:is|are|it'?s)\s+(?:now\s+)?live\b|\bjust\s+launch(?:ed|ing)\b|\bfinally\s+here\b|\bwe'?(?:ve|re)\s+(?:just\s+)?launch(?:ed|ing)\b|\bnow\s+(?:generally\s+)?available\b|\blaunch(?:ing|es)\s+(?:today|this\s+week|now)\b/i;

const GEO_ROLLOUT =
  /\b(?:starting|launching|live|rolling\s+out|available|expanding)\b[^.?!]{0,40}\bin\b\s+(?:the\s+)?[A-Z][a-zA-Z]+/;

const PRODUCT_CAPABILITY =
  /\byou\s+can\s+now\b|\bcan\s+(?:be\s+)?list(?:ed)?\s+for\s+sale\b|\bisn'?t\s+just\b[^.?!]{0,60}\banymore\b|\bnow\s+supports?\b|\bnow\s+lets?\s+you\b/i;

const PLAN_PRICING =
  /\$\s?\d[\d,]*(?:\.\d+)?\b|\b(?:Solo|Operator|Fleet|Empire|Pro|Starter|Enterprise|Premium)\s+plan\b|\bplan\s+and\s+above\b/i;

const CLAIM_MATCHERS: ReadonlyArray<{ cls: ExternalClaimClass; re: RegExp }> = [
  { cls: "launch_state", re: LAUNCH_STATE },
  { cls: "geo_rollout", re: GEO_ROLLOUT },
  { cls: "product_capability", re: PRODUCT_CAPABILITY },
  { cls: "plan_pricing", re: PLAN_PRICING },
];

const NAMED_PRODUCT = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/;

const LAUNCH_MARKER = /\b(?:live|launch(?:ed|ing)?|shipped|released|GA\b|rolled\s+out|available)\b/i;

const CAPABILITY_STOPWORDS = new Set([
  "your", "their", "them", "they", "this", "that", "with", "from", "into",
  "have", "just", "also", "only", "same", "more", "here", "will", "want",
  "each", "over", "even", "then", "than", "when", "what", "very", "much",
]);

const GEO_PLACE = /\bin\b\s+(?:the\s+)?((?:[A-Z][a-zA-Z]+)(?:\s+(?:and\s+)?[A-Z][a-zA-Z]+)*)/;

const CAPABILITY_PHRASE =
  /\b(list(?:ed)?\s+for\s+sale|for\s+sale|sell\s+(?:your|their)\s+\w+|now\s+supports?\s+[\w\s]{3,30}|now\s+lets?\s+you\s+[\w\s]{3,30}|can\s+now\s+[\w\s]{3,30})/i;

function markerNearEntity(haystack: string, entity: string, window = 100): boolean {
  const ent = entity.toLowerCase();
  let idx = haystack.indexOf(ent);
  while (idx >= 0) {
    const from = Math.max(0, idx - window);
    const slice = haystack.slice(from, idx + ent.length + window);
    if (LAUNCH_MARKER.test(slice)) return true;
    idx = haystack.indexOf(ent, idx + ent.length);
  }
  return false;
}

function ungroundedFor(
  cls: ExternalClaimClass,
  sentence: string,
  haystack: string,
): string[] {
  switch (cls) {
    case "launch_state": {
      const m = sentence.match(NAMED_PRODUCT);
      if (!m) return [];
      const entity = m[1];
      if (TOKEN_STOPWORDS.has(entity.toLowerCase())) return [];
      return markerNearEntity(haystack, entity) ? [] : [entity];
    }
    case "geo_rollout": {
      const m = sentence.match(GEO_PLACE);
      if (!m) return [];
      const place = m[1].trim();
      if (TOKEN_STOPWORDS.has(place.toLowerCase())) return [];
      return haystack.includes(place.toLowerCase()) ? [] : [place];
    }
    case "product_capability": {
      const m = sentence.match(CAPABILITY_PHRASE);
      if (!m) return [];
      const phrase = m[1].trim();
      const contentWords = phrase
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 4 && !CAPABILITY_STOPWORDS.has(w));
      if (contentWords.length === 0) return [];
      return contentWords.some((w) => haystack.includes(w)) ? [] : [phrase];
    }
    case "plan_pricing": {
      const out: string[] = [];
      for (const t of salientTokens(sentence)) {
        const isFigure = t.startsWith("$");
        const isTier = /\b(Solo|Operator|Fleet|Empire|Pro|Starter|Enterprise|Premium)\b/.test(t);
        if (!isFigure && !isTier) continue;
        if (!haystack.includes(t.toLowerCase())) out.push(t);
      }
      return out;
    }
  }
}

const NOT_AN_ASSERTION =
  /\b(?:e\.g\.|i\.e\.|for\s+example|for\s+instance|such\s+as|imagine|hypothetical|placeholder|if\s+you'?(?:re|d)|would\s+you\s+like|want\s+me\s+to|should\s+I|do\s+you\s+want|I\s+can\s+add|let\s+me\s+know|not\s+(?:yet\s+)?live|isn'?t\s+live|can'?t\s+(?:confirm|verify|ground))\b/i;

const META_LINE = /^\s*(?:key\s+changes|here'?s|notes?\s+before|a\s+few\s+notes|removed|dropped|i\s+kept|let\s+me\s+know|want\s+a\s+version)/i;

function stripMarkdown(text: string): string {
  return text.replace(/[*_`~]+/g, "");
}

function splitSentences(text: string): string[] {
  return stripMarkdown(text)
    .split(/\n+/)
    .flatMap((line) => (META_LINE.test(line) ? [] : line.split(/(?<=[.!?])\s+/)))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const TOKEN_STOPWORDS = new Set([
  "the", "your", "you", "our", "we", "instead", "big", "new", "now", "and", "but", "so",
  "here", "hi", "hey", "hello", "that", "this", "it", "if", "for", "with", "from", "on",
  "in", "at", "to", "a", "an", "no", "yes", "same", "just", "still", "all", "questions",
  "subject", "settings", "reply", "team", "plan", "plans", "available", "live", "email",
]);

function salientTokens(sentence: string): string[] {
  const out = new Set<string>();
  for (const m of sentence.matchAll(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\b/g)) {
    const tok = m[0].trim();
    if (tok.length < 3) continue;
    if (TOKEN_STOPWORDS.has(tok.toLowerCase())) continue;
    out.add(tok);
  }
  for (const m of sentence.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?/g)) out.add(m[0].replace(/\s/g, ""));
  return [...out];
}

const THREAD_EXCERPT_HEADER = "## Slack thread so far";

export function extractThreadExcerpt(promptSnapshot: string): string {
  const start = promptSnapshot.indexOf(THREAD_EXCERPT_HEADER);
  if (start < 0) return "";
  const rest = promptSnapshot.slice(start + THREAD_EXCERPT_HEADER.length);
  const end = rest.search(/\n##\s/);
  return end < 0 ? rest : rest.slice(0, end);
}

function buildEvidenceHaystack(
  toolCalls: readonly ToolCallTrace[],
  userMessage: string,
  promptSnapshot: string,
): string {
  const parts: string[] = [userMessage, extractThreadExcerpt(promptSnapshot)];
  for (const t of toolCalls ?? []) {
    if (typeof t?.name !== "string" || t.name.startsWith("memory__")) continue;
    parts.push(typeof t.output_preview === "string" ? t.output_preview : "");
  }
  return stripMarkdown(parts.join("\n")).toLowerCase();
}

export interface ExternalArtifactInput {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
  userMessage?: string;
  promptSnapshot?: string;
}

const BANNER_HEAD =
  "⚠️ *Unverified claims in this draft — check before sending.* I introduced the following statements without grounding them in a tool result, the thread, or your own words:";
const BANNER_TAIL =
  "_Everything else in the draft traces back to a source. Tell me to verify or cut these before this goes out._";

export function verifyExternalArtifactClaims(
  input: ExternalArtifactInput,
): ExternalArtifactVerdict {
  const reply = typeof input.reply === "string" ? input.reply : "";
  const userMessage = typeof input.userMessage === "string" ? input.userMessage : "";
  const promptSnapshot =
    typeof input.promptSnapshot === "string" ? input.promptSnapshot : "";
  const toolCalls = input.toolCalls ?? [];

  const none: ExternalArtifactVerdict = { hedged: false, text: reply, flags: [] };
  if (!reply.trim()) return none;
  if (!looksLikeExternalArtifact(reply, userMessage)) return none;

  const haystack = buildEvidenceHaystack(toolCalls, userMessage, promptSnapshot);
  const flags: ExternalClaimFlag[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(reply)) {
    if (NOT_AN_ASSERTION.test(sentence)) continue;
    for (const { cls, re } of CLAIM_MATCHERS) {
      if (!re.test(sentence)) continue;

      const ungrounded = ungroundedFor(cls, sentence, haystack);
      if (ungrounded.length === 0) continue;

      const key = `${cls}::${ungrounded.join("|")}`;
      if (seen.has(key)) continue;
      seen.add(key);

      flags.push({
        claimClass: cls,
        sentence: sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence,
        ungrounded,
      });
    }
  }

  if (flags.length === 0) return none;

  const lines = flags.map((f) => `• _${f.claimClass}_ — "${f.sentence}"`);
  const banner = [BANNER_HEAD, ...lines, "", BANNER_TAIL].join("\n");
  return { hedged: true, text: `${banner}\n\n---\n\n${reply}`, flags };
}
