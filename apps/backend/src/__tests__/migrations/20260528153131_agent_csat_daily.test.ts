import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260528153131_agent_csat_daily.sql",
  ),
  "utf-8",
);

describe("20260528153131_agent_csat_daily.sql", () => {
  it("creates agent_csat_daily keyed by (tenant, agent, day)", () => {
    expect(sql).toMatch(/create table agent_csat_daily/i);
    expect(sql).toMatch(/primary key \(tenant_id, agent_slug, day\)/i);
  });

  it("keeps pct_positive nullable (NULL != 0% positive)", () => {
    expect(sql).toMatch(/pct_positive numeric/i);
    expect(sql).not.toMatch(/pct_positive numeric not null/i);
  });

  it("rollup filters to per-run thumbs only (target_type='agent_run' + rating in (-1,1))", () => {
    expect(sql).toMatch(/af\.target_type = 'agent_run'/i);
    expect(sql).toMatch(/af\.rating in \(-1, 1\)/i);
  });

  it("rollup is idempotent (ON CONFLICT upsert on the daily key)", () => {
    expect(sql).toMatch(/on conflict \(tenant_id, agent_slug, day\) do update set/i);
  });

  it("RLS member-select only, no write policy (writes are service-role worker)", () => {
    expect(sql).toMatch(/alter table agent_csat_daily enable row level security/i);
    expect(sql).toMatch(/create policy agent_csat_daily_member_select on agent_csat_daily\s+for select/i);
    expect(sql).not.toMatch(/create policy[^\n]*for (insert|update|delete)/i);
  });

  it("revokes public execute on the rollup RPC", () => {
    expect(sql).toMatch(/revoke all on function rollup_agent_csat\(date\) from public/i);
  });
});
