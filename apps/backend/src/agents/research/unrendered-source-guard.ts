
import type { ResearchReport } from "./output-schema";
import type { Block, ValidationChip } from "./blocks";
import { normalizeUrl } from "./claim-grounding";

export interface UnverifiedCapture {
  requested_url: string;
  final_url: string;
  capture: string;
}

export interface UnrenderedGuardFlags {
  unrendered_sources: number;
  chips_downgraded: number;
  citations_stripped: number;
  disclosure_chips_added: number;
}

export interface UnrenderedGuardResult {
  report: ResearchReport;
  flags: UnrenderedGuardFlags;
}

const EMPTY_FLAGS: UnrenderedGuardFlags = {
  unrendered_sources: 0,
  chips_downgraded: 0,
  citations_stripped: 0,
  disclosure_chips_added: 0,
};

function unrenderedSourceIndices(
  report: ResearchReport,
  unverified: UnverifiedCapture[],
): Set<number> {
  if (unverified.length === 0) return new Set();
  const badUrls = new Set<string>();
  for (const u of unverified) {
    if (u.requested_url) badUrls.add(normalizeUrl(u.requested_url));
    if (u.final_url) badUrls.add(normalizeUrl(u.final_url));
  }
  const out = new Set<number>();
  for (const s of report.sources) {
    if (badUrls.has(normalizeUrl(s.url))) out.add(s.n);
  }
  return out;
}

function stripBlockCites(
  cites: number[] | undefined,
  bad: Set<number>,
): { kept: number[]; stripped: number } {
  if (!cites || cites.length === 0) return { kept: cites ?? [], stripped: 0 };
  const kept = cites.filter((n) => !bad.has(n));
  return { kept, stripped: cites.length - kept.length };
}

export function guardUnrenderedSources(
  report: ResearchReport,
  unverified: UnverifiedCapture[],
): UnrenderedGuardResult {
  const bad = unrenderedSourceIndices(report, unverified);
  if (bad.size === 0) return { report, flags: { ...EMPTY_FLAGS } };

  const flags: UnrenderedGuardFlags = { ...EMPTY_FLAGS, unrendered_sources: bad.size };
  const sourceByN = new Map(report.sources.map((s) => [s.n, s]));

  const validation: ValidationChip[] = report.validation.map((c) => {
    const citesBad = c.supporting_source_indices.some((n) => bad.has(n));
    if (!citesBad) return { ...c };
    const before = c.supporting_source_indices.length;
    const kept = c.supporting_source_indices.filter((n) => !bad.has(n));
    flags.citations_stripped += before - kept.length;
    const tier = c.tier === "validated" || c.tier === "inferred" ? "high-risk" : c.tier;
    if (tier !== c.tier) flags.chips_downgraded += 1;
    return { ...c, tier, supporting_source_indices: kept };
  });

  const blocks = report.blocks.map((b): Block => {
    switch (b.type) {
      case "exec_summary": {
        const r = stripBlockCites(b.citations, bad);
        flags.citations_stripped += r.stripped;
        const tiles = b.stat_tiles?.map((t) =>
          t.citation !== undefined && bad.has(t.citation)
            ? ((flags.citations_stripped += 1), { ...t, citation: undefined })
            : t,
        );
        return { ...b, citations: r.kept, stat_tiles: tiles };
      }
      case "stat_tiles": {
        const tiles = b.tiles.map((t) =>
          t.citation !== undefined && bad.has(t.citation)
            ? ((flags.citations_stripped += 1), { ...t, citation: undefined })
            : t,
        );
        return { ...b, tiles };
      }
      case "persona_cards":
        return { ...b, cards: b.cards.map((c) => keepCites(c, bad, flags)) };
      case "qa_grid":
        return { ...b, items: b.items.map((i) => keepCites(i, bad, flags)) };
      case "theme_bars":
        return { ...b, bars: b.bars.map((x) => keepCites(x, bad, flags)) };
      case "cards_grid":
        return { ...b, cards: b.cards.map((c) => keepCites(c, bad, flags)) };
      case "competitive_table":
        return { ...b, rows: b.rows.map((r) => keepCites(r, bad, flags)) };
      case "gap_list":
        return { ...b, items: b.items.map((i) => keepCites(i, bad, flags)) };
      case "recommendations":
        return { ...b, items: b.items.map((i) => keepCites(i, bad, flags)) };
      case "risks":
        return { ...b, items: b.items.map((i) => keepCites(i, bad, flags)) };
      default:
        return b;
    }
  });

  const disclosureChips: ValidationChip[] = [];
  for (const n of bad) {
    const src = sourceByN.get(n);
    const url = src?.url ?? `source #${n}`;
    disclosureChips.push({
      tier: "high-risk",
      text: `could not load ${url} — its page could not be rendered (blocked or empty shell after auto-retry); any claim about its headline/stats/layout is unverified and was stripped to high-risk.`,
      supporting_source_indices: [],
    });
    flags.disclosure_chips_added += 1;
  }

  return {
    report: { ...report, blocks, validation: [...validation, ...disclosureChips] },
    flags,
  };
}

function keepCites<T extends { citations: number[] }>(
  obj: T,
  bad: Set<number>,
  flags: UnrenderedGuardFlags,
): T {
  const r = stripBlockCites(obj.citations, bad);
  flags.citations_stripped += r.stripped;
  return { ...obj, citations: r.kept };
}
