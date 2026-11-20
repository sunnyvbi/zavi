import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const spine = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260710080000_activity_events_spine.sql"),
  "utf-8",
);
const rpc = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260710080100_admin_tenant_activation_rpc.sql"),
  "utf-8",
);

describe("activity_events spine (20260710080000)", () => {
  it("creates the activity_events table", () => {
    expect(spine).toMatch(/create table if not exists public\.activity_events/i);
  });

  it("enables RLS so operators/anon cannot read it directly", () => {
    expect(spine).toMatch(/alter table public\.activity_events enable row level security/i);
  });

  it("has a partial unique dedupe index for idempotent triggers + backfill", () => {
    expect(spine).toMatch(/create unique index[^;]*activity_events_dedupe_uq[^;]*where dedupe_key is not null/is);
  });

  it("captures connector.connected + deliverable.produced via AFTER INSERT triggers", () => {
    expect(spine).toMatch(/after insert on public\.connector_metadata/i);
    expect(spine).toMatch(/after insert on public\.run_artifacts/i);
    expect(spine).toMatch(/'connector\.connected'/);
    expect(spine).toMatch(/'deliverable\.produced'/);
  });

  it("labels the narrow deliverable signal so it is not treated as the activation gate", () => {
    expect(spine).toMatch(/'narrow_artifact_only'/);
  });
});

describe("admin_tenant_activation RPC (20260710080100)", () => {
  it("defines the projection function", () => {
    expect(rpc).toMatch(/create or replace function public\.admin_tenant_activation/i);
  });

  it("is security definer", () => {
    expect(rpc).toMatch(/security definer/i);
  });

  it("REVOKES execute from public/anon/authenticated (no cross-tenant leak)", () => {
    expect(rpc).toMatch(
      /revoke execute on function public\.admin_tenant_activation\(int\) from public, anon, authenticated/i,
    );
  });

  it("GRANTS execute only to service_role", () => {
    expect(rpc).toMatch(
      /grant execute on function public\.admin_tenant_activation\(int\) to service_role/i,
    );
  });

  it("uses the product activation ladder (brain→connector→run→approval→activated)", () => {
    for (const stage of [
      "needs_onboarding",
      "needs_connector",
      "needs_first_run",
      "needs_approval",
      "activated",
    ]) {
      expect(rpc).toMatch(new RegExp(`'${stage}'`));
    }
  });
});
