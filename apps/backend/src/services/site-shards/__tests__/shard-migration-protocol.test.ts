import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyShardMigration, assertProtocol, loadShardMigrations, readFrozen, type ShardMigrationFile } from "../migrations";
import { FROZEN_VERSIONS, concurrentIndexOf, durationMs, lintShardMigration, runnerSteps, splitStatements, stripComments } from "../migration-protocol";

const ROOT = resolve(__dirname, "../../../../../../infra/site-shard");

const file = (version: string, sql: string): ShardMigrationFile => ({ version, sql, sha256: createHash("sha256").update(sql).digest("hex") });
const TX = (body: string) => `-- x\nbegin;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\n${body}\ncommit;\n`;
const lint = (sql: string, versions: string[] = ["0011_x"]) => lintShardMigration({ version: "0011_x", sql }, versions);

describe("the repo's shard migrations", () => {
  it("every frozen file is byte-identical to its recorded checksum, and frozen.json lists only real files", () => {
    const frozen = readFrozen(ROOT);
    expect(Object.keys(frozen).sort()).toEqual([...FROZEN_VERSIONS].sort());
    const onDisk = new Map<string, string>();
    for (const sub of ["migrations", "auth"]) {
      for (const f of readdirSync(join(ROOT, sub)).filter((x) => x.endsWith(".sql"))) {
        onDisk.set(f.slice(0, -4), createHash("sha256").update(readFileSync(join(ROOT, sub, f), "utf8")).digest("hex"));
      }
    }
    for (const [v, sha] of Object.entries(frozen)) {
      expect(onDisk.has(v), `${v} is frozen but missing`).toBe(true);
      expect(onDisk.get(v), `${v} was edited after it was frozen: add a new file instead`).toBe(sha);
    }
  });

  it("every NEW (unfrozen) file follows the protocol (loadShardMigrations enforces the same)", () => {
    const files = loadShardMigrations(ROOT);
    const frozen = readFrozen(ROOT);
    const versions = files.map((f) => f.version);
    for (const f of files.filter((x) => frozen[x.version] === undefined)) {
      expect(lintShardMigration(f, versions), f.version).toEqual([]);
    }
  });
});

