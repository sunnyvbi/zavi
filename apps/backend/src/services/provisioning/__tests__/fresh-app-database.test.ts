import { describe, it, expect } from "vitest";
import { createNeonDbProvisioner } from "@/services/provisioning/neon-db";
import { attachAppDatabase } from "@/services/provisioning/render-hosting";
import {
  freshDatabaseName,
  giveNewAppFreshDatabase,
  type FreshAppDatabaseDeps,
} from "@/services/provisioning/fresh-app-database";

type Init = { method?: string; body?: string; headers?: Record<string, string> } | undefined;

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

const TENANT = "705e4a41-0914-424a-8308-50ad80d225bb";
const RUN = "5af7b461-7737-4c9c-bae2-4c9b77bb6549";
const PROJECT = "np_laptops";

function world() {
  const databases = [{ name: "neondb", owner_name: "neondb_owner" }];
  const ledgers: Record<string, Record<string, string>> = { neondb: { "0001_leads": "laptop-leads" } };
  const vault = new Map<string, string>();
  const renderEnv = new Map<string, string>();
  const neonCalls: Array<{ url: string; method: string; body?: unknown }> = [];
  let row = {
    mode: "provisioned",
    status: "ready",
    provider: "neon",
    external_ref: { neon_project_id: PROJECT } as Record<string, unknown>,
    vault_key: "db.connection_uri",
  };

  const neonFetch = async (url: string, init?: Init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    neonCalls.push({ url, method, body });
    if (url.includes("/connection_uri")) {
      const q = new URL(url).searchParams;
      const db = q.get("database_name");
      if (!databases.some((d) => d.name === db)) return res(404, { message: "no such database" });
      return res(200, { uri: `postgresql://${q.get("role_name")}:pw@ep-cake-pooler.neon.tech/${db}` });
    }
    if (url.endsWith(`/projects/${PROJECT}`)) return res(200, { project: { id: PROJECT } });
    if (url.endsWith(`/projects/${PROJECT}/branches`)) return res(200, { branches: [{ id: "br_main", default: true }] });
    if (url.endsWith("/roles")) {
      return res(200, { roles: [{ name: "zavi_readonly" }, { name: "neondb_owner", protected: false }] });
    }
    if (url.endsWith("/branches/br_main/databases") && method === "GET") return res(200, { databases: [...databases] });
    if (url.endsWith("/branches/br_main/databases") && method === "POST") {
      databases.push({ name: body.database.name, owner_name: body.database.owner_name });
      ledgers[body.database.name] = {};
      return res(201, { database: body.database });
    }
    return res(404, {});
  };

  const renderFetch = async (url: string, init?: Init) => {
    const key = decodeURIComponent(url.split("/env-vars/")[1] ?? "");
    renderEnv.set(key, JSON.parse(init?.body ?? "{}").value);
    return res(200, {});
  };

  const neon = createNeonDbProvisioner({
    token: () => "neon-token",
    orgId: () => null,
    fetchFn: neonFetch,
    persistSecret: async (_t, _k, key, val) => {
      vault.set(key, val);
      return key;
    },
  });
  vault.set("db.connection_uri", "postgresql://neondb_owner:pw@ep-cake-pooler.neon.tech/neondb?sslmode=require");

  const attach = (tenant_id: string) =>
    attachAppDatabase(tenant_id, {
      token: () => "render-token",
      fetchFn: renderFetch,
      resolveServiceId: async () => "srv-dato45gu01pc739tqjg0",
      dbUrl: async () => vault.get("db.connection_uri") ?? null,
      sessionSecret: async () => ({ value: "s".repeat(64) }) as never,
    });

  const deps: FreshAppDatabaseDeps = {
    readDbRow: async () => ({ ...row }),
    freshDatabase: (input) => neon.freshDatabase(input),
    record: async (_t, external_ref, vault_key) => {
      row = { ...row, external_ref, vault_key: vault_key ?? row.vault_key };
    },
    attach,
  };

  const pushTimeEnsure = async () => {
    const out = await neon.ensure({ tenant_id: TENANT, company_name: "app", existing_ref: row.external_ref } as never);
    row = { ...row, external_ref: out.external_ref };
    await attach(TENANT);
  };

  const migrateOnDeploy = (migrations: Record<string, string>) => {
    const db = new URL(renderEnv.get("DATABASE_URL") ?? "postgresql://x@h/none").pathname.slice(1);
    const ledger = ledgers[db];
    if (!ledger) throw new Error(`[migrate] FAILED connect: database ${db} does not exist`);
    for (const [id, checksum] of Object.entries(migrations)) {
      if (ledger[id] && ledger[id] !== checksum) {
        throw new Error(`[migrate] FAILED Error: applied migration ${id} was edited; append a new migration instead`);
      }
      ledger[id] = checksum;
    }
    return db;
  };

  return {
    deps,
    neonCalls,
    ledgers,
    renderEnv,
    databases,
    get row() {
      return row;
    },
    setRow: (r: Partial<typeof row>) => {
      row = { ...row, ...r };
    },
    pushTimeEnsure,
    migrateOnDeploy,
  };
}

