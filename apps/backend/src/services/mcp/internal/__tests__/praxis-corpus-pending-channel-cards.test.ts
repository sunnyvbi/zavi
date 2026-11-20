
import { describe, it, expect, vi } from "vitest";
import { callPraxisCorpusTool } from "../praxis-corpus";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));

const TENANT = "11111111-1111-1111-1111-111111111111";

type Result = { data: unknown; error: unknown };

function mkBuilder(result: Result, eqCalls: Array<[string, unknown]>) {
  const b: Record<string, unknown> = {};
  for (const k of ["select", "gte", "lte", "order"]) b[k] = vi.fn(() => b);
  b.eq = vi.fn((col: string, val: unknown) => {
    eqCalls.push([col, val]);
    return b;
  });
  b.limit = vi.fn(async () => result);
  return b;
}

function wire(tables: Record<string, Result>) {
  const eq: Record<string, Array<[string, unknown]>> = {};
  mocks.serviceClientMock.mockReturnValue({
    from: (table: string) => {
      if (!tables[table]) throw new Error(`unexpected table: ${table}`);
      eq[table] = [];
      return mkBuilder(tables[table], eq[table]);
    },
  });
  return eq;
}

const parse = (res: { content: string }) => JSON.parse(res.content) as Record<string, unknown>;

describe("query_pending_decisions — channel cards", () => {
  it("groups open channel cards by channel and names the page to approve them on", async () => {
    const eq = wire({
      decisions: { data: [], error: null },
      customer_visible_open_channel_actions: {
        data: [
          { channel_slug: "youtube_organic", title: "Offer: Up to 52% off" },
          { channel_slug: "youtube_organic", title: "Hook: That ₹194 an hour is not your total" },
          { channel_slug: "generated_video", title: "Explainer: Four things" },
        ],
        error: null,
      },
    });

    const out = parse((await callPraxisCorpusTool(TENANT, "query_pending_decisions", { days: 3, min_age_days: 0 })) as { content: string });

    expect(out.channel_cards).toEqual([
      { channel: "youtube_organic", where: "Channels → YouTube", open: 2, titles: ["Offer: Up to 52% off", "Hook: That ₹194 an hour is not your total"] },
      { channel: "generated_video", where: "Channels → AI UGC Videos", open: 1, titles: ["Explainer: Four things"] },
    ]);
    expect(eq.customer_visible_open_channel_actions).toContainEqual(["tenant_id", TENANT]);
  });

  it("a failed channel-card read still answers with the decisions", async () => {
    wire({
      decisions: { data: [], error: null },
      customer_visible_open_channel_actions: { data: null, error: { message: "boom" } },
    });
    const out = parse((await callPraxisCorpusTool(TENANT, "query_pending_decisions", {})) as { content: string });
    expect(out).toMatchObject({ rows: [], channel_cards: [] });
  });
});
