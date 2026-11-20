
export type GroundingPattern =
  | "line_cite_not_read"
  | "tc0_state_claim"
  | "tool_count_mismatch"
  | "search_not_read"
  | "over_generalization"
  | "citation_id_not_returned"
  | "unsupported_quant_claim"
  | "linked_record_status_unread"
  | "truncated_scope_overclaim"
  | "self_contradiction";

export interface GroundingFlag {
  pattern: GroundingPattern;
  severity: "hard" | "soft";
  detail: string;
}

export interface ToolCallLite {
  name: string;
  status?: string | null;
  input?: string | null;
  output?: string | null;
  returned_ids?: string[] | null;
}

export interface GroundingInput {
  input?: string | null;
  evidence: ToolCallLite[];
  agent_output: string | null;
  agentSlug?: string | null;
  checkUnsupportedQuant?: boolean;
  checkLinkedRecord?: boolean;
  checkTruncatedScope?: boolean;
  checkSelfContradiction?: boolean;
}

const SYNTHESIZER_AGENTS = new Set<string>(["chief-of-staff", "growth-lead"]);

export interface GroundingResult {
  flags: GroundingFlag[];
  hint: "clean" | "review";
}

const basename = (p: string): string => p.split("/").pop() ?? p;

interface ReadRange {
  start: number;
  end: number;
}

const CONTENT_READ_TOOLS = ["view", "read_file"];
const isContentReadBash = (cmd: string): boolean =>
  /\b(?:cat|sed|head|tail|less|more)\b/.test(cmd) || /\bgrep\b/.test(cmd);

const looksLikeGitPatchOutput = (output: string): boolean =>
  /diff --git /.test(output) || /@@\s*-\d/.test(output);

const isGitContentCmd = (cmd: string): boolean =>
  /\bgit\s+show\b/.test(cmd) ||
  /\bgit\s+diff\b/.test(cmd) ||
  (/\bgit\s+log\b/.test(cmd) && /\s(?:-p\b|--patch\b)/.test(cmd));

