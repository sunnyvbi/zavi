import { describe, it, expect, vi } from "vitest";
import { createNeonDbProvisioner, neonProjectName } from "@/services/provisioning/neon-db";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import { tenantSuffix } from "@/services/provisioning/tenant-slug";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

type Init = { method?: string; body?: string } | undefined;

function createdName(calls: Array<{ url: string; init: Init }>): string | undefined {
  const post = calls.find((c) => c.url.endsWith("/projects") && (c.init?.method ?? "GET") === "POST");
  if (!post?.init?.body) return undefined;
  return (JSON.parse(post.init.body) as { project?: { name?: string } }).project?.name;
}

function routedFetch(routes: {
  list?: unknown;
  create?: unknown;
  branches?: unknown;
  roles?: unknown;
  databases?: unknown;
  connectionUri?: unknown;
  probe?: unknown;
}) {
  const calls: Array<{ url: string; init: Init }> = [];
  const fn = vi.fn(async (url: string, init?: Init) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (url.includes("/connection_uri")) return routes.connectionUri ?? res(404, { message: "no uri" });
    if (url.includes("/roles")) return routes.roles ?? res(404, {});
    if (url.includes("/databases")) return routes.databases ?? res(404, {});
    if (url.endsWith("/branches")) return routes.branches ?? res(404, {});
    if (url.endsWith("/projects") && method === "POST") return routes.create ?? res(201, { project: { id: "np_x" } });
    if (/\/projects\/[^/?]+$/.test(url) && method === "GET") return routes.probe ?? res(200, { project: { id: "np_recorded" } });
    if (url.includes("/projects")) return routes.list ?? res(200, { projects: [] });
    return res(404, {});
  });
  return { fn, calls };
}

describe("neonProjectName (FIX#12 — tenant-scoped key)", () => {
  it("slugifies the company AND suffixes the tenant hash (readable prefix, tenant-unique key)", () => {
    const name = neonProjectName("Acme Co!", "t1");
    expect(name).toBe(`acme-co-${tenantSuffix("t1")}`);
    expect(name).toContain(tenantSuffix("t1"));
  });

  it("same company + DIFFERENT tenant → DIFFERENT names (no shared key)", () => {
    expect(neonProjectName("PawPal", "0d2f6bfa")).not.toBe(neonProjectName("PawPal", "32e79228"));
  });

  it("same company + SAME tenant → SAME name (idempotent reuse key)", () => {
    expect(neonProjectName("PawPal", "tA")).toBe(neonProjectName("PawPal", "tA"));
  });

  it("the name is NEVER the bare company slug (the FIX#12 cross-tenant bug key)", () => {
    expect(neonProjectName("PawPal", "tA")).not.toBe("pawpal");
  });
});

