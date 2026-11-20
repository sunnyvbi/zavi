
import { unescapeJsonPreview, type ToolCallTrace } from "@/services/tools/types";
import { isRepoPickTrace, removeClaimSentences } from "./side-effect-claim-reconciler";
import { STATUS_PHRASES } from "./run-status-projection";
import { isChatAskQueuedTrace } from "@/services/growth/chat-ask";

const ABSENCE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:has\s+been|have\s+been|was|were|is|are|got)\s+(?:deleted|archived|removed|renamed|disabled|wiped)\b/i,
    "passive-removed",
  ],
  [
    /\bno\s+longer\s+(?:exists?|active|available|connected|running|in\s+the\s+list|in\s+the\s+account)\b/i,
    "no-longer-X",
  ],
  [/\bdo(?:es)?\s+not\s+exist\b|\bdoesn'?t\s+exist\b/i, "does-not-exist"],
  [
    /\b(?:is|was|are|were)\s+not\s+(?:connected|available|configured|wired|set\s+up)\b/i,
    "not-connected",
  ],
  [/\b(?:MCP|connector)\s+not\s+connected\b/i, "mcp-not-connected"],
  [/\b(?:missing|absent)\s+from\b/i, "missing-from"],
  [/\b(?:has|have)\s+been\s+(?:removed|deleted|archived)\b/i, "has-been-removed"],
  [
    /\b(?:appears\s+to\s+(?:have\s+been|be)|seems\s+to\s+(?:have\s+been|be))\s+(?:deleted|archived|removed|missing|gone|absent)\b/i,
    "appears-removed",
  ],
];

export type ClaimGroundingFlags = {
  has_absence_claim: boolean;
  memory_used: boolean;
  truncated_evidence: boolean;
  no_grounding_tool: boolean;
  matched_patterns: string[];
};

export type ClaimVerificationResult = {
  hedged: boolean;
  text: string;
  flags: ClaimGroundingFlags;
};

function detectAbsenceClaims(text: string): string[] {
  return detect(text, ABSENCE_PATTERNS);
}

function detectMemoryUsed(toolCalls: readonly ToolCallTrace[]): boolean {
  return toolCalls.some(
    (t) => typeof t?.name === "string" && t.name.startsWith("memory__"),
  );
}

function noLiveGroundingTool(toolCalls: readonly ToolCallTrace[]): boolean {
  return !toolCalls.some(
    (t) => typeof t?.name === "string" && !t.name.startsWith("memory__"),
  );
}

function detectTruncatedEvidence(toolCalls: readonly ToolCallTrace[]): boolean {
  return toolCalls.some((t) => {
    if (typeof t?.name !== "string") return false;
    if (t.name.startsWith("memory__")) return false;
    const out = typeof t.output_preview === "string" ? t.output_preview : "";
    return (
      out.includes('"_truncated":true') || out.includes('"_truncated": true')
    );
  });
}

const ABSENCE_BANNER_HEAD = "> ⚠️ **May be out of date**";

function buildHedgeBanner(flags: ClaimGroundingFlags): string {
  const reasons: string[] = [];
  if (flags.truncated_evidence) {
    reasons.push(
      "the supporting list was capped (`_truncated:true`) — the entity may exist past the page boundary",
    );
  }
  if (flags.memory_used) {
    reasons.push("the supporting data came from memory, which may be stale");
  }
  if (reasons.length === 0) {
    reasons.push("no live tool result backed this claim");
  }
  return [
    ABSENCE_BANNER_HEAD + " — this reply mentions something is missing, deleted, or not connected, but " +
      reasons.join("; ") +
      ".",
    "> Treat the absence as **unconfirmed**. Narrow the query (filter by name/id) or paginate before acting on the negative.",
    "",
    "",
  ].join("\n");
}

export function verifyClaimGrounding(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
}): ClaimVerificationResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = args.toolCalls ?? [];
  const matched = detectAbsenceClaims(reply);
  const hasAbsenceClaim = matched.length > 0;
  const noGroundingTool = hasAbsenceClaim && noLiveGroundingTool(toolCalls);
  const flags: ClaimGroundingFlags = {
    has_absence_claim: hasAbsenceClaim,
    memory_used: detectMemoryUsed(toolCalls),
    truncated_evidence: detectTruncatedEvidence(toolCalls),
    no_grounding_tool: noGroundingTool,
    matched_patterns: matched,
  };
  const shouldHedge =
    flags.has_absence_claim &&
    (flags.memory_used || flags.truncated_evidence || flags.no_grounding_tool);
  if (!shouldHedge) {
    return { hedged: false, text: reply, flags };
  }
  return { hedged: true, text: buildHedgeBanner(flags) + reply, flags };
}

