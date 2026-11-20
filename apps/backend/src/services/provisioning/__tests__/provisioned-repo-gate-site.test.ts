
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  assertProvisionedRepoTarget,
  type ProvisionedRepoGateDeps,
} from "../provisioned-repo-gate";
import type { SiteRow, SiteStatus } from "@/services/sites/contract";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SITE_REPO = "Praxis-build/acme-1a2b3c4d-abcdef";

function site(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: "site-a", tenant_id: T1, root_conductor_run_id: "run-a", started_by_user_id: null,
    owner_email: null, label: "acme-1a2b3c4d-abcdef", hostname: "acme-1a2b3c4d-abcdef.zaviagent.com",
    github_full_name: SITE_REPO, supabase_project_ref: null, supabase_url: null, status: "building",
    live_url: null, desired_sha: null, live_sha: null, live_deploy_id: null, last_visit_at: null,
    last_edit_at: null, paused_at: null, last_error: null, created_at: "", updated_at: "",
    ...over,
  };
}

function deps(
  sites: SiteRow[],
  opts: { repoRow?: { mode: string; external_ref: Record<string, unknown> } | null; siteThrows?: boolean } = {},
): ProvisionedRepoGateDeps & { loadSiteByRepo: Mock<[string, string], Promise<SiteRow | null>> } {
  const loadSiteByRepo = vi.fn(async (tenant_id: string, name: string) => {
    if (opts.siteThrows) throw new Error("sites read failed");
    return sites.find((s) => s.tenant_id === tenant_id && s.github_full_name?.toLowerCase() === name.toLowerCase()) ?? null;
  });
  return { loadRepoResource: async () => opts.repoRow ?? null, loadSiteByRepo };
}

describe("assertProvisionedRepoTarget — site-row fallback", () => {
  it("a same-tenant site repo passes and names the site", async () => {
    const r = await assertProvisionedRepoTarget(T1, SITE_REPO, deps([site()]));
    expect(r).toEqual({ ok: true, github_full_name: SITE_REPO, site_id: "site-a" });
  });

  it("two sites in one tenant: each repo resolves to its own site", async () => {
    const d = deps([site(), site({ id: "site-b", github_full_name: "Praxis-build/beta-1a2b3c4d-123456" })]);
    expect(await assertProvisionedRepoTarget(T1, SITE_REPO, d)).toMatchObject({ ok: true, site_id: "site-a" });
    expect(await assertProvisionedRepoTarget(T1, "Praxis-build/beta-1a2b3c4d-123456", d)).toMatchObject({ ok: true, site_id: "site-b" });
  });

  it("the same repo name under another tenant fails", async () => {
    const r = await assertProvisionedRepoTarget(T2, SITE_REPO, deps([site()]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no tenant_resources/);
  });

  it("a site in a dead status fails", async () => {
    for (const status of ["failed", "fell_back_old", "deleting", "deleted"] as SiteStatus[]) {
      const r = await assertProvisionedRepoTarget(T1, SITE_REPO, deps([site({ status })]));
      expect(r.ok, status).toBe(false);
    }
    for (const status of ["provisioning", "building", "publishing", "live", "paused", "waking"] as SiteStatus[]) {
      expect((await assertProvisionedRepoTarget(T1, SITE_REPO, deps([site({ status })]))).ok, status).toBe(true);
    }
  });

  it("the site's repo name must match exactly (same rule as tenant_resources)", async () => {
    const r = await assertProvisionedRepoTarget(T1, SITE_REPO.toLowerCase(), deps([site()]));
    expect(r.ok).toBe(false);
  });

  it("a row for another tenant handed back by the lookup is refused", async () => {
    const d: ProvisionedRepoGateDeps = {
      loadRepoResource: async () => null,
      loadSiteByRepo: async () => site({ tenant_id: T2 }),
    };
    expect((await assertProvisionedRepoTarget(T1, SITE_REPO, d)).ok).toBe(false);
  });

  it("a store error fails closed with the original failure", async () => {
    const r = await assertProvisionedRepoTarget(T1, SITE_REPO, deps([site()], { siteThrows: true }));
    expect(r).toEqual({ ok: false, reason: "no tenant_resources(repo) row" });
  });

  it("a passing tenant_resources path never consults sites and is unchanged", async () => {
    const d = deps([site()], { repoRow: { mode: "provisioned", external_ref: { github_full_name: "praxis-built/old" } } });
    expect(await assertProvisionedRepoTarget(T1, "praxis-built/old", d)).toEqual({ ok: true, github_full_name: "praxis-built/old" });
    expect(d.loadSiteByRepo).not.toHaveBeenCalled();
  });

  it("without a site lookup dep there is no fallback (injected legacy deps)", async () => {
    const r = await assertProvisionedRepoTarget(T1, SITE_REPO, { loadRepoResource: async () => null });
    expect(r.ok).toBe(false);
  });
});