describe("protocol lint", () => {
  it("a conforming transactional file passes", () => {
    expect(lint(TX("create table if not exists zsite.t (id uuid primary key);\ncreate index if not exists t_idx on zsite.t (id);\nalter table zsite.records add column if not exists z text;"))).toEqual([]);
  });

  it("timeouts: both SETs, right after begin, bounded", () => {
    expect(lint("begin;\nalter table zsite.records add column z text;\ncommit;").join("\n")).toMatch(/lock_timeout[\s\S]*statement_timeout/);
    expect(lint("begin;\nset local lock_timeout = '1min';\nset local statement_timeout = '5min';\ncommit;").join()).toMatch(/lock_timeout must be/);
    expect(lint("begin;\nset local lock_timeout = '5s';\nset local statement_timeout = 0;\ncommit;").join()).toMatch(/statement_timeout must be/);
    expect(lint("begin;\nset lock_timeout = '5s';\nset statement_timeout = '5min';\ncommit;").length).toBeGreaterThan(0);
    expect(lint("begin;\nalter table zsite.records add column z text;\nset local lock_timeout = '5s';\nset local statement_timeout = '5min';\ncommit;").length).toBeGreaterThan(0);
    expect(lint("set local lock_timeout = '5s';").join()).toMatch(/begin/);
  });

  it("an inline index on an existing table is refused; CONCURRENTLY in a transaction is refused", () => {
    expect(lint(TX("create index if not exists r_idx on zsite.records (site_id);")).join()).toMatch(/inline index build on an existing table/);
    expect(lint(TX("create index concurrently r_idx on zsite.records (site_id);")).join()).toMatch(/CONCURRENTLY cannot run in a transaction/);
  });

  it("no-transaction files: each CONCURRENTLY statement alone in its step; other steps open with both SETs", () => {
    const ok = "-- zavi:no-transaction\n-- zavi:step\nset lock_timeout = '5s';\nset statement_timeout = '30min';\nselect 1;\n-- zavi:step\ncreate index concurrently if not exists r_idx on zsite.records (site_id);\n";
    expect(lint(ok)).toEqual([]);
    expect(runnerSteps({ sql: ok })).toHaveLength(2);
    const two = "-- zavi:no-transaction\n-- zavi:step\nset lock_timeout = '5s';\ncreate index concurrently r_idx on zsite.records (site_id);\n";
    expect(lint(two).join()).toMatch(/ONLY statement of its step/);
    const noSets = "-- zavi:no-transaction\n-- zavi:step\nupdate zsite.records set z = 1;\n";
    expect(lint(noSets).join()).toMatch(/lock_timeout/);
    const inline = "-- zavi:no-transaction\n-- zavi:step\nset lock_timeout = '5s';\nset statement_timeout = '30min';\ncreate index r_idx on zsite.records (site_id);\n";
    expect(lint(inline).join()).toMatch(/must be CONCURRENTLY/);
  });

  it("expand/contract: destructive DDL only in a contract file naming an EARLIER expand file", () => {
    for (const ddl of [
      "alter table zsite.records drop column z;",
      "drop table zsite.old;",
      "alter table zsite.records alter column z type bigint;",
      "alter table zsite.records alter column z set data type bigint;",
      "alter table zsite.records rename column z to y;",
      "alter table zsite.records rename z to y;",
      "alter table zsite.old rename to older;",
      "do $$ begin execute 'alter table zsite.records drop column z'; end $$;",
    ]) {
      expect(lint(TX(ddl)).join(), ddl).toMatch(/only in a contract file/);
    }
    const contract = `-- zavi:contract-after 0010_add\n${TX("alter table zsite.records drop column z;")}`;
    expect(lintShardMigration({ version: "0012_drop", sql: contract }, ["0010_add", "0012_drop"])).toEqual([]);
    expect(lintShardMigration({ version: "0012_drop", sql: contract }, ["0012_drop"]).join()).toMatch(/no such shard migration/);
    expect(lintShardMigration({ version: "0009_drop", sql: contract }, ["0010_add", "0009_drop"]).join()).toMatch(/must come BEFORE/);
    expect(lint(TX("alter table zsite.records rename constraint a to b;"))).toEqual([]);
  });

  it("full-table lock hazards on existing tables are refused (fine on a table the file creates)", () => {
    expect(lint(TX("alter table zsite.records alter column z set not null;")).join()).toMatch(/SET NOT NULL/);
    expect(lint(TX("alter table zsite.records add constraint c check (z is not null);")).join()).toMatch(/NOT VALID/);
    expect(lint(TX("alter table zsite.records add constraint c check (z is not null) not valid;"))).toEqual([]);
    expect(lint(TX("alter table zsite.records add constraint f foreign key (a) references zsite.sites (id);")).join()).toMatch(/NOT VALID/);
    expect(lint(TX("alter table zsite.records add column z timestamptz default now();")).join()).toMatch(/plain constant/);
    expect(lint(TX("alter table zsite.records add column z boolean not null default false;"))).toEqual([]);
    expect(lint(TX("lock table zsite.records;")).join()).toMatch(/LOCK TABLE/);
    expect(lint(TX("vacuum full zsite.records;")).join()).toMatch(/VACUUM FULL/);
    expect(lint(TX("do $$ begin alter table zsite.records alter column z set not null; end $$;")).join()).toMatch(/SET NOT NULL/);
    expect(lint(TX("do $$ begin execute 'create index r_idx on zsite.records (a)'; end $$;")).join()).toMatch(/inline index build on an existing table \(zsite.records\)/);
    expect(lint(TX("create or replace function zsite.f() returns void language plpgsql as $f$ begin create index r_idx on zsite.records (a); end $f$;")).join()).toMatch(/inline index build/);
    expect(lint(TX("alter table zsite.records add constraint u unique (a);")).join()).toMatch(/UNIQUE \/ PRIMARY KEY/);
    expect(lint(TX("alter table zsite.records add primary key (a);")).join()).toMatch(/UNIQUE \/ PRIMARY KEY/);
    expect(lint(TX("alter table zsite.records add constraint u unique using index u_idx;"))).toEqual([]);
    expect(lint(TX("alter table zsite.records add column z int default zsite.custom_volatile();")).join()).toMatch(/plain constant/);
    expect(lint(TX("alter table zsite.records add column z text default 'a' || now()::text;")).join()).toMatch(/plain constant/);
    expect(lint(TX("alter table zsite.records add column z int generated always as (a + 1) stored;")).join()).toMatch(/GENERATED/);
    expect(lint(TX("alter table zsite.records add column z jsonb not null default '{}'::jsonb, add column y text default 'x';"))).toEqual([]);
    expect(lint(TX("do $$ begin execute 'alter table zsite.records alter column z set not null'; end $$;")).join()).toMatch(/SET NOT NULL/);
    expect(lint(TX("alter table zsite.records add column z text unique;")).join()).toMatch(/inline UNIQUE/);
    expect(lint(TX("alter table zsite.records add column z uuid references zsite.sites (id);")).join()).toMatch(/inline REFERENCES/);
    expect(lint(TX("alter table zsite.records add column z int check (z > 0);")).join()).toMatch(/inline CHECK/);
    expect(lint(TX("do $$ begin execute format('alter table %I.%I alter column z set not null', 'zsite', 'records'); end $$;")).join()).toMatch(/cannot read/);
    expect(lint(TX("alter table zsite.records add constraint a check (z > 0) not valid, add constraint b check (y > 0);")).join()).toMatch(/NOT VALID/);
    expect(lint(TX("alter table zsite.records add constraint u unique using index u_idx, add constraint p primary key (id);")).join()).toMatch(/UNIQUE \/ PRIMARY KEY/);
    expect(lint(TX("alter table zsite.records add column z text not null default 'not null';"))).toEqual([]);
    expect(lint(TX("alter table zsite.records add column z text default 'a,b', add column y int default 0;"))).toEqual([]);
    expect(lint(TX("insert into zsite.notes (body) values ('remember to alter table later');"))).toEqual([]);
    expect(lint(TX("do $$ declare q text := 'alter table zsite.records alter column z set not null'; begin execute q; end $$;")).join()).toMatch(/SET NOT NULL/);
    expect(lintShardMigration({ version: "0011_x", sql: TX("create table if not exists zsite.records (id uuid);\nalter table zsite.records alter column z set not null;") }, ["0011_x"], ["begin;\ncreate table if not exists zsite.records (id uuid);\ncommit;"]).join()).toMatch(/SET NOT NULL/);
    expect(lint(TX("create table if not exists zsite.t (z int);\nalter table zsite.t alter column z set not null;\nalter table zsite.t add constraint c check (z > 0);"))).toEqual([]);
  });

  it("parsing helpers: comments, quotes and dollar quotes", () => {
    expect(stripComments("select 1; -- drop column x\n/* drop table y */ select '--not a comment';")).not.toMatch(/drop/);
    expect(stripComments("select '--kept'")).toContain("--kept");
    expect(splitStatements("create function f() returns int as $f$ select 1; select 2; $f$ language sql; select ';'")).toHaveLength(2);
    expect(durationMs("'5s'")).toBe(5000);
    expect(durationMs("2min")).toBe(120_000);
    expect(durationMs("250")).toBe(250);
    expect(durationMs("'abc'")).toBeNull();
    expect(concurrentIndexOf("create unique index concurrently if not exists Foo_idx on zsite.records (a);")).toEqual({ name: "foo_idx", schema: "zsite" });
    expect(concurrentIndexOf("create index concurrently foo on records (a);")).toBeNull();
    expect(concurrentIndexOf("create index foo on t (a);")).toBeNull();
  });
});

