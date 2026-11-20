import { JSON_SAMPLE_ROWS, MAX_JSON_COLUMNS_SAMPLED, MAX_JSON_KEYS, judgeJsonKeys, type JsonSampled } from "./json-keys";

export type StructuredClass = "json" | "hstore" | "composite" | "unknown" | null;

export function structuredClass(type: string | undefined): StructuredClass {
  const t = (type ?? "").trim().toLowerCase();
  if (t === "json" || t === "jsonb") return "json";
  if (t === "hstore") return "hstore";
  if (/^composite\b/.test(t)) return "composite";
  if (/^user-defined\b/.test(t)) return "unknown";
  return null;
}

const citextExt = (alias: string) => `EXISTS (SELECT 1 FROM pg_depend xd JOIN pg_extension xe ON xe.oid = xd.refobjid
         WHERE xd.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND xd.objid = ${alias}.oid
           AND xd.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND xd.deptype = 'e' AND xe.extname = 'citext')`;

export const PG_COLUMNS_SQL = `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.udt_name,
       t.typtype, tn.nspname AS type_schema, et.typtype AS elem_typtype, et.typname AS elem_name, etn.nspname AS elem_schema,
       ebt.typtype AS elem_base_typtype, ebt.typname AS elem_base_name, ebtn.nspname AS elem_base_schema,
       ${citextExt("t")} AS type_citext_ext, ${citextExt("et")} AS elem_citext_ext, ${citextExt("ebt")} AS elem_base_citext_ext
  FROM information_schema.columns c
  LEFT JOIN pg_namespace tn ON tn.nspname = c.udt_schema
  LEFT JOIN pg_type t ON t.typname = c.udt_name AND t.typnamespace = tn.oid
  LEFT JOIN pg_type et ON et.oid = t.typelem AND c.data_type = 'ARRAY'
  LEFT JOIN pg_namespace etn ON etn.oid = et.typnamespace
  LEFT JOIN pg_type ebt ON ebt.oid = et.typbasetype AND et.typtype = 'd'
  LEFT JOIN pg_namespace ebtn ON ebtn.oid = ebt.typnamespace
 WHERE c.table_schema = 'public' AND c.table_name = ANY($1::text[])
 ORDER BY c.table_name, c.ordinal_position`;

export type PgColumnRow = {
  data_type: string;
  udt_name?: string | null;
  typtype?: string | null;
  type_schema?: string | null;
  elem_typtype?: string | null;
  elem_name?: string | null;
  elem_schema?: string | null;
  elem_base_typtype?: string | null;
  elem_base_name?: string | null;
  elem_base_schema?: string | null;
  type_citext_ext?: boolean | null;
  elem_citext_ext?: boolean | null;
  elem_base_citext_ext?: boolean | null;
};

function scalarLike(typtype: string | null | undefined, name: string | null | undefined, schema: string | null | undefined, citextExt?: boolean | null): boolean {
  const n = (name ?? "").toLowerCase();
  if (typtype === "e") return true;
  if (n === "citext" && typtype === "b" && citextExt === true) return true;
  if (schema === "pg_catalog" && (typtype === "b" || typtype === "r" || typtype === "m")) return !/^_?(json|jsonb)$/.test(n);
  return false;
}

const label = (s: string | null | undefined) => (s ?? "").slice(0, 63);

export function pgColumnType(row: PgColumnRow): string {
  const dt = row.data_type;
  if (dt === "ARRAY") {
    if (row.elem_name == null || scalarLike(row.elem_typtype, row.elem_name, row.elem_schema, row.elem_citext_ext)) return dt;
    if (row.elem_typtype === "d" && scalarLike(row.elem_base_typtype, row.elem_base_name, row.elem_base_schema, row.elem_base_citext_ext)) return dt;
    return `USER-DEFINED (${label(row.elem_name)}[])`;
  }
  if (dt !== "USER-DEFINED") return dt;
  const udt = (row.udt_name ?? "").toLowerCase();
  if (udt === "hstore" && row.typtype === "b") return "hstore";
  if (udt === "citext" && row.typtype === "b" && row.type_citext_ext === true) return "citext";
  if (row.typtype === "e") return `enum (${label(row.udt_name)})`;
  if (row.typtype === "c") return `composite (${label(row.udt_name)})`;
  return `USER-DEFINED (${label(row.udt_name) || "unknown"})`;
}

