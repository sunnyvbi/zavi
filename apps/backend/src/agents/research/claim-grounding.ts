
import type { ResearchReport } from "./output-schema";
import type { Block, ValidationChip, Source } from "./blocks";
import { parseHumanNumbers, numberAppearsInText } from "./human-number";
import { extractSourceDate, yearOlderThanMonths } from "./source-date";
import { fromAnthropicName } from "@/services/mcp/types";
import { deriveToolCapability } from "@/services/mcp/tool-capability";

export interface ClaimGroundingFlags {
  grounded: number;
  downgraded: number;
  stripped: number;
  truncation_hedges: number;
  contested_downgrades: number;
  chips_synthesized: number;
  adjudicate_calls: number;
  stale_hedges: number;
}

export interface GroundResult {
  report: ResearchReport;
  flags: ClaimGroundingFlags;
}

export interface GroundOptions {
  adjudicate?: (pairs: { claim: string; sourceText: string }[]) => Promise<boolean[]>;
  tolerancePct?: number;
  stalenessMonths?: number;
  now?: Date;
}

const TRUNCATION_MARKER = "…[truncated";

const FETCH_SERVERS = new Set(["web_fetch", "web_search", "competitor_intel", "apify"]);
const BARE_FETCH_NAMES = new Set(["web_fetch", "http_fetch", "web_search", "fetch", "browser_fetch"]);

export function isFetchTrace(name: string): boolean {
  const parsed = fromAnthropicName(name);
  if (!parsed) return BARE_FETCH_NAMES.has(name);
  if (FETCH_SERVERS.has(parsed.server_id)) return true;
  return (
    deriveToolCapability({
      server_id: parsed.server_id,
      tool_name: parsed.tool_name,
    }).fetch === "yes"
  );
}

type MinimalToolCall = {
  name: string;
  output_preview: string;
  input_preview?: string;
};

export function normalizeUrl(raw: string): string {
  if (!raw) return "";
  let s = raw.trim();
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    let host = u.host.toLowerCase().replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    s = s
      .toLowerCase()
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/^www\./, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
    return s;
  }
}

function buildUrlTextMap(toolCalls: readonly MinimalToolCall[]): Map<string, string> {
  const map = new Map<string, string>();
  const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
  for (const tc of toolCalls) {
    if (!isFetchTrace(tc.name)) continue;
    const text = tc.output_preview ?? "";
    const urls = new Set<string>();
    for (const m of (tc.input_preview ?? "").matchAll(URL_RE)) urls.add(m[0]);
    for (const m of text.matchAll(URL_RE)) urls.add(m[0]);
    for (const u of urls) {
      const norm = normalizeUrl(u);
      if (!norm) continue;
      const prev = map.get(norm);
      map.set(norm, prev ? `${prev}\n${text}` : text);
    }
  }
  return map;
}

interface NumericClaim {
  text: string;
  numbers: number[];
  citations: number[];
}

function extractBlockClaims(blocks: Block[]): NumericClaim[] {
  const claims: NumericClaim[] = [];
  const push = (text: string, citations: number[] | undefined) => {
    const nums = parseHumanNumbers(text);
    if (nums.length > 0 && citations && citations.length > 0) {
      claims.push({ text, numbers: nums, citations: [...citations] });
    }
  };
  for (const b of blocks) {
    switch (b.type) {
      case "exec_summary":
        push(b.prose_md, b.citations);
        for (const t of b.stat_tiles ?? []) {
          if (t.citation !== undefined) push(`${t.value} ${t.label}`, [t.citation]);
        }
        break;
      case "stat_tiles":
        for (const t of b.tiles) {
          if (t.citation !== undefined) push(`${t.value} ${t.label}`, [t.citation]);
        }
        break;
      case "table":
        for (const row of b.rows) push(row.join(" "), b.citations);
        break;
      case "competitive_table":
        for (const r of b.rows) {
          push(`${r.brand} ${r.price ?? ""} ${r.positioning} ${r.gap}`, r.citations);
        }
        break;
      default:
        break;
    }
  }
  return claims;
}

