import { describe, expect, it } from "vitest";
import { CAPABILITY_SERVICE, capabilityNotSupported, DEDICATED_CAPABILITIES, ROUTING_CAPABILITIES, describeCapabilities, detectDedicatedCapabilities, isSqlPath, rawSqlRefusal } from "../capabilities";
import { pooledStarterNeedsDedicated } from "@/services/agents/fast-build";

describe("dedicated capability detection (contract section 5)", () => {
  it("lists exactly the contract's ten capabilities", () => {
    expect([...DEDICATED_CAPABILITIES]).toEqual([
      "payments", "payouts", "interval_overlap", "multi_step_workflow", "webhooks",
      "secrets", "jobs", "arbitrary_joins", "server_compute", "raw_sql",
    ]);
  });

  for (const cap of ROUTING_CAPABILITIES) {
    it(`detects a declared "${cap}" (routes dedicated)`, () => {
      const d = detectDedicatedCapabilities({ manifestRaw: { schemaVersion: 2, capabilities: [cap], collections: {} } });
      expect(d.capabilities).toEqual([cap]);
      expect(d.rawSql).toBe(false);
    });
  }

  it('a declared "raw_sql" is NEVER a route: reported as rawSql (refused), not as a capability', () => {
    const d = detectDedicatedCapabilities({ manifestRaw: { schemaVersion: 2, capabilities: ["raw_sql", "jobs"], collections: {} } });
    expect(d.capabilities).toEqual(["jobs"]);
    expect(d.rawSql).toBe(true);
    expect(d.declaredRawSql).toBe(true);
    expect(ROUTING_CAPABILITIES).not.toContain("raw_sql");
    expect(detectDedicatedCapabilities({ manifestRaw: null, paths: ["supabase/x.sql"] }).declaredRawSql).toBe(false);
    expect(capabilityNotSupported(["payments"])).toMatch(/needs taking payments, which Zavi's database does not support yet/);
  });

  it("SQL / supabase paths mean rawSql (a refusal) even when nothing is declared; never a capability", () => {
    for (const p of ["supabase/migrations/001_x.sql", "supabase", "db/seed.SQL", "./supabase/config.toml", "src\\x.sql"]) {
      expect(isSqlPath(p), p).toBe(true);
      const d = detectDedicatedCapabilities({ manifestRaw: { collections: {} }, paths: ["src/App.tsx", p] });
      expect(d.capabilities).toEqual([]);
      expect(d.rawSql).toBe(true);
      expect(d.sqlPaths).toEqual([p]);
    }
    const none = detectDedicatedCapabilities({ manifestRaw: null, paths: ["src/App.tsx", "supabase-client.ts", "README.md"] });
    expect(none).toMatchObject({ capabilities: [], rawSql: false, sqlPaths: [] });
  });

  it("the refusal tells the builder to use collections + the data SDK and names the files", () => {
    const r = rawSqlRefusal(["supabase/migrations/001_x.sql"]);
    expect(r.reason).toMatch(/never runs SQL from a site/);
    expect(r.reason).toMatch(/supabase\/migrations\/001_x\.sql/);
    expect(r.signal).toMatch(/declare the data the site stores as collections in zavi-site\.json/);
    expect(r.signal).toMatch(/Zavi data SDK/);
    expect(rawSqlRefusal([]).reason).toMatch(/"raw_sql" in zavi-site\.json capabilities/);
  });

  it("the service matrix: the kernel serves none of the nine semantic capabilities today; raw_sql is refused", () => {
    for (const c of ROUTING_CAPABILITIES) expect(CAPABILITY_SERVICE[c], c).toBe("legacy_dedicated_project");
    expect(CAPABILITY_SERVICE.raw_sql).toBe("refused");
    expect(Object.keys(CAPABILITY_SERVICE).sort()).toEqual([...DEDICATED_CAPABILITIES].sort());
  });

  it("reads the RAW manifest: a v1 file (which the v1 validator refuses for the key) still reveals the need", () => {
    const raw = { schemaVersion: 1, capabilities: ["payments", "webhooks", "payments"], collections: {} };
    expect(detectDedicatedCapabilities({ manifestRaw: raw }).capabilities).toEqual(["payments", "webhooks"]);
  });

  it("unknown strings are reported, never acted on; junk shapes yield nothing", () => {
    const d = detectDedicatedCapabilities({ manifestRaw: { capabilities: ["teleport", 7, null, "jobs"] } });
    expect(d.capabilities).toEqual(["jobs"]);
    expect(d.unknown).toEqual(["teleport"]);
    for (const raw of [null, "x", [], { capabilities: "payments" }, { capabilities: { payments: true } }]) {
      expect(detectDedicatedCapabilities({ manifestRaw: raw }).capabilities).toEqual([]);
    }
  });

  it("describes needs in founder words", () => {
    expect(describeCapabilities(["payments", "webhooks", "raw_sql"])).toBe("taking payments, webhooks and its own SQL");
  });

  it("fast-build: a pooled starter that needs a capability is never used pooled", () => {
    const ok = { files: { "src/App.tsx": "" }, manifest_json: JSON.stringify({ schemaVersion: 1, collections: {} }) };
    expect(pooledStarterNeedsDedicated(ok)).toBe(false);
    expect(pooledStarterNeedsDedicated({ ...ok, manifest_json: JSON.stringify({ schemaVersion: 2, capabilities: ["jobs"], collections: {} }) })).toBe(true);
    expect(pooledStarterNeedsDedicated({ ...ok, files: { ...ok.files, "supabase/migrations/1.sql": "" } })).toBe(false);
    expect(pooledStarterNeedsDedicated({ ...ok, manifest_json: "{not json" })).toBe(false);
  });
});
