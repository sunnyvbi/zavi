
import { fromTracedToolName } from "@/services/mcp/types";
import { getChannel } from "@zavi/shared";
import { STATUS_PHRASES } from "./run-status-projection";

export type ReconcilerMode = "off" | "log" | "rewrite";

export function reconcilerModeFromEnv(): ReconcilerMode {
  const raw = process.env.SIDE_EFFECT_CLAIM_GUARD_MODE;
  if (!raw) return "rewrite";
  const m = raw.toLowerCase();
  return m === "off" || m === "log" ? (m as ReconcilerMode) : "rewrite";
}

type ReconcilerToolCall = { name: string; status: string; output_preview?: string };

export function isRepoPickTrace(tc: { output_preview?: string }): boolean {
  return typeof tc.output_preview === "string" && tc.output_preview.includes("needs_repo_pick");
}

export type RepoPickMeta = {
  awaiting_repo_pick: true;
  repos: string[];
  pending_task_description: string;
};

export function repoPickFromToolCalls(
  tool_calls: readonly ReconcilerToolCall[] | undefined,
): RepoPickMeta | null {
  if (!tool_calls) return null;
  for (let i = tool_calls.length - 1; i >= 0; i--) {
    const tc = tool_calls[i];
    if (tc.status !== "ok" || !isRepoPickTrace(tc)) continue;
    if (!DISPATCH_TOOL_NAMES.has(traceToolName(tc.name))) continue;
    const meta = parseRepoPickMeta(tc.output_preview as string);
    if (meta) return meta;
  }
  return null;
}

function parseRepoPickMeta(preview: string): RepoPickMeta | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let v: unknown = tryParse(preview);
  if (typeof v === "string") v = tryParse(v);
  if (Array.isArray(v)) {
    const block = v.find(
      (b): b is { text: string } =>
        !!b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string",
    );
    v = block ? tryParse(block.text) : undefined;
  }
  const meta = (v as { meta?: Record<string, unknown> } | undefined)?.meta;
  if (!meta || meta.awaiting_repo_pick !== true || !Array.isArray(meta.repos)) return null;
  const repos = meta.repos.filter((r): r is string => typeof r === "string" && r.length > 0);
  if (repos.length === 0) return null;
  return {
    awaiting_repo_pick: true,
    repos,
    pending_task_description:
      typeof meta.pending_task_description === "string" ? meta.pending_task_description : "",
  };
}

type ReconcilerInput = {
  agent_slug: string;
  chat_turn?: boolean;
  output_text: string;
  parsed: unknown;
  tool_calls?: readonly ReconcilerToolCall[];
  parse_ok?: boolean;
  thread_children_working?: { ok: true; value: readonly string[] } | { ok: false };
  surface?: "mcp";
  run_id?: string;
  tenant_runs_working?: { ok: true; value: readonly string[] } | { ok: false };
};

type TruthContext = {
  chat_turn?: boolean;
  parsed: Record<string, unknown> | null;
  tool_calls: readonly ReconcilerToolCall[] | undefined;
  envelope_accepted: boolean;
  thread_children_working: readonly string[] | null;
  surface: "mcp" | null;
  tenant_runs_working: readonly string[] | null;
  run_id: string | null;
};

type Adapter = {
  claim_type: string;
  applies_to: ReadonlySet<string> | "*";
  detect: (text: string, truth: TruthContext) => boolean;
  actual_count: (truth: TruthContext) => number;
  claim_sentence: (sentence: string, truth: TruthContext) => boolean;
  empty_fallback: string;
  replacement?: (truth: TruthContext) => string | null;
  skip_blockquotes?: boolean;
  shadow?: boolean;
};

