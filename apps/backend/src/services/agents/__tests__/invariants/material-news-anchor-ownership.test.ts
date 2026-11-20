
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  judgeFindings: [] as unknown[],
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/services/agents/budget", () => ({
  resolveDailyCapUsd: vi.fn(async () => 0),
  consumeBudgetOrReject: vi.fn(async () => true),
}));
vi.mock("@/services/material-news/topics", () => ({
  MAX_TOPICS: 8,
  MIN_ANCHORS_FOR_TOPICS: 2,
  getOrRefreshTopics: vi.fn(async () => ["p2p car rental"]),
  loadAnchors: vi.fn(async () => [
    { id: "A1", title: "market", body: "", created_at: "2026-01-01T00:00:00Z" },
    { id: "A2", title: "regulator", body: "", created_at: "2026-01-01T00:00:00Z" },
  ]),
}));
vi.mock("@/services/mcp/internal/web-search", () => ({
  callWebSearchTool: vi.fn(async () => ({
    is_error: false,
    content: JSON.stringify({
      results: [{ title: "t", url: "https://x/y", snippet: "s", published_date: new Date().toISOString() }],
    }),
  })),
}));
vi.mock("@/services/mcp/internal/web_fetch", () => ({
  callWebFetchTool: vi.fn(async () => ({ is_error: false, content: JSON.stringify({ capture: "ok", body_text: "b" }) })),
}));
vi.mock("@/services/anthropic", () => ({
  getAnthropic: () => ({
    messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({ findings: h.judgeFindings }) }] })) },
  }),
  heliconePropertyHeaders: () => ({}),
}));
function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "order", "limit", "maybeSingle", "gte", "lt", "in", "delete", "update"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.insert = vi.fn(() => ({ then: (r: (v: unknown) => unknown) => r({ error: null }) }));
  chain.upsert = vi.fn((obj: Record<string, unknown>) => {
    if (table === "news_findings") h.upserts.push(obj);
    return { then: (r: (v: unknown) => unknown) => r({ error: null }) };
  });
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
  return chain;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (x: string) => x,
  tenantClient: () => ({ from: (t: string) => chainFor(t) }),
}));

import { scanTenant } from "@/services/material-news/scan";

beforeEach(() => {
  h.judgeFindings = [];
  h.upserts = [];
});

describe("INVARIANT: material-news anchor ownership", () => {
  it("drops a verdict whose anchor_id is not this tenant's anchor", async () => {
    h.judgeFindings = [{ n: 0, anchor_id: "SOME-OTHER-TENANT-ANCHOR", score: 0.99, why: "x", headline: "h" }];
    await scanTenant({ id: "22222222-2222-4222-8222-222222222222" });
    expect(h.upserts).toHaveLength(0);
  });

  it("keeps a verdict grounded in an owned anchor", async () => {
    h.judgeFindings = [{ n: 0, anchor_id: "A1", score: 0.9, why: "x", headline: "h" }];
    await scanTenant({ id: "22222222-2222-4222-8222-222222222222" });
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].anchor_id).toBe("A1");
  });
});