export function actionClaimGuardEnabled(): boolean {
  return process.env.ACTION_CLAIM_GUARD_ENABLED !== "false";
}

const ACTION_CLAIM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bI(?:'ve|\s+have|\s+just)?\s+(?:queued|created|filed|posted|sent|dispatched|opened|submitted|raised|logged|scheduled|routed|handed\s+off|kicked\s+off)\b/i,
    "i-did-action",
  ],
  [
    /\bI(?:\s+just)?\s+(?:queued|created|filed|posted|sent|dispatched|opened|submitted|raised|logged|routed)\b/i,
    "relclause-action",
  ],
  [
    /\b(?:filed|queued|posted|sent|dispatched|created|opened|submitted|done)\s*[✓✔☑]/i,
    "checkmark-done",
  ],
  [
    /\bI(?:'m|\u2019m|\s+am)\s+(?:now\s+)?(?:putting(?!\s+together\b)|raising|increasing|lowering|cutting|pausing|stopping|launching|sending|moving|shifting|applying|switching|turning(?!\s+to\b)|setting(?!\s+(?:up|out|aside)\b)|filing|queuing|posting|submitting|scheduling)\b/i,
    "i-am-doing",
  ],
  [
    /\b(?:dispatched|handed\s+off|routed|sent)\s+(?:it\s+|this\s+|that\s+|the\s+\w+\s+)?to\s+(?:the\s+)?(?:engineer|specialist|team|support[-\s]?lead|operator)\b/i,
    "dispatched-to",
  ],
];

const PRIOR_TURN_MARKERS: readonly RegExp[] = [
  /\b(?:earlier|previously|before|last\s+turn|prior\s+turn|earlier\s+in\s+this\s+thread)\b/i,
  /\b(?:haven'?t|have\s+not|did\s+not|didn'?t)\s+(?:re-?checked|re-?read|re-?verified|re-?run|re-?pulled|confirmed\s+again)\b/i,
  /\bfrom\s+(?:before|memory|a\s+prior\s+(?:turn|run|read))\b/i,
];

const FUTURE_CONDITIONAL_MARKERS: readonly RegExp[] = [
  /\bI(?:'ll|\s+will|\s+can|\s+could|\s+would|\s+am\s+going\s+to|\s+plan\s+to|\s+intend\s+to)\b/i,
  /\bif\s+you\s+(?:approve|confirm|say|want|'d\s+like)\b/i,
];

const SIDE_EFFECT_TOOL_RE =
  /(?:^|[._])(?:propose|dispatch|create|post|send|upload|file|open|submit|raise|schedule|route|handoff|hand_off|write|update|comment|reply|assign|transition|provision|payment)/i;

function detect(
  text: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const matched: string[] = [];
  for (const [re, label] of patterns) {
    if (re.test(text)) matched.push(label);
  }
  return matched;
}

function anyMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function hasSideEffectToolCall(toolCalls: readonly ToolCallTrace[]): boolean {
  return toolCalls.some((t) => {
    if (typeof t?.name !== "string") return false;
    if (t.name.startsWith("memory__")) return false;
    if (t.status !== "ok") return false;
    if (isRepoPickTrace(t)) return false;
    return SIDE_EFFECT_TOOL_RE.test(t.name);
  });
}

export type ActionClaimFlags = {
  action_claim: boolean;
  prior_turn_marked: boolean;
  matched_action_patterns: string[];
};

export type ActionClaimResult = {
  flagged: boolean;
  text: string;
  flags: ActionClaimFlags;
};

function buildActionBanner(flags: ActionClaimFlags): string {
  const lines: string[] = [];
  if (flags.action_claim) {
    lines.push(
      "> ⚠️ **Unverified action claim** — this reply states an action was taken (created / queued / filed / posted / sent / dispatched) this turn, but no matching action tool call is in this run's trace.",
    );
  }
  lines.push(
    "> Treat the claim as **unconfirmed**: take the action now, or say it's from a prior turn and unverified.",
  );
  lines.push("", "");
  return lines.join("\n");
}

export function verifyActionAndLiveReadClaims(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
  dispatchedActions?: readonly unknown[];
}): ActionClaimResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = args.toolCalls ?? [];
  const hasRecordedDispatch =
    Array.isArray(args.dispatchedActions) && args.dispatchedActions.length > 0;

  const scanned = toolCalls.some(isChatAskQueuedTrace)
    ? reply
        .split(/(?<=[.!?])\s+|\n+/)
        .filter((x) => !CHAT_ASK_REVIEW_SENTENCE_RE.test(x))
        .join(" ")
    : reply;
  const priorMarked = anyMatch(scanned, PRIOR_TURN_MARKERS);
  const futureFramed = anyMatch(scanned, FUTURE_CONDITIONAL_MARKERS);
  const actionMatches = detect(scanned, ACTION_CLAIM_PATTERNS);
  const actionClaim = actionMatches.length > 0 && !futureFramed && !priorMarked;

  const actionBad =
    actionClaim && !hasSideEffectToolCall(toolCalls) && !hasRecordedDispatch;

  const flags: ActionClaimFlags = {
    action_claim: actionBad,
    prior_turn_marked: priorMarked,
    matched_action_patterns: actionMatches,
  };

  if (!actionBad) {
    return { flagged: false, text: reply, flags };
  }
  return { flagged: true, text: buildActionBanner(flags) + reply, flags };
}

