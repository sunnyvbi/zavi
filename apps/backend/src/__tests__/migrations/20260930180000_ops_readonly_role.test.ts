import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260930180000_ops_readonly_role.sql"),
  "utf8",
);
const viewBody = (name: string) => {
  const start = sql.indexOf(`create or replace view ops.${name}`);
  return sql.slice(start, sql.indexOf(";", start));
};

describe("20260930180000_ops_readonly_role.sql", () => {
  it("creates a login role that is read-only with a 15s statement timeout", () => {
    expect(sql).toMatch(/create role zavi_ops login noinherit/i);
    expect(sql).toMatch(/alter role zavi_ops set statement_timeout = '15s'/i);
    expect(sql).toMatch(/alter role zavi_ops set default_transaction_read_only = on/i);
    expect(sql).toMatch(/alter role zavi_ops set idle_in_transaction_session_timeout = '30s'/i);
  });

  it("no ops view reads a large value, only its size", () => {
    const big = ["prompt_snapshot", "raw_response_text", "tool_calls", "parsed", "reasoning_text",
      "output_text", "payload", "body_markdown", "outcome"];
    for (const v of ["agent_runs", "tenants", "memory_note"]) {
      const body = viewBody(v).replace(/pg_column_size\([a-z_]+\)/g, "");
      for (const col of big) expect(body, `${v}.${col}`).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(viewBody("agent_runs")).toMatch(/pg_column_size\(prompt_snapshot\) as prompt_bytes/);
    expect(viewBody("agent_runs")).toMatch(/case when pg_column_size\(error\) <= 2000 then error end as error/);
  });

  it("only zavi_ops can use the ops schema", () => {
    expect(sql).toMatch(/revoke all on schema ops from public, anon, authenticated/i);
    expect(sql).toMatch(/grant usage on schema ops to zavi_ops/i);
    expect(sql).toMatch(/grant select on all tables in schema ops to zavi_ops/i);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated|service_role)\b/i);
  });

  it("does not alter Supabase-managed roles", () => {
    expect(sql).not.toMatch(/alter role (authenticator|authenticated|anon|service_role|postgres)\b/i);
  });
});
