import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260713060000_fde_training_events.sql"),
  "utf-8",
);

describe("20260713060000_fde_training_events.sql", () => {
  it("creates the table with the columns P3 needs to fold a rescue back into the fleet", () => {
    expect(sql).toMatch(/create table if not exists fde_training_events/i);
    for (const col of [
      "tenant_id",
      "staff_user_id",
      "gap_dimension",
      "action_kind",
      "input_ref",
      "work_product_ref",
      "before_score",
      "after_score",
      "escalation_category",
      "agent_training_hint",
      "folded_into_prompt",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("constrains action_kind + gap_dimension so a typo cannot silently never match a training query", () => {
    expect(sql).toMatch(/action_kind\s+text not null check \(action_kind in \(/i);
    expect(sql).toMatch(/gap_dimension\s+text check \(gap_dimension in \(/i);
    for (const dim of [
      "verified_brain",
      "product_url",
      "connectors",
      "goal_measurable",
      "deliverable",
      "founder_engaged",
    ]) {
      expect(sql).toContain(dim);
    }
  });

  it("is WORM: DELETE is blocked outright, for service-role too (a trigger, not RLS)", () => {
    expect(sql).toMatch(/create or replace function fde_training_events_worm_guard\(\)/i);
    expect(sql).toMatch(/if tg_op = 'DELETE' then/i);
    expect(sql).toMatch(/append-only \(WORM\): DELETE blocked/i);
    expect(sql).toMatch(/before update or delete on fde_training_events/i);
  });

  it("allows the fold flag to move ONLY false -> true (never re-fold, never un-fold)", () => {
    expect(sql).toMatch(/old\.folded_into_prompt is distinct from false/i);
    expect(sql).toMatch(/new\.folded_into_prompt is distinct from true/i);
  });

  it("freezes every other column — a tamper cannot ride along with a legal fold", () => {
    expect(sql).toMatch(/to_jsonb\(old\) - 'folded_into_prompt' - 'folded_at'/i);
    expect(sql).toMatch(/to_jsonb\(new\) - 'folded_into_prompt' - 'folded_at'/i);
    expect(sql).toMatch(/only folded_into_prompt\/folded_at may be updated/i);
  });

  it("enables RLS with NO client policy — this is a CROSS-TENANT staff record", () => {
    expect(sql).toMatch(/alter table fde_training_events enable row level security/i);
    expect(sql).not.toMatch(/create policy .* on fde_training_events/i);
  });

  it("indexes the two reads that exist: one tenant's history, and the unfolded backlog", () => {
    expect(sql).toMatch(/fde_training_events_tenant_idx/i);
    expect(sql).toMatch(/fde_training_events_unfolded_idx/i);
    expect(sql).toMatch(/where folded_into_prompt = false/i);
  });
});
