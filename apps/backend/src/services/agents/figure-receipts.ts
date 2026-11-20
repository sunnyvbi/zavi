
import { proseOnly, type CheckedFigure } from "@/services/agents/answer-sources";
import { digitsOf } from "@/services/agents/engine/figure-ledger";
import { listResults, resultIsVerified, type StoredResult } from "@/services/analytics/metric-results";
import { digitSetOf, exploratoryFor } from "@/services/analytics/exploratory-results";
import { isProposalAt, proposalKey } from "@zavi/shared";

export type FigureReceipt = {
  figure: string;
  kind: "catalog" | "compute" | "exploratory" | "pulled" | "worked_out" | "reported";
  source: string;
  source_slug?: string;
  metric_id?: string;
  label?: string;
  definition?: string;
  window?: { since: string; until: string };
  tz?: string;
  currency?: string | null;
  fetched_at?: string;
  params?: Array<[string, string]>;
  formula?: string;
  caveats?: string[];
  purpose?: string;
  sql?: string[];
  verified?: false;
};

export const MAX_FIGURE_RECEIPTS = 20;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;

function paramsOf(v: unknown): Array<[string, string]> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Array<[string, string]> = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    const shown =
      typeof val === "string" || typeof val === "number" || typeof val === "boolean"
        ? String(val)
        : Array.isArray(val)
          ? val.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ")
          : Object.entries(val as Record<string, unknown>)
              .map(([a, b]) => `${a} ${typeof b === "object" ? JSON.stringify(b) : String(b)}`)
              .join(", ");
    out.push([k.slice(0, 40), shown.slice(0, 160)]);
    if (out.length >= 10) break;
  }
  return out.length ? out : undefined;
}

function resultDigits(r: StoredResult): Set<string> {
  return digitSetOf([r.value, r.compare_value, r.delta_pct, ...(r.series ?? []).map((p) => p.value)]);
}

export function usesTypedInput(r: StoredResult): boolean {
  return !resultIsVerified(r);
}

function fromResult(figure: string, r: StoredResult, source: string): FigureReceipt {
  const rc = r.receipt ?? {};
  const w = rc.window as { since?: unknown; until?: unknown } | undefined;
  return {
    figure,
    kind: r.kind === "compute" ? "compute" : "catalog",
    source,
    source_slug: str(rc.source, 40),
    metric_id: str(rc.metric_id, 60),
    label: str(r.label, 120),
    definition: str(rc.definition, 300),
    window:
      w && typeof w.since === "string" && typeof w.until === "string" && w.since && w.until
        ? { since: w.since, until: w.until }
        : undefined,
    tz: str(rc.tz, 64),
    currency: typeof rc.currency === "string" ? rc.currency.slice(0, 8) : rc.currency === null ? null : undefined,
    fetched_at: str(rc.fetched_at, 40),
    params: paramsOf(rc.params),
    formula: str(rc.formula, 300),
    caveats: Array.isArray(rc.caveats)
      ? rc.caveats.filter((c): c is string => typeof c === "string").slice(0, 4).map((c) => c.slice(0, 300))
      : undefined,
  };
}

const SELF_RECORDING = /(?:^|__)growth__(?:get_metric|compute)$/;
const CODEACT = /codeact$/;

const SMALL_MONEY = /\$\s?(\d)(?![\d,]|\.\d)/g;
const SMALL_PERCENT = /(?<![\d.,$])(-?\d)\s?%/g;

function resultNumbers(r: StoredResult): number[] {
  return [r.value, r.compare_value, r.delta_pct, ...(r.series ?? []).map((p) => p.value)].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
}

