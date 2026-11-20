
import type { AccessNote } from "@/services/data-gateway/types";

import { isCompanyNotesTool } from "@/services/agents/tool-source-label";

const ledgers = new Map<string, Set<string>>();

const moneyKeys = new Map<string, Set<string>>();

const smallInts = new Map<string, Set<string>>();
const MAX_MONEY_KEYS_PER_RUN = 5_000;

const urls = new Map<string, Set<string>>();

const MAX_FIGURES_PER_RUN = 50_000;

const MAX_RUNS_RETAINED = 500;
const MAX_URLS_PER_RUN = 5_000;

function pruneIfNeeded(): void {
  if (ledgers.size <= MAX_RUNS_RETAINED) return;
  const overflow = ledgers.size - MAX_RUNS_RETAINED;
  let i = 0;
  for (const key of ledgers.keys()) {
    if (i++ >= overflow) break;
    ledgers.delete(key);
    moneyKeys.delete(key);
    smallInts.delete(key);
  }
}

function roundTo2(value: string): string {
  const [int, frac = ""] = value.split(".");
  if (frac.length <= 2) return `${int}.${frac.padEnd(2, "0")}`;
  const kept = BigInt(`${int}${frac.slice(0, 2)}`) + (frac[2] >= "5" ? 1n : 0n);
  const digits = kept.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function recordTrustedMoneyValue(run_id: string, value: number): void {
  if (!run_id || !Number.isFinite(value)) return;
  const plain = String(Math.abs(value));
  if (!/^\d{1,15}\.\d{3,12}$/.test(plain)) return;
  let set = moneyKeys.get(run_id);
  if (!set) {
    set = new Set<string>();
    moneyKeys.set(run_id, set);
  }
  if (set.size >= MAX_MONEY_KEYS_PER_RUN) return;
  set.add(`${value < 0 ? "-" : ""}${roundTo2(plain)}`);
}

function recordSmallInts(run_id: string, raw: string): void {
  let small = smallInts.get(run_id);
  if ((small && small.size === 10) || raw.length > 1_000_000) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const roots = blocks.flatMap((b) => {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string") {
      const text = (b as { text: string }).text;
      if (text.length > 1_000_000 || !/^\s*[[{]/.test(text)) return [];
      try {
        return [JSON.parse(text) as unknown];
      } catch {
        return [];
      }
    }
    return [b];
  });
  const stack: unknown[] = [...roots];
  let seen = 0;
  while (stack.length > 0 && seen++ < 200_000) {
    const v = stack.pop();
    if (typeof v === "number") {
      if (Number.isInteger(v) && v >= 0 && v <= 9) {
        if (!small) {
          small = new Set<string>();
          smallInts.set(run_id, small);
        }
        small.add(String(v));
        if (small.size === 10) return;
      }
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) stack.push(x);
    }
  }
}

export function smallIntWasRead(run_id: string, value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 9 && (smallInts.get(run_id)?.has(String(value)) ?? false);
}

export function moneyRoundingWasRead(run_id: string, amount: string, negative: boolean): boolean {
  return moneyKeys.get(run_id)?.has(`${negative ? "-" : ""}${amount}`) ?? false;
}

const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

export function digitsOf(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

export function recordFigures(run_id: string, raw: string): void {
  if (!run_id || !raw) return;
  let set = ledgers.get(run_id);
  if (!set) {
    set = new Set<string>();
    ledgers.set(run_id, set);
    pruneIfNeeded();
  }
  if (set.size >= MAX_FIGURES_PER_RUN) return;
  for (const re of [NUMBER, /\d+/g]) {
    for (const m of raw.matchAll(re)) {
      const d = digitsOf(m[0]);
      if (d.length < 2) continue;
      set.add(d);
      if (set.size >= MAX_FIGURES_PER_RUN) return;
    }
  }
}

export function normaliseUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "");
}

export function recordUrls(run_id: string, raw: string): void {
  if (!run_id || !raw) return;
  let set = urls.get(run_id);
  if (!set) {
    set = new Set<string>();
    urls.set(run_id, set);
    if (urls.size > MAX_RUNS_RETAINED) {
      const overflow = urls.size - MAX_RUNS_RETAINED;
      let i = 0;
      for (const key of urls.keys()) {
        if (i++ >= overflow) break;
        urls.delete(key);
      }
    }
  }
  if (set.size >= MAX_URLS_PER_RUN) return;
  for (const m of raw.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    set.add(normaliseUrl(m[0]));
    if (set.size >= MAX_URLS_PER_RUN) return;
  }
}

