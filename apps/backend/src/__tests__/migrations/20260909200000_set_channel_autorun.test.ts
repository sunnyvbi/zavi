import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260909200000_set_channel_autorun.sql",
  ),
  "utf8",
);

const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260909200000_set_channel_autorun.sql", () => {
  it("stamps autorun_set_by = 'founder' on BOTH the insert and the update path", () => {
    const fn = code.slice(code.indexOf("create or replace function set_channel_autorun("));
    const insertPath = fn.slice(fn.indexOf("insert into tenant_channels"), fn.indexOf("on conflict"));
    const updatePath = fn.slice(fn.indexOf("on conflict"));
    expect(insertPath).toMatch(/'founder'/);
    expect(updatePath).toMatch(/autorun_set_by\s*=\s*'founder'/);
  });

  it("never writes plan_selected — that column is Zavi's, not the founder's", () => {
    const fn = code.slice(code.indexOf("create or replace function set_channel_autorun("));
    expect(fn).not.toMatch(/plan_selected/);
  });

  it("reads its own write back rather than trusting the update", () => {
    const fn = code.slice(code.indexOf("create or replace function set_channel_autorun("));
    expect(fn).toMatch(/select true into v_exists/i);
    expect(fn).toMatch(/autorun_set_by = 'founder'/);
    expect(fn).toMatch(/return coalesce\(v_exists, false\)/i);
  });

  it("refuses a null tenant, an empty slug, or a null autorun", () => {
    const fn = code.slice(code.indexOf("create or replace function set_channel_autorun("));
    expect(fn).toMatch(/p_tenant_id is null/i);
    expect(fn).toMatch(/nullif\(trim\(p_channel_slug\), ''\) is null/i);
    expect(fn).toMatch(/p_autorun is null/i);
  });

  it("never coerces a null autorun to false", () => {
    const fn = code.slice(code.indexOf("create or replace function set_channel_autorun("));
    expect(fn).not.toMatch(/coalesce\(p_autorun/i);
  });

  it("is service_role only, with the grant restored after the revoke", () => {
    expect(code).toMatch(
      /revoke all on function set_channel_autorun\(uuid, text, boolean\)\s+from public, anon, authenticated/i,
    );
    expect(code).toMatch(
      /grant execute on function set_channel_autorun\(uuid, text, boolean\)\s+to service_role/i,
    );
  });

  it("is security definer with a pinned search_path", () => {
    expect(code).toMatch(
      /security definer set search_path = public, pg_temp/i,
    );
  });
});
