import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260711210416_barge_in_drain_steers_rpcs.sql"),
  "utf-8",
);
function fnBody(name: string): string {
  const m = sql.match(new RegExp(`create or replace function ${name}[\\s\\S]*?\\$\\$;`, "i"));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
}

describe("20260711210416_barge_in_drain_steers_rpcs.sql", () => {
  it("both RPCs are service_role-only security-definers with pg_temp-pinned search_path", () => {
    for (const f of ["drain_agent_run_steers", "mark_agent_run_steers_drained"]) {
      const b = fnBody(f);
      expect(b).toMatch(/security definer/i);
      expect(b).toMatch(/set search_path = public, pg_temp/i);
    }
    expect((sql.match(/from public, anon, authenticated/g) || []).length).toBe(2);
    expect((sql.match(/to service_role/g) || []).length).toBe(2);
    expect(sql).not.toMatch(/to (authenticated|anon)\b(?![,)]* service_role)/i);
  });

  it("drain is tenant-scoped + guards run ownership + leases FOR UPDATE SKIP LOCKED by seq", () => {
    const b = fnBody("drain_agent_run_steers");
    expect(b).toMatch(/from public\.agent_runs r\s+where r\.id = p_run_id and r\.tenant_id = p_tenant_id/i);
    expect(b).toMatch(/s\.run_id = p_run_id\s+and s\.tenant_id = p_tenant_id/i);
    expect(b).toMatch(/order by s\.seq[\s\S]*for update skip locked/i);
    expect(b).toMatch(/set status = 'leased'/i);
    expect(b).not.toMatch(/(from|join|update)\s+(?!public\.)agent_run(s|_steers)\b/i);
  });

  it("drain reclaims an EXPIRED lease (Slice 7) — crashed segment's steers become drainable", () => {
    expect(fnBody("drain_agent_run_steers")).toMatch(
      /status = 'leased' and s\.lease_until is not null and s\.lease_until < now\(\)/i,
    );
  });

  it("mark is idempotent + tenant-scoped: only (run,tenant)-matched LEASED rows → drained", () => {
    const b = fnBody("mark_agent_run_steers_drained");
    expect(b).toMatch(/set status = 'drained'/i);
    expect(b).toMatch(/s\.run_id = p_run_id\s+and s\.tenant_id = p_tenant_id\s+and s\.status = 'leased'/i);
  });
});
