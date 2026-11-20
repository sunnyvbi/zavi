
import { describe, it, expect, vi, beforeEach } from "vitest";

const flag = { on: false };
vi.mock("@/services/connectors/github/repo-scoping-flag", () => ({
  REPO_SCOPING_FLAG_KEY: "repo_scoping_enabled",
  isRepoScopingEnabled: async () => flag.on,
  getRepoScopingFlagState: async () => (flag.on ? "on" : "off"),
}));

const row: { value: Record<string, unknown> | null } = { value: null };
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: row.value, error: null });
      return b;
    },
  }),
}));

vi.mock("@/services/sites/public-resolver", () => ({
  sitePublicResolver: () => ({ byRepo: async () => null }),
}));

import { resolveRepoFullName, RepoResolutionError } from "../repo-resolver";

beforeEach(() => {
  flag.on = false;
  row.value = {
    repo_ids: [1, 2, 3],
    repo_full_names: ["o/a", "o/b", "o/c"],
    selected_repo_ids: null,
    default_repo_full_name: "o/b",
  };
});

describe("resolveRepoFullName — scoping enforcement", () => {
  it("flag OFF → hint to any connected repo resolves (unchanged)", async () => {
    flag.on = false;
    row.value = {
      repo_ids: [1, 2, 3],
      repo_full_names: ["o/a", "o/b", "o/c"],
      selected_repo_ids: [1],
      default_repo_full_name: "o/b",
    };
    expect(await resolveRepoFullName({ tenant_id: "t1", repo_hint: "o/c" })).toBe("o/c");
  });

  it("flag ON + scoped-IN hint → resolves", async () => {
    flag.on = true;
    row.value = {
      repo_ids: [1, 2, 3],
      repo_full_names: ["o/a", "o/b", "o/c"],
      selected_repo_ids: [1, 3],
      default_repo_full_name: "o/b",
    };
    expect(await resolveRepoFullName({ tenant_id: "t1", repo_hint: "o/a" })).toBe("o/a");
  });

  it("TRUST BOUNDARY: flag ON + hint to a SCOPED-OUT (but installation-connected) repo → throws", async () => {
    flag.on = true;
    row.value = {
      repo_ids: [1, 2, 3],
      repo_full_names: ["o/a", "o/b", "o/c"],
      selected_repo_ids: [1],
      default_repo_full_name: "o/b",
    };
    await expect(
      resolveRepoFullName({ tenant_id: "t1", repo_hint: "o/c" }),
    ).rejects.toMatchObject({ name: "RepoResolutionError", code: "repo_hint_not_connected" });
  });

  it("flag ON + no hint + default that got SCOPED OUT → no_default_set (default not usable)", async () => {
    flag.on = true;
    row.value = {
      repo_ids: [1, 2, 3],
      repo_full_names: ["o/a", "o/b", "o/c"],
      selected_repo_ids: [1, 3],
      default_repo_full_name: "o/b",
    };
    await expect(resolveRepoFullName({ tenant_id: "t1" })).rejects.toMatchObject({
      code: "no_default_set",
    });
  });

  it("flag ON + scoped to a SINGLE repo + no hint/default → uses that single scoped repo", async () => {
    flag.on = true;
    row.value = {
      repo_ids: [1, 2, 3],
      repo_full_names: ["o/a", "o/b", "o/c"],
      selected_repo_ids: [2],
      default_repo_full_name: null,
    };
    expect(await resolveRepoFullName({ tenant_id: "t1" })).toBe("o/b");
  });

  it("flag ON + selection NULL (grandfathered) → behaves unscoped", async () => {
    flag.on = true;
    row.value = {
      repo_ids: [1, 2, 3],
      repo_full_names: ["o/a", "o/b", "o/c"],
      selected_repo_ids: null,
      default_repo_full_name: "o/b",
    };
    expect(await resolveRepoFullName({ tenant_id: "t1", repo_hint: "o/c" })).toBe("o/c");
    expect(await resolveRepoFullName({ tenant_id: "t1" })).toBe("o/b");
  });
});
