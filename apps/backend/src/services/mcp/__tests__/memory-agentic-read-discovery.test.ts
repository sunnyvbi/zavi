import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClientMock: vi.fn(),
  getBoolSetting: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: mocks.serviceClientMock,
}));

vi.mock("@/services/settings", () => ({
  getBoolSetting: mocks.getBoolSetting,
}));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";

beforeEach(() => {
  _clearToolCacheForTests();
  vi.clearAllMocks();
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
  });
  mocks.getBoolSetting.mockResolvedValue(false);
});

const TENANT_OFF = "00000000-0000-4000-8000-0000000000aa";
const TENANT_ON = "00000000-0000-4000-8000-0000000000bb";

function memoryToolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((t) => t.name).filter((n) => n.startsWith("memory__")).sort();
}

describe("memory agentic-read discovery gating", () => {
  it("flag OFF → only memory__search + memory__write advertised", async () => {
    mocks.getBoolSetting.mockImplementation(async (key: string) =>
      key === "memory_agentic_read_enabled" ? false : false,
    );
    const res = await discoverToolsForTenant(TENANT_OFF, ["memory__*"]);
    expect(memoryToolNames(res.tools)).toEqual(["memory__search", "memory__write"]);
  });

  it("flag ON → all four advertised (search + write + list_topics + read)", async () => {
    mocks.getBoolSetting.mockImplementation(async (key: string) =>
      key === "memory_agentic_read_enabled" ? true : false,
    );
    const res = await discoverToolsForTenant(TENANT_ON, ["memory__*"]);
    expect(memoryToolNames(res.tools)).toEqual([
      "memory__list_topics",
      "memory__read",
      "memory__search",
      "memory__write",
    ]);
  });
});
