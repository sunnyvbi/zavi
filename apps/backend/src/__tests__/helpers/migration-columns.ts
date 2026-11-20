import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../../supabase/migrations");

const NOT_A_COLUMN = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude", "like"]);

let cache: string[] | null = null;

function migrationSql(): string[] {
  if (cache) return cache;
  cache = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(/--[^\n]*/g, ""));
  return cache;
}

function tableName(table: string): string {
  return `(?:public\\.)?"?${table}"?`;
}

function bodyAfter(sql: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(openParen + 1, i);
  }
  return "";
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

export function migrationColumns(table: string): Set<string> {
  const cols = new Set<string>();
  let created = false;
  const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${tableName(table)}\\s*\\(`, "gi");
  const alter = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${tableName(table)}\\s([^;]*);`, "gi");
  const drop = new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?${tableName(table)}\\s*(?:cascade\\s*)?;`, "gi");
  for (const sql of migrationSql()) {
    const events: Array<{ at: number; run: () => void }> = [];
    for (const m of sql.matchAll(drop)) events.push({ at: m.index!, run: () => cols.clear() });
    for (const m of sql.matchAll(create)) {
      const body = bodyAfter(sql, m.index! + m[0].length - 1);
      events.push({
        at: m.index!,
        run: () => {
          created = true;
          for (const part of splitTopLevel(body)) {
            const name = part.trim().match(/^"?([a-z_][a-z0-9_]*)"?/i)?.[1]?.toLowerCase();
            if (name && !NOT_A_COLUMN.has(name)) cols.add(name);
          }
        },
      });
    }
    for (const m of sql.matchAll(alter)) {
      const clause = m[1];
      events.push({
        at: m.index!,
        run: () => {
          for (const a of clause.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) cols.add(a[1].toLowerCase());
          for (const d of clause.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) cols.delete(d[1].toLowerCase());
          for (const r of clause.matchAll(/rename\s+column\s+"?([a-z_][a-z0-9_]*)"?\s+to\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
            if (cols.delete(r[1].toLowerCase())) cols.add(r[2].toLowerCase());
          }
        },
      });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.run());
  }
  if (!created) throw new Error(`no create table for ${table} in supabase/migrations`);
  return cols;
}

export function selectedColumns(select: string): string[] {
  return splitTopLevel(select)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*")
    .map((s) => s.replace(/^[a-z_][a-z0-9_]*:/i, "").split(/->>|->|::/)[0].trim().toLowerCase());
}

export function assertKnownColumns(table: string, columns: Iterable<string>): void {
  const known = migrationColumns(table);
  const unknown = [...columns].map((c) => c.split(/->>|->|::/)[0].trim().toLowerCase()).filter((c) => !known.has(c));
  if (unknown.length > 0) throw new Error(`column(s) ${unknown.join(", ")} do not exist on ${table} (supabase/migrations)`);
}