export function urlWasRead(run_id: string, url: string): boolean {
  const set = urls.get(run_id);
  if (!set || set.size === 0) return true;
  const n = normaliseUrl(url);
  if (!n) return true;
  if (set.has(n)) return true;
  for (const seen of set) {
    if (seen.startsWith(n) || n.startsWith(seen)) return true;
  }
  return false;
}

export function urlLedgerIsEmpty(run_id: string): boolean {
  return (urls.get(run_id)?.size ?? 0) === 0;
}

export function recordInputFigures(run_id: string, raw: string): void {
  recordFigures(run_id, raw);
}

export function figureWasRead(run_id: string, figure: string): boolean {
  const d = digitsOf(figure);
  if (d.length === 0) return true;
  const set = ledgers.get(run_id);
  if (!set) return false;
  if (set.has(d)) return true;

  if (!/0$/.test(d)) return false;
  const cited = Number(d);
  if (!Number.isFinite(cited) || cited === 0) return false;
  const significant = d.replace(/0+$/, "").length;
  if (significant === 0 || significant >= d.length) return false;
  for (const seen of set) {
    if (seen.length !== d.length) continue;
    const read = Number(seen);
    if (!Number.isFinite(read) || read === 0) continue;
    if (Number(read.toPrecision(significant)) === cited) return true;
  }
  return false;
}

export function ledgerIsEmpty(run_id: string): boolean {
  return (ledgers.get(run_id)?.size ?? 0) === 0;
}

const PAUSED_STATUSES: ReadonlySet<string> = new Set(["paused_awaiting_approval", "paused_awaiting_child"]);

export function releaseRunFigures(run_id: string, status: string | null): boolean {
  if (status !== null && PAUSED_STATUSES.has(status)) return false;
  clearFigures(run_id);
  return true;
}

export function clearFigures(run_id: string): void {
  refusedReads.delete(run_id);
  ledgers.delete(run_id);
  moneyKeys.delete(run_id);
  smallInts.delete(run_id);
  urls.delete(run_id);
  pullIndexes.delete(run_id);
  shownRows.delete(run_id);
  withheld.delete(run_id);
  ownerFigures.delete(run_id);
  pullUnits.delete(run_id);
}

const withheld = new Map<string, Set<string>>();

export function withholdFigures(run_id: string, figures: string[]): void {
  if (!run_id || figures.length === 0) return;
  let set = withheld.get(run_id);
  if (!set) {
    set = new Set<string>();
    withheld.set(run_id, set);
    if (withheld.size > MAX_RUNS_RETAINED) {
      const oldest = withheld.keys().next().value;
      if (oldest !== undefined) withheld.delete(oldest);
    }
  }
  for (const f of figures) {
    const d = digitsOf(f);
    if (d.length > 0) set.add(d);
  }
}

function withheldMatch(run_id: string, figure: string): string | null {
  const set = withheld.get(run_id);
  const d = digitsOf(figure);
  if (!set || set.size === 0 || !d) return null;
  if (set.has(d)) return d;
  if (!/0$/.test(d)) return null;
  const significant = d.replace(/0+$/, "").length;
  if (significant === 0 || significant >= d.length) return null;
  for (const w of set) {
    if (w.length !== d.length) continue;
    if (Number(Number(w).toPrecision(significant)) === Number(d)) return w;
  }
  return null;
}

export function figureIsDecisionSource(run_id: string, figure: string): boolean {
  if (!figureWasRead(run_id, figure)) return false;
  const w = withheldMatch(run_id, figure);
  if (!w) return true;
  return pullsForFigure(run_id, figure).length > 0 || pullsForFigure(run_id, w).length > 0;
}

export function _figureCount(run_id: string): number {
  return ledgers.get(run_id)?.size ?? 0;
}

export const SELF_RECORDING_TOOLS: ReadonlySet<string> = new Set([
  "growth__get_metric",
  "growth__compute",
  "growth__explain_change",
  "growth__ad_budget_room",
]);

