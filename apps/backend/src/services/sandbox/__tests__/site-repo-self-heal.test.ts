
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeConnectorClient } from "@/services/sites/__tests__/connector-fake";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SITE1 = "Zavi-Latest-Build/austin-dog-grooming-d0ca391e-5e0b8e";
const SITE2 = "Zavi-Latest-Build/rise-shine-bakery-d0ca391e-f275dd";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  rpcErrors: [] as (string | null)[],
  rpcCalls: 0,
  site: null as Record<string, unknown> | null,
  siteLookups: [] as [string, string][],
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    const { client } = fakeConnectorClient(h.rows);
    return {
      from: client.from,
      rpc: async (name: string) => {
        if (name !== "get_or_create_tenant_sandbox") throw new Error(`unexpected rpc ${name}`);
        h.rpcCalls++;
        const msg = h.rpcErrors.shift() ?? "stop here";
        return { data: null, error: { message: msg } };
      },
    };
  },
}));

vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    getByRepo: async (tenant_id: string, repo: string) => {
      h.siteLookups.push([tenant_id, repo]);
      return h.site && h.site.tenant_id === tenant_id ? { ...h.site } : null;
    },
  }),
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { resolveSandboxForRun } from "../lifecycle";

const NOT_IN = `get_or_create_tenant_sandbox: repo ${SITE2} not in tenant connected repos`;

function umbrella(tenant_id: string, repos: string[], login = "Praxis-build") {
  return {
    tenant_id,
    slug: "github",
    account_login: login,
    repo_full_names: [...repos],
    default_repo_full_name: repos[0],
    repo_default_branches: Object.fromEntries(repos.map((r) => [r, "main"])),
  };
}

beforeEach(() => {
  h.rows = [umbrella(T, [SITE1])];
  h.rpcErrors = [NOT_IN];
  h.rpcCalls = 0;
  h.site = { id: "site-2", tenant_id: T, status: "building", github_full_name: SITE2 };
  h.siteLookups = [];
});

describe("resolveSandboxForRun: a site repo missing from the connection self-heals", () => {
  it("adds this tenant's live site repo and asks the RPC once more", async () => {
    await expect(resolveSandboxForRun({ tenant_id: T, repo_full_name: SITE2 })).rejects.toThrow(/rpc failed: stop here/);
    expect(h.rpcCalls).toBe(2);
    expect(h.siteLookups).toEqual([[T, SITE2]]);
    expect(h.rows[0].repo_full_names).toEqual([SITE1, SITE2]);
    expect(h.rows[0].default_repo_full_name).toBe(SITE1);
  });

  it("never heals a repo that is not a site of this tenant", async () => {
    h.site = { id: "site-x", tenant_id: OTHER, status: "building", github_full_name: SITE2 };
    await expect(resolveSandboxForRun({ tenant_id: T, repo_full_name: SITE2 })).rejects.toThrow(/not in tenant connected repos/);
    expect(h.rpcCalls).toBe(1);
    expect(h.rows[0].repo_full_names).toEqual([SITE1]);
  });

  it("never heals a failed or deleted site's repo", async () => {
    for (const status of ["failed", "fell_back_old", "deleting", "deleted"]) {
      h.rpcErrors = [NOT_IN];
      h.rpcCalls = 0;
      h.site = { id: "site-2", tenant_id: T, status, github_full_name: SITE2 };
      await expect(resolveSandboxForRun({ tenant_id: T, repo_full_name: SITE2 }), status).rejects.toThrow(/not in tenant connected repos/);
      expect(h.rpcCalls, status).toBe(1);
    }
    expect(h.rows[0].repo_full_names).toEqual([SITE1]);
  });

  it("never touches a GitHub account the user connected themselves", async () => {
    h.rows = [umbrella(T, ["acme/app"], "acme")];
    await expect(resolveSandboxForRun({ tenant_id: T, repo_full_name: SITE2 })).rejects.toThrow(/not in tenant connected repos/);
    expect(h.rpcCalls).toBe(1);
    expect(h.rows[0].repo_full_names).toEqual(["acme/app"]);
  });

  it("leaves any other RPC error alone", async () => {
    h.rpcErrors = ["connection reset"];
    await expect(resolveSandboxForRun({ tenant_id: T, repo_full_name: SITE2 })).rejects.toThrow(/connection reset/);
    expect(h.rpcCalls).toBe(1);
    expect(h.siteLookups).toEqual([]);
  });
});
