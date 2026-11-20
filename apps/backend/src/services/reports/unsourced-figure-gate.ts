
import {
  attributedFigures,
  cutSentencesWithFigures,
  sentenceSpans,
} from "@/services/agents/attributed-figures";
import {
  figureWasRead,
  ledgerIsEmpty,
  urlWasRead,
  urlLedgerIsEmpty,
} from "@/services/agents/engine/figure-ledger";
import { ExpectedToolError } from "@/services/tools/types";
import { logEvent } from "@/services/logging/logEvent";

export function unsourcedFiguresIn(run_id: string, text: string): string[] {
  if (!run_id || !text) return [];
  if (ledgerIsEmpty(run_id)) return [];
  return attributedFigures(text).filter((f) => !figureWasRead(run_id, f));
}

const READ_THIS_RUN =
  /\b(?:confirmed|verified|read|fetched|checked|retrieved|observed)\b[^.!?\n]{0,80}\bthis run\b|\bthis run\b[^.!?\n]{0,40}\b(?:confirmed|verified|read|fetched|checked|retrieved|observed)\b/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g;

export function unreadSourcesIn(run_id: string, text: string): string[] {
  if (!run_id || !text) return [];
  if (urlLedgerIsEmpty(run_id)) return [];
  const bad = new Set<string>();
  for (const span of sentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end);
    if (!READ_THIS_RUN.test(sentence)) continue;
    for (const m of sentence.matchAll(URL_IN_TEXT)) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, "");
      if (!urlWasRead(run_id, url)) bad.add(url);
    }
  }
  return [...bad];
}

const REGULATORY_CLAIM =
  /\b(?:ban(?:s|ned|ning)?|outlaw(?:s|ed)?|prohibit(?:s|ed|ion)?|mandate[sd]?|require[sd]? by law|regulation|ordinance|building code|legally required|law (?:takes|took) effect|rule (?:takes|took) effect|phase[- ]?out|must (?:be )?(?:replace|upgrade|comply))/i;
const DATE_OR_YEAR = /\b(?:20\d{2}|19\d{2})\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

export function unsourcedRuleClaimsIn(run_id: string, text: string): string[] {
  if (!run_id || !text) return [];
  if (urlLedgerIsEmpty(run_id)) return [];
  const out: string[] = [];
  for (const span of sentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end).trim();
    if (sentence.length < 12) continue;
    if (!REGULATORY_CLAIM.test(sentence) || !DATE_OR_YEAR.test(sentence)) continue;
    const urls = [...sentence.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[.,;:!?)\]]+$/, ""));
    if (urls.some((u) => urlWasRead(run_id, u))) continue;
    out.push(sentence.slice(0, 120));
  }
  return out;
}

const MAX_REFUSALS_PER_RUN = 2;
const refusals = new Map<string, number>();
const MAX_RUNS_RETAINED = 500;

function bumpRefusals(run_id: string): number {
  const next = (refusals.get(run_id) ?? 0) + 1;
  refusals.set(run_id, next);
  if (refusals.size > MAX_RUNS_RETAINED) {
    const overflow = refusals.size - MAX_RUNS_RETAINED;
    let i = 0;
    for (const key of refusals.keys()) {
      if (i++ >= overflow) break;
      refusals.delete(key);
    }
  }
  return next;
}

export function _resetRefusals(run_id: string): void {
  refusals.delete(run_id);
}

export function assertFiguresWereRead(run_id: string, text: string): void {
  const bad = unsourcedFiguresIn(run_id, text);
  if (bad.length === 0) return;
  if (bumpRefusals(run_id) > MAX_REFUSALS_PER_RUN) return;
  throw new ExpectedToolError(
    "artifact_unsourced_figures",
    `Refusing to render this: it attributes ${bad.length} figure(s) to an outside source, and no tool result in this run contained them: ${bad.join(", ")}. ` +
      `Either quote the number a tool actually returned, or remove the sentence. Do not restate it as an estimate, and do not round it into a different number.`,
    { unsourced_figures: bad.slice(0, 10).join(", ") },
  );
}

export function figureGuardedText(
  run_id: string,
  text: string,
  log?: (msg: string, meta?: Record<string, unknown>) => void,
): string {
  const checked = run_id && text && !ledgerIsEmpty(run_id) ? attributedFigures(text).length : 0;
  const unread = unreadSourcesIn(run_id, text);
  const rules = unsourcedRuleClaimsIn(run_id, text);
  const bad = [...unsourcedFiguresIn(run_id, text), ...unread, ...rules];
  void logEvent({
    level: "info",
    source: "reports.figure_gate",
    code: bad.length === 0 ? "clean" : "unsourced",
    meta: { figures_checked: checked, unsourced_figures: bad.length },
  }).catch(() => {});
  if (bad.length === 0) return text;
  if (bumpRefusals(run_id) <= MAX_REFUSALS_PER_RUN) {
    throw new ExpectedToolError(
      "artifact_unsourced_figures",
      `Refusing to render this: it cites ${bad.length} thing(s) this run did not read — ${bad.join(", ")}. ` +
        `For a figure, quote the number a tool actually returned or drop the sentence; do not restate it as an estimate or round it into a different number. ` +
        `For a page, do not say a source was read, confirmed or verified this run unless a tool in THIS run fetched it — a prior run's text is not a receipt. ` +
        `For a law, ban, code or mandate, cite the page you read this run that says it, or cut the claim: a wrong rule is one the founder's customers and their licensing board can both act on.`,
      { unsourced_figures: bad.slice(0, 10).join(", ") },
    );
  }
  const stripped = cutSentencesWithFigures(text, bad);
  log?.("unsourced figures stripped after repeated refusals", {
    figures: bad.length,
    chars_removed: text.length - stripped.length,
  });
  void logEvent({
    level: "warn",
    source: "reports.figure_gate",
    code: "stripped",
    meta: { unsourced_figures: bad.length, chars_removed: text.length - stripped.length },
  }).catch(() => {});
  return stripped;
}