describe("NeonDbProvisioner", () => {
  it("gated: missing NEON_API_KEY → CredentialNotConfigured", async () => {
    const p = createNeonDbProvisioner({ token: () => null, fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "NEON_API_KEY",
    });
  });

  it("FIX#6 heal: existing project still resolves + persists the connection URI (no longer DB-dead)", async () => {
    const { fn, calls } = routedFetch({
      list: res(200, { projects: [{ id: "np_old", name: neonProjectName("Acme", "t1") }] }),
      branches: res(200, { branches: [{ id: "br_1", default: true }] }),
      roles: res(200, { roles: [{ name: "acme_owner", protected: false }] }),
      databases: res(200, { databases: [{ name: "neondb" }] }),
      connectionUri: res(200, { uri: "postgresql://acme_owner:pw@ep-pooler.neon.tech/neondb" }),
    });
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const p = createNeonDbProvisioner({ token: () => "tok", orgId: () => "org_1", fetchFn: fn as never, persistSecret: persist });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });

    expect(r.external_ref).toEqual({ neon_project_id: "np_old" });
    expect(r.vault_keys).toEqual({ connection_uri: "db.connection_uri" });
    expect(persist).toHaveBeenCalledWith(
      "t1",
      "db",
      "db.connection_uri",
      "postgresql://acme_owner:pw@ep-pooler.neon.tech/neondb?sslmode=require",
    );
    expect(calls.some((c) => c.url.endsWith("/projects") && (c.init?.method ?? "GET") === "POST")).toBe(false);
    expect(calls.some((c) => /\/branches\/br_1\/roles/.test(c.url))).toBe(true);
    expect(calls.some((c) => /\/branches\/br_1\/databases/.test(c.url))).toBe(true);
  });

  it("FIX#6 create: empty connection_uris → fetches POOLED URI via explicit endpoint + persists", async () => {
    const { fn, calls } = routedFetch({
      list: res(200, { projects: [] }),
      create: res(201, {
        project: { id: "np_42" },
        roles: [{ name: "neondb_owner", protected: false }],
        databases: [{ name: "neondb", owner_name: "neondb_owner" }],
        branch: { id: "br_main", default: true },
      }),
      connectionUri: res(200, { uri: "postgresql://neondb_owner:pw@ep-pooler.neon.tech/neondb?sslmode=require" }),
    });
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });
    const r = await p.ensure({ tenant_id: "t9", company_name: "EmptyUris Co" });

    expect(r.external_ref.neon_project_id).toBe("np_42");
    expect(r.vault_keys).toEqual({ connection_uri: "db.connection_uri" });
    expect(persist).toHaveBeenCalledWith(
      "t9",
      "db",
      "db.connection_uri",
      "postgresql://neondb_owner:pw@ep-pooler.neon.tech/neondb?sslmode=require",
    );
    const uriCall = calls.find((c) => c.url.includes("/connection_uri"));
    expect(uriCall).toBeTruthy();
    expect(uriCall!.url).toContain("pooled=true");
    expect(uriCall!.url).toContain("role_name=neondb_owner");
    expect(uriCall!.url).toContain("database_name=neondb");
    expect(calls.some((c) => c.url.endsWith("/branches"))).toBe(false);
  });

  it("FIX#6: resolves branch + role + database via GET fallback when create body omits them", async () => {
    const { fn, calls } = routedFetch({
      list: res(200, { projects: [] }),
      create: res(201, { project: { id: "np_77" } }),
      branches: res(200, { branches: [{ id: "br_def", primary: true }] }),
      roles: res(200, { roles: [{ name: "owner_role", protected: false }] }),
      databases: res(200, { databases: [{ name: "appdb" }] }),
      connectionUri: res(200, { uri: "postgresql://owner_role:pw@ep-pooler.neon.tech/appdb" }),
    });
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });
    await p.ensure({ tenant_id: "t7", company_name: "Fallback Co" });

    expect(persist).toHaveBeenCalledWith(
      "t7",
      "db",
      "db.connection_uri",
      "postgresql://owner_role:pw@ep-pooler.neon.tech/appdb?sslmode=require",
    );
    expect(calls.some((c) => c.url.endsWith("/branches"))).toBe(true);
    expect(calls.some((c) => /\/branches\/br_def\/roles/.test(c.url))).toBe(true);
    expect(calls.some((c) => /\/branches\/br_def\/databases/.test(c.url))).toBe(true);
  });

  it("FIX#6: pooled + sslmode=require URI is persisted (sslmode appended when endpoint omits it)", async () => {
    const { fn } = routedFetch({
      list: res(200, { projects: [] }),
      create: res(201, {
        project: { id: "np_ssl" },
        roles: [{ name: "r", protected: false }],
        databases: [{ name: "d" }],
      }),
      connectionUri: res(200, { uri: "postgresql://r:pw@ep-pooler.neon.tech/d" }),
    });
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });
    await p.ensure({ tenant_id: "t1", company_name: "Ssl Co" });
    const persistedUri = persist.mock.calls[0][3] as string;
    expect(persistedUri).toContain("sslmode=require");
    expect(persistedUri).toContain("-pooler");
  });

  it("FIX#6: unobtainable URI (connection_uri endpoint fails) → THROW + no secret persisted", async () => {
    const { fn } = routedFetch({
      list: res(200, { projects: [] }),
      create: res(201, {
        project: { id: "np_dead" },
        roles: [{ name: "r", protected: false }],
        databases: [{ name: "d" }],
      }),
      connectionUri: res(500, { message: "neon transient" }),
    });
    const persist = vi.fn();
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Dead Co" })).rejects.toThrow(/could not be resolved/i);
    expect(persist).not.toHaveBeenCalled();
  });

  it("FIX#6: role/database unresolvable → THROW (not a silent ready)", async () => {
    const { fn } = routedFetch({
      list: res(200, { projects: [] }),
      create: res(201, { project: { id: "np_norole" } }),
      branches: res(200, { branches: [{ id: "br_x", default: true }] }),
      roles: res(200, { roles: [] }),
      databases: res(200, { databases: [] }),
    });
    const persist = vi.fn();
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });
    await expect(p.ensure({ tenant_id: "t1", company_name: "NoRole Co" })).rejects.toThrow(/could not be resolved/i);
    expect(persist).not.toHaveBeenCalled();
  });

  it("teardown deletes the project", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(200, {}));
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fetchFn as never });
    await expect(p.teardown({ neon_project_id: "np_1" })).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("kind/provider = db/neon", () => {
    const p = createNeonDbProvisioner({ token: () => "tok" });
    expect(p.kind).toBe("db");
    expect(p.provider).toBe("neon");
  });

  it("FIX#12 (a) KEY REGRESSION: SAME company + DIFFERENT tenant → TWO DIFFERENT Neon projects (no shared DB)", async () => {
    const make = (createId: string) =>
      routedFetch({
        list: res(200, { projects: [] }),
        create: res(201, {
          project: { id: createId },
          roles: [{ name: "owner", protected: false }],
          databases: [{ name: "neondb" }],
        }),
        connectionUri: res(200, { uri: `postgresql://owner:pw@ep-pooler.neon.tech/neondb` }),
      });

    const a = make("np_tenantA");
    const b = make("np_tenantB");
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const pa = createNeonDbProvisioner({ token: () => "tok", fetchFn: a.fn as never, persistSecret: persist });
    const pb = createNeonDbProvisioner({ token: () => "tok", fetchFn: b.fn as never, persistSecret: persist });

    const ra = await pa.ensure({ tenant_id: "0d2f6bfa", company_name: "PawPal" });
    const rb = await pb.ensure({ tenant_id: "32e79228", company_name: "PawPal" });

    expect(ra.external_ref.neon_project_id).toBe("np_tenantA");
    expect(rb.external_ref.neon_project_id).toBe("np_tenantB");
    expect(ra.external_ref.neon_project_id).not.toBe(rb.external_ref.neon_project_id);

    const nameA = createdName(a.calls);
    const nameB = createdName(b.calls);
    expect(nameA).toBe(neonProjectName("PawPal", "0d2f6bfa"));
    expect(nameB).toBe(neonProjectName("PawPal", "32e79228"));
    expect(nameA).not.toBe(nameB);
    expect(nameA).not.toBe("pawpal");
    expect(nameB).not.toBe("pawpal");
  });

  it("FIX#12 (b) same tenant + same app re-ensure REUSES the same project (lineage preserved, no new create)", async () => {
    const existingId = "np_reuse";
    const { fn, calls } = routedFetch({
      list: res(200, { projects: [{ id: existingId, name: neonProjectName("PawPal", "tA") }] }),
      branches: res(200, { branches: [{ id: "br_1", default: true }] }),
      roles: res(200, { roles: [{ name: "owner", protected: false }] }),
      databases: res(200, { databases: [{ name: "neondb" }] }),
      connectionUri: res(200, { uri: "postgresql://owner:pw@ep-pooler.neon.tech/neondb" }),
    });
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });

    const r = await p.ensure({ tenant_id: "tA", company_name: "PawPal" });

    expect(r.external_ref).toEqual({ neon_project_id: existingId });
    expect(calls.some((c) => c.url.endsWith("/projects") && (c.init?.method ?? "GET") === "POST")).toBe(false);
    expect(persist).toHaveBeenCalledWith("tA", "db", "db.connection_uri", expect.stringContaining("sslmode=require"));
  });

  it("FIX#12 (c') tenant B does NOT reuse tenant A's tenant-scoped project for the same company", async () => {
    const { fn, calls } = routedFetch({
      list: res(200, { projects: [{ id: "np_tenantA", name: neonProjectName("PawPal", "0d2f6bfa") }] }),
      create: res(201, {
        project: { id: "np_tenantB" },
        roles: [{ name: "owner", protected: false }],
        databases: [{ name: "neondb" }],
      }),
      connectionUri: res(200, { uri: "postgresql://owner:pw@ep-pooler.neon.tech/neondb" }),
    });
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });

    const r = await p.ensure({ tenant_id: "32e79228", company_name: "PawPal" });

    expect(r.external_ref.neon_project_id).toBe("np_tenantB");
    expect(r.external_ref.neon_project_id).not.toBe("np_tenantA");
    expect(createdName(calls)).toBe(neonProjectName("PawPal", "32e79228"));
  });

  it("FIX#12 (c) IGNORES a project named by the BARE company slug (cross-tenant squat is NOT reused)", async () => {
    const { fn, calls } = routedFetch({
      list: res(200, { projects: [{ id: "np_bareslug", name: "pawpal" }] }),
      create: res(201, {
        project: { id: "np_fresh" },
        roles: [{ name: "owner", protected: false }],
        databases: [{ name: "neondb" }],
      }),
      connectionUri: res(200, { uri: "postgresql://owner:pw@ep-pooler.neon.tech/neondb" }),
    });
    const persist = vi.fn().mockResolvedValue("db.connection_uri");
    const p = createNeonDbProvisioner({ token: () => "tok", fetchFn: fn as never, persistSecret: persist });

    const r = await p.ensure({ tenant_id: "tA", company_name: "PawPal" });

    expect(r.external_ref.neon_project_id).toBe("np_fresh");
    expect(r.external_ref.neon_project_id).not.toBe("np_bareslug");
    expect(createdName(calls)).toBe(neonProjectName("PawPal", "tA"));
  });
});

