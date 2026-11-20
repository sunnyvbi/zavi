import { describe, it, expect, vi, beforeEach } from "vitest";

const discoverCatalog = vi.fn();
const persistDiscoveryFailure = vi.fn();
const getSecret = vi.fn();
let configRow: { type: string; connection_secret_key: string; mode?: string; transport?: string | null } | null = null;
const updates: { table: string; patch: unknown; eq: [string, string] }[] = [];
let catalogRow: { dialect: string } | null = null;

const scopedTo: string[] = [];
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => {
    scopedTo.push(tid);
    return {
      from: (table: string) => ({
        select: () => ({
          maybeSingle: async () => ({ data: table === "tenant_db_catalog" ? catalogRow : configRow, error: null }),
        }),
        update: (patch: unknown) => ({
          eq: async (k: string, v: string) => {
            updates.push({ table, patch, eq: [k, v] });
            return { error: null };
          },
        }),
      }),
    };
  },
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: (...a: unknown[]) => getSecret(...a) }));
vi.mock("@/services/tools/operator-db/discovery", () => ({
  persistDiscoveryFailure: (...a: unknown[]) => persistDiscoveryFailure(...a),
}));
const audit = vi.hoisted(() => ({ reserve: vi.fn(), finalize: vi.fn() }));
vi.mock("../audit", () => ({ reserveAudit: audit.reserve, finalizeAudit: audit.finalize }));
const probes = vi.hoisted(() => ({ connectivity: vi.fn(), write: vi.fn() }));
vi.mock("../discovery/run", () => ({
  discoverWithConnection: (...a: unknown[]) => discoverCatalog(...a),
  probeConnectivity: (...a: unknown[]) => probes.connectivity(...a),
}));
vi.mock("../discovery/privilege", () => ({ probeWriteCapable: (...a: unknown[]) => probes.write(...a) }));
vi.mock("../discovery/mongo", () => ({ MONGO_STRUCTURE_SCAN_TEXT: "Structure scan: mongo" }));
vi.mock("../connector/status", async (orig) => ({ ...(await orig<typeof import("../connector/status")>()), readActiveConnector: async () => null }));

import { discoverCatalogForTenant } from "@/services/tools/operator-db/discovery/run-for-tenant";
import { probeCandidate, checkStoredLogin } from "../describe";

beforeEach(() => {
  vi.clearAllMocks();
  scopedTo.length = 0;
  updates.length = 0;
  audit.reserve.mockResolvedValue("log-1");
  audit.finalize.mockResolvedValue(undefined);
  configRow = { type: "mongodb", connection_secret_key: "operator_db.connection_string" };
  catalogRow = null;
  getSecret.mockResolvedValue("mongodb://x/db");
  discoverCatalog.mockResolvedValue({ ok: true, tables_found: 500, entities_inferred: ["users"] });
});

describe("discoverCatalogForTenant", () => {
  it("no tenant_db_config row → not_connected, never reads Vault or discovers", async () => {
    configRow = null;
    const r = await discoverCatalogForTenant("t1");
    expect(r).toEqual({ ok: false, discovery_error: "not_connected" });
    expect(getSecret).not.toHaveBeenCalled();
    expect(discoverCatalog).not.toHaveBeenCalled();
  });

  it("config but no Vault secret → no_secret, never discovers", async () => {
    getSecret.mockResolvedValueOnce(null);
    const r = await discoverCatalogForTenant("t1");
    expect(r).toEqual({ ok: false, discovery_error: "no_secret" });
    expect(discoverCatalog).not.toHaveBeenCalled();
  });

  it("re-derives connection by tenant_id and discovers with the passed budget/cap", async () => {
    const r = await discoverCatalogForTenant("t1", { capMs: 240_000, tableCap: 1000 });
    expect(getSecret).toHaveBeenCalledWith("t1", "operator_db.connection_string");
    expect(discoverCatalog).toHaveBeenCalledWith("t1", "mongodb", "mongodb://x/db", {
      capMs: 240_000,
      tableCap: 1000,
      generation: 0,
    });
    expect(r).toEqual({ ok: true, tables_found: 500, entities_inferred: ["users"] });
  });

  it("an event from before a later transition is dropped (stale_request), nothing is read", async () => {
    const r = await discoverCatalogForTenant("t1", { generation: 7 });
    expect(r).toEqual({ ok: false, discovery_error: "stale_request" });
    expect(getSecret).not.toHaveBeenCalled();
    expect(discoverCatalog).not.toHaveBeenCalled();
  });

  it("falls back to the default secret key when the config column is empty", async () => {
    configRow = { type: "mongodb", connection_secret_key: "" };
    await discoverCatalogForTenant("t1");
    expect(getSecret).toHaveBeenCalledWith("t1", "operator_db.connection_string");
  });

  it("no_secret STAMPS the failure on the catalog using the known config dialect", async () => {
    configRow = { type: "postgres", connection_secret_key: "k" };
    getSecret.mockResolvedValueOnce(null);
    await discoverCatalogForTenant("t1");
    expect(persistDiscoveryFailure).toHaveBeenCalledWith("t1", "postgres", "no_secret", 0);
  });

  it("not_connected STAMPS the failure using the EXISTING catalog row's dialect", async () => {
    configRow = null;
    catalogRow = { dialect: "mysql" };
    await discoverCatalogForTenant("t1");
    expect(persistDiscoveryFailure).toHaveBeenCalledWith("t1", "mysql", "not_connected", 0);
  });

  it("not_connected with NO existing catalog row writes nothing (nothing to correct)", async () => {
    configRow = null;
    catalogRow = null;
    const r = await discoverCatalogForTenant("t1");
    expect(r).toEqual({ ok: false, discovery_error: "not_connected" });
    expect(persistDiscoveryFailure).not.toHaveBeenCalled();
  });

  it("a successful discovery never stamps a failure", async () => {
    await discoverCatalogForTenant("t1");
    expect(persistDiscoveryFailure).not.toHaveBeenCalled();
  });
});

