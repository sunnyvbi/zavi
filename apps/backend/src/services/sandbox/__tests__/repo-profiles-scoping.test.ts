import { describe, it, expect, vi, beforeEach } from "vitest";

const connectorByTenant: Record<
  string,
  { installation_id: number | null; repo_full_names: string[] } | null
> = {};

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "connector_metadata") {
        return {
          select: () => ({
            eq: (_c1: string, tenant_id: string) => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: connectorByTenant[tenant_id] ?? null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));

const mintMock = vi.fn(async (_a?: unknown) => "tok-scoped");
const metaMock = vi.fn(async (_a?: unknown) => ({
  description: "An app",
  default_branch: "main",
  topics: [],
}));
const langMock = vi.fn(async (_a?: unknown): Promise<Record<string, number>> => ({
  TypeScript: 1000,
}));
const rootMock = vi.fn(async (_a?: unknown): Promise<string[]> => ["package.json"]);

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: (a: unknown) => mintMock(a),
  getRepoMetadata: (a: unknown) => metaMock(a),
  getRepoLanguages: (a: unknown) => langMock(a),
  listRepoRootEntries: (a: unknown) => rootMock(a),
}));

type ScopedResult = {
  repos: string[];
  scoped: boolean;
  allConnected: string[];
  selectionRequired: boolean;
};
const getScopedRepos = vi.fn(
  async (_tenant_id: string): Promise<ScopedResult> => ({
    repos: [],
    scoped: false,
    allConnected: [],
    selectionRequired: false,
  }),
);
type ResolvedResult = {
  mode: "all" | "scoped" | "deny";
  repos: string[];
  allConnected: string[];
  selectionRequired: boolean;
};
const resolveScopedRepos = vi.fn(
  async (tenant_id: string): Promise<ResolvedResult> => {
    const r = await getScopedRepos(tenant_id);
    return {
      mode: r.scoped ? "scoped" : "all",
      repos: r.repos,
      allConnected: r.allConnected,
      selectionRequired: r.selectionRequired,
    };
  },
);
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepos: (tenant_id: string) => getScopedRepos(tenant_id),
  resolveScopedRepos: (tenant_id: string) => resolveScopedRepos(tenant_id),
  getScopedRepoFullNames: async (tenant_id: string) =>
    (await getScopedRepos(tenant_id)).repos,
}));

import {
  buildTenantRepoProfiles,
  buildRepoProfile,
  seedPendingProfiles,
} from "../repo-profiles";

function scoped(over: Partial<ScopedResult>): ScopedResult {
  return {
    repos: [],
    scoped: false,
    allConnected: [],
    selectionRequired: false,
    ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(connectorByTenant)) delete connectorByTenant[k];
  rpcCalls.length = 0;
  mintMock.mockClear();
  metaMock.mockClear();
  langMock.mockClear();
  rootMock.mockClear();
  getScopedRepos.mockClear();
  resolveScopedRepos.mockClear();
});

describe("buildTenantRepoProfiles — scoped target set (E3 P0-1)", () => {
  it("scoped to a subset → builds ONLY the scoped repo; no token/metadata for scoped-out repos", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    getScopedRepos.mockResolvedValue(
      scoped({ repos: ["o/a"], scoped: true, allConnected: ["o/a", "o/b"] }),
    );

    const out = await buildTenantRepoProfiles({ tenant_id: "tA" });

    expect(Object.keys(out)).toEqual(["o/a"]);
    expect(out["o/a"]).toBe("ready");
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo_full_name: "o/a" }),
    );
    expect(metaMock).toHaveBeenCalledTimes(1);
    const upserts = rpcCalls.filter((c) => c.fn === "upsert_repo_profile");
    expect(upserts.map((u) => u.args.p_repo_full_name)).toEqual(["o/a"]);
  });

  it("selectionRequired (active but empty selection) → builds NOTHING (no token/metadata/listRoot calls)", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    getScopedRepos.mockResolvedValue(
      scoped({
        repos: [],
        scoped: true,
        allConnected: ["o/a", "o/b"],
        selectionRequired: true,
      }),
    );

    const out = await buildTenantRepoProfiles({ tenant_id: "tA" });

    expect(out).toEqual({});
    expect(mintMock).not.toHaveBeenCalled();
    expect(metaMock).not.toHaveBeenCalled();
    expect(langMock).not.toHaveBeenCalled();
    expect(rootMock).not.toHaveBeenCalled();
  });

  it("grandfather (scoped===false, full connected set) → builds ALL connected repos (no regression)", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    getScopedRepos.mockResolvedValue(
      scoped({
        repos: ["o/a", "o/b"],
        scoped: false,
        allConnected: ["o/a", "o/b"],
      }),
    );

    const out = await buildTenantRepoProfiles({ tenant_id: "tA" });

    expect(Object.keys(out).sort()).toEqual(["o/a", "o/b"]);
    expect(mintMock).toHaveBeenCalledTimes(2);
  });

  it("FAILS CLOSED when getScopedRepos THROWS → builds NOTHING (never the connected set)", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    getScopedRepos.mockRejectedValueOnce(new Error("boom"));

    const out = await buildTenantRepoProfiles({ tenant_id: "tA" });

    expect(out).toEqual({});
    expect(mintMock).not.toHaveBeenCalled();
    expect(metaMock).not.toHaveBeenCalled();
  });

  it("only_repos narrows further WITHIN the scoped set", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b", "o/c"],
    };
    getScopedRepos.mockResolvedValue(
      scoped({
        repos: ["o/a", "o/b"],
        scoped: true,
        allConnected: ["o/a", "o/b", "o/c"],
      }),
    );

    const out = await buildTenantRepoProfiles({
      tenant_id: "tA",
      only_repos: ["o/b"],
    });

    expect(Object.keys(out)).toEqual(["o/b"]);
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo_full_name: "o/b" }),
    );
  });
});

