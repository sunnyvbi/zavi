import { describe, it, expect, vi } from "vitest";
import {
  createGitHubRepoProvisioner,
  CredentialNotConfigured,
  repoSlug,
} from "@/services/provisioning/github-repo";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("repoSlug", () => {
  it("slugifies + trims + lowercases, suffixed with a tenant hash (A1)", () => {
    const s = repoSlug("Acme Waitlist Co.!", "t1");
    expect(s).toMatch(/^acme-waitlist-co-[a-f0-9]{8}$/);
    const blank = repoSlug("   ", "t1");
    expect(blank).toMatch(/^company-[a-f0-9]{8}$/);
  });

  it("is TENANT-SCOPED + collision-free — same name, different tenant → different slug (A1)", () => {
    expect(repoSlug("UpcarAI", "tenant-a")).not.toBe(repoSlug("UpcarAI", "tenant-b"));
    expect(repoSlug("UpcarAI", "tenant-a")).toBe(repoSlug("UpcarAI", "tenant-a"));
  });
});

describe("GitHubRepoProvisioner", () => {
  it("ensure THROWS CredentialNotConfigured when the token is missing (gated)", async () => {
    const p = createGitHubRepoProvisioner({ token: () => null, fetchFn: vi.fn() as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toBeInstanceOf(
      CredentialNotConfigured,
    );
    await expect(p.ensure({ tenant_id: "t1", company_name: "Acme" })).rejects.toMatchObject({
      key: "GITHUB_PROVISION_TOKEN",
    });
  });

  it("idempotent: returns the existing repo when it already exists (no create)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      res(200, { full_name: "praxis-built/acme", html_url: "https://github.com/praxis-built/acme", default_branch: "main" }),
    );
    const p = createGitHubRepoProvisioner({ token: () => "tok", org: () => "praxis-built", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Acme" });
    expect(r.external_ref.github_full_name).toBe("praxis-built/acme");
    expect(r.vault_keys).toEqual({});
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("creates the repo when it does not exist (404 → POST 201 → verify 200)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(404, {}))
      .mockResolvedValueOnce(
        res(201, { full_name: "praxis-built/newco", html_url: "https://github.com/praxis-built/newco", default_branch: "main" }),
      )
      .mockResolvedValueOnce(
        res(200, { full_name: "praxis-built/newco" }),
      );
    const p = createGitHubRepoProvisioner({ token: () => "tok", org: () => "praxis-built", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "NewCo" });
    expect(r.external_ref.github_full_name).toBe("praxis-built/newco");
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[1][1]?.method).toBe("POST");
    expect(fetchFn.mock.calls[1][0]).toContain("/orgs/praxis-built/repos");
    expect(fetchFn.mock.calls[2][0]).toContain("/repos/praxis-built/newco");
    expect(fetchFn.mock.calls[2][1]?.method).toBeUndefined();
  });

  it("GAP-1b: THROWS when post-create verify never finds the repo (201 then 404×3 → not 'ready')", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(404, {}))
      .mockResolvedValueOnce(
        res(201, { full_name: "praxis-built/ghost", html_url: "https://github.com/praxis-built/ghost", default_branch: "main" }),
      )
      .mockResolvedValue(res(404, {}));
    const p = createGitHubRepoProvisioner({ token: () => "tok", org: () => "praxis-built", fetchFn: fetchFn as never });
    await expect(p.ensure({ tenant_id: "t1", company_name: "Ghost" })).rejects.toThrow(
      /repo verify failed/i,
    );
  });

  it("GAP-1b: verify retries absorb a brief post-create read-after-write lag (201, 404, then 200 → ok)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(404, {}))
      .mockResolvedValueOnce(
        res(201, { full_name: "praxis-built/laggy", html_url: "https://github.com/praxis-built/laggy", default_branch: "main" }),
      )
      .mockResolvedValueOnce(res(404, {}))
      .mockResolvedValueOnce(res(200, { full_name: "praxis-built/laggy" }));
    const p = createGitHubRepoProvisioner({ token: () => "tok", org: () => "praxis-built", fetchFn: fetchFn as never });
    const r = await p.ensure({ tenant_id: "t1", company_name: "Laggy" });
    expect(r.external_ref.github_full_name).toBe("praxis-built/laggy");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("teardown deletes the repo (204 ok, 404 ok)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(res(204, {}));
    const p = createGitHubRepoProvisioner({ token: () => "tok", fetchFn: fetchFn as never });
    await expect(p.teardown({ github_full_name: "praxis-built/acme" })).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("kind + provider are repo/github", () => {
    const p = createGitHubRepoProvisioner({ token: () => "tok" });
    expect(p.kind).toBe("repo");
    expect(p.provider).toBe("github");
  });
});