const SINGLE_QUOTED_SPAN_RE = /(?<![^\s(])'(?:[^'\n]|'(?=\w))+'(?![^\s.,;:!?)])/g;

const QUOTED_SPEECH_RE =
  /\b(?:said|says|say|wrote|writes|asked|asks|replied|replies|told|tells|messaged|texted|emailed)\b[^"“‘']{0,40}(?:["“‘]|(?<![^\s(])')|:\s*["“‘']/i;

export function isActionClaimSentence(sentence: string): boolean {
  if (QUOTED_SPEECH_RE.test(sentence)) return false;
  const unquoted = sentence
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`/g, " ")
    .replace(SINGLE_QUOTED_SPAN_RE, " ");
  if (anyMatch(unquoted, FUTURE_CONDITIONAL_MARKERS)) return false;
  if (anyMatch(unquoted, PRIOR_TURN_MARKERS)) return false;
  for (const [re] of ACTION_CLAIM_PATTERNS) {
    const m = re.exec(unquoted);
    if (!m) continue;
    const before = unquoted.slice(0, m.index);
    if (/\b(?:you|your|you've|they|he|she)\b/i.test(before)) continue;
    return true;
  }
  return false;
}

export function removeUngroundedActionClaims(reply: string, backed: (sentence: string) => boolean = () => false): {
  text: string;
  removed: number;
} {
  const r = removeClaimSentences(reply, (x) => isActionClaimSentence(x) && !backed(x), {
    skipBlockquotes: true,
  });
  if (r.removed === 0) return { text: reply, removed: 0 };
  return {
    text: r.text.length > 0 ? r.text : STATUS_PHRASES.no_change,
    removed: r.removed,
  };
}

export const PROPOSAL_LINES = {
  approval: "I sent this change to you for approval.",
  auto: "I submitted this change; it applies on its own within your limits.",
  failed: "This change did not go through.",
  uncertain: "This change may have only partly gone through; check the card.",
  closed: "That card was closed; no change will run.",
  created: "I created this, but it is not switched on yet.",
  inProgress: "This change was approved and is still being set up.",
  directAsk: "Zavi will post here how it went once it finishes.",
  directAskMixed: "Zavi will post here how the ad you asked for went; the other changes are on their cards.",
  mixed: "Only some of these changes ran; check each card.",
} as const;

const CHANGE_DONE_RE =
  /\bI(?:'ve|\u2019ve|\s+have|\s+just|'m|\u2019m|\s+am)?\s+(?:now\s+|also\s+)?(?:raised|raising|increased|increasing|lowered|lowering|reduced|reducing|cut|cutting|paused|pausing|unpaused|resumed|resuming|stopped|stopping|launched|launching|activated|enabled|disabled|applied|applying|switched|switching|turned(?!\s+to\b)|turning(?!\s+to\b)|put(?!\s+together\b)|putting(?!\s+together\b)|moved|moving|shifted|shifting|changed|updated|set(?!\s+(?:up|out|aside)\b))\b/i;

export function isChangeDoneSentence(sentence: string): boolean {
  if (QUOTED_SPEECH_RE.test(sentence)) return false;
  const unquoted = sentence
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`/g, " ")
    .replace(SINGLE_QUOTED_SPAN_RE, " ");
  const m = CHANGE_DONE_RE.exec(unquoted);
  if (!m) return false;
  const start = Math.max(0, ...[...unquoted.slice(0, m.index).matchAll(CLAUSE_BREAK_RE)].map((b) => (b.index ?? 0) + b[0].length));
  const after = unquoted.slice(m.index + m[0].length);
  const next = after.search(CLAUSE_BREAK_ONE_RE);
  const clause = unquoted.slice(start, m.index + m[0].length + (next < 0 ? after.length : next));
  if (anyMatch(clause, FUTURE_CONDITIONAL_MARKERS)) return false;
  if (anyMatch(clause, PRIOR_TURN_MARKERS)) return false;
  return !/\b(?:you|your|you've|they|he|she)\b/i.test(unquoted.slice(start, m.index));
}

