import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261010160000_site_shard_autoprovision.sql";
const sql = readFileSync(join(dir, FILE), "utf-8");

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("end $$;", start));
}

describe(FILE, () => {
  it("is the newest migration and runs after the shard registry + graduation it reads", () => {
    const v = (f: string) => Number(f.split("_")[0]);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    for (const f of ["20261010090000_site_shards.sql", "20261010120000_site_graduation.sql", "20261010140500_site_host_projection.sql"]) {
      expect(files).toContain(f);
      expect(v(FILE)).toBeGreaterThan(v(f));
    }
    expect(files.filter((f) => v(f) === v(FILE))).toEqual([FILE]);
  });

  it("is one transaction and additive", () => {
    expect(sql.trimStart().split("\n").find((l) => l.trim() && !l.startsWith("--"))).toBe("begin;");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/drop (table|column|function)/i);
  });

  it("both tables are RLS-on and closed to every client role", () => {
    for (const t of ["site_shard_autoprov", "site_shard_autoprov_ledger", "site_shard_provision_guards"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${t} from public, anon, authenticated;`);
    }
  });

  it.each([
    ["site_shard_autoprov_claim", "text, text, integer, boolean, text, text, integer"],
    ["site_shard_autoprov_finish", "uuid, text, text"],
    ["site_shard_autoprov_set_paused", "text, boolean, text, text"],
    ["site_shard_autoprov_status", "text, integer"],
    ["site_shard_autoprov_notice", "text, text"],
    ["site_shard_guard_acquire", "text, text, integer"],
    ["site_shard_guard_release", "text, text"],
    ["site_shard_guard_begin_create", "text, text, text, boolean, integer, integer"],
    ["site_shard_guard_end_create", "text, text, text"],
    ["site_shard_guard_staff_recover", "text, integer, text"],
  ])("%s is security definer, pinned search_path, service_role only", (name, sig) => {
    const body = fnBody(name);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
  });

  it("claim: serialized per env (row lock), one in flight, the cap clamped to 10 (override ceiling 25), name + registry row in the same transaction", () => {
    const b = fnBody("site_shard_autoprov_claim");
    expect(b).toContain("where a.env = p_env for update;");
    expect(b).toContain("v_max := least(greatest(coalesce(p_max_per_day, 0), 0), 10);");
    expect(b).toContain("v_max := 25;");
    expect(b).toMatch(/if p_source = 'staff' and coalesce\(p_override, false\) then/);
    const guard = b.indexOf("s.state = 'provisioning'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(b.indexOf("insert into public.site_shards"));
    expect(b.indexOf("l.kind = 'create'", guard + 1)).toBeLessThan(b.indexOf("insert into public.site_shards"));
    expect(b.indexOf("p_source = 'auto' and v_state.paused")).toBeLessThan(guard);
    expect(b).toContain("'in_progress_manual'");
    expect(b).toContain("(now() at time zone 'utc')::date");
    expect(b).toMatch(/l\.day = v_day and l\.kind = 'create'/);
    expect(b).toContain("insert into public.site_shards (env, name, region, is_canary)");
  });

  it("finish: idempotent per ledger row; 2 failures in a row pause it (the breaker)", () => {
    const b = fnBody("site_shard_autoprov_finish");
    expect(b).toContain("if v_row.status <> 'started' then");
    expect(b).toContain("consecutive_failures = consecutive_failures + 1");
    expect(b).toContain("v_state.consecutive_failures >= 2 and not v_state.paused");
    expect(b).toContain("paused = true, paused_by = 'breaker'");
  });

  it("guard: an expired lease is NEVER taken over (needs_staff); the gate is re-checked under the env lock in the transaction that marks 'creating'", () => {
    const acq = fnBody("site_shard_guard_acquire");
    expect(acq).toContain("-- Expired: its holder may still be inside a provider call. Never taken over.");
    expect(acq).not.toMatch(/until < now\(\)\s+or/);
    const b = fnBody("site_shard_guard_begin_create");
    const envLock = b.indexOf("where a.env = v_env for update;");
    expect(envLock).toBeGreaterThan(-1);
    expect(envLock).toBeLessThan(b.indexOf("for update;", envLock + 1) + 1);
    expect(b.indexOf("v_state.paused")).toBeLessThan(b.indexOf("set create_state = 'creating'"));
    expect(b.indexOf("'settling'")).toBeLessThan(b.indexOf("set create_state = 'creating'"));
    expect(b).toContain("g.create_attempts >= 2");
  });

  it("resume resets the breaker", () => {
    expect(fnBody("site_shard_autoprov_set_paused")).toContain("consecutive_failures = case when p_paused then consecutive_failures else 0 end");
  });
});
