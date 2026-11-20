
import type { ToolCallTrace } from "@/services/tools/types";

export const UNVERIFIED_ABSENCE_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "operator",
]);

const HEDGE_MARKER = "<!--unverified-absence-hedge-->";

const NEGATIVE_EXISTENCE_PATTERNS: readonly RegExp[] = [
  /\bno\b[^.?!]*\bfound\b/i,
  /\bfound\s+no\b/i,
  /\bno\b[^.?!]*\b(?:configured|set\s*up|wired|installed|present|implemented|in\s+place)\b/i,
  /\b(?:isn'?t|is\s+not|aren'?t|are\s+not|wasn'?t|weren'?t)\s+(?:configured|set\s*up|wired|implemented|present|installed|in\s+place)\b/i,
  /\b(?:does|do|did)(?:n'?t|\s+not)\s+exist\b/i,
  /\bno\s+such\b/i,
  /\bthere\s+(?:is|are|was|were)\s+no\b/i,
  /\bthere(?:'s|'re|s)\s+no\b/i,
  /\bzero\s+(?:hits|results|matches)\b/i,
  /\breturned\s+(?:zero|no)\s+(?:hits|results|matches)\b/i,
  /\b(?:could\s*n'?t|couldn'?t|unable\s+to)\s+find\s+any\b/i,
  /\bfound\s+nothing\b/i,
];

export function hasReadFileBudgetRefusal(toolCalls: readonly ToolCallTrace[]): boolean {
  return toolCalls.some((t) => {
    if (typeof t?.name !== "string") return false;
    if (!t.name.endsWith("github__read_file")) return false;
    const out = typeof t.output_preview === "string" ? t.output_preview : "";
    return /BUDGET EXHAUSTED/i.test(out);
  });
}

export type AbsenceRiskReason =
  | "read_budget"
  | "blocked_read"
  | "partial_scan"
  | "empty_multi_term_search"
  | "no_code_read"
  | "no_web_search";

const GITHUB_READ_SUFFIXES = [
  "github__read_file",
  "github__search_code",
  "github__grep",
  "github__list_files",
] as const;

export function isGithubRead(name: unknown): boolean {
  return typeof name === "string" && GITHUB_READ_SUFFIXES.some((s) => name.endsWith(s));
}

function isSuccessfulCodeLookup(t: ToolCallTrace): boolean {
  if (!isGithubRead(t?.name)) return false;
  if (t.status === "tool_error") return false;
  const out = typeof t.output_preview === "string" ? t.output_preview : "";
  if (!out) return false;
  if (/BUDGET EXHAUSTED/i.test(out)) return false;
  if (/"complete"\s*:\s*true/.test(out)) return true;
  if (/"total"\s*:\s*0\b/.test(out)) return false;
  if (/"matches"\s*:\s*\[\s*\]/.test(out)) return false;
  return true;
}

function isBlockedRead(t: ToolCallTrace): boolean {
  if (!isGithubRead(t?.name)) return false;
  const out = typeof t.output_preview === "string" ? t.output_preview : "";
  if (t.status === "tool_error") return true;
  return /approval_channel_unavailable|pending_approval|governance_emit_failed/i.test(out);
}

function isPartialScan(t: ToolCallTrace): boolean {
  if (typeof t?.name !== "string" || !t.name.endsWith("github__grep")) return false;
  const out = typeof t.output_preview === "string" ? t.output_preview : "";
  return /"complete"\s*:\s*false/.test(out);
}

function isEmptyMultiTermSearch(t: ToolCallTrace): boolean {
  if (typeof t?.name !== "string" || !t.name.endsWith("github__search_code")) return false;
  const out = typeof t.output_preview === "string" ? t.output_preview : "";
  if (!/"total"\s*:\s*0\b/.test(out)) return false;
  const rawIn = typeof t.input_preview === "string" ? t.input_preview : "";
  if (!rawIn) return false;
  const m = rawIn.match(/"query"\s*:\s*"([^"]*)"/);
  if (!m) return false;
  return m[1].trim().split(/\s+/).filter(Boolean).length >= 2;
}

function isSuccessfulOperatorDbLookup(t: ToolCallTrace): boolean {
  const name = typeof t?.name === "string" ? t.name : "";
  if (!name.includes("operator_db")) return false;
  if (t.status === "tool_error") return false;
  const out = typeof t.output_preview === "string" ? t.output_preview : "";
  return out.length > 0;
}

const OPEN_WEB_SUFFIXES = [
  "web_search__search",
  "web_fetch__fetch",
  "apify__rag_web_browser",
] as const;

const GOOGLE_DRIVE_HOST_RE = /\b(?:docs|drive)\.google\.com\b/i;

function isGoogleDriveRead(t: ToolCallTrace): boolean {
  return (
    GOOGLE_DRIVE_HOST_RE.test(t.input_preview ?? "") ||
    GOOGLE_DRIVE_HOST_RE.test(t.output_preview ?? "")
  );
}

function isOpenWebLookup(t: ToolCallTrace): boolean {
  const name = typeof t?.name === "string" ? t.name : "";
  if (!OPEN_WEB_SUFFIXES.some((s) => name.endsWith(s))) return false;
  if (t.status === "tool_error") return false;
  if (name.endsWith("web_fetch__fetch") && isGoogleDriveRead(t)) return false;
  return true;
}

