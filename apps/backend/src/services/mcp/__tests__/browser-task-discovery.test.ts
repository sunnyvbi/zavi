import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";
import { READ_BASELINE, UNIVERSAL_TOOL_BASELINE } from "../write-allowlist";
import { isSideEffectingTool } from "../tool-effect-classifier";
import { effectOf } from "../tool-effects";
import { classifyToolRisk } from "../tool-risk-registry";

function mockServers(rows: unknown[]) {
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }),
      }),
    }),
  });
}

let prev: string | undefined;
beforeEach(() => {
  _clearToolCacheForTests();
  prev = process.env.ALL_AGENTS_ALL_TOOLS;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ALL_AGENTS_ALL_TOOLS;
  else process.env.ALL_AGENTS_ALL_TOOLS = prev;
});

describe("browser__task discovery", () => {
  it.each(["1", "0"])("resolves for an agent that never declared it (ALL_AGENTS_ALL_TOOLS=%s)", async (flag) => {
    process.env.ALL_AGENTS_ALL_TOOLS = flag;
    mockServers([]);
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    const bt = res.tools.find((t) => t.name === "browser__task");
    expect(bt).toBeDefined();
    expect(bt!.input_schema.required).toEqual(expect.arrayContaining(["goal", "start_url"]));
    expect(res.disconnected_connectors).not.toContain("browser");
  });

  it("exposes exactly ONE browser tool: no raw browser_* op is ever advertised", async () => {
    process.env.ALL_AGENTS_ALL_TOOLS = "1";
    mockServers([]);
    const res = await discoverToolsForTenant("t-1", []);
    const browserish = res.tools.map((t) => t.name).filter((n) => n.startsWith("browser"));
    expect(browserish).toEqual(["browser__task"]);
  });

  it("is a universal baseline tool but NOT in READ_BASELINE (egress policy)", () => {
    expect(UNIVERSAL_TOOL_BASELINE.has("browser__task")).toBe(true);
    expect(READ_BASELINE.has("browser__task")).toBe(false);
  });

  it("is declared a read: not ledgered as a side effect, risk class read", () => {
    expect(effectOf("browser", "task")).toBe("read");
    expect(isSideEffectingTool("browser", "task")).toBe(false);
    expect(classifyToolRisk("browser", "task")).toBe("read");
  });
});