const DISPATCH_CLAIM_RE = new RegExp(
  [
    "\\bdispatched\\b[^.?!\\n]{0,40}\\bto\\b[^.?!\\n]{0,20}\\b(engineer|specialist|the team|the engineer)\\b",
    "\\b(sent|handed off|routed|dispatched|queued)\\b[^.?!\\n]{0,30}\\b(to|for) (the )?engineer\\b",
    "\\b\\d+\\s+action[s]?\\s+(sent|dispatched|queued)\\b",
    "\\b(dispatched|sent)\\s*:\\s*\\*{0,2}[a-z0-9-]+",
  ].join("|"),
  "i",
);

function traceToolName(name: string): string {
  const parsed = fromTracedToolName(name);
  return parsed ? `${parsed.server_id}__${parsed.tool_name}` : name;
}

const DISPATCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "praxis__handoff",
  "praxis__handoff_parallel",
  "praxis__ask_agent",
  "praxis__action",
]);

function successfulDispatchToolCount(
  tool_calls: readonly ReconcilerToolCall[] | undefined,
): number {
  if (!tool_calls) return 0;
  let n = 0;
  for (const tc of tool_calls) {
    if (
      DISPATCH_TOOL_NAMES.has(traceToolName(tc.name)) &&
      tc.status === "ok" &&
      !isRepoPickTrace(tc)
    )
      n += 1;
  }
  return n;
}

function dispatchedActionsCount(truth: TruthContext): number {
  const fromTools = successfulDispatchToolCount(truth.tool_calls);

  const da = truth.parsed?.dispatched_actions;
  const fromEnvelope = truth.envelope_accepted && Array.isArray(da) ? da.length : 0;

  return Math.max(fromEnvelope, fromTools);
}

const ZERO_DISPATCH_RE = /\b(?:0|zero|no)\s+actions?\s+(?:were\s+)?(?:sent|dispatched|queued)\b/i;

const DISPATCH_DOWNSTREAM_RE =
  /\b(?:PRs?|pull requests?)\b[^.?!\n]{0,40}\b(?:opened|opening|created|raised|up|live|ready)\b|\b(?:opened|opening|created|raised)\b[^.?!\n]{0,40}\b(?:PRs?|pull requests?)\b/i;

const DISPATCH_ADAPTER: Adapter = {
  claim_type: "dispatch",
  applies_to: new Set(["pm", "chief-of-staff", "operator"]),
  detect: (t) => DISPATCH_CLAIM_RE.test(t) && !ZERO_DISPATCH_RE.test(t),
  actual_count: dispatchedActionsCount,
  claim_sentence: (s) =>
    (DISPATCH_CLAIM_RE.test(s) && !ZERO_DISPATCH_RE.test(s)) ||
    isCompletedClaim(s, DISPATCH_DOWNSTREAM_RE),
  empty_fallback: STATUS_PHRASES.no_change,
};

const SPECIALIST =
  "\\b(?:the|our|my)\\s+(?:engineer|specialist|researcher|marketer|qa(?:\\s+agent)?)\\b";
