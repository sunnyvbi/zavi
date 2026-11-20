
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAppSetting = vi.fn();
vi.mock("@/services/settings", () => ({
  getAppSetting: (...args: unknown[]) => getAppSetting(...args),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

import { realDeployPollDeps } from "../provisioning-deploy-poll";

const gate = () => realDeployPollDeps("token", (async () => new Response("")) as never);

beforeEach(() => getAppSetting.mockReset());

describe("isBuildFlowTenant — only 'fresh' may have its identity overwritten", () => {
  it("'fresh' → true (the tenant's product IS the app we built)", async () => {
    getAppSetting.mockResolvedValue("fresh");
    expect(await gate().isBuildFlowTenant("t1")).toBe(true);
  });

  it("'existing' → false (has-product tenant keeps its own domain)", async () => {
    getAppSetting.mockResolvedValue("existing");
    expect(await gate().isBuildFlowTenant("t1")).toBe(false);
  });

  it("unset → false (absence is silent; the agent asks)", async () => {
    getAppSetting.mockResolvedValue(undefined);
    expect(await gate().isBuildFlowTenant("t1")).toBe(false);
  });

  it("an unknown future value → false, not 'truthy so probably yes'", async () => {
    getAppSetting.mockResolvedValue("migrating");
    expect(await gate().isBuildFlowTenant("t1")).toBe(false);
  });
});
