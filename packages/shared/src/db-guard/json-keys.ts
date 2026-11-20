
export type JsonSampled = "full" | "partial" | "none";

export function isJsonColumnType(dialect: "postgres" | "mysql" | null, type: string | undefined): boolean {
  const t = (type ?? "").trim().toLowerCase();
  if (dialect === "mysql") return t === "json";
  return t === "json" || t === "jsonb";
}

export const MAX_JSON_COLUMNS_SAMPLED = 50;
export const JSON_SAMPLE_ROWS = 200;
export const MAX_JSON_KEYS = 200;
export const MAX_MYSQL_NESTED_KEYS = 30;

const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const myIdent = (s: string) => "`" + s.replace(/`/g, "``") + "`";

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function keyLooksLikeValue(k: string): boolean {
  if (k.length === 0 || k.length > 64) return true;
  if (/[@\s]/.test(k)) return true;
  if (/^[+\d][\d().+-]{5,}$/.test(k)) return true;
  if (/^\d+$/.test(k)) return true;
  if (UUID.test(k)) return true;
  if (/^[0-9a-f]{16,}$/i.test(k)) return true;
  if (/^[A-Za-z0-9_-]{24,}$/.test(k) && /\d/.test(k) && /[A-Za-z]/.test(k)) return true;
  return false;
}

const pgSample = (table: string, column: string) =>
  `(SELECT ${pgIdent(column)}::jsonb AS j FROM ONLY ${pgIdent("public")}.${pgIdent(table)} WHERE ${pgIdent(column)} IS NOT NULL LIMIT ${JSON_SAMPLE_ROWS}) s`;

export function pgJsonShapeSql(table: string, column: string): string {
  return `SELECT count(*)::int AS n,
    count(*) FILTER (WHERE jsonb_typeof(s.j) = 'object')::int AS objs,
    count(*) FILTER (WHERE jsonb_typeof(s.j) = 'array'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.j) x WHERE jsonb_typeof(x) <> 'object'))::int AS obj_arrays
  FROM ${pgSample(table, column)}`;
}

export function pgJsonKeySampleSql(table: string, column: string): string {
  return `SELECT DISTINCT e1.k1 AS k1, e2.k2 AS k2
  FROM ${pgSample(table, column)}
  CROSS JOIN LATERAL (
    SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.j) = 'array' THEN s.j ELSE jsonb_build_array(s.j) END) AS a(x) LIMIT 20
  ) el
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(el.x) = 'object' THEN el.x ELSE '{}'::jsonb END) AS e1(k1, v1)
  LEFT JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(e1.v1) = 'object' THEN e1.v1 ELSE '{}'::jsonb END) AS e2(k2) ON true
  LIMIT ${MAX_JSON_KEYS * 2 + 1}`;
}

const mySample = (table: string, column: string, database: string | null) =>
  `(SELECT ${myIdent(column)} AS j FROM ${database ? `${myIdent(database)}.${myIdent(table)}` : myIdent(table)} WHERE ${myIdent(column)} IS NOT NULL LIMIT ${JSON_SAMPLE_ROWS}) s`;

export function mysqlJsonShapeSql(table: string, column: string, database: string | null): string {
  return `SELECT COUNT(*) AS n, COALESCE(SUM(JSON_TYPE(s.j) = 'OBJECT'), 0) AS objs, 0 AS obj_arrays FROM ${mySample(table, column, database)}`;
}

export function mysqlJsonKeySampleSql(table: string, column: string, database: string | null): string {
  return `SELECT DISTINCT JSON_KEYS(s.j) AS ks FROM ${mySample(table, column, database)} LIMIT ${MAX_JSON_KEYS + 1}`;
}

export function mysqlJsonNestedKeySql(table: string, column: string, database: string | null, key: string): string {
  if (!SAFE_MYSQL_KEY.test(key)) throw new Error("unsafe key");
  return `SELECT DISTINCT JSON_KEYS(s.j, '$."${key}"') AS ks FROM ${mySample(table, column, database)} LIMIT ${MAX_JSON_KEYS + 1}`;
}

export function jsonKeysFromRows(rows: Record<string, unknown>[], prefix = ""): string[] {
  const out = new Set<string>();
  const add = (k: unknown) => {
    if (typeof k === "string") out.add(prefix ? `${prefix}.${k}` : k);
  };
  for (const r of rows) {
    if ("ks" in r) {
      let ks: unknown = r.ks;
      if (typeof ks === "string") {
        try {
          ks = JSON.parse(ks);
        } catch {
          ks = null;
        }
      }
      if (Array.isArray(ks)) ks.forEach(add);
      continue;
    }
    if (typeof r.k1 !== "string") continue;
    add(r.k1);
    if (typeof r.k2 === "string") add(`${r.k1}.${r.k2}`);
  }
  return [...out].sort();
}

export type JsonSampleResult = { json_keys: string[]; json_sampled: JsonSampled; json_map_like: boolean };

export function judgeJsonKeys(paths: string[], truncated: boolean): { json_keys: string[]; json_map_like: boolean } {
  const kept = paths.filter((p) => !p.split(".").some(keyLooksLikeValue));
  return { json_keys: kept.slice(0, MAX_JSON_KEYS), json_map_like: truncated || kept.length !== paths.length || paths.length > MAX_JSON_KEYS };
}

type SampledColumn = { name: string; type: string; json_keys?: string[]; json_sampled?: JsonSampled; json_map_like?: boolean };

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0);
const SAFE_MYSQL_KEY = /^[A-Za-z0-9_-]{1,64}$/;

