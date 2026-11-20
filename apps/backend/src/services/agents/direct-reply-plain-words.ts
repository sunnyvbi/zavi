
import { findInternalJargon, replaceBuildRepoRefs, type JargonClass } from "./internal-jargon";
import { composeCustomerStatusBody, projectRunStatus } from "./run-status-projection";
import type { RunOutcome } from "./outcome-model";

export const BUILD_SITE_PHRASE = "the site Zavi built for you";

const REPO_HINT_LEAD_RE =
  /`?\brepo_hint\b`?\s*(?:came\s+in\s+as|is\s+set\s+to|was\s+set\s+to|is|was|=|:)\s*(?=`?(?![nN]\/[aA]\b)[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)/gi;
const REPO_HINT_TOKEN_RE =
  /(?:\b(the|a|an|your|our|this|that)\s+)?(?<![\w./-])`?repo_hint`?(?![\w/-])(?!\.\w)/gi;
const REPO_HINT_NOUN = "the repo for this chat";

const RESULT_JARGON: ReadonlySet<JargonClass> = new Set([
  "repo_hint",
  "envelope",
  "sandbox",
  "uuid",
  "tool_name",
  "git_command",
  "build_repo",
]);

const OPTIONS_RE =
  /^\s*(?:[-*]\s+)?\**\s*(?:[A-Z]|\d{1,2})[.)]\s|\b(?:choose|pick|select)\b[^.\n]{0,80}\bor\b/im;

function asksForInput(input: DirectReplyInput): boolean {
  const code = (input.side_effect as { reason_code?: string } | undefined)?.reason_code;
  if (code === "needs_input" || code === "wrong_repo") return true;
  return OPTIONS_RE.test(input.text) || input.text.includes("?");
}

export function replaceInternalTermsForCustomer(text: string): { text: string; changed: boolean } {
  if (!text) return { text, changed: false };
  let out = replaceBuildRepoRefs(text, BUILD_SITE_PHRASE);
  out = out.replace(REPO_HINT_LEAD_RE, (_m, offset: number, whole: string) => {
    const atStart = /(?:^|\n|[.!?]\s+)$/.test(whole.slice(0, offset));
    return atStart ? "This chat was set to " : "this chat was set to ";
  });
  out = out.replace(REPO_HINT_TOKEN_RE, (_m, article: string | undefined, offset: number, whole: string) => {
    const atStart =
      /(?:^|\n|[.!?]\s+)$/.test(whole.slice(0, offset)) || /^[A-Z]/.test(article ?? "");
    return atStart ? "The repo for this chat" : REPO_HINT_NOUN;
  });
  return { text: out, changed: out !== text };
}

export type DirectReplyInput = {
  text: string;
  parse_ok: boolean;
  side_effect?: RunOutcome["side_effect"] | { kind: "shipped" | "refused" | "none" };
  customer_summary?: string | null;
};

export function plainDirectEngineerReply(
  input: DirectReplyInput,
): { text: string; mode: "unchanged" | "replaced" | "status" } {
  const { text } = input;
  if (!text) return { text, mode: "unchanged" };

  const resultJargon = findInternalJargon(text).some((c) => RESULT_JARGON.has(c));
  const noChange =
    input.side_effect?.kind === "refused" &&
    (input.side_effect as { reason_code?: unknown }).reason_code === "no_change" &&
    !!input.customer_summary;
  if ((resultJargon || noChange) && input.side_effect?.kind === "refused" && !asksForInput(input)) {
    const status = projectRunStatus({
      id: "direct",
      status: input.parse_ok ? "success" : "parse_failed",
      outcome: {
        side_effect: input.side_effect as RunOutcome["side_effect"],
        customer_summary: input.customer_summary ?? null,
        deliverable: null,
      },
      output_text: null,
    });
    return { text: composeCustomerStatusBody(status), mode: "status" };
  }

  const r = replaceInternalTermsForCustomer(text);
  if (!r.changed) return { text, mode: "unchanged" };
  return { text: r.text.length > 0 ? r.text : text, mode: "replaced" };
}
