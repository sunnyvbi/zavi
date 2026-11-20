import { describe, it, expect, vi, afterEach } from "vitest";
import { seedTemplate } from "@/services/provisioning/seed-template";
import { seedProvisionedRepo } from "@/services/provisioning/seed-provisioned-repo";
import { createGitHubRepoProvisioner } from "@/services/provisioning/github-repo";
import { isProvisionedUmbrellaOwner } from "@/services/mcp/internal/github";
import { resolveProvisionOrg } from "@/services/provisioning/provision-org";
import { fakeGitHub, type Files } from "./fake-github-git";

const OLD_APP: Files = {
  "package.json": '{"name":"laptop-rental","dependencies":{"lucide-react":"1"}}',
  "app/page.tsx": "export default function Laptops() { return 'Laptop rental'; }",
  "app/laptops/page.tsx": "import { Laptop } from 'lucide-react';",
  "lib/laptops.ts": "export const laptops = [];",
  "README.md": "# laptop rental",
};
const STARTER: Files = {
  "package.json": '{"name":"starter"}',
  "app/page.tsx": "export default function Home() { return 'starter'; }",
  "README.md": "# starter",
  ".gitignore": "node_modules\n.next\n",
};
const base = (fetchFn: unknown) => ({ token: () => "tok", fetchFn: fetchFn as never, files: STARTER, provisionOrg: () => "Praxis-build" });

describe("seedTemplate replaceExisting (fresh build on a repo that already holds an app)", () => {
  it("replaces the whole tree: no base_tree, only starter paths, parent is the old HEAD, fast-forward with force:false", async () => {
    const gh = fakeGitHub({ initial: OLD_APP });
    const r = await seedTemplate("t1", "Praxis-build/mohit-93bd8436", { ...base(gh.fetchFn), replaceExisting: true });
    expect(r).toMatchObject({ seeded: true, replaced: true, previous_commit_sha: "c_old" });
    expect(gh.state.treeCalls).toHaveLength(1);
    expect(gh.state.treeCalls[0]).not.toHaveProperty("base_tree");
    expect(gh.state.treeCalls[0].tree.map((e) => e.path).sort()).toEqual(Object.keys(STARTER).sort());
    expect(gh.state.commitCalls[0].parents).toEqual(["c_old"]);
    expect(gh.state.patchCalls).toEqual([{ sha: (r as { commit_sha: string }).commit_sha, force: false }]);
    expect(gh.headFiles()).toEqual(STARTER);
    expect(gh.commits.get("c_old")).toBeDefined();
  });

  it("without replaceExisting the seed-once guard still refuses and writes nothing", async () => {
    const gh = fakeGitHub({ initial: OLD_APP });
    const r = await seedTemplate("t1", "Praxis-build/mohit-93bd8436", base(gh.fetchFn));
    expect(r).toMatchObject({ seeded: false, reason: "repo_not_empty" });
    expect(gh.state.treeCalls).toHaveLength(0);
    expect(gh.state.commitCalls).toHaveLength(0);
    expect(gh.state.patchCalls).toHaveLength(0);
    expect(gh.headFiles()).toEqual(OLD_APP);
  });

  it("empty (auto_init) repo keeps the layered seed even when replaceExisting is set", async () => {
    const gh = fakeGitHub({ initial: { "README.md": "# auto" } });
    const r = await seedTemplate("t1", "Praxis-build/new", { ...base(gh.fetchFn), replaceExisting: true });
    expect(r).toMatchObject({ seeded: true });
    expect(r).not.toHaveProperty("replaced");
    expect(gh.state.treeCalls[0].base_tree).toBeTruthy();
    expect(gh.headFiles()).toEqual(STARTER);
  });

  it("refuses to replace a repo outside the provisioning org and writes nothing", async () => {
    const gh = fakeGitHub({ initial: OLD_APP });
    await expect(
      seedTemplate("t1", "customer-org/their-app", { ...base(gh.fetchFn), replaceExisting: true }),
    ).rejects.toThrow(/not under the provisioning org/);
    const writes = gh.fetchFn.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method);
    expect(writes).toEqual([]);
    expect(gh.headFiles()).toEqual(OLD_APP);
  });

  it("HEAD moving under the replacement is rejected (no clobber) and throws", async () => {
    const gh = fakeGitHub({ initial: OLD_APP, moveHeadBeforePatch: true });
    await expect(
      seedTemplate("t1", "Praxis-build/mohit-93bd8436", { ...base(gh.fetchFn), replaceExisting: true }),
    ).rejects.toThrow(/ref update failed \(422\)/);
    expect(gh.state.head).toBe("c_concurrent");
  });

  it("seedProvisionedRepo threads replaceExisting and flags a failed replacement", async () => {
    const ok = fakeGitHub({ initial: OLD_APP });
    const r1 = await seedProvisionedRepo("t1", "Praxis-build/x", { ...base(ok.fetchFn), enabled: () => true, replaceExisting: true });
    expect(r1).toMatchObject({ seeded: true, replaced: true });
    const bad = fakeGitHub({ initial: OLD_APP, failOn: "commit" });
    const r2 = await seedProvisionedRepo("t1", "Praxis-build/x", { ...base(bad.fetchFn), enabled: () => true, replaceExisting: true });
    expect(r2).toMatchObject({ seeded: false, reason: "error", replace_requested: true });
    expect(bad.headFiles()).toEqual(OLD_APP);
    const plain = fakeGitHub({ initial: OLD_APP });
    const r3 = await seedProvisionedRepo("t1", "Praxis-build/x", { ...base(plain.fetchFn), enabled: () => true });
    expect(r3).toMatchObject({ seeded: false, reason: "repo_not_empty" });
  });
});

