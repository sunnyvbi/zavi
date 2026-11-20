import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveOpenEngineerPrsForSlackThread,
  buildSlackFollowupRunPayload,
  handleSlackEngineerFollowup,
} from "../slack-pr-followup";
import { vi } from "vitest";
import { classifyFollowupCandidates, type OpenEngineerPr } from "../chat-pr-followup";

vi.mock("../pr-nonpush-answer", () => ({
  answerNonPushFollowup: vi.fn(async ({ text }: { text: string }) =>
    /\b(fixed|merged|shipped|status|done|another agent|did it)\b/i.test(text)
      ? "These are mine, not another agent's. #460 open; #461 already merged."
      : null,
  ),
}));

function makeSvc(byTable: Record<string, unknown[]>): SupabaseClient {
  return {
    from(table: string) {
      const data = byTable[table] ?? [];
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "filter", "order", "limit", "in"]) {
        chain[m] = () => chain;
      }
      (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        resolve({ data, error: null });
      return chain;
    },
  } as unknown as SupabaseClient;
}

const THREAD = "1781480746.808779";
const CHAN = "D0B448H4PKP";
const TEAM = "T0A8X9ZGPQ9";

const openerRun = {
  id: "run-opener",
  payload: { slack: { thread_ts: THREAD, channel_id: CHAN, team_id: TEAM }, slack_handoff_child: true },
  parsed: {
    pr_number: 460,
    pr_repo: "rravi149/upcar-private",
    pr_url: "https://github.com/rravi149/upcar-private/pull/460",
    pr_head_branch: "engineer/upcar-private-booking-auto-capture",
  },
};
const actedDecision = { id: "dec-1", agent_run_id: "run-opener", status: "acted" };

