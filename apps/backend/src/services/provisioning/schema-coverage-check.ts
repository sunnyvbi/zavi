import { blankComments } from "./role-grant-check";
import type { PushedFile } from "./app-db-on-demand";

export type SchemaCoverageHit = { file: string; line: number; table: string };

export const SCHEMA_COVERAGE_ERROR_PREFIX = "schema_not_migrated:";

const MIGRATE_PATH = "scripts/migrate.mjs";
const PACKAGE_JSON_PATH = "package.json";
const MIGRATE_RUN_RE = /\bnode\s+(?:\.\/)?scripts\/migrate\.mjs\b/;
const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs)$/i;
const SQL_EXT = /\.sql$/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const IDENT = String.raw`(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?`;
const CREATE_HEAD = String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?(?:RECURSIVE\s+)?(?:TABLE|(?:MATERIALIZED\s+)?VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?`;
const CREATED_RE = new RegExp(String.raw`${CREATE_HEAD}${IDENT}`, "gi");
const DYNAMIC_CREATE_RE = new RegExp(String.raw`${CREATE_HEAD}(?:"?public"?\.)?"?(?:\$\{|["'\`]\s*\+)`, "i");
const ORM_MIGRATIONS_RE = /(?:^|\/)(?:prisma|drizzle)\/|(?:^|\/)drizzle\.config\.[cm]?[jt]s$|(?:^|\/)migrations?\/[^/]+\.mjs$/i;
const RENAMED_RE = new RegExp(String.raw`\bRENAME\s+TO\s+${IDENT}`, "gi");
const STRING_LITERAL_RE = /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const SQL_START_RE = /^[`"']\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\s/;
const SQL_SHAPE_RE =
  /^[`"']\s*(?:SELECT\s[\s\S]*?\bFROM\s|INSERT\s+INTO\s|UPDATE\s+(?:ONLY\s+)?[A-Za-z_"][\w".]*\s+(?:AS\s+)?(?:[A-Za-z_]\w*\s+)?SET\s|DELETE\s+FROM\s|WITH\s+(?:RECURSIVE\s+)?"?[A-Za-z_]\w*"?\s*(?:\([^()]*\)\s*)?AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\()/;
const FROM_FUNCTION_RE = /\b(?:EXTRACT|SUBSTRING|TRIM|POSITION|OVERLAY)\s*\([^()]*\)/gi;
const TABLE_REF_RE =
  /\b(FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?(\s*\(|\.)?/gi;
const CTE_RE =
  /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\([^()]*\)\s*)?AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi;
const NOT_A_TABLE_BEFORE_RE = /\b(?:DISTINCT|FOR|DO|KEY)\s+$/i;
const SQL_WORDS: ReadonlySet<string> = new Set(["set", "select", "lateral", "values", "only", "skip", "of", "nowait"]);
const BUILTIN_TABLES: ReadonlySet<string> = new Set(["_schema_migrations", "_schema_meta", "dual"]);

function tablesCreatedIn(src: string): Set<string> {
  const out = new Set<string>();
  const code = blankComments(src.replace(/\r\n/g, "\n"));
  for (const re of [CREATED_RE, RENAMED_RE]) {
    for (const m of code.matchAll(re)) out.add(m[1].toLowerCase());
  }
  return out;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function tablesQueriedIn(sql: string): string[] {
  const text = sql.replace(FROM_FUNCTION_RE, (m) => " ".repeat(m.length));
  const ctes = new Set([...text.matchAll(CTE_RE)].map((m) => m[1].toLowerCase()));
  const out: string[] = [];
  for (const m of text.matchAll(TABLE_REF_RE)) {
    if (m[3] === "." || (m[3] && m[1].toUpperCase() !== "INTO")) continue;
    const table = m[2].toLowerCase();
    if (SQL_WORDS.has(table) || ctes.has(table) || table.startsWith("pg_")) continue;
    if (NOT_A_TABLE_BEFORE_RE.test(text.slice(0, m.index))) continue;
    out.push(table);
  }
  return out;
}

type SchemaView = { live: PushedFile[]; migrate: PushedFile; schema: PushedFile[] };

function schemaView(files: ReadonlyArray<PushedFile>, repoFiles: ReadonlyArray<PushedFile>): SchemaView | null {
  const pushedPaths = new Set(files.map((f) => f.path));
  const isText = (f: PushedFile) => f.action !== "delete" && f.encoding !== "base64" && typeof f.content === "string";
  const live = files.filter(isText);
  const schema = [...live, ...repoFiles.filter((f) => isText(f) && !pushedPaths.has(f.path))];
  const migrate = schema.find((f) => f.path === MIGRATE_PATH);
  if (!migrate) return null;
  if (DYNAMIC_CREATE_RE.test(blankComments((migrate.content ?? "").replace(/\r\n/g, "\n")))) return null;
  if (schema.some((f) => f.path !== MIGRATE_PATH && ORM_MIGRATIONS_RE.test(f.path))) return null;
  return { live, migrate, schema };
}

function tablesQueriedByCode(live: ReadonlyArray<PushedFile>): SchemaCoverageHit[] {
  const hits: SchemaCoverageHit[] = [];
  for (const f of live) {
    if (f.path === MIGRATE_PATH || !CODE_EXT.test(f.path) || TEST_FILE.test(f.path)) continue;
    const code = blankComments((f.content ?? "").replace(/\r\n/g, "\n"));
    const seen = new Set<string>();
    for (const lit of code.matchAll(STRING_LITERAL_RE)) {
      if (!SQL_START_RE.test(lit[0]) || !SQL_SHAPE_RE.test(lit[0])) continue;
      for (const table of tablesQueriedIn(lit[0].slice(1, -1))) {
        if (BUILTIN_TABLES.has(table) || seen.has(table)) continue;
        seen.add(table);
        hits.push({ file: f.path, line: lineAt(code, lit.index ?? 0), table });
      }
    }
  }
  return hits;
}

export function detectUnmigratedTables(
  files: ReadonlyArray<PushedFile>,
  repoFiles: ReadonlyArray<PushedFile> = [],
): SchemaCoverageHit[] {
  const view = schemaView(files, repoFiles);
  if (!view) return [];
  const created = tablesCreatedIn(view.migrate.content ?? "");
  for (const f of view.schema) {
    if (SQL_EXT.test(f.path)) for (const t of tablesCreatedIn(f.content ?? "")) created.add(t);
  }
  return tablesQueriedByCode(view.live)
    .filter((h) => !created.has(h.table))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function runsMigrateBeforeStart(packageJson: string): boolean {
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return true;
  }
  const runs = (s: unknown, depth: number): boolean => {
    if (typeof s !== "string") return false;
    if (MIGRATE_RUN_RE.test(s)) return true;
    if (depth > 0) return false;
    return [...s.matchAll(/\bnpm run(?:-script)? ([\w:.-]+)/g)].some((m) => runs(scripts[m[1]], depth + 1));
  };
  return [scripts.prestart, scripts.start].some((s) => runs(s, 0));
}

export function detectMigrateNotRunAtStart(
  files: ReadonlyArray<PushedFile>,
  repoFiles: ReadonlyArray<PushedFile> = [],
): SchemaCoverageHit | null {
  const view = schemaView(files, repoFiles);
  if (!view) return null;
  const pkg = view.schema.find((f) => f.path === PACKAGE_JSON_PATH);
  if (!pkg || runsMigrateBeforeStart(pkg.content ?? "")) return null;
  return tablesQueriedByCode(view.live).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)[0] ?? null;
}

export function formatSchemaCoverageError(hits: ReadonlyArray<SchemaCoverageHit>): string {
  const shown = hits.slice(0, 5).map((h) => `${h.file}:${h.line} queries "${h.table}"`);
  const more = hits.length > 5 ? ` (+${hits.length - 5} more)` : "";
  return (
    `${SCHEMA_COVERAGE_ERROR_PREFIX} ${shown.join("; ")}${more}, but scripts/migrate.mjs never creates that table, so the live site answers 500. ` +
    "Fix: append a new MIGRATIONS entry to scripts/migrate.mjs that creates every table the app queries (CREATE TABLE IF NOT EXISTS, FK targets first); never edit a shipped entry."
  );
}

export function assertSchemaCoversQueries(
  files: ReadonlyArray<PushedFile>,
  repoFiles: ReadonlyArray<PushedFile> = [],
): void {
  const hits = detectUnmigratedTables(files, repoFiles);
  if (hits.length > 0) throw new Error(formatSchemaCoverageError(hits));
  const unwired = detectMigrateNotRunAtStart(files, repoFiles);
  if (unwired) {
    throw new Error(
      `${SCHEMA_COVERAGE_ERROR_PREFIX} ${unwired.file}:${unwired.line} queries "${unwired.table}", but package.json never runs scripts/migrate.mjs before the app starts, so the live database has no tables and the site answers 500. ` +
        'Fix: add "prestart": "node scripts/migrate.mjs" to the scripts in package.json.',
    );
  }
}

export type RepoExec = (cmd: string, timeoutMs: number) => Promise<{ stdout: string; exit_code: number }>;

const MAX_BASELINE_SQL_FILES = 200;

function shq(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export async function readSchemaBaseline(
  run: RepoExec,
  repoRoot: string,
  pushed: ReadonlyArray<PushedFile>,
): Promise<PushedFile[]> {
  try {
    const pushedPaths = new Set(pushed.map((f) => f.path));
    const listed = await run(`cd ${shq(repoRoot)} && git ls-files`, 30_000);
    if (listed.exit_code !== 0) return [];
    const paths = listed.stdout
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !pushedPaths.has(p));
    const out: PushedFile[] = [];
    const orm = paths.find((p) => p !== MIGRATE_PATH && ORM_MIGRATIONS_RE.test(p));
    if (orm) out.push({ path: orm, content: "" });
    const toRead = paths.filter((p) => p === MIGRATE_PATH || p === PACKAGE_JSON_PATH || SQL_EXT.test(p));
    if (toRead.length > MAX_BASELINE_SQL_FILES) return [];
    for (const path of toRead) {
      const r = await run(`cd ${shq(repoRoot)} && cat ${shq(path)}`, 30_000);
      if (r.exit_code !== 0) return [];
      out.push({ path, content: r.stdout });
    }
    return out;
  } catch {
    return [];
  }
}
