
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = "20260602220322_action_outcomes_measurement_loop.sql";

let sql = "";
beforeAll(() => {
  const path = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations", MIGRATION);
  sql = readFileSync(path, "utf8").toLowerCase();
});

describe("action_outcomes migration — table + RLS contract", () => {
  it("creates the table with a UNIQUE decision_id FK ON DELETE RESTRICT", () => {
    expect(sql).toMatch(/create table if not exists action_outcomes/);
    expect(sql).toMatch(/decision_id\s+uuid\s+not null unique/);
    expect(sql).toMatch(/references decisions\(id\) on delete restrict/);
  });

  it("enables RLS and grants authed clients SELECT-only (no insert/update/delete policy)", () => {
    expect(sql).toMatch(/alter table action_outcomes enable row level security/);
    expect(sql).toMatch(/create policy action_outcomes_select on action_outcomes\s+for select/);
    expect(sql).not.toMatch(/create policy .* on action_outcomes\s+for (insert|update|delete)/);
  });

  it("carries the structured Meta-shaped snapshot columns + window bounds", () => {
    for (const col of [
      "baseline_metrics",
      "outcome_metrics",
      "delta_metrics",
      "baseline_status",
      "reconcile_status",
      "measurement_window_days",
      "measurement_window_start",
      "measurement_window_end",
      "metrics_schema_version",
      "reconcile_after",
    ]) {
      expect(sql, `missing column ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

describe("record_action_outcome — binding RPC contract", () => {
  it("resolves tenant FROM the decision row (C8 — never trusts a caller tenant)", () => {
    expect(sql).toMatch(/select tenant_id into v_tenant from decisions where id = p_decision_id/);
    expect(sql).not.toMatch(/function record_action_outcome\([^)]*p_tenant_id/);
  });

  it("is idempotent on decision_id (on conflict do nothing)", () => {
    expect(sql).toMatch(/insert into action_outcomes[\s\S]*on conflict \(decision_id\) do nothing/);
  });

  it("sets reconcile_after = now() + window at insert time", () => {
    expect(sql).toMatch(/now\(\) \+ make_interval\(days => v_window\)/);
  });

  it("is service_role-only (revoked from public + authenticated)", () => {
    expect(sql).toMatch(/revoke all on function record_action_outcome\([^)]*\) from public/);
    expect(sql).toMatch(/revoke all on function record_action_outcome\([^)]*\) from authenticated/);
    expect(sql).toMatch(/grant execute on function record_action_outcome\([^)]*\) to service_role/);
  });
});

describe("reconcile_action_outcome — reconciliation RPC contract", () => {
  it("only updates a still-pending row (idempotent under retry / overlapping tick)", () => {
    expect(sql).toMatch(
      /update action_outcomes[\s\S]*reconcile_status\s*=\s*p_status[\s\S]*where id = p_id and reconcile_status = 'pending'/,
    );
  });

  it("returns whether THIS call applied (row_count > 0) so a concurrent tick is a noop", () => {
    expect(sql).toMatch(/get diagnostics v_changed = row_count/);
    expect(sql).toMatch(/return v_changed > 0/);
  });

  it("is service_role-only", () => {
    expect(sql).toMatch(/revoke all on function reconcile_action_outcome\([^)]*\) from authenticated/);
    expect(sql).toMatch(/grant execute on function reconcile_action_outcome\([^)]*\) to service_role/);
  });
});

describe("get_action_outcome_signal — read aggregate contract", () => {
  it("aggregates measured deltas per (action_class, decision_outcome) for a tenant", () => {
    expect(sql).toMatch(/function get_action_outcome_signal\(\s*p_tenant_id uuid/);
    expect(sql).toMatch(/group by action_class, decision_outcome/);
    expect(sql).toMatch(/filter \(where reconcile_status = 'measured'/);
    expect(sql).toMatch(/where tenant_id = p_tenant_id/);
  });

  it("is service_role-only", () => {
    expect(sql).toMatch(/grant execute on function get_action_outcome_signal\([^)]*\) to service_role/);
  });
});