function shortClaim(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

function gatherSourceText(
  citations: number[],
  sourceByN: Map<number, Source>,
  urlText: Map<string, string>,
): {
  combined: string;
  perSource: { n: number; text: string | null; truncated: boolean; year: number | null; label: string | null }[];
} {
  const perSource = citations.map((n) => {
    const src = sourceByN.get(n);
    if (!src) return { n, text: null, truncated: false, year: null, label: null };
    const text = urlText.get(normalizeUrl(src.url)) ?? null;
    const truncated = text != null && text.includes(TRUNCATION_MARKER);
    const { year, label } = text != null ? extractSourceDate(text) : { year: null, label: null };
    return { n, text, truncated, year, label };
  });
  const combined = perSource
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n");
  return { combined, perSource };
}

export async function groundResearchClaims(
  report: ResearchReport,
  toolCalls: readonly MinimalToolCall[],
  opts: GroundOptions = {},
): Promise<GroundResult> {
  const tolerancePct = opts.tolerancePct ?? 2;
  const stalenessMonths = opts.stalenessMonths;
  const now = opts.now ?? new Date();
  const flags: ClaimGroundingFlags = {
    grounded: 0,
    downgraded: 0,
    stripped: 0,
    truncation_hedges: 0,
    contested_downgrades: 0,
    chips_synthesized: 0,
    adjudicate_calls: 0,
    stale_hedges: 0,
  };

  const sourceByN = new Map<number, Source>(report.sources.map((s) => [s.n, s]));
  const urlText = buildUrlTextMap(toolCalls);
  const blockClaims = extractBlockClaims(report.blocks);

  type PerSourceDate = { n: number; year: number | null; label: string | null };
  type ChipVerdict = {
    idx: number;
    chip: ValidationChip;
    numbers: number[];
    supportingN: number[];
    missingDeterministic: boolean;
    truncatedUnverified: boolean;
    singleSource: boolean;
    contested: boolean;
    combinedText: string;
    perSourceDates: PerSourceDate[];
  };

  const verdicts: ChipVerdict[] = [];

  report.validation.forEach((chip, idx) => {
    if (chip.tier !== "validated") return;
    const numbers = parseHumanNumbers(chip.text);
    const cites = chip.supporting_source_indices;
    const { combined, perSource } = gatherSourceText(cites, sourceByN, urlText);

    const perSourceDates: PerSourceDate[] = perSource.map((p) => ({ n: p.n, year: p.year, label: p.label }));

    if (numbers.length === 0) {
      verdicts.push({
        idx,
        chip,
        numbers,
        supportingN: cites.filter((n) => perSource.find((p) => p.n === n)?.text != null),
        missingDeterministic: false,
        truncatedUnverified: false,
        singleSource: cites.length === 1,
        contested: false,
        combinedText: combined,
        perSourceDates,
      });
      return;
    }

    const supportingN: number[] = [];
    const perSourceNumbers: number[][] = [];
    let anyTruncatedMiss = false;
    for (const p of perSource) {
      if (p.text == null) {
        perSourceNumbers.push([]);
        continue;
      }
      const nums = parseHumanNumbers(p.text);
      perSourceNumbers.push(nums);
      const hit = numbers.some((v) => numberAppearsInText(v, p.text!, tolerancePct));
      if (hit) supportingN.push(p.n);
      else if (p.truncated) anyTruncatedMiss = true;
    }

    const missingDeterministic = supportingN.length === 0;

    let contested = false;
    if (!missingDeterministic) {
      const primary = numbers[0];
      const tol = Math.abs(primary) * (tolerancePct / 100);
      const sourcesWithNumbers = perSourceNumbers.filter((ns) => ns.length > 0);
      if (sourcesWithNumbers.length >= 2) {
        const supports = sourcesWithNumbers.map((ns) =>
          ns.some((c) => Math.abs(c - primary) <= tol),
        );
        const anySupport = supports.some(Boolean);
        const anyContradict = supports.some((s) => !s);
        contested = anySupport && anyContradict;
      }
    }

    verdicts.push({
      idx,
      chip,
      numbers,
      supportingN,
      missingDeterministic,
      truncatedUnverified: missingDeterministic && anyTruncatedMiss,
      singleSource: cites.length === 1,
      contested,
      combinedText: combined,
      perSourceDates,
    });
  });

  const adjudicable = verdicts.filter(
    (v) => v.missingDeterministic && !v.truncatedUnverified && v.numbers.length > 0,
  );

  let adjudicateVerdicts = new Map<number, boolean>();
  if (adjudicable.length > 0 && opts.adjudicate) {
    flags.adjudicate_calls += 1;
    try {
      const pairs = adjudicable.map((v) => ({
        claim: v.chip.text,
        sourceText: v.combinedText,
      }));
      const results = await opts.adjudicate(pairs);
      adjudicable.forEach((v, i) => {
        adjudicateVerdicts.set(v.idx, results[i] === true);
      });
    } catch {
      for (const v of adjudicable) adjudicateVerdicts.set(v.idx, false);
    }
  }

  const newValidation: ValidationChip[] = report.validation.map((c) => ({ ...c }));
  const addedChips: ValidationChip[] = [];

  for (const v of verdicts) {
    const chip = newValidation[v.idx];

    if (v.truncatedUnverified) {
      chip.tier = "inferred";
      chip.supporting_source_indices = v.supportingN;
      flags.downgraded += 1;
      flags.truncation_hedges += 1;
      addedChips.push({
        tier: "high-risk",
        text: `source text capped (truncated); claim "${shortClaim(chip.text)}" unverified.`,
        supporting_source_indices: v.chip.supporting_source_indices,
      });
      continue;
    }

    if (v.numbers.length > 0 && v.missingDeterministic) {
      const adjudicatedSupported = adjudicateVerdicts.get(v.idx) === true;
      if (!adjudicatedSupported) {
        chip.tier = "inferred";
        const before = chip.supporting_source_indices.length;
        chip.supporting_source_indices = v.supportingN;
        flags.stripped += before - chip.supporting_source_indices.length;
        flags.downgraded += 1;
        addedChips.push({
          tier: "high-risk",
          text: `claim "${shortClaim(chip.text)}" not found in cited source(s); downgraded.`,
          supporting_source_indices: [],
        });
        continue;
      }
      flags.grounded += 1;
      continue;
    }

    if (v.contested) {
      chip.tier = "high-risk";
      flags.downgraded += 1;
      flags.contested_downgrades += 1;
      addedChips.push({
        tier: "high-risk",
        text: `cited sources disagree on the number for "${shortClaim(chip.text)}"; treat as high-risk.`,
        supporting_source_indices: chip.supporting_source_indices,
      });
      continue;
    }

    if (v.singleSource) {
      chip.tier = "inferred";
      flags.downgraded += 1;
      flags.contested_downgrades += 1;
      continue;
    }

    if (v.numbers.length > 0) flags.grounded += 1;
    if (v.numbers.length > 0 && v.supportingN.length > 0) {
      const before = chip.supporting_source_indices.length;
      const kept = chip.supporting_source_indices.filter((n) => {
        const src = sourceByN.get(n);
        if (!src) return true;
        const text = urlText.get(normalizeUrl(src.url));
        if (text == null) return true;
        return v.supportingN.includes(n);
      });
      chip.supporting_source_indices = kept;
      flags.stripped += before - kept.length;
    }

    if (
      stalenessMonths != null &&
      v.numbers.length > 0 &&
      chip.tier === "validated" &&
      v.supportingN.length > 0
    ) {
      const datedSupporting = v.perSourceDates.filter(
        (d) => v.supportingN.includes(d.n) && d.year != null,
      );
      if (datedSupporting.length > 0) {
        const anyFresh = datedSupporting.some(
          (d) => !yearOlderThanMonths(d.year as number, now, stalenessMonths),
        );
        if (!anyFresh) {
          const newest = datedSupporting.reduce((a, b) =>
            (b.year as number) > (a.year as number) ? b : a,
          );
          const dateLabel = newest.label ?? String(newest.year);
          flags.stale_hedges += 1;
          addedChips.push({
            tier: "high-risk",
            text: `figure "${shortClaim(chip.text)}" dates to ${dateLabel}; may be stale — treat as directional.`,
            supporting_source_indices: chip.supporting_source_indices,
          });
        }
      }
    }
  }

  if (report.validation.length === 0 && blockClaims.length > 0) {
    const topClaims = blockClaims.slice(0, 3);
    for (const c of topClaims) {
      addedChips.push({
        tier: "inferred",
        text: `${shortClaim(c.text)}`,
        supporting_source_indices: c.citations,
      });
      flags.chips_synthesized += 1;
    }
  }

  const finalReport: ResearchReport = {
    ...report,
    validation: [...newValidation, ...addedChips],
  };

  return { report: finalReport, flags };
}
