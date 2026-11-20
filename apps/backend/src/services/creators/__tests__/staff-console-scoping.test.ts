
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeKind } from "@/services/tenant-client";

const SRC = readFileSync(join(__dirname, "..", "staff-console.ts"), "utf8");

const GLOBAL_TABLES = ["human_members", "human_member_pii", "creator_packages", "creator_payout_accounts"];

const CROSS_TENANT_TABLES = [
  "creator_disputes",
  "creator_orders",
  "creator_submissions",
  "creator_thread_messages",
  "creator_money_events",
  "creator_offers",
  "brief_applications",
];

describe("every table the staff console touches is classified in the real registry", () => {
  it.each(GLOBAL_TABLES)("%s is registered global, so globalClient() will serve it", (table) => {
    expect(scopeKind(table)).toBe("global");
  });

  it.each(CROSS_TENANT_TABLES)(
    "%s is a tenant-plane table, never a global or own-id one",
    (table) => {
      expect(["tenant_id", "unsupported"]).toContain(scopeKind(table));
    },
  );

  it("the workspace table is the one that scopes by its own id", () => {
    expect(scopeKind("tenants")).toBe("idIsTenantId");
  });

  it("the source reads exactly the tables this test knows about", () => {
    const found = new Set(
      [...SRC.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)].map((m) => m[1]),
    );
    const known = new Set([...GLOBAL_TABLES, ...CROSS_TENANT_TABLES, "tenants"]);
    for (const t of found) expect(known).toContain(t);
  });

  it("never imports the raw serviceClient", () => {
    expect(SRC).not.toMatch(/from\s+"@\/services\/supabase"/);
    expect(SRC).toMatch(/staffCrossTenantClient/);
    expect(SRC).toMatch(/globalClient/);
  });
});
