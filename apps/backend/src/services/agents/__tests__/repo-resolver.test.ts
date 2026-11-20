import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMaybeSingle = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: mockMaybeSingle,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/services/sites/public-resolver", () => ({
  sitePublicResolver: () => ({ byRepo: async () => null }),
}));

import { resolveRepoFullName, RepoResolutionError } from "../repo-resolver";

describe("resolveRepoFullName", () => {
  beforeEach(() => {
    mockMaybeSingle.mockReset();
  });

  it("returns repo_hint when present and in connected list", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        repo_full_names: ["acme/web", "acme/api"],
        default_repo_full_name: "acme/api",
      },
      error: null,
    });
    const out = await resolveRepoFullName({
      tenant_id: "t1",
      repo_hint: "acme/web",
    });
    expect(out).toBe("acme/web");
  });

  it("rejects repo_hint that is not in connected list", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["acme/web"], default_repo_full_name: null },
      error: null,
    });
    await expect(
      resolveRepoFullName({ tenant_id: "t1", repo_hint: "evil/exfil" }),
    ).rejects.toBeInstanceOf(RepoResolutionError);
  });

  it("falls back to default_repo_full_name when repo_hint is empty", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        repo_full_names: ["acme/web", "acme/api"],
        default_repo_full_name: "acme/api",
      },
      error: null,
    });
    const out = await resolveRepoFullName({ tenant_id: "t1", repo_hint: "" });
    expect(out).toBe("acme/api");
  });

  it("falls back to default when repo_hint is undefined", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        repo_full_names: ["acme/api"],
        default_repo_full_name: "acme/api",
      },
      error: null,
    });
    const out = await resolveRepoFullName({ tenant_id: "t1" });
    expect(out).toBe("acme/api");
  });

  it("throws when no repo_hint and no default", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        repo_full_names: ["acme/web", "acme/api"],
        default_repo_full_name: null,
      },
      error: null,
    });
    await expect(resolveRepoFullName({ tenant_id: "t1" })).rejects.toBeInstanceOf(
      RepoResolutionError,
    );
  });

  it("throws when github not connected at all", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      resolveRepoFullName({ tenant_id: "t1", repo_hint: "acme/web" }),
    ).rejects.toBeInstanceOf(RepoResolutionError);
  });

  it("throws on supabase error (defensive — do not silently fall back)", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: "db blew up" },
    });
    await expect(
      resolveRepoFullName({ tenant_id: "t1", repo_hint: "acme/web" }),
    ).rejects.toBeInstanceOf(RepoResolutionError);
  });

  it("trims whitespace before evaluating repo_hint", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["acme/web"], default_repo_full_name: "acme/web" },
      error: null,
    });
    const out = await resolveRepoFullName({
      tenant_id: "t1",
      repo_hint: "   ",
    });
    expect(out).toBe("acme/web");
  });

  it("uses the single connected repo when no hint and no default is set", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["acme/only"], default_repo_full_name: null },
      error: null,
    });
    const out = await resolveRepoFullName({ tenant_id: "t1" });
    expect(out).toBe("acme/only");
  });

  it("still throws with 2+ connected repos and no default (no false auto-pick)", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        repo_full_names: ["acme/web", "acme/api"],
        default_repo_full_name: null,
      },
      error: null,
    });
    await expect(resolveRepoFullName({ tenant_id: "t1" })).rejects.toBeInstanceOf(
      RepoResolutionError,
    );
  });

  it("THE FIX: repo_hint not connected but provisioned-gate ok → returns the hint", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        repo_full_names: ["acme/web", "acme/api"],
        default_repo_full_name: "acme/api",
      },
      error: null,
    });
    const gate = vi
      .fn()
      .mockResolvedValue({ ok: true, github_full_name: "Praxis-build/qa-gate-check-6ec4d609" });
    const out = await resolveRepoFullName(
      { tenant_id: "t1", repo_hint: "Praxis-build/qa-gate-check-6ec4d609" },
      { assertProvisionedRepoTarget: gate },
    );
    expect(out).toBe("Praxis-build/qa-gate-check-6ec4d609");
    expect(gate).toHaveBeenCalledWith("t1", "Praxis-build/qa-gate-check-6ec4d609");
  });

  it("THE FIX: no connector_metadata row at all + provisioned-repo hint (gate ok) → returns hint (does NOT throw no_github_connection)", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const gate = vi
      .fn()
      .mockResolvedValue({ ok: true, github_full_name: "Praxis-build/idea-build-abc" });
    const out = await resolveRepoFullName(
      { tenant_id: "t1", repo_hint: "Praxis-build/idea-build-abc" },
      { assertProvisionedRepoTarget: gate },
    );
    expect(out).toBe("Praxis-build/idea-build-abc");
    expect(gate).toHaveBeenCalledWith("t1", "Praxis-build/idea-build-abc");
  });

  it("TRUST BOUNDARY: repo_hint not connected AND gate ok:false → throws repo_hint_not_connected (does NOT resolve)", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["acme/web"], default_repo_full_name: null },
      error: null,
    });
    const gate = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "no tenant_resources(repo) row" });
    await expect(
      resolveRepoFullName(
        { tenant_id: "t1", repo_hint: "evil/exfil" },
        { assertProvisionedRepoTarget: gate },
      ),
    ).rejects.toMatchObject({
      name: "RepoResolutionError",
      code: "repo_hint_not_connected",
    });
    expect(gate).toHaveBeenCalledWith("t1", "evil/exfil");
  });

  it("FAIL-CLOSED: gate ok:false with reason query_error → throws (hint not accepted)", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["acme/web"], default_repo_full_name: null },
      error: null,
    });
    const gate = vi.fn().mockResolvedValue({ ok: false, reason: "query_error" });
    await expect(
      resolveRepoFullName(
        { tenant_id: "t1", repo_hint: "Praxis-build/whatever" },
        { assertProvisionedRepoTarget: gate },
      ),
    ).rejects.toMatchObject({ code: "repo_hint_not_connected" });
  });

  it("connected hint short-circuits — provisioned gate is NOT consulted", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { repo_full_names: ["acme/web"], default_repo_full_name: null },
      error: null,
    });
    const gate = vi.fn();
    const out = await resolveRepoFullName(
      { tenant_id: "t1", repo_hint: "acme/web" },
      { assertProvisionedRepoTarget: gate },
    );
    expect(out).toBe("acme/web");
    expect(gate).not.toHaveBeenCalled();
  });
});
