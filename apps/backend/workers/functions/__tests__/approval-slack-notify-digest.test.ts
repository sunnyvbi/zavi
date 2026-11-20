import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: { channel: string | null } = { channel: "C_PRAXIS" };

  const claimedIds = new Set<string>();
  let lastEqId: string | null = null;

  const selectFn = vi.fn(async () => {
    const id = lastEqId ?? "";
    if (claimedIds.has(id)) return { data: [] as Array<{ id: string }>, error: null };
    claimedIds.add(id);
    return { data: [{ id }], error: null };
  });
  const isFn = vi.fn(() => ({ select: selectFn }));
  const eqFn = vi.fn((k: string, v: string) => {
    if (k === "id") lastEqId = v;
    return { is: isFn };
  });
  const updateFn = vi.fn(() => ({ eq: eqFn }));

  const clsEqFn = vi.fn(async () => ({ data: [] as Array<{ slug: string }>, error: null }));
  const clsSelectFn = vi.fn(() => ({ eq: clsEqFn }));

  const fromFn = vi.fn((tbl: string) => {
    if (tbl === "decision_classes") return { select: clsSelectFn };
    return { update: updateFn };
  });
  const rpcFn = vi.fn(async () => ({ data: null, error: null }));
  const serviceClient = vi.fn(() => ({ from: fromFn, rpc: rpcFn }));

  const resolveZaviChannel = vi.fn(async () => state.channel);
  const slackFetch = vi.fn(
    async (_t: string, _method: string, _body: Record<string, unknown>, _team?: string) => ({ ts: "1.2" }),
  );

  return {
    state,
    claimedIds,
    selectFn,
    isFn,
    eqFn,
    updateFn,
    clsEqFn,
    clsSelectFn,
    fromFn,
    rpcFn,
    serviceClient,
    resolveZaviChannel,
    slackFetch,
  };
});

vi.mock("../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, _f: unknown) => ({ id: "stub" }) },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/slack/resolve-zavi-channel", () => ({ resolveZaviChannel: m.resolveZaviChannel }));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => true,
  getBoolSettingStrict: async () => true,
}));

import { postApprovalBubblesBatch, type PendingApprovalRow } from "../approval-slack-notify";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const RUN = "30000000-0000-0000-0000-000000000077";

function pmRow(i: number, run = RUN): PendingApprovalRow {
  return {
    id: `dec-${i}`,
    tenant_id: TENANT,
    decision_class: "pm.needs_action",
    agent_run_id: run,
    body: { theme: `Theme ${i}`, exception_kind: "recurred", roadmap_id: `rm-${i}` },
  };
}

const enabled = () => Promise.resolve(true);
const disabled = () => Promise.resolve(false);

beforeEach(() => {
  m.state.channel = "C_PRAXIS";
  m.claimedIds.clear();
  m.selectFn.mockClear();
  m.isFn.mockClear();
  m.eqFn.mockClear();
  m.updateFn.mockClear();
  m.clsEqFn.mockClear();
  m.clsSelectFn.mockClear();
  m.fromFn.mockClear();
  m.rpcFn.mockClear();
  m.serviceClient.mockClear();
  m.resolveZaviChannel.mockClear();
  m.slackFetch.mockClear();
});

describe("postApprovalBubblesBatch — pm.needs_action digest grouping", () => {
  it("flag ON: 3 pm.needs_action rows sharing a run → ONE digest post + all 3 marked posted", async () => {
    const rows = [pmRow(1), pmRow(2), pmRow(3)];
    const res = await postApprovalBubblesBatch(rows, { isDigestEnabled: enabled });

    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(1);
    const body = posts[0][2] as { blocks?: string; text?: string };
    expect(typeof body.blocks).toBe("string");
    const s = body.blocks as string;
    expect(s).toContain("dec-1");
    expect(s).toContain("dec-2");
    expect(s).toContain("dec-3");

    expect(m.selectFn).toHaveBeenCalledTimes(3);
    expect(res.posted).toBe(3);
    expect(res.failed).toBe(0);
  });

  it("flag OFF: same 3 rows → 3 per-bubble posts (regression guard)", async () => {
    const rows = [pmRow(1), pmRow(2), pmRow(3)];
    const res = await postApprovalBubblesBatch(rows, { isDigestEnabled: disabled });

    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(3);
    expect(res.posted).toBe(3);
  });

  it("a non-pm class sharing the run is NOT folded into the digest", async () => {
    const other: PendingApprovalRow = {
      id: "eng-9",
      tenant_id: TENANT,
      decision_class: "engineer.ship-pr",
      agent_run_id: RUN,
      body: { decision_evidence: { reason_text: "ship", evidence: [], alternatives_considered: [], reversibility: "reversible", blast_radius: "GREEN", confidence: 0.9 } },
    };
    const rows = [pmRow(1), pmRow(2), other];
    await postApprovalBubblesBatch(rows, { isDigestEnabled: enabled });

    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(2);
  });

  it("a coalesced dispatch_died body is NOT folded into the digest — renders as its own per-bubble", async () => {
    const coalesced: PendingApprovalRow = {
      id: "dead-1",
      tenant_id: TENANT,
      decision_class: "pm.needs_action",
      agent_run_id: RUN,
      body: {
        coalesced: true,
        exception_kind: "dispatch_died",
        roadmap_id: null,
        rendered_markdown: "⚠️ *Engineer blocked by infrastructure.* 2 work items could not run.",
      },
    };
    const rows = [pmRow(1), pmRow(2), coalesced];
    await postApprovalBubblesBatch(rows, { isDigestEnabled: enabled });

    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(2);
    const allBlocks = posts.map((p) => (p[2] as { blocks?: string }).blocks ?? "").join("\n");
    expect(allBlocks).toContain("Engineer blocked by infrastructure");
    expect(allBlocks).not.toContain("(untitled)");
  });

  it("a stuck_rollup body is NOT folded into the digest either", async () => {
    const rollup: PendingApprovalRow = {
      id: "stuck-1",
      tenant_id: TENANT,
      decision_class: "pm.needs_action",
      agent_run_id: RUN,
      body: {
        stuck_rollup: true,
        exception_kind: "stuck",
        roadmap_id: null,
        rendered_markdown: "🕒 *2 fixes stuck in review.*",
      },
    };
    const rows = [pmRow(1), pmRow(2), rollup];
    await postApprovalBubblesBatch(rows, { isDigestEnabled: enabled });
    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(2);
  });

  it("a single pm.needs_action row is NOT digested (group size 1 → per-bubble)", async () => {
    const res = await postApprovalBubblesBatch([pmRow(1)], { isDigestEnabled: enabled });
    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(1);
    expect(res.posted).toBe(1);
  });

  it("pm.needs_action rows in DIFFERENT runs are not grouped together", async () => {
    const rows = [pmRow(1, "runA"), pmRow(2, "runA"), pmRow(3, "runB"), pmRow(4, "runB")];
    await postApprovalBubblesBatch(rows, { isDigestEnabled: enabled });
    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(2);
  });

  it("idempotency: a second cron cycle over the same rows re-posts NOTHING (invariant 4)", async () => {
    const rows = [pmRow(1), pmRow(2), pmRow(3)];
    await postApprovalBubblesBatch(rows, { isDigestEnabled: enabled });
    m.slackFetch.mockClear();
    const res2 = await postApprovalBubblesBatch(rows, { isDigestEnabled: enabled });
    const posts = m.slackFetch.mock.calls.filter((c) => (c[1] as string) === "chat.postMessage");
    expect(posts.length).toBe(0);
    expect(res2.posted).toBe(0);
  });
});
