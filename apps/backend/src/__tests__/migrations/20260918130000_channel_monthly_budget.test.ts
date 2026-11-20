import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260918130000_channel_monthly_budget.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260918130000_channel_monthly_budget.sql", () => {
  it("adds a nullable monthly_budget_usd column", () => {
    expect(code).toMatch(/add column if not exists monthly_budget_usd numeric null/i);
  });

  it("is security definer with a pinned search_path including pg_temp", () => {
    expect(code).toMatch(/security definer set search_path = public, pg_temp/i);
  });

  it("refuses authenticated/anon callers and grants only service_role", () => {
    expect(code).toMatch(/revoke all on function set_channel_monthly_budget\(uuid, text, numeric\)\s+from public, anon, authenticated/i);
    expect(code).toMatch(/grant execute on function set_channel_monthly_budget\(uuid, text, numeric\)\s+to service_role/i);
    expect(code).not.toMatch(/grant execute on function set_channel_monthly_budget[^;]*authenticated/i);
  });

  it("reads its own write back", () => {
    expect(code).toMatch(/select true into v_exists/i);
    expect(code).toMatch(/monthly_budget_usd is not distinct from p_usd/i);
  });

  it("refuses a null tenant, an empty slug and a negative amount", () => {
    expect(code).toMatch(/p_tenant_id is null/i);
    expect(code).toMatch(/nullif\(trim\(p_channel_slug\), ''\) is null/i);
    expect(code).toMatch(/p_usd < 0/i);
  });
});
