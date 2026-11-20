import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connector: null as Record<string, unknown> | null,
  provisioned: null as Record<string, unknown> | null,
  fail: "" as string,
  sites: [] as Array<Record<string, unknown>>,
  reads: [] as Array<{ table: string; filters: Record<string, unknown> }>,
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let selection = "";
      const q = {
        select(columns: string) { selection = columns; return q; },
        eq(key: string, value: unknown) { filters[key] = value; return q; },
        async maybeSingle() {
          state.reads.push({ table, filters });
          const fail = state.fail === table || (state.fail === "scoped" && selection.includes("selected_repo_ids"));
          return { data: fail ? null : table === "connector_metadata" ? state.connector : state.provisioned,
            error: fail ? { message: "temporary read failure" } : null };
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/connectors/github/repo-scoping-flag", () => ({
  getRepoScopingFlagState: async () => "on",
}));

vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    async listForTenant(tenant_id: string) {
      if (state.fail === "sites") throw new Error("sites unavailable");
      return state.sites.filter(s => s.tenant_id === tenant_id);
    },
    async getByRepo(tenant_id: string, repo: string) {
      if (state.fail === "sites") throw new Error("sites unavailable");
      return state.sites.find(s => s.tenant_id === tenant_id && s.github_full_name === repo) ?? null;
    },
  }),
}));
vi.mock("@/services/sites/public-resolver", () => ({
  sitePublicResolver: () => ({
    async byRepo(repo: string) {
      const site = state.sites.find(s => s.github_full_name === repo);
      return site ? { tenant_id: site.tenant_id, site_id: site.id, status: site.status } : null;
    },
  }),
}));

import { resolveEngineerDispatchRepo, withEngineerRepo } from "../engineer-dispatch-repo";
import { resolveContentSeoPublishRepo } from "@/agents/content-design/post-run";
import { checkSandboxRepoAccess } from "@/services/sandbox/repo-access-gate";
import { resolveRepoCredsForRun } from "@/services/sandbox/repo-creds";

afterEach(() => {
  vi.unstubAllEnvs();
});

const body = { target_agent_slug: "engineer", intent: "fix the signup form" };
const resolveCard = () => withEngineerRepo("growth-lead.dispatch-specialist", body,
  () => resolveEngineerDispatchRepo("tenant-1"));

beforeEach(() => {
  state.connector = null;
  state.provisioned = null;
  state.fail = "";
  state.reads = [];
  state.sites = [];
});

