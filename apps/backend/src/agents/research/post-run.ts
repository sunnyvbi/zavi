import type { ResearchReport } from "./output-schema";
import type { Block, ValidationChip } from "./blocks";

export interface NormalizeResult {
  report: ResearchReport;
  droppedCitations: number;
  downgradedChips: number;
}

export function normalizeResearchReport(input: ResearchReport): NormalizeResult {
  const valid = new Set(input.sources.map((s) => s.n));
  let droppedCitations = 0;

  const filterCites = (arr: number[] | undefined): number[] => {
    if (!arr) return [];
    const kept = arr.filter((n) => valid.has(n));
    droppedCitations += arr.length - kept.length;
    return kept;
  };

  const filterTileCite = (c?: number): number | undefined => {
    if (c === undefined) return undefined;
    if (valid.has(c)) return c;
    droppedCitations += 1;
    return undefined;
  };
  const filterTiles = <T extends { citation?: number }>(tiles: T[] | undefined): T[] | undefined =>
    tiles?.map((t) => ({ ...t, citation: filterTileCite(t.citation) }));

  const blocks = input.blocks.map((b): Block => {
    switch (b.type) {
      case "exec_summary":
        return { ...b, citations: filterCites(b.citations), stat_tiles: filterTiles(b.stat_tiles) };
      case "stat_tiles":
        return { ...b, tiles: filterTiles(b.tiles) ?? b.tiles };
      case "persona_cards":
        return { ...b, cards: b.cards.map((c) => ({ ...c, citations: filterCites(c.citations) })) };
      case "qa_grid":
        return { ...b, items: b.items.map((i) => ({ ...i, citations: filterCites(i.citations) })) };
      case "theme_bars":
        return { ...b, bars: b.bars.map((x) => ({ ...x, citations: filterCites(x.citations) })) };
      case "cards_grid":
        return { ...b, cards: b.cards.map((c) => ({ ...c, citations: filterCites(c.citations) })) };
      case "competitive_table":
        return { ...b, rows: b.rows.map((r) => ({ ...r, citations: filterCites(r.citations) })) };
      case "gap_list":
        return { ...b, items: b.items.map((i) => ({ ...i, citations: filterCites(i.citations) })) };
      case "recommendations":
        return { ...b, items: b.items.map((i) => ({ ...i, citations: filterCites(i.citations) })) };
      case "risks":
        return { ...b, items: b.items.map((i) => ({ ...i, citations: filterCites(i.citations) })) };
      case "validation":
        return { ...b, chips: b.chips.map((c) => guardChip(c, valid)) };
      default:
        return b;
    }
  });

  let downgradedChips = 0;
  const validation = input.validation.map((c) => {
    const guarded = guardChip(c, valid);
    if (guarded.tier !== c.tier) downgradedChips += 1;
    return guarded;
  });

  for (const lens of input.lenses) {
    if (lens.provenance.poisoned || lens.provenance.fetch_errors > 0) {
      const text = lens.provenance.poisoned
        ? `Lens "${lens.label}" had suspicious page content (${lens.provenance.reason ?? "possible injection"}); treat its findings cautiously.`
        : `Lens "${lens.label}" had ${lens.provenance.fetch_errors} fetch error(s); coverage may be incomplete.`;
      if (!validation.some((c) => c.tier === "high-risk" && c.text === text)) {
        validation.push({ tier: "high-risk", text, supporting_source_indices: filterCites(lens.sources) });
      }
    }
  }

  return { report: { ...input, blocks, validation }, droppedCitations, downgradedChips };
}

export function detectWeakSynthesis(report: ResearchReport): boolean {
  if (report.template === "customer-intel") {
    const hasSynthBlock = report.blocks.some(
      (b) => b.type === "recommendations" || b.type === "gap_list",
    );
    if (!hasSynthBlock) return true;
  }
  return false;
}

function guardChip(c: ValidationChip, valid: Set<number>): ValidationChip {
  const supporting = c.supporting_source_indices.filter((n) => valid.has(n));
  const tier = c.tier === "validated" && supporting.length === 0 ? "inferred" : c.tier;
  return { ...c, tier, supporting_source_indices: supporting };
}
