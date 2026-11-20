import { describe, it, expect } from "vitest";
import { isBuildPipelinePayload, tenantHasRealGithubInstall } from "../repo-access-gate";

function svcReturning(data: unknown, error: unknown = null) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = () => Promise.resolve({ data, error });
  return { from: () => q } as never;
}

describe("build-repo gate inputs", () => {
  it("a build-pipeline payload is any stage or a repair pass", () => {
    expect(isBuildPipelinePayload({ stage: "build" })).toBe(true);
    expect(isBuildPipelinePayload({ stage: "refine_gate" })).toBe(true);
    expect(isBuildPipelinePayload({ repair_mode: true })).toBe(true);
    expect(isBuildPipelinePayload({ task_description: "A launch-ready landing page", repo_hint: "acme/ios" })).toBe(false);
    expect(isBuildPipelinePayload(null)).toBe(false);
  });

  it("reads the tenant's own row: a real install is true, the umbrella sentinel false, errors false", async () => {
    expect(await tenantHasRealGithubInstall("t", svcReturning({ installation_id: 42, account_login: "acme" }))).toBe(true);
    expect(await tenantHasRealGithubInstall("t", svcReturning({ installation_id: null, account_login: "Praxis-build" }))).toBe(false);
    expect(await tenantHasRealGithubInstall("t", svcReturning(null, { message: "boom" }))).toBe(false);
  });
});