describe("loadShardMigrations enforces it", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  function root(files: Record<string, string>, frozen: Record<string, string> = {}) {
    dir = mkdtempSync(join(tmpdir(), "shard-proto-"));
    mkdirSync(join(dir, "migrations"));
    for (const [n, sql] of Object.entries(files)) writeFileSync(join(dir, "migrations", n), sql);
    writeFileSync(join(dir, "migrations", "frozen.json"), JSON.stringify({ files: frozen }));
    return dir;
  }

  it("refuses a non-conforming new file, loads a conforming one", () => {
    expect(() => loadShardMigrations(root({ "0001_a.sql": "begin; alter table zsite.records drop column z; commit;" }))).toThrow(/shard migration protocol[\s\S]*0001_a/);
    rmSync(dir, { recursive: true, force: true });
    expect(loadShardMigrations(root({ "0001_a.sql": TX("alter table zsite.records add column if not exists z text;") }))).toHaveLength(1);
  });

  it("a frozen file is exempt from the lint but must match its checksum", () => {
    const legacy = "begin; create index x on zsite.records (a); commit;";
    const sha = createHash("sha256").update(legacy).digest("hex");
    expect(loadShardMigrations(root({ "0001_core.sql": legacy }, { "0001_core": sha }))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
    expect(() => loadShardMigrations(root({ "0001_core.sql": `${legacy} ` }, { "0001_core": sha }))).toThrow(/frozen file changed/);
  });

  it("adding a NEW file's checksum to frozen.json does not exempt it (the frozen set is pinned in code)", () => {
    const bad = "begin; create index x on zsite.records (a); commit;";
    const sha = createHash("sha256").update(bad).digest("hex");
    expect(() => loadShardMigrations(root({ "0011_bad.sql": bad }, { "0011_bad": sha }))).toThrow(/0011_bad/);
  });

  it("assertProtocol lists every problem at once", () => {
    expect(() => assertProtocol([file("0001_a", "drop table t;"), file("0002_b", "lock table t;")], {})).toThrow(/0001_a[\s\S]*0002_b/);
  });
});

