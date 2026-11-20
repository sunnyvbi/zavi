import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODE_VERDICT, blockedOnUsNote, classifyExecFailure } from "../exec-failure";
import { execPlatformKeys, execPlatformLabel } from "../exec-kill-switch";
import { EXEC_FIXTURES } from "./exec-failure.fixtures";

const MIGRATIONS_DIR = join(__dirname, "../../../../../../supabase/migrations");
function latestDefinition(name: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8").includes(`create or replace function ${name}(`));
  if (files.length === 0) throw new Error(`${name} defined in no migration`);
  return readFileSync(join(MIGRATIONS_DIR, files[files.length - 1]), "utf8");
}
const BLOCKED_NOTE_SQL = latestDefinition("exec_blocked_note");
const CLASSIFIER_SQL = latestDefinition("classify_exec_failure");

export function functionStatement(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in migration`);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$;", open + 2);
  return sql.slice(start, close + 3);
}

describe("classifier parity: static", () => {
  it("the SQL code table is exactly CODE_VERDICT", () => {
    const fn = functionStatement(CLASSIFIER_SQL, "classify_exec_failure");
    const values = fn.slice(fn.indexOf("from (values"), fn.indexOf(") as c(code, bucket, fix)"));
    const rows = [...values.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*(?:'([a-z_]+)'|null)\)/g)].map((m) => [m[1], m[2], m[3] ?? null]);
    const ts = Object.entries(CODE_VERDICT).map(([code, v]) => [code, v.bucket, v.fix]);
    expect(rows.sort()).toEqual(ts.sort());
  });

  it("the SQL note names every platform label exactly as the TS map does", () => {
    const fn = functionStatement(BLOCKED_NOTE_SQL, "exec_blocked_note");
    const labels = Object.fromEntries([...fn.matchAll(/when '([a-z_]+)'\s+then '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const ts = Object.fromEntries(execPlatformKeys().map((k) => [k, execPlatformLabel(`${k}.x`)]));
    expect(labels).toEqual(ts);
    expect(fn).toContain("else 'These' end");
  });
});

const PG_URL = process.env.ZAVI_TEST_PG_URL;

describe.skipIf(!PG_URL)("classifier parity: live Postgres", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: PG_URL });
    await db.connect();
    await db.query("begin");
    await db.query(functionStatement(CLASSIFIER_SQL, "classify_exec_failure"));
    await db.query(functionStatement(BLOCKED_NOTE_SQL, "exec_blocked_note"));
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it.each(EXEC_FIXTURES.map((x) => [x.name, x] as const))("%s", async (_n, x) => {
    const { rows } = await db.query("select classify_exec_failure($1::jsonb) as v", [JSON.stringify(x.result)]);
    const ts = classifyExecFailure(x.result);
    expect(rows[0].v).toEqual(ts);
    expect(rows[0].v).toEqual(x.bucket === null ? null : { bucket: x.bucket, fix: x.fix, platform_code: x.platform_code });
  });

  it("non-object inputs classify like TS does", async () => {
    for (const junk of ["null", "7", '"x"', "[]", '[{"error":"x"}]', '{"error":5,"code":9}']) {
      const { rows } = await db.query("select classify_exec_failure($1::jsonb) as v", [junk]);
      expect(rows[0].v, junk).toEqual(classifyExecFailure(JSON.parse(junk)));
    }
    const { rows } = await db.query("select classify_exec_failure(null) as v");
    expect(rows[0].v).toEqual(classifyExecFailure(null));
  });

  it("the blocked note matches blockedOnUsNote for every class", async () => {
    const classes = [...new Set([...EXEC_FIXTURES.map((x) => x.exec_class), ...execPlatformKeys().map((k) => `${k}.x`), "weird", ""])];
    for (const c of classes) {
      const { rows } = await db.query("select exec_blocked_note($1) as n", [c]);
      expect(rows[0].n, c).toBe(blockedOnUsNote(c));
    }
  });
});
