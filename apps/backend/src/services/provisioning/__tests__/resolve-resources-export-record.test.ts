import { describe, it, expect, vi } from "vitest";
import { resolveResources, type ResolveResourcesDeps } from "@/services/provisioning/resolve-resources";
import type { Provisioner } from "@/services/provisioning/types";

const EXPORT = {
  full_name: "acme-co/acme-app",
  url: "https://github.com/acme-co/acme-app",
  branch: "main",
  commit_sha: "e".repeat(40),
  file_count: 42,
  exported_at: "2026-09-30T08:00:00.000Z",
};

function harness() {
  const rows = new Map<string, Record<string, unknown>>();
  const deps: ResolveResourcesDeps = {
    loadMode: vi.fn().mockResolvedValue(null),
    loadVaultKey: vi.fn().mockResolvedValue(null),
    loadExternalRef: async (tenant_id, kind) => rows.get(`${tenant_id}:${kind}`) ?? null,
    getProvisioner: () => null,
    setTenantResource: async (tenant_id, kind, _mode, _status, _provider, external_ref) => {
      rows.set(`${tenant_id}:${kind}`, (external_ref ?? {}) as Record<string, unknown>);
    },
  };
  return { rows, deps };
}

function repoProvisioner(full_name: string): Provisioner {
  return {
    kind: "repo",
    provider: "github",
    ensure: async () => ({
      external_ref: { github_full_name: full_name, html_url: `https://github.com/${full_name}`, default_branch: "main" },
      vault_keys: {},
    }),
    teardown: vi.fn(),
  };
}

describe("resolveResources keeps the founder's GitHub export record across a rebuild", () => {
  it("a new build that re-finds the same repo keeps the 'Exported to' record", async () => {
    const { rows, deps } = harness();
    rows.set("t1:repo", { github_full_name: "praxis-built/acme-1234", html_url: "https://github.com/praxis-built/acme-1234", export: EXPORT });

    await resolveResources("t1", "Acme", ["repo"], { ...deps, getProvisioner: () => repoProvisioner("praxis-built/acme-1234") });

    expect(rows.get("t1:repo")).toMatchObject({ github_full_name: "praxis-built/acme-1234", export: EXPORT });
  });

  it("a build that lands in a different repo drops the old record, since it describes another app's code", async () => {
    const { rows, deps } = harness();
    rows.set("t1:repo", { github_full_name: "praxis-built/acme-1234", export: EXPORT });

    await resolveResources("t1", "Cakes", ["repo"], { ...deps, getProvisioner: () => repoProvisioner("praxis-built/cakes-1234") });

    expect(rows.get("t1:repo")).toEqual({
      github_full_name: "praxis-built/cakes-1234",
      html_url: "https://github.com/praxis-built/cakes-1234",
      default_branch: "main",
    });
    expect(rows.get("t1:repo")).not.toHaveProperty("exports");
  });

  it("keeps every app's export record across a switch to another app's repo", async () => {
    const { rows, deps } = harness();
    const exports = { "praxis-built/acme-1234": EXPORT };
    rows.set("t1:repo", { github_full_name: "praxis-built/acme-1234", export: EXPORT, exports });

    await resolveResources("t1", "Cakes", ["repo"], { ...deps, getProvisioner: () => repoProvisioner("praxis-built/cakes-1234") });

    expect(rows.get("t1:repo")).toMatchObject({ github_full_name: "praxis-built/cakes-1234", exports });
    expect(rows.get("t1:repo")).not.toHaveProperty("export");
  });
});