describe("provisioning org resolution when PRAXIS_GITHUB_ORG is unset or blank", () => {
  const noOrg = (fetchFn: unknown) => ({ token: () => "tok", fetchFn: fetchFn as never, files: STARTER });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const [label, value] of [["unset", undefined], ["blank", "  "]] as const) {
    it(`${label}: first build into an empty repo seeds with replaceExisting and the build is not blocked`, async () => {
      vi.stubEnv("PRAXIS_GITHUB_ORG", value as string);
      if (value === undefined) delete process.env.PRAXIS_GITHUB_ORG;
      const gh = fakeGitHub({ initial: { "README.md": "# auto" } });
      const r = await seedProvisionedRepo("t1", "praxis-built/acme-1234abcd", {
        ...noOrg(gh.fetchFn),
        enabled: () => true,
        replaceExisting: true,
      });
      expect(r).toMatchObject({ seeded: true });
      expect(gh.headFiles()).toEqual({ ...STARTER });
    });

    it(`${label}: an empty repo is seeded even when its owner is not the provisioning org, because nothing is replaced`, async () => {
      vi.stubEnv("PRAXIS_GITHUB_ORG", value as string);
      if (value === undefined) delete process.env.PRAXIS_GITHUB_ORG;
      const gh = fakeGitHub({ initial: { "README.md": "# auto" } });
      const r = await seedTemplate("t1", "Praxis-build/acme-1234abcd", { ...noOrg(gh.fetchFn), replaceExisting: true });
      expect(r).toMatchObject({ seeded: true });
      expect(gh.state.treeCalls[0].base_tree).toBeTruthy();
    });

    it(`${label}: a rebuild into a non-empty praxis-built repo replaces the old app under the shared default org`, async () => {
      vi.stubEnv("PRAXIS_GITHUB_ORG", value as string);
      if (value === undefined) delete process.env.PRAXIS_GITHUB_ORG;
      const gh = fakeGitHub({ initial: OLD_APP });
      const r = await seedTemplate("t1", "praxis-built/acme-1234abcd", { ...noOrg(gh.fetchFn), replaceExisting: true });
      expect(r).toMatchObject({ seeded: true, replaced: true, previous_commit_sha: "c_old" });
      expect(gh.headFiles()).toEqual(STARTER);
    });

    it(`${label}: a non-empty repo outside the default org is still refused with no write`, async () => {
      vi.stubEnv("PRAXIS_GITHUB_ORG", value as string);
      if (value === undefined) delete process.env.PRAXIS_GITHUB_ORG;
      const gh = fakeGitHub({ initial: OLD_APP });
      await expect(
        seedTemplate("t1", "customer-org/their-app", { ...noOrg(gh.fetchFn), replaceExisting: true }),
      ).rejects.toThrow(/not under the provisioning org "praxis-built"/);
      expect(gh.state.treeCalls).toHaveLength(0);
      expect(gh.state.patchCalls).toHaveLength(0);
      expect(gh.headFiles()).toEqual(OLD_APP);
    });

    it(`${label}: the repo the provisioner creates is one the seed guard and the push gate both accept`, async () => {
      vi.stubEnv("PRAXIS_GITHUB_ORG", value as string);
      if (value === undefined) delete process.env.PRAXIS_GITHUB_ORG;
      const provisioner = createGitHubRepoProvisioner({
        token: () => "tok",
        fetchFn: (async (url: string) => {
          const full = url.split("/repos/")[1];
          return { status: 200, json: async () => ({ full_name: full, html_url: `https://github.com/${full}`, default_branch: "main" }), text: async () => "" };
        }) as never,
      });
      const res = await provisioner.ensure({ tenant_id: "1234abcd-0000-0000-0000-000000000000", company_name: "Acme" });
      const full = String((res.external_ref as { github_full_name: string }).github_full_name);
      expect(full.split("/")[0]).toBe("praxis-built");
      expect(resolveProvisionOrg()).toBe("praxis-built");
      expect(isProvisionedUmbrellaOwner(full.split("/")[0])).toBe(true);
      const gh = fakeGitHub({ initial: OLD_APP });
      const r = await seedTemplate("t1", full, { ...noOrg(gh.fetchFn), replaceExisting: true });
      expect(r).toMatchObject({ seeded: true, replaced: true });
    });
  }

  it("an explicit PRAXIS_GITHUB_ORG still wins everywhere", async () => {
    vi.stubEnv("PRAXIS_GITHUB_ORG", " Praxis-build ");
    expect(resolveProvisionOrg()).toBe("Praxis-build");
    expect(isProvisionedUmbrellaOwner("praxis-build")).toBe(true);
    expect(isProvisionedUmbrellaOwner("praxis-built")).toBe(false);
    const gh = fakeGitHub({ initial: OLD_APP });
    await expect(
      seedTemplate("t1", "praxis-built/x", { token: () => "tok", fetchFn: gh.fetchFn as never, files: STARTER, replaceExisting: true }),
    ).rejects.toThrow(/not under the provisioning org "Praxis-build"/);
  });
});