export function isSelfRecordingTool(name: string): boolean {
  const n = String(name ?? "").trim();
  for (const t of SELF_RECORDING_TOOLS) {
    if (n === t || n.endsWith(`__${t}`)) return true;
  }
  return false;
}

export interface FigurePull {
  tool: string;
  nth: number;
  access?: AccessNote[];
}

interface PullIndex {
  pulls: FigurePull[];
  byFigure: Map<string, number[]>;
  counts: Map<string, number>;
  totals: ColumnTotal[];
  typed: Map<string, TypedPull[]>;
  byValue: Map<string, number[]>;
  named: Map<string, number[]>;
}

export interface TypedPull {
  pull: FigurePull;
  unit: "$" | "%";
  key: string | null;
}

export interface ColumnTotal {
  pull: FigurePull;
  column: string;
  rows: number;
  total: number;
  decimals: number;
  cells: number[];
}

const MAX_PULLS_PER_RUN = 300;
const MAX_INDEXED_FIGURES_PER_RUN = 20_000;
const MAX_PULLS_PER_FIGURE = 3;

const pullIndexes = new Map<string, PullIndex>();

function pullIndexFor(run_id: string): PullIndex {
  let idx = pullIndexes.get(run_id);
  if (!idx) {
    idx = { pulls: [], byFigure: new Map(), counts: new Map(), totals: [], typed: new Map(), byValue: new Map(), named: new Map() };
    pullIndexes.set(run_id, idx);
    if (pullIndexes.size > MAX_RUNS_RETAINED) {
      const overflow = pullIndexes.size - MAX_RUNS_RETAINED;
      let i = 0;
      for (const key of pullIndexes.keys()) {
        if (i++ >= overflow) break;
        pullIndexes.delete(key);
      }
    }
  }
  return idx;
}

function attributableBody(raw: string): string {
  if (raw.length > MAX_PARSE_BYTES) return raw;
  const t = raw.trimStart();
  if (!t.startsWith("{")) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  const body = (parsed as Record<string, unknown>).body_text;
  if (typeof body === "string") return body;
  return t.includes('"recommendation') ? JSON.stringify(withoutSuggestions(parsed, 0)) : raw;
}

