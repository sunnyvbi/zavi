import { describe, it, expect, vi } from "vitest";
import { resolveResources, type ResolveResourcesDeps } from "@/services/provisioning/resolve-resources";
import type { Provisioner, ResourceKind } from "@/services/provisioning/types";
import {
  readStaticState,
  staticRoutingActive,
  writeStaticState,
  type StaticStateStore,
} from "@/services/hosting/static-publish";

const HOST = "acme.zaviagent.com";

function rowStore() {
  const rows = new Map<string, Record<string, unknown>>();
  const store: StaticStateStore = {
    load: async (tenant_id) => rows.get(`${tenant_id}:hosting`) ?? null,
    save: async (tenant_id, external_ref) => {
      rows.set(`${tenant_id}:hosting`, external_ref);
    },
  };
  const deps: ResolveResourcesDeps = {
    loadMode: vi.fn().mockResolvedValue(null),
    loadVaultKey: vi.fn().mockResolvedValue(null),
    loadExternalRef: async (tenant_id, kind) => rows.get(`${tenant_id}:${kind}`) ?? null,
    getProvisioner: () => null,
    setTenantResource: async (tenant_id, kind, _mode, _status, _provider, external_ref) => {
      rows.set(`${tenant_id}:${kind}`, (external_ref ?? {}) as Record<string, unknown>);
    },
  };
  return { rows, store, deps };
}

function renderLikeHosting(serviceId: string): Provisioner {
  return {
    kind: "hosting",
    provider: "render",
    ensure: async () => ({ external_ref: { render_service_id: serviceId, url: `https://${serviceId}.onrender.com` }, vault_keys: {} }),
    teardown: vi.fn(),
  };
}

async function publishLive(store: StaticStateStore, tenant_id: string) {
  await writeStaticState(
    tenant_id,
    {
      status: "live",
      sha: "a".repeat(40),
      deploy_id: "d1",
      at: "2026-09-29T00:00:00.000Z",
      hostname: HOST,
      routing_previous: {
        dns: [{ id: "dns_1", type: "CNAME", content: "srv-1.onrender.com", proxied: false, ttl: 1 }],
        created_dns_id: null,
        route: null,
        created_route_id: "route_1",
      },
    },
    store,
  );
}

describe("resolveResources keeps static hosting state across a hosting re-provision", () => {
  it("a rebuild that re-finds the Render service leaves the live static routing and its rollback snapshot intact", async () => {
    const { rows, store, deps } = rowStore();
    rows.set("t1:hosting", { render_service_id: "srv-1", url: "https://srv-1.onrender.com" });
    await publishLive(store, "t1");
    const before = await readStaticState("t1", store);
    expect(staticRoutingActive(before, HOST)).toBe(true);

    const map: Partial<Record<ResourceKind, Provisioner>> = { hosting: renderLikeHosting("srv-1") };
    await resolveResources("t1", "Acme", ["hosting"], { ...deps, getProvisioner: (k) => map[k] ?? null });
    await resolveResources("t1", "Acme", ["hosting"], { ...deps, getProvisioner: (k) => map[k] ?? null });

    const after = await readStaticState("t1", store);
    expect(after).toEqual(before);
    expect(staticRoutingActive(after, HOST)).toBe(true);
    expect(after?.routing_previous?.created_route_id).toBe("route_1");
    expect(rows.get("t1:hosting")).toMatchObject({ render_service_id: "srv-1" });
  });

  it("drops static state when the provisioner returns a different Render service, so rollback cannot target the old one", async () => {
    const { rows, store, deps } = rowStore();
    rows.set("t1:hosting", { render_service_id: "srv-old", url: "https://srv-old.onrender.com" });
    await publishLive(store, "t1");

    const map: Partial<Record<ResourceKind, Provisioner>> = { hosting: renderLikeHosting("srv-new") };
    await resolveResources("t1", "Acme", ["hosting"], { ...deps, getProvisioner: (k) => map[k] ?? null });

    expect(rows.get("t1:hosting")).toEqual({ render_service_id: "srv-new", url: "https://srv-new.onrender.com" });
  });

  it("does not invent static state for a tenant that never published statically, nor copy it onto other kinds", async () => {
    const { rows, deps } = rowStore();
    rows.set("t1:db", { neon_project_id: "np_1", static: { status: "live" } });
    const db: Provisioner = {
      kind: "db",
      provider: "neon",
      ensure: async () => ({ external_ref: { neon_project_id: "np_1" }, vault_keys: {} }),
      teardown: vi.fn(),
    };
    const map: Partial<Record<ResourceKind, Provisioner>> = { hosting: renderLikeHosting("srv-1"), db };
    await resolveResources("t1", "Acme", ["db", "hosting"], { ...deps, getProvisioner: (k) => map[k] ?? null });

    expect(rows.get("t1:hosting")).toEqual({ render_service_id: "srv-1", url: "https://srv-1.onrender.com" });
    expect(rows.get("t1:db")).toEqual({ neon_project_id: "np_1" });
  });
});