describe("seedPendingProfiles — scoped seed (E3 P0-1)", () => {
  it("scoped → seeds only the in-scope repos; never seeds a scoped-out repo", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    getScopedRepos.mockResolvedValue(
      scoped({ repos: ["o/a"], scoped: true, allConnected: ["o/a", "o/b"] }),
    );

    await seedPendingProfiles({ tenant_id: "tA", repos: ["o/a", "o/b"] });

    const seeds = rpcCalls.filter((c) => c.fn === "seed_repo_profile_pending");
    expect(seeds.map((s) => s.args.p_repo_full_name)).toEqual(["o/a"]);
  });

  it("selectionRequired → seeds NOTHING", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    getScopedRepos.mockResolvedValue(
      scoped({
        repos: [],
        scoped: true,
        allConnected: ["o/a", "o/b"],
        selectionRequired: true,
      }),
    );

    await seedPendingProfiles({ tenant_id: "tA", repos: ["o/a", "o/b"] });

    expect(rpcCalls.filter((c) => c.fn === "seed_repo_profile_pending")).toHaveLength(0);
  });

  it("grandfather (scoped===false) → seeds ALL passed repos (no regression)", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    getScopedRepos.mockResolvedValue(
      scoped({ repos: ["o/a", "o/b"], scoped: false, allConnected: ["o/a", "o/b"] }),
    );

    await seedPendingProfiles({ tenant_id: "tA", repos: ["o/a", "o/b"] });

    const seeds = rpcCalls.filter((c) => c.fn === "seed_repo_profile_pending");
    expect(seeds.map((s) => s.args.p_repo_full_name).sort()).toEqual(["o/a", "o/b"]);
  });

  it("FAILS CLOSED on resolver 'deny' (active scoping unresolved) → seeds NOTHING (never the raw passed set)", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    resolveScopedRepos.mockResolvedValueOnce({
      mode: "deny",
      repos: [],
      allConnected: [],
      selectionRequired: false,
    });

    await seedPendingProfiles({ tenant_id: "tA", repos: ["o/a", "o/b"] });

    expect(
      rpcCalls.filter((c) => c.fn === "seed_repo_profile_pending"),
    ).toHaveLength(0);
  });

  it("FAILS CLOSED when the resolver THROWS → seeds NOTHING", async () => {
    connectorByTenant["tA"] = {
      installation_id: 7,
      repo_full_names: ["o/a", "o/b"],
    };
    resolveScopedRepos.mockRejectedValueOnce(new Error("boom"));

    await seedPendingProfiles({ tenant_id: "tA", repos: ["o/a", "o/b"] });

    expect(
      rpcCalls.filter((c) => c.fn === "seed_repo_profile_pending"),
    ).toHaveLength(0);
  });
});

describe("buildRepoProfile — scope guard (round-4 P2-5)", () => {
  it("scoped-OUT (connected but not selected) → 'skipped', NO row, no token mint", async () => {
    connectorByTenant["tA"] = { installation_id: 7, repo_full_names: ["o/a", "o/b"] };
    getScopedRepos.mockResolvedValue(
      scoped({ repos: ["o/a"], scoped: true, allConnected: ["o/a", "o/b"] }),
    );

    const status = await buildRepoProfile({
      tenant_id: "tA",
      installation_id: 7,
      repo_full_name: "o/b",
    });

    expect(status).toBe("skipped");
    expect(mintMock).not.toHaveBeenCalled();
    expect(metaMock).not.toHaveBeenCalled();
    expect(rpcCalls.filter((c) => c.fn === "upsert_repo_profile")).toHaveLength(0);
  });

  it("in-scope repo → builds normally (no regression)", async () => {
    connectorByTenant["tA"] = { installation_id: 7, repo_full_names: ["o/a", "o/b"] };
    getScopedRepos.mockResolvedValue(
      scoped({ repos: ["o/a"], scoped: true, allConnected: ["o/a", "o/b"] }),
    );

    const status = await buildRepoProfile({
      tenant_id: "tA",
      installation_id: 7,
      repo_full_name: "o/a",
    });

    expect(status).toBe("ready");
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({ repo_full_name: "o/a" }),
    );
  });

  it("grandfather (scoped===false) → builds connected repo (ships inert)", async () => {
    connectorByTenant["tA"] = { installation_id: 7, repo_full_names: ["o/a", "o/b"] };
    getScopedRepos.mockResolvedValue(
      scoped({ repos: ["o/a", "o/b"], scoped: false, allConnected: ["o/a", "o/b"] }),
    );

    const status = await buildRepoProfile({
      tenant_id: "tA",
      installation_id: 7,
      repo_full_name: "o/b",
    });

    expect(status).toBe("ready");
  });
});
