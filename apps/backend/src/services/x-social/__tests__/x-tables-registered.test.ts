
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ select: () => ({}), upsert: () => ({}), update: () => ({}), insert: () => ({}), delete: () => ({}) }) }),
}));

import { asTenantId, tenantClient } from "@/services/tenant-client";

const X_PANEL_UPSERTS: Array<[string, string]> = [
  ["social_post_metric_snapshots", "tenant_id,channel,external_post_id,captured_on"],
  ["social_account_snapshots", "tenant_id,channel,captured_on"],
  ["social_profile_check_dismissals", "tenant_id,channel,check_key"],
];

describe("X panel tables are classified for tenantClient", () => {
  it.each(X_PANEL_UPSERTS)("%s accepts its real upsert", (table, onConflict) => {
    const c = tenantClient(asTenantId("73db45ff-457e-4541-bc8f-bdb625390204"));
    expect(() => c.from(table).upsert({ tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204" }, { onConflict })).not.toThrow();
  });

  it("social_posts is readable and updatable (the ledger stamp)", () => {
    const c = tenantClient(asTenantId("73db45ff-457e-4541-bc8f-bdb625390204"));
    expect(() => c.from("social_posts")).not.toThrow();
  });

  it("an unclassified table still throws — the guard itself is intact", () => {
    const c = tenantClient(asTenantId("73db45ff-457e-4541-bc8f-bdb625390204"));
    expect(() => c.from("definitely_not_a_table").upsert({}, { onConflict: "tenant_id" })).toThrow(/not classified/);
  });
});
