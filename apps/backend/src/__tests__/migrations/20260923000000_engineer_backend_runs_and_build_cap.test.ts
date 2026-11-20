import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20260923000000_engineer_backend_runs_and_build_cap.sql"), "utf-8");
const PRIOR = readFileSync(join(DIR, "20260922080000_build_stage_priced_as_product_builder.sql"), "utf-8");
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

function fn(src: string, name: string): string {
  const a = src.indexOf(`create or replace function ${name}(`);
  const b = src.indexOf("end $$;", a);
  if (a < 0 || b < 0) throw new Error(`${name} not found`);
  return src.slice(a, b + "end $$;".length);
}
const GUARD = "and not _is_engineer_backend_run(NEW.agent_slug, NEW.enqueued_by, NEW.trigger, NEW.payload)";

describe("engineer backend runs + build cap (20260923000000)", () => {
  it("mirrors isEngineerBackendRun: engineer, service-role row, non-chat trigger or server-built PR follow-up", () => {
    const f = CODE.slice(CODE.indexOf("function _is_engineer_backend_run("));
    expect(f).toMatch(/p_slug = 'engineer'/);
    expect(f).toMatch(/p_enqueued_by is null/);
    for (const t of ["chat", "slack", "teams", "telegram", "discord", "whatsapp", "email", "manual"]) {
      expect(f).toContain(`'${t}'`);
    }
    expect(f).toMatch(/p_payload->>'kind', ''\) = 'engineer_pr_followup'/);
  });

  it.each(["_trg_reserve_run_credits", "_trg_rereserve_run_credits"])(
    "%s is the 20260922080000 body plus exactly the engineer guard",
    (name) => {
      const next = fn(SQL, name);
      expect(next).toContain(GUARD);
      const stripped = next.replace(`\n     ${GUARD}`, "");
      expect(stripped).toBe(fn(PRIOR, name));
    },
  );

  it("claims one dispatch per build step, cascading with the conductor", () => {
    expect(CODE).toMatch(/create table if not exists conductor_dispatch_claims/);
    expect(CODE).toMatch(/conductor_run_id uuid not null references conductor_runs\(id\) on delete cascade,\s+dedup_key/);
    expect(CODE).toMatch(/primary key \(conductor_run_id, dedup_key\)/);
  });

  it("refunds once per key, never below zero, service role only", () => {
    expect(CODE).toMatch(/primary key \(conductor_run_id, refund_key\)/);
    const f = fn(SQL, "refund_conductor_budget");
    expect(f).toMatch(/on conflict do nothing/);
    expect(f).toMatch(/greatest\(0, spend_usd - p_amount_usd\)/);
    expect(CODE).toMatch(/grant execute on function refund_conductor_budget\(uuid, numeric, text\) to service_role;/);
    expect(CODE).toMatch(/revoke all on function refund_conductor_budget\(uuid, numeric, text\) from public, anon, authenticated;/);
    expect(CODE).toMatch(/revoke all on conductor_dispatch_claims from anon, authenticated;/);
    expect(CODE).toMatch(/revoke all on conductor_budget_refunds from anon, authenticated;/);
  });
});