const SUGGESTION_KEYS = new Set(["recommendation", "recommendations"]);
function withoutSuggestions(node: unknown, depth: number): unknown {
  if (depth > MAX_TYPED_DEPTH || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((x) => withoutSuggestions(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!SUGGESTION_KEYS.has(k.toLowerCase())) out[k] = withoutSuggestions(v, depth + 1);
  }
  return out;
}

const MAX_PARSE_BYTES = 2_000_000;

export function recordFiguresFromPull(
  run_id: string,
  raw: string,
  tool_name: string,
  access?: AccessNote[],
): void {
  recordFigures(run_id, raw);
  if (!run_id || !raw || !tool_name) return;
  recordSmallInts(run_id, raw);
  const idx = pullIndexFor(run_id);
  if (idx.pulls.length >= MAX_PULLS_PER_RUN) return;
  const nth = (idx.counts.get(tool_name) ?? 0) + 1;
  idx.counts.set(tool_name, nth);
  const pullAt = idx.pulls.length;
  const notes = access?.filter((n) => n.result === "allowed").slice(0, MAX_ACCESS_NOTES_PER_PULL);
  idx.pulls.push(notes && notes.length > 0 ? { tool: tool_name, nth, access: notes } : { tool: tool_name, nth });
  const body = attributableBody(raw);
  if (TOTALLED_TOOL.test(tool_name)) indexColumnTotals(idx, pullAt, body);
  indexTypedJson(idx, pullAt, body, tool_name);
  indexNamedJson(idx, pullAt, body);
  for (const re of [NUMBER, /\d+/g]) {
    for (const m of body.matchAll(re)) {
      const d = digitsOf(m[0]);
      if (d.length < 2) continue;
      if (re === NUMBER) {
        recordPullUnit(run_id, body, m.index ?? 0, m[0], d);
        recordTypedPull(idx, pullAt, body, m.index ?? 0, m[0]);
      }
      const v = numericValueKey(m[0]);
      if (v !== null) {
        const at = idx.byValue.get(v);
        if (!at) {
          if (idx.byValue.size < MAX_INDEXED_FIGURES_PER_RUN) idx.byValue.set(v, [pullAt]);
        } else if (!at.includes(pullAt)) at.push(pullAt);
      }
      const existing = idx.byFigure.get(d);
      if (existing) {
        if (existing.includes(pullAt)) continue;
        if (existing.length < MAX_PULLS_PER_FIGURE) {
          existing.push(pullAt);
        } else if (!isCompanyNotesTool(tool_name)) {
          let displaced = false;
          for (let i = existing.length - 1; i >= 0; i--) {
            if (isCompanyNotesTool(idx.pulls[existing[i]].tool)) {
              existing.splice(i, 1);
              existing.push(pullAt);
              displaced = true;
              break;
            }
          }
          if (!displaced) {
            existing.shift();
            existing.push(pullAt);
          }
        }
        continue;
      }
      if (idx.byFigure.size >= MAX_INDEXED_FIGURES_PER_RUN) return;
      idx.byFigure.set(d, [pullAt]);
    }
  }
}

const MIN_TOTAL_ROWS = 2;
const MAX_TOTAL_ROWS = 1_000;
const MAX_TOTALS_PER_RUN = 200;
const NOT_A_QUANTITY_WORDS = new Set([
  "id", "year", "month", "day", "date", "ts", "timestamp",
  "avg", "average", "mean", "median", "rate", "ratio", "pct", "percent", "share",
  "price", "cpm", "cpc", "ctr", "cpa", "roas",
]);
function isQuantityColumn(column: string): boolean {
  const words = column
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.length > 0 && !words.some((w) => NOT_A_QUANTITY_WORDS.has(w));
}
const TOTALLED_TOOL = /(^|__)operator_db__(query(_[a-z0-9_]+)?|codeact)$/;

function decimalPlaces(n: number): number {
  const m = String(n).match(/\.(\d+)$/);
  return m ? m[1].length : 0;
}

function indexColumnTotals(idx: PullIndex, pullAt: number, body: string): void {
  if (body.length > MAX_PARSE_BYTES || idx.totals.length >= MAX_TOTALS_PER_RUN) return;
  const t = body.trimStart();
  if (!t.startsWith("{")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return;
  }
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(parsed)) return;
  const result = Array.isArray(parsed.rows) ? parsed : isObj(parsed.data) ? parsed.data : null;
  if (!result || !Array.isArray(result.rows)) return;
  const rows = result.rows as unknown[];
  if (result.truncated !== false) return;
  if (result.row_count !== undefined && result.row_count !== rows.length) return;
  if (result.row_count_exact === false) return;
  if (rows.length < MIN_TOTAL_ROWS || rows.length > MAX_TOTAL_ROWS) return;
  if (!rows.every(isObj)) return;
  const first = rows[0] as Record<string, unknown>;
  for (const column of Object.keys(first)) {
    if (!isQuantityColumn(column)) continue;
    const cells: number[] = [];
    for (const row of rows as Record<string, unknown>[]) {
      const v = row[column];
      if (typeof v !== "number" || !Number.isFinite(v)) break;
      cells.push(v);
    }
    if (cells.length !== rows.length) continue;
    const decimals = Math.max(...cells.map(decimalPlaces));
    const scale = 10 ** decimals;
    const total = Math.round(cells.reduce((a, c) => a + c * scale, 0)) / scale;
    idx.totals.push({ pull: idx.pulls[pullAt], column, rows: rows.length, total, decimals, cells });
    if (idx.totals.length >= MAX_TOTALS_PER_RUN) return;
  }
}

export function totalsForFigure(run_id: string, figure: string): ColumnTotal[] {
  const cleaned = figure.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return [];
  const value = Number(cleaned);
  return (pullIndexes.get(run_id)?.totals ?? []).filter(
    (t) => t.total > 0 && Math.abs(t.total - value) < 1e-9,
  );
}

export function columnTotals(run_id: string): ColumnTotal[] {
  return pullIndexes.get(run_id)?.totals ?? [];
}

export function numericValueKey(raw: string): string | null {
  const m = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? String(n) : null;
}

