import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261106160100_channel_card_stale_copy_cleanup.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const modules = process.env.SITES_SQL_TEST_MODULES;
const BACKUP = "public.channel_actions_copy_cleanup_backup_20261015";

const OLD = "Write the date. Tell us next week and we will pick the fix for the questions you were missing from.";
const OLD_B = "Write the date. Tell us next week and we will pick the fix from the questions where you were missing.";
const OLD_C = "Write the date. Tell us next week and we will pick the fix from the questions you were missing from.";
const OLD_D = "Write the date. Tell us next week and we'll pick the next fix from the questions you were missing from.";
const NEW = "Write the date and run it again in a month to see which answers changed.";
const GENERIC = ["Open your site and make the change this card describes.", "Check that it worked, then press Done."];

describe(FILE, () => {
  it("is the latest migration version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261106150000_enqueue_agent_run_user_trigger_allowlist.sql"));
  });

  it("writes only how_to and body, keeps the backup private", () => {
    const live = sql.replace(/^\s*--.*$/gm, "");
    const sets = [...live.matchAll(/\bset\s+(\w+)\s*=/gi)].map((m) => m[1].toLowerCase());
    expect(sets.sort()).toEqual(["body", "how_to"]);
    expect(live).toMatch(new RegExp(`alter table ${BACKUP.replace(/\./g, "\\.")} enable row level security;`));
    expect(live).toMatch(new RegExp(`revoke all on table ${BACKUP.replace(/\./g, "\\.")} from public, anon, authenticated;`));
    expect(live).not.toMatch(/\bgrant\b/i);
  });
});

type Db = {
  exec: (q: string) => Promise<unknown>;
  query: (q: string, p?: unknown[]) => Promise<{ rows: any[] }>;
  close: () => Promise<void>;
};
let db: Db;

const T = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const geoBody = (s: string) => ({ action_key: "k", step: { body: `1. Q?\nFor each, note.\n${s}`, how_to: [] }, rendered_markdown: `Kit. ${s}` });

async function insert(n: number, status: string, slug: string, howTo: unknown, body: unknown, stepsDone: unknown = null) {
  await db.query(
    "insert into public.channel_actions (id, tenant_id, channel_slug, status, title, body, how_to, steps_done) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id(n), T, slug, status, `t${n}`, JSON.stringify(body), JSON.stringify(howTo), stepsDone === null ? null : JSON.stringify(stepsDone)],
  );
}
const row = async (n: number) => (await db.query("select * from public.channel_actions where id = $1", [id(n)])).rows[0];
const snapshot = async () => (await db.query("select id, status, title, body::text b, how_to::text h from public.channel_actions order by id")).rows;

