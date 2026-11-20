import type { DomainPage } from "./types";

export const CONTEXT_MAX_CHARS = 8_000;
export const RESEARCH_RESERVE_CHARS = 3_000;

function render(pages: DomainPage[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const page of pages) {
    if (used >= budget) break;
    const block = `${page.title}\n${page.text_excerpt}`.slice(0, budget - used);
    if (!block) break;
    out.push(block);
    used += block.length + 2;
  }
  return out.join("\n\n");
}

export function buildEnrichmentContext(
  domainPages: DomainPage[],
  researchPages: DomainPage[],
  maxChars = CONTEXT_MAX_CHARS,
): string {
  const reserve = researchPages.length > 0 ? Math.min(RESEARCH_RESERVE_CHARS, maxChars) : 0;
  const ownText = render(domainPages, maxChars - reserve);
  const researchBudget = maxChars - ownText.length - (ownText ? 2 : 0);
  const researchText = researchBudget > 0 ? render(researchPages, researchBudget) : "";
  return [ownText, researchText].filter(Boolean).join("\n\n").slice(0, maxChars);
}