export function pullsForFigureValue(run_id: string, figure: string): FigurePull[] {
  const pulls = pullsForFigure(run_id, figure);
  const idx = pullIndexes.get(run_id);
  const v = numericValueKey(figure);
  if (!idx || v === null || pulls.length === 0) return pulls;
  const at = new Set(idx.byValue.get(v) ?? []);
  return pulls.filter((p) => at.has(idx.pulls.indexOf(p)));
}

export function pullsForFigure(run_id: string, figure: string): FigurePull[] {
  const d = digitsOf(figure);
  if (!d) return [];
  const idx = pullIndexes.get(run_id);
  if (!idx) return [];
  return (idx.byFigure.get(d) ?? []).map((i) => idx.pulls[i]).filter(Boolean);
}

const MONEY_KEY_WORDS = new Set([
  "usd", "spend", "spent", "cost", "costs", "cpc", "cpm", "cpa", "cpl", "cpi", "price", "prices",
  "revenue", "budget", "budgets", "amount", "gmv", "payout", "payouts", "fee", "fees", "sales",
  "earnings", "income", "refund", "refunds", "charge", "charges", "paid", "balance", "bid", "bids",
  "aov", "ltv", "arpu", "cac", "gross", "net", "mrr", "arr",
]);
const PERCENT_KEY_WORDS = new Set(["pct", "percent", "percentage", "ctr", "rate", "share"]);
const MINOR_UNIT_WORDS = new Set(["minor", "cents", "micros"]);
const COUNT_HEAD_WORDS = new Set([
  "count", "num", "qty", "quantity", "units",
  "users", "customers", "signups", "bookings", "orders", "clicks", "impressions", "sessions", "visits",
  "leads", "conversions", "trips", "installs", "subscribers",
]);
const KEY_QUALIFIERS = new Set(["from", "per", "of", "by", "for", "on", "in", "to"]);
const UNIT_VALUE_KEYS = new Set([
  "total", "compare_total", "delta_abs", "value", "values", "sum", "avg", "average", "mean", "median",
  "min", "max", "current", "previous",
]);
const UNIT_SERIES_KEYS = new Set(["series", "breakdown", "points", "data", "rows", "values", "history", "items", "buckets"]);
const STRIPE_TOOL = /(?:^|_)stripe(?:_|$)/i;

export function isMinorUnitTool(tool: string): boolean {
  return STRIPE_TOOL.test(tool);
}
const MAX_TYPED_PER_RUN = 20_000;
const MAX_TYPED_PARSE_BYTES = 2_000_000;
const MAX_TYPED_DEPTH = 40;

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function objectUnit(o: Record<string, unknown>): "$" | "%" | null {
  const u = typeof o.unit === "string" ? o.unit.toLowerCase() : "";
  if (u === "currency" || u === "usd" || u === "money") return "$";
  if (u === "percent" || u === "pct" || u === "%") return "%";
  return null;
}

type TypedUnit = "$" | "%" | "$c";

function unitForKey(key: string, ctx: "$" | "%" | null, minorAmounts: boolean, minorSource: boolean): TypedUnit | null {
  const words = keyWords(key);
  if (words.length === 0) return null;
  if (words.some((w) => MINOR_UNIT_WORDS.has(w))) return null;
  const cut = words.findIndex((w, i) => i > 0 && KEY_QUALIFIERS.has(w));
  const head = cut > 0 ? words.slice(0, cut) : words;
  if (COUNT_HEAD_WORDS.has(head[head.length - 1])) return null;
  if (key.toLowerCase() === "delta_pct") return "%";
  const saysDollars = words.includes("usd") || words.includes("dollars");
  if (head.some((w) => MONEY_KEY_WORDS.has(w))) {
    if (saysDollars) return "$";
    if (minorSource) return "$c";
    if (minorAmounts && head[0] === "amount") return "$c";
    return "$";
  }
  if (head.some((w) => PERCENT_KEY_WORDS.has(w))) return "%";
  if (ctx && UNIT_VALUE_KEYS.has(key.toLowerCase())) return ctx === "$" && minorSource ? "$c" : ctx;
  return null;
}

export function figureValueKey(raw: string): string | null {
  if (/\d[eE][-+]?\d/.test(raw)) return null;
  const m = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? String(n) : null;
}