describe("deriveOpenEngineerPrsForSlackThread", () => {
  it("returns the open PR for a handoff-child opener + acted ship-pr decision", async () => {
    const svc = makeSvc({ agent_runs: [openerRun], decisions: [actedDecision] });
    const prs = await deriveOpenEngineerPrsForSlackThread({
      svc, tenant_id: "t1", team_id: TEAM, channel_id: CHAN, thread_ts: THREAD,
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      pr_number: 460,
      pr_repo: "rravi149/upcar-private",
      head_branch: "engineer/upcar-private-booking-auto-capture",
      run_id: "run-opener",
      decision_id: "dec-1",
    });
  });

  it("ignores a run from a DIFFERENT workspace (team_id mismatch)", async () => {
    const otherTeamRun = {
      ...openerRun,
      payload: { slack: { thread_ts: THREAD, channel_id: CHAN, team_id: "T_OTHER" } },
    };
    const svc = makeSvc({ agent_runs: [otherTeamRun], decisions: [actedDecision] });
    const prs = await deriveOpenEngineerPrsForSlackThread({
      svc, tenant_id: "t1", team_id: TEAM, channel_id: CHAN, thread_ts: THREAD,
    });
    expect(prs).toHaveLength(0);
  });

  it("REJECTS a run with NO team_id when source_team_id is known (bleed guard)", async () => {
    const noTeamRun = {
      ...openerRun,
      payload: { slack: { thread_ts: THREAD, channel_id: CHAN } },
    };
    const svc = makeSvc({ agent_runs: [noTeamRun], decisions: [actedDecision] });
    const prs = await deriveOpenEngineerPrsForSlackThread({
      svc, tenant_id: "t1", team_id: TEAM, channel_id: CHAN, thread_ts: THREAD,
    });
    expect(prs).toHaveLength(0);
  });

  it("falls back to channel-only when caller has NO team_id", async () => {
    const noTeamRun = {
      ...openerRun,
      payload: { slack: { thread_ts: THREAD, channel_id: CHAN } },
    };
    const svc = makeSvc({ agent_runs: [noTeamRun], decisions: [actedDecision] });
    const prs = await deriveOpenEngineerPrsForSlackThread({
      svc, tenant_id: "t1", channel_id: CHAN, thread_ts: THREAD,
    });
    expect(prs).toHaveLength(1);
  });

  it("skips a run missing pr_head_branch (pre-DEL-318 PR — not a safe push target)", async () => {
    const noBranchRun = {
      ...openerRun,
      parsed: { pr_number: 460, pr_repo: "rravi149/upcar-private", pr_url: "https://x/pull/460" },
    };
    const svc = makeSvc({ agent_runs: [noBranchRun], decisions: [actedDecision] });
    const prs = await deriveOpenEngineerPrsForSlackThread({
      svc, tenant_id: "t1", team_id: TEAM, channel_id: CHAN, thread_ts: THREAD,
    });
    expect(prs).toHaveLength(0);
  });

  it("ignores proposed/approved decisions (only acted/dispatched opened a PR)", async () => {
    const svc = makeSvc({
      agent_runs: [openerRun],
      decisions: [{ id: "dec-x", agent_run_id: "run-opener", status: "proposed" }],
    });
    const prs = await deriveOpenEngineerPrsForSlackThread({
      svc, tenant_id: "t1", channel_id: CHAN, thread_ts: THREAD,
    });
    expect(prs).toHaveLength(1);
  });

  it("returns BOTH when the thread has two distinct open PRs (→ classify clarifies)", async () => {
    const second = {
      id: "run-2",
      payload: { slack: { thread_ts: THREAD, channel_id: CHAN, team_id: TEAM } },
      parsed: {
        pr_number: 461,
        pr_repo: "rravi149/upcar-private",
        pr_url: "https://github.com/rravi149/upcar-private/pull/461",
        pr_head_branch: "engineer/second-change",
      },
    };
    const svc = makeSvc({
      agent_runs: [openerRun, second],
      decisions: [actedDecision, { id: "dec-2", agent_run_id: "run-2", status: "dispatched" }],
    });
    const prs = await deriveOpenEngineerPrsForSlackThread({
      svc, tenant_id: "t1", team_id: TEAM, channel_id: CHAN, thread_ts: THREAD,
    });
    expect(prs).toHaveLength(2);
    expect(classifyFollowupCandidates({ message: "also add X", openPrs: prs }).action).toBe(
      "clarify",
    );
  });
});

describe("buildSlackFollowupRunPayload", () => {
  const pr: OpenEngineerPr = {
    decision_id: "dec-1",
    run_id: "run-opener",
    pr_number: 460,
    pr_repo: "rravi149/upcar-private",
    pr_url: "https://github.com/rravi149/upcar-private/pull/460",
    head_branch: "engineer/upcar-private-booking-auto-capture",
  };
  const slackPayload = { channel_id: CHAN, thread_ts: THREAD, team_id: TEAM, text: "you forgot the .js files" };

  it("carries the server-derived follow-up contract + preserves payload.slack", () => {
    const p = buildSlackFollowupRunPayload({ pr, instruction: "you forgot the .js files", slackPayload });
    expect(p).toMatchObject({
      kind: "engineer_pr_followup",
      checkout_ref: "engineer/upcar-private-booking-auto-capture",
      target_pr_number: 460,
      target_pr_repo: "rravi149/upcar-private",
      target_pr_url: "https://github.com/rravi149/upcar-private/pull/460",
      source: "slack",
      instruction: "you forgot the .js files",
      slack: slackPayload,
    });
  });

  it("NEVER sets thread_id (runner would treat it as an agent_threads.id → chat plumbing)", () => {
    const p = buildSlackFollowupRunPayload({ pr, instruction: "x", slackPayload });
    expect("thread_id" in p).toBe(false);
  });
});