const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export const PG_SKEYS_SCHEMA_SQL = `SELECT pn.nspname AS schema, tn.nspname AS type_schema
  FROM pg_extension e
  JOIN pg_depend pd ON pd.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND pd.refobjid = e.oid
                   AND pd.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND pd.deptype = 'e'
  JOIN pg_proc p ON p.oid = pd.objid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace
  JOIN pg_type t ON t.oid = p.proargtypes[0]
  JOIN pg_namespace tn ON tn.oid = t.typnamespace
  JOIN pg_depend td ON td.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND td.refobjid = e.oid
                   AND td.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND td.objid = t.oid AND td.deptype = 'e'
 WHERE e.extname = 'hstore' AND p.proname = 'skeys' AND p.pronargs = 1 AND t.typname = 'hstore'
   AND p.pronamespace = e.extnamespace AND t.typnamespace = e.extnamespace
   AND p.proretset AND p.prorettype = 'pg_catalog.text'::pg_catalog.regtype
 LIMIT 1`;

const hstoreSample = (table: string, column: string) =>
  `(SELECT ${pgIdent(column)} AS h FROM ONLY ${pgIdent("public")}.${pgIdent(table)} WHERE ${pgIdent(column)} IS NOT NULL LIMIT ${JSON_SAMPLE_ROWS}) s`;

export function pgHstoreCountSql(table: string, column: string): string {
  return `SELECT count(*)::int AS n FROM ${hstoreSample(table, column)}`;
}

export function pgHstoreKeySampleSql(table: string, column: string, skeysSchema: string): string {
  return `SELECT DISTINCT k.k AS k FROM ${hstoreSample(table, column)} CROSS JOIN LATERAL ${pgIdent(skeysSchema)}.skeys(s.h) AS k(k) LIMIT ${MAX_JSON_KEYS + 1}`;
}

export const PG_COMPOSITE_ATTRS_SQL = `SELECT n.nspname AS type_schema, t.typname AS type_name, a.attname AS attname,
       at.typtype AS att_typtype, at.typname AS att_typname, atn.nspname AS att_schema,
       bt.typtype AS base_typtype, bt.typname AS base_typname, btn.nspname AS base_schema,
       ${citextExt("at")} AS att_citext_ext, ${citextExt("bt")} AS base_citext_ext
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_attribute a ON a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type at ON at.oid = a.atttypid
  JOIN pg_namespace atn ON atn.oid = at.typnamespace
  LEFT JOIN pg_type bt ON bt.oid = at.typbasetype AND at.typtype = 'd'
  LEFT JOIN pg_namespace btn ON btn.oid = bt.typnamespace
 WHERE t.typtype = 'c' AND (n.nspname || '.' || t.typname) = ANY($1::text[])
 ORDER BY n.nspname, t.typname, a.attnum`;

type CompositeAttrRow = {
  type_schema: string;
  type_name: string;
  attname: string;
  att_typtype: string | null;
  att_typname: string | null;
  att_schema: string | null;
  base_typtype: string | null;
  base_typname: string | null;
  base_schema: string | null;
  att_citext_ext?: boolean | null;
  base_citext_ext?: boolean | null;
};

function attrScalar(r: CompositeAttrRow): boolean {
  if (r.att_typtype === "d") return scalarLike(r.base_typtype, r.base_typname, r.base_schema, r.base_citext_ext);
  return scalarLike(r.att_typtype, r.att_typname, r.att_schema, r.att_citext_ext);
}

export type StructuredColumn = {
  name: string;
  type: string;
  json_keys?: string[];
  json_sampled?: JsonSampled;
  json_map_like?: boolean;
};

export type PgTypeRef = { table: string; column: string; schema: string | null; name: string | null };