function gitShowBlobPath(cmd: string): string | null {
  const m = cmd.match(/\bgit\s+show\s+\S*?:([^\s"\\]+)/);
  return m ? m[1] : null;
}

function gitPatchRangesForFile(
  output: string,
  fileBase: string,
): { ranges: ReadRange[]; sectionPresent: boolean } {
  const ranges: ReadRange[] = [];
  let sectionPresent = false;
  if (!looksLikeGitPatchOutput(output)) return { ranges, sectionPresent };
  for (const sec of output.split(/diff --git /)) {
    const headerPath = sec.match(/^a\/([^\s\\"]+) b\/[^\s\\"]+/);
    const plusPath = sec.match(/\+\+\+ b\/([^\s\\"]+)/);
    const rawPath = headerPath?.[1] ?? plusPath?.[1];
    if (!rawPath || basename(rawPath) !== fileBase) continue;
    sectionPresent = true;
    for (const h of sec.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g)) {
      const startNew = +h[1];
      const lenNew = h[2] !== undefined ? +h[2] : 1;
      if (startNew > 0 && lenNew > 0) ranges.push({ start: startNew, end: startNew + lenNew - 1 });
    }
  }
  return { ranges, sectionPresent };
}

function readRangesForFile(evidence: ToolCallLite[], fileBase: string): {
  ranges: ReadRange[];
  grepLines: Set<number>;
  fileTouchedAtAll: boolean;
} {
  const ranges: ReadRange[] = [];
  const grepLines = new Set<number>();
  let touched = false;

  for (const tc of evidence) {
    const input = tc.input ?? "";
    const output = tc.output ?? "";

    if (CONTENT_READ_TOOLS.some((t) => tc.name.includes(t))) {
      const pathMatch = input.match(/"path"\s*:\s*"([^"]+)"/);
      if (pathMatch && basename(pathMatch[1]) === fileBase) {
        touched = true;
        const rangeMatch = input.match(/"view_range"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/);
        if (rangeMatch) ranges.push({ start: +rangeMatch[1], end: +rangeMatch[2] });
        else ranges.push({ start: 1, end: Infinity });
      }
      continue;
    }

    if (tc.name.includes("run_bash")) {
      const cmdMatch = input.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const cmd = cmdMatch ? cmdMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : input;
      const cmdMentionsFile = cmd.includes(fileBase);

      if (cmdMentionsFile && /\b(?:cat|head|tail)\b/.test(cmd)) {
        touched = true;
        ranges.push({ start: 1, end: Infinity });
      }
      if (cmdMentionsFile) {
        const sedSpecs = cmd.match(/sed\s+-n\s+'([^']+)'/g) ?? [];
        for (const spec of sedSpecs) {
          for (const r of spec.matchAll(/(\d+)\s*,\s*(\d+)\s*p/g)) {
            touched = true;
            ranges.push({ start: +r[1], end: +r[2] });
          }
        }
      }
      if (/\bgrep\b/.test(cmd)) {
        for (const m of output.matchAll(/([\w./[\]-]+):(\d+):/g)) {
          if (basename(m[1]) === fileBase) {
            touched = true;
            grepLines.add(+m[2]);
          }
        }
      }
      if (isGitContentCmd(cmd)) {
        const { ranges: gitRanges, sectionPresent } = gitPatchRangesForFile(output, fileBase);
        if (sectionPresent) {
          touched = true;
          ranges.push(...gitRanges);
        }
        const blobPath = gitShowBlobPath(cmd);
        if (blobPath && basename(blobPath) === fileBase && !/diff --git /.test(output)) {
          touched = true;
          ranges.push({ start: 1, end: Infinity });
        }
      }
      continue;
    }
  }
  return { ranges, grepLines, fileTouchedAtAll: touched };
}

const lineInRanges = (line: number, ranges: ReadRange[]): boolean =>
  ranges.some((r) => line >= r.start && line <= r.end);

function hadContentRead(evidence: ToolCallLite[]): boolean {
  return evidence.some((tc) => {
    if (CONTENT_READ_TOOLS.some((t) => tc.name.includes(t))) return true;
    if (tc.name.includes("run_bash")) {
      const cmdMatch = (tc.input ?? "").match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const cmd = cmdMatch ? cmdMatch[1] : "";
      if (cmd && isContentReadBash(cmd)) return true;
      if (isGitContentCmd(cmd) && (looksLikeGitPatchOutput(tc.output ?? "") || gitShowBlobPath(cmd)))
        return true;
      return false;
    }
    return false;
  });
}

const CITE_RE = /([\w.[\]-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md)):(\d+)(?:-(\d+))?/g;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SRC_CITE_RE = /\[src:\s*([^\]]+)\]/gi;

const STATE_CLAIM_RES: ReadonlyArray<readonly [RegExp, string]> = [
  [/sitting in\s+`?\/?approvals/i, "claims proposal is in /approvals"],
  [/\balready (?:staged|in\s+\/?approvals|exists on github|implemented at)\b/i, "claims already-staged/exists"],
  [/\bdropped silently\b/i, "claims a prior proposal dropped silently"],
  [/\bis\s+(?:not\s+)?(?:tracked|staged|committed)\b/i, "asserts git tracked/staged state"],
  [/git\s+ls-files[^]*\bempty\b/i, "asserts git ls-files result"],
  [/\bno bundled reverts\b/i, "asserts the staged diff has no reverts"],
  [/waiting for your click/i, "asserts an approval is queued"],
];

const ZERO_HITS_RE = /\b(?:0|zero|no)\s+(?:hits|results|matches)\b/i;

const OVERGEN_RES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\ball\s+\d+\s+\w+/i, '"all N <things>" blanket claim'],
  [/\bevery\s+(?:caller|site|consumer|push[- ]?site|usage|reference)\b/i, '"every caller/site" blanket claim'],
  [/\bno behavior change\b/i, '"no behavior change" claim'],
  [/\bnothing else\s+(?:uses|depends|touches|relies)/i, '"nothing else uses this" claim'],
];

const BEHAVIORAL_RES: ReadonlyArray<RegExp> = [
  /\bdisplay-only\b/i,
  /\bno money moves?\b/i,
  /\bno double-bill\b/i,
  /\b(?:is|it's|its)\s+safe\b/i,
  /\byes,\s*safe\b/i,
  /\bthe (?:local )?variable (?:was|is) (?:already )?\d/i,
  /\bevery other status\b/i,
];

const stripCodeFences = (s: string): string => s.replace(/```[^]*?```/g, " ");

function citeInInboundContext(fileBase: string, line: number, context: string): boolean {
  if (!context) return false;
  for (const m of context.matchAll(CITE_RE)) {
    if (basename(m[1]) !== fileBase) continue;
    const start = +m[2];
    const end = m[3] !== undefined ? +m[3] : start;
    if (line >= Math.min(start, end) && line <= Math.max(start, end)) return true;
  }
  return false;
}

const QUANT_DOLLAR = /\$\s?\d[\d,]*(?:\.\d+)?/;
const QUANT_PERCENT = /\b\d+(?:\.\d+)?\s?%/;
const QUANT_FORMULA = /\b\d[\d,.]*\s*[+\-*/×]\s*\d[\d,.]*|\b(?:max|min|sum|avg|round)\s*\(/i;
const QUANT_BARE = /\b\d{1,3}(?:,\d{3})+\b|\b\d{2,}(?:\.\d+)?\b|\b\d+\.\d+\b/;

const LIVE_STATE_FRAMING: ReadonlyArray<RegExp> = [
  /\b(?:your|our)\s+(?:[\w-]+\s+){0,2}?(?:revenue|gmv|mrr|arr|sales|payout|earnings|profit|margin)\b/i,
  /\b(?:revenue|gmv|mrr|arr|payouts?|earnings|profit|margin)\b[^.?!\n]{0,40}\b(?:is|was|are|were|came\s+in\s+at|sits\s+at|stands\s+at|totals?|reached|of)\b\s*\**\$?\s?\d/i,
  /\$\s?\d[\d,.]*(?:\s*\/\s*\w+)?\s+in\s+(?:revenue|gmv|sales|payouts?|earnings|profit)\b/i,
  /\byou (?:have|currently have|now have|made|earned|booked|sold|did)\b/i,
  /\b(?:there are|we have|the (?:db|database|data) shows|your (?:data|db|database|account|numbers?) shows?)\b/i,
  /\b(?:active|total|current)\s+(?:users?|listings?|bookings?|hosts?|customers?|transactions?|orders?)\b/i,
  /\b(?:average|avg|median)\s+(?:price|rate|value|spend|order|booking|fee|revenue)\b/i,
  /\b(?:count|number)\s+of\s+(?:users?|listings?|bookings?|hosts?|customers?|transactions?|orders?)\b/i,
  /\byour\s+(?:cost|costs|price|pricing|fee|fees|rate|rates|charge|charges|payout|payouts|spend|bill|invoice)\b/i,
  /\byou(?:'|’)?(?:re)?\s+(?:charge|charged|charging|pay|paid|are\s+charged|spend|spent|earn|earned|earning|make|making|generate|generated|generating|pull(?:ing)?\s+in|bring(?:ing)?\s+in|collect|collected)\b/i,
  /\b(?:the|current|your)\s+(?:fee|cost|charge|price|payout|rate|total)\s+(?:is|was|comes?\s+to|of|for)\b/i,
  /\b(?:works?\s+out\s+to|comes?\s+to|amounts?\s+to|totals?)\s+\$?\s?\d/i,
  /\b(?:your|our)\b[^.?!\n]{0,32}\btake[-\s]?rate\b/i,
  /\btake[-\s]?rate\s+(?:is|was|of|stands|runs|came\s+in|sits)\b/i,
  /\b(?:formula|computed|calculated)\b|\(from\s+code\)/i,
  /\$\s?\d[\d,.]*\s*\/\s*(?:day|night|wk|week|mo|month|hr|hour)\b[^.?!\n]{0,40}\b(?:trip|extension|booking|listing|host|plan|payout|your|the\s+account)\b/i,
  /\b(?:trip|extension|booking|listing|host|plan|payout|your|the\s+account)\b[^.?!\n]{0,40}\$\s?\d[\d,.]*\s*\/\s*(?:day|night|wk|week|mo|month|hr|hour)\b/i,
];

const normalizeQuant = (s: string): string => s.replace(/[$,%\s]/g, "");

function quantInContext(token: string, context: string): boolean {
  if (!context) return false;
  const t = normalizeQuant(token);
  if (t.length === 0) return false;
  return normalizeQuant(context).includes(t);
}

const NON_LIVE_EVIDENCE_TOOL_RE = /(?:^|__)(?:memory|brain)(?:__|_|$)/i;

function successfulToolOutputCorpus(evidence: ToolCallLite[]): Set<string> {
  const tokens = new Set<string>();
  for (const tc of evidence) {
    if (NON_LIVE_EVIDENCE_TOOL_RE.test(tc.name ?? "")) continue;
    const status = (tc.status ?? "").toLowerCase();
    const succeeded =
      status === "ok" ||
      status === "success" ||
      status === "completed" ||
      status === "";
    if (!succeeded) continue;
    const out = (tc.output ?? "").trim();
    if (out.length === 0) continue;
    if (/^(?:null|\[\]|\{\}|""|none)$/i.test(out)) continue;
    if (/"(?:rows|data|items|results)"\s*:\s*(?:\[\s*\]|null)/.test(out)) continue;
    if (/"_truncated"\s*:\s*true/.test(out)) continue;
    for (const tok of allQuantTokens(out)) tokens.add(normalizeQuant(tok));
  }
  return tokens;
}

function quantInToolOutput(token: string, corpus: Set<string>): boolean {
  if (corpus.size === 0) return false;
  const t = normalizeQuant(token);
  if (t.length === 0) return false;
  return corpus.has(t);
}

function isOperatorDbDataRead(name: string): boolean {
  return (
    /operator_db/.test(name) &&
    /(query|codeact|transaction|bookings_by|active_supply|funnel)/.test(name)
  );
}

function hadSuccessfulOperatorDbRead(evidence: ToolCallLite[]): boolean {
  return evidence.some((tc) => {
    if (!isOperatorDbDataRead(tc.name ?? "")) return false;
    const st = (tc.status ?? "").toLowerCase();
    if (!(st === "ok" || st === "success" || st === "completed" || st === "")) return false;
    const out = (tc.output ?? "").trim();
    if (out.length === 0) return false;
    if (/^(?:null|\[\]|\{\}|""|none)$/i.test(out)) return false;
    if (/"(?:rows|data|items|results)"\s*:\s*(?:\[\s*\]|null)/.test(out)) return false;
    return true;
  });
}

const DERIV_TABLE_ROW = /^\s*\|.*\|.*\|/m;
const DERIV_ARITH_DIGITS = /\d[\d,.]*\s*[−\-+*/×]\s*\$?\s?\d[\d,.]*/;
const DERIV_FORMULA_PAREN = /\([^)]*[−\-+*/×][^)]*[−\-+*/×][^)]*\)/;
const DERIV_COMPUTED_PHRASE =
  /\b(?:sum of|summed (?:from|across)|after (?:subtracting|deducting)|breakdown|computed (?:as|from)|calculated (?:as|from))\b/i;
function showsDerivation(prose: string): boolean {
  return (
    DERIV_TABLE_ROW.test(prose) ||
    DERIV_ARITH_DIGITS.test(prose) ||
    DERIV_FORMULA_PAREN.test(prose) ||
    DERIV_COMPUTED_PHRASE.test(prose)
  );
}

function allQuantTokens(sentence: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of [QUANT_DOLLAR, QUANT_PERCENT, QUANT_FORMULA, QUANT_BARE]) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of sentence.matchAll(g)) {
      const tok = m[0].trim();
      if (tok && !seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }
  return out;
}

const LINKED_RECORD_ID_RE =
  /\b(pendingPaymentId|pendingPaymentFromUser|paymentIntentId|stripePaymentIntentId|chargeId|payoutIds?|refundId|disputeId|invoiceId)\b["']?\s*[:=]\s*\[?\s*["']?([A-Za-z0-9_]{6,})/gi;

const PAYMENT_MECHANICS_RES: ReadonlyArray<RegExp> = [
  /\bauthoriz(?:ation|ed)?\s+hold\b/i,
  /\bauth\s+hold\b/i,
  /\bpre-?auth(?:orization)?\b/i,
  /\bscheduled\s+(?:future\s+)?charge\b/i,
  /\bwill\s+be\s+charged\b/i,
  /\bdrops?\s+off\b/i,
  /\bpending\s+charge\b/i,
  /\bcharged\s+(?:closer\s+to|nearer\s+to|near|on|at|before)\b/i,
  /\bhold\s+(?:that\s+|which\s+)?(?:drops?|will|clears?|releases?|expires?)\b/i,
  /\b(?:likely|probably|typically|usually|most\s+likely|should\s+be)\b[^.!?\n]{0,48}\b(?:charge|charged|hold|capture|captured|bill|billed|payment|scheduled|debit)\b/i,
];

export function isPaymentMechanicsSentence(sentence: string): boolean {
  return PAYMENT_MECHANICS_RES.some((re) => re.test(sentence));
}

function idDereferencedAsQueryInput(idValue: string, evidence: ToolCallLite[]): boolean {
  const needle = idValue.toLowerCase();
  for (const tc of evidence) {
    const status = (tc.status ?? "").toLowerCase();
    const succeeded =
      status === "ok" || status === "success" || status === "completed" || status === "";
    if (!succeeded) continue;
    if ((tc.input ?? "").toLowerCase().includes(needle)) return true;
  }
  return false;
}

const Q = '\\\\?"';
const TRUNCATION_ENVELOPE = new RegExp(`${Q}_truncated${Q}\\s*:\\s*true`);
const RETURNED_FIELD = new RegExp(`${Q}_returned${Q}\\s*:\\s*(\\d+)`);
const TOTAL_FIELD = new RegExp(`${Q}_total${Q}\\s*:\\s*(\\d+)`);

const OBSERVED_STATE_RE =
  /\b(?:paused|active|archived|deleted|removed|disabled|enabled|stopped|running|live|inactive|no\s+delivery|not\s+delivering|zero\s+delivery|had\s+no\s+(?:delivery|spend|impressions)|no\s+spend)\b/i;

const HONEST_ABSTENTION_RE =
  /\b(?:can(?:'|’)?t|cannot|could\s+not|couldn(?:'|’)?t|unable\s+to|won(?:'|’)?t)\s+(?:tell|say|verify|confirm|report|know)|\bnot\s+returned\b|\bwere\s+not\s+(?:in|included)\b|\bwithout\s+paginating\b|\bneed\s+to\s+paginate\b/i;

const QUOTING_RE =
  /(?:you|the\s+user|they|he|she|the\s+report|the\s+doc(?:ument)?)\s+(?:wrote|said|claims?|claimed|states?|stated)\b|\bquoting\b|\bper\s+your\s+message\b|^\s*>/i;

type TruncatedPage = { returned: number; total: number; name: string; index: number };

function truncatedPages(evidence: readonly ToolCallLite[]): TruncatedPage[] {
  const out: TruncatedPage[] = [];
  evidence.forEach((call, index) => {
    const body = call.output ?? "";
    if (!TRUNCATION_ENVELOPE.test(body)) return;
    const r = body.match(RETURNED_FIELD);
    const t = body.match(TOTAL_FIELD);
    if (!r || !t) return;
    const returned = Number(r[1]);
    const total = Number(t[1]);
    if (!Number.isFinite(returned) || !Number.isFinite(total)) return;
    if (total > returned) out.push({ returned, total, name: call.name, index });
  });
  return out;
}

function laterCallCoveredThePage(
  evidence: readonly ToolCallLite[],
  page: TruncatedPage,
): boolean {
  return evidence.some((call, index) => {
    if (index <= page.index) return false;
    if (call.name !== page.name) return false;
    if (call.status && call.status !== "success" && call.status !== "ok") return false;
    const body = call.output ?? "";
    if (!body) return false;
    if (TRUNCATION_ENVELOPE.test(body)) {
      const r = body.match(RETURNED_FIELD);
      return !!r && Number(r[1]) >= page.total;
    }
    const t = body.match(TOTAL_FIELD);
    return !!t && Number(t[1]) >= page.total;
  });
}

function returnedScopeRe(returned: number): RegExp {
  const r = String(returned);
  return new RegExp(
    `\\b(?:the\\s+)?${r}\\s+(?:returned|shown|listed|received|fetched|visible|displayed)\\b|\\bof\\s+the\\s+${r}\\b`,
    "i",
  );
}

function unseenRowPhrases(unseen: number): { numbered: RegExp[]; unnumbered: RegExp[] } {
  const n = String(unseen);
  return {
    numbered: [
      new RegExp(`\\b${n}\\s+(?:others?|remaining|more)\\b`, "i"),
      new RegExp(`\\bthe\\s+(?:other|remaining)\\s+${n}\\b`, "i"),
    ],
    unnumbered: [
      /\bthe\s+rest\s+(?:of\s+(?:them|the\s+\w+)\s+)?(?:are|were|is|was|have|had)\b/i,
      /(?:^|[,:]\s*)(?:all\s+)?(?:the\s+)?others?\s+(?:are|were)\b/i,
      /\bthe\s+remaining\s+(?:ones|campaigns|rows|items)\b/i,
    ],
  };
}

function nonFencedLines(text: string): string[] {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map<string, number>([
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);

const COUNT_CLAIM_RE =
  /\b(?:the\s+)?(two|three|four|five|six|seven|eight|nine|ten|[2-9]|10)\s+((?:[a-z][a-z-]*\s+){0,2}[a-z][a-z-]*s)\b/i;

const NOT_A_LIST_NOUN_RE =
  /^(?:seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?|times|dollars?|cents?|points?|percent|others?|remaining|rows?|records?|results?|customers?|users?|tenants?|hosts?|pass(?:es)?|fails?|gaps?|skips?|errors?|warnings?|findings?|is|was|has|does|says|goes|gets|this|thus|plus|less|its|news|series|status|progress|business)$/i;

const PLURAL_NOUN_HEAD_RE = /^[a-z][a-z-]{2,}s$/i;

const COUNT_NOT_THE_SUBJECT_RE =
  /\b(?:of|out\s+of|by|via|using|with|from|across|through|against|between|among|per)\s+(?:the\s+)?$|[\d.]$/i;

const APPROX_COUNT_RE =
  /\b(?:about|around|roughly|approximately|at\s+least|at\s+most|up\s+to|over|under|more\s+than|fewer\s+than|nearly|almost|some|several)\b|~/i;

const CAVEAT_ITEM_RE =
  /^(?:\*\*|__|\*|_)?\s*(?:note|notes|nb|caveat|caveats|caution|important|bonus|aside|source|sources|methodology|assumption|assumptions|disclaimer|limitation|limitations|next\s+steps?|recommendations?|worth\s+noting|one\s+more\s+thing|not\s+included|excluded)\b/i;

const LIST_ITEM_RE = /^(\s*)(?:(\d{1,2})[.)]\s+|([-*•+])\s+)(.*)$/;

interface ListItem {
  indent: number;
  ordered: boolean;
  num: number | null;
  text: string;
}

function parseListItem(line: string): ListItem | null {
  const m = line.match(LIST_ITEM_RE);
  if (!m) return null;
  return {
    indent: m[1].length,
    ordered: m[2] !== undefined,
    num: m[2] !== undefined ? Number(m[2]) : null,
    text: (m[4] ?? "").trim(),
  };
}

function adjacentEnumeration(lines: readonly string[], fromLine: number): ListItem[] | null {
  let i = fromLine + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const first = i < lines.length ? parseListItem(lines[i]) : null;
  if (!first) return null;
  const items: ListItem[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const item = parseListItem(line);
    if (!item) {
      if (line.search(/\S/) > first.indent) continue;
      break;
    }
    if (item.indent > first.indent) continue;
    if (item.indent < first.indent) break;
    if (item.ordered !== first.ordered) break;
    items.push(item);
  }
  return items;
}

const orderedNumberingIsContiguous = (items: readonly ListItem[]): boolean =>
  items.every((it, idx) => it.num === idx + 1);

function withoutTrailingCaveats(items: readonly ListItem[]): ListItem[] {
  const out = [...items];
  while (out.length > 0 && CAVEAT_ITEM_RE.test(out[out.length - 1].text)) out.pop();
  return out;
}

const GROUPING_ITEM_RE = /[,;]|^(?:\*\*|__)?[^:\n]{1,40}:\s*\S/;

function countVsEnumerationFlag(lines: readonly string[]): GroundingFlag | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (parseListItem(line)) continue;
    if (/^\s{0,3}#{1,6}\s/.test(line)) continue;
    const m = line.match(COUNT_CLAIM_RE);
    if (!m) continue;
    const every = line.match(new RegExp(COUNT_CLAIM_RE.source, "gi"));
    if (every && every.length > 1) continue;
    if (APPROX_COUNT_RE.test(line)) continue;
    if (COUNT_NOT_THE_SUBJECT_RE.test(line.slice(0, m.index ?? 0))) continue;
    if (/[.!?]\s/.test(line.slice((m.index ?? 0) + m[0].length))) continue;
    const lead = m[1].toLowerCase();
    const stated = NUMBER_WORDS.get(lead) ?? Number(lead);
    if (!Number.isFinite(stated)) continue;
    const head = (m[2].trim().split(/\s+/).pop() ?? "").toLowerCase();
    if (!PLURAL_NOUN_HEAD_RE.test(head)) continue;
    if (NOT_A_LIST_NOUN_RE.test(head)) continue;
    const items = adjacentEnumeration(lines, i);
    if (!items || items.length === 0) continue;
    if (items[0].ordered && !orderedNumberingIsContiguous(items)) continue;
    const counted = withoutTrailingCaveats(items);
    if (counted.length === 0 || counted.length === stated) continue;
    if (counted.length < stated && counted.some((it) => GROUPING_ITEM_RE.test(it.text))) continue;
    return {
      pattern: "self_contradiction",
      severity: "soft",
      detail:
        `says "${m[0].trim()}" but the enumeration directly under it has ` +
        `${counted.length} top-level item${counted.length === 1 ? "" : "s"} — ` +
        `the answer disagrees with itself`,
    };
  }
  return null;
}

interface MarkdownTable {
  headers: string[];
  rows: string[][];
  start: number;
  end: number;
}

const isTableLine = (line: string): boolean => /^\s*\|.*\|/.test(line);
const isSeparatorRow = (line: string): boolean =>
  /^[\s|:-]+$/.test(line) && line.includes("-") && line.includes("|");

const splitCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parseTables(lines: readonly string[]): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isTableLine(lines[i])) continue;
    if (!isTableLine(lines[i + 1]) || !isSeparatorRow(lines[i + 1])) continue;
    const headers = splitCells(lines[i]);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j]) && !isSeparatorRow(lines[j]); j++) {
      rows.push(splitCells(lines[j]));
    }
    tables.push({ headers, rows, start: i, end: j - 1 });
    i = j - 1;
  }
  return tables;
}

const stripEmphasis = (s: string): string => s.replace(/[*_`]/g, "").trim();

function numericCell(raw: string): number | null {
  const s = stripEmphasis(raw);
  if (!/^\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^\$?\s?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const TOTAL_ROW_LABEL_RE = /^(?:total|totals|sum|subtotal|overall|all|grand\s+total|combined)\b/i;
const PARTIAL_ROW_LABEL_RE = /^(?:\.\.\.|…|others?|remaining|rest\b|everything\s+else)/i;
const TIME_LABEL_RE =
  /^(?:\d{4}(?:-\d{2}){0,2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:\s+'?\d{2,4})?|q[1-4](?:\s*\d{4})?|(?:week|wk|day)\s*\d+|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))$/i;
const PARTIAL_SCOPE_RE =
  /\b(?:top|first|largest|biggest|leading|highest|lowest|bottom|sample|excerpt|selected|a\s+few|handful|some\s+of|among\s+the|truncated|showing\s+\d+\s+of|page\s+\d+|per\s+page)\b|…|\.\.\./i;
const TOTAL_FRAMING_RE =
  /\b(?:in\s+total|total(?:s|ing|ling|led)?|altogether|combined|overall|all\s+up|across\s+(?:all|the)|has|have|had|there\s+(?:is|are|were)|we\s+(?:have|had|run|operate)|you\s+(?:have|had|run|operate)|shows?|sits\s+at|stands\s+at)\b/i;
const APPROX_TOTAL_RE =
  /~|≈|\b(?:about|around|roughly|approximately|nearly|almost|over|under|more\s+than|less\s+than|at\s+least|north\s+of|ish|order\s+of)\b/i;
const STATED_NUMBER_RE = /(?<![\w.,\-])(\d{1,3}(?:,\d{3})+|\d{2,})(?![\d,]*(?:\.\d|%))/g;

const TOKEN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "by", "per", "at",
  "is", "are", "was", "were", "has", "have", "had", "this", "that", "it", "its",
  "their", "we", "you", "our", "your", "all", "total", "totals", "count", "counts",
  "number", "numbers", "active", "new", "current", "now", "right", "across",
  "there", "from", "with", "them", "these", "those", "today", "overall",
]);

function contentTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.split(/[^A-Za-z]+/)) {
    const lower = w.toLowerCase();
    if (lower.length === 0 || TOKEN_STOPWORDS.has(lower)) continue;
    const singular = lower.replace(/ies$/, "y").replace(/s$/, "");
    if (singular.length >= 3 && !TOKEN_STOPWORDS.has(singular)) out.add(singular);
  }
  return out;
}

function totalVsBreakdownFlag(
  lines: readonly string[],
  evidence: readonly ToolCallLite[],
): GroundingFlag | null {
  if (truncatedPages(evidence).length > 0) return null;

  for (const table of parseTables(lines)) {
    if (table.rows.length < 2) continue;
    const labels = table.rows.map((r) => stripEmphasis(r[0] ?? ""));
    if (labels.some((l) => PARTIAL_ROW_LABEL_RE.test(l))) continue;
    if (labels.filter((l) => TIME_LABEL_RE.test(l)).length * 2 >= labels.length) continue;

    const dataRows = table.rows.filter(
      (r) => !TOTAL_ROW_LABEL_RE.test(stripEmphasis(r[0] ?? "")),
    );
    if (dataRows.length < 2) continue;

    const windowText = [
      ...lines.slice(Math.max(0, table.start - 4), table.start),
      ...lines.slice(table.end + 1, table.end + 5),
    ]
      .filter((l) => !isTableLine(l))
      .join("\n");
    if (PARTIAL_SCOPE_RE.test(windowText)) continue;
    if (table.headers.some((h) => PARTIAL_SCOPE_RE.test(h))) continue;

    const printed = new Set<number>();
    for (const row of table.rows) {
      for (const cell of row) {
        const v = numericCell(cell);
        if (v !== null) printed.add(v);
      }
    }

    const columns: Array<{ header: string; sum: number; rows: number }> = [];
    for (let c = 1; c < table.headers.length; c++) {
      const vals = dataRows.map((r) => numericCell(r[c] ?? ""));
      if (vals.some((v) => v === null)) continue;
      const nums = vals as number[];
      const sum = nums.reduce((a, b) => a + b, 0);
      if (sum <= 0) continue;
      columns.push({ header: stripEmphasis(table.headers[c] ?? ""), sum, rows: nums.length });
    }
    if (columns.length === 0) continue;

    const sentences = windowText
      .split(/(?<=[.!?:])\s+|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      if (!TOTAL_FRAMING_RE.test(sentence)) continue;
      const lowerSentence = sentence.toLowerCase();
      if (labels.some((l) => l.length >= 3 && lowerSentence.includes(l.toLowerCase()))) continue;
      const approx = APPROX_TOTAL_RE.test(sentence);
      for (const m of sentence.matchAll(STATED_NUMBER_RE)) {
        const stated = Number(m[1].replace(/,/g, ""));
        if (!Number.isFinite(stated) || stated <= 0) continue;
        if (/^\d{4}$/.test(m[1]) && stated >= 1900 && stated <= 2100) continue;
        if (printed.has(stated)) continue;
        const at = m.index ?? 0;
        const quantified =
          sentence.slice(at + m[1].length).match(/^[^.,;:()\n]{0,40}/)?.[0] ?? "";
        const near = contentTokens(quantified);
        for (const col of columns) {
          const shared = [...contentTokens(col.header)].filter((t) => near.has(t));
          if (shared.length === 0) continue;
          const tolerance = Math.max(1, col.sum * (approx ? 0.1 : 0.02));
          if (Math.abs(stated - col.sum) <= tolerance) continue;
          return {
            pattern: "self_contradiction",
            severity: "soft",
            detail:
              `states "${m[1]}" as a total, but its own breakdown in the same answer ` +
              `("${col.header}", ${col.rows} rows) sums to ${col.sum} — ` +
              `the answer disagrees with itself`,
          };
        }
      }
    }
  }
  return null;
}

export function runGroundingChecks(run: GroundingInput): GroundingResult {
  const flags: GroundingFlag[] = [];
  const isSynthesizer = !!run.agentSlug && SYNTHESIZER_AGENTS.has(run.agentSlug);
  const out = run.agent_output ?? "";
  const prose = stripCodeFences(out);
  const evidence = run.evidence ?? [];

  const citesSeen = new Set<string>();
  for (const m of prose.matchAll(CITE_RE)) {
    const fileBase = basename(m[1]);
    const line = +m[2];
    const key = `${fileBase}:${line}`;
    if (citesSeen.has(key)) continue;
    citesSeen.add(key);
    const { ranges, grepLines, fileTouchedAtAll } = readRangesForFile(evidence, fileBase);
    const grounded = lineInRanges(line, ranges) || grepLines.has(line);
    if (!grounded) {
      const fromInbound = citeInInboundContext(fileBase, line, run.input ?? "");
      const grepOnly = fileTouchedAtAll && ranges.length === 0;
      flags.push({
        pattern: "line_cite_not_read",
        severity: fromInbound || grepOnly ? "soft" : "hard",
        detail: fromInbound
          ? `cites ${fileBase}:${line}; present in inbound context (provenance) — not tool-verified this run (internal-only)`
          : !fileTouchedAtAll
            ? `cites ${fileBase}:${line} but ${fileBase} was never read this run`
            : grepOnly
              ? `cites ${fileBase}:${line}; only grepped (line may be in truncated grep output) — verify`
              : `cites ${fileBase}:${line} but no view/sed range covered line ${line}`,
      });
    }
  }

  if (evidence.length === 0) {
    for (const [re, why] of STATE_CLAIM_RES) {
      if (re.test(prose)) {
        flags.push({
          pattern: "tc0_state_claim",
          severity: isSynthesizer ? "soft" : "hard",
          detail: `tc=0 but ${why}${isSynthesizer ? " (synthesizer: hydration recap — soft)" : ""}`,
        });
        break;
      }
    }
  }

  if (ZERO_HITS_RE.test(prose)) {
    let maxTotal = 0;
    for (const tc of evidence) {
      if (!/search_code|search_issues/.test(tc.name)) continue;
      for (const t of (tc.output ?? "").matchAll(/"total"\s*:\s*(\d+)/g)) maxTotal = Math.max(maxTotal, +t[1]);
    }
    if (maxTotal > 0) {
      flags.push({
        pattern: "tool_count_mismatch",
        severity: "hard",
        detail: `output claims "0 hits" but a search_code returned total=${maxTotal}`,
      });
    }
  }

  if (evidence.length > 0 && !hadContentRead(evidence)) {
    const behavioral = BEHAVIORAL_RES.find((re) => re.test(prose));
    if (behavioral) {
      flags.push({
        pattern: "search_not_read",
        severity: "soft",
        detail: "asserts code behavior/safety but no view/read_file/cat/sed/grep produced file contents this run",
      });
    }
  }

  for (const [re, why] of OVERGEN_RES) {
    if (re.test(prose)) {
      flags.push({ pattern: "over_generalization", severity: "soft", detail: why });
      break;
    }
  }

  const returnedIds = new Set<string>();
  for (const tc of evidence) {
    for (const id of tc.returned_ids ?? []) returnedIds.add(id.toLowerCase());
  }
  if (returnedIds.size > 0) {
    const cited = new Set<string>();
    for (const m of prose.matchAll(UUID_RE)) cited.add(m[0].toLowerCase());
    for (const b of prose.matchAll(SRC_CITE_RE)) {
      for (const t of b[1].split(/[,\s]+/)) {
        const tok = t.trim().toLowerCase();
        if (/^[0-9a-f]{8,}$/.test(tok)) cited.add(tok);
      }
    }
    const backed = (tok: string): boolean => {
      for (const rid of returnedIds) {
        if (rid === tok || rid.startsWith(tok) || tok.startsWith(rid)) return true;
      }
      return false;
    };
    const unbacked = [...cited].filter((t) => !backed(t));
    if (unbacked.length > 0) {
      flags.push({
        pattern: "citation_id_not_returned",
        severity: "soft",
        detail: `cites ${unbacked.length} id(s) no tool returned this run (e.g. ${unbacked.slice(0, 2).join(", ")})`,
      });
    }
  }

  if (run.checkUnsupportedQuant) {
    const context = run.input ?? "";
    const toolCorpus = successfulToolOutputCorpus(evidence);
    const hadDataRead = hadSuccessfulOperatorDbRead(evidence);
    const sentences = prose.split(/(?<=[.!?\n])\s+/);
    let fired = false;
    for (const sentence of sentences) {
      if (fired) break;
      const framed = LIVE_STATE_FRAMING.some((re) => re.test(sentence));
      if (!framed) continue;
      for (const token of allQuantTokens(sentence)) {
        if (quantInContext(token, context)) continue;
        if (quantInToolOutput(token, toolCorpus)) continue;
        const derivedExempt = hadDataRead && showsDerivation(sentence);
        const severity: GroundingFlag["severity"] = derivedExempt ? "soft" : "hard";
        const reason = derivedExempt
          ? "but it is a derived/computed figure shown with its derivation alongside a successful data read this run (analyst computation, telemetry only)"
          : "but no successful tool result this run returned that figure and it is not in the fed-in context";
        flags.push({
          pattern: "unsupported_quant_claim",
          severity,
          detail: `asserts "${token}" as live business/DB state ${reason}`,
        });
        fired = true;
        break;
      }
    }
  }

  if (run.checkLinkedRecord) {
    const heldSources = [run.input ?? ""];
    for (const tc of evidence) {
      const status = (tc.status ?? "").toLowerCase();
      const succeeded =
        status === "ok" || status === "success" || status === "completed" || status === "";
      if (succeeded) heldSources.push(tc.output ?? "");
    }
    const held = new Map<string, string>();
    for (const src of heldSources) {
      for (const m of src.matchAll(LINKED_RECORD_ID_RE)) {
        if (!held.has(m[2])) held.set(m[2], m[1]);
      }
    }
    if (held.size > 0 && PAYMENT_MECHANICS_RES.some((re) => re.test(prose))) {
      const anyRead = [...held.keys()].some((id) => idDereferencedAsQueryInput(id, evidence));
      for (const [idValue, field] of held) {
        if (!idDereferencedAsQueryInput(idValue, evidence)) {
          flags.push({
            pattern: "linked_record_status_unread",
            severity: anyRead ? "soft" : "hard",
            detail: `answer speculates about payment status/mechanics, but the linked ${field} held this run was never dereferenced (no successful tool call queried that id) — read the record before describing it`,
          });
          break;
        }
      }
    }
  }

  if (run.checkTruncatedScope) {
    const pages = truncatedPages(evidence);
    const sentences = prose.split(/(?<=[.!?\n])\s+|;\s*/);
    let firedC10 = false;
    for (const page of pages) {
      if (firedC10) break;
      if (laterCallCoveredThePage(evidence, page)) continue;
      const unseen = page.total - page.returned;
      const { numbered, unnumbered } = unseenRowPhrases(unseen);
      const returnedScope = returnedScopeRe(page.returned);
      for (const sentence of sentences) {
        const applicable = returnedScope.test(sentence)
          ? numbered
          : [...numbered, ...unnumbered];
        const hit = applicable.map((re) => sentence.match(re)).find(Boolean);
        if (!hit) continue;
        const tail = sentence.slice((hit.index ?? 0) + hit[0].length);
        if (!OBSERVED_STATE_RE.test(tail)) continue;
        if (HONEST_ABSTENTION_RE.test(sentence)) continue;
        if (QUOTING_RE.test(sentence)) continue;
        flags.push({
          pattern: "truncated_scope_overclaim",
          severity: "hard",
          detail:
            `asserts observed state about the ${unseen} rows that fell past a truncated page ` +
            `(_returned ${page.returned} of _total ${page.total}) — those rows were never returned, ` +
            `so their status was not observed`,
        });
        firedC10 = true;
        break;
      }
    }
  }

  if (run.checkSelfContradiction) {
    const lines = nonFencedLines(out);
    const countFlag = countVsEnumerationFlag(lines);
    if (countFlag) flags.push(countFlag);
    const totalFlag = totalVsBreakdownFlag(lines, evidence);
    if (totalFlag) flags.push(totalFlag);
  }

  return { flags, hint: flags.length > 0 ? "review" : "clean" };
}

export const hasHardGroundingFlag = (r: GroundingResult): boolean =>
  r.flags.some((f) => f.severity === "hard");
