import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261021094500_site_vision_fix_free.sql"), "utf-8");
const PRIOR = readFileSync(join(DIR, "20261019120000_brief_journey_fix_free.sql"), "utf-8");

const fn = (sql: string, name: string) => {
  const m = sql.match(new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\nend \\$\\$;`));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
};
const EARLY_RETURN = `  -- A deploy's one screenshot-review fix pass is paid by Zavi: no reserve, no
  -- charge. Before the credits switch, so the pass is bound to its run even
  -- while credits are off (an unbound token must never be left for another row).
  if _is_site_vision_fix_run(NEW.tenant_id, NEW.id, NEW.agent_slug, NEW.payload,
                             NEW.trigger, NEW.enqueued_by) then
    return null;
  end if;
`;

describe("free site vision fix (20261021094500)", () => {
  it("one claim per conductor run + site, for a run of this tenant only", () => {
    expect(SQL).toMatch(/primary key \(conductor_run_id, site_id\)/);
    const claim = fn(SQL, "claim_site_vision_fix_status");
    expect(claim).toMatch(/from conductor_runs c where c\.id = p_conductor_run_id and c\.tenant_id = p_tenant_id/);
    expect(claim).toMatch(/on conflict \(conductor_run_id, site_id\) do nothing/);
    expect(claim).toMatch(/token = gen_random_uuid\(\)|gen_random_uuid\(\)\)/);
  });

  it("the waiver binds to the first run that carries the token, run, site and attempt, and refuses a marked run it cannot bind", () => {
    const w = fn(SQL, "_is_site_vision_fix_run");
    expect(w).toMatch(/p_enqueued_by is not null or p_trigger is distinct from 'a2a'/);
    expect(w).toMatch(/p_agent_slug is distinct from 'engineer'/);
    expect(w).toMatch(/p_payload->>'vision_fix' is distinct from 'true'/);
    for (const k of ["vision_fix_token", "site_id", "build_conductor_run_id", "repair_attempt"]) expect(w).toContain(`p_payload->>'${k}'`);
    expect(w).toMatch(/v\.tenant_id = p_tenant_id/);
    expect(w).toMatch(/\(v\.agent_run_id is null or v\.agent_run_id = p_run_id\)/);
    expect(w).toMatch(/raise exception 'site_vision_fix_unbound'/);
  });

  it("release gives back only an unbound reservation with its exact token", () => {
    const r = fn(SQL, "release_site_vision_fix");
    expect(r).toMatch(/token = p_token/);
    expect(r).toMatch(/agent_run_id is null/);
  });

  it("both reserve triggers are the prior bodies plus the early return, before the credits switch, nothing else", () => {
    for (const t of ["_trg_reserve_run_credits", "_trg_rereserve_run_credits"]) {
      const now = fn(SQL, t);
      expect(now).toContain(EARLY_RETURN + "  if not _credits_enforced(NEW.tenant_id) then");
      expect(now.replace(EARLY_RETURN, "")).toBe(fn(PRIOR, t));
    }
  });

  it("every function is a pinned security definer callable by the service role only", () => {
    for (const name of ["claim_site_vision_fix_status", "release_site_vision_fix", "_is_site_vision_fix_run"]) {
      expect(fn(SQL, name)).toMatch(/security definer set search_path = public, pg_temp/);
    }
    expect(SQL).toMatch(/revoke all on function claim_site_vision_fix_status\(uuid, uuid, uuid, integer\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/revoke all on function release_site_vision_fix\(uuid, uuid, uuid, uuid\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/revoke all on function _is_site_vision_fix_run\(uuid, uuid, text, jsonb, text, uuid\) from public, anon, authenticated;/);
    expect(SQL).not.toMatch(/grant execute on function _is_site_vision_fix_run/);
    expect(SQL).toMatch(/revoke all on table public\.site_vision_fix_claims from anon, authenticated;/);
  });
});
