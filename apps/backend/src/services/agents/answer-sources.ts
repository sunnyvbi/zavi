
import {
  digitsOf,
  pullsForFigure,
  pullsForFigureValue,
  pullIndexIsEmpty,
  toolCallCount,
  shownRowsFor,
  totalsForFigure,
  columnTotals,
  ownerTyped,
  preferredPull,
  pullsNamingFigure,
  refusedReadsFor,
  typedPullsForFigure,
  isLowEntropyFigure,
  isMinorUnitTool,
  figureKeysIn,
  ownerFigureKey,
  type ColumnTotal,
  type FigurePull,
} from "@/services/agents/engine/figure-ledger";
import { isProposalAt, proposalKey } from "@zavi/shared";
import { toolSourceLabel } from "@/services/agents/tool-source-label";
import type { AccessNote } from "@/services/data-gateway/types";

export interface AnswerSourcesResult {
  block: string | null;
  meta: {
    figures: number;
    sourced: number;
    unsourced: number;
    unverified: string[];
    refused?: number;
    earlier?: string[];
  };
  checked: CheckedFigure[];
}

export type CheckedFigure =
  | { figure: string; kind: "pulled"; source: string; tool: string }
  | { figure: string; kind: "worked_out"; formula: string }
  | { figure: string; kind: "reported" };

const MAX_UNVERIFIED_LISTED = 20;

const EMPTY: AnswerSourcesResult = {
  block: null,
  meta: { figures: 0, sourced: 0, unsourced: 0, unverified: [] },
  checked: [],
};

export function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)\s]*\)/g, "] ")
    .replace(/https?:\/\/\S+/g, " ");
}

const MONEY = /\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?/g;
const PERCENT = /(?<![\d.])-?\d{1,3}(?:\.\d+)?\s?%/g;
const COUNT = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b/g;

function isYear(raw: string): boolean {
  if (/[$%]/.test(raw)) return false;
  const d = digitsOf(raw);
  if (d.length !== 4) return false;
  const n = Number(d);
  return n >= 1900 && n <= 2100;
}

export function figureIdentity(raw: string): string {
  return ownerFigureKey(raw) ?? digitsOf(raw);
}

export function answerFigures(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of figureTokens(text)) {
    const d = figureIdentity(raw);
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(raw);
  }
  return out;
}

export function figureTokens(text: string): string[] {
  return figureTokenSpans(proseOnly(text)).map((f) => f.raw);
}

function figureTokenSpans(prose: string): Array<{ at: number; raw: string }> {
  const found: Array<{ at: number; end: number; raw: string }> = [];
  for (const re of [MONEY, PERCENT, COUNT]) {
    re.lastIndex = 0;
    for (const m of prose.matchAll(re)) {
      const raw = m[0].trim();
      if (isYear(raw)) continue;
      if (digitsOf(raw).length < 2) continue;
      found.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, raw });
    }
  }
  found.sort((a, b) => a.at - b.at || b.end - a.end);
  const out: Array<{ at: number; raw: string }> = [];
  let outer: { end: number; digits: string } | null = null;
  for (const f of found) {
    const digits = digitsOf(f.raw);
    if (outer && f.end <= outer.end && digits === outer.digits) continue;
    if (!outer || f.end > outer.end) outer = { end: f.end, digits };
    out.push({ at: f.at, raw: f.raw });
  }
  return out;
}

const HEADLINE = /\*\*([^*\n]+)\*\*/;
const SMALL_COUNT = /(?<![\d.,$])\b\d{2}\b(?![\d.,%])/g;