export function smallFigureReceipts(answer: string, results: StoredResult[]): FigureReceipt[] {
  if (!answer || results.length === 0) return [];
  const prose = proseOnly(answer);
  const out: FigureReceipt[] = [];
  const seen = new Set<string>();
  const newest = [...results].reverse();
  const take = (raw: string, n: number, percent: boolean) => {
    const key = `${percent ? "%" : "$"}${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    const r = newest.find(
      (x) =>
        (percent || x.unit === "currency" || x.kind === "compute") &&
        resultNumbers(x).some((v) => (percent ? Math.round(v) === n : v === n)),
    );
    if (!r) return;
    const source = r.kind === "compute" ? "Worked out by Zavi" : String((r.receipt as { source?: unknown }).source ?? "Metric");
    out.push({ ...fromResult(raw.trim(), r, source), ...(usesTypedInput(r) ? { verified: false as const } : {}) });
  };
  const proposed = new Set<string>();
  const notProposed = (m: RegExpMatchArray) => {
    const raw = m[0].trim();
    if (!isProposalAt(prose, m.index ?? 0, raw, proposed)) return true;
    const key = proposalKey(raw);
    if (key) proposed.add(key);
    return false;
  };
  for (const m of prose.matchAll(SMALL_MONEY)) if (notProposed(m)) take(m[0], Number(m[1]), false);
  for (const m of prose.matchAll(SMALL_PERCENT)) if (notProposed(m)) take(m[0], Number(m[1]), true);
  for (const m of prose.matchAll(SMALL_COUNT)) {
    const at = m.index ?? 0;
    if (!isBareCount(prose, at, m[0])) continue;
    const n = Number(m[0]);
    const key = `#${n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hits = results.filter(
      (x) =>
        (x.kind === "compute" || x.unit === "count") &&
        [x.value, x.compare_value, ...(x.series ?? []).map((p) => p.value)].some((v) => v === n),
    );
    if (hits.length !== 1) continue;
    const r = hits[0];
    const source = r.kind === "compute" ? "Worked out by Zavi" : String((r.receipt as { source?: unknown }).source ?? "Metric");
    out.push({ ...fromResult(m[0], r, source), ...(usesTypedInput(r) ? { verified: false as const } : {}) });
  }
  return out;
}

const SMALL_COUNT = /(?<![\w\p{Sc}.,:/#\-–—])\d{1,2}(?![\d%:/\-–—]|[.,]\d|[a-zA-Z])/gu;
const MONTH = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;
const MONTH_AFTER = /^\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

export function isBareCount(text: string, at: number, raw: string): boolean {
  const before = text.slice(Math.max(0, at - 12), at);
  const after = text.slice(at + raw.length, at + raw.length + 12);
  if (MONTH.test(before.trimEnd()) && /\s$/.test(before)) return false;
  if (MONTH_AFTER.test(after)) return false;
  if (/^\s?(?:st|nd|rd|th)\b/i.test(after)) return false;
  if (/^\s?[ap]\.?m\b\.?/i.test(after)) return false;
  if (/\b(?:id|no|number|ticket|order|campaign)\s*[:#]?\s*$/i.test(before)) return false;
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  if (/^\s*$/.test(text.slice(lineStart, at)) && /^[.)]/.test(after)) return false;
  return true;
}

export function buildFigureReceipts(
  tenant_id: string,
  run_id: string,
  checked: CheckedFigure[],
  answer = "",
): FigureReceipt[] {
  if (!tenant_id || !run_id) return [];
  try {
    const results = listResults(tenant_id, run_id);
    const out: FigureReceipt[] = smallFigureReceipts(answer, results).slice(0, MAX_FIGURE_RECEIPTS);
    for (const c of checked) {
      if (out.length >= MAX_FIGURE_RECEIPTS) break;
      if (c.kind === "worked_out") {
        out.push({ figure: c.figure, kind: "worked_out", source: "Worked out from pulled numbers", formula: c.formula });
        continue;
      }
      if (c.kind === "reported") {
        out.push({ figure: c.figure, kind: "reported", source: "From you", source_slug: "founder_reported" });
        continue;
      }
      const d = digitsOf(c.figure);
      if (SELF_RECORDING.test(c.tool)) {
        const r = [...results].reverse().find((x) => resultDigits(x).has(d));
        if (r) {
          out.push({ ...fromResult(c.figure, r, c.source), ...(usesTypedInput(r) ? { verified: false as const } : {}) });
          continue;
        }
      }
      if (CODEACT.test(c.tool)) {
        const x = exploratoryFor(tenant_id, run_id, d);
        if (x) {
          out.push({
            figure: c.figure,
            kind: "exploratory",
            source: c.source,
            source_slug: "operator_db",
            tz: x.session_tz ?? undefined,
            fetched_at: x.fetched_at,
            purpose: x.purpose,
            sql: x.sql_reads,
            caveats: x.caveats.length ? x.caveats : undefined,
          });
          continue;
        }
      }
      out.push({ figure: c.figure, kind: "pulled", source: c.source });
    }
    return out;
  } catch {
    return [];
  }
}
