
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    }),
  }),
}));

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const skillTool = {
  name: "tenant_skill__cto-engineer__abc12345",
  description: "Learned tenant routine: deploy. Learned from 2 sources on 2026-05-28; review before use.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  server_id: "tenant_skill",
  tool_name: "cto-engineer__abc12345",
};

vi.mock("@/services/routines/inject", () => ({
  synthesizeApprovedRoutineTools: vi.fn(async (tenant_id: string, agent_slug: string) => {
    if (tenant_id === TENANT_A && agent_slug === "cto-engineer") return [skillTool];
    return [];
  }),
}));

type LogEventArg = {
  level: string;
  code: string;
  tenant_id: string;
  meta: { agent_slug: string };
};
const logEventMock = vi.fn(async (_arg: LogEventArg) => {});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (arg: LogEventArg) => logEventMock(arg) }));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";
import { synthesizeApprovedRoutineTools } from "@/services/routines/inject";

describe("discovery — single-source tenant-routine injection", () => {
  beforeEach(() => {
    _clearToolCacheForTests();
    logEventMock.mockClear();
  });

  it("splices the approved routine into the resolved tool list for the matching agent", async () => {
    const r = await discoverToolsForTenant(TENANT_A, [], "cto-engineer");
    const names = r.tools.map((t) => t.name);
    expect(names).toContain("tenant_skill__cto-engineer__abc12345");
  });

  it("injects NO skills when agent_slug is omitted (legacy callers)", async () => {
    const r = await discoverToolsForTenant(TENANT_A, []);
    expect(r.tools.find((t) => t.server_id === "tenant_skill")).toBeUndefined();
  });

  it("injects NO skills for a different agent (cross-agent isolation)", async () => {
    const r = await discoverToolsForTenant(TENANT_A, [], "operator");
    expect(r.tools.find((t) => t.server_id === "tenant_skill")).toBeUndefined();
  });

  it("injects NO skills for a different tenant (cross-tenant isolation)", async () => {
    const r = await discoverToolsForTenant("bbbbbbbb-0000-0000-0000-000000000002", [], "cto-engineer");
    expect(r.tools.find((t) => t.server_id === "tenant_skill")).toBeUndefined();
  });

  it("emits a logEvent (warn) and fails open when routine synthesis throws", async () => {
    (synthesizeApprovedRoutineTools as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(
      new Error("synth boom"),
    );
    const r = await discoverToolsForTenant(TENANT_A, [], "cto-engineer");
    expect(r.tools.find((t) => t.server_id === "tenant_skill")).toBeUndefined();
    expect(logEventMock).toHaveBeenCalledTimes(1);
    const arg = logEventMock.mock.calls[0][0];
    expect(arg.level).toBe("warn");
    expect(arg.code).toBe("tenant_skill_inject_failed");
    expect(arg.tenant_id).toBe(TENANT_A);
    expect(arg.meta.agent_slug).toBe("cto-engineer");
  });
});
