import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-key", () => ({ getComposioApiKey: () => "test-key" }));
vi.mock("@/services/mcp/streamable-guards", () => ({ assertStreamableUrlAllowed: vi.fn() }));

import { composioExecuteTool } from "./api";

afterEach(() => { vi.unstubAllGlobals(); });

async function execute(data: unknown, toolSlug = "TIKTOK_ADS_CREATE_SMART_PLUS_AD") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ successful: true, data }), { status: 200 })));
  return composioExecuteTool({ tool_slug: toolSlug, user_id: "tenant", connected_account_id: "account", arguments: {} });
}

describe("TikTok creation response handling", () => {
  it("does not report an ad created when a successful transport wraps a TikTok validation error", async () => {
    const refusal = { code: 40001, message: "Invalid creative", request_id: "request", data: {} };
    for (const data of [refusal, { data: refusal }]) {
      expect(await execute(data)).toMatchObject({ ok: false, error: "TikTok API 40001: Invalid creative", outcome_unknown: false });
    }
  });

  it("preserves uncertain outcomes for unrecognized codes so creation is not blindly repeated", async () => {
    expect(await execute({ code: 50000, message: "Internal error" })).toMatchObject({ ok: false, outcome_unknown: true });
  });

  it("rejects a nonzero vendor code even when its error message is missing", async () => {
    expect(await execute({ code: 50000 })).toMatchObject({
      ok: false, outcome_unknown: true, error: "TikTok API 50000: Request failed without an error message",
    });
  });

  it("preserves successful creation IDs and does not reinterpret another toolkit's fields", async () => {
    const data = { code: 0, message: "OK", data: { ad_id: "created-ad" } };
    expect(await execute(data)).toMatchObject({ ok: true, data, outcome_unknown: false });
    expect(await execute({ code: 40001, message: "A business field" }, "OTHER_GET_ITEM")).toMatchObject({ ok: true });
  });
});