type Run = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function guarded<T>(run: Run, fn: () => Promise<T>): Promise<T> {
  await run("SAVEPOINT zavi_pg_structured");
  try {
    const out = await fn();
    await run("RELEASE SAVEPOINT zavi_pg_structured");
    return out;
  } catch (e) {
    await run("ROLLBACK TO SAVEPOINT zavi_pg_structured").catch(() => undefined);
    throw e;
  }
}

export async function annotatePgStructuredColumns(
  tables: { name: string; columns: StructuredColumn[] }[],
  types: PgTypeRef[],
  run: Run,
  opts: { deadlineAt: number },
): Promise<void> {
  const typeOf = new Map(types.map((r) => [`${r.table}\u0000${r.column}`, r]));
  const hstoreCols: { table: string; col: StructuredColumn; schema: string | null }[] = [];
  const compositeCols: { col: StructuredColumn; key: string | null }[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const cls = structuredClass(c.type);
      if (cls === "hstore") {
        c.json_sampled = "none";
        delete c.json_keys;
        delete c.json_map_like;
        hstoreCols.push({ table: t.name, col: c, schema: typeOf.get(`${t.name}\u0000${c.name}`)?.schema ?? null });
      } else if (cls === "composite") {
        c.json_sampled = "none";
        delete c.json_keys;
        delete c.json_map_like;
        const ref = typeOf.get(`${t.name}\u0000${c.name}`);
        compositeCols.push({ col: c, key: ref?.schema && ref.name ? `${ref.schema}.${ref.name}` : null });
      }
    }
  }

  const keys = [...new Set(compositeCols.map((c) => c.key).filter((k): k is string => k !== null))];
  if (keys.length > 0 && Date.now() <= opts.deadlineAt) {
    try {
      const rows = (await guarded(run, () => run(PG_COMPOSITE_ATTRS_SQL, [keys]))) as unknown as CompositeAttrRow[];
      const byType = new Map<string, CompositeAttrRow[]>();
      for (const r of rows) {
        const k = `${r.type_schema}.${r.type_name}`;
        byType.set(k, [...(byType.get(k) ?? []), r]);
      }
      for (const { col, key } of compositeCols) {
        const attrs = key ? byType.get(key) : undefined;
        if (!attrs || attrs.length === 0) continue;
        const j = judgeJsonKeys([...new Set(attrs.map((a) => a.attname))].sort(), false);
        col.json_sampled = attrs.every(attrScalar) ? "full" : "partial";
        if (j.json_keys.length > 0) col.json_keys = j.json_keys;
        if (j.json_map_like) col.json_map_like = true;
      }
    } catch {
    }
  }

  if (hstoreCols.length === 0 || Date.now() > opts.deadlineAt) return;
  let schema: string | null = null;
  let typeSchema: string | null = null;
  try {
    const r = await guarded(run, () => run(PG_SKEYS_SCHEMA_SQL));
    schema = typeof r[0]?.schema === "string" ? (r[0].schema as string) : null;
    typeSchema = typeof r[0]?.type_schema === "string" ? (r[0].type_schema as string) : null;
  } catch {
    schema = null;
  }
  if (schema === null || typeSchema === null) return;
  let sampled = 0;
  for (const { table, col, schema: colTypeSchema } of hstoreCols) {
    if (colTypeSchema !== typeSchema) continue;
    if (sampled >= MAX_JSON_COLUMNS_SAMPLED || Date.now() > opts.deadlineAt) break;
    sampled++;
    try {
      const out = await guarded(run, async () => {
        const n = Number((await run(pgHstoreCountSql(table, col.name)))[0]?.n ?? 0);
        if (!Number.isFinite(n) || n === 0) return null;
        const rows = await run(pgHstoreKeySampleSql(table, col.name, schema!));
        const names = [...new Set(rows.map((r) => r.k).filter((k): k is string => typeof k === "string"))].sort();
        return judgeJsonKeys(names, rows.length > MAX_JSON_KEYS);
      });
      if (out === null) continue;
      col.json_sampled = "full";
      if (out.json_keys.length > 0) col.json_keys = out.json_keys;
      if (out.json_map_like) col.json_map_like = true;
    } catch {
      col.json_sampled = "none";
      delete col.json_keys;
      delete col.json_map_like;
    }
  }
}