const CLAUSE_BREAK_RE = /[,;]\s*|\s+(?:and|but|then|so)\s+/gi;
const CLAUSE_BREAK_ONE_RE = /[,;]\s*|\s+(?:and|but|then|so)\s+/i;

const PROPOSAL_TOOL_RE = /(?:^|[._])propose/i;
const DIRECT_ASK_STATUS_RE = /\b(?:is|was|has been|it's|it’s)\s+(?:now\s+)?(?:approved|live)\b|\bstill being set up\b|\bwait(?:s|ing)? for (?:your |the founder's )?approval\b|\bnothing goes live until\b/i;
const AD_SUBJECT_RE = /\b(?:ads?|campaign|launch)\b/i;
const PROPOSAL_RECEIPT_RE = /"(?:decision_id|action_id|brief_id)"\s*:\s*"[^"]+"/;

const CARD_STATUS_RE = /"card_status"\s*:\s*"([a-z_]+)"/;
const cardStatus = (out: string): string | null => CARD_STATUS_RE.exec(out)?.[1] ?? null;

function proposalAutoApplies(out: string): boolean {
  if (/"will_auto_apply"\s*:\s*true/.test(out)) return true;
  if (/"approval_required"\s*:\s*false/.test(out)) return true;
  return /"decision_class"\s*:\s*"meta_ads\.update_(?:ad_set|campaign)_budget"/.test(out);
}

type ProposalLine = keyof typeof PROPOSAL_LINES;

function proposalKind(out: string): ProposalLine | "done" {
  switch (cardStatus(out)) {
    case "carried_out":
      return "done";
    case "waiting_for_approval":
      return "approval";
    case "approved_by_autopilot":
    case "approved_in_progress":
      return "inProgress";
    case "direct_ask_launching":
      return "directAsk";
    case "created_not_live":
      return "created";
    case "uncertain":
      return "uncertain";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      return proposalAutoApplies(out) ? "auto" : "approval";
  }
}

const LINE_ORDER: readonly ProposalLine[] = ["approval", "closed", "uncertain", "failed", "created", "inProgress", "directAsk", "auto"];

function proposalOnly(
  toolCalls: readonly ToolCallTrace[],
): { filed: boolean; line: string | null } | null {
  const effects = toolCalls.filter(
    (t) => typeof t?.name === "string" && !t.name.startsWith("memory__") && t.status === "ok" && !isRepoPickTrace(t) && SIDE_EFFECT_TOOL_RE.test(t.name),
  );
  if (effects.length === 0 || !effects.every((t) => PROPOSAL_TOOL_RE.test(t.name))) return null;
  const out = (t: ToolCallTrace) => unescapeJsonPreview(String(t.output_preview ?? ""));
  const filed = effects.filter((t) => PROPOSAL_RECEIPT_RE.test(out(t)));
  const kinds = new Set(filed.map((t) => proposalKind(out(t))));
  if (kinds.has("directAsk") && kinds.size > 1) return { filed: true, line: PROPOSAL_LINES.directAskMixed };
  const line = LINE_ORDER.find((k) => kinds.has(k));
  const allFiled = filed.length === effects.length;
  const someRan = kinds.has("done");
  if (someRan && (line || !allFiled)) return { filed: true, line: PROPOSAL_LINES.mixed };
  return { filed: filed.length > 0, line: line ? PROPOSAL_LINES[line] : null };
}

export function removeUnbackedActionClaims(args: {
  text: string;
  toolCalls?: readonly ToolCallTrace[];
  parsed?: unknown;
  sideEffectKind?: string;
}): { text: string; removed: number } {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text || !actionClaimGuardEnabled()) return { text, removed: 0 };
  const status = removeUnbackedStatusClaims({ text, toolCalls: args.toolCalls });
  const action = removeUnbackedActionOnly({ ...args, text: status.text });
  return { text: action.text, removed: status.removed + action.removed };
}

