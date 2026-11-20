import { describe, it, expect, vi, beforeEach } from "vitest";

const connectorByTenant: Record<
  string,
  { installation_id: number | null; repo_full_names: string[] } | null
> = {};

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let readyProfilesFixture: Array<Record<string, unknown>> = [];

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "connector_metadata") {
        return {
          select: () => ({
            eq: (_c1: string, tenant_id: string) => ({
              eq: () => ({
                maybeSingle: async () => {
                  const row = connectorByTenant[tenant_id] ?? null;
                  return { data: row, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "repo_profiles") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                eq: async () => ({ data: readyProfilesFixture, error: null }),
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
  topics: ["mobile"],
}));
const langMock = vi.fn(async (_a?: unknown): Promise<Record<string, number>> => ({
  Swift: 10000,
  Ruby: 100,
}));
const rootMock = vi.fn(async (_a?: unknown): Promise<string[]> => [
  "Podfile",
  "README.md",
  "App.xcodeproj",
]);

vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: (a: unknown) => mintMock(a),
  getRepoMetadata: (a: unknown) => metaMock(a),
  getRepoLanguages: (a: unknown) => langMock(a),
  listRepoRootEntries: (a: unknown) => rootMock(a),
}));

import {
  deriveSubKinds,
  assertTenantConnectedRepo,
  CrossTenantRepoError,
  deriveKind,
  buildRepoProfile,
  readReadyProfiles,
} from "../repo-profiles";

beforeEach(() => {
  for (const k of Object.keys(connectorByTenant)) delete connectorByTenant[k];
  rpcCalls.length = 0;
  readyProfilesFixture = [];
  mintMock.mockClear();
  metaMock.mockClear();
  langMock.mockClear();
  rootMock.mockClear();
  metaMock.mockResolvedValue({ description: "An app", default_branch: "main", topics: ["mobile"] });
  langMock.mockResolvedValue({ Swift: 10000, Ruby: 100 });
  rootMock.mockResolvedValue(["Podfile", "README.md", "App.xcodeproj"]);
});

describe("assertTenantConnectedRepo — cross-tenant guard (NEGATIVE tests)", () => {
  it("ACCEPTS a repo in the tenant's connected set", async () => {
    connectorByTenant["tA"] = { installation_id: 1, repo_full_names: ["acme/web", "acme/ios"] };
    await expect(
      assertTenantConnectedRepo("tA", "acme/web"),
    ).resolves.toBeUndefined();
  });

  it("REJECTS a repo NOT in the tenant's connected set", async () => {
    connectorByTenant["tA"] = { installation_id: 1, repo_full_names: ["acme/web"] };
    await expect(
      assertTenantConnectedRepo("tA", "acme/secret-other"),
    ).rejects.toBeInstanceOf(CrossTenantRepoError);
  });

  it("REJECTS another tenant's repo (cross-tenant) — the core isolation invariant", async () => {
    connectorByTenant["tA"] = { installation_id: 1, repo_full_names: ["acme/web"] };
    connectorByTenant["tB"] = { installation_id: 2, repo_full_names: ["globex/api"] };
    await expect(
      assertTenantConnectedRepo("tA", "globex/api"),
    ).rejects.toBeInstanceOf(CrossTenantRepoError);
  });

  it("FAILS CLOSED when GitHub is not connected (no installation)", async () => {
    connectorByTenant["tA"] = { installation_id: null, repo_full_names: [] };
    await expect(
      assertTenantConnectedRepo("tA", "acme/web"),
    ).rejects.toBeInstanceOf(CrossTenantRepoError);
  });

  it("FAILS CLOSED on missing connector row", async () => {
    await expect(
      assertTenantConnectedRepo("tZ", "acme/web"),
    ).rejects.toBeInstanceOf(CrossTenantRepoError);
  });
});

describe("deriveKind — signal-driven classification (no hardcoded names)", () => {
  it("Podfile / .xcodeproj + Swift-dominant → ios", () => {
    const r = deriveKind({
      rootEntries: ["Podfile", "App.xcodeproj", "README.md"],
      languages: { Swift: 9000, JavaScript: 100 },
    });
    expect(r.kind).toBe("ios");
    expect(r.manifest_paths).toContain("Podfile");
    expect(r.manifest_paths).toContain(".xcodeproj");
  });

  it("build.gradle + Kotlin → android", () => {
    const r = deriveKind({
      rootEntries: ["build.gradle", "AndroidManifest.xml"],
      languages: { Kotlin: 8000 },
    });
    expect(r.kind).toBe("android");
  });

  it("package.json + TS-dominant → web", () => {
    const r = deriveKind({
      rootEntries: ["package.json", "next.config.js"],
      languages: { TypeScript: 50000 },
    });
    expect(r.kind).toBe("web");
  });

  it("go.mod → backend", () => {
    const r = deriveKind({
      rootEntries: ["go.mod", "main.go"],
      languages: { Go: 40000 },
    });
    expect(r.kind).toBe("backend");
  });

  it("mixed iOS + package.json (mobile repo with JS tooling) resolves to ios, not web (no crash, no XOR)", () => {
    const r = deriveKind({
      rootEntries: ["Podfile", "App.xcodeproj", "package.json"],
      languages: { Swift: 30000, TypeScript: 2000 },
    });
    expect(r.kind).toBe("ios");
  });

  it("no manifest, no dominant language → unknown (routes to ASK, never a wrong default)", () => {
    const r = deriveKind({ rootEntries: ["LICENSE"], languages: {} });
    expect(r.kind).toBe("unknown");
  });
});

describe("buildRepoProfile — per-repo-scoped token + cross-tenant guard + structured upsert", () => {
  it("asserts the connected guard, mints a PER-REPO token, upserts a 'ready' profile", async () => {
    connectorByTenant["tA"] = { installation_id: 7, repo_full_names: ["acme/ios"] };
    const status = await buildRepoProfile({
      tenant_id: "tA",
      installation_id: 7,
      repo_full_name: "acme/ios",
    });
    expect(status).toBe("ready");
    expect(mintMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: "tA", installation_id: 7, repo_full_name: "acme/ios" }),
    );
    const upsert = rpcCalls.find((c) => c.fn === "upsert_repo_profile");
    expect(upsert).toBeTruthy();
    expect(upsert!.args.p_tenant_id).toBe("tA");
    expect(upsert!.args.p_repo_full_name).toBe("acme/ios");
    expect(upsert!.args.p_profile_status).toBe("ready");
    expect(upsert!.args.p_kind).toBe("ios");
  });

  it("REFUSES to build a repo not in the tenant's connected set (no token mint)", async () => {
    connectorByTenant["tA"] = { installation_id: 7, repo_full_names: ["acme/ios"] };
    const status = await buildRepoProfile({
      tenant_id: "tA",
      installation_id: 7,
      repo_full_name: "globex/api",
    });
    expect(status).toBe("skipped");
    expect(mintMock).not.toHaveBeenCalled();
    expect(metaMock).not.toHaveBeenCalled();
    expect(rpcCalls.filter((c) => c.fn === "upsert_repo_profile")).toHaveLength(0);
  });

  it("GitHub failure → 'error' status with retry_after, never throws", async () => {
    connectorByTenant["tA"] = { installation_id: 7, repo_full_names: ["acme/ios"] };
    metaMock.mockRejectedValueOnce(new Error("github 503"));
    const status = await buildRepoProfile({
      tenant_id: "tA",
      installation_id: 7,
      repo_full_name: "acme/ios",
    });
    expect(status).toBe("error");
    const errUpsert = rpcCalls.find(
      (c) => c.fn === "upsert_repo_profile" && c.args.p_profile_status === "error",
    );
    expect(errUpsert).toBeTruthy();
    expect(errUpsert!.args.p_retry_after).toBeTruthy();
  });
});

describe("readReadyProfiles — guards every repo before reading", () => {
  it("drops repos not in the connected set, returns ready profiles for the rest", async () => {
    connectorByTenant["tA"] = { installation_id: 1, repo_full_names: ["acme/web", "acme/ios"] };
    readyProfilesFixture = [
      {
        repo_full_name: "acme/web",
        kind: "web",
        language_stats: { TypeScript: 1 },
        frameworks: ["node"],
        topics: [],
        description: null,
        default_branch: "main",
        manifest_paths: ["package.json"],
        profile_status: "ready",
      },
    ];
    const out = await readReadyProfiles({
      tenant_id: "tA",
      repos: ["acme/web", "globex/evil"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].repo_full_name).toBe("acme/web");
    expect(out[0].kind).toBe("web");
  });
});

describe("deriveKind — monorepo sub-kinds (2026-09-10)", () => {
  it("a TS monorepo with apps/backend is BOTH web and backend", () => {
    const r = deriveKind({
      rootEntries: ["package.json", "apps", "README.md"],
      languages: { TypeScript: 900000 },
      subEntries: ["web", "admin", "backend", "mobile"],
    });
    expect(r.kind).toBe("web");
    expect([...r.kinds].sort()).toEqual(["backend", "web"]);
  });

  it("a single-surface repo keeps exactly its one kind", () => {
    const r = deriveKind({
      rootEntries: ["package.json"],
      languages: { TypeScript: 100 },
      subEntries: [],
    });
    expect(r.kinds).toEqual(["web"]);
  });

  it("kinds is never empty, even for an unclassifiable repo", () => {
    const r = deriveKind({ rootEntries: ["LICENSE"], languages: {} });
    expect(r.kind).toBe("unknown");
    expect(r.kinds).toEqual(["unknown"]);
  });

  it("native repo with a JS tooling sub-dir does not become web", () => {
    const r = deriveKind({
      rootEntries: ["Podfile", "package.json"],
      languages: { Swift: 500000, JavaScript: 1000 },
      subEntries: [],
    });
    expect(r.kind).toBe("ios");
    expect(r.kinds).toEqual(["ios"]);
  });
});

describe("deriveSubKinds", () => {
  it("maps recognised surface directories", () => {
    expect([...deriveSubKinds(["backend", "web"])].sort()).toEqual([
      "backend",
      "web",
    ]);
    expect(deriveSubKinds(["api"])).toEqual(["backend"]);
    expect(deriveSubKinds(["dashboard"])).toEqual(["web"]);
  });

  it("contributes NOTHING for ambiguous or unknown names", () => {
    expect(deriveSubKinds(["mobile", "shared", "utils", "config"])).toEqual([]);
  });

  it("dedupes repeated surfaces", () => {
    expect(deriveSubKinds(["api", "server", "workers"])).toEqual(["backend"]);
  });
});

describe("monorepo sub-listing asks GitHub for DIRECTORIES only", () => {
  it("passes onlyType:'dir' for the apps/ listing but NOT for the root listing", async () => {
    connectorByTenant["tA"] = { installation_id: 7, repo_full_names: ["o/mono"] };
    rootMock.mockImplementation(async (a?: unknown) => {
      const args = (a ?? {}) as { path?: string };
      return args.path === "apps"
        ? ["web", "backend"]
        : ["package.json", "apps"];
    });

    await buildRepoProfile({
      tenant_id: "tA",
      installation_id: 7,
      repo_full_name: "o/mono",
    });

    const calls = rootMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const rootCall = calls.find((c) => !c.path);
    const appsCall = calls.find((c) => c.path === "apps");

    expect(rootCall).toBeDefined();
    expect(rootCall?.onlyType).toBeUndefined();

    expect(appsCall).toBeDefined();
    expect(appsCall?.onlyType).toBe("dir");
  });
});
