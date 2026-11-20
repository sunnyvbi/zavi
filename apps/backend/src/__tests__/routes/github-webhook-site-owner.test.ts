import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const INSTALLER = "00000000-0000-0000-0000-00000000000a";
const OWNER = "00000000-0000-0000-0000-00000000000b";

const m = vi.hoisted(() => {
  const state = {
    connectorTenant: { tenant_id: "00000000-0000-0000-0000-00000000000a" } as { tenant_id: string } | null,
    siteRef: null as { tenant_id: string; site_id: string; status: string } | null,
    siteRpcError: null as { message: string } | null,
  };
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const maybeSingle = vi.fn(async () => ({ data: state.connectorTenant, error: null }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- self-referential mock chain
  const eqChain: any = vi.fn(() => ({ eq: eqChain, maybeSingle, limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }));
  const from = vi.fn(() => ({ select: () => ({ eq: eqChain }) }));
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    if (name === "site_by_repo") {
      if (state.siteRpcError) return { data: null, error: state.siteRpcError };
      return { data: state.siteRef ? [state.siteRef] : [], error: null };
    }
    if (name === "mark_pr_merged") return { data: 0, error: null };
    return { data: null, error: null };
  });
  const enqueueDeployTruthWatch = vi.fn(async () => ({ enqueued: false, reason: "not_a_provisioned_app" }));
  const enqueueWorkItem = vi.fn(async () => ({ work_item_id: "wi" }));
  return { state, rpcCalls, rpc, from, enqueueDeployTruthWatch, enqueueWorkItem };
});

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("@/services/pipeline/deploy-truth", () => ({
  enqueueDeployTruthWatch: (...a: unknown[]) => (m.enqueueDeployTruthWatch as (...x: unknown[]) => unknown)(...a),
  realEnqueueDeployTruthDeps: {},
}));
vi.mock("@/services/agents/work-queue", () => ({ enqueueWorkItem: (...a: unknown[]) => (m.enqueueWorkItem as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }));
vi.mock("@/services/connectors/github/oauth", () => ({
  verifyWebhookSignature: () => true,
  listInstallationRepos: async () => [],
}));

import { githubWebhook } from "../../routes/webhooks/github";

function mkRes() {
  let s = 200;
  let b: unknown = null;
  const res = {
    status(c: number) {
      s = c;
      return res;
    },
    json(x: unknown) {
      b = x;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => s, body: () => b as Record<string, unknown> };
}

function req(event: string, body: Record<string, unknown>): Request {
  const headers: Record<string, string> = {
    "x-hub-signature-256": "sha256=stub",
    "x-github-event": event,
    "x-github-delivery": "d-1",
  };
  return { body: Buffer.from(JSON.stringify(body)), header: (n: string) => headers[n.toLowerCase()] } as unknown as Request;
}

const merged = (repo: string) => ({
  action: "closed",
  installation: { id: 42, account: { login: "Praxis-build" } },
  repository: { full_name: repo },
  pull_request: { merged: true, html_url: `https://github.com/${repo}/pull/1`, merge_commit_sha: "abc", merged_at: "2026-10-01T00:00:00Z" },
});

beforeEach(() => {
  m.state.connectorTenant = { tenant_id: INSTALLER };
  m.state.siteRef = null;
  m.state.siteRpcError = null;
  m.rpcCalls.length = 0;
  m.enqueueDeployTruthWatch.mockClear();
  m.enqueueWorkItem.mockClear();
});

describe("github webhook: repo -> site ownership", () => {
  it("a merged PR on a site repo acts for the SITE OWNER, not the installer, and skips the legacy watch", async () => {
    m.state.siteRef = { tenant_id: OWNER, site_id: "s1", status: "live" };
    const { res, body } = mkRes();
    await githubWebhook(req("pull_request", merged("Zavi-Sites/Lucky-Paws")), res);
    expect(m.rpcCalls.find((c) => c.name === "site_by_repo")?.args).toEqual({ p_github_full_name: "Zavi-Sites/Lucky-Paws" });
    const mark = m.rpcCalls.find((c) => c.name === "mark_pr_merged");
    expect(mark?.args.p_tenant_id).toBe(OWNER);
    expect(m.rpcCalls.some((c) => c.args.p_tenant_id === INSTALLER)).toBe(false);
    expect(m.enqueueDeployTruthWatch).not.toHaveBeenCalled();
    expect(body().action).toBe("merged_recorded");
  });

  it("a site repo event with NO connector tenant still resolves to the site owner", async () => {
    m.state.connectorTenant = null;
    m.state.siteRef = { tenant_id: OWNER, site_id: "s1", status: "live" };
    const { res } = mkRes();
    await githubWebhook(req("pull_request", merged("Zavi-Sites/Lucky-Paws")), res);
    expect(m.rpcCalls.find((c) => c.name === "mark_pr_merged")?.args.p_tenant_id).toBe(OWNER);
  });

  it("an engineer shepherd signal on a site repo enqueues for the site owner only", async () => {
    m.state.siteRef = { tenant_id: OWNER, site_id: "s1", status: "live" };
    const { res } = mkRes();
    await githubWebhook(
      req("pull_request_review", {
        action: "submitted",
        installation: { id: 42 },
        repository: { full_name: "Zavi-Sites/Lucky-Paws" },
        review: { state: "changes_requested" },
        pull_request: { head: { ref: "engineer/fix" } },
      }),
      res,
    );
    expect(m.enqueueWorkItem).toHaveBeenCalledTimes(1);
    expect((m.enqueueWorkItem.mock.calls[0] as unknown[])[0]).toMatchObject({ tenant_id: OWNER });
  });

  it("a deleted site's repo is ignored: no run marked, no watch, no enqueue", async () => {
    m.state.siteRef = { tenant_id: OWNER, site_id: "s1", status: "deleted" };
    const { res, body } = mkRes();
    await githubWebhook(req("pull_request", merged("Zavi-Sites/Lucky-Paws")), res);
    expect(m.rpcCalls.some((c) => c.name === "mark_pr_merged")).toBe(false);
    expect(m.enqueueDeployTruthWatch).not.toHaveBeenCalled();
    expect(body().ignored).toMatchObject({ reason: "site_gone" });
  });

  it("FAIL-CLOSED: an owner-lookup failure acts for nobody (200, no tenant writes)", async () => {
    m.state.siteRpcError = { message: "rpc down" };
    const { res, status, body } = mkRes();
    await githubWebhook(req("pull_request", merged("acme/web")), res);
    expect(status()).toBe(200);
    expect(body().action).toBe("repo_owner_unresolved");
    expect(m.rpcCalls.some((c) => c.name === "mark_pr_merged")).toBe(false);
    expect(m.enqueueDeployTruthWatch).not.toHaveBeenCalled();
  });

  it("a plain (non-site) repo keeps the connector tenant and the legacy deploy-truth watch", async () => {
    const { res } = mkRes();
    await githubWebhook(req("pull_request", merged("acme/web")), res);
    expect(m.enqueueDeployTruthWatch).toHaveBeenCalledTimes(1);
    expect(m.rpcCalls.find((c) => c.name === "mark_pr_merged")?.args.p_tenant_id).toBe(INSTALLER);
  });
});
