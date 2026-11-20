import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const BATCH = "20261011120000_media_charge_batch.sql";
const CLAIM = "20261011120100_starter_autostart_claim.sql";
const batch = readFileSync(join(MIG_DIR, BATCH), "utf8");
const claim = readFileSync(join(MIG_DIR, CLAIM), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

describe("media charge batch + starter claim migrations", () => {
  it("sort after every earlier migration", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all).toContain(BATCH);
    expect(all).toContain(CLAIM);
    expect(BATCH > "20261011100000_conductor_runs_build_app_per_site_indexes.sql").toBe(true);
    expect(CLAIM > BATCH).toBe(true);
  });

  it("charge_media_credits_batch: one transaction over the per-key charge, validated first, service-role only", () => {
    expect(batch).toMatch(/create or replace function public\.charge_media_credits_batch\(\s*p_tenant_id uuid,\s*p_run_id\s+uuid,\s*p_items\s+jsonb/);
    expect(batch).toContain("security definer set search_path = public, pg_temp");
    expect(batch).toContain("public.charge_media_credits(p_tenant_id, v_item->>'key', (v_item->>'cost_usd')::numeric, v_item->>'task', v_item->>'model', p_run_id)");
    expect(batch.indexOf("invalid item")).toBeLessThan(batch.indexOf("public.charge_media_credits(p_tenant_id"));
    expect(batch).not.toMatch(/exception\s+when/i);
    expect(batch).toContain("revoke all on function public.charge_media_credits_batch(uuid, uuid, jsonb) from public, anon, authenticated;");
    expect(batch).toContain("grant execute on function public.charge_media_credits_batch(uuid, uuid, jsonb) to service_role;");
    expect(batch).toContain("add column if not exists pending_charges jsonb");
  });

  it("starter_autostart_claims: one row per tenant (primary key), RLS on, no client access", () => {
    expect(claim).toMatch(/tenant_id\s+uuid primary key references public\.tenants\(id\) on delete cascade/);
    expect(claim).toContain("alter table public.starter_autostart_claims enable row level security;");
    expect(claim).toContain("revoke all on public.starter_autostart_claims from public, anon, authenticated;");
    expect(claim).not.toMatch(/create policy/);
  });

  it("claim_starter_autostart: insert-once on the key, owner check, tenant-scoped card, service-role only", () => {
    expect(claim).toContain("on conflict (tenant_id) do nothing;");
    expect(claim).toContain("return v_owner = p_action_id;");
    expect(claim).toContain("where id = p_action_id and tenant_id = p_tenant_id");
    expect(claim).toContain("revoke all on function public.claim_starter_autostart(uuid, uuid, uuid) from public, anon, authenticated;");
    expect(claim).toContain("grant execute on function public.claim_starter_autostart(uuid, uuid, uuid) to service_role;");
    expect(claim).toMatch(/where e\.event = 'approved' and e\.event_key like 'starter-%'/);
    const fn = claim.slice(claim.indexOf("create or replace function public.claim_starter_autostart"));
    expect(fn).toMatch(/coalesce\(\(select e\.action_id[\s\S]*e\.event_key like 'starter-%'[\s\S]*\), p_action_id\)/);
  });

  it("both RPCs and the table are in the tenant registries", () => {
    expect(registry).toMatch(/\n\s*charge_media_credits_batch: "p_tenant_id",/);
    expect(registry).toMatch(/\n\s*claim_starter_autostart: "p_tenant_id",/);
    expect(registry).toMatch(/\n\s*starter_autostart_claims: "tenant_id",/);
  });
});