function walkTyped(
  idx: PullIndex,
  pullAt: number,
  node: unknown,
  key: string | null,
  ctx: "$" | "%" | null,
  minorAmounts: boolean,
  minorSource: boolean,
  foreignCurrency: boolean,
  depth: number,
): void {
  if (depth > MAX_TYPED_DEPTH || node === null || node === undefined) return;
  if (typeof node === "number" || (typeof node === "string" && /^-?\d+(?:\.\d+)?$/.test(node.trim()))) {
    if (!key) return;
    const unit = unitForKey(key, ctx, minorAmounts, minorSource);
    if (!unit) return;
    if (/[eE]/.test(String(node))) return;
    if ((unit === "$" || unit === "$c") && foreignCurrency) return;
    const n = Number(node);
    if (!Number.isFinite(n)) return;
    const v = figureValueKey(String(unit === "$c" ? Math.round(n) / 100 : n));
    if (v) addTyped(idx, pullAt, v, unit === "$c" ? "$" : unit, key.toLowerCase());
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) walkTyped(idx, pullAt, x, key, ctx, minorAmounts, minorSource, foreignCurrency, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    const own = typeof o.unit === "string" ? objectUnit(o) : ctx;
    const code = typeof o.currency === "string" && /^[a-z]{3}$/i.test(o.currency) ? o.currency.toLowerCase() : null;
    const minor = code !== null;
    const foreign = code ? code !== "usd" : foreignCurrency;
    for (const [k, v] of Object.entries(o)) {
      const child = v !== null && typeof v === "object" && !UNIT_SERIES_KEYS.has(k.toLowerCase()) ? null : own;
      walkTyped(idx, pullAt, v, k, child, minor, minorSource, foreign, depth + 1);
    }
  }
}

const GENERIC_VALUE_KEYS = new Set([...UNIT_VALUE_KEYS, "result", "number", "id", "nth"]);
const METADATA_KEYS = new Set(["row_count", "rows_returned", "limit", "offset", "page", "page_size", "per_page", "queries", "time_increment", "revision"]);
const NOT_RETURNED_KEYS = new Set(["inputs", "input", "receipt", "params"]);

function namesItsMeasure(o: Record<string, unknown>): boolean {
  return typeof o.metric_id === "string" && o.metric_id.length > 0;
}

function walkNamed(idx: PullIndex, pullAt: number, node: unknown, key: string | null, depth: number, measured = false): void {
  if (depth > MAX_TYPED_DEPTH || node === null || node === undefined) return;
  if (typeof node === "number" || (typeof node === "string" && /^-?\d+(?:\.\d+)?$/.test(node.trim()))) {
    if (!key) return;
    const k = key.toLowerCase();
    if (METADATA_KEYS.has(k)) return;
    if (GENERIC_VALUE_KEYS.has(k) && !(measured && UNIT_VALUE_KEYS.has(k))) return;
    const v = figureValueKey(String(node));
    if (!v) return;
    const at = idx.named.get(v);
    if (!at) {
      if (idx.named.size < MAX_TYPED_PER_RUN) idx.named.set(v, [pullAt]);
    } else if (!at.includes(pullAt)) at.push(pullAt);
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) walkNamed(idx, pullAt, x, key, depth + 1, measured);
    return;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    const own = namesItsMeasure(o) || measured;
    for (const [k, v] of Object.entries(o)) {
      if (NOT_RETURNED_KEYS.has(k.toLowerCase())) continue;
      const child = v !== null && typeof v === "object" && !UNIT_SERIES_KEYS.has(k.toLowerCase()) ? false : own;
      walkNamed(idx, pullAt, v, k, depth + 1, child);
    }
  }
}

function indexNamedJson(idx: PullIndex, pullAt: number, body: string): void {
  if (body.length > MAX_TYPED_PARSE_BYTES) return;
  const t = body.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return;
  try {
    walkNamed(idx, pullAt, JSON.parse(t), null, 0);
  } catch {
  }
}

export function pullsNamingFigure(run_id: string, figure: string): FigurePull[] {
  const v = figureValueKey(figure);
  const idx = pullIndexes.get(run_id);
  if (!v || !idx) return [];
  return (idx.named.get(v) ?? []).map((i) => idx.pulls[i]).filter(Boolean);
}

