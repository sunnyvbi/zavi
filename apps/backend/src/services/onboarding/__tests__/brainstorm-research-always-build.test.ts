import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({ messages: { create: createMock } }),
  hasAnthropicAuth: () => true,
  DEFAULT_FAST_MODEL: "claude-sonnet-4-6",
  cachedSystemBlock: (text: string) => ({ type: "text", text }),
}));

import { researchIdea } from "../brainstorm-research";

const IDEA = "A simple website for my Austin bakery with menu, hours and cake orders";

function text(s: string) {
  return { content: [{ type: "text", text: s }] };
}

describe("DEL-1323 B8: research synthesis for a website idea", () => {
  const savedKey = process.env.TAVILY_API_KEY;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
    vi.stubGlobal("fetch", fetchSpy);
    createMock.mockReset();
    createMock
      .mockResolvedValueOnce(text('<reply>{"queries":["austin bakery websites"]}</reply>'))
      .mockResolvedValueOnce(text('<reply>{"opening_message":"Cake orders are the money page. Pickup or delivery?"}</reply>'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedKey;
  });

  function synthSystem(): string {
    return createMock.mock.calls[1][0].system[0].text as string;
  }

  it("tells the synthesis that Zavi builds it when alwaysBuild is on", async () => {
    const landscape = await researchIdea(IDEA, { alwaysBuild: true });
    expect(landscape.opening_message).toMatch(/Cake orders/);
    expect(synthSystem()).toMatch(/ZAVI BUILDS IT/);
    expect(synthSystem()).toMatch(/Never tell the visitor to use one of them instead/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the old synthesis prompt without the option", async () => {
    await researchIdea(IDEA);
    expect(synthSystem()).not.toMatch(/ZAVI BUILDS IT/);
    expect(synthSystem().endsWith("Output NOTHING outside the tags.")).toBe(true);
  });
});
