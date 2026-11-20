
export const PLAN_APPROVE_MAX_CHARS = 4000;

export const APPROVED_PLAN_SEPARATOR = "\n\nApproved plan:\n";

export function combineIdeaAndPlan(idea: string, plan: string, cap: number): string {
  const head = idea.trim();
  const body = plan.trim();
  if (!body) return head.slice(0, cap);
  const budget = cap - head.length - APPROVED_PLAN_SEPARATOR.length;
  if (budget <= 0) return head.slice(0, cap);
  const planPart = body.length > budget ? body.slice(0, budget) : body;
  return `${head}${APPROVED_PLAN_SEPARATOR}${planPart}`;
}

function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function fitClarifiedIdea(idea: string, augmented: string, cap: number): string {
  if (augmented.trim().length <= cap) return augmented;
  if (!augmented.startsWith(idea)) return clipUnits(augmented.trim(), cap);
  const context = augmented.slice(idea.length);
  const head = idea.trim();
  const budget = cap - context.length;
  if (budget <= 0) return clipUnits(`${head}${context}`.trim(), cap);
  return `${clipUnits(head, budget).trimEnd()}${context}`;
}

export const CLARIFY_CONTEXT_SEPARATOR = "\n\nAdditional context:\n";

export const ASKED_TEXT_TAIL = /\s+(?:Additional context:\s+-\s|Approved plan:\s)/;

export function askedText(text: string): string;
export function askedText(text: string | null): string | null;
export function askedText(text: string | null): string | null {
  if (!text) return text;
  const at = text.search(ASKED_TEXT_TAIL);
  return at > 0 ? text.slice(0, at).trim() : text;
}