describe("engineer card eligibility using the real repository readers", () => {
  it.each(["connector_metadata", "scoped", "tenant_resources"])("keeps the proposal without inventing a repo when %s fails", async (failure) => {
    if (failure === "scoped") state.connector = { repo_ids: [1], repo_full_names: ["acme/site"] };
    state.fail = failure;
    expect(await resolveCard()).toBe(body);
    expect(state.reads.every((read) => read.filters.tenant_id === "tenant-1")).toBe(true);
  });

  it("does not turn a scoped-repo read error on a supplied hint into no repository", async () => {
    state.connector = { repo_ids: [1], repo_full_names: ["acme/site"] };
    state.fail = "scoped";
    const hinted = { ...body, repo_hint: "acme/site" };
    expect(await withEngineerRepo("cgo.dispatch-specialist", hinted,
      hint => resolveEngineerDispatchRepo("tenant-1", hint))).toBe(hinted);
  });

  it("preserves a provisioned hint when its permission lookup is unreadable", async () => {
    state.fail = "tenant_resources";
    const hinted = { ...body, repo_hint: "Praxis-build/site" };
    expect(await withEngineerRepo("cgo.dispatch-specialist", hinted,
      hint => resolveEngineerDispatchRepo("tenant-1", hint))).toBe(hinted);
  });

  it("refuses a confirmed no-repository tenant", async () => {
    expect(await resolveCard()).toBeNull();
  });

  it("uses the connected repository", async () => {
    state.connector = { repo_ids: [1], repo_full_names: ["acme/site"] };
    expect(await resolveCard()).toEqual({ ...body, repo_hint: "acme/site" });
  });

  it("preserves a choice between several connected repositories", async () => {
    state.connector = { repo_ids: [1, 2], repo_full_names: ["acme/a", "acme/b"] };
    expect(await resolveCard()).toBe(body);
  });

  it("does not restore a scoped-out default or scoped-out repositories", async () => {
    state.connector = { repo_ids: [1], repo_full_names: ["acme/site"],
      default_repo_full_name: "acme/site", selected_repo_ids: [] };
    expect(await resolveCard()).toBeNull();
  });

  it("counts a legacy Zavi-provisioned repository", async () => {
    state.provisioned = { mode: "provisioned", external_ref: { github_full_name: "Praxis-build/site" } };
    expect(await resolveCard()).toEqual({ ...body, repo_hint: "Praxis-build/site" });
  });

  it("uses the canonical current site, with its matching site id", async () => {
    state.sites = [
      { id: "old-site", tenant_id: "tenant-1", status: "live", github_full_name: "Praxis-build/old", created_at: "2026-10-01" },
      { id: "new-site", tenant_id: "tenant-1", status: "live", github_full_name: "Praxis-build/new", created_at: "2026-10-25" },
      { id: "deleted", tenant_id: "tenant-1", status: "deleted", github_full_name: "Praxis-build/deleted", created_at: "2026-10-28" },
    ];
    expect(await resolveCard()).toEqual({ ...body, repo_hint: "Praxis-build/new", site_id: "new-site" });
  });

  it("takes a site-only engineer card through eager preflight and credential resolution", async () => {
    vi.stubEnv("GITHUB_PROVISION_TOKEN", "test-umbrella-token");
    state.sites = [{ id: "site-1", tenant_id: "tenant-1", status: "live", github_full_name: "Praxis-build/site" }];
    const card = await resolveCard();
    expect(card).toEqual({ ...body, repo_hint: "Praxis-build/site", site_id: "site-1" });
    const payload = { ...card, task_description: body.intent };
    expect(await checkSandboxRepoAccess("tenant-1", payload)).toBe("ok");
    expect(await resolveRepoCredsForRun("tenant-1", payload)).toMatchObject({
      kind: "resolved", repo_full_name: "Praxis-build/site", provisioned: true,
    });
  });

  it.each([
    { tenant_id: "tenant-2", status: "live", suppliedId: "site-1" },
    { tenant_id: "tenant-1", status: "deleted", suppliedId: "site-1" },
    { tenant_id: "tenant-1", status: "failed", suppliedId: "site-1" },
    { tenant_id: "tenant-1", status: "live", suppliedId: "wrong-site" },
    { tenant_id: "tenant-1", status: "live", suppliedId: undefined },
  ])("does not bypass preflight for an invalid site identity: %j", async ({ tenant_id, status, suppliedId }) => {
    state.sites = [{ id: "site-1", tenant_id, status, github_full_name: "Praxis-build/site" }];
    expect(await checkSandboxRepoAccess("tenant-1", { repo_hint: "Praxis-build/site", site_id: suppliedId })).toBe("not_connected");
  });

  it("adds the matching site id to an existing CGO repo hint", async () => {
    state.sites = [{ id: "site-1", tenant_id: "tenant-1", status: "live", github_full_name: "Praxis-build/site" }];
    const hinted = { ...body, repo_hint: "Praxis-build/site" };
    expect(await withEngineerRepo("cgo.dispatch-specialist", hinted,
      hint => resolveEngineerDispatchRepo("tenant-1", hint))).toEqual({ ...hinted, site_id: "site-1" });
  });

  it.each(["deleted", "failed"])("does not use a %s site", async status => {
    state.sites = [{ id: "site-1", tenant_id: "tenant-1", status, github_full_name: "Praxis-build/site" }];
    expect(await resolveCard()).toBeNull();
    expect(await resolveEngineerDispatchRepo("tenant-1", "Praxis-build/site")).toBeNull();
  });

  it("refuses a foreign site hint even if an umbrella installation lists the repo", async () => {
    state.connector = { repo_ids: [1], repo_full_names: ["Praxis-build/foreign"] };
    state.sites = [{ id: "site-2", tenant_id: "tenant-2", status: "live", github_full_name: "Praxis-build/foreign" }];
    expect(await resolveEngineerDispatchRepo("tenant-1", "Praxis-build/foreign")).toBeNull();
  });

  it("refuses a mismatched supplied site id instead of silently retargeting it", async () => {
    state.sites = [{ id: "site-1", tenant_id: "tenant-1", status: "live", github_full_name: "Praxis-build/site" }];
    expect(await withEngineerRepo("cgo.dispatch-specialist", { ...body, repo_hint: "Praxis-build/site", site_id: "another-site" },
      hint => resolveEngineerDispatchRepo("tenant-1", hint))).toBeNull();
  });

  it("keeps an unhinted proposal when the sites lookup fails", async () => {
    state.fail = "sites";
    expect(await resolveCard()).toBe(body);
  });

  it("preserves the content publisher's default fail-closed read behavior", async () => {
    state.fail = "connector_metadata";
    expect(await resolveContentSeoPublishRepo("tenant-1")).toBeNull();
  });
});
