
import { deriveToolCapability } from "@/services/mcp/tool-capability";

export type ReceiptEvidence = {
  pr_url?: string | null;
  pr_number?: number | null;
  files_changed?: number | null;
  tool_names?: readonly string[];
  receipts?: readonly string[];
};

export type ReceiptFlags = {
  has_outcome_claim: boolean;
  receipt_in_body: boolean;
  receipt_in_evidence: boolean;
  matched_claims: string[];
};

export type ReceiptResult = {
  hedged: boolean;
  text: string;
  flags: ReceiptFlags;
};

const OUTCOME_CLAIM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:opened|raised|created|submitted|pushed|merged)\s+(?:a\s+|the\s+)?(?:pr|pull\s*request|mr)\b/i, "opened-pr"],
  [/\b(?:shipped|deployed|rolled\s+out|released)\b/i, "shipped"],
  [/\b(?:filed|created|opened)\s+(?:a\s+|the\s+)?(?:ticket|issue|bug|jira)\b/i, "filed-ticket"],
  [/\b(?:posted|sent|messaged|replied)\b.{0,40}\b(?:slack|message|email|thread|channel)\b/i, "posted-message"],
  [/\b(?:sent|emailed)\s+(?:an?\s+)?email\b/i, "sent-email"],
  [/\b(?:committed|pushed)\s+(?:the\s+|a\s+)?(?:fix|change|code|commit)\b/i, "pushed-commit"],
  [/✅\s*(?:shipped|done|deployed|merged|posted|sent|filed)/i, "checkmark-outcome"],
];

const PR_LINK_RE =
  /\bhttps?:\/\/(?:github|gitlab)\.com\/[^\s)]+\/(?:pull|merge_requests|-\/merge_requests)\/\d+/i;

function detectOutcomeClaims(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const matched: string[] = [];
  for (const [re, label] of OUTCOME_CLAIM_PATTERNS) {
    if (re.test(body)) matched.push(label);
  }
  return matched;
}

function prUrlInBody(body: string): boolean {
  return typeof body === "string" && PR_LINK_RE.test(body);
}

function toolNameIsWrite(fullName: string): boolean {
  if (typeof fullName !== "string" || fullName.length === 0) return false;
  const idx = fullName.indexOf("__");
  const server_id = idx >= 0 ? fullName.slice(0, idx) : "";
  const tool_name = idx >= 0 ? fullName.slice(idx + 2) : fullName;
  try {
    return deriveToolCapability({ server_id, tool_name }).write === "yes";
  } catch {
    return false;
  }
}

function receiptInEvidence(ev: ReceiptEvidence | undefined): boolean {
  if (!ev) return false;
  if (Array.isArray(ev.receipts) && ev.receipts.length > 0) return true;
  if (typeof ev.pr_url === "string" && PR_LINK_RE.test(ev.pr_url)) return true;
  if (typeof ev.pr_number === "number" && ev.pr_number > 0) return true;
  if (typeof ev.files_changed === "number" && ev.files_changed > 0) return true;
  if (Array.isArray(ev.tool_names)) {
    return ev.tool_names.some((n) => toolNameIsWrite(String(n)));
  }
  return false;
}

function buildUnverifiedBanner(): string {
  return [
    "> ⚠️ **Unverified result** — this reply says it shipped/filed/posted " +
      "something, but no proof (a PR link, a diff, or a sent message) " +
      "is attached.",
    "> Treat the outcome as **unconfirmed** until you see the artifact (the PR, the ticket, the sent message).",
    "",
    "",
  ].join("\n");
}

export function verifyReceipt(args: {
  body: string;
  evidence?: ReceiptEvidence;
}): ReceiptResult {
  const body = typeof args.body === "string" ? args.body : "";
  const matched = detectOutcomeClaims(body);
  const inEvidence = receiptInEvidence(args.evidence);
  const inBody = prUrlInBody(body) && inEvidence;
  const flags: ReceiptFlags = {
    has_outcome_claim: matched.length > 0,
    receipt_in_body: inBody,
    receipt_in_evidence: inEvidence,
    matched_claims: matched,
  };
  const shouldHedge = flags.has_outcome_claim && !inEvidence;
  if (!shouldHedge) {
    return { hedged: false, text: body, flags };
  }
  return { hedged: true, text: buildUnverifiedBanner() + body, flags };
}