const STATE_WORDS = "disabled|suspended|paused|restricted|deactivated|inactive";
const STATE_WORD_RE = new RegExp(`\\b(?:${STATE_WORDS})\\b`, "gi");
const ACCOUNT_SUBJECT_RE = /\b(?:account|business\s+manager|billing|payment\s+method)\b/i;
const STATUS_SUBJECT_RE = /\b(?:account|business\s+manager|billing|payment\s+method|campaigns?|ads?|ad\s+sets?|pixel|page|profile)\b/i;

const STATUS_REPORT_RE = new RegExp(
  `\\b(?:(?:is|are|was|were|has\\s+been|have\\s+been|got|gets)\\s+(?:currently\\s+|still\\s+|now\\s+)?(?:flagged|marked|listed|showing(?:\\s+up)?|shown|reported)|shows?(?:\\s+up)?|appears?|displays?)\\s+as\\s+(?:${STATE_WORDS})\\b`,
  "i",
);
const ACCOUNT_STATE_RE = new RegExp(
  `\\b(?:is|are|was|were|has\\s+been|have\\s+been|got)\\s+(?:currently\\s+|still\\s+|now\\s+)?(?:flagged|${STATE_WORDS})\\b`,
  "i",
);

const SCHEDULE_SUBJECT_RE = /\b(?:campaigns?|tests?|experiments?|ads?|ad\s+sets?|launch|promo(?:tion)?s?|posts?|emails?|sequences?|flights?)\b/i;
const DAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = `(?:tomorrow|today|tonight|(?:next|this)\\s+(?:week(?:end)?|month|morning|afternoon|evening|${DAY})|${DAY}|${MONTH}|the\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\s+(?!(?:of|at)\\b)[a-z])|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|\\d{1,2}/\\d{1,2}|\\d{4}-\\d{2}-\\d{2})\\b`;
const SCHEDULED_RE = [
  new RegExp(`\\b(?:is|are|was|were|has\\s+been|have\\s+been|got)\\s+(?:already\\s+|now\\s+|all\\s+)?(?:set|scheduled|slated|booked|due)\\s+(?:to\\s+(?:start|launch|begin|go\\s+live|kick\\s+off)\\b|for\\s+(?:on\\s+)?${DATE})`, "i"),
  new RegExp(`\\b(?:will|is\\s+going\\s+to|are\\s+going\\s+to|goes|go)\\s+(?:live|launch|start|begin|kick\\s+off)\\s+(?:on\\s+|at\\s+|in\\s+)?${DATE}`, "i"),
  new RegExp(`\\b(?:starts|launches|begins|kicks\\s+off)\\s+(?:on\\s+)?${DATE}`, "i"),
];

