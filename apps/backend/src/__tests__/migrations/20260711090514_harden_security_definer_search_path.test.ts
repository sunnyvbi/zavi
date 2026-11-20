import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const SWEEP = "20260711090514_harden_security_definer_search_path.sql";
const sql = readFileSync(join(MIG_DIR, SWEEP), "utf-8");

describe("20260711090514_harden_security_definer_search_path.sql", () => {
  it("is a config-only ALTER sweep — never CREATE OR REPLACE a body (avoids the stale-base trap)", () => {
    expect(sql).toMatch(/alter function .* set search_path = .*pg_temp/i);
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
  });

  it("only sweeps public security-definer fns, excluding extension-owned ones", () => {
    expect(sql).toMatch(/n\.nspname = 'public'/i);
    expect(sql).toMatch(/p\.prosecdef/i);
    expect(sql).toMatch(/pg_depend[\s\S]*classid = 'pg_proc'::regclass[\s\S]*deptype = 'e'/i);
  });

  it("APPENDS pg_temp to the existing path (preserves vault etc.) — never overwrites", () => {
    expect(sql).toMatch(/set search_path = %s, pg_temp/i);
    expect(sql).toMatch(/substring\(c\.elem from '\^search_path=\(\.\*\)\$'\)/i);
  });

  it("is idempotent via EXACT-token pg_temp match (codex: pg_temp_evil must not count)", () => {
    expect(sql).toMatch(/'pg_temp' = any\(string_to_array\(replace\(.*' ', ''\), ','\)\)/i);
    expect(sql).toMatch(/\^\[a-z_\]\[a-z0-9_, \]\*\$/);
  });

  it("disarms a deploy-session statement_timeout BEFORE the DO block (codex: QUERY_CANCELED is not caught)", () => {
    const beforeDo = sql.slice(0, sql.indexOf("do $$"));
    expect(beforeDo).toMatch(/set statement_timeout = 0/i);
    expect(beforeDo).toMatch(/set lock_timeout = '5s'/i);
  });

  it("is resilient (per-function guard) + reports leftovers (never silently blocks deploys)", () => {
    expect(sql).toMatch(/exception when others then/i);
    expect(sql).toMatch(/still unpinned/i);
    expect(sql).toMatch(/raise warning/i);
  });
});

describe("security-definer functions pin pg_temp (forward guard)", () => {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > SWEEP);

  it(`scans ${files.length} post-sweep migration(s)`, () => {
    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(MIG_DIR, f), "utf-8");
      for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?function\b[\s\S]*?\$\$/gi)) {
        const header = m[0];
        if (!/security\s+definer/i.test(header)) continue;
        if (!/search_path/i.test(header)) continue;
        if (!/pg_temp/i.test(header)) {
          const name = (header.match(/function\s+([a-z0-9_.]+)/i) || [])[1] || "?";
          violations.push(`${f}: ${name}() sets search_path without pg_temp`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

const LOCKDOWN = "20260924120000_lock_down_direct_rpc_access.sql";
const CREATE_FN = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s*\(/gi;
const REVOKE_FN = /revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+function\s+(?:public\.)?"?([A-Za-z0-9_]+)"?\s*\(/gi;

function violationsIn(file: string, sql: string): string[] {
  if (!/security\s+definer/i.test(sql)) return [];
  const created = new Map<string, number>();
  for (const m of sql.matchAll(CREATE_FN)) created.set(m[1].toLowerCase(), (created.get(m[1].toLowerCase()) ?? 0) + 1);
  const revoked = new Map<string, number>();
  for (const m of sql.matchAll(REVOKE_FN)) {
    const rest = sql.slice(m.index!);
    const from = (rest.match(/\bfrom\b([^;]*)/i) || [])[1] || "";
    if (!["public", "anon", "authenticated"].every((r) => new RegExp(String.raw`\b${r}\b`, "i").test(from))) continue;
    revoked.set(m[1].toLowerCase(), (revoked.get(m[1].toLowerCase()) ?? 0) + 1);
  }
  return [...created]
    .filter(([name, n]) => (revoked.get(name) ?? 0) < n)
    .map(([name, n]) => `${file}: ${name}() has ${n} definition(s) in a SECURITY DEFINER migration but fewer revokes from public, anon, authenticated`);
}

describe("security-definer migrations revoke EXECUTE from public, anon and authenticated (forward guard)", () => {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > LOCKDOWN);

  it(`scans ${files.length} post-lockdown migration(s)`, () => {
    const violations = files.flatMap((f) => violationsIn(f, readFileSync(join(MIG_DIR, f), "utf-8")));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  const fn = (arg: string, tail = "language plpgsql security definer as $$ begin return 1; end $$;") =>
    `create or replace function public.leak(p_x ${arg}) returns int ${tail}\n`;
  const full = (arg: string) => `revoke execute on function public.leak(${arg}) from public, anon, authenticated;\n`;

  it("flags a missing revoke and a public-only revoke", () => {
    expect(violationsIn("t", fn("uuid"))).toHaveLength(1);
    expect(violationsIn("t", fn("uuid") + "revoke execute on function public.leak(uuid) from public;\n")).toHaveLength(1);
    expect(violationsIn("t", fn("uuid") + full("uuid"))).toHaveLength(0);
    expect(violationsIn("t", fn("uuid") + "revoke all privileges on function leak(uuid) from public, anon, authenticated;\n")).toHaveLength(0);
  });

  it("needs one revoke per overload", () => {
    expect(violationsIn("t", fn("uuid") + fn("text") + full("uuid"))).toHaveLength(1);
    expect(violationsIn("t", fn("uuid") + fn("text") + full("uuid") + full("text"))).toHaveLength(0);
  });

  it("cannot be fooled by where SECURITY DEFINER sits or what the body contains", () => {
    expect(violationsIn("t", fn("uuid", "as 'begin null; end' language plpgsql security definer;"))).toHaveLength(1);
    expect(violationsIn("t", fn("uuid", "as $b$ select '$x$; returns trigger'; $b$ language sql security definer;"))).toHaveLength(1);
    expect(violationsIn("t", "create function public.ok(p uuid) returns int language sql as $$ select 1 $$;\n")).toHaveLength(0);
  });
});

describe(LOCKDOWN, () => {
  const lock = readFileSync(join(MIG_DIR, LOCKDOWN), "utf-8");
  it("uses types-only signatures (to_regprocedure raises on argument names)", () => {
    const sigs = [...lock.matchAll(/^    '([^']+)'/gm)].map((m) => m[1]);
    expect(sigs.length).toBeGreaterThan(200);
    expect(sigs.filter((s) => /\(\s*p_[a-z_]+\s/i.test(s))).toEqual([]);
  });
  it("guards the prod-only brain_chunks table so a fresh database still applies", () => {
    expect(lock).toMatch(/to_regclass\('public\.brain_chunks'\) is not null/);
  });

  it("closes get_secret and keeps the RLS-policy helpers callable by signed-in users", () => {
    expect(lock).toMatch(/'public\.get_secret\(uuid,text\)'/);
    expect(lock).toMatch(/'public\._preview_run_locked\(uuid\)'/);
    expect(lock).toMatch(/grant execute on function %s to authenticated, service_role/);
    const sigs = [...lock.matchAll(/^    '([^']+)'/gm)].map((m) => m[1]);
    for (const pub of ["startup_offer_status", "get_public_role", "get_creator_storefront"]) {
      expect(sigs.some((x) => x.includes(pub))).toBe(false);
    }
  });
});
