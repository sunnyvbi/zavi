import { cardCopy } from "./cardCopy";
import { cardOwner } from "./devMail";
import { actionLink, deliverableOf, type ActionItem } from "./types";

export const ZAVI_BUILDER_DRAFT_KEY = "zavi.websiteChatDraft";
export const ZAVI_BUILDER_HREF = "/workspace?tab=website";

export const isZaviBuilderCard = (a: ActionItem): boolean => !a.executable && cardOwner(a) === "zavi";

export function zaviBuilderDraft(a: ActionItem, opts: { link?: string | null; content?: string | null } = {}): string {
  const copy = cardCopy(a, false);
  const lead = copy.leadFull.trim();
  const howTo = (a.body?.step?.how_to ?? []).filter((s): s is string => typeof s === "string" && !!s.trim());
  const modelSteps = howTo.length ? howTo : copy.steps;
  const content = (opts.content ?? deliverableOf(a)?.content ?? "").trim();
  const label = deliverableOf(a)?.label ?? "What to use";
  const link = opts.link ?? actionLink(a);
  return [
    `Make this change on my website: ${a.title}`,
    lead && lead !== a.title ? lead : "",
    modelSteps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    content ? `${label}:\n\n${content}` : "",
    link ? `Page: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function handToZaviBuilder(draft: string): void {
  try {
    window.sessionStorage.setItem(ZAVI_BUILDER_DRAFT_KEY, draft);
  } catch {
    void 0;
  }
  window.location.href = ZAVI_BUILDER_HREF;
}

export function takeZaviBuilderDraft(): string | null {
  try {
    const draft = window.sessionStorage.getItem(ZAVI_BUILDER_DRAFT_KEY);
    window.sessionStorage.removeItem(ZAVI_BUILDER_DRAFT_KEY);
    return draft && draft.trim() ? draft : null;
  } catch {
    return null;
  }
}