function headlineFigures(prose: string): Array<{ at: number; raw: string }> {
  const m = prose.match(HEADLINE);
  if (!m) return [];
  const span = m[1]!;
  const base = (m.index ?? 0) + 2;
  return [
    ...figureTokenSpans(span),
    ...[...span.matchAll(SMALL_COUNT)].map((x) => ({ at: x.index ?? 0, raw: x[0] })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((f) => ({ at: base + f.at, raw: f.raw }));
}

export function claimFigures(text: string): string[] {
  const prose = proseOnly(text);
  const proposed = new Set<string>();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { at, raw } of headlineFigures(prose)) {
    if (isProposalAt(prose, at, raw, proposed)) {
      const key = proposalKey(raw);
      if (key) proposed.add(key);
      continue;
    }
    const d = figureIdentity(raw);
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(raw);
  }
  for (const { at, raw } of figureTokenSpans(prose)) {
    if (isProposalAt(prose, at, raw, proposed)) {
      const key = proposalKey(raw);
      if (key) proposed.add(key);
      continue;
    }
    const d = figureIdentity(raw);
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(raw);
  }
  return out;
}

const RUN_COST_WORD = /\b(?:cost|costs|price|priced|charge|charged|spend|spent|bill|billed)\b/i;
const RUN_COST_CONTEXT =
  /\b(?:per|each|every)\s+(?:test\s+)?run\b|\b(?:a|the|this|test)\s+run\b|\bto\s+run\b/i;

export function runCostFigures(text: string): Set<string> {
  const out = new Set<string>();
  for (const sentence of proseOnly(text).split(/(?<=[.!?])\s+|\n+/)) {
    if (!RUN_COST_WORD.test(sentence) || !RUN_COST_CONTEXT.test(sentence)) continue;
    MONEY.lastIndex = 0;
    for (const m of sentence.matchAll(MONEY)) out.add(digitsOf(m[0]));
  }
  return out;
}

function pullLabel(pull: FigurePull, repeated: boolean): string {
  const db = dbSourceLabel(pull);
  if (db) return `${db} (call ${pull.nth})`;
  const label = toolSourceLabel(pull.tool);
  const cased = label.charAt(0).toUpperCase() + label.slice(1);
  return repeated ? `${cased} (call ${pull.nth})` : cased;
}

export function dbSourceLabel(pull: FigurePull): string | null {
  if (!pull.access || pull.access.length === 0) return null;
  return pull.access.some((n) => n.mode === "connector") ? "Your connector: a query" : "Your database: a query";
}

const LOG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function seeQueryHref(log_id: string | null | undefined): string | null {
  if (!log_id || !LOG_ID.test(log_id)) return null;
  return `/workspace?tab=brain&access=${log_id}#data-access`;
}

function plain(s: string, max = 200): string {
  const t = s.replace(/[\[\]()`*<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const MAX_TABLES_NAMED = 3;
function tablesText(tables: string[]): string {
  const uniq = [...new Set(tables.map((t) => plain(t, 80)).filter(Boolean))];
  if (uniq.length <= MAX_TABLES_NAMED) return uniq.join(", ");
  return `${uniq.slice(0, MAX_TABLES_NAMED).join(", ")} and ${uniq.length - MAX_TABLES_NAMED} more`;
}

function seeQueryLinks(notes: AccessNote[]): string {
  const hrefs = [...new Set(notes.map((n) => seeQueryHref(n.log_id)).filter((h): h is string => !!h))].slice(0, 5);
  if (hrefs.length === 0) return "";
  if (hrefs.length === 1) return ` [See query](${hrefs[0]})`;
  return ` See queries: ${hrefs.map((h, i) => `[${i + 1}](${h})`).join(", ")}`;
}

function dbPullLine(pull: FigurePull, label: string): string {
  const notes = pull.access ?? [];
  const tables = tablesText(notes.flatMap((n) => n.tables));
  const rows = notes.reduce((sum, n) => sum + (Number.isFinite(n.rows) ? n.rows : 0), 0);
  const totals = notes.some((n) => n.totals_only) ? ", totals only" : "";
  const on = tables ? ` on ${tables}` : "";
  return `${label}${on}, ${shown(rows)} ${rows === 1 ? "row" : "rows"}${totals}.${seeQueryLinks(notes)}`;
}

function reasonText(reason: string | undefined): string {
  const r = plain(reason ?? "", 240);
  if (!r) return "it is not allowed by the rules.";
  const m = r.match(/^.*?[.!?](?=\s|$)/);
  const first = (m ? m[0] : r).trim();
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}

const BLOCKED_FIELD = /^(.+?) is (?:hidden in What Zavi can see|blocked by this connector's rules)\./;

type RefusalLines = { count: number; lines: string[]; warning: string | null };

export function refusalLines(refused: AccessNote[]): RefusalLines {
  const seen = new Set<string>();
  const lines: string[] = [];
  const fields: { field: string; by: "zavi" | "connector" }[] = [];
  for (const n of refused) {
    const key = n.log_id ?? `${n.refused_by}:${n.tables.join(",")}:${n.reason ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tables = tablesText(n.tables);
    const reason = reasonText(n.reason);
    const on = tables ? ` on ${tables}` : "";
    const lead =
      n.refused_by === "connector"
        ? `Your connector refused a query${on}`
        : n.refused_rule === "settings"
          ? `Your settings refused a query${on}`
          : `Zavi's safety check blocked a query${on}`;
    lines.push(`${lead}: ${reason} Nothing was sent.${seeQueryLinks([n])}`);
    const f = plain(n.reason ?? "", 240).match(BLOCKED_FIELD);
    if (f && !fields.some((x) => x.field === f[1])) fields.push({ field: plain(f[1]!, 80), by: n.refused_by === "connector" ? "connector" : "zavi" });
  }
  let warning: string | null = null;
  if (fields.length > 0) {
    const many = fields.length > 1;
    const byConnector = fields.some((x) => x.by === "connector");
    const who = byConnector ? "Your connector blocked" : "Your settings hide";
    warning = `Not in this run's data: ${fields.map((x) => x.field).join(", ")}. ${who} ${many ? "them" : "it"}, so nothing about ${many ? "them" : "it"} was sent.`;
  }
  return { count: lines.length, lines, warning };
}

function refusedSentence(n: number): string {
  return n === 1 ? "1 query was refused." : `${n} queries were refused.`;
}

export const SOURCES_HEADER = "**Sources.**";

const MAX_FIGURES_LISTED_PER_PULL = 6;
const MAX_PROSE_CANDIDATES = 10;

function numericValue(raw: string): number | null {
  const cleaned = raw.replace(/[$,%\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function decimalsOf(raw: string): number {
  const m = raw.match(/\.(\d+)/);
  return m ? m[1].length : 0;
}

export function derivationsOf(
  percent: string,
  candidates: string[],
  samePull: (a: string, b: string) => boolean,
): Map<string, string> {
  const found = new Map<string, string>();
  const add = (op: string, a: string, b: string, shown: string) => {
    const key = `${op}:${numericValue(a)}:${numericValue(b)}`;
    if (!found.has(key)) found.set(key, shown);
  };
  const target = numericValue(percent);
  if (target === null) return found;
  const k = decimalsOf(percent);
  const round = (x: number) => (Math.sign(x) * Math.round(Math.abs(x) * 10 ** k)) / 10 ** k;
  const want = round(target);
  for (const a of candidates) {
    for (const b of candidates) {
      if (digitsOf(a) === digitsOf(b)) continue;
      const av = numericValue(a);
      const bv = numericValue(b);
      if (av === null || bv === null || bv <= 0 || av < 0) continue;
      if (!samePull(a, b)) continue;
      if (round((av / bv) * 100) === want) add("share", a, b, `${percent} = ${a} / ${b}`);
      if (av < bv && round((1 - av / bv) * 100) === want) {
        add("drop", a, b, `${percent} = 1 - ${a} / ${b}`);
      }
      if (round(((av - bv) / bv) * 100) === want) {
        add("change", a, b, `${percent} = (${a} - ${b}) / ${b}`);
      }
    }
  }
  return found;
}

export function workedOutFrom(
  percent: string,
  candidates: string[],
  samePull: (a: string, b: string) => boolean,
): string | null {
  const found = derivationsOf(percent, candidates, samePull);
  return found.size === 1 ? [...found.values()][0] : null;
}

function shown(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function totalFormula(figure: string, totals: ColumnTotal[]): string | null {
  const ways = new Set(totals.map((t) => `total of ${t.column} across ${t.rows} rows`));
  return ways.size === 1 ? `${figure} = ${[...ways][0]}` : null;
}

export function shareOfTotal(percent: string, totals: ColumnTotal[]): string | null {
  const target = numericValue(percent);
  if (target === null || target < 0) return null;
  const k = decimalsOf(percent);
  const round = (x: number) => Math.round(x * 10 ** k) / 10 ** k;
  const want = round(target);
  const found = new Map<string, string>();
  for (const t of totals) {
    if (t.total <= 0) continue;
    for (const c of t.cells) {
      if (c < 0 || round((c / t.total) * 100) !== want) continue;
      const key = `${t.pull.tool}#${t.pull.nth}:${t.column}:${c}`;
      if (!found.has(key)) found.set(key, `${percent} = ${shown(c, t.decimals)} / ${shown(t.total, t.decimals)}`);
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

export function buildAnswerSources(
  run_id: string,
  answer: string,
  opts: {
    earlierReplies?: string[];
  } = {},
): AnswerSourcesResult {
  if (!run_id || !answer) return EMPTY;
  const refused = refusalLines(refusedReadsFor(run_id));
  const refusalOnly = (): AnswerSourcesResult =>
    refused.count === 0
      ? EMPTY
      : {
          block: [
            "---",
            `${SOURCES_HEADER} ${refusedSentence(refused.count)}`,
            "",
            ...refused.lines,
            ...(refused.warning ? ["", refused.warning] : []),
          ].join("\n"),
          meta: { ...EMPTY.meta, refused: refused.count },
          checked: [],
        };
  if (pullIndexIsEmpty(run_id)) {
    const entered = answerFigures(answer).filter((f) => ownerTyped(run_id, f));
    const base = refusalOnly();
    return entered.length === 0
      ? base
      : { ...base, checked: entered.map((figure) => ({ figure, kind: "reported" as const })) };
  }
  const prose = claimFigures(answer);
  const runCosts = runCostFigures(answer);
  const rows = shownRowsFor(run_id);

  const seen = new Set<string>();
  const figures: string[] = [];
  const add = (raw: string) => {
    if (digitsOf(raw).length < 2 || isYear(raw)) return;
    const d = figureIdentity(raw);
    if (seen.has(d)) return;
    seen.add(d);
    figures.push(raw);
  };
  prose.filter((raw) => !(raw.includes("$") && runCosts.has(digitsOf(raw)))).forEach(add);
  rows.forEach((row) => row.forEach(add));
  if (figures.length === 0) return refusalOnly();

  const pulled = (raw: string) => pullsForFigure(run_id, raw).length > 0;
  const samePull = (a: string, b: string) => {
    const keys = new Set(pullsForFigure(run_id, a).map((p) => `${p.tool}#${p.nth}`));
    return pullsForFigure(run_id, b).some((p) => keys.has(`${p.tool}#${p.nth}`));
  };
  const proseCandidates = [
    ...new Set(
      [...proseOnly(answer).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)]
        .map((m) => m[0])
        .filter((raw) => !raw.includes(".") && digitsOf(raw).length >= 2 && pulled(raw)),
    ),
  ].slice(0, MAX_PROSE_CANDIDATES);

  const totals = columnTotals(run_id);

  const order: string[] = [];
  const byKey = new Map<string, { pull: FigurePull; figures: string[] }>();
  const workedOut: string[] = [];
  const unsourced: string[] = [];
  const entered: string[] = [];
  const checked: CheckedFigure[] = [];

  for (const figure of figures) {
    let pulls = figure.trim().startsWith("-") ? [] : creditablePulls(run_id, figure);
    const unit = figure.includes("%") ? "%" : figure.includes("$") ? "$" : null;
    const binding = unit
      ? typedPullsForFigure(run_id, figure, unit).map((t) => t.pull)
      : pullsNamingFigure(run_id, figure);
    const bound = pulls.filter((p) => binding.includes(p) && !isWebRead(p.tool));
    if (pulls.length > 0 && ownerTyped(run_id, figure)) {
      if (bound.length === 0) {
        entered.push(figure);
        checked.push({ figure, kind: "reported" });
        continue;
      }
      pulls = bound;
    }
    if (pulls.length > 0) {
      for (const pull of pulls) {
        const key = `${pull.tool}#${pull.nth}`;
        let row = byKey.get(key);
        if (!row) {
          row = { pull, figures: [] };
          byKey.set(key, row);
          order.push(key);
        }
        if (!row.figures.includes(figure)) row.figures.push(figure);
      }
      const first = preferredPull(pulls) ?? pulls[0];
      checked.push({ figure, kind: "pulled", source: pullLabel(first, toolCallCount(run_id, first.tool) > 1), tool: first.tool });
      continue;
    }
    if (!figure.trim().startsWith("-") && !figure.includes("%")) {
      const total = totalFormula(figure, totalsForFigure(run_id, figure));
      if (total) {
        workedOut.push(total);
        checked.push({ figure, kind: "worked_out", formula: total });
        continue;
      }
    }
    if (figure.includes("%")) {
      const share = shareOfTotal(figure, totals);
      if (share) {
        workedOut.push(share);
        checked.push({ figure, kind: "worked_out", formula: share });
        continue;
      }
      const d = digitsOf(figure);
      const inRows = new Map<string, string>();
      for (const r of rows) {
        if (!r.some((c) => digitsOf(c) === d)) continue;
        derivationsOf(figure, r.filter(pulled), () => true).forEach((v, k) => inRows.set(k, v));
      }
      derivationsOf(figure, proseCandidates, samePull).forEach((v, k) => { if (!inRows.has(k)) inRows.set(k, v); });
      const how = inRows.size === 1 ? [...inRows.values()][0] : null;
      if (how) {
        workedOut.push(how);
        checked.push({ figure, kind: "worked_out", formula: how });
        continue;
      }
    }
    if (ownerTyped(run_id, figure)) {
      entered.push(figure);
      checked.push({ figure, kind: "reported" });
      continue;
    }
    unsourced.push(figure);
  }

  const pulledMoney = checked.filter((c) => c.kind === "pulled" && c.figure.includes("$")).map((c) => c.figure);
  for (let i = unsourced.length - 1; i >= 0; i--) {
    const figure = unsourced[i];
    const how = twoTermSum(run_id, figure, pulledMoney, answer);
    if (!how) continue;
    unsourced.splice(i, 1);
    workedOut.push(how);
    checked.push({ figure, kind: "worked_out", formula: how });
  }

  const earlierKeys = new Set<string>();
  for (const t of opts.earlierReplies ?? []) for (const k of figureKeysIn(t)) earlierKeys.add(k);
  const earlier = unsourced.filter((f) => {
    const k = ownerFigureKey(f);
    return !!k && earlierKeys.has(k);
  });

  const direct = figures.length - unsourced.length - workedOut.length - entered.length;
  const resultMeta = (): AnswerSourcesResult["meta"] => ({
    figures: figures.length,
    sourced: direct,
    unsourced: unsourced.length,
    unverified: unsourced.slice(0, MAX_UNVERIFIED_LISTED),
    ...(earlier.length > 0 ? { earlier: earlier.slice(0, MAX_UNVERIFIED_LISTED) } : {}),
  });

  const named = figures.length <= 6 ? ` (${figures.join(", ")})` : "";
  if (figures.length === unsourced.length) {
    const base = refusalOnly();
    return { ...base, meta: { ...resultMeta(), ...(refused.count > 0 ? { refused: refused.count } : {}) }, checked };
  }
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (unsourced.length === 0) {
    parts.push(
      direct === figures.length
        ? figures.length === 1
          ? `The number ${figures[0]} came straight from data pulled in this run`
          : `All ${figures.length} numbers${named} came straight from data pulled in this run`
        : `${direct} of ${figures.length} numbers came straight from data pulled in this run`,
    );
    if (workedOut.length > 0) parts.push(`${workedOut.length} ${workedOut.length === 1 ? "checks" : "check"} out as arithmetic on it`);
    if (entered.length > 0) parts.push(`${entered.length} ${entered.length === 1 ? "is" : "are"} yours`);
  } else {
    if (direct > 0) parts.push(`${n(direct, "number", "numbers")} came straight from data pulled in this run`);
    if (workedOut.length > 0) {
      parts.push(
        direct > 0
          ? `${workedOut.length} ${workedOut.length === 1 ? "checks" : "check"} out as arithmetic on it`
          : `${n(workedOut.length, "number checks", "numbers check")} out as arithmetic on data pulled in this run`,
      );
    }
    if (entered.length > 0) {
      parts.push(direct > 0 || workedOut.length > 0 ? `${entered.length} ${entered.length === 1 ? "is" : "are"} yours` : `${n(entered.length, "number is", "numbers are")} yours`);
    }
  }
  const lines: string[] = [];
  lines.push("---");
  lines.push(`${SOURCES_HEADER} ${parts.join(", ")}.${refused.count > 0 ? ` ${refusedSentence(refused.count)}` : ""}`);
  lines.push("");
  order.forEach((key, i) => {
    const row = byKey.get(key);
    if (!row) return;
    const repeated = toolCallCount(run_id, row.pull.tool) > 1;
    if (dbSourceLabel(row.pull)) {
      lines.push(`${i + 1}. ${dbPullLine(row.pull, pullLabel(row.pull, repeated))}`);
      return;
    }
    const listed = row.figures.slice(0, MAX_FIGURES_LISTED_PER_PULL).join(", ");
    const more = row.figures.length - MAX_FIGURES_LISTED_PER_PULL;
    lines.push(
      `${i + 1}. ${pullLabel(row.pull, repeated)} returned ${listed}${more > 0 ? ` and ${more} more` : ""}`,
    );
  });
  if (workedOut.length > 0) {
    if (order.length > 0) lines.push("");
    lines.push(`Checks out against those: ${workedOut.join(" · ")}`);
  }
  if (entered.length > 0) {
    if (order.length > 0 || workedOut.length > 0) lines.push("");
    lines.push(`From you: ${entered.join(", ")}`);
  }
  if (refused.count > 0) {
    if (order.length > 0 || workedOut.length > 0 || entered.length > 0) lines.push("");
    lines.push(...refused.lines);
  }
  if (refused.warning) {
    lines.push("");
    lines.push(refused.warning);
  }

  return {
    block: lines.join("\n"),
    meta: { ...resultMeta(), ...(refused.count > 0 ? { refused: refused.count } : {}) },
    checked,
  };
}

export function creditablePulls(run_id: string, figure: string): FigurePull[] {
  const unit = figure.includes("%") ? "%" : figure.includes("$") ? "$" : null;
  const typed: FigurePull[] = [];
  if (unit) for (const t of typedPullsForFigure(run_id, figure, unit)) if (!typed.includes(t.pull)) typed.push(t.pull);
  if (unit && isLowEntropyFigure(figure)) return typed;
  const pulls = pullsForFigureValue(run_id, figure);
  const out = unit === "$" ? pulls.filter((p) => !isMinorUnitTool(p.tool) || typed.includes(p)) : [...pulls];
  for (const p of typed) if (!out.includes(p)) out.push(p);
  return out;
}

const WEB_READ = /(?:^|__)web_(?:search|fetch)__/;

function isWebRead(tool: string): boolean {
  return WEB_READ.test(tool);
}

const TOTAL_WORD = /\b(?:total|totals|combined|together|in all|altogether|sum|adds up to|add up to)\b/i;

function cents(raw: string): number | null {
  const m = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Math.round(Number(m[0]) * 100);
  return Number.isFinite(n) ? n : null;
}

const MONEY_FAMILIES: Array<{ family: string; key: RegExp; words: RegExp }> = [
  {
    family: "spend",
    key: /(?:^|_)(?:budget|budgets|spend|spent|cost|costs)(?:_|$)/,
    words: /\b(?:spend|spent|spending|budget|budgets|cost|costs)\b/i,
  },
  {
    family: "revenue",
    key: /(?:^|_)(?:revenue|sales|gmv|income|earnings|gross|net|mrr|arr)(?:_|$)/,
    words: /\b(?:revenue|sales|gmv|income|earnings|gross|net|mrr|arr)\b/i,
  },
];

function familyOfKey(key: string): string | null {
  return MONEY_FAMILIES.find((f) => f.key.test(key))?.family ?? null;
}

function familyOfSentence(s: string): string | null {
  const named = MONEY_FAMILIES.filter((f) => f.words.test(s));
  return named.length === 1 ? named[0].family : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function twoTermSum(run_id: string, figure: string, pulledMoney: string[], answer: string): string | null {
  if (!figure.includes("$") || figure.trim().startsWith("-")) return null;
  const target = cents(figure);
  if (target === null || target <= 0) return null;
  const token = new RegExp(`(?<![\\d.,$])${escapeRe(figure.trim())}(?![\\d]|[.,]\\d)`);
  const families = new Set<string>();
  let clauses = 0;
  for (const s of proseOnly(answer).split(/(?<=[.!?])\s+|\n+|;\s+|,?\s+(?:and|but)\s+/)) {
    if (!token.test(s)) continue;
    clauses++;
    const f = TOTAL_WORD.test(s) ? familyOfSentence(s) : null;
    if (!f) return null;
    families.add(f);
  }
  if (clauses === 0 || families.size !== 1) return null;
  const family = [...families][0];
  const keysOf = (f: string) =>
    new Set(
      typedPullsForFigure(run_id, f, "$")
        .map((t) => t.key)
        .filter((k): k is string => !!k && familyOfKey(k) === family),
    );
  const found = new Map<string, string>();
  for (let i = 0; i < pulledMoney.length; i++) {
    for (let j = i + 1; j < pulledMoney.length; j++) {
      const a = pulledMoney[i];
      const b = pulledMoney[j];
      const ca = cents(a);
      const cb = cents(b);
      if (ca === null || cb === null || ca === cb || ca + cb !== target) continue;
      const ka = keysOf(a);
      if (![...keysOf(b)].some((k) => ka.has(k))) continue;
      const [hi, lo] = ca >= cb ? [a, b] : [b, a];
      found.set(`${Math.max(ca, cb)}:${Math.min(ca, cb)}`, `${figure} = ${hi} + ${lo}`);
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}
