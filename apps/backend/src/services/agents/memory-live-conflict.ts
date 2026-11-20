
import type { ToolCallTrace } from "@/services/tools/types";

export type MemoryLiveConflict = {
  conflicted: boolean;
  sharedTerms: string[];
  liveTool?: string;
  liveQuery?: string;
};

const ANSWER_ASSERTS_RE =
  /\b(?:is live|are live|is available|shipped|launched|rolled out|went live|in production|now (?:live|available|supports?)|can now|yes[,—\-\s])/i;
const NEGATION_RE =
  /\b(?:not|never|isn't|aren't|hasn't|haven't|has not|have not|no longer|not yet|cannot|can't|unable)\b[^.!?]{0,24}$/i;

const MEMORY_TOOL_RE = /memory.*search|search.*memory|recall/i;
const MEMORY_ASSERTS_SHIPPED_RE =
  /\b(?:is shipped|feature is shipped|shipped|launched|is live|are live|went live|rolled out|can now|now available)\b/i;

const LIVE_TOOL_RE =
  /(?:github|repo|code).*(?:search|grep|read_file|list)|search_code|grep_repo|code_index/i;
const EMPTY_RESULT_RE =
  /\\?"total\\?"\s*:\s*0\b|\\?"items\\?"\s*:\s*\[\s*\]|\\?"results\\?"\s*:\s*\[\s*\]|\\?"matches\\?"\s*:\s*\[\s*\]|^\s*\[\s*\]\s*$/;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "this", "that", "is", "are",
  "of", "to", "in", "on", "at", "by", "from", "feature", "features", "support",
  "new", "our", "your", "can", "now", "guest", "guests", "user", "users",
]);

function terms(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of (s ?? "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (!STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function affirmative(text: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(g)) {
    const i = m.index ?? 0;
    if (!NEGATION_RE.test(text.slice(Math.max(0, i - 40), i))) return true;
  }
  return false;
}

export function detectMemoryLiveConflict(args: {
  answer: string;
  toolCalls?: readonly ToolCallTrace[];
}): MemoryLiveConflict {
  const none: MemoryLiveConflict = { conflicted: false, sharedTerms: [] };
  const answer = typeof args.answer === "string" ? args.answer : "";
  const calls = args.toolCalls ?? [];
  if (answer.length === 0 || calls.length === 0) return none;

  if (!affirmative(answer, ANSWER_ASSERTS_RE)) return none;

  const memoryHits = calls.filter(
    (c) =>
      c.status === "ok" &&
      MEMORY_TOOL_RE.test(c.name) &&
      affirmative(c.output_preview ?? "", MEMORY_ASSERTS_SHIPPED_RE),
  );
  if (memoryHits.length === 0) return none;

  const emptyLive = calls.filter(
    (c) =>
      c.status === "ok" &&
      LIVE_TOOL_RE.test(c.name) &&
      EMPTY_RESULT_RE.test((c.output_preview ?? "").trim()),
  );
  if (emptyLive.length === 0) return none;

  const live = emptyLive[0];
  const liveTerms = terms(live.input_preview ?? "");
  let best: { shared: string[]; call: ToolCallTrace } | null = null;
  for (const m of memoryHits) {
    const memTerms = terms(m.output_preview ?? "");
    const shared = [...liveTerms].filter((t) => memTerms.has(t));
    if (shared.length >= 2 && (!best || shared.length > best.shared.length)) {
      best = { shared, call: m };
    }
  }
  if (!best) return none;

  return {
    conflicted: true,
    sharedTerms: best.shared.slice(0, 6),
    liveTool: live.name,
    liveQuery: extractQuery(live.input_preview ?? ""),
  };
}

function extractQuery(inputPreview: string): string | undefined {
  const m = inputPreview.match(/"(?:query|q|search|pattern)"\s*:\s*"([^"]{1,120})"/i);
  return m?.[1];
}

export function buildConflictReply(c: MemoryLiveConflict): string {
  const subject = c.sharedTerms.slice(0, 3).join(" ");
  const what = subject.length > 0 ? `**${subject}**` : "this";
  const searched = c.liveQuery ? ` (searched for "${c.liveQuery}")` : "";
  return [
    `I can't confirm this one, and I don't want to guess.`,
    ``,
    `Our saved notes say ${what} shipped, but searching your codebase right now returns no matching code${searched}. Those two disagree, so one of them is wrong:`,
    ``,
    `- the note may have recorded a plan or an intention as though it were done, or`,
    `- the feature exists under a different name than I searched for, or lives somewhere I can't see.`,
    ``,
    `Worth confirming with whoever owns that area before relying on either answer. If you tell me what it's actually called in the code, I can check again.`,
  ].join("\n");
}
