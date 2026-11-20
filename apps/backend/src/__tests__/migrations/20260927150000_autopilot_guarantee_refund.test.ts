import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260927150000_autopilot_guarantee_refund.sql"),
  "utf8",
);
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function ${name}(`);
  return sql.slice(at, sql.indexOf("$$;", at));
};

describe("20260927150000_autopilot_guarantee_refund", () => {
  it("every new RPC is in the tenant-RPC registry (tenantRpc throws otherwise)", () => {
    const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
    for (const fn of ["pause_channel_by_cgo", "claim_cgo_pause", "refund_autopilot_run"]) {
      expect(registry).toMatch(new RegExp(`\\n\\s*${fn}: "p_tenant_id",`));
    }
  });

  it("both functions are service-role only", () => {
    for (const sig of ["pause_channel_by_cgo(uuid, text, text, uuid)", "claim_cgo_pause(uuid, text, int)", "refund_autopilot_run(uuid, uuid)"]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
  });

  it("a pause is bound to the live plan by id, under a lock, in the same transaction", () => {
    const f = fnOf("pause_channel_by_cgo");
    expect(f).toMatch(/status = 'live' for share/);
    expect(f).toMatch(/set_channel_in_plan_by_cgo\(p_tenant_id, p_channel_slug, false\)[\s\S]*cgo_plan_id = v_plan/);
  });

  it("the claim requires that same plan to still be live, and locks it", () => {
    const f = fnOf("claim_cgo_pause");
    expect(f).toMatch(/where id = v_plan[\s\S]*status = 'live'[\s\S]*for update/);
    expect(f).toMatch(/v_row\.cgo_plan_id is distinct from v_plan/);
    expect(fnOf("claim_cgo_pause")).not.toMatch(/created_at/);
  });

  it("the claim locks plan before channel, the same order as a plan commit", () => {
    const f = fnOf("claim_cgo_pause");
    expect(f.indexOf("from growth_plan")).toBeLessThan(f.search(/from tenant_channels[\s\S]{0,120}for update/));
  });

  it("no refund before the check-in's bill has settled", () => {
    const f = fnOf("refund_autopilot_run");
    expect(f.indexOf("'pending'")).toBeGreaterThan(-1);
    expect(f.indexOf("'pending'")).toBeLessThan(f.indexOf("sum(coalesce(debited, amount))"));
    expect(f).toMatch(/r\.kind = 'reserve'[\s\S]*t\.attempt = r\.attempt and t\.kind in \('settle', 'refund'\)/);
  });

  it("the refund is only this tenant's cgo run, pays what was debited, once per run", () => {
    const f = fnOf("refund_autopilot_run");
    expect(f).toMatch(/tenant_id = p_tenant_id and agent_slug = 'cgo'/);
    expect(f).toMatch(/sum\(coalesce\(debited, amount\)\)/);
    expect(f).toContain("'autopilot-guarantee:' || p_run_id::text");
    expect(f).toMatch(/on conflict \(grant_key\) where kind = 'grant' and grant_key is not null\s+do nothing/);
  });
});
