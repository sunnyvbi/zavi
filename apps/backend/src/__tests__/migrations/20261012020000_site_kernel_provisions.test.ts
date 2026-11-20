import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261012020000_site_kernel_provisions.sql"), "utf-8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const RPCS: Array<[string, string]> = [
  ["site_kernel_provision_claim", "uuid, uuid, text, integer"],
  ["site_kernel_provision_advance", "uuid, uuid, uuid, text, text, jsonb, boolean, integer"],
  ["site_kernel_attach", "uuid, uuid, uuid"],
];
const OTHER_RPCS: Array<[string, string]> = [
  ["site_backend_dedicate_static_reserve", "uuid, uuid"],
  ["site_backend_place", "uuid, uuid, text"],
];
const PRIOR = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261010090000_site_shards.sql"), "utf-8");
function fnBodyIn(text: string, name: string): string {
  const start = text.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf("$$;", text.indexOf("$$", start) + 2));
}

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", sql.indexOf("$$", start) + 2));
}
const esc = (s: string) => s.replace(/[[\]().]/g, (c) => `\\${c}`);

describe("20261012020000_site_kernel_provisions.sql", () => {
  it("the ledger table: RLS on, NO policy, no grant to anon / authenticated", () => {
    expect(sql).toMatch(/alter table public\.site_kernel_provisions enable row level security/);
    expect(sql).toMatch(/revoke all on public\.site_kernel_provisions from public, anon, authenticated/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated)/i);
  });

  it("every function is service-role only, security definer, pins search_path, and is in the tenant-RPC registry", () => {
    for (const [name, args] of RPCS) {
      const body = fnBody(name);
      expect(body, name).toMatch(/security definer/i);
      expect(body, name).toMatch(/set search_path = pg_catalog, pg_temp/i);
      expect(sql, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\(${esc(args)}\\) from public, anon, authenticated;`));
      expect(sql, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\(${esc(args)}\\) to service_role;`));
      expect(registry, name).toMatch(new RegExp(`\\b${name}: "p_tenant_id"`));
    }
  });

  it("every site-touching function locks / filters the site row by id AND tenant", () => {
    for (const name of ["site_kernel_provision_claim", "site_kernel_provision_advance", "site_kernel_attach"]) {
      expect(fnBody(name), name).toMatch(/where s\.id = p_site_id and s\.tenant_id = p_tenant_id for update/);
    }
    expect(fnBody("site_kernel_provision_advance")).toMatch(/where k\.site_id = p_site_id and k\.tenant_id = p_tenant_id and k\.state = p_from\s+and k\.lease_id = p_lease_id and k\.lease_until >= now\(\)/);
  });

  it("one eligibility rule (internal, not callable by any API role) used by every RPC", () => {
    const check = fnBody("site_kernel_site_check");
    expect(check).toMatch(/'deleting', 'deleted', 'failed', 'fell_back_old'/);
    expect(check).toMatch(/must graduate/);
    expect(check).toMatch(/legacy dedicated site/);
    expect(sql).toMatch(/revoke all on function public\.site_kernel_site_check\(text, public\.sites\) from public, anon, authenticated, service_role;/);
    expect(sql).not.toMatch(/grant execute on function public\.site_kernel_site_check/);
    for (const [name] of RPCS) expect(fnBody(name), name).toMatch(/public\.site_kernel_site_check\('/);
  });

  it("claim takes a bounded lease with a fresh owner token", () => {
    const b = fnBody("site_kernel_provision_claim");
    expect(b).toMatch(/p_lease_seconds < 10 or p_lease_seconds > 3600/);
    expect(b).toMatch(/lease_id = gen_random_uuid\(\)/);
    expect(b).toMatch(/lease_until is null or k\.lease_until < now\(\)/);
  });

  it("the reserve and the rebuilt placement are service-role only, security definer, in the registry", () => {
    for (const [name, args] of OTHER_RPCS) {
      const body = fnBody(name);
      expect(body, name).toMatch(/security definer/i);
      expect(body, name).toMatch(/set search_path = pg_catalog, pg_temp/i);
      expect(sql, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\(${esc(args)}\\) from public, anon, authenticated;`));
      expect(sql, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\(${esc(args)}\\) to service_role;`));
    }
    expect(registry).toMatch(/\bsite_backend_dedicate_static_reserve: "p_tenant_id"/);
    const reserve = fnBody("site_backend_dedicate_static_reserve");
    expect(reserve).toMatch(/where s\.id = p_site_id and s\.tenant_id = p_tenant_id for update/);
    expect(reserve).toMatch(/being set up on its own database/);
    expect(fnBody("site_kernel_provision_claim")).toMatch(/sp\.ref->>'legacy_dedicated' = 'true'/);
  });

  it("site_backend_place is a clean superset of its prior definition plus the kernel-ledger refusal (DB-fn-rebuild gate)", () => {
    const prior = fnBodyIn(PRIOR, "site_backend_place");
    const next = fnBody("site_backend_place");
    const dropped = prior
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 12 && !l.startsWith("--"))
      .filter((l) => !next.includes(l));
    expect(dropped).toEqual([]);
    expect(next).toMatch(/if exists \(select 1 from public\.site_kernel_provisions k where k\.site_id = p_site_id\) then/);
  });

  it("teardown: moving past 'requested' records a kernel-marked pooled_backend provider claim", () => {
    expect(fnBody("site_kernel_provision_advance")).toMatch(/'pooled_backend', 'created', jsonb_build_object\('kernel_site', true\)/);
    expect(fnBody("site_kernel_attach")).toMatch(/jsonb_build_object\('kernel_site', true, 'kernel_shard_id', v_kernel\)/);
  });

  it("advance: forward-only steps, allowlisted patch keys", () => {
    const b = fnBody("site_kernel_provision_advance");
    expect(b).toMatch(/v_patch - array\['project_ref', 'region', 'kernel_shard_id', 'last_error'\]/);
    expect(b).not.toMatch(/'attached'/);
  });

  it("attach: the kernel is read from the SITE's own project, serving and one-site; the mode + kernel move together", () => {
    const b = fnBody("site_kernel_attach");
    expect(b).toMatch(/sh\.dedicated_site_id = p_site_id and sh\.project_ref = v_site\.supabase_project_ref/);
    expect(b).toMatch(/sh\.state = 'full' and sh\.provision_step = 'done' and sh\.max_sites = 1/);
    expect(b).toMatch(/v_site\.backend_mode <> 'static' or v_site\.kernel_shard_id is not null or v_site\.gateway_binding is not null/);
    expect(b).toMatch(/v_row\.lease_id is distinct from p_lease_id or v_row\.lease_until < now\(\)/);
    expect(b).toMatch(/set backend_mode = 'dedicated', kernel_shard_id = v_kernel/);
  });
});

describe("site_backend_place: the kernel refusal survives later redefinitions", () => {
  it("the LATEST migration that redefines site_backend_place still refuses a site with a kernel provision", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(__dirname, "../../../../../supabase/migrations");
    const latest = readdirSync(dir)
      .filter((f: string) => f.endsWith(".sql"))
      .sort()
      .filter((f: string) => /create or replace function public\.site_backend_place\(/i.test(readFileSync(join(dir, f), "utf8")))
      .pop() as string;
    const body = fnBodyIn(readFileSync(join(dir, latest), "utf8"), "site_backend_place");
    expect(body, latest).toMatch(/site_kernel_provisions/);
  });
});