describe("describeTenantDb: connector mode and audit", () => {
  it("connector mode never reads Vault (no connector paired -> connector_not_ready)", async () => {
    configRow = { type: "postgres", connection_secret_key: "k", mode: "connector" };
    expect(await discoverCatalogForTenant("t1")).toEqual({ ok: false, discovery_error: "connector_not_ready" });
    expect(getSecret).not.toHaveBeenCalled();
    expect(discoverCatalog).not.toHaveBeenCalled();
  });
  it("a structure scan is audited as background 'Schema discovery', scoped to the tenant", async () => {
    await discoverCatalogForTenant("t1");
    expect(audit.reserve.mock.calls[0]![0]).toMatchObject({
      operation: "structure_scan",
      query_text: "Structure scan: mongo",
      ctx: { tenant_id: "t1", caller: { kind: "background", feature: "Schema discovery" } },
    });
    expect(audit.finalize.mock.calls[0]![2]).toMatchObject({ result: "allowed", row_count: 500 });
    expect(scopedTo.every((t) => t === "t1")).toBe(true);
  });
});

describe("describeTenantDb records how the connection travels", () => {
  it("an existing MySQL login without TLS is recorded as plaintext at its next scan", async () => {
    configRow = { type: "mysql", connection_secret_key: "operator_db.connection_string", transport: null };
    getSecret.mockResolvedValueOnce("mysql://u:p@db.example.com/shop");
    await discoverCatalogForTenant("t1");
    expect(updates).toEqual([{ table: "tenant_db_config", patch: { transport: "plaintext" }, eq: ["mode", "direct"] }]);
  });
  it("no write when it is unchanged, and none after a failed scan", async () => {
    configRow = { type: "mysql", connection_secret_key: "k", transport: "plaintext" };
    getSecret.mockResolvedValueOnce("mysql://u:p@db.example.com/shop");
    await discoverCatalogForTenant("t1");
    configRow = { type: "mongodb", connection_secret_key: "k", transport: null };
    discoverCatalog.mockResolvedValueOnce({ ok: false, discovery_error: "x" });
    await discoverCatalogForTenant("t1");
    expect(updates).toEqual([]);
  });
});

describe("probeCandidate (connect-time test)", () => {
  const ctx = { tenant_id: "t1", caller: { kind: "background" as const, feature: "Connection test" } };
  it("probe failure -> ok:false and one failed audit row", async () => {
    probes.connectivity.mockResolvedValue({ ok: false, error: "auth failed" });
    expect(await probeCandidate(ctx, "postgres", "postgres://x")).toEqual({ ok: false, error: "auth failed" });
    expect(audit.reserve.mock.calls[0]![0]).toMatchObject({ operation: "connection_test", query_text: "Connection test: sign in and check permissions" });
    expect(audit.finalize.mock.calls[0]![2]).toMatchObject({ result: "failed" });
    expect(probes.write).not.toHaveBeenCalled();
  });
  it("probe ok -> write check, allowed row", async () => {
    probes.connectivity.mockResolvedValue({ ok: true });
    probes.write.mockResolvedValue("false");
    expect(await probeCandidate(ctx, "postgres", "postgres://x")).toEqual({ ok: true, write_capable: "false" });
    expect(audit.finalize.mock.calls[0]![2]).toMatchObject({ result: "allowed" });
  });
  it("audit unavailable -> the test does not run", async () => {
    audit.reserve.mockRejectedValue(new Error("down"));
    expect((await probeCandidate(ctx, "postgres", "postgres://x")).ok).toBe(false);
    expect(probes.connectivity).not.toHaveBeenCalled();
  });
});

describe("checkStoredLogin", () => {
  const ctx = { tenant_id: "t1", caller: { kind: "person" as const, user_id: "u1", feature: "Connection test" as const } };

  it("postgres: reads the tenant's own secret, audits a connection test, maps grants", async () => {
    configRow = { type: "postgres", connection_secret_key: "operator_db.connection_string" };
    getSecret.mockResolvedValueOnce("postgres://x/db");
    probes.write.mockResolvedValueOnce("true");
    expect(await checkStoredLogin(ctx)).toBe("can_write");
    expect(getSecret).toHaveBeenCalledWith("t1", "operator_db.connection_string");
    expect(audit.reserve).toHaveBeenCalledWith(expect.objectContaining({ operation: "connection_test" }));
    expect(audit.finalize).toHaveBeenCalled();
    expect(scopedTo.every((t) => t === "t1")).toBe(true);
  });

  it("mongodb: unknown without opening a connection or reading Vault", async () => {
    expect(await checkStoredLogin(ctx)).toBe("unknown");
    expect(getSecret).not.toHaveBeenCalled();
    expect(probes.write).not.toHaveBeenCalled();
  });

  it("connector mode or not connected: null, Vault never read", async () => {
    configRow = { type: "postgres", connection_secret_key: "k", mode: "connector" };
    expect(await checkStoredLogin(ctx)).toBeNull();
    configRow = null;
    expect(await checkStoredLogin(ctx)).toBeNull();
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("audit unavailable: no check runs", async () => {
    configRow = { type: "mysql", connection_secret_key: "k" };
    getSecret.mockResolvedValueOnce("mysql://x/db");
    audit.reserve.mockRejectedValueOnce(new Error("down"));
    expect(await checkStoredLogin(ctx)).toBeNull();
    expect(probes.write).not.toHaveBeenCalled();
  });
});
