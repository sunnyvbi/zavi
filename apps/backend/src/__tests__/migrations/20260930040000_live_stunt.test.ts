import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260930040000_live_stunt.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return sql.slice(at, sql.indexOf("end $$;", at));
};

describe("20260930040000_live_stunt", () => {
  it("sorts after every earlier migration", () => {
    expect(readdirSync(MIG_DIR)).toContain(FILE);
    expect(FILE > "20260930030000_ad_budget_brake.sql").toBe(true);
  });

  it("both tables: RLS on, no policies, nothing granted to the browser roles", () => {
    for (const t of ["live_stunt_snapshots", "live_stunt_days"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${t} from public, anon, authenticated;`);
      expect(sql).not.toMatch(new RegExp(`create policy[^;]*on public\\.${t}`));
      expect(sql).not.toMatch(new RegExp(`grant [^;]*on [^;]*public\\.${t}`));
    }
  });

  it("the review apply checks tenant, day, hash, expiry and draft, and consumes the token in one update", () => {
    const fn = fnOf("live_stunt_review_apply");
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(fn).toContain("where tenant_id = p_tenant_id and run_slug = p_run_slug and day = p_day and status = 'draft'");
    expect(fn).toContain("token_hash is not null and token_hash = p_token_hash and token_expires_at > now()");
    expect(fn).toContain("token_hash = null");
    expect(fn.match(/update public\.live_stunt_days/g)).toHaveLength(1);
  });

  it("rows are keyed by run so a test run never mixes with the real one", () => {
    expect(sql).toContain("primary key (tenant_id, run_slug, day)");
    expect(sql).toContain("on conflict (tenant_id, run_slug, day) do update");
    expect(sql.match(/run_slug text not null check/g)).toHaveLength(2);
  });

  it("the draft upsert never overwrites a published or hidden day", () => {
    const fn = fnOf("live_stunt_draft_upsert");
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(fn).toContain("where public.live_stunt_days.status = 'draft'");
    expect(fn).toContain("'kept_published'");
  });

  it("both RPCs are service-role only and registered as tenant RPCs; both tables are tenant tables", () => {
    expect(sql).toContain("revoke all on function public.live_stunt_review_apply(uuid,text,date,text,text,text,text,text) from public, anon, authenticated;");
    expect(sql).toContain("revoke all on function public.live_stunt_draft_upsert(uuid,text,date,jsonb,jsonb,text,timestamptz) from public, anon, authenticated;");
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    for (const t of ["live_stunt_snapshots", "live_stunt_days"]) {
      expect(registry).toMatch(new RegExp(`\\n\\s*${t}: "tenant_id",`));
    }
    expect(registry).toMatch(/\n\s*live_stunt_review_apply: "p_tenant_id",/);
    expect(registry).toMatch(/\n\s*live_stunt_draft_upsert: "p_tenant_id",/);
  });
});
