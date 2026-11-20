import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261012090000_site_shard_metrics_freshness.sql";
const sql = readFileSync(join(dir, FILE), "utf-8");

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end);
}

describe(FILE, () => {
  it("runs after the registry, graduation and autoprovision migrations it redefines / reads; unique version", () => {
    const v = (f: string) => Number(f.split("_")[0]);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    for (const f of ["20261010090000_site_shards.sql", "20261010120000_site_graduation.sql", "20261010160000_site_shard_autoprovision.sql", "20261012020000_site_kernel_provisions.sql", "20261012050000_site_validation_shards_test_sites.sql"]) {
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

  it("the placement log and rollout locks are RLS-on and closed to client roles", () => {
    for (const t of ["site_shard_placements", "site_shard_rollout_locks"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${t} from public, anon, authenticated;`);
    }
  });

  it.each([
    ["site_shard_metrics_fresh", "public.site_shards"],
    ["site_shard_load", "public.site_shards"],
    ["site_shard_record_metrics", "uuid, jsonb"],
    ["site_backend_place", "uuid, uuid, text"],
    ["site_shard_placement_pause", "uuid, text, integer"],
    ["site_shard_placement_resume", "uuid, text"],
    ["site_shard_rollout_claim", "text, text, integer"],
    ["site_shard_rollout_release", "text, text"],
    ["site_shard_capacity_inputs", "text"],
    ["site_shard_metrics_alert_claim", "uuid, text, integer"],
  ])("%s is security definer, pinned search_path, service_role only", (name, sig) => {
    const body = fnBody(name);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
  });

  it("FAIL CLOSED: placement requires fresh metrics on all three sources and no live pause, in BOTH the pick and the capacity re-check", () => {
    const fresh = fnBody("site_shard_metrics_fresh");
    expect(fresh).toContain("then s.site_count < 25 and s.created_at > now() - interval '24 hours'");
    expect(fresh).toContain("coalesce(s.m_db_at > now() - make_interval(secs => s.metrics_max_age_s), false)");
    expect(fresh).toContain("('gateway' = any(s.m_unconfigured) or coalesce(s.m_gateway_at > now() - make_interval(secs => s.metrics_max_age_s), false))");
    expect(fresh).toContain("('cpu' = any(s.m_unconfigured) or coalesce(s.m_cpu_at > now() - make_interval(secs => s.metrics_max_age_s), false))");
    const place = fnBody("site_backend_place");
    expect(place.match(/public\.site_shard_metrics_fresh\(sh\)\n/g)).toHaveLength(2);
    expect(place.match(/sh\.placement_paused_until is null or sh\.placement_paused_until <= now\(\)/g)).toHaveLength(2);
    expect(place.match(/sh\.dedicated_site_id is null/g)?.length).toBeGreaterThanOrEqual(2);
    expect(place).toContain("if exists (select 1 from public.site_kernel_provisions k where k.site_id = p_site_id) then");
    expect(place.match(/sh\.purpose = 'pool'/g)?.length).toBeGreaterThanOrEqual(4);
    expect(place).toContain("if v_shard.purpose <> 'pool' then");
    expect(fnBody("site_shard_record_metrics").match(/v_row\.purpose = 'pool'/g)).toHaveLength(2);
    expect(place).toContain("pg_advisory_xact_lock");
    expect(place).toContain("where sh.id = v_shard.id and sh.state = 'open' and sh.purpose = 'pool' and sh.site_count < sh.max_sites");
    expect(place).toContain("insert into public.site_shard_placements (env, shard_id) values (p_env, v_shard.id);");
    expect(place).toMatch(/no shard capacity in % \(open shards with stale metrics: %, placement paused: %\)/);
  });

  it("record_metrics: an absent source keeps its time (least() ignores NULL), times are clamped to now() and never go back; kernel guard kept", () => {
    const rec = fnBody("site_shard_record_metrics");
    expect(rec).toContain("v_db  := case when v_at ? 'db' then least((v_at->>'db')::timestamptz, now()) end;");
    expect(rec).toContain("m_db_at            = case when v_db is null then s.m_db_at else greatest(coalesce(s.m_db_at, v_db), v_db) end");
    expect(rec).toContain("v_row.dedicated_site_id is null");
    expect(rec).toContain("k not in ('db', 'gateway', 'cpu', 'sweep')");
  });

  it("every new RPC is on the fail-closed siteShardRpc allowlist", () => {
    const tc = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf-8");
    for (const n of ["site_shard_placement_pause", "site_shard_placement_resume", "site_shard_capacity_inputs", "site_shard_metrics_alert_claim", "site_shard_rollout_claim", "site_shard_rollout_release"]) {
      expect(tc).toContain(`"${n}",`);
    }
  });
});
