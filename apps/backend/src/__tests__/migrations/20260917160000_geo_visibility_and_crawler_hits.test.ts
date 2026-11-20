import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260917160000_geo_visibility_and_crawler_hits.sql"),
  "utf8",
);

const TABLES = [
  "geo_prompts",
  "geo_prompt_sweeps",
  "geo_prompt_responses",
  "geo_crawler_ingest_tokens",
  "geo_crawler_hits_daily",
  "geo_robots_observations",
];

describe("20260917160000_geo_visibility_and_crawler_hits.sql", () => {
  it("is transactional", () => {
    expect(sql).toMatch(/^begin;/im);
    expect(sql).toMatch(/^commit;/im);
  });

  it("keeps every table service-role only: RLS on, no policies, nothing granted to anon/authenticated", () => {
    for (const t of TABLES) {
      expect(sql).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`, "i"));
      expect(sql).toMatch(new RegExp(`revoke all on table ${t}\\s+from public, anon, authenticated`, "i"));
    }
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated)/i);
  });

  it("does not put sampled visibility on the tier-1 readiness row", () => {
    expect(sql).not.toMatch(/alter table seo_audit_snapshots/i);
  });

  it("ties every sampled answer to a sweep of its OWN tenant, structurally", () => {
    expect(sql).toMatch(/foreign key \(sweep_id, tenant_id\) references geo_prompt_sweeps \(id, tenant_id\)/i);
  });

  it("allows one running sweep per tenant, enforced by an index and not only by code", () => {
    expect(sql).toMatch(/create unique index if not exists geo_prompt_sweeps_one_running_uq[\s\S]*?where status = 'running'/i);
  });

  it("the spend guard serialises admissions and fails closed on a missing cap", () => {
    const fn = sql.slice(sql.indexOf("create or replace function geo_open_prompt_sweep"));
    expect(fn).toMatch(/pg_advisory_xact_lock/i);
    expect(fn).toMatch(/greatest\(coalesce\(p_tenant_cap_7d, 0\), 0\)/i);
    expect(fn).toMatch(/greatest\(coalesce\(p_fleet_cap_usd_24h, 0\), 0\)/i);
    expect(fn).toMatch(/tenant_cap_reached/);
    expect(fn).toMatch(/fleet_cap_reached/);
  });

  it("only four engines — what DataForSEO returns out of the box", () => {
    expect(sql).toMatch(/engine in \('chatgpt', 'claude', 'gemini', 'perplexity'\)/);
  });

  it("stores no IP, user agent string or referrer from a customer's logs", () => {
    const hits = sql.slice(sql.indexOf("create table if not exists geo_crawler_hits_daily"));
    const cols = hits.slice(0, hits.indexOf(");")).replace(/--.*$/gm, "");
    expect(cols).not.toMatch(/\bip\b|user_agent|referr?er|query/i);
  });

  it("stores only a hash of the ingest token, one active per tenant", () => {
    expect(sql).toMatch(/token_hash\s+text\s+not null check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(sql).toMatch(/geo_crawler_ingest_tokens_one_active_uq[\s\S]*?where revoked_at is null/i);
    expect(sql).not.toMatch(/raw_token|token_plain/i);
  });

  it("re-checks the token inside the hits write", () => {
    const fn = sql.slice(sql.indexOf("create or replace function geo_record_crawler_hits"));
    expect(fn).toMatch(/where id = p_token_id and tenant_id = p_tenant_id and revoked_at is null/);
  });

  it("revokes every function from public roles and grants only service_role", () => {
    const fns = [...sql.matchAll(/create or replace function (\w+)\(/g)].map((m) => m[1]);
    expect(fns.length).toBeGreaterThanOrEqual(5);
    for (const f of fns) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f}\\([^)]*\\)\\s+from public, anon, authenticated`, "i"));
      expect(sql).toMatch(new RegExp(`grant execute on function ${f}\\([^)]*\\)\\s+to service_role`, "i"));
    }
  });
});