const NOT_A_STATUS_CLAIM_RE = /\b(?:if|unless|whether|in\s+case|once|when|previously|earlier|used\s+to|before|I(?:'ll|\u2019ll|\s+will))\b|\?\s*$/i;
const MODAL_RE = /\b(?:would|could|might|should)\b/i;
const OFFER_RE = /\bI(?:\s+(?:can(?:['\u2019]t|not)|couldn['\u2019]t|am\s+unable\s+to)\b|['\u2019]m\s+unable\s+to\b|\s+(?:can|could)\b(?!['\u2019]t)(?!\s+(?:also\s+)?(?:see|tell)\b))/gi;
const OFFER_STOP_RE = /\b(?:because|since|however|although|though|yet)\b|\bbut\b(?!\s+not\b)|,\s*and\b|;/i;
const STATUS_CLAUSE_BREAK_RE = /[,;]\s*|\s+(?:and|but|then|so|because|since)\s+/gi;
const STATUS_CLAUSE_BREAK_ONE_RE = /[,;]\s*|\s+(?:and|but|then|so|because|since)\s+/i;

type StatusClaimKind = "account" | "scheduled";

function clauseAround(s: string, start: number, end: number): string {
  const from = Math.max(0, ...[...s.slice(0, start).matchAll(STATUS_CLAUSE_BREAK_RE)].map((b) => (b.index ?? 0) + b[0].length));
  const next = s.slice(end).search(STATUS_CLAUSE_BREAK_ONE_RE);
  return s.slice(from, next < 0 ? s.length : end + next);
}

export function statusClaimKind(sentence: string): StatusClaimKind | null {
  if (QUOTED_SPEECH_RE.test(sentence)) return null;
  const s = sentence
    .replace(/"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`/g, " ")
    .replace(SINGLE_QUOTED_SPAN_RE, " ");
  if (NOT_A_STATUS_CLAIM_RE.test(s)) return null;
  const claim = (m: RegExpExecArray | null): boolean => {
    if (!m || MODAL_RE.test(clauseAround(s, m.index, m.index + m[0].length))) return false;
    const before = s.slice(0, m.index);
    const offers = [...before.matchAll(OFFER_RE)];
    const covering = offers.filter((o) => !/^I\s+can\s+(?:also\s+)?confirm\b/i.test(before.slice(o.index ?? 0)));
    const last = covering[covering.length - 1];
    return !last || OFFER_STOP_RE.test(before.slice((last.index ?? 0) + last[0].length));
  };
  const report = STATUS_REPORT_RE.exec(s);
  if (report && STATUS_SUBJECT_RE.test(s.slice(0, report.index)) && claim(report)) return "account";
  const acct = ACCOUNT_STATE_RE.exec(s);
  if (acct && ACCOUNT_SUBJECT_RE.test(s.slice(0, acct.index)) && claim(acct)) return "account";
  if (SCHEDULE_SUBJECT_RE.test(s) && SCHEDULED_RE.some((re) => claim(re.exec(s)))) return "scheduled";
  return null;
}

function liveOutputs(toolCalls: readonly ToolCallTrace[]): string[] {
  return toolCalls
    .filter((t) => typeof t?.name === "string" && !t.name.startsWith("memory__") && t.status === "ok")
    .map((t) => unescapeJsonPreview(String(t.output_preview ?? "")));
}

const SCHEDULE_EVIDENCE_RE = /schedul|start_(?:time|date)|starts?_at|go_live|launch_(?:date|at)/i;
const SCHEDULE_VALUE_RE = /"(\w*(?:schedul|start_time|start_date|starts?_at|go_live|launch_date|launch_at)\w*)"\s*:\s*(?:"([^"]+)"|(\d{9,13})\b)/gi;
const STALE_SCHEDULE_MS = 365 * 86_400_000;

function outputHasSchedule(out: string, now: number): boolean {
  for (const m of out.matchAll(SCHEDULE_VALUE_RE)) {
    const at = m[3] ? Number(m[3]) * (m[3].length >= 13 ? 1 : 1000) : Date.parse(m[2]);
    if (Number.isNaN(at) || at >= now - STALE_SCHEDULE_MS) return true;
  }
  return false;
}

function hasScheduleEvidence(toolCalls: readonly ToolCallTrace[], now = Date.now()): boolean {
  return toolCalls.some(
    (t) =>
      typeof t?.name === "string" &&
      !t.name.startsWith("memory__") &&
      t.status === "ok" &&
      (outputHasSchedule(unescapeJsonPreview(String(t.output_preview ?? "")), now) ||
        (SIDE_EFFECT_TOOL_RE.test(t.name) &&
          SCHEDULE_EVIDENCE_RE.test(`${t.name} ${unescapeJsonPreview(String(t.input_preview ?? ""))}`))),
  );
}

const META_DISABLED_RE = /"account_status"\s*:\s*2\b/;
const GOOGLE_BLOCKED_RE = /"(?:SUSPENDED|CANCELED|CLOSED)"/;

function stateText(out: string): string {
  let t = out.toLowerCase();
  if (META_DISABLED_RE.test(out)) t += " disabled";
  if (GOOGLE_BLOCKED_RE.test(out)) t += " disabled suspended deactivated inactive";
  return t;
}

export function removeUnbackedStatusClaims(args: {
  text: string;
  toolCalls?: readonly ToolCallTrace[];
}): { text: string; removed: number } {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text) return { text, removed: 0 };
  const toolCalls = args.toolCalls ?? [];
  const outputs = liveOutputs(toolCalls).map(stateText);
  const scheduleBacked = hasScheduleEvidence(toolCalls);
  const accountBacked = (sentence: string): boolean => {
    const states = [...sentence.matchAll(STATE_WORD_RE)].map((m) => m[0].toLowerCase().replace(/d$/, ""));
    const stems = states.length > 0 ? states : ["flag"];
    return outputs.some((o) => stems.some((st) => o.includes(st)));
  };
  const r = removeClaimSentences(
    text,
    (x) => {
      const kind = statusClaimKind(x);
      if (kind === "account") return !accountBacked(x);
      if (kind === "scheduled") return !scheduleBacked;
      return false;
    },
    { skipBlockquotes: true },
  );
  if (r.removed === 0) return r;
  let out = r.text;
  if (out.startsWith(ABSENCE_BANNER_HEAD)) {
    const body = out.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();
    if (detectAbsenceClaims(body).length === 0) out = body;
  }
  return { text: out.length > 0 ? out : STATUS_UNCONFIRMED, removed: r.removed };
}

export const STATUS_UNCONFIRMED = "I couldn't confirm that status from live data in this run.";

function removeUnbackedActionOnly(args: {
  text: string;
  toolCalls?: readonly ToolCallTrace[];
  parsed?: unknown;
  sideEffectKind?: string;
}): { text: string; removed: number } {
  const text = args.text;
  if (!text) return { text, removed: 0 };
  const statuses = (args.toolCalls ?? [])
    .filter((t) => t?.status === "ok" && typeof t.name === "string" && PROPOSAL_TOOL_RE.test(t.name))
    .map((t) => unescapeJsonPreview(String(t.output_preview ?? "")))
    .filter((out) => PROPOSAL_RECEIPT_RE.test(out))
    .map((out) => cardStatus(out) ?? "filed");
  if (statuses.includes("direct_ask_launching")) {
    const mixed = statuses.some((st) => st !== "direct_ask_launching");
    return removeClaimSentences(text, (x) => isChangeDoneSentence(x) || (DIRECT_ASK_STATUS_RE.test(x) && AD_SUBJECT_RE.test(x)), { skipBlockquotes: true, replacement: mixed ? PROPOSAL_LINES.directAskMixed : PROPOSAL_LINES.directAsk });
  }
  if (args.sideEffectKind === "shipped") return { text, removed: 0 };
  const parsed =
    args.parsed && typeof args.parsed === "object"
      ? (args.parsed as Record<string, unknown>)
      : {};
  if (/https?:\/\/github\.com\/[^\s"']+\/pull\/\d+/i.test(JSON.stringify(parsed))) {
    return { text, removed: 0 };
  }
  const dispatched = parsed.dispatched_actions;
  const proposals = proposalOnly(args.toolCalls ?? []);
  if (proposals?.filed && proposals.line === null) return { text, removed: 0 };
  if (proposals && !(Array.isArray(dispatched) && dispatched.length > 0)) {
    if (!proposals.filed) {
      const r = removeClaimSentences(text, (x) => isChangeDoneSentence(x) || isActionClaimSentence(x), { skipBlockquotes: true });
      return r.removed === 0 ? r : { text: r.text.length > 0 ? r.text : STATUS_PHRASES.no_change, removed: r.removed };
    }
    return removeClaimSentences(text, isChangeDoneSentence, {
      skipBlockquotes: true,
      replacement: proposals.line ?? PROPOSAL_LINES.approval,
    });
  }
  if (hasSideEffectToolCall(args.toolCalls ?? [])) return { text, removed: 0 };
  if (Array.isArray(dispatched) && dispatched.length > 0) return { text, removed: 0 };
  if (anyMatch(text, PRIOR_TURN_MARKERS.slice(1))) return { text, removed: 0 };
  if ((args.toolCalls ?? []).some(isChatAskQueuedTrace)) {
    return removeUngroundedActionClaims(text, (x) => CHAT_ASK_REVIEW_SENTENCE_RE.test(x));
  }
  return removeUngroundedActionClaims(text);
}

const CHAT_ASK_REVIEW_SENTENCE_RE = /\bqueu(?:e|ed|es|ing)\b[^.!?\n]*\breview\b|\breview\b[^.!?\n]*\bqueu(?:e|ed|es|ing)\b/i;

export function toolBrokenClaimGuardEnabled(): boolean {
  return process.env.TOOL_BROKEN_CLAIM_GUARD_ENABLED !== "false";
}

const TOOL_BROKEN_CLAIM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:tool|query\s+layer|dispatch\s+layer|connector)\b[^.!?\n]{0,40}?\b(?:is|are|remains?)\s+(?:currently\s+|still\s+)?(?:broken|failing|erroring|non-functional|not\s+working|down)\b/i,
    "tool-is-broken",
  ],
  [/\bbroken\s+(?:\w+\s+){0,2}?(?:tool|layer)\b/i, "broken-tool"],
  [
    /\btool\b[^.!?\n]{0,30}?\b(?:hits?|throws?|keeps\s+(?:hitting|throwing|failing)|errors?\s+out)\b/i,
    "tool-hits-error",
  ],
  [
    /\bserialization\s+(?:bug|issue|defect|error)\b[^.!?\n]{0,60}\b(?:block(?:s|ed|ing)?|prevent(?:s|ed|ing)?)\b/i,
    "serialization-blocks",
  ],
  [
    /\b(?:block(?:s|ed|ing)?|prevent(?:s|ed|ing)?|hit(?:s|ting)?)\b[^.!?\n]{0,60}\bserialization\s+(?:bug|issue|defect|error)\b/i,
    "blocks-serialization",
  ],
  [
    /\bevery\s+(?:aggregate|query|attempt|call|tool\s+call|param(?:eter)?s?)\b[^.!?\n]{0,60}\b(?:fail(?:s|ed|ing)?|error(?:s|ed)?|blocked|rejected|comes?\s+through\s+as\s+(?:a\s+)?strings?)\b/i,
    "every-call-fails",
  ],
  [/\b[A-Z][A-Z0-9]{1,9}-\d+\s+(?:is\s+)?(?:still\s+)?blocking\b/, "ticket-blocking"],
  [
    /\bblocked\s+by\s+(?:the\s+)?(?:\w+\s+){0,3}?\(?[A-Z][A-Z0-9]{1,9}-\d+\)?/,
    "blocked-by-ticket",
  ],
  [
    /\b(?:known|same)\s+(?:\w+\s+){0,2}?bug\s*\(\s*[A-Z][A-Z0-9]{1,9}-\d+\s*\)/,
    "known-bug-ticket",
  ],
];

