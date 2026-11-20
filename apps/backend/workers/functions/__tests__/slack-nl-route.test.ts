import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: { pending: Array<Record<string, unknown>>; narrow: number[] | null } = {
    pending: [
      { id: "d1", tenant_id: "t1", decision_class: "meta_ads.resume_campaign", agent_run_id: "r1", body: {} },
      { id: "d2", tenant_id: "t1", decision_class: "meta_ads.update_ad_set_budget", agent_run_id: "r1", body: { daily_budget_usd: 5 } },
    ],
    narrow: null,
  };
  const builder: Record<string, unknown> = {};
  for (const meth of ["select", "eq", "in", "limit"]) builder[meth] = vi.fn(() => builder);
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: state.pending, error: null });
  const from = vi.fn(() => builder);
  const serviceClient = vi.fn(() => ({ from }));

  const slackFetch = vi.fn(async () => ({ ts: "1" }));
  const narrowApprovalTargets = vi.fn(async () => state.narrow);
  const buildBubble = vi.fn((row: { id: string }) => ({ blocks: [{ type: "actions" }], fallback: `bubble ${row.id}` }));
  const loadAllowlistableSet = vi.fn(async () => new Set<string>());
  const loadDecisionHandlers = vi.fn(async () => new Map<string, string | null>());
  const buildBatchControlBlocks = vi.fn(() => [{ type: "actions", block_id: "praxis_batch_actions" }]);

  return { state, from, serviceClient, slackFetch, narrowApprovalTargets, buildBubble, loadAllowlistableSet, loadDecisionHandlers, buildBatchControlBlocks };
});

vi.mock("../client", () => ({ inngest: { createFunction: () => ({ id: "stub" }) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/approvals/slack-approval-nl", () => ({ narrowApprovalTargets: m.narrowApprovalTargets }));
vi.mock("@/services/approvals/slack-approval-blocks", () => ({ buildBatchControlBlocks: m.buildBatchControlBlocks }));
vi.mock("../approval-slack-notify", () => ({
  loadAllowlistableSet: m.loadAllowlistableSet,
  loadDecisionHandlers: m.loadDecisionHandlers,
  buildBubble: m.buildBubble,
}));

import { runSlackNlRoute } from "../slack-nl-route";

const BASE = {
  tenant_id: "t1",
  run_ids: ["r1"],
  thread_ts: "1700.1",
  channel_id: "C1",
  team_id: "T1",
  text: "approve the budget one",
};

beforeEach(() => {
  m.state.pending = [
    { id: "d1", tenant_id: "t1", decision_class: "meta_ads.resume_campaign", agent_run_id: "r1", body: {} },
    { id: "d2", tenant_id: "t1", decision_class: "meta_ads.update_ad_set_budget", agent_run_id: "r1", body: { daily_budget_usd: 5 } },
  ];
  m.state.narrow = null;
  m.slackFetch.mockClear();
  m.narrowApprovalTargets.mockClear();
  m.buildBubble.mockClear();
  m.buildBatchControlBlocks.mockClear();
});

function postedBubbleFallbacks(): string[] {
  return m.slackFetch.mock.calls
    .map((c) => ((c as unknown[])[2] as { text?: string; blocks?: string }))
    .filter((b) => typeof b.blocks === "string" && typeof b.text === "string" && b.text.startsWith("bubble "))
    .map((b) => b.text as string);
}

describe("runSlackNlRoute", () => {
  it("narrow picks one → re-posts ONLY that bubble, no batch card", async () => {
    m.state.narrow = [2];
    const res = await runSlackNlRoute(BASE);
    expect(res.reposted).toBe(1);
    expect(postedBubbleFallbacks()).toEqual(["bubble d2"]);
    expect(m.buildBatchControlBlocks).not.toHaveBeenCalled();
  });

  it("narrow → null re-posts ALL bubbles + batch card (single run, >1)", async () => {
    m.state.narrow = null;
    const res = await runSlackNlRoute(BASE);
    expect(res.reposted).toBe(2);
    expect(postedBubbleFallbacks()).toEqual(["bubble d1", "bubble d2"]);
    expect(m.buildBatchControlBlocks).toHaveBeenCalledTimes(1);
  });

  it("multi-run thread → NO batch card even when re-posting all", async () => {
    m.state.narrow = null;
    await runSlackNlRoute({ ...BASE, run_ids: ["r1", "r2"] });
    expect(m.buildBatchControlBlocks).not.toHaveBeenCalled();
  });

  it("narrow THROWS → falls back to re-posting all (never throws out)", async () => {
    m.narrowApprovalTargets.mockRejectedValueOnce(new Error("llm down"));
    const res = await runSlackNlRoute(BASE);
    expect(res.reposted).toBe(2);
  });

  it("no pending → note only, no bubbles, NO decide/apply ever", async () => {
    m.state.pending = [];
    const res = await runSlackNlRoute(BASE);
    expect(res.reposted).toBe(0);
    expect(postedBubbleFallbacks()).toEqual([]);
    expect(m.buildBubble).not.toHaveBeenCalled();
  });

  it("guards empty channel/thread/run_ids", async () => {
    expect(await runSlackNlRoute({ ...BASE, channel_id: "" })).toEqual({ reposted: 0 });
    expect(await runSlackNlRoute({ ...BASE, run_ids: [] })).toEqual({ reposted: 0 });
  });
});
