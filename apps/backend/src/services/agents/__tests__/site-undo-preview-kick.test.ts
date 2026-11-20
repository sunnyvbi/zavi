import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  kicks: [] as Array<{ tenant_id: string; site?: unknown; repo: unknown }>,
  runs: [] as string[],
}));

vi.mock("@/services/agents/conductor-driver", () => ({
  kickSandboxPreview: (input: { tenant_id: string; site?: unknown; node: { payload: { target: { github_full_name: unknown } } } }) => {
    h.kicks.push({ tenant_id: input.tenant_id, site: input.site, repo: input.node.payload.target.github_full_name });
  },
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => ({}) }));
vi.mock("@/services/sites/sandbox-resolver", () => ({
  createSiteSandboxResolver: () => ({
    forSite: async () => ({
      run: async (cmd: string) => {
        h.runs.push(cmd);
        return { exitCode: 0, stdout: "__head=fff1234def5678901234567890123456789abcde\n", stderr: "" };
      },
    }),
  }),
}));

import { syncSitePreviewToCommit } from "@/services/agents/refine-undo";
import { siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";

describe("site undo moves the preview with the real wiring", () => {
  it("restarts the site's preview as a site (with the click-to-edit picker), not as an old-flow app", async () => {
    const site = siteRow({ id: "aaaaaaaa-0000-4000-8000-000000000001", label: "alpha", root_conductor_run_id: "run-root-a", status: "building" });
    await syncSitePreviewToCommit({ tenant_id: T1, site, sha: "fff1234def5678901234567890123456789abcde" });
    expect(h.runs).toHaveLength(1);
    expect(h.kicks).toEqual([{ tenant_id: T1, site: true, repo: site.github_full_name }]);
  });
});
