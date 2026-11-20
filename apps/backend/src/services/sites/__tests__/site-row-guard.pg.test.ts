
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROWS_CHANGED_MARKER, rowGuardAssertSql, rowGuardSnapshotSql } from "../site-row-guard";
import { publishFenceSql, publishReserveSql } from "@/services/site-shards/sql";

const hasPg =
  process.env.ZAVI_SKIP_PG_TESTS !== "1" &&
  ["postgres", "initdb", "pg_ctl", "psql"].every((b) => spawnSync(b, ["--version"]).status === 0);

let dir = "";
const PORT = String(55000 + Math.floor(Math.random() * 5000));

function run(sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", dir, "-p", PORT, "-U", "postgres", "-d", "postgres", "-c", sql], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr || `psql exited ${r.status}`);
  return r.stdout;
}

function val(sql: string): string | null {
  const out = run(sql).trim();
  return out === "" ? null : out;
}

let serverVersion = 0;

const items = () => val(`select string_agg(id || '=' || name, ',' order by id) from public.items`);

const migrate = (sql: string, tag = "0123456789abcdef") => run(`${rowGuardSnapshotSql(tag)}\n${sql}\n;\n${rowGuardAssertSql(tag)}`);

const FIXTURE = `drop schema if exists public cascade;
create schema public;
create table public.items (id int primary key, name text);
insert into public.items values (1, 'a'), (2, 'b');
create table public.log (id serial primary key, note text);`;

describe.skipIf(!hasPg)("site row guard (real Postgres)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zrg-"));
    const init = spawnSync("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "--no-sync"], { encoding: "utf8" });
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
    const start = spawnSync(
      "pg_ctl",
      ["-D", join(dir, "data"), "-w", "-l", join(dir, "log"), "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c fsync=off`, "start"],
      { encoding: "utf8" },
    );
    if (start.status !== 0) throw new Error(`pg_ctl start failed: ${start.stderr}`);
    serverVersion = Number(val("show server_version_num"));
  });
  afterAll(() => {
    if (dir) {
      spawnSync("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"], { encoding: "utf8" });
      rmSync(dir, { recursive: true, force: true });
    }
  });
  beforeEach(() => {
    run(FIXTURE);
  });

  it("adding passes: a new table with rows, new rows in an existing table, a new column", () => {
    migrate(`create table public.fresh (id int primary key); insert into public.fresh values (1); update public.fresh set id = 2 where id = 1;
insert into public.items values (3, 'c');
alter table public.items add column if not exists note text`);
    expect(items()).toBe("1=a,2=b,3=c");
    expect(val(`select string_agg(id::text, ',') from public.fresh`)).toBe("2");
  });

  const refused: Array<[string, string]> = [
    ["a plain UPDATE", `update public.items set name = 'x' where id = 1`],
    ["a DELETE", `delete from public.items where id = 2`],
    ["INSERT ... ON CONFLICT DO UPDATE", `insert into public.items values (1, 'x') on conflict (id) do update set name = excluded.name`],
    [
      "a quoted mutator called from an INSERT",
      `create function "public"."Mutator"() returns text language plpgsql as $f$ begin update "public"."items" set name = 'x' where id = 1; return 'm'; end $f$;
insert into public.log (note) values ("public"."Mutator"())`,
    ],
    [
      "MERGE /* c */ INTO in a trigger fired by an INSERT",
      `create function public.t_merge() returns trigger language plpgsql as $f$ begin merge /* c */ into public.items i using (select 1 as id) s on i.id = s.id when matched then update set name = 'x'; return new; end $f$;
create trigger t_merge after insert on public.log for each row execute function public.t_merge();
insert into public.log (note) values ('go')`,
    ],
    ["a TRUNCATE", `truncate public.items`],
    [
      "a DEFERRABLE INITIALLY DEFERRED constraint trigger (it would otherwise fire at commit, after the check)",
      `create function public.t_late() returns trigger language plpgsql as $f$ begin update public.items set name = 'x' where id = 1; return null; end $f$;
create constraint trigger t_late after insert on public.log deferrable initially deferred for each row execute function public.t_late();
insert into public.log (note) values ('go')`,
    ],
  ];

  for (const [what, sql] of refused) {
    it(`refuses ${what}, and the whole migration rolls back`, () => {
      if (/MERGE/.test(what) && serverVersion < 150000) return;
      expect(() => migrate(sql)).toThrow(new RegExp(ROWS_CHANGED_MARKER));
      expect(items()).toBe("1=a,2=b");
      expect(val(`select count(*)::text from public.log`)).toBe("0");
    });
  }

  it("names the table and what happened", () => {
    expect(() => migrate(`update public.items set name = 'x' where id in (1, 2); delete from public.items where id = 1`)).toThrow(
      /public\.items \(2 updated, 1 deleted\)/,
    );
  });

  it("the shard publish fence: once a newer generation RESERVED, an older one's whole commit transaction rolls back", () => {
    const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
    run(`drop schema if exists zsite cascade; create schema zsite;
create table zsite.site_fences (site_id uuid primary key, applied_generation bigint not null check (applied_generation >= 1), updated_at timestamptz not null default now());
create table zsite.contract (v text)`);
    const commit = (gen: number, v: string) => run(`begin;\n${publishFenceSql(SITE, gen)}\ninsert into zsite.contract values ('${v}');\ncommit;`);
    const lost = /zavi_refused \{"code":"lease_lost"\}/;
    expect(() => commit(1, "unreserved")).toThrow(lost);
    run(publishReserveSql(SITE, 1));
    run(publishReserveSql(SITE, 2));
    expect(() => commit(1, "stale")).toThrow(lost);
    run(publishReserveSql(SITE, 1));
    expect(() => commit(1, "stale-again")).toThrow(lost);
    commit(2, "gen2");
    commit(2, "gen2-retry");
    expect(val(`select string_agg(v, ',' order by v) from zsite.contract`)).toBe("gen2,gen2-retry");
    expect(val(`select applied_generation::text from zsite.site_fences`)).toBe("2");
  });
});
