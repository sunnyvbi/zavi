import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PG_URL = process.env.ZAVI_TEST_PG_URL;
const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const noComments = (s: string) => s.replace(/--[^\n]*/g, "");
const noFks = (s: string) =>
  s
    .replace(/references\s+[a-z_.]+\s*(\([^)]*\))?(\s+on delete (cascade|set null|restrict))?/gi, "")
    .replace(/,\s*(constraint\s+\w+\s+)?foreign key\s*\([^)]*\)[^,)]*/gi, "");

function tableDdl(table: string): string[] {
  let create: string | null = null;
  const alters: string[] = [];
  for (const f of files()) {
    const s = noComments(read(f));
    const m = create === null ? new RegExp(`create table (if not exists )?(public\\.)?${table}\\s*\\(`).exec(s) : null;
    if (m) {
      let depth = 0;
      let j = m.index + m[0].length - 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      create = s.slice(m.index, j + 1);
    }
    for (const a of s.matchAll(new RegExp(`alter table (if exists )?(public\\.)?${table}\\b([\\s\\S]*?);`, "g"))) {
      if (/add column|add constraint|drop constraint|alter column/.test(a[3]) && !/%I|foreign key/i.test(a[3])) {
        alters.push(`alter table ${table} ${a[3].trim()};`);
      }
    }
  }
  if (!create) throw new Error(`${table}: no create table in migrations`);
  return [noFks(create), ...alters.map(noFks)].map((s) => s.replace(/\bpublic\./g, ""));
}

const SCHEMA = `zz_hkeep_${Math.random().toString(36).slice(2, 10)}`;
function latestFunction(name: string): string {
  const hit = files().filter((f) => read(f).includes(`create or replace function ${name}(`)).pop();
  if (!hit) throw new Error(`${name} defined in no migration`);
  const sql = read(hit);
  const s = sql.indexOf(`create or replace function ${name}(`);
  const a = sql.indexOf("$$", s);
  const b = sql.indexOf("$$", a + 2);
  return sql.slice(s, sql.indexOf(";", b) + 1).replace(/search_path = public, pg_temp/, `search_path = ${SCHEMA}, pg_temp`);
}

function grants(name: string): string[] {
  const hit = files().filter((f) => read(f).includes(`create or replace function ${name}(`)).pop()!;
  return read(hit)
    .split("\n")
    .filter((l) => /^(revoke|grant) /.test(l) && l.includes(`on function ${name}(`));
}

const T = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const G = "00000000-0000-4000-8000-0000000000b1";
const H = "00000000-0000-4000-8000-0000000000b2";
const ACTOR = "00000000-0000-4000-8000-0000000000b3";

describe.skipIf(!PG_URL)("Keep my plan, stored on the hypothesis (live SQL)", () => {
  const db = new Client({ connectionString: PG_URL });

  beforeAll(async () => {
    await db.connect();
    await db.query("begin");
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set local search_path = ${SCHEMA}, public`);
    for (const r of ["anon", "authenticated", "service_role"]) {
      await db.query(`do $$ begin create role ${r}; exception when others then null; end $$;`);
    }
    for (const stmt of tableDdl("cgo_hypotheses")) {
      await db.query("savepoint ddl");
      try {
        await db.query(stmt);
      } catch (e) {
        if (!["42P07", "42710", "42701"].includes((e as { code?: string }).code ?? "")) throw e;
        await db.query("rollback to savepoint ddl");
      }
    }
    await db.query(latestFunction("set_hypothesis_plan_kept"));
    for (const g of grants("set_hypothesis_plan_kept")) await db.query(g);
  });
  afterAll(async () => {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  });

  beforeEach(async () => {
    await db.query("delete from cgo_hypotheses;");
  });

  const insert = (status: string, marked: boolean, tenant = T) =>
    db.query(
      `insert into cgo_hypotheses (id, tenant_id, goal_id, problem, claim, status, evidence, evidence_version, status_at, restates_plan_constraint)
       values ($1, $2, $3, 'traffic', 'Renter demand is binding', $4, '[]', 1, now(), $5)`,
      [H, tenant, G, status, marked],
    );
  const keep = async (kept: boolean, tenant = T) =>
    (await db.query(`select set_hypothesis_plan_kept($1, $2, $3, $4) r`, [tenant, H, ACTOR, kept])).rows[0].r as { kept_at: string | null };
  const row = async () => (await db.query(`select plan_kept_at, plan_kept_by from cgo_hypotheses where id = $1`, [H])).rows[0];
  const code = async (p: Promise<unknown>) => {
    await db.query("savepoint t");
    try {
      await p;
      return "ok";
    } catch (e) {
      await db.query("rollback to savepoint t");
      return (e as { code?: string }).code;
    }
  };

  it("keeps a ruled-out blocker, then Undo clears it", async () => {
    await insert("ruled_out", true);
    expect((await keep(true)).kept_at).toBeTruthy();
    expect(await row()).toMatchObject({ plan_kept_by: ACTOR });
    expect((await keep(false)).kept_at).toBeNull();
    expect(await row()).toMatchObject({ plan_kept_at: null, plan_kept_by: null });
  });

  it("refuses another tenant, an open idea, and an unmarked row, writing nothing", async () => {
    await insert("ruled_out", true);
    expect(await code(keep(true, OTHER))).toBe("P0002");
    await db.query("delete from cgo_hypotheses;");
    await insert("testing", true);
    expect(await code(keep(true))).toBe("P0002");
    await db.query("delete from cgo_hypotheses;");
    await insert("ruled_out", false);
    expect(await code(keep(true))).toBe("P0002");
    expect((await row()).plan_kept_at).toBeNull();
  });

  it("only the service role may call it", async () => {
    const r = await db.query(
      `select has_function_privilege('authenticated', 'set_hypothesis_plan_kept(uuid, uuid, uuid, boolean)', 'execute') a,
              has_function_privilege('service_role', 'set_hypothesis_plan_kept(uuid, uuid, uuid, boolean)', 'execute') s`,
    );
    expect(r.rows[0]).toEqual({ a: false, s: true });
  });
});