const HANDED_OFF = "handed\\s+(?:(?:it|this)\\s+)?off";
const CURRENT_TURN_HANDOFF_RES: readonly RegExp[] = [
  new RegExp(
    `\\b(?:it|this|the\\s+(?:task|work|request))\\s+(?:was|got|has\\s+been)\\s+(?:dispatched|${HANDED_OFF})\\s+this\\s+turn\\b`,
    "i",
  ),
  new RegExp(
    `${SPECIALIST}\\s+(?:(?:was|got|has\\s+been)\\s+just\\s+(?:been\\s+)?|has\\s+just\\s+been\\s+)(?:dispatched|${HANDED_OFF})\\b`,
    "i",
  ),
  new RegExp(
    `${SPECIALIST}\\s+(?:was|got|has\\s+been)\\s+(?:dispatched|${HANDED_OFF})\\s+(?:this\\s+turn|just\\s+now)\\b`,
    "i",
  ),
  new RegExp(
    `\\bI(?:'ve|’ve|\\s+have)?\\s+just\\s+(?:dispatched|${HANDED_OFF}\\s+to)\\s+${SPECIALIST}`,
    "i",
  ),
  new RegExp(
    `\\bI(?:'ve|’ve|\\s+have)?\\s+(?:dispatched|${HANDED_OFF}\\s+to)\\s+${SPECIALIST}\\s+(?:this\\s+turn|just\\s+now)\\b`,
    "i",
  ),
];
const INFLIGHT_FOLLOW_ON_RES: readonly RegExp[] = [
  new RegExp(
    `\\b(?:post|report|come|check|get)\\s+back\\b[^.?!\\n]{0,40}\\b(?:once|when|after|as\\s+soon\\s+as)\\s+${SPECIALIST}\\s+(?:finishes|is\\s+done|wraps(?:\\s+up)?|completes|lands)\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:once|when|as\\s+soon\\s+as)\\s+${SPECIALIST}\\s+(?:finishes|is\\s+done|wraps(?:\\s+up)?|completes)\\b[^.?!\\n]{0,40}\\b(?:post|report|share|send|drop)\\b`,
    "i",
  ),
  /\bI(?:'|’)ll\s+(?:have|send|share|post|drop)\b[^.?!\n]{0,30}\b(?:link|PR|result|update)s?\b[^.?!\n]{0,20}\bthen\s*[.!]?\s*$/i,
];
const OFFER_RE =
  /\b(?:if\s+you(?:'d|’d)?\s+(?:want|like)|want\s+me\s+to|shall\s+I|should\s+I|can\s+I|could\s+I|would\s+you)\b/i;

const CUSTOMER_ATTRIBUTION_RE =
  /\b(?:your|their)\s+(?:own\s+)?(?:engineers?|team|developers?|devs?|specialists?|agents?|update|note|message)\b|\bper\s+(?:your|their)\b|\baccording\s+to\s+(?:you|your|them|their)\b|\b(?:as\s+)?you\s+(?:said|mentioned|told\s+me|noted)\b/i;

function isCurrentTurnHandoffSentence(sentence: string): boolean {
  if (OFFER_RE.test(sentence) || CUSTOMER_ATTRIBUTION_RE.test(sentence)) return false;
  return CURRENT_TURN_HANDOFF_RES.some((re) => re.test(sentence));
}

function isFollowOnSentence(sentence: string): boolean {
  if (OFFER_RE.test(sentence) || CUSTOMER_ATTRIBUTION_RE.test(sentence)) return false;
  return INFLIGHT_FOLLOW_ON_RES.some((re) => re.test(sentence));
}

const WORK_SUBJECT =
  "(?:\\b(?:the|our|my)\\s+|\\bZavi(?:'s|’s)\\s+|\\byour\\s+(?=(?:[A-Za-z][\\w&/+-]*\\s+){0,4}specialists?\\b))" +
  "(?:[A-Za-z][\\w&/+-]*\\s+){0,4}?(?:specialist|agent|engineer|researcher|marketer)s?";
const WORK_UNDERWAY_RE = new RegExp(
  `(${WORK_SUBJECT})\\s+(?:is|are)\\s+(?:now\\s+|already\\s+|currently\\s+|still\\s+){0,2}` +
    "(?:working\\s+on\\b|trying\\s+to\\b|on\\s+it\\b|looking\\s+into\\b|digging\\s+into\\b)",
  "i",
);
const CONDITIONAL_LEAD_RE =
  /\b(?:if|once|when|whether|until|unless|while|as\s+soon\s+as|confirm|sure|know|unclear|check|see)\b|n['’]t\b|\b(?:not|never|cannot|no)\b/i;
const QUOTED_SPAN_RE = /"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<![^\s(])'(?:[^'\n]|'(?=\w))+'(?![^\s.,;:!?)])/g;

function workUnderwaySubject(sentence: string): string | null {
  if (OFFER_RE.test(sentence) || CUSTOMER_ATTRIBUTION_RE.test(sentence)) return null;
  if (/\?\s*$/.test(sentence)) return null;
  const unquoted = sentence.replace(QUOTED_SPAN_RE, " ");
  const m = WORK_UNDERWAY_RE.exec(unquoted);
  if (!m) return null;
  const lead = unquoted.slice(0, m.index);
  const clause = lead.slice(Math.max(lead.lastIndexOf(";"), lead.lastIndexOf(","), lead.lastIndexOf(":")) + 1);
  return CONDITIONAL_LEAD_RE.test(clause) ? null : m[1];
}

export function isWorkUnderwaySentence(sentence: string): boolean {
  return workUnderwaySubject(sentence) !== null;
}

const GENERIC_SUBJECT_WORDS = new Set([
  "the", "our", "my", "your", "zavi", "zavi's", "zavi’s", "ai", "own", "new", "same", "other", "growth",
  "specialist", "specialists", "agent", "agents", "marketer", "marketers",
  "ads", "ad", "organic", "paid", "social", "channel", "search", "video", "videos", "s",
]);

function slugWords(slug: string): Set<string> {
  const words = new Set(slug.toLowerCase().split(/[_\s-]+/).filter(Boolean));
  const name = getChannel(slug)?.name;
  if (name) for (const w of name.toLowerCase().split(/[^a-z0-9]+/)) if (w) words.add(w);
  if (words.has("research")) words.add("researcher");
  if (words.has("engineer") || words.has("builder")) words.add("engineer");
  return words;
}

function workingRunBacks(subject: string, working: readonly string[]): boolean {
  if (working.length === 0) return false;
  const named = subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !GENERIC_SUBJECT_WORDS.has(w));
  if (named.length === 0) return true;
  return working.some((slug) => {
    const words = slugWords(slug);
    return named.some((w) => !GENERIC_SUBJECT_WORDS.has(w) && (words.has(w) || words.has(w.replace(/s$/, ""))));
  });
}

function workClaimUnbacked(sentence: string, truth: TruthContext): boolean {
  const subject = workUnderwaySubject(sentence);
  if (subject === null) return false;
  if (truth.thread_children_working === null || truth.tenant_runs_working === null) return false;
  return !workingRunBacks(subject, [...truth.thread_children_working, ...truth.tenant_runs_working]);
}

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const x of line.match(/.*?(?:[.!?]+(?=\s|$)|$)\s*/g) ?? []) {
      if (x.trim().length > 0) out.push(x);
    }
  }
  return out;
}

