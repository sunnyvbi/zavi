import { describe, it, expect, vi } from "vitest";
import { resolveResourceCreds, type ResolveCredsDeps } from "@/services/provisioning/resolve-creds";
import type { TenantResourceRow } from "@/services/provisioning/types";

function deps(row: TenantResourceRow | null): ResolveCredsDeps & {
  getSecret: ReturnType<typeof vi.fn>;
  getConnectorToken: ReturnType<typeof vi.fn>;
} {
  return {
    loadRow: vi.fn().mockResolvedValue(row),
    getSecret: vi.fn().mockResolvedValue("vault-secret"),
    getConnectorToken: vi.fn().mockResolvedValue("connector-token"),
  };
}

const base = {
  tenant_id: "t1",
  status: "ready" as const,
  provider: null,
  last_error: null,
};

describe("resolveResourceCreds", () => {
  it("returns null when the resource has no row", async () => {
    const d = deps(null);
    expect(await resolveResourceCreds("t1", "repo", d)).toBeNull();
    expect(d.getSecret).not.toHaveBeenCalled();
    expect(d.getConnectorToken).not.toHaveBeenCalled();
  });

  it("provisioned → reads Vault via vault_key", async () => {
    const d = deps({
      ...base, resource_kind: "db", mode: "provisioned",
      external_ref: { neon_project_id: "np_1" }, vault_key: "neon.t1.uri",
    });
    const r = await resolveResourceCreds("t1", "db", d);
    expect(r).toEqual({
      mode: "provisioned",
      secret: "vault-secret",
      external_ref: { neon_project_id: "np_1" },
      provider: null,
      status: "ready",
    });
    expect(d.getSecret).toHaveBeenCalledWith("t1", "neon.t1.uri");
    expect(d.getConnectorToken).not.toHaveBeenCalled();
  });

  it("connected → reads the connector token via {connector_slug, token_key}", async () => {
    const d = deps({
      ...base, resource_kind: "repo", mode: "connected",
      external_ref: { connector_slug: "github", token_key: "github.access_token" }, vault_key: null,
    });
    const r = await resolveResourceCreds("t1", "repo", d);
    expect(r?.mode).toBe("connected");
    expect(r?.secret).toBe("connector-token");
    expect(d.getConnectorToken).toHaveBeenCalledWith("t1", "github", "github.access_token");
    expect(d.getSecret).not.toHaveBeenCalled();
  });

  it("provisioned with no vault_key yet → secret null (not provisioned)", async () => {
    const d = deps({ ...base, resource_kind: "hosting", mode: "provisioned", external_ref: {}, vault_key: null });
    const r = await resolveResourceCreds("t1", "hosting", d);
    expect(r).toEqual({
      mode: "provisioned",
      secret: null,
      external_ref: {},
      provider: null,
      status: "ready",
    });
    expect(d.getSecret).not.toHaveBeenCalled();
  });

  it("connected with missing refs → secret null (no token fetch)", async () => {
    const d = deps({ ...base, resource_kind: "stripe", mode: "connected", external_ref: {}, vault_key: null });
    const r = await resolveResourceCreds("t1", "stripe", d);
    expect(r?.secret).toBeNull();
    expect(d.getConnectorToken).not.toHaveBeenCalled();
  });
});