function indexTypedJson(idx: PullIndex, pullAt: number, body: string, tool_name: string): void {
  if (body.length > MAX_TYPED_PARSE_BYTES) return;
  const t = body.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return;
  }
  walkTyped(idx, pullAt, parsed, null, null, false, STRIPE_TOOL.test(tool_name), false, 0);
}

function recordTypedPull(idx: PullIndex, pullAt: number, body: string, at: number, raw: string): void {
  const v = figureValueKey(raw);
  if (!v) return;
  if (/\$\s?$/.test(body.slice(Math.max(0, at - 2), at))) addTyped(idx, pullAt, v, "$", null);
  else if (/^\s?%/.test(body.slice(at + raw.length, at + raw.length + 2))) addTyped(idx, pullAt, v, "%", null);
}

function addTyped(idx: PullIndex, pullAt: number, v: string, unit: "$" | "%", key: string | null): void {
  const pull = idx.pulls[pullAt];
  const list = idx.typed.get(v);
  if (list) {
    if (list.length >= MAX_PULLS_PER_FIGURE * 4) return;
    if (list.some((t) => t.pull === pull && t.unit === unit && t.key === key)) return;
    list.push({ pull, unit, key });
    return;
  }
  if (idx.typed.size >= MAX_TYPED_PER_RUN) return;
  idx.typed.set(v, [{ pull, unit, key }]);
}

export function typedPullsForFigure(run_id: string, figure: string, unit: "$" | "%"): TypedPull[] {
  const v = figureValueKey(figure);
  if (!v) return [];
  return (pullIndexes.get(run_id)?.typed.get(v) ?? []).filter((t) => t.unit === unit);
}

export function isLowEntropyFigure(figure: string): boolean {
  if (!/[$%]/.test(figure)) return false;
  const sig = digitsOf(figure).replace(/^0+/, "").replace(/0+$/, "");
  return sig.length <= 2;
}

export function toolCallCount(run_id: string, tool: string): number {
  return pullIndexes.get(run_id)?.counts.get(tool) ?? 0;
}

const pullUnits = new Map<string, Set<string>>();
const MAX_PULL_UNITS_PER_RUN = 20_000;

function recordPullUnit(run_id: string, body: string, at: number, raw: string, d: string): void {
  const before = body.slice(Math.max(0, at - 2), at);
  const after = body.slice(at + raw.length, at + raw.length + 2);
  const units: string[] = [];
  if (/\$\s?$/.test(before)) units.push("$");
  if (/^\s?%/.test(after)) units.push("%");
  if (units.length === 0) return;
  let set = pullUnits.get(run_id);
  if (!set) {
    set = new Set<string>();
    pullUnits.set(run_id, set);
    if (pullUnits.size > MAX_RUNS_RETAINED) {
      const oldest = pullUnits.keys().next().value;
      if (oldest !== undefined) pullUnits.delete(oldest);
    }
  }
  for (const u of units) if (set.size < MAX_PULL_UNITS_PER_RUN) set.add(`${u}${d}`);
}

export function pullWroteUnit(run_id: string, figure: string, unit: "$" | "%"): boolean {
  return pullUnits.get(run_id)?.has(`${unit}${digitsOf(figure)}`) ?? false;
}

export function preferredPull(pulls: FigurePull[]): FigurePull | undefined {
  return pulls.find((p) => !isCompanyNotesTool(p.tool)) ?? pulls[0];
}

export function pullIndexIsEmpty(run_id: string): boolean {
  return (pullIndexes.get(run_id)?.pulls.length ?? 0) === 0;
}

const MAX_ACCESS_NOTES_PER_PULL = 10;
const MAX_REFUSED_PER_RUN = 20;
const refusedReads = new Map<string, AccessNote[]>();

export function recordRefusedReads(run_id: string, access: AccessNote[] | undefined): void {
  if (!run_id || !access || access.length === 0) return;
  const refused = access.filter((n) => n.result === "refused");
  if (refused.length === 0) return;
  const list = refusedReads.get(run_id) ?? [];
  for (const n of refused) if (list.length < MAX_REFUSED_PER_RUN) list.push(n);
  refusedReads.delete(run_id);
  refusedReads.set(run_id, list);
  while (refusedReads.size > MAX_RUNS_RETAINED) {
    const oldest = refusedReads.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    refusedReads.delete(oldest);
  }
}