export function hasWorkUnderwayClaim(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return sentencesOf(text).some(isWorkUnderwaySentence);
}

export function hasInflightHandoffClaim(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return sentencesOf(text).some((s) => isCurrentTurnHandoffSentence(s) || isWorkUnderwaySentence(s));
}

function noThreadChildWorking(truth: TruthContext): boolean {
  return truth.thread_children_working !== null && truth.thread_children_working.length === 0;
}

const INFLIGHT_DISPATCH_ADAPTER: Adapter = {
  claim_type: "dispatch_inflight",
  applies_to: new Set(["pm", "chief-of-staff", "operator"]),
  detect: (text, truth) =>
    truth.thread_children_working !== null &&
    dispatchedActionsCount(truth) === 0 &&
    sentencesOf(text).some(
      (s) => isCurrentTurnHandoffSentence(s) || workClaimUnbacked(s, truth),
    ),
  actual_count: () => 0,
  claim_sentence: (s, truth) =>
    isCurrentTurnHandoffSentence(s) ||
    (noThreadChildWorking(truth) && isFollowOnSentence(s)) ||
    workClaimUnbacked(s, truth),
  empty_fallback: STATUS_PHRASES.no_change,
  skip_blockquotes: true,
};

const THREAD_PROMISE_RE = new RegExp(
  [
    "\\b(?:post|report|send|share|drop|reply|come)(?:s|ed|ing)?\\b[^.?!\\n]{0,40}\\b(?:in|into|to|on)\\s+(?:this|the)\\s+(?:thread|chat|conversation)\\b",
    "\\b(?:post|report|send|share|drop)(?:s|ed|ing)?\\b[^.?!\\n]{0,40}\\bback\\s+here\\b",
  ].join("|"),
  "i",
);

