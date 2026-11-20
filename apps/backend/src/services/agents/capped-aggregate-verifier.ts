
import type { ToolCallTrace } from "@/services/tools/types";
import { unescapeJsonPreview } from "@/services/tools/types";

const STRONG_ACCOUNT_SCOPE =
  /\b(?:total|totals|overall|blended|account[- ]?(?:wide|level)?|portfolio|combined|in aggregate|across (?:all |every )?(?:campaigns|ad ?sets|ads|ad groups)|all (?:campaigns|ad ?sets|ads|ad groups))\b/i;

const TIME_WINDOW_SCOPE =
  /\b(?:last \d+ ?(?:d|days|weeks?|months?)|(?:this|past|previous|last) (?:week|month|quarter)|year[- ]to[- ]date|ytd)\b/i;

const ENTITY_NOUN = /\b(?:campaign|ad ?set|ad group|creative|placement|audience)\b/i;

const ENTITY_NAMED = [
  /["'][^"']{2,60}["']\s*(?:campaign|ad ?set|ad group|creative)\b/i,
  /\b(?:campaign|ad ?set|ad group|creative)\s+["'][^"']{2,60}["']/i,
  /\b[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,4}\s+(?:campaign|ad ?set|ad group|creative)\b/,
  /\b(?:campaign|ad ?set|ad group)\s+(?:id\s*)?[0-9]{6,}/i,
];

function namesOneEntity(sentence: string): boolean {
  return ENTITY_NOUN.test(sentence) && ENTITY_NAMED.some((re) => re.test(sentence));
}

const AGGREGATE_METRIC = [
  /\b(?:roas|return on ad spend)\b[^.!?\n]{0,24}?\d+(?:\.\d+)?\s?(?:x\b|×)/i,
  /\d+(?:\.\d+)?\s?(?:x\b|×)[^.!?\n]{0,16}?\b(?:roas|return on ad spend)\b/i,
  /\b(?:cac|cpa|cost per (?:acquisition|booking|purchase|lead))\b[^.!?\n]{0,24}?\$?\d/i,
  /\$\s?[\d,]+(?:\.\d+)?[^.!?\n]{0,24}?\b(?:spent?|spend|revenue|budget)\b/i,
  /\b(?:spent?|spend|revenue)\b[^.!?\n]{0,24}?\$\s?[\d,]+/i,
  /\b(?:conversions?|purchases?|bookings?|leads?|impressions?|clicks?)\b[^.!?\n]{0,16}?[:\s]\s?[\d,]+/i,
  /[\d,]+\s+(?:conversions?|purchases?|bookings?|leads?|impressions?|clicks?)\b/i,
];

const SELF_SCOPED =
  /\b(?:of (?:the )?\d+\s+(?:shown|visible|returned|listed)|\d+\s+of\s+\d+|only the \w+ (?:shown|visible)|shown here|visible (?:rows|campaigns)|at least|so far|partial|incomplete|a floor|lower bound)\b/i;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isMemoryTool(name: string): boolean {
  return /(?:^|__|\.)memory(?:__|\.|_)/i.test(name) || name.startsWith("memory__");
}

function hasTotals(t: ToolCallTrace): boolean {
  if (t.result_had_totals === true) return true;
  const preview = typeof t.output_preview === "string" ? t.output_preview : "";
  return /"totals"\s*:\s*\{/.test(unescapeJsonPreview(preview));
}

function wasTruncated(t: ToolCallTrace): boolean {
  if (t.result_truncated === true) return true;
  const out = unescapeJsonPreview(
    typeof t.output_preview === "string" ? t.output_preview : "",
  );
  return out.includes('"_truncated":true') || out.includes('"_truncated": true');
}

export type CappedAggregateFlags = {
  ungrounded_sentences: string[];
  capped_tools: string[];
};

export type CappedAggregateResult = {
  hedged: boolean;
  text: string;
  flags: CappedAggregateFlags;
};

function buildBanner(flags: CappedAggregateFlags): string {
  const tools = flags.capped_tools.slice(0, 3).join(", ");
  return [
    "> ⚠️ **Scope warning — this may be a fraction of the account.** The number(s) below are stated " +
      "account-wide, but the supporting result was capped" +
      (tools ? ` (\`${tools}\`)` : "") +
      " and carried no account totals, so only part of the data was visible.",
    "> Re-read it as **the rows shown, not the account**. Narrow the query, paginate, or call a tool that " +
      "returns a `totals` block before acting on this figure.",
    "",
    "",
  ].join("\n");
}

export function verifyCappedAggregate(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
}): CappedAggregateResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = args.toolCalls ?? [];
  const empty: CappedAggregateFlags = { ungrounded_sentences: [], capped_tools: [] };
  if (!reply) return { hedged: false, text: reply, flags: empty };

  const cappedNoTotals: string[] = [];
  let anyTotals = false;
  for (const t of toolCalls) {
    const name = typeof t.name === "string" ? t.name : "";
    if (!name || isMemoryTool(name)) continue;
    const totals = hasTotals(t);
    if (totals) anyTotals = true;
    if (wasTruncated(t) && !totals) cappedNoTotals.push(name);
  }
  if (cappedNoTotals.length === 0 || anyTotals) {
    return { hedged: false, text: reply, flags: empty };
  }

  const offenders: string[] = [];
  for (const sentence of splitSentences(reply)) {
    const strong = STRONG_ACCOUNT_SCOPE.test(sentence);
    const accountScoped =
      strong || (TIME_WINDOW_SCOPE.test(sentence) && !namesOneEntity(sentence));
    if (!accountScoped) continue;
    if (SELF_SCOPED.test(sentence)) continue;
    if (!AGGREGATE_METRIC.some((re) => re.test(sentence))) continue;
    offenders.push(sentence.slice(0, 240));
    if (offenders.length >= 5) break;
  }
  if (offenders.length === 0) return { hedged: false, text: reply, flags: empty };

  const flags: CappedAggregateFlags = {
    ungrounded_sentences: offenders,
    capped_tools: [...new Set(cappedNoTotals)],
  };
  return { hedged: true, text: buildBanner(flags) + reply, flags };
}
