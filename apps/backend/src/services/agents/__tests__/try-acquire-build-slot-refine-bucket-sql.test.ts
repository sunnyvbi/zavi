import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");
function mig(substr: string): string {
  const f = readdirSync(MIG_DIR).find((x) => x.includes(substr));
  if (!f) throw new Error(`migration not found: ${substr} in ${MIG_DIR}`);
  return readFileSync(join(MIG_DIR, f), "utf8");
}

describe("Bug #1 — try_acquire_build_slot refine daily bucket discriminator", () => {
  const sql = mig("refine_daily_bucket_discriminator");

  it("adds a DEFAULTED p_is_refine param (no deploy window where old 6-arg calls break)", () => {
    expect(sql).toMatch(/p_is_refine\s+boolean\s+default\s+false/i);
    expect(sql).toMatch(/drop function if exists try_acquire_build_slot\(uuid, text, numeric, numeric, int, numeric\)/i);
  });

  it("in-flight (double-build) guard excludes company_goal, NULL-safely, still on provisioning+active", () => {
    expect(sql).toMatch(/status in \('provisioning', 'active'\)/);
    expect(sql).toMatch(/kind is distinct from 'company_goal'/);
  });

  it("daily-count guard counts the acquire's OWN bucket: build_app rows whose refine_mode matches p_is_refine", () => {
    expect(sql).toMatch(/kind = 'build_app'/);
    expect(sql).toMatch(/goal_graph #>> '\{0,payload,refine_mode\}'/);
    expect(sql).toMatch(/coalesce\(\(goal_graph #>> '\{0,payload,refine_mode\}'\)::boolean, false\) = p_is_refine/);
  });

  it("does NOT widen the kind CHECK and keeps the INSERT kind-default (zero blast radius)", () => {
    expect(sql).not.toMatch(/check \(kind in/i);
    expect(sql).not.toMatch(/kind\s*=\s*'refine'/i);
    expect(sql).not.toMatch(/'build_app'\s*,\s*'refine'/i);
    expect(sql).toMatch(/insert into conductor_runs \(tenant_id, objective, status, max_usd, goal_graph\)/);
  });

  it("preserves the advisory lock + the atomic $-cap RPC intact", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('build:' \|\| p_tenant_id::text, 0\)\)/);
    expect(sql).toMatch(/consume_budget_or_reject\(/);
    expect(sql.indexOf("raise exception 'daily_limit'")).toBeLessThan(sql.indexOf("consume_budget_or_reject("));
  });

  it("security-definer hygiene: revokes client roles + grants only service_role on the 7-arg signature", () => {
    expect(sql).toMatch(/security definer set search_path = public/);
    expect(sql).toMatch(/revoke all on function try_acquire_build_slot\(uuid, text, numeric, numeric, int, numeric, boolean\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function try_acquire_build_slot\(uuid, text, numeric, numeric, int, numeric, boolean\) to service_role/);
  });
});
