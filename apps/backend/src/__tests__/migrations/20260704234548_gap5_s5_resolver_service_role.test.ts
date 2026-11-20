import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260704234548_gap5_s5_resolver_service_role.sql",
  ),
  "utf-8",
);

describe("Gap 5 S5 PR3 — resolver service-role change (clean superset)", () => {
  it("harvest guard now fires ONLY for an authenticated caller (auth.uid() present)", () => {
    expect(SQL).toMatch(/if auth\.uid\(\) is not null and not exists/);
  });
  it("still returns empty for a non-member authenticated caller", () => {
    expect(SQL).toMatch(/return; -- empty/);
  });
  it("preserves the PII gate (non-member → 'Zavi staff', never the email)", () => {
    expect(SQL).toMatch(/else 'Zavi staff'/);
  });
  it("keeps definer + search_path + the same grants", () => {
    expect(SQL).toMatch(/security definer set search_path = public/);
    expect(SQL).toMatch(/grant execute on function resolve_decision_actors\(uuid, uuid\[\]\) to authenticated, service_role/);
  });
});
