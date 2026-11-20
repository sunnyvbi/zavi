import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  catalog: null as Record<string, unknown> | null,
  getSecret: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: st.config, error: null }) }) }),
  }),
}));
vi.mock("@/services/tools/operator-db/catalog", () => ({
  getCatalog: async () => st.catalog,
  hintsToSchemaMapShape: () => ({}),
}));
vi.mock("@/services/tools/operator-db/mapping", () => ({
  getConfirmedMapping: async () => null,
  applyConfirmedMap: (m: unknown) => m,
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: st.getSecret }));
const logEvent = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => undefined));
vi.mock("@/services/logging/logEvent", () => ({ logEvent }));

import { loadDbAccess, noteLastGoodFallback, __resetLastGoodFallbackLog } from "../resolve";

const row = (over: Record<string, unknown> = {}) => ({
  type: "postgres",
  mode: "direct",
  connection_secret_key: "operator_db.connection_string",
  disabled_tables: [],
  hidden_fields: [],
  unhidden_fields: [],
  auto_hide: true,
  settings_confirmed_at: null,
  policy_catalog_hash: "h1",
  ...over,
});
const cat = (hash = "h1") => ({
  dialect: "postgres",
  catalog: { tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }] }] },
  hints: {},
  catalog_hash: hash,
  discovery_error: null,
});

beforeEach(() => {
  st.config = row();
  st.catalog = cat();
  st.getSecret.mockReset().mockResolvedValue("postgres://x");
  logEvent.mockClear();
  __resetLastGoodFallbackLog();
});

describe("loadDbAccess", () => {
  it("connector mode never calls getSecret", async () => {
    st.config = row({ mode: "connector" });
    const a = await loadDbAccess("t1");
    expect(a.mode).toBe("connector");
    expect(a.connectionString).toBeNull();
    expect(st.getSecret).not.toHaveBeenCalled();
  });
  it("direct mode reads the secret", async () => {
    expect((await loadDbAccess("t1")).connectionString).toBe("postgres://x");
  });
  it("not connected -> operator_db_not_connected with the Your database copy", async () => {
    st.config = null;
    await expect(loadDbAccess("t1")).rejects.toMatchObject({ code: "operator_db_not_connected", message: expect.stringMatching(/Connectors > Integrations > Your database/) });
  });
  it.each([null, { ...cat(), discovery_error: "boom" }, { ...cat(), catalog: { tables: [] } }])("no usable catalog -> operator_db_not_discovered (%#)", async (c) => {
    st.catalog = c as never;
    await expect(loadDbAccess("t1")).rejects.toMatchObject({ code: "operator_db_not_discovered" });
    expect(st.getSecret).not.toHaveBeenCalled();
  });
  it("an un-hide applies only while policy_catalog_hash matches the catalog", async () => {
    st.config = row({ unhidden_fields: ["users.email"], policy_catalog_hash: "h1" });
    expect((await loadDbAccess("t1")).policy.isHidden("users", "email")).toBe(false);
    st.catalog = cat("h2");
    expect((await loadDbAccess("t1")).policy.isHidden("users", "email")).toBe(true);
  });
});

describe("a kept last good catalog keeps reads working (2026-10-13 outage)", () => {
  const kept = () => ({ ...cat(), rescan_error: "operation exceeded time limit", rescan_failed_at: "2026-10-14T06:00:00Z" });

  it("must-catch: reads resolve against the last good catalog while its re-scan is failing", async () => {
    st.catalog = kept();
    const a = await loadDbAccess("t1");
    expect(a.catalog.catalog.tables.map((t) => t.name)).toEqual(["users"]);
    expect(a.policy.resolve("users", true)).not.toBeNull();
  });

  it("serving it leaves one praxis_logs row per tenant per hour, not one per read", async () => {
    st.catalog = kept();
    await loadDbAccess("t1");
    await loadDbAccess("t1");
    await loadDbAccess("t2");
    const rows = logEvent.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows.filter((r) => r.code === "serving_last_good_catalog").map((r) => r.tenant_id)).toEqual(["t1", "t2"]);
    expect(noteLastGoodFallback("t1", "x", Date.now() + 61 * 60_000)).toBe(true);
  });

  it("must-not-catch: a catalog whose latest scan replaced it logs nothing", async () => {
    await loadDbAccess("t1");
    expect(logEvent).not.toHaveBeenCalled();
  });
});
