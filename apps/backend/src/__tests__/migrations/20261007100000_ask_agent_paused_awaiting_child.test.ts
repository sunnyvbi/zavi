import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261007100000_ask_agent_paused_awaiting_child.sql"), "utf8");
const prior = readFileSync(
  join(dir, "20260704230000_credit_finalize_include_paused_awaiting_approval.sql"),
  "utf8",
);
const fnOf = (src: string) => {
  const at = src.indexOf("create or replace function _trg_finalize_run_credits()");
  return src.slice(at, src.indexOf("$$;", at));
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("20261007100000_ask_agent_paused_awaiting_child", () => {
  it("creates agent_asks with RLS on and no policies (service-role only)", () => {
    expect(sql).toMatch(/create table if not exists agent_asks \(/);
    expect(sql).toMatch(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/);
    expect(sql).toMatch(/alter table agent_asks enable row level security;/);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("one ask per parent run, one per child", () => {
    expect(sql).toMatch(/create unique index if not exists agent_asks_parent_uq on agent_asks \(parent_run_id\)/);
    expect(sql).toMatch(/create unique index if not exists agent_asks_child_uq\s+on agent_asks \(child_run_id\)/);
  });

  it("the continuation claim column only takes the two outcomes", () => {
    expect(sql).toMatch(/outcome\s+text check \(outcome in \('answer', 'timeout'\)\)/);
  });

  it("the finalize trigger settles running → paused_awaiting_child as a success", () => {
    const body = fnOf(sql);
    expect(body).toMatch(/NEW\.status in \([^)]*'paused_awaiting_child'[^)]*\)/);
    expect(body).toMatch(/case when NEW\.status = 'paused_awaiting_child' then 'success' else NEW\.status end/);
  });

  it("keeps the OLD guard, so the later paused → success flip never re-finalizes (no double charge)", () => {
    const body = fnOf(sql);
    expect(body).toMatch(/OLD\.status in \('queued','running','blocked'\)/);
    expect(body).not.toMatch(/OLD\.status in \([^)]*paused/);
    expect(sql).not.toMatch(/_trg_rereserve_run_credits/);
    expect(sql).not.toMatch(/create or replace function finalize_run_credits/);
  });

  it("is the 20260704230000 body with only the child status + reason mapping + pg_temp changed", () => {
    const stripped = fnOf(sql)
      .replace(",'paused_awaiting_child')", ")")
      .replace("set search_path = public, pg_temp", "set search_path = public")
      .replace(
        /perform finalize_run_credits\(\s*NEW\.id,\s*NEW\.cost_usd,\s*case when NEW\.status = 'paused_awaiting_child' then 'success' else NEW\.status end\s*\);/,
        "perform finalize_run_credits(NEW.id, NEW.cost_usd, NEW.status);",
      );
    expect(norm(stripped)).toBe(norm(fnOf(prior)));
  });
});