const TOOL_RESOLVED_MARKERS: readonly RegExp[] = [
  /\b(?:is|was|has\s+been|got|now)\s+(?:fixed|resolved|patched|repaired)\b/i,
  /\bno\s+longer\s+(?:fails?|failing|broken|blocked|erroring|an\s+issue)\b/i,
  /\b(?:works|working)\s+(?:now|again)\b|\bnow\s+works\b/i,
];

const TOOL_PRIOR_UNRECHECKED_MARKERS: readonly RegExp[] = [
  /\b(?:haven'?t|have\s+not|didn'?t|did\s+not)\s+(?:re-?tried|re-?checked|re-?run|re-?verified|re-?tested|confirmed\s+again)\b/i,
  /\bfrom\s+a\s+prior\s+(?:turn|run)\b[^.!?\n]{0,40}\bunverified\b/i,
];

function hasFailedToolCall(toolCalls: readonly ToolCallTrace[]): boolean {
  return toolCalls.some(
    (t) =>
      typeof t?.name === "string" &&
      !t.name.startsWith("memory__") &&
      t.status !== "ok",
  );
}

export type ToolBrokenClaimFlags = {
  tool_broken_claim: boolean;
  prior_turn_marked: boolean;
  failed_tool_in_trace: boolean;
  matched_patterns: string[];
};

