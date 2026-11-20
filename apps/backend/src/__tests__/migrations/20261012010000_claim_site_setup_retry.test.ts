import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261012010000_claim_site_setup_retry.sql"), "utf-8");
const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const body = code.slice(code.indexOf("create or replace function public.claim_site_setup_retry("), code.indexOf("end $$;"));

describe("Retry of a failed site setup claims the run under the build lock (20261012010000)", () => {
  it("takes the per-tenant build lock before reading anything, and locks this tenant's run", () => {
    const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0))");
    expect(lock).toBeGreaterThan(0);
    expect(body.indexOf("from conductor_runs r")).toBeGreaterThan(lock);
    expect(body).toMatch(/r\.id = p_run_id\s+and r\.tenant_id = p_tenant_id\s+and r\.kind = 'build_app'\s+for update/);
  });

  it("only a failed, never-paused provision_failed run with a retryable setup marker is resumable", () => {
    expect(body).toMatch(/v_run\.status <> 'failed'/);
    expect(body).toMatch(/v_run\.paused_at is not null/);
    expect(body).toMatch(/coalesce\(v_run\.failure_class, ''\) <> 'provision_failed'/);
    expect(body).toMatch(/e\.node->'payload'->'site_setup'->'retryable' = 'true'::jsonb/);
  });

  it("compare-and-set, one build at a time, and the site must be this run's own, still being set up, with no provider being cleaned up", () => {
    const resumed = body.indexOf("return 'resumed';");
    for (const guard of ["return 'changed_concurrently';", "return 'another_build_running';", "return 'site_gone';"]) {
      expect(body.indexOf(guard), guard).toBeGreaterThan(0);
      expect(body.indexOf(guard), guard).toBeLessThan(resumed);
    }
    expect(body).toMatch(/v_run\.updated_at is distinct from p_expected_updated_at/);
    expect(body).toMatch(/o\.status in \('provisioning', 'active'\)/);
    expect(body).toMatch(/s\.tenant_id = p_tenant_id\s+and s\.root_conductor_run_id = p_run_id\s+and \(p_site_id is null or s\.id = p_site_id\)\s+for update/);
    expect(body).toMatch(/if p_site_id is not null and v_site_id is null then\s+return 'site_gone';/);
    expect(body).toMatch(/v_status not in \('provisioning', 'building'\)/);
    expect(body).toMatch(/sp\.state not in \('claimed', 'created'\)/);
  });

  it("puts the run back to 'provisioning' (never 'active': the conductor must not tick a setup) and only freshens the site", () => {
    expect(body).toMatch(/set status = 'provisioning', failure_class = null, failure_reason = null, updated_at = now\(\)/);
    expect(body).not.toMatch(/status = 'active'/);
    expect(body.match(/^\s*update\s/gm)).toHaveLength(2);
    expect(body).toMatch(/update public\.sites set updated_at = now\(\)\s+where id = v_site_id and tenant_id = p_tenant_id;/);
    expect(body.indexOf("update public.sites")).toBeGreaterThan(body.lastIndexOf("return 'site_gone';"));
  });

  it("site_claim_stranded re-checks age AND a dead run in the same statement as the move to 'deleting'", () => {
    const fn = code.slice(code.indexOf("create or replace function public.site_claim_stranded("));
    const upd = fn.slice(fn.indexOf("update public.sites s"), fn.indexOf("return found;"));
    expect(upd).toMatch(/set status = 'deleting'/);
    expect(upd).toMatch(/s\.tenant_id = p_tenant_id/);
    expect(upd).toMatch(/s\.status in \('provisioning', 'building'\)/);
    expect(upd).toMatch(/s\.updated_at < p_cutoff/);
    expect(upd).toMatch(/r\.status in \('provisioning', 'active', 'paused'\)/);
    expect(SQL).toMatch(/grant execute on function public\.site_claim_stranded\(uuid, uuid, timestamptz, text\) to service_role;/);
  });

  it("site_reaper_candidates keeps its prior branches verbatim and adds only provider-less stranded sites (DB-fn-rebuild gate)", () => {
    const prior = readFileSync(join(DIR, "20261008094400_site_reaper.sql"), "utf-8");
    const priorFn = prior.slice(prior.indexOf("create or replace function public.site_reaper_candidates("), prior.indexOf("revoke all on function public.site_reaper_candidates"));
    const fn = code.slice(code.indexOf("create or replace function public.site_reaper_candidates("));
    const norm = (s: string) => s.replace(/\s+/g, " ");
    for (const piece of [
      "s.status in ('fell_back_old', 'failed', 'deleting', 'deleted')",
      "p.state in ('cleanup_pending', 'delete_issuing')",
      "not (p.ref @> '{\"retained\": true}'::jsonb)",
      "order by s.updated_at",
    ]) {
      expect(norm(priorFn)).toContain(piece);
      expect(norm(fn)).toContain(piece);
    }
    expect(norm(fn)).toMatch(/and not exists \(select 1 from public\.site_providers p where p\.site_id = s\.id and p\.tenant_id = s\.tenant_id\)/);
    expect(norm(fn)).toMatch(/s\.status = 'deleting' and s\.updated_at < p_cutoff and not exists \(select 1 from public\.site_providers p/);
    expect(SQL).toMatch(/grant execute on function public\.site_reaper_candidates\(timestamptz, int\) to service_role;/);
  });

  it("is security definer with a pinned search_path and service_role only; continue_paused_build is untouched", () => {
    expect(SQL).toMatch(/security definer set search_path = public, pg_temp/);
    expect(SQL).toMatch(/revoke all on function public\.claim_site_setup_retry\(uuid, uuid, timestamptz, uuid\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function public\.claim_site_setup_retry\(uuid, uuid, timestamptz, uuid\) to service_role;/);
    expect(code).not.toMatch(/create or replace function (public\.)?continue_paused_build/);
  });
});
