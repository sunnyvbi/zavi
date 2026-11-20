import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260922080000_build_stage_priced_as_product_builder.sql"),
  "utf-8",
);

const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("build stage priced as product-builder (20260922080000)", () => {
  it("both credit triggers price a verified Build stage as product-builder", () => {
    const cases = SQL.match(
      /v_required := case when v_build then _tier_required\('product-builder'\)\s+else _tier_required\(NEW\.agent_slug\) end;/g,
    );
    expect(cases?.length).toBe(2);
    expect(CODE).not.toMatch(/v_required := _tier_required\(NEW\.agent_slug\);/);
  });

  it("the exemption is evaluated whatever the fleet-wide switch says", () => {
    for (const body of SQL.split("create or replace function").slice(1)) {
      if (!body.includes("v_build :=")) continue;
      expect(body.indexOf("v_build :=")).toBeLessThan(body.indexOf("_tier_gate_enforced()"));
    }
  });

  it("keeps the trigger's a2a requirement — this migration does not touch the exemption itself", () => {
    expect(SQL).toMatch(/NEW\.payload, NEW\.trigger/);
    expect(CODE).not.toMatch(/create or replace function _is_live_build_stage/);
  });

  it("the exemption requires a service-role enqueue, not just the a2a trigger", () => {
    const guarded = CODE.match(
      /v_build := NEW\.enqueued_by is null\s+and _is_live_build_stage\(NEW\.tenant_id, NEW\.agent_slug, NEW\.payload, NEW\.trigger\);/g,
    );
    expect(guarded?.length).toBe(2);
    expect(CODE).not.toMatch(/v_build := _is_live_build_stage\(/);
  });

  it("re-reserve keeps running→queued excluded from re-reserving", () => {
    const body = SQL.slice(SQL.indexOf("function _trg_rereserve_run_credits"));
    expect(body).toMatch(/running→queued[\s\S]*intentionally excluded/);
    expect(
      body.match(/OLD\.status in \('success','parse_failed','error','failed','cancelled','dispatch_error'\)/g)?.length,
    ).toBe(2);
  });
});
