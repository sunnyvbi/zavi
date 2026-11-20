import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260528214229_agent_decisions_not_taken.sql"),
  "utf-8",
);

describe("20260528214229_agent_decisions_not_taken.sql", () => {
  it("creates the decision_rejection_type enum with all 6 values", () => {
    expect(sql).toMatch(/create type decision_rejection_type as enum/i);
    for (const v of [
      "autonomy_forbidden",
      "dedup_suppressed_24h",
      "cap_exceeded",
      "condition_unmet",
      "founder_override",
      "agent_not_emitted",
    ]) {
      expect(sql).toContain(`'${v}'`);
    }
  });

  it("creates agent_decisions_not_taken with a nullable agent_run_id (pre-run refusals)", () => {
    expect(sql).toMatch(/create table agent_decisions_not_taken/i);
    expect(sql).toMatch(/agent_run_id\s+uuid,/i);
    expect(sql).toMatch(/rejection_type decision_rejection_type not null/i);
  });

  it("RLS member-select + service-role-only writes (mirror 0044)", () => {
    expect(sql).toMatch(/alter table agent_decisions_not_taken enable row level security/i);
    expect(sql).toMatch(/create policy agent_decisions_not_taken_tenant_select/i);
    expect(sql).toMatch(/revoke insert, update, delete on agent_decisions_not_taken from authenticated, anon/i);
    expect(sql).toMatch(/grant all on agent_decisions_not_taken to service_role/i);
  });

  it("stores no raw payload column — only C14-safe fields (enum + reason_code + ids/class)", () => {
    expect(sql).not.toMatch(/\b(payload|body|raw_input|prompt)\b\s+(jsonb|text)/i);
    expect(sql).toMatch(/reason_code\s+text/i);
  });

  it("is net-new (no CREATE OR REPLACE FUNCTION) — DB-fn-rebuild gate exempt", () => {
    const ddl = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(ddl).not.toMatch(/create or replace function/i);
  });
});
