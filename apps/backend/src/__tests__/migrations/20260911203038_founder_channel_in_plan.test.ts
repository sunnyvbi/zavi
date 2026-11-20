import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260911203038_founder_channel_in_plan.sql",
  ),
  "utf8",
);

const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

function fnBody(name: string): string {
  const start = code.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("$$;", start);
  return code.slice(start, end === -1 ? undefined : end);
}

describe("20260911203038_founder_channel_in_plan.sql", () => {
  it("adds plan_selected_set_by limited to plan | founder", () => {
    expect(code).toMatch(
      /add column if not exists plan_selected_set_by text\s+check \(plan_selected_set_by in \('plan', 'founder'\)\)/,
    );
  });

  it("a founder add lands with autorun OFF and the switch pinned as the founder's", () => {
    const fn = fnBody("set_channel_in_plan");
    const insert = fn.slice(fn.indexOf("insert into tenant_channels"), fn.indexOf("on conflict"));
    expect(insert).toMatch(/true, 'founder', v_next, false, 'founder'/);
    const update = fn.slice(fn.indexOf("on conflict"), fn.indexOf("select true into v_ok"));
    expect(update).not.toMatch(/\bautorun\s*=/);
  });

  it("only removes the founder's own add", () => {
    const fn = fnBody("set_channel_in_plan");
    expect(fn).toMatch(/return 'not_founder'/);
  });

  it("reads its own write back and refuses null input", () => {
    const fn = fnBody("set_channel_in_plan");
    expect(fn).toMatch(/select true into v_ok/);
    expect(fn).toMatch(/p_in_plan is null then\s+return 'failed'/);
  });

  it("commit_growth_plan's sweep leaves a founder add in the plan", () => {
    const fn = fnBody("commit_growth_plan");
    const sweep = fn.slice(fn.lastIndexOf("update tenant_channels"));
    expect(sweep).toMatch(/plan_selected_set_by is distinct from 'founder'/);
  });

  it("retire_growth_plan clears Zavi's picks but keeps founder adds", () => {
    const fn = code.slice(code.indexOf("create or replace function retire_growth_plan("));
    const sweep = fn.slice(fn.indexOf("update tenant_channels"));
    expect(sweep).toMatch(/set plan_selected\s+= false/);
    expect(sweep).toMatch(/plan_selected_set_by is distinct from 'founder'/);
  });

  it("every function pins search_path with pg_temp", () => {
    for (const name of ["set_channel_in_plan", "commit_growth_plan"]) {
      expect(fnBody(name)).toMatch(/set search_path = public, pg_temp/);
    }
    expect(code.slice(code.indexOf("create or replace function retire_growth_plan("))).toMatch(
      /set search_path = public, pg_temp/,
    );
  });

  it("set_channel_in_plan is service_role only", () => {
    expect(code).toMatch(
      /revoke all on function set_channel_in_plan\(uuid, text, boolean\)\s+from public, anon, authenticated;/,
    );
    expect(code).toMatch(
      /grant execute on function set_channel_in_plan\(uuid, text, boolean\)\s+to service_role;/,
    );
  });
});
