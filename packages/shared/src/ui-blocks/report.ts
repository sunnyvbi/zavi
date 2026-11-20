
import type { UiBlock } from "./schema";

type Cell = string | number | null;

export type Measure = {
  name: string;
  values: (number | null)[];
  display: string[];
  kind: "percent" | "money" | "count";
  formula?: string;
};

export type Kpi = {
  name: string;
  value: string;
  change: string | null;
  direction: "up" | "down" | "flat" | null;
  period: string | null;
  previous: string | null;
};

export type ReportModel = {
  title: string;
  dimension: string | null;
  labels: string[];
  measures: Measure[];
  kpis: Kpi[];
  columns: string[];
  rows: string[][];
  note: string | null;
};

const NUMBER = /^[-+]?\$?\s?\d[\d,]*(?:\.\d+)?\s?%?$/;

export function parseCell(v: Cell): { value: number | null; kind: Measure["kind"] | null } {
  if (typeof v === "number") return { value: v, kind: "count" };
  if (typeof v !== "string" || !NUMBER.test(v.trim())) return { value: null, kind: null };
  const t = v.trim();
  const n = Number(t.replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(n)) return { value: null, kind: null };
  return { value: n, kind: t.includes("%") ? "percent" : t.includes("$") ? "money" : "count" };
}

const show = (v: Cell) => (v === null || v === undefined ? "" : String(v));

const cleanLabel = (s: string) => s.replace(/\*+$/, "").trim();

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function isColumnList(title: string, columns: string[]): boolean {
  return title === columns.join(" · ");
}

function fmtCount(n: number, kind: Measure["kind"]): string {
  const s = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return kind === "money" ? `$${s}` : s;
}

