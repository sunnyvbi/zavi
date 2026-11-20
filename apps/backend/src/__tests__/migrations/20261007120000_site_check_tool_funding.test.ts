import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const raw = readFileSync(join(dir, "20261007120000_site_check_tool_funding.sql"), "utf8");
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();
const fn = sql.slice(sql.indexOf("create or replace function public.start_card_claim("), sql.indexOf("$$;", sql.indexOf("start_card_claim(")));
const SIG = "text, timestamptz, text, jsonb, text, uuid, date, numeric, text, uuid, uuid, text, jsonb, int";

describe("20261007120000_site_check_tool_funding", () => {
  it("existing rows stay public-budget cards; RLS untouched", () => {
    expect(sql).toContain("add column if not exists funding_kind text not null default 'public_budget'");
    expect(sql).not.toMatch(/create policy|disable row level security|grant [^;]* to (anon|authenticated)/);
  });

  it("a tenant card must carry its full funding ref and never a public budget day", () => {
    expect(sql).toMatch(/funding_kind = 'tenant_credits'[\s\S]*funding_tenant_id is not null[\s\S]*requested_by_run_id is not null[\s\S]*tool_call_id is not null[\s\S]*budget_day is null/);
    expect(sql).toContain("create unique index if not exists start_cards_tool_call_uq");
  });

  it("start_card_claim is service_role only with a pinned search_path", () => {
    expect(fn).toContain("set search_path = public, pg_temp");
    expect(sql).toContain(`revoke all on function public.start_card_claim(${SIG}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.start_card_claim(${SIG}) to service_role;`);
  });

  it("the dedupe read and the insert both happen AFTER the domain lock (no SELECT-then-INSERT race)", () => {
    const lock = fn.indexOf("pg_advisory_xact_lock(hashtextextended('start_card_domain:'");
    const read = fn.indexOf("where domain = p_domain");
    const insert = fn.indexOf("insert into start_cards");
    expect(lock).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(read);
  });

  it("a tool call re-checks the run's tenant (C8), takes the run lock first, and enforces the cap before inserting", () => {
    expect(fn).toMatch(/v_tenant is distinct from p_tenant_id then\s+raise exception 'tenant_mismatch'/);
    const runLock = fn.indexOf("'start_card_run:'");
    const domainLock = fn.indexOf("'start_card_domain:'");
    expect(runLock).toBeGreaterThan(0);
    expect(runLock).toBeLessThan(domainLock);
    expect(fn.indexOf("'run_cap'")).toBeLessThan(fn.indexOf("insert into start_cards"));
    expect(fn.indexOf("'same_call'")).toBeLessThan(fn.indexOf("insert into start_cards"));
  });

  it("a run with a Stop pending cannot claim a paid card, and the run cap is 1 whatever is passed", () => {
    expect(fn).toMatch(/select tenant_id, status, coalesce\(stop_requested, false\)/);
    expect(fn).toMatch(/v_run_st is distinct from 'running' or v_stop then\s+return jsonb_build_object\('outcome', 'run_not_running'\)/);
    expect(fn).toContain("v_count >= least(coalesce(p_run_cap, 1), 1)");
  });

  it("a replay gets its same_call card BEFORE the running/stop check (the receipt survives a stopped run)", () => {
    const tenantChk = fn.indexOf("'tenant_mismatch'");
    const runLock = fn.indexOf("'start_card_run:'");
    const sameCall = fn.indexOf("'same_call'");
    const notRunning = fn.indexOf("'run_not_running'");
    expect(tenantChk).toBeGreaterThan(0);
    expect(runLock).toBeGreaterThan(tenantChk);
    expect(sameCall).toBeGreaterThan(runLock);
    expect(notRunning).toBeGreaterThan(sameCall);
    expect(notRunning).toBeLessThan(fn.indexOf("'start_card_domain:'"));
  });
});
