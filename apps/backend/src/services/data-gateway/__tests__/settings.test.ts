import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  catalog: null as unknown,
  managedBy: null as string | null,
  settings: null as Record<string, unknown> | null,
  tables: [] as string[],
}));

vi.mock("@/services/data-gateway/resolve", () => ({ readDbConfig: async () => h.config }));
vi.mock("../resolve", () => ({ readDbConfig: async () => h.config }));
vi.mock("@/services/tools/operator-db/catalog", () => ({ getCatalog: async () => h.catalog }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      h.tables.push(table);
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () =>
        table === "tenant_db_settings" ? { data: h.settings, error: null } : { data: { managed_by: h.managedBy }, error: null };
      return b;
    },
  }),
}));

import { rawResultsRetention, readDbRetention, readDbSetup, readDbVisibility, revokeCommandFor } from "../settings";

const catalog = (tables: unknown[], hash = "h1") => ({ dialect: "postgres", catalog: { tables }, hints: {}, catalog_hash: hash, coverage: null, discovery_error: null, updated_at: null });
const USERS = { name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "plan" }], rowEstimate: 42 };

beforeEach(() => {
  h.config = { type: "postgres", auto_hide: true, settings_confirmed_at: null, disabled_tables: [], hidden_fields: [], unhidden_fields: [], policy_catalog_hash: null };
  h.catalog = catalog([USERS, { name: "audit", columns: [{ name: "id" }], rowEstimate: 1 }]);
  h.managedBy = null;
});

describe("readDbVisibility", () => {
  it("sensitive fields start hidden; tables start on; carries the catalog hash", async () => {
    const v = await readDbVisibility("t1");
    expect(v!.catalog_hash).toBe("h1");
    expect(v!.sensitive).toEqual([{ table: "users", field: "email", kind: "Email address", hidden: true }]);
    expect(v!.tables.map((t) => [t.name, t.enabled, t.rows])).toEqual([
      ["users", true, 42],
      ["audit", true, 1],
    ]);
  });

  it("an explicit un-hide shows only against the catalog it was confirmed on", async () => {
    h.config = { ...h.config, unhidden_fields: ["users.email"], policy_catalog_hash: "old" };
    expect((await readDbVisibility("t1"))!.sensitive[0].hidden).toBe(true);
    h.config = { ...h.config, policy_catalog_hash: "h1" };
    expect((await readDbVisibility("t1"))!.sensitive[0].hidden).toBe(false);
  });

  it("switched-off tables show off; MongoDB views are never on and list what they remove", async () => {
    h.config = { ...h.config, disabled_tables: ["AUDIT"] };
    h.catalog = catalog([USERS, { name: "audit", columns: [], rowEstimate: 0 }, { name: "users_for_zavi", columns: [{ name: "id" }], rowEstimate: 42, view_of: "users", removed_fields: ["email"] }]);
    const v = await readDbVisibility("t1");
    expect(v!.tables.find((t) => t.name === "audit")!.enabled).toBe(false);
    expect(v!.tables.find((t) => t.name === "users_for_zavi")).toMatchObject({ enabled: false, view_of: "users" });
    expect(v!.removed_by_view).toEqual(["users.email"]);
  });

  it("before discovery: pending and empty", async () => {
    h.catalog = null;
    const v = await readDbVisibility("t1");
    expect(v).toMatchObject({ discovery: "pending", tables: [], sensitive: [] });
  });

  it("not connected: null", async () => {
    h.config = null;
    expect(await readDbVisibility("t1")).toBeNull();
  });
});

describe("readDbSetup", () => {
  it("an old connection (auto_hide off, never confirmed) is legacy; a Zavi-managed one is not", async () => {
    h.config = { ...h.config, auto_hide: false };
    expect(await readDbSetup("t1")).toMatchObject({ connected: true, legacy: true, discovery: "ready" });
    h.managedBy = "zavi";
    expect(await readDbSetup("t1")).toMatchObject({ legacy: false, managed_by: "zavi" });
  });

  it("a new connection is not legacy", async () => {
    expect(await readDbSetup("t1")).toMatchObject({ legacy: false, settings_confirmed: false });
  });

  it("reports how a direct connection travels; never in connector mode; unknown values are null", async () => {
    h.config = { ...h.config, transport: "plaintext" };
    expect(await readDbSetup("t1")).toMatchObject({ transport: "plaintext" });
    expect(await readDbVisibility("t1")).toMatchObject({ transport: "plaintext" });
    h.config = { ...h.config, transport: null };
    expect(await readDbSetup("t1")).toMatchObject({ transport: null });
    h.config = { ...h.config, transport: "weird" };
    expect(await readDbSetup("t1")).toMatchObject({ transport: null });
    h.config = { ...h.config, mode: "connector", transport: "plaintext" };
    expect(await readDbSetup("t1")).toMatchObject({ transport: null });
  });
});

describe("retention (outlives a disconnect)", () => {
  it("reads tenant_db_settings, not the connection row", async () => {
    h.config = null;
    h.settings = { raw_results_retention: "7", chat_retention: "30" };
    expect(await readDbRetention("t1")).toEqual({ exists: true, raw_results_retention: "7", chat_retention: "30" });
    expect(h.tables).toContain("tenant_db_settings");
  });
  it("fails closed: no settings row at all is the strictest setting", async () => {
    h.settings = null;
    expect(await rawResultsRetention("t1")).toBe("run");
  });
  it("an explicit legacy NULL keeps today's behaviour; a disconnect tombstone keeps the saved choice", async () => {
    h.settings = { raw_results_retention: null, chat_retention: null };
    expect(await rawResultsRetention("t1")).toBeNull();
    h.settings = { raw_results_retention: "run", chat_retention: "forever", managed_db_opt_out_at: "2026-10-12T00:00:00Z" };
    expect(await rawResultsRetention("t1")).toBe("run");
  });
});

describe("revokeCommandFor", () => {
  it("a Zavi-made database drops Zavi's own login", () => {
    expect(revokeCommandFor("postgres", "zavi")).toBe("DROP OWNED BY zavi_readonly;\nDROP ROLE zavi_readonly;");
  });
  it("per dialect", () => {
    expect(revokeCommandFor("postgres")).toContain("DROP ROLE zavi_reader;");
    expect(revokeCommandFor("mysql")).toContain("DROP USER 'zavi_reader'@'%';");
    expect(revokeCommandFor("mongodb")).toContain('db.dropUser("zavi_reader")');
  });
});
