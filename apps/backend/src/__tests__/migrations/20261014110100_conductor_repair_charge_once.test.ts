import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261014110100_conductor_repair_charge_once.sql";
const code = readFileSync(join(DIR, FILE), "utf-8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

function fn(name: string): string {
  const start = code.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return code.slice(start, code.indexOf("end $$;", start));
}

describe("a repair is charged at most once per attempt (20261014110100)", () => {
  it("has a unique version", () => {
    const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]);
    expect(versions.filter((v) => v === "20261014110100")).toHaveLength(1);
  });

  it("the charge locks the run row, short-circuits on a recorded key, and records the key with the charge", () => {
    const f = fn("consume_conductor_budget_once");
    const lock = f.indexOf("for update");
    const exists = f.indexOf("already_charged");
    const charge = f.indexOf("set spend_usd = r.spend_usd + p_estimate_usd");
    const record = f.indexOf("insert into public.conductor_budget_charges");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(exists);
    expect(exists).toBeLessThan(charge);
    expect(charge).toBeLessThan(record);
    expect(f).toContain("and r.status not in ('halted', 'done', 'failed') and (r.max_usd is null or r.spend_usd + p_estimate_usd <= r.max_usd)");
    expect(f).toContain("set status = 'halted', updated_at = now()");
  });

  it("the refund deletes the key first, so it gives back at most once and never below zero", () => {
    const f = fn("refund_conductor_budget_once");
    expect(f.indexOf("delete from public.conductor_budget_charges")).toBeLessThan(f.indexOf("update public.conductor_runs"));
    expect(f).toContain("if v_amount is null then return false;");
    expect(f).toContain("greatest(0, r.spend_usd - v_amount)");
  });

  it("everything is service-role only (table RLS on, functions revoked from public/anon/authenticated)", () => {
    expect(code).toContain("alter table public.conductor_budget_charges enable row level security;");
    expect(code).toContain("revoke all on public.conductor_budget_charges from public, anon, authenticated;");
    for (const sig of ["consume_conductor_budget_once(uuid, numeric, text)", "refund_conductor_budget_once(uuid, text)"]) {
      expect(code).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(code).toMatch(/security definer set search_path = pg_catalog, pg_temp/);
  });
});
