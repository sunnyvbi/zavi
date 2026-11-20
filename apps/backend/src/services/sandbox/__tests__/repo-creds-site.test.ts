
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteRow } from "@/services/sites/contract";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  getByRepo: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/connectors/github/oauth", () => ({ mintInstallationToken: vi.fn(async () => "ghs_minted") }));
vi.mock("@/services/connectors/github/scoped-repos", () => ({
  resolveScopedRepos: vi.fn(async () => ({ mode: "all", repos: [] })),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({ getByRepo: mocks.getByRepo }),
}));

import { resolveRepoCredsForRun } from "../repo-creds";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SITE_REPO = "Praxis-build/acme-1a2b3c4d-abcdef";

const SITE: SiteRow = {
  id: "site-a", tenant_id: T1, root_conductor_run_id: "run-a", started_by_user_id: null, owner_email: null,
  label: "l", hostname: "l.zaviagent.com", github_full_name: SITE_REPO, supabase_project_ref: null,
  supabase_url: null, status: "building", live_url: null, desired_sha: null, live_sha: null,
  live_deploy_id: null, last_visit_at: null, last_edit_at: null, paused_at: null, last_error: null,
  created_at: "", updated_at: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_PROVISION_TOKEN = "ghp_umbrella_test";
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
  });
  mocks.getByRepo.mockImplementation(async (tenant_id: string, name: string) =>
    tenant_id === SITE.tenant_id && name === SITE_REPO ? SITE : null,
  );
});

const payload = (over: Record<string, unknown> = {}) => ({
  stage: "build",
  site_id: "site-a",
  target: { github_full_name: SITE_REPO, github_target_mode: "umbrella" },
  ...over,
});

describe("resolveRepoCredsForRun — new-flow site repo", () => {
  it("a same-tenant site repo with the matching site_id resolves with the umbrella token", async () => {
    const r = await resolveRepoCredsForRun(T1, payload());
    expect(r).toMatchObject({ kind: "resolved", repo_full_name: SITE_REPO, provisioned: true, installation_token: "ghp_umbrella_test" });
  });

  it("the same repo under another tenant fails", async () => {
    await expect(resolveRepoCredsForRun(T2, payload())).rejects.toThrow(/provisioned-repo gate failed/);
  });

  it("a payload site_id that does not match fails", async () => {
    await expect(resolveRepoCredsForRun(T1, payload({ site_id: "site-b" }))).rejects.toThrow(/site_id/);
  });

  it("a missing payload site_id fails", async () => {
    const p = payload();
    delete (p as Record<string, unknown>).site_id;
    await expect(resolveRepoCredsForRun(T1, p)).rejects.toThrow(/site_id/);
  });

  it("a store error fails closed", async () => {
    mocks.getByRepo.mockRejectedValue(new Error("sites read failed"));
    await expect(resolveRepoCredsForRun(T1, payload())).rejects.toThrow(/provisioned-repo gate failed/);
  });

  it("a dead site fails", async () => {
    mocks.getByRepo.mockResolvedValue({ ...SITE, status: "fell_back_old" });
    await expect(resolveRepoCredsForRun(T1, payload())).rejects.toThrow(/provisioned-repo gate failed/);
  });
});
