
import type { Document } from "mongodb";
import type { MongoFacade } from "@/services/data-gateway/session";
import type { OperatorDbCatalog } from "@/services/tools/operator-db/types";
import type { SampleOutcome } from "./sample-sql";

const MAX_SIZED = 10;

const TXN_NAME_RE =
  /^(trips?|bookings?|orders?|reservations?|appointments?|rides?|jobs?|sales?|transactions?|invoices?|checkouts?|purchases?)$/i;

const SAMPLE_DOCS = 60;
const MAX_CANDIDATES = 3;
const MAX_FIELDS_PER_COLLECTION = 45;
const EXAMPLES_PER_FIELD = 4;
const MAX_STATUS_VALUES = 40;

export type FieldSketch = {
  path: string;
  types: string[];
  examples: unknown[];
  numeric_stats?: { min: number; max: number; nonzero_frac: number };
};

export type CollectionSketch = {
  collection: string;
  approx_count: number | null;
  fields: FieldSketch[];
  status_candidates: Array<{ path: string; values: Array<{ value: string; count: number }> }>;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (v instanceof Date) return "date";
  const c = (v as { _bsontype?: string })?._bsontype;
  if (c) return c;
  return typeof v;
}

function safeExample(v: unknown): unknown {
  const t = typeOf(v);
  if (t === "number" || t === "boolean") return v;
  if (t === "Decimal128" || t === "Long" || t === "Int32" || t === "Double") return String(v);
  if (t === "date") return (v as Date).toISOString().slice(0, 10);
  if (t === "string") return (v as string).slice(0, 40);
  if (t === "null" || t === "undefined") return null;
  if (Array.isArray(v)) return `[array:${v.length}]`;
  if (t === "object") return `{obj:${Object.keys(v as object).slice(0, 6).join(",")}}`;
  return `[${t}]`;
}

function isMoneyMagnitude(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function walkFields(doc: Document, into: Map<string, { types: Set<string>; examples: unknown[] }>) {
  for (const [k, v] of Object.entries(doc)) {
    const t = typeOf(v);
    add(into, k, t, v);
    if (t === "object" && v && !(v instanceof Date)) {
      for (const [k2, v2] of Object.entries(v as Document)) {
        if (typeOf(v2) === "object") continue;
        add(into, `${k}.${k2}`, typeOf(v2), v2);
      }
    }
  }
}
function add(
  m: Map<string, { types: Set<string>; examples: unknown[] }>,
  path: string,
  t: string,
  v: unknown,
) {
  let e = m.get(path);
  if (!e) {
    e = { types: new Set(), examples: [] };
    m.set(path, e);
  }
  e.types.add(t);
  if (e.examples.length < EXAMPLES_PER_FIELD) e.examples.push(safeExample(v));
}

const MONEY_HINT = /amount|total|price|fee|cost|payout|gmv|revenue|paid|charge|grand|net|deposit|value|sum/i;
function score(f: FieldSketch, statusPaths: Set<string>): number {
  let s = 0;
  if (f.types.includes("date")) s += 4;
  if (f.numeric_stats) s += 3;
  if (MONEY_HINT.test(f.path)) s += 3;
  if (statusPaths.has(f.path)) s += 2;
  return s;
}

export async function sampleMongoSketches(mongo: MongoFacade, catalog: OperatorDbCatalog): Promise<SampleOutcome> {
  {
    const colls = catalog.tables.map((t) => t.name).filter((n) => !n.startsWith("system."));
    const skipped: string[] = [];

    const named = colls.filter((n) => TXN_NAME_RE.test(n));
    const sized: Array<{ name: string; count: number }> = [];
    for (const n of [...new Set([...named, ...colls])].slice(0, MAX_SIZED)) {
      try {
        sized.push({ name: n, count: await mongo.estimatedDocumentCount(n) });
      } catch {
        sized.push({ name: n, count: 0 });
      }
    }
    sized.sort((a, b) => b.count - a.count);
    const shortlist = [...new Set([...named, ...sized.map((s) => s.name)])].slice(0, MAX_CANDIDATES);

    const sketches: CollectionSketch[] = [];
    for (const coll of shortlist) {
      const visible = [...new Set((catalog.tables.find((t) => t.name === coll)?.columns ?? []).map((c) => c.name.split(".")[0]!))].filter(
        (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n),
      );
      if (visible.length === 0) {
        skipped.push(`${coll}: no visible fields`);
        continue;
      }
      let docs: Document[] = [];
      try {
        docs = (await mongo.aggregate(
          coll,
          [{ $sample: { size: SAMPLE_DOCS } }, { $project: Object.fromEntries(visible.map((f) => [f, 1])) }],
          { maxTimeMS: 6000 },
        )) as Document[];
      } catch (e) {
        skipped.push(
          (e as { code?: string })?.code === "data_access_refused"
            ? `${coll}: refused (${(e as Error).message.slice(0, 200)})`
            : `${coll}: sample failed (${e instanceof Error ? e.name : "Error"})`,
        );
        continue;
      }
      if (docs.length === 0) {
        skipped.push(`${coll}: no documents`);
        continue;
      }

      const fieldMap = new Map<string, { types: Set<string>; examples: unknown[] }>();
      const stringVals = new Map<string, Map<string, number>>();
      for (const d of docs) {
        walkFields(d, fieldMap);
        for (const [k, v] of Object.entries(d)) {
          if (typeof v === "string" && v.length <= 40) {
            let m = stringVals.get(k);
            if (!m) {
              m = new Map();
              stringVals.set(k, m);
            }
            m.set(v, (m.get(v) ?? 0) + 1);
          }
        }
      }

      const fields: FieldSketch[] = [];
      for (const [path, e] of fieldMap) {
        const nums = e.examples.filter((x) => typeof x === "number") as number[];
        const fs: FieldSketch = { path, types: [...e.types], examples: e.examples };
        if (nums.length > 0) {
          const finite = nums.filter(Number.isFinite);
          if (finite.length) {
            fs.numeric_stats = {
              min: Math.min(...finite),
              max: Math.max(...finite),
              nonzero_frac: Math.round((finite.filter(isMoneyMagnitude).length / finite.length) * 100) / 100,
            };
          }
        }
        fields.push(fs);
      }

      const status_candidates: CollectionSketch["status_candidates"] = [];
      for (const [path, m] of stringVals) {
        if (m.size <= MAX_STATUS_VALUES && m.size > 1) {
          status_candidates.push({
            path,
            values: [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })),
          });
        }
      }

      const statusPaths = new Set(status_candidates.map((s) => s.path));
      const ranked = fields.sort((a, b) => score(b, statusPaths) - score(a, statusPaths));
      sketches.push({
        collection: coll,
        approx_count: sized.find((s) => s.name === coll)?.count ?? null,
        fields: ranked.slice(0, MAX_FIELDS_PER_COLLECTION),
        status_candidates,
      });
    }
    return { sketches, skipped };
  }
}
