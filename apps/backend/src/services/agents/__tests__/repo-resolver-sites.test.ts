
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMaybeSingle = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = mockMaybeSingle;
      return b;
    },
  }),
}));
vi.mock("@/services/sites/public-resolver", () => ({
  sitePublicResolver: () => ({ byRepo: async () => null }),
}));

import { resolveRepoFullName } from "../repo-resolver";

const T = "t1";
const site = (over: Record<string, unknown> = {}) =>
  ({ id: "s1", tenant_id: T, github_full_name: "Zavi-Sites/Lucky-Paws", status: "live", ...over }) as never;

beforeEach(() => {
  mockMaybeSingle.mockReset();
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("resolveRepoFullName — new-flow site repos", () => {
  it("this tenant's live site repo resolves to the site's canonical name, legacy gate not consulted", async () => {
    const gate = vi.fn();
    const out = await resolveRepoFullName(
      { tenant_id: T, repo_hint: "zavi-sites/lucky-paws" },
      {
        assertProvisionedRepoTarget: gate,
        siteOwnerOfRepo: async () => ({ tenant_id: T, site_id: "s1", status: "live" }),
        siteForRepo: async () => site(),
      },
    );
    expect(out).toBe("Zavi-Sites/Lucky-Paws");
    expect(gate).not.toHaveBeenCalled();
  });

  it("CROSS-TENANT: another workspace's site repo is refused EVEN when it is in the connected list", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["Zavi-Sites/Lucky-Paws"], default_repo_full_name: null },
      error: null,
    });
    const siteForRepo = vi.fn();
    await expect(
      resolveRepoFullName(
        { tenant_id: T, repo_hint: "Zavi-Sites/Lucky-Paws" },
        { siteOwnerOfRepo: async () => ({ tenant_id: "other", site_id: "s9", status: "live" }), siteForRepo },
      ),
    ).rejects.toMatchObject({ code: "repo_hint_not_connected" });
    expect(siteForRepo).not.toHaveBeenCalled();
  });

  it("CROSS-TENANT: a connected default / single repo that is another workspace's site is refused", async () => {
    const foreign = async () => ({ tenant_id: "other", site_id: "s9", status: "live" as const });
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["Zavi-Sites/Theirs", "acme/web"], default_repo_full_name: "Zavi-Sites/Theirs" },
      error: null,
    });
    await expect(resolveRepoFullName({ tenant_id: T }, { siteOwnerOfRepo: foreign })).rejects.toMatchObject({
      code: "repo_hint_not_connected",
    });
    mockMaybeSingle.mockResolvedValue({ data: { repo_full_names: ["Zavi-Sites/Theirs"], default_repo_full_name: null }, error: null });
    await expect(resolveRepoFullName({ tenant_id: T }, { siteOwnerOfRepo: foreign })).rejects.toMatchObject({
      code: "repo_hint_not_connected",
    });
  });

  it("a plain connected repo (not a site) still resolves unchanged", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { repo_full_names: ["acme/web"], default_repo_full_name: "acme/web" }, error: null });
    expect(await resolveRepoFullName({ tenant_id: T, repo_hint: "acme/web" }, { siteOwnerOfRepo: async () => null })).toBe("acme/web");
    expect(await resolveRepoFullName({ tenant_id: T }, { siteOwnerOfRepo: async () => null })).toBe("acme/web");
  });

  it("a deleted site's repo is refused, never handed to the legacy gate", async () => {
    const gate = vi.fn().mockResolvedValue({ ok: true, github_full_name: "Zavi-Sites/Lucky-Paws" });
    await expect(
      resolveRepoFullName(
        { tenant_id: T, repo_hint: "Zavi-Sites/Lucky-Paws" },
        { assertProvisionedRepoTarget: gate, siteOwnerOfRepo: async () => ({ tenant_id: T, site_id: "s1", status: "deleted" }) },
      ),
    ).rejects.toMatchObject({ code: "repo_hint_not_connected" });
    expect(gate).not.toHaveBeenCalled();
  });

  it("two sites in one workspace: each hint resolves to ITS site only", async () => {
    const sites: Record<string, { id: string; name: string }> = {
      "zavi-sites/a": { id: "sa", name: "Zavi-Sites/A" },
      "zavi-sites/b": { id: "sb", name: "Zavi-Sites/B" },
    };
    const deps = {
      siteOwnerOfRepo: async (n: string) => ({ tenant_id: T, site_id: sites[n.toLowerCase()].id, status: "live" as const }),
      siteForRepo: async (_t: string, n: string) =>
        site({ id: sites[n.toLowerCase()].id, github_full_name: sites[n.toLowerCase()].name }),
    };
    expect(await resolveRepoFullName({ tenant_id: T, repo_hint: "zavi-sites/a" }, deps)).toBe("Zavi-Sites/A");
    expect(await resolveRepoFullName({ tenant_id: T, repo_hint: "zavi-sites/b" }, deps)).toBe("Zavi-Sites/B");
  });

  it("FAIL-CLOSED: the owner lookup failing refuses the hint (no connected-list fall-through)", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { repo_full_names: ["acme/web"], default_repo_full_name: null }, error: null });
    await expect(
      resolveRepoFullName(
        { tenant_id: T, repo_hint: "acme/web" },
        {
          siteOwnerOfRepo: async () => {
            throw new Error("rpc down");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "supabase_read_failed" });
  });

  it("a delete that began between the owner read and the scoped read is refused (re-checked on the row)", async () => {
    await expect(
      resolveRepoFullName(
        { tenant_id: T, repo_hint: "Zavi-Sites/Lucky-Paws" },
        {
          siteOwnerOfRepo: async () => ({ tenant_id: T, site_id: "s1", status: "live" }),
          siteForRepo: async () => site({ status: "deleting" }),
        },
      ),
    ).rejects.toMatchObject({ code: "repo_hint_not_connected" });
  });

  it("an owner/site row mismatch (site id differs) is refused", async () => {
    await expect(
      resolveRepoFullName(
        { tenant_id: T, repo_hint: "Zavi-Sites/Lucky-Paws" },
        {
          siteOwnerOfRepo: async () => ({ tenant_id: T, site_id: "s1", status: "live" }),
          siteForRepo: async () => site({ id: "s2" }),
        },
      ),
    ).rejects.toMatchObject({ code: "repo_hint_not_connected" });
  });
});
