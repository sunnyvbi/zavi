import { splitFencedCode } from "@/services/agents/format-ask-enforce";
import { isFullRequest } from "@/services/agents/short-question-classify";
import { WORK_INTENT_ANYWHERE_RE } from "./_reply-format";

const BODY_FLOOR = 600;

const OPERATOR_NAMED_PATH_RE =
  /\.(?:ts|tsx|js|jsx|mjs|py|rb|go|swift|kt|java|sql|css|json|ya?ml)\b|\bwhich file\b|\bwhat file\b|\bwhere (?:is|does|in the code)\b|`[^`]+`/i;

const READ_BUDGET_RE =
  /\b(?:read|tool|token|context)\s+budget\b|\bhit\s+the\s+(?:read|tool)\s+budget\b|\bran\s+out\s+of\s+(?:read|tool|context)\b|\bbefore\s+I\s+(?:could\s+)?(?:open|read|finish)\b/i;
const RUN_ID_LINE_RE = /^\s*(?:run[_\s-]?id|run)\s*[=:]\s*[`'"]?[a-f0-9-]{6,}/i;
const GREP_OUTPUT_RE =
  /^\s*(?:\$\s*)?(?:grep|rg|git grep)\b|^\s*[\w./-]+\.[a-z]{1,4}:\d+:/i;

const CONCLUSION_AFTER_SEP_RE = /[:\-—]\s+\S/;
const DOMAIN_ID_RE =
  /\b(?:pi_|ch_|sub_|cus_|in_|re_|txn_|acct_)[A-Za-z0-9]+\b|\btrip\s+\d+\b|\b\d{6,}\b/i;
const MONEY_STATUS_RE =
  /\$\s?\d|\bUSD\b|\brefund|\bcharge|\bpayout|\bpaid\b|\binvoice|\bis\b|\bwas\b|\bshows?\b|\bconfirmed\b|\balready\b|\bfailed\b|\bblocked\b/i;

function lineCarriesAnswer(line: string): boolean {
  return (
    CONCLUSION_AFTER_SEP_RE.test(line) ||
    DOMAIN_ID_RE.test(line) ||
    MONEY_STATUS_RE.test(line)
  );
}

function isProcessOnlyLine(line: string): boolean {
  const l = line.trim();
  if (l.length === 0) return false;
  if (lineCarriesAnswer(l)) return false;
  return (
    WORK_INTENT_ANYWHERE_RE.test(l) ||
    READ_BUDGET_RE.test(l) ||
    RUN_ID_LINE_RE.test(l) ||
    GREP_OUTPUT_RE.test(l)
  );
}

export function stripProcessNarration(args: {
  body: string;
  userMessage?: string | null;
}): string {
  const body = args.body ?? "";
  if (process.env.REPLY_BREVITY_STRIP === "0") return body;
  if (body.length < BODY_FLOOR) return body;

  const um = args.userMessage ?? "";
  if (isFullRequest(um)) return body;
  if (OPERATOR_NAMED_PATH_RE.test(um)) return body;

  const segments = splitFencedCode(body);
  let dropped = 0;
  const kept = segments.map((seg) => {
    if (seg.code) return seg.text;
    const lines = seg.text.split("\n");
    const out = lines.filter((line) => {
      if (isProcessOnlyLine(line)) {
        dropped += 1;
        return false;
      }
      return true;
    });
    return out.join("\n");
  });

  if (dropped === 0) return body;

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
}
