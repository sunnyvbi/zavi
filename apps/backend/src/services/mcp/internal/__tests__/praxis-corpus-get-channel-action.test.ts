
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/services/channels/card-context", () => ({ resolveChannelAction: mocks.resolve }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { callPraxisCorpusTool, listPraxisCorpusTools } from "../praxis-corpus";

const TENANT = "11111111-1111-4111-8111-111111111111";
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

beforeEach(() => { mocks.resolve.mockReset(); });

describe("praxis_corpus.get_channel_action", () => {
  it("is registered", () => {
    expect(listPraxisCorpusTools().map((t) => t.tool_name)).toContain("get_channel_action");
  });

  it("looks a title up for the CALLING tenant and returns every status", async () => {
    mocks.resolve.mockResolvedValue({ matches: [{ id: "x", status: "acted", title: "T" }], total: 1 });
    const out = parse((await callPraxisCorpusTool(TENANT, "get_channel_action", { title: "T", channel: "meta_ads" })) as { content: string });
    expect(mocks.resolve).toHaveBeenCalledWith(TENANT, { title: "T", channel_slug: "meta_ads" });
    expect(out).toEqual({ found: true, total: 1, cards: [{ id: "x", status: "acted", title: "T" }] });
  });

  it("an id wins over a title", async () => {
    mocks.resolve.mockResolvedValue({ matches: [], total: 0 });
    await callPraxisCorpusTool(TENANT, "get_channel_action", { id: "abc", title: "T" });
    expect(mocks.resolve).toHaveBeenCalledWith(TENANT, { id: "abc" });
  });

  it("refuses a call with neither id nor title", async () => {
    const r = (await callPraxisCorpusTool(TENANT, "get_channel_action", {})) as { is_error: boolean; content: string };
    expect(r.is_error).toBe(true);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("a read failure is a tool error, not a crash", async () => {
    mocks.resolve.mockImplementation(async () => {
      throw new Error("db down");
    });
    const r = (await callPraxisCorpusTool(TENANT, "get_channel_action", { title: "T" })) as { is_error: boolean; content: string };
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: "praxis_corpus_query_failed" });
  });
});
