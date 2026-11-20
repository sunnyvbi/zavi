
import type { CanonicalMap } from "./mapping";

export type ProbeKind = "date" | "numeric" | "status" | "reason" | "presence";

export type FieldProbe = {
  role: string;
  field_key: string;
  field: string;
  kind: ProbeKind;
  ok: boolean;
  coverage: number;
  reason?: string;
  distinct?: number;
};

const KIND_BY_KEY: Record<string, ProbeKind> = {
  created_at_field: "date",
  gmv_proxy_field: "numeric",
  status_field: "status",
  reason_field: "reason",
};

const REASON_MAX_DISTINCT = 40;
const REASON_MAX_AVG_LEN = 60;
const DATE_MIN_COVERAGE = 0.05;
const NUMERIC_MIN_COVERAGE = 0.05;
const PRESENCE_MIN_COVERAGE = 0.05;

function isScalarDate(v: unknown): boolean {
  if (v == null || Array.isArray(v) || typeof v === "object") return false;
  if (v instanceof Date) return !isNaN(v.getTime());
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    return ms > 978307200000 && ms < 4102444800000;
  }
  if (typeof v === "string") {
    if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) return false;
    const t = Date.parse(v);
    return !isNaN(t) && t > 978307200000 && t < 4102444800000;
  }
  return false;
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const ext = o.$numberDecimal ?? o.$numberDouble ?? o.$numberLong ?? o.$numberInt;
    if (typeof ext === "string" || typeof ext === "number") {
      const n = Number(ext);
      return isFinite(n) ? n : null;
    }
  }
  return null;
}

function isPositiveNumber(v: unknown): boolean {
  const n = coerceNumber(v);
  return n !== null && n > 0;
}

function isPresent(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function isScalarPresent(v: unknown): boolean {
  return (typeof v === "string" && v.trim().length > 0)
    || typeof v === "number"
    || typeof v === "boolean";
}

function kindForKey(key: string): ProbeKind {
  return KIND_BY_KEY[key] ?? "presence";
}

function probeOne(
  role: string,
  field_key: string,
  field: string,
  sample: Record<string, unknown>[],
): FieldProbe {
  const kind = kindForKey(field_key);
  const values = sample.map((r) => r?.[field]);
  const n = values.length || 1;

  if (kind === "date") {
    const hit = values.filter(isScalarDate).length;
    const coverage = hit / n;
    return {
      role, field_key, field, kind,
      ok: coverage >= DATE_MIN_COVERAGE,
      coverage,
      reason: coverage >= DATE_MIN_COVERAGE ? undefined
        : "date field has no parseable scalar-timestamp rows in the sample (mapped column may be an array / non-date)",
    };
  }

  if (kind === "numeric") {
    const hit = values.filter(isPositiveNumber).length;
    const coverage = hit / n;
    return {
      role, field_key, field, kind,
      ok: coverage >= NUMERIC_MIN_COVERAGE,
      coverage,
      reason: coverage >= NUMERIC_MIN_COVERAGE ? undefined
        : "amount field has no positive-numeric rows in the sample (mapped column may not be a monetary value)",
    };
  }

  if (kind === "status" || kind === "reason") {
    const present = values.filter(isScalarPresent);
    const coverage = present.length / n;
    const distinctSet = new Set(present.map((v) => String(v).trim().toLowerCase()));
    const distinct = distinctSet.size;
    const avgLen = present.length
      ? present.reduce((a: number, v) => a + String(v).length, 0) / present.length
      : 0;

    if (kind === "status") {
      const ok = present.length > 0 && distinct >= 1;
      return {
        role, field_key, field, kind, ok, coverage, distinct,
        reason: ok ? undefined : "status field is empty in the sample (no terminal states to key cancel-leak on)",
      };
    }
    const enumLike = present.length > 0 && distinct >= 1 && distinct <= REASON_MAX_DISTINCT;
    const notFreeText = avgLen <= REASON_MAX_AVG_LEN;
    const ok = enumLike && notFreeText;
    return {
      role, field_key, field, kind, ok, coverage, distinct,
      reason: ok ? undefined
        : !enumLike ? "reason field is high-cardinality (not enum-like) — cancel-leak by reason cannot be aggregated safely"
        : "reason field looks like free text (long average length) — not a reason enum",
    };
  }

  const hit = values.filter(isPresent).length;
  const coverage = hit / n;
  return {
    role, field_key, field, kind: "presence",
    ok: coverage >= PRESENCE_MIN_COVERAGE,
    coverage,
    reason: coverage >= PRESENCE_MIN_COVERAGE ? undefined : "mapped field is empty across the sample",
  };
}

const COLUMN_REF_KEYS = new Set([
  "field", "id_field", "created_at_field", "geo_field", "category_field",
  "gmv_proxy_field", "listing_ref_field", "status_field", "reason_field",
]);

export function probeRoleFields(
  role: string,
  entry: Record<string, unknown>,
  sample: Record<string, unknown>[],
): FieldProbe[] {
  const out: FieldProbe[] = [];
  for (const [key, val] of Object.entries(entry)) {
    if (!COLUMN_REF_KEYS.has(key)) continue;
    if (typeof val !== "string" || val.trim().length === 0) continue;
    out.push(probeOne(role, key, val, sample));
  }
  return out;
}

export type TableSampler = (table: string) => Promise<Record<string, unknown>[] | null>;

export async function probeMappedFields(
  map: CanonicalMap,
  sampler: TableSampler,
): Promise<FieldProbe[]> {
  const out: FieldProbe[] = [];
  const cache = new Map<string, Record<string, unknown>[] | null>();
  for (const [role, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    const table = (entry as { table?: string }).table;
    if (!table) continue;
    if (!cache.has(table)) {
      try {
        cache.set(table, await sampler(table));
      } catch {
        cache.set(table, null);
      }
    }
    const sample = cache.get(table);
    if (!sample || sample.length === 0) {
      out.push({
        role, field_key: "table", field: table, kind: "presence",
        ok: false, coverage: 0, reason: "sample_unavailable",
      });
      continue;
    }
    out.push(...probeRoleFields(role, entry as Record<string, unknown>, sample));
  }
  return out;
}