function kpiFor(m: Measure, labels: string[]): Kpi | null {
  const idx = m.values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (idx.length === 0) return null;
  const last = idx[idx.length - 1];
  const prev = idx.length > 1 ? idx[idx.length - 2] : null;
  const period = labels[last] ? cleanLabel(labels[last]) : null;
  if (prev === null) {
    return { name: m.name, value: m.display[last], change: null, direction: null, period, previous: null };
  }
  const cur = m.values[last] as number;
  const before = m.values[prev] as number;
  const previous = labels[prev] ? cleanLabel(labels[prev]) : null;
  let delta: number;
  let text: string;
  if (m.kind === "percent") {
    delta = Math.round((cur - before) * 10) / 10;
    text = `${Math.abs(delta).toLocaleString("en-US", { maximumFractionDigits: 1 })} pts`;
  } else if (before === 0) {
    delta = cur - before;
    text = fmtCount(delta, m.kind);
  } else {
    delta = Math.round(((cur - before) / Math.abs(before)) * 1000) / 10;
    text = `${Math.abs(delta).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const word = direction === "up" ? "Up" : direction === "down" ? "Down" : "Flat";
  return {
    name: m.name,
    value: m.display[last],
    change: direction === "flat" ? "Flat" : `${word} ${text}`,
    direction,
    period,
    previous,
  };
}

export function buildReport(block: UiBlock): ReportModel | null {
  let columns: string[];
  let raw: Cell[][];
  let note: string | null = null;
  let title = block.title;

  if (block.kind === "table") {
    columns = block.columns;
    raw = block.rows;
    note = block.note ?? null;
  } else if (block.kind === "chart") {
    columns = ["", block.title];
    raw = block.series.map((p) => [p.label, block.unit === "%" ? `${p.value}%` : block.unit === "$" ? `$${p.value}` : p.value]);
  } else if (block.kind === "kpi") {
    columns = ["Metric", "Value"];
    raw = block.items.map((k) => [k.label, typeof k.value === "number" ? k.value : k.value]);
  } else {
    return null;
  }

  const rows = raw.map((r) => columns.map((_, j) => show(r[j] ?? null)));
  const numeric = columns.map((_, j) => {
    const parsed = raw.map((r) => parseCell(r[j] ?? null));
    const filled = raw.filter((r) => show(r[j] ?? null) !== "");
    return filled.length > 0 && parsed.every((p, i) => p.value !== null || show(raw[i][j] ?? null) === "");
  });
  const dimIdx = block.kind === "table" ? (columns.length > 1 ? 0 : -1) : numeric.findIndex((n) => !n);
  const labels = dimIdx >= 0 ? rows.map((r) => r[dimIdx]) : rows.map((_, i) => `Row ${i + 1}`);
  const measures: Measure[] = columns
    .map((name, j) => ({ name, j }))
    .filter(({ j }) => block.kind !== "kpi" && numeric[j] && j !== dimIdx)
    .map(({ name, j }) => {
      const parsed = raw.map((r) => parseCell(r[j] ?? null));
      const kinds = parsed.map((p) => p.kind).filter(Boolean);
      const kind: Measure["kind"] = kinds.includes("percent") ? "percent" : kinds.includes("money") ? "money" : "count";
      return { name, values: parsed.map((p) => p.value), display: rows.map((r) => r[j]), kind };
    });

  const dimension = dimIdx >= 0 ? columns[dimIdx] || null : null;
  if (block.kind === "table" && isColumnList(title, columns) && measures.length > 0) {
    title = dimension
      ? `${joinNames(measures.map((m) => m.name))} by ${dimension.toLowerCase()}`
      : joinNames(measures.map((m) => m.name));
  }

  const kpis = block.kind === "kpi"
    ? block.items.map((k) => ({
        name: k.label,
        value: typeof k.value === "number" ? k.value.toLocaleString("en-US") : k.value,
        change: k.delta ?? null,
        direction: (k.tone ?? null) as Kpi["direction"],
        period: null,
        previous: null,
      }))
    :
      isTimeSeries(labels) || labels.length === 1
      ? measures.slice(0, 4).map((m) => kpiFor(m, labels)).filter((k): k is Kpi => k !== null)
      : [];

  explainRates(measures);
  return { title, dimension, labels, measures, kpis, columns, rows, note };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function periodKey(label: string): number | null {
  const t = cleanLabel(label).toLowerCase();
  const iso = t.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (iso) return Number(iso[1]) * 400 + Number(iso[2]) * 32 + Number(iso[3] ?? 0);
  const q = t.match(/^q([1-4])\s*'?(\d{2,4})?$/);
  if (q) return (q[2] ? Number(q[2]) * 10 : 0) + Number(q[1]);
  const m = MONTHS.findIndex((mo) => t.startsWith(mo));
  const md = t.match(/^[a-z]+\.?\s+(\d{1,2})$/);
  if (m >= 0 && md && Number(md[1]) <= 31) return m * 32 + Number(md[1]);
  if (m >= 0 && /^[a-z]+\.?(\s+'\d{2}|\s+\d{4})?$/.test(t)) {
    const y = t.match(/'?(\d{2}|\d{4})$/)?.[1];
    return (y ? Number(y.length === 2 ? `20${y}` : y) * 12 : 0) + m;
  }
  const y = t.match(/^(19|20)\d\d$/);
  if (y) return Number(t);
  const w = t.match(/^(?:week|wk|w)\s*(\d{1,2})$/);
  if (w) return Number(w[1]);
  return null;
}

export function isTimeSeries(labels: string[]): boolean {
  if (labels.length < 2) return false;
  const keys = labels.map(periodKey);
  if (keys.some((k) => k === null)) return false;
  return keys.every((k, i) => i === 0 || (k as number) > (keys[i - 1] as number));
}

export type ReportSources = {
  summary: string;
  pulled: string[];
  checked: string[];
  missing: string | null;
};

export function parseSources(sources: string | null): ReportSources | null {
  if (!sources) return null;
  const lines = sources.split("\n").map((l) => l.trim()).filter(Boolean);
  const [first, ...rest] = lines;
  const summary = first.replace(/^\*\*(Sources|Where these numbers came from)\.\*\*\s*/, "");
  const pulled = rest.filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s/, ""));
  const checkedLine = rest.find((l) => l.startsWith("Checks out against those:"));
  const checked = checkedLine
    ? checkedLine.replace("Checks out against those:", "").split(" · ").map((s) => s.trim()).filter(Boolean)
    : [];
  const missing =
    rest.find((l) => l.startsWith("Not in this run's data:") || l.startsWith("No pull in this run returned")) ?? null;
  return { summary, pulled, checked, missing };
}

export function toCsv(columns: string[], rows: string[][]): string {
  const safe = (s: string) => (/^\s*[=+\-@\t\r]/.test(s) && !NUMBER.test(s.trim()) ? `'${s}` : s);
  const esc = (raw: string) => {
    const s = safe(raw);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

export function explainRates(measures: Measure[]): void {
  for (const rate of measures) {
    if (rate.kind !== "percent") continue;
    const decimals = Math.max(0, ...rate.display.map((d) => d.match(/\.(\d+)/)?.[1].length ?? 0));
    const round = (x: number) => Math.round(x * 10 ** decimals) / 10 ** decimals;
    const rows = rate.values.map((v, i) => i).filter((i) => rate.values[i] !== null);
    if (rows.length === 0) continue;
    const found: string[] = [];
    for (const top of measures) {
      for (const bottom of measures) {
        if (top === rate || bottom === rate || top === bottom) continue;
        if (top.kind === "percent" || bottom.kind === "percent") continue;
        if (top.kind !== bottom.kind) continue;
        const holds = rows.every((i) => {
          const a = top.values[i];
          const b = bottom.values[i];
          return a !== null && b !== null && b > 0 && round((a / b) * 100) === round(rate.values[i] as number);
        });
        if (holds) found.push(`${top.name} ÷ ${bottom.name}`);
      }
    }
    if (found.length === 1) rate.formula = found[0];
  }
}

export const SOURCES_HEADERS = ["**Sources.**", "**Where these numbers came from.**"];

export type SplitSources = { body: string; sources: string | null };

export function splitSources(text: string): SplitSources {
  let at = -1;
  let header = "";
  for (const h of SOURCES_HEADERS) {
    const i = text.lastIndexOf(`---\n${h}`);
    if (i > at && (i === 0 || text[i - 1] === "\n")) {
      at = i;
      header = h;
    }
  }
  if (at < 0) return { body: text, sources: null };
  const sources = text.slice(at + 4).trim();
  if (!sources.startsWith(header)) return { body: text, sources: null };
  return { body: text.slice(0, at).trimEnd(), sources };
}

