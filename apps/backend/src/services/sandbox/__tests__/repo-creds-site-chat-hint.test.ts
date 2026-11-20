import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteRow } from "@/services/sites/contract";

const mocks = vi.hoisted(() => ({
  connector: null as Record<string, unknown> | null,
  sites: [] as SiteRow[],
  mint: vi.fn(async () => "ghs_minted"),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: table === "connector_metadata" ? mocks.connector : null, error: null });
      return q;
    },
  }),
}));
vi.mock("@/services/connectors/github/oauth", () => ({ mintInstallationToken: mocks.mint }));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  resolveScopedRepos: vi.fn(async () => ({ mode: "all", repos: (mocks.connector?.repo_full_names as string[]) ?? [] })),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    getByRepo: async (tenant_id: string, name: string) =>
      mocks.sites.find((s) => s.tenant_id === tenant_id && s.github_full_name === name) ?? null,
  }),
}));

import { resolveRepoCredsForRun } from "../repo-creds";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OLDER = "Praxis-build/paws-and-suds-1a2b3c4d-aaaaaa";
const NEWER = "Praxis-build/still-water-yoga-1a2b3c4d-bbbbbb";
const FOREIGN = "Praxis-build/other-2b3c4d5e-cccccc";

function site(id: string, tenant_id: string, repo: string): SiteRow {
  return {
    id, tenant_id, root_conductor_run_id: `run-${id}`, started_by_user_id: null, owner_email: null,
    label: repo.split("/")[1], hostname: `${repo.split("/")[1]}.zaviagent.com`, github_full_name: repo,
    supabase_project_ref: null, supabase_url: null, status: "live", live_url: null, desired_sha: null,
    live_sha: null, live_deploy_id: null, last_visit_at: null, last_edit_at: null, paused_at: null,
    last_error: null, created_at: "", updated_at: "",
  };
}

const chatEdit = (repo_hint: string, site_id?: string) => ({
  task_description: "make the header blue",
  source_agent: "manual_chat",
  repo_hint,
  ...(site_id ? { site_id } : {}),
});

beforeEach(() => {
  process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella_test";
  mocks.mint.mockClear();
  mocks.sites = [site("site-old", T1, OLDER), site("site-new", T1, NEWER), site("site-foreign", T2, FOREIGN)];
  mocks.connector = {
    account_login: "Praxis-build",
    installation_id: null,
    repo_full_names: [NEWER],
    default_repo_full_name: NEWER,
  };
});

describe("DEL-1323 B6: an engineer chat about an older site works in that site's repo", () => {
  it("a hint naming the older site with its site_id resolves that repo with the umbrella token", async () => {
    const r = await resolveRepoCredsForRun(T1, chatEdit(OLDER, "site-old"));
    expect(r).toEqual({
      kind: "resolved",
      owner: "Praxis-build",
      repo: "paws-and-suds-1a2b3c4d-aaaaaa",
      repo_full_name: OLDER,
      installation_token: "ghp_umbrella_test",
      provisioned: true,
    });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("the same works when the founder also connected their own GitHub", async () => {
    mocks.connector = { account_login: "acme-dev", installation_id: 42, repo_full_names: ["acme-dev/shop"], default_repo_full_name: "acme-dev/shop" };
    const r = await resolveRepoCredsForRun(T1, chatEdit(OLDER, "site-old"));
    expect(r).toMatchObject({ kind: "resolved", repo_full_name: OLDER, provisioned: true });
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("a site_id that names another site of the tenant is refused", async () => {
    await expect(resolveRepoCredsForRun(T1, chatEdit(OLDER, "site-new"))).rejects.toThrow(/site_id does not match/);
  });

  it("another tenant's site repo is refused even with that site's id", async () => {
    await expect(resolveRepoCredsForRun(T1, chatEdit(FOREIGN, "site-foreign"))).rejects.toThrow(/provisioned-repo gate failed/);
  });

  it("a deleted site is refused", async () => {
    mocks.sites[0] = { ...mocks.sites[0], status: "deleted" };
    await expect(resolveRepoCredsForRun(T1, chatEdit(OLDER, "site-old"))).rejects.toThrow(/provisioned-repo gate failed/);
  });

  it("without a site_id the run takes the old path unchanged", async () => {
    await expect(resolveRepoCredsForRun(T1, chatEdit(OLDER))).rejects.toThrow(/umbrella-provisioned app/);
    mocks.connector = { account_login: "acme-dev", installation_id: 42, repo_full_names: ["acme-dev/shop"], default_repo_full_name: "acme-dev/shop" };
    expect(await resolveRepoCredsForRun(T1, chatEdit("acme-dev/shop"))).toMatchObject({
      kind: "resolved",
      repo_full_name: "acme-dev/shop",
      provisioned: false,
    });
  });
});
