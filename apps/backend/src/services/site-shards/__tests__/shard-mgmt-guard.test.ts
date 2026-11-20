
import { describe, expect, it, vi } from "vitest";
import { ZAVI_PLATFORM_REFS, assertNotPlatformRef, createShardMgmt } from "../shard-mgmt";

const ENV = { SUPABASE_MGMT_TOKEN: "t", SUPABASE_ORG_ID: "org-sites", SUPABASE_URL: "https://ownprojectrefaaaaaaa.supabase.co" };
const SHARD = "abcdefghijklmnopqrst";

function client(rows: unknown[] = []) {
  const fetchFn = vi.fn(async (url: string) => ({
    status: 200,
    text: async () => JSON.stringify(url.endsWith("/v1/projects") ? rows : [{ ok: 1 }]),
  }));
  return { m: createShardMgmt({ fetchFn, env: ENV }), fetchFn };
}

describe("shard mgmt: Zavi's own projects are off limits", () => {
  it.each([...ZAVI_PLATFORM_REFS, "ownprojectrefaaaaaaa"])("refuses %s before any request", async (ref) => {
    const { m, fetchFn } = client();
    await expect(m.query(ref, "select 1")).rejects.toThrow(/Zavi's own Supabase project/);
    await expect(m.setExposedSchemas(ref, "api")).rejects.toThrow(/Zavi's own/);
    await expect(m.patchAuthConfig(ref, {})).rejects.toThrow(/Zavi's own/);
    await expect(m.importSigningKey(ref, { private_jwk: {}, status: "standby" })).rejects.toThrow(/Zavi's own/);
    await expect(m.apiKeys(ref)).rejects.toThrow(/Zavi's own/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a shard ref goes through", async () => {
    const { m, fetchFn } = client();
    await m.query(SHARD, "select 1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toContain(`/v1/projects/${SHARD}/database/query`);
  });

  it("a name lookup that resolves to a platform project throws", async () => {
    const { m } = client([{ id: ZAVI_PLATFORM_REFS[0], name: "zavi-shard-prod-1", organization_id: "org-sites", status: "ACTIVE_HEALTHY" }]);
    await expect(m.listProjectsByName("zavi-shard-prod-1")).rejects.toThrow(/Zavi's own/);
  });

  it("assertNotPlatformRef passes ordinary refs", () => {
    expect(assertNotPlatformRef(SHARD, {})).toBe(SHARD);
    expect(() => assertNotPlatformRef("wmycgyjsenvgtczlupoe", {})).toThrow();
  });
});

describe("shard schema SQL loader (what provisioning and graduation apply)", () => {
  it("finds every shard file from the source tree: 0001-0011 + 0080 function callers core + 1001-1004, 1030, 1040 auth, each with a sha256", async () => {
    const { loadShardMigrations } = await import("../migrations");
    const files = loadShardMigrations();
    const versions = files.map((f) => f.version.slice(0, 4));
    expect(versions).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0013", "0080", "1001", "1002", "1003", "1004", "1030", "1040"]);
    for (const f of files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("an empty or missing SQL dir throws instead of applying nothing", async () => {
    const { loadShardMigrations } = await import("../migrations");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    expect(() => loadShardMigrations(mkdtempSync(join(tmpdir(), "no-shard-sql-")))).toThrow(/no shard schema SQL/);
  });
});