export function refusedReadsFor(run_id: string): AccessNote[] {
  return refusedReads.get(run_id) ?? [];
}

export function _pullCount(run_id: string): number {
  return pullIndexes.get(run_id)?.pulls.length ?? 0;
}

const MAX_SHOWN_ROWS_PER_RUN = 200;

const shownRows = new Map<string, string[][]>();

const NUMERIC_CELL = /^[-+]?\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?%?$|^[-+]?\$?\s?\d+(?:\.\d+)?\s?%?$/;

export function resetShownRows(run_id: string): void {
  shownRows.delete(run_id);
}

export function recordShownRows(run_id: string, rows: string[][]): void {
  if (!run_id || rows.length === 0) return;
  let list = shownRows.get(run_id);
  if (!list) {
    list = [];
    shownRows.set(run_id, list);
    if (shownRows.size > MAX_RUNS_RETAINED) {
      const oldest = shownRows.keys().next().value;
      if (oldest !== undefined) shownRows.delete(oldest);
    }
  }
  for (const row of rows) {
    if (list.length >= MAX_SHOWN_ROWS_PER_RUN) return;
    const nums = row.map((c) => c.trim()).filter((c) => NUMERIC_CELL.test(c));
    if (nums.length > 0) list.push(nums);
  }
}

export function shownRowsFor(run_id: string): string[][] {
  return shownRows.get(run_id) ?? [];
}

const ownerFigures = new Map<string, Set<string>>();

export function ownerFigureKey(raw: string): string | null {
  const t = raw.trim().replace(/[,.;:!?)\]]+$/, "");
  const m = t.match(/^(-)?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s?(%)?$/);
  if (!m) return null;
  const value = Number(`${m[2].replace(/,/g, "")}${m[3] ?? ""}`);
  if (!Number.isFinite(value)) return null;
  const unit = m[4] ? "%" : t.replace(/^-/, "").startsWith("$") ? "$" : "";
  return `${unit}${m[1] ?? ""}${value}`;
}

const OWNER_NUMBER =
  /(?<![A-Za-z0-9.,/\-\u2010-\u2015\u2212])(-?\$?\s?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?![\d]|,\d|\.\d|[/\-\u2010-\u2015\u2212]\d|[A-Za-z])(\s?%)?/g;

const PHONE_SEP = String.raw`[\s.\-\u2010-\u2015]`;
const PHONE_RUN = new RegExp(
  String.raw`(?<!\d)(?:\+\d{1,3}${PHONE_SEP}{0,3}|1${PHONE_SEP}{1,3})?(?:(?:\(\d{3}\)|\[\d{3}\])${PHONE_SEP}{0,3}|\d{3}${PHONE_SEP}{1,3})\d{3}${PHONE_SEP}{1,3}\d{4}(?!\d)` +
    String.raw`|\+\d(?:[\s.\-()]{0,2}\d){7,14}(?!\d)`,
  "g",
);

export function recordOwnerFigures(run_id: string, text: string): void {
  if (!run_id || !text) return;
  let set = ownerFigures.get(run_id);
  if (!set) {
    set = new Set<string>();
    ownerFigures.set(run_id, set);
    if (ownerFigures.size > MAX_RUNS_RETAINED) {
      const oldest = ownerFigures.keys().next().value;
      if (oldest !== undefined) ownerFigures.delete(oldest);
    }
  }
  const cleaned = text.replace(PHONE_RUN, " ");
  for (const m of cleaned.matchAll(OWNER_NUMBER)) {
    if (set.size >= MAX_FIGURES_PER_RUN) return;
    const key = ownerFigureKey(`${m[1]}${m[2]}${m[3] ?? ""}${m[4] ?? ""}`);
    if (key) set.add(key);
  }
}

export function figureKeysIn(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.replace(PHONE_RUN, " ").matchAll(OWNER_NUMBER)) {
    if (out.size >= MAX_FIGURES_PER_RUN) break;
    const key = ownerFigureKey(`${m[1]}${m[2]}${m[3] ?? ""}${m[4] ?? ""}`);
    if (key) out.add(key);
  }
  return out;
}

export function ownerTyped(run_id: string, figure: string): boolean {
  const key = ownerFigureKey(figure);
  return !!key && (ownerFigures.get(run_id)?.has(key) ?? false);
}