async function sampleOne(
  dialect: "postgres" | "mysql",
  table: string,
  column: string,
  run: (sql: string) => Promise<Record<string, unknown>[]>,
  database: string | null,
): Promise<JsonSampleResult> {
  const shape = (await run(dialect === "postgres" ? pgJsonShapeSql(table, column) : mysqlJsonShapeSql(table, column, database)))[0] ?? {};
  const n = num(shape.n);
  if (n === 0) return { json_keys: [], json_sampled: "none", json_map_like: false };
  let partial = num(shape.objs) + num(shape.obj_arrays) !== n;
  if (dialect === "postgres") {
    const rows = await run(pgJsonKeySampleSql(table, column));
    const j = judgeJsonKeys(jsonKeysFromRows(rows), rows.length > MAX_JSON_KEYS * 2);
    return { ...j, json_sampled: partial ? "partial" : "full" };
  }
  const topRows = await run(mysqlJsonKeySampleSql(table, column, database));
  const top = jsonKeysFromRows(topRows);
  let truncated = topRows.length > MAX_JSON_KEYS;
  const paths = [...top];
  const nestable = top.filter((k) => SAFE_MYSQL_KEY.test(k));
  if (nestable.length !== top.length || nestable.length > MAX_MYSQL_NESTED_KEYS) partial = true;
  for (const k of nestable.slice(0, MAX_MYSQL_NESTED_KEYS)) {
    const rows = await run(mysqlJsonNestedKeySql(table, column, database, k));
    if (rows.length > MAX_JSON_KEYS) truncated = true;
    paths.push(...jsonKeysFromRows(rows, k));
  }
  const j = judgeJsonKeys([...new Set(paths)].sort(), truncated);
  return { ...j, json_sampled: partial ? "partial" : "full" };
}

export async function sampleJsonKeys(
  dialect: "postgres" | "mysql",
  tables: { name: string; columns: SampledColumn[] }[],
  run: (sql: string) => Promise<Record<string, unknown>[]>,
  opts: { deadlineAt: number; database?: string | null },
): Promise<void> {
  let sampled = 0;
  for (const t of tables) {
    for (const c of t.columns) {
      if (!isJsonColumnType(dialect, c.type)) continue;
      c.json_sampled = "none";
      if (sampled >= MAX_JSON_COLUMNS_SAMPLED || Date.now() > opts.deadlineAt) continue;
      sampled++;
      try {
        if (dialect === "postgres") await run("SAVEPOINT zavi_json_keys");
        const r = await sampleOne(dialect, t.name, c.name, run, opts.database ?? null);
        if (dialect === "postgres") await run("RELEASE SAVEPOINT zavi_json_keys");
        c.json_sampled = r.json_sampled;
        if (r.json_keys.length > 0) c.json_keys = r.json_keys;
        if (r.json_map_like) c.json_map_like = true;
      } catch {
        if (dialect === "postgres") await run("ROLLBACK TO SAVEPOINT zavi_json_keys").catch(() => undefined);
        c.json_sampled = "none";
        delete c.json_keys;
        delete c.json_map_like;
      }
    }
  }
}