export function mcpFollowLine(run_id: string | null): string {
  return run_id
    ? `Call zavi_get_run_status with run_id ${run_id} to get the specialist's answer when it finishes.`
    : "Call zavi_get_run_status with this run_id to get the specialist's answer when it finishes.";
}

export const MCP_FANOUT_LINE =
  "Call zavi_recent_runs to find each specialist's run_id, then zavi_get_run_status on each to read its answer when it finishes.";

const LATER_RE = /\b(?:will|going\s+to|about\s+to)\b|['’]ll\b|\b(?:once|when|as\s+soon\s+as)\b[^.?!\n]{0,40}\b(?:finish(?:es|ed)?|done|ready|complete[sd]?|lands?)\b/i;

function isThreadPromiseSentence(sentence: string): boolean {
  if (OFFER_RE.test(sentence) || CUSTOMER_ATTRIBUTION_RE.test(sentence)) return false;
  if (/\b(?:not|never|no)\b|n['’]t\b/i.test(sentence)) return false;
  return THREAD_PROMISE_RE.test(sentence) && LATER_RE.test(sentence);
}

function successfulHandoffCount(tool_calls: readonly ReconcilerToolCall[] | undefined, tool: string): number {
  return (tool_calls ?? []).filter(
    (tc) => traceToolName(tc.name) === tool && tc.status === "ok" && !isRepoPickTrace(tc),
  ).length;
}

const MCP_THREAD_PROMISE_ADAPTER: Adapter = {
  claim_type: "thread_promise_no_thread",
  applies_to: "*",
  detect: (text, truth) => truth.surface === "mcp" && sentencesOf(text).some(isThreadPromiseSentence),
  actual_count: () => 0,
  claim_sentence: (s) => isThreadPromiseSentence(s),
  empty_fallback: STATUS_PHRASES.no_change,
  replacement: (truth) => {
    const single = successfulHandoffCount(truth.tool_calls, "praxis__handoff");
    const fanout = successfulHandoffCount(truth.tool_calls, "praxis__handoff_parallel");
    if (single === 1 && fanout === 0) return mcpFollowLine(truth.run_id);
    return single + fanout > 0 ? MCP_FANOUT_LINE : null;
  },
};

const PR_CLAIM_RE = new RegExp(
  [
    "\\b(opened|open|opening|created|raised|submitted|pushed)\\b[^.?!\\n]{0,40}\\b(pull request|PR)\\b",
    "\\bPR\\b[^.?!\\n]{0,30}\\b(against|to)\\b\\s*[`'\"]?(main|master|development|develop)\\b",
    "\\b(preview-only|draft)\\s+PR\\b",
    "\\bPR\\s+is\\s+(up|open|ready|live)\\b",
  ].join("|"),
  "i",
);

const PR_TOOL_RE = /(create_pr|open_pr|create_pull_request|pulls_create)/i;

function prCount(truth: TruthContext): number {
  const parsedStr = JSON.stringify(truth.parsed ?? {});
  if (/https?:\/\/github\.com\/[^\s"']+\/pull\/\d+/i.test(parsedStr)) return 1;

  for (const tc of truth.tool_calls ?? []) {
    if (PR_TOOL_RE.test(traceToolName(tc.name)) && tc.status === "ok") return 1;
  }

  if (truth.envelope_accepted) return 1;

  return 0;
}

const PR_ADAPTER: Adapter = {
  claim_type: "pr",
  applies_to: new Set(["engineer", "product-builder"]),
  detect: (t) => isCompletedClaim(t, PR_CLAIM_RE),
  actual_count: prCount,
  claim_sentence: (s) => isCompletedClaim(s, PR_CLAIM_RE),
  empty_fallback: STATUS_PHRASES.couldnt,
};

const CLAIM_NEGATION_RE =
  /\b(?:not|never|no|havent|hasnt|hadnt|didnt|wont|dont|doesnt|isnt|wasnt|arent|cant|cannot|couldnt|wouldnt|without|un(?:able|sent))\b|n['’]t\b|\byet\s+to\b/i;
const CLAIM_FUTURE_RE =
  /\b(?:will|'ll|’ll|going\s+to|gonna|about\s+to|would|planning\s+to|intend(?:ing)?\s+to|once\s+you|after\s+(?:you\s+)?approv)/i;

function isCompletedClaim(text: string, claimRe: RegExp): boolean {
  const m = claimRe.exec(text);
  if (!m) return false;

  const rawPre = text.slice(Math.max(0, m.index - 40), m.index);
  const pre = rawPre.slice(
    Math.max(
      rawPre.lastIndexOf(";") + 1,
      rawPre.lastIndexOf(",") + 1,
      rawPre.lastIndexOf(".") + 1,
      rawPre.lastIndexOf("\n") + 1,
    ),
  );

  if (CLAIM_NEGATION_RE.test(pre)) return false;

  if (CLAIM_FUTURE_RE.test(m[0]) || CLAIM_FUTURE_RE.test(pre)) return false;

  return true;
}

const EMAIL_SENT_CLAIM_RE = new RegExp(
  [
    "\\bemailed\\b",
    "\\bsent\\b[^.?!\\n]{0,30}\\bemail\\b",
    "\\bemail\\b[^.?!\\n]{0,20}\\b(?:has\\s+been\\s+|was\\s+)?sent\\b",
  ].join("|"),
  "i",
);

function traceNameMatchesAny(
  rawName: string,
  toolNames: ReadonlySet<string>,
): boolean {
  for (const cand of toolNames) {
    if (rawName === cand || rawName.endsWith("__" + cand)) return true;
  }
  return false;
}

const EMAIL_SEND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "email__send",
  "gmail__send",
]);

function successfulEmailSendCount(
  tool_calls: readonly ReconcilerToolCall[] | undefined,
): number {
  if (!tool_calls) return 0;
  let n = 0;
  for (const tc of tool_calls) {
    if (tc.status === "ok" && traceNameMatchesAny(tc.name, EMAIL_SEND_TOOL_NAMES)) n += 1;
  }
  return n;
}

const EMAIL_SENT_ADAPTER: Adapter = {
  claim_type: "email_sent",
  applies_to: new Set(["chief-of-staff", "advisor", "fundraising", "operator"]),
  detect: (t) => isCompletedClaim(t, EMAIL_SENT_CLAIM_RE),
  actual_count: (truth) => successfulEmailSendCount(truth.tool_calls),
  claim_sentence: (s) => isCompletedClaim(s, EMAIL_SENT_CLAIM_RE),
  empty_fallback: STATUS_PHRASES.no_change,
  shadow: true,
};

const SLACK_POSTED_CLAIM_RE = new RegExp(
  [
    "\\bdm'?d\\b",
    "\\bposted\\b[^.?!\\n]{0,30}\\b(to|in)\\b[^.?!\\n]{0,20}\\b(slack|channel|#[\\w-]+|thread)\\b",
    "\\b(sent|posted)\\b[^.?!\\n]{0,20}\\b(the\\s+)?(slack\\s+)?message\\b",
    "\\bslack\\s+message\\s+sent\\b",
  ].join("|"),
  "i",
);

const SLACK_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "slack__post_message",
  "slack__upload_file",
]);

function successfulSlackPostCount(
  tool_calls: readonly ReconcilerToolCall[] | undefined,
): number {
  if (!tool_calls) return 0;
  let n = 0;
  for (const tc of tool_calls) {
    if (tc.status === "ok" && traceNameMatchesAny(tc.name, SLACK_WRITE_TOOL_NAMES)) n += 1;
  }
  return n;
}

const SLACK_POSTED_ADAPTER: Adapter = {
  claim_type: "slack_posted",
  applies_to: new Set(["growth-lead"]),
  detect: (t) => isCompletedClaim(t, SLACK_POSTED_CLAIM_RE),
  actual_count: (truth) => successfulSlackPostCount(truth.tool_calls),
  claim_sentence: (s) => isCompletedClaim(s, SLACK_POSTED_CLAIM_RE),
  empty_fallback: STATUS_PHRASES.no_change,
  shadow: true,
};

const CARD_PART = String.raw`(?:subject(?:\s+lines?)?|preview(?:\s+text)?|body|email\s+\d+|emails?|sequence|card|draft|copy|cta|button|wording)`;
const CARD_CHANGE_CLAIM_RE = new RegExp(
  [
    String.raw`\b${CARD_PART}(?:['’]s\s+[\w ]{1,30})?\s+(?:is|are)\s+now\b(?!\s+(?:too|very|more|less|about|a\s+bit)\b)`,
    String.raw`\b${CARD_PART}(?:['’]s\s+[\w ]{1,30})?\s+now\s+(?:reads?|says?)\b`,
    String.raw`\b${CARD_PART}\s+(?:has|have|was|were)\s+(?:been\s+)?(?:changed|updated|replaced|rewritten|edited|redrafted|swapped)\b`,
    String.raw`\bI(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:changed|updated|replaced|rewrote|rewritten|edited|redrafted|swapped|shortened)\b`,
    String.raw`^\W*(?:done\W+)?(?:changed|updated|replaced|rewrote|edited|redrafted|swapped|shortened)\s+(?:the\s+|your\s+)?${CARD_PART}\b`,
    String.raw`\b(?:updated|new)\s+(?:card|draft)\s+(?:below|above|replaces)\b`,
  ].join("|"),
  "i",
);
const CARD_CHANGE_NOT_DONE_RE = /\b(?:if|once|when|would|could|can't|cannot|will|earlier|previous(?:ly)?)\b/i;

function isCardChangeClaim(sentence: string): boolean {
  return CARD_CHANGE_CLAIM_RE.test(sentence) && !CARD_CHANGE_NOT_DONE_RE.test(sentence);
}

const CARD_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["email__propose_campaign"]);

function cardWriteCount(truth: TruthContext): number {
  let n = 0;
  for (const tc of truth.tool_calls ?? []) {
    if (tc.status === "ok" && traceNameMatchesAny(tc.name, CARD_WRITE_TOOL_NAMES)) n += 1;
  }
  const steps = truth.envelope_accepted ? truth.parsed?.steps : undefined;
  return n + (Array.isArray(steps) ? steps.length : 0);
}

const CARD_CHANGE_ADAPTER: Adapter = {
  claim_type: "card_change",
  applies_to: new Set(["email_marketing"]),
  detect: (t, truth) => truth.chat_turn === true && t.split(/(?<=[.!?])\s+|\n+/).some(isCardChangeClaim),
  actual_count: cardWriteCount,
  claim_sentence: (s, truth) => truth.chat_turn === true && isCardChangeClaim(s),
  empty_fallback: STATUS_PHRASES.no_change,
};

const ADAPTERS: readonly Adapter[] = [
  DISPATCH_ADAPTER,
  INFLIGHT_DISPATCH_ADAPTER,
  PR_ADAPTER,
  EMAIL_SENT_ADAPTER,
  SLACK_POSTED_ADAPTER,
  MCP_THREAD_PROMISE_ADAPTER,
  CARD_CHANGE_ADAPTER,
];

export function removeClaimSentences(
  text: string,
  isClaim: (sentence: string) => boolean,
  opts?: { skipBlockquotes?: boolean; replacement?: string },
): { text: string; removed: number } {
  let removed = 0;
  let replaced = false;
  let inFence = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || (opts?.skipBlockquotes && /^\s*>/.test(line))) {
      out.push(line);
      continue;
    }
    const m = /^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?)(.*)$/.exec(line);
    const prefix = m?.[1] ?? "";
    const body = m?.[2] ?? line;
    const sentences = (body.match(/.*?(?:[.!?]+(?=\s|$)|$)\s*/g) ?? []).filter((x) => x.length > 0);
    const kept: string[] = [];
    for (const sentence of sentences) {
      if (sentence.trim().length > 0 && isClaim(sentence)) {
        removed += 1;
        if (opts?.replacement && !replaced) {
          replaced = true;
          kept.push(`${opts.replacement}${/\s$/.test(sentence) ? " " : ""}`);
        }
        continue;
      }
      kept.push(sentence);
    }
    if (kept.join("") === sentences.join("")) {
      out.push(line);
      continue;
    }
    const rest = kept.join("").trim();
    if (rest.length > 0) out.push(prefix + rest);
  }
  if (removed === 0) return { text, removed: 0 };
  const joined = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: joined, removed };
}