const DEFERRED_PROMISE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:i(?:'|’)?m|i\s+am|we(?:'|’)?re|we\s+are|just)\s+opening\s+(?:a\s+|the\s+)?(?:pr|pull\s*request|mr)\b/i, "opening-pr"],
  [/\bopening\s+(?:a\s+|the\s+)?(?:pr|pull\s*request|mr)\b[^.\n]{0,15}\bnow\b/i, "opening-pr-now"],
  [/\b(?:i(?:'|’)?ll|i\s+will|we(?:'|’)?ll|we\s+will)\s+(?:open|raise|create|submit|put\s+up)\s+(?:a\s+|the\s+)?(?:pr|pull\s*request|mr)\b/i, "will-open-pr"],
  [/\bi(?:'|’)?ll\s+post\s+(?:the|a|it|them|your)\b[^.\n]{0,40}\b(?:link|result|results|summary|back|here|thread)\b/i, "will-post-result"],
  [/\bpost\s+the\s+(?:link|result|pr)\b[^.\n]{0,30}\b(?:when|shortly|in\s+this\s+thread|here)\b/i, "will-post-link"],
  [/\bpr\s+is\s+(?:on\s+its\s+way|coming\s+(?:shortly|soon|now|up)\b)/i, "on-its-way-pr"],
  [/\bthe\s+(?:result|link)\s+is\s+(?:on\s+its\s+way|coming\s+(?:shortly|soon|now|up)\b)/i, "on-its-way-post"],
  [/\bi(?:'|’)?ll\s+email\s+(?:you|them|the\s+team|the\s+group)\b/i, "will-send-email"],
  [/\bi(?:'|’)?ll\s+send\b[^.\n]{0,30}\bemail\b/i, "will-send-email"],
  [/\bi(?:'|’)?ll\s+post\s+the\s+(?:combined\s+)?result\s+back\b/i, "will-post-back"],
];

const PROMISE_NEGATION_BEFORE =
  /\b(?:not|never|without|no\s+need|avoid|instead\s+of|rather\s+than|don'?t|doesn'?t|won'?t|shouldn'?t|can'?t|cannot|hold\s+off|hold\s+on|wait\s+(?:before|on|to)|don'?t\s+want)\b/i;

const CONDITIONAL_OFFER =
  /\b(?:if\s+you(?:'|’)?d?\s*(?:like|want|prefer|wish|need)|if\s+you\s+would\s+(?:like|want|prefer)|if\s+you\s+want|want\s+me\s+to|would\s+you\s+like|let\s+me\s+know\s+if|shall\s+i|should\s+i|do\s+you\s+want)\b/i;

const ADVISORY_BEFORE =
  /\b(?:recommend|suggest|consider|advise|propose|you\s+(?:should|could|might|may|can|ought)|worth|better\s+to|best\s+to)\b/i;

type PromiseFamily = "pr" | "post" | "email";
const UNIVERSAL_BACKING_RE = /(?:handoff|__action\b|emit_decision|\bdispatch|schedule)/i;
const FAMILY_BACKING_RE: Record<PromiseFamily, RegExp> = {
  pr: /(?:open_pr|create_pr|create_pull_request|pull_request)/i,
  post: /(?:__post|slack__(?:post|send|add|reply|upload|create)|render_launch_video|render_video)/i,
  email: /gmail__send/i,
};
const LABEL_FAMILY: Record<string, PromiseFamily> = {
  "opening-pr": "pr",
  "opening-pr-now": "pr",
  "will-open-pr": "pr",
  "will-post-result": "post",
  "will-post-link": "post",
  "will-post-back": "post",
  "on-its-way-pr": "pr",
  "on-its-way-post": "post",
  "will-send-email": "email",
};

const READ_ONLY_TOOL_RE = /(?:^|_|\b)(?:list|get|search|read|fetch|view|show|describe)_/i;

export type PromiseToolCall = { name?: unknown; status?: unknown };

function ranTool(
  toolCalls: readonly PromiseToolCall[] | undefined,
  re: RegExp,
): boolean {
  if (!Array.isArray(toolCalls)) return false;
  return toolCalls.some((t) => {
    const name = typeof t?.name === "string" ? t.name : "";
    if (t?.status !== "ok") return false;
    if (READ_ONLY_TOOL_RE.test(name)) return false;
    return re.test(name);
  });
}

function primaryFamily(families: ReadonlySet<PromiseFamily>): PromiseFamily | null {
  if (families.has("pr")) return "pr";
  if (families.has("email")) return "email";
  if (families.has("post")) return "post";
  return null;
}

function promiseBacked(
  toolCalls: readonly PromiseToolCall[] | undefined,
  families: ReadonlySet<PromiseFamily>,
): boolean {
  const primary = primaryFamily(families);
  if (!primary) return false;
  if (ranTool(toolCalls, UNIVERSAL_BACKING_RE)) return true;
  return ranTool(toolCalls, FAMILY_BACKING_RE[primary]);
}

function detectDeferredPromises(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const matched: string[] = [];
  for (const [re, label] of DEFERRED_PROMISE_PATTERNS) {
    const m = re.exec(body);
    if (!m) continue;
    const before = body.slice(Math.max(0, m.index - 36), m.index);
    if (PROMISE_NEGATION_BEFORE.test(before)) continue;
    if (ADVISORY_BEFORE.test(before)) continue;
    const after = body.slice(m.index, m.index + m[0].length + 40);
    if (CONDITIONAL_OFFER.test(before) || CONDITIONAL_OFFER.test(after)) continue;
    matched.push(label);
  }
  return matched;
}

const UNSTARTED_PROMISE_MARKER = "> ⚠️ **Nothing was started yet**";

function buildUnstartedPromiseBanner(): string {
  return [
    UNSTARTED_PROMISE_MARKER +
      " — this reply promises a deferred action " +
      "(open a PR, post a result, send something), but no such action was actually kicked off this turn.",
    "> Treat it as **not yet done** — re-run or confirm before relying on it.",
    "",
    "",
  ].join("\n");
}

export function deferredPromiseFamilies(reply: string): PromiseFamily[] {
  const body = typeof reply === "string" ? reply : "";
  if (body.includes(UNSTARTED_PROMISE_MARKER)) return [];
  const families = new Set<PromiseFamily>();
  for (const label of detectDeferredPromises(body)) {
    const fam = LABEL_FAMILY[label];
    if (fam) families.add(fam);
  }
  return [...families];
}

export type DeferredPromiseResult = {
  hedged: boolean;
  text: string;
  flags: { has_deferred_promise: boolean; backed: boolean; matched: string[] };
};

export function verifyDeferredPromise(args: {
  reply: string;
  toolCalls?: readonly PromiseToolCall[];
  dispatchedActions?: readonly unknown[];
  hasActiveThreadRun?: boolean;
}): DeferredPromiseResult {
  const body = typeof args.reply === "string" ? args.reply : "";
  if (body.includes(UNSTARTED_PROMISE_MARKER)) {
    return { hedged: false, text: body, flags: { has_deferred_promise: false, backed: false, matched: [] } };
  }
  const matched = detectDeferredPromises(body);
  const families = new Set<PromiseFamily>();
  for (const label of matched) {
    const fam = LABEL_FAMILY[label];
    if (fam) families.add(fam);
  }
  const hasDispatch =
    Array.isArray(args.dispatchedActions) && args.dispatchedActions.length > 0;
  const backed =
    hasDispatch || args.hasActiveThreadRun === true || promiseBacked(args.toolCalls, families);
  const flags = { has_deferred_promise: matched.length > 0, backed, matched };
  if (matched.length === 0 || backed) {
    return { hedged: false, text: body, flags };
  }
  return { hedged: true, text: buildUnstartedPromiseBanner() + body, flags };
}