const EXTERNAL_ABSENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:does|do|did)(?:n'?t|\s+not)\s+(?:publicly\s+)?(?:publish|disclose|break\s+out)\b/i,
  /\bnot\s+in\s+[^.?!]*\b(?:public\s+disclosure|annual\s+report|filing|10-?K|S-?1|prospectus)\b/i,
  /\b(?:isn'?t|is\s+not|aren'?t|are\s+not|not)\s+publicly\s+(?:available|disclosed|reported|published|broken\s+out)\b/i,
  /\bno\s+public(?:ly\s+available)?\s+(?:figure|number|data|disclosure|breakdown|filing)\b/i,
];

export function assertsExternalAbsence(reply: string): string[] {
  const matched: string[] = [];
  for (const re of EXTERNAL_ABSENCE_PATTERNS) {
    const m = reply.match(re);
    if (m) matched.push(m[0].slice(0, 80));
  }
  return matched;
}

const CODE_OR_PRODUCT_CONTEXT_RE =
  /\b(endpoint|route|api|function|method|handler|model|field|column|file|table|schema|controller|component|module|feature|features|codebase|code|repo|repository|integration|integrations|flow|screen|implemented|wired|built|support|supports)\b/i;

export function absenceRiskReason(
  toolCalls: readonly ToolCallTrace[],
  reply?: string,
  codeSearchAvailable?: boolean,
): AbsenceRiskReason | null {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];

  let lastSuccess = -1;
  for (let i = 0; i < calls.length; i++) {
    if (isSuccessfulCodeLookup(calls[i])) lastSuccess = i;
  }

  for (let i = calls.length - 1; i > lastSuccess; i--) {
    const t = calls[i];
    if (!t || typeof t.name !== "string") continue;
    if (t.name.endsWith("github__read_file") && /BUDGET EXHAUSTED/i.test(t.output_preview ?? "")) {
      return "read_budget";
    }
    if (isBlockedRead(t)) return "blocked_read";
    if (isPartialScan(t)) return "partial_scan";
    if (isEmptyMultiTermSearch(t)) return "empty_multi_term_search";
  }

  if (
    typeof reply === "string" &&
    !calls.some((t) => isOpenWebLookup(t)) &&
    assertsExternalAbsence(reply).length > 0
  ) {
    return "no_web_search";
  }

  const anyGithubRead = calls.some((t) => isGithubRead(t?.name));
  const anyDbEvidence = calls.some((t) => isSuccessfulOperatorDbLookup(t));
  if (
    codeSearchAvailable !== false &&
    !anyGithubRead &&
    !anyDbEvidence &&
    typeof reply === "string" &&
    CODE_OR_PRODUCT_CONTEXT_RE.test(reply)
  ) {
    return "no_code_read";
  }

  return null;
}

export function hasUnverifiedAbsenceRisk(toolCalls: readonly ToolCallTrace[]): boolean {
  return absenceRiskReason(toolCalls) !== null;
}

export function assertsNegativeExistence(reply: string): string[] {
  const matched: string[] = [];
  for (const re of NEGATIVE_EXISTENCE_PATTERNS) {
    const m = reply.match(re);
    if (m) matched.push(m[0].slice(0, 80));
  }
  return matched;
}

const BANNER_BY_REASON: Readonly<Record<AbsenceRiskReason, string>> = {
  read_budget: `I hit the file-read budget with at least one file still unopened this run`,
  blocked_read: `my code search was blocked before it ran this run`,
  partial_scan: `my code search only covered part of the repo this run`,
  empty_multi_term_search: `my code search came back empty, and that search only matches when every word appears in the same file`,
  no_code_read: `I did not search the code this run`,
  no_web_search: `I did not search the web this run`,
};

function buildUnverifiedBanner(reason: AbsenceRiskReason): string {
  return [
    `> ⚠️ **Unverified** — ${BANNER_BY_REASON[reason]}, so treat any "not found" / "doesn't exist" / "doesn't publish" below as **"I could not fully check,"** not confirmed absence.`,
    "> Ask me to check again and I'll search directly.",
    HEDGE_MARKER,
    "",
    "",
  ].join("\n");
}

export type UnverifiedAbsenceFlags = {
  matched_phrases: string[];
  reason: AbsenceRiskReason | null;
};

export type UnverifiedAbsenceResult = {
  hedged: boolean;
  text: string;
  flags: UnverifiedAbsenceFlags;
};

export function verifyNoUnverifiedAbsence(args: {
  reply: string;
  toolCalls: readonly ToolCallTrace[] | undefined;
  codeSearchAvailable?: boolean;
}): UnverifiedAbsenceResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = Array.isArray(args.toolCalls) ? args.toolCalls : [];

  if (reply.includes(HEDGE_MARKER)) {
    return {
      hedged: false,
      text: reply,
      flags: { matched_phrases: [], reason: null },
    };
  }

  const reason = absenceRiskReason(toolCalls, reply, args.codeSearchAvailable);
  if (reason === null) {
    return {
      hedged: false,
      text: reply,
      flags: { matched_phrases: [], reason: null },
    };
  }

  const matched =
    reason === "no_web_search" ? assertsExternalAbsence(reply) : assertsNegativeExistence(reply);
  if (matched.length === 0) {
    return {
      hedged: false,
      text: reply,
      flags: { matched_phrases: [], reason: null },
    };
  }

  return {
    hedged: true,
    text: buildUnverifiedBanner(reason) + reply,
    flags: {
      matched_phrases: Array.from(new Set(matched)).slice(0, 8),
      reason,
    },
  };
}
