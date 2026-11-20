import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "../../../../../supabase/migrations");

const RLS_EXEMPT: Record<string, string> = {};

interface ParsedSchema {
  tenantTables: Set<string>;
  rlsEnabled: Set<string>;
  allTables: Set<string>;
}

function normalizeTableName(raw: string): string {
  return raw
    .trim()
    .replace(/^public\./i, "")
    .replace(/"/g, "")
    .toLowerCase();
}

function extractCreateTableBody(sql: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return sql.slice(openParenIdx + 1, i);
    }
  }
  return "";
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function maskStringLiterals(sql: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inStr) {
      if (ch === "'") {
        inStr = true;
        out += "'";
      } else {
        out += ch;
      }
    } else {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += "  ";
          i++;
        } else {
          inStr = false;
          out += "'";
        }
      } else {
        out += " ";
      }
    }
  }
  return out;
}

function parseAllMigrations(): ParsedSchema {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const tenantTables = new Set<string>();
  const rlsEnabled = new Set<string>();
  const allTables = new Set<string>();

  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?((?:public\.)?"?[a-z0-9_]+"?)\s*\(/gi;
  const enableRlsRe =
    /alter\s+table\s+(?:only\s+)?((?:public\.)?"?[a-z0-9_]+"?)\s+enable\s+row\s+level\s+security/gi;
  const addTenantColRe =
    /alter\s+table\s+(?:only\s+)?((?:public\.)?"?[a-z0-9_]+"?)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?tenant_id\b/gi;

  for (const file of files) {
    const sql = maskStringLiterals(
      stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), "utf-8")),
    );

    let m: RegExpExecArray | null;
    createRe.lastIndex = 0;
    while ((m = createRe.exec(sql)) !== null) {
      const name = normalizeTableName(m[1]);
      allTables.add(name);
      const openIdx = m.index + m[0].length - 1;
      const body = extractCreateTableBody(sql, openIdx);
      if (/(^|,)\s*"?tenant_id"?\s+[a-z]/i.test(body)) {
        tenantTables.add(name);
      }
    }

    addTenantColRe.lastIndex = 0;
    while ((m = addTenantColRe.exec(sql)) !== null) {
      tenantTables.add(normalizeTableName(m[1]));
    }

    enableRlsRe.lastIndex = 0;
    while ((m = enableRlsRe.exec(sql)) !== null) {
      rlsEnabled.add(normalizeTableName(m[1]));
    }
  }

  return { tenantTables, rlsEnabled, allTables };
}

describe("cross-tenant RLS coverage — every tenant_id table must enable RLS (static)", () => {
  const schema = parseAllMigrations();

  it("parses a non-trivial schema (sanity — the parser actually sees the migrations)", () => {
    expect(schema.allTables.size).toBeGreaterThan(80);
    expect(schema.tenantTables.size).toBeGreaterThan(40);
  });

  it("the parser correctly identifies a known tenant_id table and a known RLS-enabled table", () => {
    expect(schema.tenantTables.has("tenant_users")).toBe(true);
    expect(schema.rlsEnabled.has("tenant_users")).toBe(true);
  });

  it("every table with a tenant_id column has ENABLE ROW LEVEL SECURITY (or an allowlisted exemption)", () => {
    const missing: string[] = [];
    for (const t of schema.tenantTables) {
      if (schema.rlsEnabled.has(t)) continue;
      if (t in RLS_EXEMPT) continue;
      missing.push(t);
    }
    missing.sort();

    expect(
      missing,
      `CROSS-TENANT LEAK RISK — these tables declare a tenant_id column but never ` +
        `ENABLE ROW LEVEL SECURITY in any migration. Without RLS the authed/anon ` +
        `PostgREST role can read EVERY tenant's rows (Asana-MCP-class leak).\n\n` +
        `Fix one of:\n` +
        `  1. Add  ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;  + a tenant-scoped ` +
        `policy in the table's migration (preferred).\n` +
        `  2. If the table is intentionally service-role-only (never read by the ` +
        `authed role), add it to RLS_EXEMPT in this file WITH a justification ` +
        `(a reviewer will see it in the diff).\n\n` +
        `Tables missing RLS:\n` +
        missing.map((t) => `  - ${t}`).join("\n"),
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (every exempt table still exists and still lacks RLS)", () => {
    const stale: string[] = [];
    for (const t of Object.keys(RLS_EXEMPT)) {
      if (!schema.allTables.has(t)) {
        stale.push(`${t} (no longer exists in any migration)`);
      } else if (schema.rlsEnabled.has(t)) {
        stale.push(`${t} (now has RLS enabled — remove the exemption)`);
      }
    }
    expect(stale, `Stale RLS_EXEMPT entries — clean these up:\n${stale.join("\n")}`).toEqual([]);
  });
});
