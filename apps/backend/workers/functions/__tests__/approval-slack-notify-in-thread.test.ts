import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => {
  const state: {
    scanRows: Array<Record<string, unknown>>;
    claimWins: boolean;
    slackThrows: boolean;
  } = { scanRows: [], claimWins: true, slackThrows: false };

  const slackFetch = vi.fn(
    async (_t: string, _method: string, _body: Record<string, unknown>, _team?: string) => {
      if (state.slackThrows) throw new Error("slack_api_error: channel_not_found");
      return { ts: "123.456" };
    },
  );

  const scanLimit = vi.fn(async () => ({ data: state.scanRows, error: null }));
  const scanNot = vi.fn(() => ({ limit: scanLimit }));
  const scanIs = vi.fn(() => ({ not: scanNot }));
  const scanEq4 = vi.fn(() => ({ is: scanIs }));
  const scanEq3 = vi.fn(() => ({ eq: scanEq4 }));
  const scanEq2 = vi.fn(() => ({ eq: scanEq3 }));
  const scanEq1 = vi.fn(() => ({ eq: scanEq2 }));
  const scanSelect = vi.fn(() => ({ eq: scanEq1 }));

  const claimSelect = vi.fn(async () => ({ data: state.claimWins ? [{ id: "x" }] : [] }));
  const claimIs = vi.fn(() => ({ select: claimSelect }));
  const claimEq = vi.fn(() => ({ is: claimIs }));
  const updateFn = vi.fn(() => ({ eq: claimEq }));

  const clsEq = vi.fn(async () => ({ data: [] as Array<{ slug: string }>, error: null }));
  const clsSelect = vi.fn(() => ({ eq: clsEq }));

  const fromFn = vi.fn((tbl: string) => {
    if (tbl === "decision_classes") return { select: clsSelect };
    return { select: scanSelect, update: updateFn };
  });
  const serviceClient = vi.fn(() => ({ from: fromFn }));

  return {
    state, slackFetch, serviceClient, fromFn,
    scanSelect, scanLimit, scanNot, updateFn, claimSelect, claimIs, claimEq,
  };
});

vi.mock("../client", () => ({
  inngest: { createFunction: (_c: unknown, _t: unknown, _f: unknown) => ({ id: "stub" }) },
}));
vi.mock("@/services/supabase", () => ({ serviceClient: m.serviceClient }));
vi.mock("@/services/slack/resolve-zavi-channel", () => ({
  resolveZaviChannel: vi.fn(async () => "C_PRAXIS"),
}));
vi.mock("@/services/tools/slack/_client", () => ({ slackFetch: m.slackFetch }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => true,
  getBoolSettingStrict: async () => true,
}));

import { postPendingApprovalBubblesForRun } from "../approval-slack-notify";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const RUN = "30000000-0000-0000-0000-000000000077";
const ROW = {
  id: "20000000-0000-0000-0000-000000000099",
  tenant_id: TENANT,
  decision_class: "meta_ads.resume_campaign",
  agent_run_id: RUN,
  body: {
    decision_evidence: {
      reason_text: "Resume the paused campaign",
      evidence: ["spend was capped"],
      alternatives_considered: [],
      reversibility: "reversible",
      blast_radius: "YELLOW",
      confidence: 0.8,
    },
  },
};

const ARGS = {
  tenant_id: TENANT,
  run_id: RUN,
  channel_id: "C_THREAD",
  thread_ts: "1700.0001",
  team_id: "T_SOURCE",
};

beforeEach(() => {
  m.state.scanRows = [ROW];
  m.state.claimWins = true;
  m.state.slackThrows = false;
  m.slackFetch.mockClear();
  m.updateFn.mockClear();
  m.claimSelect.mockClear();
});

describe("postPendingApprovalBubblesForRun", () => {
  it("posts the bubble INTO THE THREAD with team_id + JSON-stringified blocks, after claiming", async () => {
    const res = await postPendingApprovalBubblesForRun(ARGS);
    expect(res).toEqual({ posted: 1, failed: 0 });

    expect(m.slackFetch).toHaveBeenCalledTimes(1);
    const [tenant, method, body, team] = m.slackFetch.mock.calls[0];
    expect(tenant).toBe(TENANT);
    expect(method).toBe("chat.postMessage");
    expect(body.channel).toBe("C_THREAD");
    expect(body.thread_ts).toBe("1700.0001");
    expect(team).toBe("T_SOURCE");
    expect(typeof body.blocks).toBe("string");
    expect(
      JSON.parse(body.blocks as string).some((b: { type?: string }) => b.type === "actions"),
    ).toBe(true);

    expect(m.updateFn).toHaveBeenCalledTimes(1);
    expect(m.claimSelect).toHaveBeenCalledTimes(1);
  });

  it("guards on empty channel_id / thread_ts (no scan, no post)", async () => {
    expect(await postPendingApprovalBubblesForRun({ ...ARGS, channel_id: "" })).toEqual({ posted: 0, failed: 0 });
    expect(await postPendingApprovalBubblesForRun({ ...ARGS, thread_ts: "" })).toEqual({ posted: 0, failed: 0 });
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("does NOT post when the claim is lost (cron/retry already claimed it) — no double-post", async () => {
    m.state.claimWins = false;
    const res = await postPendingApprovalBubblesForRun(ARGS);
    expect(res).toEqual({ posted: 0, failed: 0 });
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("swallows a Slack post failure (never throws into the reply path)", async () => {
    m.state.slackThrows = true;
    const res = await postPendingApprovalBubblesForRun(ARGS);
    expect(res).toEqual({ posted: 0, failed: 1 });
  });

  it("RELEASES the claim on a post failure so the cron re-posts (B4 — no invisible bubble)", async () => {
    m.state.slackThrows = true;
    await postPendingApprovalBubblesForRun(ARGS);
    const calls = m.updateFn.mock.calls as unknown as Array<[{ slack_approval_posted_at?: unknown }]>;
    const releaseCall = calls.find((c) => c[0]?.slack_approval_posted_at === null);
    expect(releaseCall).toBeTruthy();
  });

  it("no-op when the run queued no pending-approval decisions", async () => {
    m.state.scanRows = [];
    const res = await postPendingApprovalBubblesForRun(ARGS);
    expect(res).toEqual({ posted: 0, failed: 0 });
    expect(m.slackFetch).not.toHaveBeenCalled();
  });

  it("never scans growth-page-only classes (cgo goal moves are approved on the Growth page)", async () => {
    m.state.scanRows = [];
    await postPendingApprovalBubblesForRun(ARGS);
    expect(m.scanNot).toHaveBeenCalledWith("decision_class", "in", '("cgo.dispatch-specialist")');
  });
});