export type ToolBrokenClaimResult = {
  flagged: boolean;
  text: string;
  flags: ToolBrokenClaimFlags;
};

function buildToolBrokenBanner(): string {
  return [
    "> ⚠️ **Unverified tool-failure claim** — this reply says a tool is broken, failing, or blocked by a bug, but no tool call failed in this run's trace. The claim may be stale (carried from memory or thread history after a fix shipped).",
    "> Retry the tool in this run before repeating the claim; if it fails now, report the fresh error instead of the remembered one.",
    "",
    "",
  ].join("\n");
}

export function verifyToolBrokenClaim(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
}): ToolBrokenClaimResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = args.toolCalls ?? [];

  const matched = detect(reply, TOOL_BROKEN_CLAIM_PATTERNS);
  const priorMarked = anyMatch(reply, TOOL_PRIOR_UNRECHECKED_MARKERS);
  const resolvedFramed = anyMatch(reply, TOOL_RESOLVED_MARKERS);
  const failedToolInTrace = hasFailedToolCall(toolCalls);

  const claim = matched.length > 0 && !priorMarked && !resolvedFramed;
  const flagged = claim && !failedToolInTrace;

  const flags: ToolBrokenClaimFlags = {
    tool_broken_claim: flagged,
    prior_turn_marked: priorMarked,
    failed_tool_in_trace: failedToolInTrace,
    matched_patterns: matched,
  };

  if (!flagged) {
    return { flagged: false, text: reply, flags };
  }
  return { flagged: true, text: buildToolBrokenBanner() + reply, flags };
}