export type ReconcileResult = {
  corrected: boolean;
  text: string;
  mismatch?: { claim_type: string; actual: number };
  removed_sentences?: number;
};

export function reconcileSideEffectClaims(
  input: ReconcilerInput,
  mode: ReconcilerMode = reconcilerModeFromEnv(),
): ReconcileResult {
  if (mode === "off") return { corrected: false, text: input.output_text };
  if (!input.output_text) return { corrected: false, text: input.output_text };
  const parsed =
    input.parsed && typeof input.parsed === "object"
      ? (input.parsed as Record<string, unknown>)
      : null;

  const truth: TruthContext = {
    chat_turn: input.chat_turn,
    parsed,
    tool_calls: input.tool_calls,
    envelope_accepted: input.parse_ok !== false,
    thread_children_working:
      input.thread_children_working === undefined
        ? []
        : input.thread_children_working.ok
          ? input.thread_children_working.value
          : null,
    surface: input.surface ?? null,
    tenant_runs_working: input.tenant_runs_working?.ok ? input.tenant_runs_working.value : null,
    run_id: input.run_id ?? null,
  };

  let text = input.output_text;
  let first: ReconcileResult["mismatch"];
  let firstCorrected: ReconcileResult["mismatch"];
  let removed = 0;
  let fallback: string | null = null;
  for (const a of ADAPTERS) {
    if (a.applies_to !== "*" && !a.applies_to.has(input.agent_slug)) continue;
    if (!a.detect(text, truth)) continue;
    const actual = a.actual_count(truth);
    if (actual > 0) continue;
    const effectiveMode: ReconcilerMode = a.shadow ? "log" : mode;
    first ??= { claim_type: a.claim_type, actual };
    if (effectiveMode !== "rewrite") continue;
    const replacement = a.replacement?.(truth) ?? undefined;
    const r = removeClaimSentences(text, (s) => a.claim_sentence(s, truth), {
      ...(replacement ? { replacement } : {}),
      ...(a.skip_blockquotes ? { skipBlockquotes: true } : {}),
    });
    if (r.removed === 0) continue;
    removed += r.removed;
    text = r.text;
    fallback ??= a.empty_fallback;
    firstCorrected ??= { claim_type: a.claim_type, actual };
  }
  if (!first) return { corrected: false, text: input.output_text };
  if (removed === 0) return { corrected: false, text: input.output_text, mismatch: first };
  return {
    corrected: true,
    text: text.length > 0 ? text : (fallback ?? STATUS_PHRASES.no_change),
    mismatch: firstCorrected ?? first,
    removed_sentences: removed,
  };
}