const CAKE_MIGRATIONS = { "0001_leads": "cake-leads", "0002_lead_order_details": "cake-orders" };

describe("a new app that replaces the old one gets a fresh database", () => {
  it("reproduces the incident without it: the cake app's migrate hits the laptop ledger", async () => {
    const w = world();
    await w.pushTimeEnsure();
    expect(() => w.migrateOnDeploy(CAKE_MIGRATIONS)).toThrow(/applied migration 0001_leads was edited/);
  });

  it("the cake app deploys onto an empty database, and the push-time ensure keeps it there", async () => {
    const w = world();

    await expect(giveNewAppFreshDatabase({ tenant_id: TENANT, conductor_run_id: RUN }, w.deps)).resolves.toBe("fresh");
    await w.pushTimeEnsure();

    const fresh = freshDatabaseName(RUN);
    expect(fresh).toBe("app_5af7b4617737");
    expect(w.row.external_ref).toEqual({ neon_project_id: PROJECT, database_name: fresh });
    expect(w.renderEnv.get("DATABASE_URL")).toBe(
      `postgresql://neondb_owner:pw@ep-cake-pooler.neon.tech/${fresh}?sslmode=require`,
    );
    expect(w.migrateOnDeploy(CAKE_MIGRATIONS)).toBe(fresh);
    expect(w.ledgers.neondb).toEqual({ "0001_leads": "laptop-leads" });
    expect(w.databases.map((d) => d.name)).toEqual(["neondb", fresh]);
    const created = w.neonCalls.filter((c) => c.method === "POST");
    expect(created).toHaveLength(1);
    expect(created[0].body).toEqual({ database: { name: fresh, owner_name: "neondb_owner" } });
    expect(w.neonCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("a retried build start reuses its own fresh database instead of creating a second one", async () => {
    const w = world();
    await giveNewAppFreshDatabase({ tenant_id: TENANT, conductor_run_id: RUN }, w.deps);
    w.setRow({ external_ref: { neon_project_id: PROJECT } });

    await giveNewAppFreshDatabase({ tenant_id: TENANT, conductor_run_id: RUN }, w.deps);

    expect(w.neonCalls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(w.databases.map((d) => d.name)).toEqual(["neondb", freshDatabaseName(RUN)]);
  });

  it("never touches a database the founder connected, or a tenant with no app database yet", async () => {
    for (const r of [{ mode: "connected" }, { status: "pending" }, { external_ref: {} }]) {
      const w = world();
      w.setRow(r);
      await expect(giveNewAppFreshDatabase({ tenant_id: TENANT, conductor_run_id: RUN }, w.deps)).resolves.toBe(
        "no_app_db",
      );
      expect(w.neonCalls).toHaveLength(0);
      expect(w.renderEnv.size).toBe(0);
    }
  });

  it("records nothing and leaves Render alone when Neon refuses the new database", async () => {
    const w = world();
    const refusing: FreshAppDatabaseDeps = {
      ...w.deps,
      freshDatabase: async () => {
        throw new Error("fresh app database: create failed (423): project locked");
      },
    };

    await expect(giveNewAppFreshDatabase({ tenant_id: TENANT, conductor_run_id: RUN }, refusing)).rejects.toThrow(
      /project locked/,
    );
    expect(w.row.external_ref).toEqual({ neon_project_id: PROJECT });
    expect(w.renderEnv.size).toBe(0);
  });
});