describe("NeonDbProvisioner — never creates a second database for a tenant", () => {
  const RECORDED = { neon_project_id: "np_recorded" };

  function resolvable() {
    return {
      branches: res(200, { branches: [{ id: "br_1", default: true }] }),
      roles: res(200, { roles: [{ name: "o", protected: false }] }),
      databases: res(200, { databases: [{ name: "neondb" }] }),
      connectionUri: res(200, { uri: "postgresql://o:pw@ep-pooler.neon.tech/neondb" }),
    };
  }

  it("rebinds to the RECORDED project and never lists or creates", async () => {
    const { fn, calls } = routedFetch({ ...resolvable(), list: res(200, { projects: [] }) });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme", existing_ref: RECORDED });

    expect(r.external_ref).toEqual({ neon_project_id: "np_recorded" });
    expect(calls.some((c) => c.url.endsWith("/projects") && c.init?.method === "POST")).toBe(false);
    expect(calls.some((c) => c.url.includes("/projects?") && (c.init?.method ?? "GET") === "GET")).toBe(false);
  });

  for (const roles of [
    [{ name: "zavi_readonly", protected: false }, { name: "o", protected: false }],
    [{ name: "o", protected: false }, { name: "zavi_readonly", protected: false }],
  ]) {
    it(`heal keeps the OWNER role, never zavi_readonly (roles: ${roles.map((r) => r.name).join(",")})`, async () => {
      const { fn, calls } = routedFetch({ ...resolvable(), roles: res(200, { roles }) });
      const p = createNeonDbProvisioner({
        token: () => "tok",
        fetchFn: fn as never,
        persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
      });
      await p.ensure({ tenant_id: "t1", company_name: "Acme", existing_ref: RECORDED });
      const uriCall = calls.find((c) => c.url.includes("/connection_uri"));
      expect(uriCall!.url).toContain("role_name=o");
      expect(uriCall!.url).not.toContain("zavi_readonly");
    });
  }

  it("prefers the database's owner_name over list order", async () => {
    const create = res(201, {
      project: { id: "np_x" },
      roles: [{ name: "other", protected: false }, { name: "app_owner", protected: false }],
      databases: [{ name: "neondb", owner_name: "app_owner" }],
      branch: { id: "br_1" },
    });
    const { fn, calls } = routedFetch({
      create,
      connectionUri: res(200, { uri: "postgresql://app_owner:pw@ep-pooler.neon.tech/neondb" }),
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    await p.ensure({ tenant_id: "t1", company_name: "Acme" });
    expect(calls.find((c) => c.url.includes("/connection_uri"))!.url).toContain("role_name=app_owner");
  });

  it("ignores a recorded ref that carries no usable project id", async () => {
    const { fn, calls } = routedFetch({
      ...resolvable(),
      list: res(200, { projects: [] }),
      create: res(201, { project: { id: "np_new" } }),
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    const r = await p.ensure({
      tenant_id: "t1",
      company_name: "Acme",
      existing_ref: { neon_project_id: "" },
    });
    expect(r.external_ref.neon_project_id).toBe("np_new");
    expect(calls.some((c) => c.url.endsWith("/projects") && c.init?.method === "POST")).toBe(true);
  });

  it("REAL NEON SHAPE: a full page plus a cursor, then an empty page, still creates", async () => {
    let page = 0;
    const calls: Array<{ url: string; method: string }> = [];
    const fn = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/connection_uri"))
        return res(200, { uri: "postgresql://o:pw@ep-pooler.neon.tech/neondb" });
      if (url.includes("/roles")) return res(200, { roles: [{ name: "o", protected: false }] });
      if (url.includes("/databases")) return res(200, { databases: [{ name: "neondb" }] });
      if (url.endsWith("/branches")) return res(200, { branches: [{ id: "br_1", default: true }] });
      if (url.endsWith("/projects") && method === "POST")
        return res(201, { project: { id: "np_created" } });
      if (url.includes("/projects")) {
        page += 1;
        return res(200, {
          projects: page === 1 ? [{ id: "np_a", name: "someone-else" }] : [],
          pagination: { cursor: "lively-recipe-43068908" },
        });
      }
      return res(404, {});
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });
    expect(r.external_ref).toEqual({ neon_project_id: "np_created" });
    expect(calls.some((c) => c.url.endsWith("/projects") && c.method === "POST")).toBe(true);
  });

  it("a page that could not load some projects REFUSES, even if the walk then ends cleanly", async () => {
    let page = 0;
    const calls: Array<{ url: string; method: string }> = [];
    const fn = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/projects") && method === "POST")
        return res(201, { project: { id: "np_created" } });
      if (url.includes("/projects")) {
        page += 1;
        return res(200, {
          projects: page === 1 ? [{ id: "np_a", name: "someone-else" }] : [],
          pagination: { cursor: "lively-recipe-43068908" },
          unavailable_project_ids: page === 1 ? ["np_hidden"] : [],
        });
      }
      return res(404, {});
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toThrow(
      /did not complete/i,
    );
    expect(calls.some((c) => c.url.endsWith("/projects") && c.method === "POST")).toBe(false);
  });

  it("a repeated cursor on a page that still has rows is STUCK, and refuses to create", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fn = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/projects") && method === "POST")
        return res(201, { project: { id: "np_created" } });
      if (url.includes("/projects"))
        return res(200, {
          projects: [{ id: "np_a", name: "someone-else" }],
          pagination: { cursor: "frozen" },
        });
      return res(404, {});
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toThrow(
      /did not complete/i,
    );
    expect(calls.some((c) => c.url.endsWith("/projects") && c.method === "POST")).toBe(false);
  });

  it("PAGINATES the name lookup — finds a project that is not on page 1", async () => {
    const target = neonProjectName("Acme", "t1");
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `np_${i}`, name: `other-${i}` }));
    let listCalls = 0;
    const calls: Array<{ url: string; init: { method?: string; body?: string } | undefined }> = [];
    const fn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, init });
      if (url.includes("/connection_uri"))
        return res(200, { uri: "postgresql://o:pw@ep-pooler.neon.tech/neondb" });
      if (url.includes("/roles")) return res(200, { roles: [{ name: "o", protected: false }] });
      if (url.includes("/databases")) return res(200, { databases: [{ name: "neondb" }] });
      if (url.endsWith("/branches")) return res(200, { branches: [{ id: "br_1", default: true }] });
      if (url.endsWith("/projects") && init?.method === "POST") return res(201, { project: { id: "np_dupe" } });
      if (url.includes("/projects")) {
        listCalls++;
        return listCalls === 1
          ? res(200, { projects: page1, pagination: { cursor: "c1" } })
          : res(200, { projects: [{ id: "np_found", name: target }] });
      }
      return res(404, {});
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });

    expect(r.external_ref).toEqual({ neon_project_id: "np_found" });
    expect(listCalls).toBe(2);
    expect(calls.some((c) => c.url.endsWith("/projects") && c.init?.method === "POST")).toBe(false);
  });

  it("keeps paging when a SHORT page still carries a cursor", async () => {
    const target = neonProjectName("Acme", "t1");
    let listCalls = 0;
    const calls: Array<{ url: string; init: Init }> = [];
    const fn = vi.fn(async (url: string, init?: Init) => {
      calls.push({ url, init });
      if (url.includes("/connection_uri"))
        return res(200, { uri: "postgresql://o:pw@ep-pooler.neon.tech/neondb" });
      if (url.includes("/roles")) return res(200, { roles: [{ name: "o", protected: false }] });
      if (url.includes("/databases")) return res(200, { databases: [{ name: "neondb" }] });
      if (url.endsWith("/branches")) return res(200, { branches: [{ id: "br_1", default: true }] });
      if (url.endsWith("/projects") && init?.method === "POST") return res(201, { project: { id: "np_dupe" } });
      if (url.includes("/projects")) {
        listCalls++;
        return listCalls === 1
          ? res(200, {
              projects: Array.from({ length: 10 }, (_, i) => ({ id: `np_${i}`, name: `other-${i}` })),
              pagination: { cursor: "c1" },
            })
          : res(200, { projects: [{ id: "np_found", name: target }] });
      }
      return res(404, {});
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });

    expect(r.external_ref).toEqual({ neon_project_id: "np_found" });
    expect(listCalls).toBe(2);
    expect(calls.some((c) => c.url.endsWith("/projects") && c.init?.method === "POST")).toBe(false);
  });

  it("REFUSES to create when the cursor repeats — an unfinished scan is not proof of absence", async () => {
    let listCalls = 0;
    const fn = vi.fn(async (url, init) => {
      if (url.includes("/connection_uri"))
        return res(200, { uri: "postgresql://o:pw@ep-pooler.neon.tech/neondb" });
      if (url.includes("/roles")) return res(200, { roles: [{ name: "o", protected: false }] });
      if (url.includes("/databases")) return res(200, { databases: [{ name: "neondb" }] });
      if (url.endsWith("/branches")) return res(200, { branches: [{ id: "br_1", default: true }] });
      if (url.endsWith("/projects") && init?.method === "POST") return res(201, { project: { id: "np_new" } });
      if (url.includes("/projects")) {
        listCalls++;
        return res(200, { projects: [{ id: "np_a", name: "unrelated" }], pagination: { cursor: "same" } });
      }
      return res(404, {});
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toThrow(
      /did not complete/,
    );
    expect(listCalls).toBeLessThanOrEqual(3);
  });

  it("stops paging when the cursor runs out, and still creates when there is no match", async () => {
    const { fn, calls } = routedFetch({
      ...resolvable(),
      list: res(200, { projects: [{ id: "np_a", name: "unrelated" }] }),
      create: res(201, { project: { id: "np_new" } }),
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });
    expect(r.external_ref.neon_project_id).toBe("np_new");
    expect(calls.some((c) => c.url.endsWith("/projects") && c.init?.method === "POST")).toBe(true);
  });
});

