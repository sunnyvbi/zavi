import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { siteRow, T1, T2 } from "./fake-site-store";
import { restartSitePreview } from "../site-preview-restart";

const h = vi.hoisted(() => ({
  resolve: vi.fn(async () => ({ e2b_sandbox_id: "restarted-box", row_id: "sandbox-row" })),
  inject: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  scrub: vi.fn(async () => {}),
  head: vi.fn(async () => "new-head"),
  ready: vi.fn(async () => "preview_starting"),
  destroy: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  markDestroyed: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/services/tenant-client", () => {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { id: "sandbox-row", e2b_sandbox_id: "old-box" }, error: null }) };
  return { asTenantId: (t: string) => t, tenantClient: () => ({ from: () => chain }) };
});

vi.mock("@/services/sandbox/lifecycle", () => ({
  resolveSandboxForRun: h.resolve,
  injectSandboxSecrets: h.inject,
  resetSiteRepo: h.reset,
  markSandboxFailed: vi.fn(),
  markSandboxDestroyed: async (id: string) => {
    const r = (await (h.markDestroyed as (...args: unknown[]) => Promise<unknown>)("mark_sandbox_destroyed", { p_id: id })) as { error: { message: string } | null };
    if (r.error) throw new Error(r.error.message);
  },
  sandboxTemplateForRun: () => "site-template",
}));
vi.mock("@/services/sandbox/e2b-client", () => ({ revokeSandboxGithubToken: h.scrub, destroySandbox: h.destroy, pauseSandbox: h.pause }));
vi.mock("@/services/provisioning/github-repo", () => ({ readProvisionedRepoHeadSha: h.head }));
vi.mock("@/services/logging/alert", () => ({ alert: vi.fn(async () => {}) }));
vi.mock("../sandbox-ready", () => ({ onSiteSandboxReady: h.ready }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GITHUB_PROVISION_TOKEN", "test-repo-credential");
});
afterEach(() => { vi.unstubAllEnvs(); });

it("restarts through the production helper, resets the site's repo and scrubs its credential before preview boot", async () => {
  const site = siteRow({ id: "33333333-3333-4333-8333-333333333333", backend_mode: "static" });
  await restartSitePreview({ tenant_id: T1, run_id: "build-run", site });
  expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, repo_full_name: site.github_full_name, run_id: site.id, template: "site-template" }));
  expect(h.reset).toHaveBeenCalledWith("restarted-box", `https://github.com/${site.github_full_name}.git`, "new-head");
  expect(h.scrub).toHaveBeenCalledWith("restarted-box");
  expect(h.ready).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T1, site_id: site.id, e2b_sandbox_id: "restarted-box" }), undefined, { repoAlreadyReset: true });
  expect(h.scrub.mock.invocationCallOrder[0]).toBeLessThan(h.ready.mock.invocationCallOrder[0]);
});

it("never writes the credential into the old box: it is destroyed and its row marked destroyed before the new box is resolved", async () => {
  const site = siteRow({ id: "33333333-3333-4333-8333-333333333333", backend_mode: "static" });
  await restartSitePreview({ tenant_id: T1, run_id: "build-run", site });
  expect(h.destroy).toHaveBeenCalledWith("old-box");
  expect(h.markDestroyed).toHaveBeenCalledWith("mark_sandbox_destroyed", { p_id: "sandbox-row" });
  expect(h.destroy.mock.invocationCallOrder[0]).toBeLessThan(h.resolve.mock.invocationCallOrder[0]);
  expect(h.markDestroyed.mock.invocationCallOrder[0]).toBeLessThan(h.resolve.mock.invocationCallOrder[0]);
  expect(h.inject).toHaveBeenCalledWith("restarted-box", expect.anything());
  expect(h.inject).not.toHaveBeenCalledWith("old-box", expect.anything());
});

it("a failed scrub force-pauses the new box and never boots the preview (#3474)", async () => {
  h.scrub.mockRejectedValue(new Error("scrub exit 1"));
  const release = vi.fn(async () => {});
  const site = siteRow({ id: "33333333-3333-4333-8333-333333333333", backend_mode: "static" });
  await expect(restartSitePreview({ tenant_id: T1, run_id: "build-run", site, release })).rejects.toThrow();
  expect(h.pause).toHaveBeenCalledWith("restarted-box");
  expect(h.ready).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalled();
  h.scrub.mockReset();
});

it("a box that cannot be retired is never reused: no resolve, no credential", async () => {
  h.markDestroyed.mockResolvedValueOnce({ error: { message: "db down" } } as never);
  const site = siteRow({ id: "33333333-3333-4333-8333-333333333333", backend_mode: "static" });
  await expect(restartSitePreview({ tenant_id: T1, run_id: "build-run", site })).rejects.toThrow(/retire/);
  expect(h.resolve).not.toHaveBeenCalled();
  expect(h.inject).not.toHaveBeenCalled();
});

it("rejects another tenant before resolving a sandbox", async () => {
  await expect(restartSitePreview({ tenant_id: T1, run_id: "build-run", site: siteRow({ id: "33333333-3333-4333-8333-333333333333", tenant_id: T2 }) })).rejects.toThrow(/workspace/);
  expect(h.resolve).not.toHaveBeenCalled();
});
