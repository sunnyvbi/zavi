import { describe, it, expect, vi, beforeEach } from "vitest";

const logSpy = vi.fn();
let searchOk = false;

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: (...args: unknown[]) => {
    logSpy(...args);
    return Promise.resolve();
  },
}));

vi.mock("@/services/mcp/internal/web-search", () => ({
  callWebSearchTool: vi.fn(async () =>
    searchOk
      ? { ok: true, is_error: false, content: JSON.stringify({ answer: "", results: [] }), ms: 1 }
      : {
          ok: false,
          is_error: true,
          content: JSON.stringify({ error: "web_search_auth_failed", message: "Tavily auth failed (401)." }),
          ms: 1,
        },
  ),
}));

vi.mock("@/services/anthropic", () => ({
  DEFAULT_FAST_MODEL: "claude-haiku-test",
  cachedSystemBlock: (text: string) => ({ type: "text", text }),
  hasAnthropicAuth: () => true,
  getAnthropic: () => ({
    messages: {
      create: async () => ({
        content: [{ type: "text", text: '<queries_json>{"category":"x","queries":["alpha co competitors","beta alternatives"]}</queries_json>' }],
      }),
    },
  }),
}));

import { findCompetitors } from "../competitors";

describe("findCompetitors observability", () => {
  beforeEach(() => logSpy.mockClear());

  it("logs web_search_no_results with the failure reason when every search fails", async () => {
    searchOk = false;
    const out = await findCompetitors("Acme", "acme.io", "Acme sells widgets.");
    expect(out).toEqual([]);
    const call = logSpy.mock.calls.map((c) => c[0]).find((a) => a?.code === "web_search_no_results");
    expect(call).toBeTruthy();
    expect(call.source).toBe("onboarding.competitors");
    expect(call.message).toContain("web_search_auth_failed");
    expect(call.message).toContain("domain=acme.io");
    expect(call.message).not.toContain("widgets");
  });

  it("logs no_competitors_extracted when search returns but nothing survives", async () => {
    searchOk = true;
    const out = await findCompetitors("Acme", "acme.io", "ctx");
    expect(out).toEqual([]);
    const call = logSpy.mock.calls.map((c) => c[0]).find((a) => a?.code === "no_competitors_extracted");
    expect(call).toBeTruthy();
    expect(call.message).toContain("domain=acme.io");
  });
});
