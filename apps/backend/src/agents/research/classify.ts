import type { RESEARCH_TEMPLATES } from "./output-schema";

export const MAX_LENSES = 6;

type Template = (typeof RESEARCH_TEMPLATES)[number];

export const TEMPLATES: Record<Template, { lenses: string[]; defaultBlocks: string[] }> = {
  "customer-intel": {
    lenses: ["audience", "reviews", "social", "sentiment", "competitors", "site"],
    defaultBlocks: ["hero", "exec_summary", "persona_cards", "qa_grid", "theme_bars", "cards_grid", "competitive_table", "gap_list", "recommendations", "risks", "validation", "source_list"],
  },
  "competitor-teardown": {
    lenses: ["pricing", "product", "ads", "hiring", "complaints", "releases"],
    defaultBlocks: ["hero", "exec_summary", "competitive_table", "cards_grid", "theme_bars", "risks", "validation", "source_list"],
  },
  landscape: {
    lenses: ["overview", "players", "trends", "expert-commentary", "risks"],
    defaultBlocks: ["hero", "exec_summary", "stat_tiles", "cards_grid", "theme_bars", "risks", "validation", "source_list"],
  },
  freeform: {
    lenses: ["overview"],
    defaultBlocks: ["hero", "exec_summary", "markdown", "validation", "source_list"],
  },
};

export function lensesForTemplate(t: Template): string[] {
  return TEMPLATES[t].lenses.slice(0, MAX_LENSES);
}

export function defaultBlocksForTemplate(t: Template): string[] {
  return TEMPLATES[t].defaultBlocks;
}
