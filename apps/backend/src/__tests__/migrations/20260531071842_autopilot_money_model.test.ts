import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260531071842_autopilot_money_model.sql"),
  "utf-8",
);

describe("20260531071842_autopilot_money_model.sql", () => {
  it("creates the path_a|path_b enum + an additive nullable column on the override table", () => {
    expect(sql).toMatch(/create type autopilot_money_model as enum \('path_a', 'path_b'\)/i);
    expect(sql).toMatch(/alter table tenant_decision_class_overrides/i);
    expect(sql).toMatch(/add column if not exists money_model autopilot_money_model/i);
  });

  it("set_tenant_money_model is security definer + membership-gated", () => {
    expect(sql).toMatch(/create or replace function set_tenant_money_model\(/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/from tenant_users/i);
    expect(sql).toMatch(/not a member of tenant/i);
  });

  it("keys the choice to the stripe.create_connected_account class + upserts on conflict", () => {
    expect(sql).toMatch(/v_class\s+text\s*:=\s*'stripe\.create_connected_account'/i);
    expect(sql).toMatch(/on conflict \(tenant_id, decision_class\) do update/i);
    expect(sql).toMatch(/set money_model = excluded\.money_model/i);
  });

  it("grants execute to authenticated only (not public)", () => {
    expect(sql).toMatch(/revoke all on function set_tenant_money_model.*from public/is);
    expect(sql).toMatch(/grant execute on function set_tenant_money_model.*to authenticated/is);
  });

  it("preserves autonomy on conflict (only touches money_model)", () => {
    const doUpdate = sql.slice(sql.search(/on conflict/i));
    expect(doUpdate).not.toMatch(/set[\s\S]*autonomy\s*=/i);
  });
});