describe("runner: no-transaction files and concurrent indexes", () => {
  const nt = file(
    "0011_idx",
    "-- zavi:no-transaction\n-- zavi:step\nset lock_timeout = '5s';\nset statement_timeout = '30min';\nselect 1;\n-- zavi:step\ncreate index concurrently if not exists r_idx on zsite.records (site_id);\n",
  );

  function fake(opts: { invalidBefore?: boolean; invalidAfter?: boolean } = {}) {
    const sent: string[] = [];
    let built = false;
    return {
      sent,
      sql: {
        async query(_ref: string, q: string) {
          sent.push(q);
          if (q.includes("not i.indisvalid")) {
            const invalid = built ? opts.invalidAfter : opts.invalidBefore;
            return invalid ? [{ schema: "zsite" }] : [];
          }
          if (q.startsWith("create index concurrently")) built = true;
          if (q.includes("to_regprocedure")) return [{ ok: false }];
          return [];
        },
      },
    };
  }

  it("sends each step as its own query (the concurrent one alone), then records the file", async () => {
    const f = fake();
    await applyShardMigration(f.sql, "refrefref1", nt);
    const steps = f.sent.filter((q) => !q.includes("indisvalid") && !q.includes("to_regprocedure"));
    expect(steps[0]).toMatch(/^-- zavi:no-transaction|^set lock_timeout/);
    expect(steps[1]).toBe("create index concurrently if not exists r_idx on zsite.records (site_id);");
    expect(steps[2]).toMatch(/insert into zsite.migrations \(version\) values \('0011_idx'\)/);
  });

  it("drops an INVALID leftover of a failed build before rebuilding it", async () => {
    const f = fake({ invalidBefore: true });
    await applyShardMigration(f.sql, "refrefref1", nt);
    const drop = f.sent.findIndex((q) => q === 'drop index concurrently if exists "zsite"."r_idx"');
    const build = f.sent.findIndex((q) => q.startsWith("create index concurrently"));
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(build);
  });

  it("a build that ends INVALID fails the file (not recorded)", async () => {
    const f = fake({ invalidAfter: true });
    await expect(applyShardMigration(f.sql, "refrefref1", nt)).rejects.toThrow(/INVALID/);
    expect(f.sent.some((q) => q.includes("insert into zsite.migrations"))).toBe(false);
  });

  it("a transactional file is still ONE query", async () => {
    const f = fake();
    await applyShardMigration(f.sql, "refrefref1", file("0012_t", TX("select 1;")));
    expect(f.sent.filter((q) => q.includes("begin;"))).toHaveLength(1);
  });
});