describe("handleSlackEngineerFollowup (orchestration + run_id guard)", () => {
  const baseArgs = {
    tenant_id: "t1",
    team_id: TEAM,
    channel_id: CHAN,
    thread_ts: THREAD,
    original_ts: "1781480700.000000",
    event_id: "Ev123",
    text: "you forgot the .js files",
  };

  it("route → enqueues engineer slack run with the followup payload + posts, handled:true", async () => {
    const svc = makeSvc({ agent_runs: [openerRun], decisions: [actedDecision] });
    const enqueueAgentRun = vi.fn().mockResolvedValue({ run_id: "new-run-1" });
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const r = await handleSlackEngineerFollowup({ svc, enqueueAgentRun, postMessage }, baseArgs);
    expect(r).toEqual({ handled: true, action: "route", target_pr_number: 460 });
    expect(enqueueAgentRun).toHaveBeenCalledTimes(1);
    const call = enqueueAgentRun.mock.calls[0][0];
    expect(call).toMatchObject({
      agent_slug: "engineer",
      trigger: "slack",
      cron_dedupe_key: "slack:Ev123",
    });
    expect(call.payload).toMatchObject({
      kind: "engineer_pr_followup",
      checkout_ref: "engineer/upcar-private-booking-auto-capture",
      target_pr_number: 460,
      source: "slack",
    });
    expect(call.payload.slack).toMatchObject({ channel_id: CHAN, thread_ts: THREAD, event_id: "Ev123", team_id: TEAM });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toContain("PR #460");
  });

  it("run_id==='' (dedupe-drop) → handled:false, NO post (no false 'On it')", async () => {
    const svc = makeSvc({ agent_runs: [openerRun], decisions: [actedDecision] });
    const enqueueAgentRun = vi.fn().mockResolvedValue({ run_id: "" });
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const r = await handleSlackEngineerFollowup({ svc, enqueueAgentRun, postMessage }, baseArgs);
    expect(r.handled).toBe(false);
    expect(r.action).toBe("dedupe_drop");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("skip (no open PR) → handled:false, no enqueue, no post", async () => {
    const svc = makeSvc({ agent_runs: [], decisions: [] });
    const enqueueAgentRun = vi.fn().mockResolvedValue({ run_id: "x" });
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const r = await handleSlackEngineerFollowup({ svc, enqueueAgentRun, postMessage }, baseArgs);
    expect(r).toEqual({ handled: false, action: "skip" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  const secondPr = {
    id: "run-2",
    payload: { slack: { thread_ts: THREAD, channel_id: CHAN, team_id: TEAM } },
    parsed: { pr_number: 461, pr_repo: "rravi149/upcar-private", pr_url: "https://x/pull/461", pr_head_branch: "engineer/second" },
  };
  const twoPrSvc = () =>
    makeSvc({
      agent_runs: [openerRun, secondPr],
      decisions: [actedDecision, { id: "dec-2", agent_run_id: "run-2", status: "dispatched" }],
    });

  it("status/provenance question (2 open PRs) → posts live-state answer, action 'answer', NO enqueue (push-impossible)", async () => {
    const enqueueAgentRun = vi.fn().mockResolvedValue({ run_id: "x" });
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const r = await handleSlackEngineerFollowup(
      { svc: twoPrSvc(), enqueueAgentRun, postMessage },
      { ...baseArgs, text: "is this issue fixed by some other agent already or not?" },
    );
    expect(r).toEqual({ handled: true, action: "answer" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toMatch(/not another agent/i);
    expect(postMessage.mock.calls[0][0].text).toMatch(/#461 already merged/i);
  });

  it("change-shaped non-status turn (2 open PRs) → skip (falls through to real engineer), NO canned clarify, NO post, NO enqueue", async () => {
    const enqueueAgentRun = vi.fn().mockResolvedValue({ run_id: "x" });
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const r = await handleSlackEngineerFollowup(
      { svc: twoPrSvc(), enqueueAgentRun, postMessage },
      { ...baseArgs, text: "also tweak the header" },
    );
    expect(r).toEqual({ handled: false, action: "skip" });
    expect(enqueueAgentRun).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