describe.skipIf(!modules)(`${FILE} executed in Postgres (pglite)`, () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(resolve(modules!, "../package.json"))("@electric-sql/pglite");
    db = new PGlite();
    await db.exec(`
      create role anon; create role authenticated;
      create table public.channel_actions (
        id uuid primary key, tenant_id uuid not null, channel_slug text not null, status text not null,
        status_at timestamptz default '2026-10-01', title text, body jsonb, how_to jsonb, steps_done jsonb,
        exec_status text, snoozed_until timestamptz);
      create table public.touched (id uuid, op text);
      create function public.log_touch() returns trigger language plpgsql as $$
        begin insert into public.touched values (new.id, tg_op); return new; end $$;
      create trigger t after update on public.channel_actions for each row execute function public.log_touch();
    `);
    await insert(1, "pending", "seo", GENERIC, { a: 1 });
    await insert(2, "snoozed", "reddit", [GENERIC[0]], { a: 1 });
    await insert(3, "pending", "seo", [GENERIC[0], "Paste the new title into the page."], { a: 1 });
    await insert(4, "acted", "seo", GENERIC, { a: 1 });
    await insert(5, "pending", "seo", GENERIC, { a: 1 }, [0]);
    await insert(6, "pending", "seo", [], { a: 1 });
    await insert(7, "pending", "geo", GENERIC, geoBody(OLD));
    await insert(8, "pending", "geo", ["Do the real thing."], geoBody(OLD_B));
    await insert(9, "snoozed", "geo", [], geoBody(OLD_C));
    await insert(10, "pending", "geo", [], geoBody(OLD_D));
    await insert(11, "rejected", "geo", GENERIC, geoBody(OLD));
    await insert(12, "pending", "seo", [], geoBody(OLD));
    await insert(13, "pending", "geo", [], geoBody("Tell us next week and we will pick the fix for the questions you were missing from."));
    await db.exec(sql);
  });
  afterAll(async () => db?.close());

  it("clears a generic-only HOW TO on open cards and nothing else", async () => {
    expect((await row(1)).how_to).toEqual([]);
    expect((await row(2)).how_to).toEqual([]);
    expect((await row(7)).how_to).toEqual([]);
    expect((await row(3)).how_to).toEqual([GENERIC[0], "Paste the new title into the page."]);
    expect((await row(4)).how_to).toEqual(GENERIC);
    expect((await row(5)).how_to).toEqual(GENERIC);
    expect((await row(11)).how_to).toEqual(GENERIC);
    expect((await row(8)).how_to).toEqual(["Do the real thing."]);
  });

  it("replaces every known GEO wording in place, keeping the body's shape", async () => {
    for (const n of [7, 8, 9, 10]) {
      const r = await row(n);
      expect(r.body).toEqual(geoBody(NEW));
    }
    expect((await row(11)).body).toEqual(geoBody(OLD));
    expect((await row(12)).body).toEqual(geoBody(OLD));
    expect((await row(13)).body.rendered_markdown).toContain("Tell us next week");
  });

  it("never changes status, title or timestamps", async () => {
    const r = await row(7);
    expect(r.status).toBe("pending");
    expect(r.title).toBe("t7");
    expect(new Date(r.status_at).toISOString()).toBe(new Date("2026-10-01").toISOString());
    expect((await row(9)).status).toBe("snoozed");
  });

  it("backs up exactly the changed rows, with old and new values", async () => {
    const b = (await db.query(`select id, fix, how_to, body, new_how_to, new_body from ${BACKUP} order by id, fix`)).rows;
    expect(b.map((x) => `${x.id.slice(-2)}:${x.fix}`)).toEqual([
      "01:how_to", "02:how_to", "07:geo_body", "07:how_to", "08:geo_body", "09:geo_body", "10:geo_body",
    ]);
    const r7 = b.find((x) => x.id === id(7) && x.fix === "geo_body");
    expect(r7.body).toEqual(geoBody(OLD));
    expect(r7.new_body).toEqual(geoBody(NEW));
    const touched = (await db.query("select distinct id from public.touched order by id")).rows.map((x) => x.id.slice(-2));
    expect(touched).toEqual(["01", "02", "07", "08", "09", "10"]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = await snapshot();
    await db.exec("delete from public.touched");
    await db.exec(sql);
    expect(await snapshot()).toEqual(before);
    expect((await db.query("select count(*)::int n from public.touched")).rows[0].n).toBe(0);
    expect((await db.query(`select count(*)::int n from ${BACKUP}`)).rows[0].n).toBe(7);
  });

  it("keeps the backup table away from the browser roles", async () => {
    const rls = (await db.query("select relrowsecurity from pg_class where oid = $1::regclass", [BACKUP])).rows[0];
    expect(rls.relrowsecurity).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      const p = (await db.query(`select has_table_privilege($1, $2, 'select') s`, [role, BACKUP])).rows[0];
      expect(p.s).toBe(false);
    }
  });

  it("the commented rollback restores the original copy", async () => {
    const block = sql.split("-- ── Rollback")[1];
    const rollback = block
      .split("\n")
      .filter((l) => l.startsWith("-- ") && !/^-- (Restores|later edit|When no longer|drop table)/.test(l))
      .map((l) => l.slice(3))
      .join("\n");
    await db.exec(rollback);
    expect((await row(1)).how_to).toEqual(GENERIC);
    expect((await row(7)).how_to).toEqual(GENERIC);
    expect((await row(7)).body).toEqual(geoBody(OLD));
    expect((await row(10)).body).toEqual(geoBody(OLD_D));
  });
});
