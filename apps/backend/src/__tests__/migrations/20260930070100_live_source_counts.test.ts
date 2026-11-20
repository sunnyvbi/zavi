import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260930070100_live_source_counts.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

describe(FILE, () => {
  it("has a version no other migration uses", () => {
    const version = FILE.split("_")[0];
    const same = readdirSync(MIG_DIR).filter((x) => x.endsWith(".sql") && x !== FILE && x.split("_")[0] === version);
    expect(same).toEqual([]);
  });
  it("tables: RLS on, no policies, nothing granted to browser roles", () => {
    for (const t of ["live_source_hourly", "live_source_push"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${t} from public, anon, authenticated;`);
      expect(sql).not.toMatch(new RegExp(`create policy[^;]*on public\\.${t}`));
      expect(registry).toMatch(new RegExp(`\\n\\s*${t}: "tenant_id",`));
    }
  });
  it("the replace RPC is service-role only, tenant-scoped, and ignores rows outside its window", () => {
    expect(sql).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toContain("where tenant_id = p_tenant_id and hour >= p_from and hour < p_to;");
    expect(sql).toContain("where (r->>'hour')::timestamptz >= p_from and (r->>'hour')::timestamptz < p_to\n     and m.key = any(p_metrics);");
    expect(sql).toContain("jsonb_each(r->'metrics')");
    expect(sql).toContain("and m.key = any(p_metrics);");
    expect(sql).toContain("metrics text[] not null default '{}'");
    expect(sql).toContain("primary key (tenant_id, hour, metric)");
    expect(sql).toContain("check (metric ~ '^[a-z][a-z0-9_]{0,39}$')");
    expect(sql).toContain("revoke all on function public.live_source_replace(uuid,timestamptz,timestamptz,text[],jsonb) from public, anon, authenticated;");
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(registry).toMatch(/\n\s*live_source_replace: "p_tenant_id",/);
    expect(sql).toContain("where tenant_id = p_tenant_id and covered_to > p_to) then\n    return -1;");
  });
});
