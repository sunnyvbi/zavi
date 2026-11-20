import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

import { discoverToolsForTenant, _clearToolCacheForTests } from "../discovery";

let prev: string | undefined;
beforeEach(() => {
  _clearToolCacheForTests();
  prev = process.env.ALL_AGENTS_ALL_TOOLS;
  mocks.serviceClientMock.mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) }),
  });
});
afterEach(() => {
  if (prev === undefined) delete process.env.ALL_AGENTS_ALL_TOOLS;
  else process.env.ALL_AGENTS_ALL_TOOLS = prev;
});

describe("card tools discovery", () => {
  it.each(["1", "0"])("an agent that never declared them still gets both (ALL_AGENTS_ALL_TOOLS=%s)", async (flag) => {
    process.env.ALL_AGENTS_ALL_TOOLS = flag;
    const res = await discoverToolsForTenant("t-1", ["memory__search"]);
    const names = res.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["praxis__show_card", "praxis__list_open_cards"]));
    expect(res.disconnected_connectors).not.toContain("praxis");
  });
});