describe("NeonDbProvisioner — a recorded binding is verified, not trusted", () => {
  function resolvable() {
    return {
      branches: res(200, { branches: [{ id: "br_1", default: true }] }),
      roles: res(200, { roles: [{ name: "o", protected: false }] }),
      databases: res(200, { databases: [{ name: "neondb" }] }),
      connectionUri: res(200, { uri: "postgresql://o:pw@ep-pooler.neon.tech/neondb" }),
    };
  }

  it("a 404 on the recorded project REPROVISIONS instead of wedging", async () => {
    const { fn, calls } = routedFetch({
      ...resolvable(),
      probe: res(404, { message: "not found" }),
      list: res(200, { projects: [] }),
      create: res(201, { project: { id: "np_replacement" } }),
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    const r = await p.ensure({
      tenant_id: "t1",
      company_name: "Acme",
      existing_ref: { neon_project_id: "np_deleted" },
    });
    expect(r.external_ref.neon_project_id).toBe("np_replacement");
    expect(calls.some((c) => c.url.endsWith("/projects") && c.init?.method === "POST")).toBe(true);
  });

  it("a 5xx on the probe THROWS and keeps the binding — a blip is not a licence to create", async () => {
    const { fn, calls } = routedFetch({
      ...resolvable(),
      probe: res(503, { message: "upstream" }),
      list: res(200, { projects: [] }),
      create: res(201, { project: { id: "np_should_not_exist" } }),
    });
    const p = createNeonDbProvisioner({
      token: () => "tok",
      fetchFn: fn as never,
      persistSecret: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    await expect(
      p.ensure({ tenant_id: "t1", company_name: "Acme", existing_ref: { neon_project_id: "np_x" } }),
    ).rejects.toThrow(/probe failed/);
    expect(calls.some((c) => c.url.endsWith("/projects") && c.init?.method === "POST")).toBe(false);
  });
});
