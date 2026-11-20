import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(dir, "20261012130100_site_reaper_failed_claim.sql"), "utf-8");
const PRIOR = readFileSync(join(dir, "20261012010000_claim_site_setup_retry.sql"), "utf-8");
const fn = (src: string, name: string) => {
  const start = src.indexOf(`create or replace function public.${name}(`);
  return src.slice(start, src.indexOf("end $$;", start) + "end $$;".length);
};

describe("20261012130100_site_reaper_failed_claim.sql", () => {
  it("site_claim_failed moves only this tenant's old, never-served failed site with a dead run, in one statement", () => {
    const f = fn(SQL, "site_claim_failed");
    const update = f.slice(f.indexOf("update public.sites s"), f.indexOf("return found;"));
    for (const clause of [
      "s.id = p_site_id",
      "s.tenant_id = p_tenant_id",
      "s.status = 'failed'",
      "s.updated_at < p_cutoff",
      "s.live_sha is null",
      "s.live_deploy_id is null",
      "r.status in ('provisioning', 'active', 'paused')",
    ]) {
      expect(update, clause).toContain(clause);
    }
    expect(update).toContain("set status = 'deleting'");
    expect(f).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
    expect(SQL).toContain("revoke all on function public.site_claim_failed(uuid, uuid, timestamptz, text) from public, anon, authenticated;");
    expect(SQL).toContain("grant execute on function public.site_claim_failed(uuid, uuid, timestamptz, text) to service_role;");
  });

  it("site_reaper_candidates is the 20261012010000 body plus only the added filter", () => {
    const now = fn(SQL, "site_reaper_candidates");
    const stripped = now
      .replace("     where ((\n", "     where (\n")
      .replace(/       \)\)\n       -- Never a failed \/ stranded site[\s\S]*?\n       \)\n     order by/, "       )\n     order by");
    expect(stripped).toBe(fn(PRIOR, "site_reaper_candidates"));
    expect(now).toMatch(/and not \(\s+s\.status in \('failed', 'provisioning', 'building'\)\s+and \(\s+s\.live_sha is not null\s+or s\.live_deploy_id is not null/);
    expect(SQL).toContain("grant execute on function public.site_reaper_candidates(timestamptz, int) to service_role;");
  });
});
