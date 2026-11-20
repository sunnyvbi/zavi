import { describe, it, expect, vi } from "vitest";
import { resolveResources, type ResolveResourcesDeps } from "@/services/provisioning/resolve-resources";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";
import type { Provisioner, ResourceKind, ResourceMode } from "@/services/provisioning/types";

function fakeProvisioner(
  kind: ResourceKind,
  ensure: Provisioner["ensure"],
): Provisioner {
  return { kind, provider: `${kind}-prov`, ensure, teardown: vi.fn() };
}

function deps(over: Partial<ResolveResourcesDeps> = {}): ResolveResourcesDeps & {
  setTenantResource: ReturnType<typeof vi.fn>;
} {
  return {
    loadMode: vi.fn().mockResolvedValue(null),
    loadVaultKey: vi.fn().mockResolvedValue(null),
    loadExternalRef: vi.fn().mockResolvedValue(null),
    getProvisioner: () => null,
    setTenantResource: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as ResolveResourcesDeps & { setTenantResource: ReturnType<typeof vi.fn> };
}

describe("resolveResources", () => {
  it("connected mode → skipped, no provisioner call, no row write", async () => {
    const getProvisioner = vi.fn();
    const d = deps({ loadMode: vi.fn().mockResolvedValue("connected" as ResourceMode), getProvisioner });
    const r = await resolveResources("t1", "Acme", ["repo"], d);
    expect(r.connected).toEqual(["repo"]);
    expect(r.provisioned).toEqual([]);
    expect(getProvisioner).not.toHaveBeenCalled();
    expect(d.setTenantResource).not.toHaveBeenCalled();
  });

  it("provisioned → calls ensure, records the row, and passes external_ref to downstream context", async () => {
    const repo = fakeProvisioner("repo", async () => ({
      external_ref: { repo_url: "https://github.com/praxis-built/acme" },
      vault_keys: {},
    }));
    let hostingSawContext: Record<string, unknown> | undefined;
    const hosting = fakeProvisioner("hosting", async (input) => {
      hostingSawContext = input.context;
      return { external_ref: { render_service_id: "srv_1" }, vault_keys: {} };
    });
    const map: Record<string, Provisioner> = { repo, hosting };
    const d = deps({ getProvisioner: (k) => map[k] ?? null });

    const r = await resolveResources("t1", "Acme", ["hosting", "repo"], d);
    expect(r.provisioned).toEqual(["repo", "hosting"]);
    expect(hostingSawContext?.repo_url).toBe("https://github.com/praxis-built/acme");
    expect(r.context).toMatchObject({ repo_url: expect.any(String), render_service_id: "srv_1" });
  });

  it("records the first vault key as the row's vault_key", async () => {
    const db = fakeProvisioner("db", async () => ({
      external_ref: { neon_project_id: "np_1" },
      vault_keys: { connection_uri: "db.connection_uri" },
    }));
    const d = deps({ getProvisioner: (k) => (k === "db" ? db : null) });
    await resolveResources("t1", "Acme", ["db"], d);
    expect(d.setTenantResource).toHaveBeenCalledWith(
      "t1", "db", "provisioned", "ready", "db-prov", { neon_project_id: "np_1" }, "db.connection_uri",
    );
  });

  it("PRESERVES the existing vault_key on idempotent re-provision (provisioner returns no new keys)", async () => {
    const db = fakeProvisioner("db", async () => ({
      external_ref: { neon_project_id: "np_existing" },
      vault_keys: {},
    }));
    const d = deps({
      getProvisioner: (k) => (k === "db" ? db : null),
      loadVaultKey: vi.fn().mockResolvedValue("db.connection_uri"),
    });
    await resolveResources("t1", "Acme", ["db"], d);
    expect(d.loadVaultKey).toHaveBeenCalledWith("t1", "db");
    expect(d.setTenantResource).toHaveBeenCalledWith(
      "t1", "db", "provisioned", "ready", "db-prov", { neon_project_id: "np_existing" }, "db.connection_uri",
    );
  });

  it("vault_key stays null when there is neither a new key nor an existing one", async () => {
    const db = fakeProvisioner("db", async () => ({
      external_ref: { neon_project_id: "np_first" },
      vault_keys: {},
    }));
    const d = deps({ getProvisioner: (k) => (k === "db" ? db : null) });
    await resolveResources("t1", "Acme", ["db"], d);
    expect(d.setTenantResource).toHaveBeenCalledWith(
      "t1", "db", "provisioned", "ready", "db-prov", { neon_project_id: "np_first" }, null,
    );
  });

  it("credential missing → row 'pending', collected in pending_creds, build CONTINUES", async () => {
    const repo = fakeProvisioner("repo", async () => {
      throw new CredentialNotConfigured("GITHUB_PROVISION_TOKEN");
    });
    const db = fakeProvisioner("db", async () => ({ external_ref: { neon_project_id: "np" }, vault_keys: {} }));
    const map: Record<string, Provisioner> = { repo, db };
    const d = deps({ getProvisioner: (k) => map[k] ?? null });
    const r = await resolveResources("t1", "Acme", ["repo", "db"], d);
    expect(r.pending_creds).toEqual([{ kind: "repo", missing_key: "GITHUB_PROVISION_TOKEN" }]);
    expect(r.provisioned).toEqual(["db"]);
  });

  it("no provisioner registered → failed, collected, continues", async () => {
    const d = deps({ getProvisioner: () => null });
    const r = await resolveResources("t1", "Acme", ["ads"], d);
    expect(r.failed).toEqual([{ kind: "ads", error: "no provisioner registered" }]);
  });

  it("records the provisioner's initialStatus (A4: async hosting → 'provisioning', not 'ready')", async () => {
    const repo = fakeProvisioner("repo", async () => ({ external_ref: { repo_url: "u" }, vault_keys: {} }));
    const hosting = fakeProvisioner("hosting", async () => ({
      external_ref: { render_service_id: "srv_1", url: null },
      vault_keys: {},
    }));
    hosting.initialStatus = () => "provisioning";
    const map: Record<string, Provisioner> = { repo, hosting };
    const d = deps({ getProvisioner: (k) => map[k] ?? null });

    await resolveResources("t1", "Acme", ["repo", "hosting"], d);
    const calls = d.setTenantResource.mock.calls;
    const repoCall = calls.find((c) => c[1] === "repo");
    const hostingCall = calls.find((c) => c[1] === "hosting");
    expect(repoCall?.[3]).toBe("ready");
    expect(hostingCall?.[3]).toBe("provisioning");
  });

  it("fires the afterProvision hook after a kind provisions, BEFORE the next dependency-ordered kind (A2)", async () => {
    const order: string[] = [];
    const repo = fakeProvisioner("repo", async () => {
      order.push("provision:repo");
      return { external_ref: { github_full_name: "praxis-built/acme-t1" }, vault_keys: {} };
    });
    const hosting = fakeProvisioner("hosting", async () => {
      order.push("provision:hosting");
      return { external_ref: { render_service_id: "srv_1" }, vault_keys: {} };
    });
    const map: Record<string, Provisioner> = { repo, hosting };
    const d = deps({ getProvisioner: (k) => map[k] ?? null });

    const seen: Array<{ kind: string; full?: unknown }> = [];
    await resolveResources("t1", "Acme", ["repo", "hosting"], d, {
      afterProvision: async (kind, ctx) => {
        order.push(`hook:${kind}`);
        seen.push({ kind, full: ctx.github_full_name });
      },
    });

    expect(order).toEqual(["provision:repo", "hook:repo", "provision:hosting", "hook:hosting"]);
    expect(seen[0]).toEqual({ kind: "repo", full: "praxis-built/acme-t1" });
  });

  it("a throwing afterProvision hook does NOT abort the build (A2 best-effort)", async () => {
    const repo = fakeProvisioner("repo", async () => ({
      external_ref: { github_full_name: "praxis-built/acme" },
      vault_keys: {},
    }));
    const d = deps({ getProvisioner: (k) => (k === "repo" ? repo : null) });
    const r = await resolveResources("t1", "Acme", ["repo"], d, {
      afterProvision: async () => {
        throw new Error("seed blew up");
      },
    });
    expect(r.provisioned).toEqual(["repo"]);
    expect(r.failed).toEqual([]);
  });
});
