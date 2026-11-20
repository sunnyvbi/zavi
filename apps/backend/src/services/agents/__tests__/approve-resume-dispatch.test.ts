import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  resumeAfterDecision,
  type ResumeEnqueue,
} from "../approve-resume-dispatch";
import { PAUSED_AWAITING_APPROVAL } from "../approve-resume";
const stamp = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/services/channels/direct-run", () => ({ stampDirectChannelRunWithin: stamp }));

function makeSvc(cfg: {
  read?: { data?: unknown; error?: { message: string } | null };
  flip?: { error?: { message: string } | null };
  term?: { data?: unknown; error?: { message: string } | null };
  ins?: { data?: unknown; error?: { message: string } | null };
  cont?: { data?: unknown; error?: { message: string } | null };
}) {
  let mode: "read" | "update" = "read";
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.from = () => b;
  b.select = () => b;
  b.insert = () => b;
  b.update = () => {
    mode = "update";
    return b;
  };
  b.eq = chain;
  b.in = chain;
  b.limit = () => Promise.resolve(cfg.cont ?? { data: [], error: null });
  b.single = () =>
    Promise.resolve(cfg.ins ?? { data: { id: "umsg_new" }, error: null });
  b.maybeSingle = () =>
    mode === "update"
      ? Promise.resolve(cfg.term ?? { data: null, error: null })
      : Promise.resolve(cfg.read ?? { data: null, error: null });
  b.then = (onF: (v: unknown) => unknown) =>
    Promise.resolve(cfg.flip ?? { error: null }).then(onF);
  return b as never;
}

const chatPausedRow = {
  id: "run_paused",
  status: PAUSED_AWAITING_APPROVAL,
  trigger: "chat",
  agent_slug: "engineer",
  payload: { thread_id: "th_chat", task_description: "ship it" },
  tenant_id: "t1",
};

const pausedRow = {
  id: "run_paused",
  status: PAUSED_AWAITING_APPROVAL,
  trigger: "slack",
  agent_slug: "support-lead",
  payload: { thread_id: "th_1", slack: { channel: "C1" } },
  tenant_id: "t1",
};

describe("approve-resume-dispatch — resumeAfterDecision", () => {
  let enqueue: ReturnType<typeof vi.fn> & ResumeEnqueue;
  beforeEach(() => {
    enqueue = vi.fn().mockResolvedValue({ run_id: "cont_1" }) as ReturnType<
      typeof vi.fn
    > &
      ResumeEnqueue;
  });

  it("no-ops with no run", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: null, approved: true, toolName: "x" },
      { enqueue, svc: makeSvc({}) },
    );
    expect(r).toEqual({ resumed: false, reason: "no_run" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("DRAINS an already-paused run even when the flag is OFF", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      { enqueue, svc: makeSvc({ read: { data: pausedRow } }) },
    );
    expect(r.resumed).toBe(true);
    expect(r.reason).toBe("resumed");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("never reports the retired flag_off reason", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      { enqueue, svc: makeSvc({ read: { data: pausedRow } }) },
    );
    expect(r.reason).not.toBe("flag_off");
  });

  it("no-ops when the run is not paused (never paused / already resolved)", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      {
        enqueue,
        svc: makeSvc({ read: { data: { ...pausedRow, status: "success" } } }),
      },
    );
    expect(r).toEqual({ resumed: false, reason: "not_paused" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reports still_running when the approval landed before the run finished", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      { enqueue, svc: makeSvc({ read: { data: { ...chatPausedRow, status: "running" } } }) },
    );
    expect(r).toEqual({ resumed: false, reason: "still_running" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("allowFinished: resumes a chat run that ended 'success' with the tool result", async () => {
    const r = await resumeAfterDecision(
      {
        tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "composio.execute_tool",
        outcome: 'Mixpanel returned: {"signup":120}', allowFinished: true,
      },
      { enqueue, svc: makeSvc({ read: { data: { ...chatPausedRow, status: "success" } } }) },
    );
    expect(r.reason).toBe("resumed");
    const payload = (enqueue.mock.calls[0] as unknown[])[0] as { payload: Record<string, unknown> };
    expect(payload.payload.internal_resume_turn).toContain('{"signup":120}');
    expect(payload.payload.resume_of_run_id).toBe("run_paused");
  });

  it("allowFinished: never a second continuation, never a non-chat run", async () => {
    const done = { ...chatPausedRow, status: "success" };
    const args = { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x", allowFinished: true };
    expect(
      await resumeAfterDecision(args, { enqueue, svc: makeSvc({ read: { data: done }, cont: { data: [{ id: "c" }] } }) }),
    ).toEqual({ resumed: false, reason: "not_paused" });
    expect(
      await resumeAfterDecision(args, { enqueue, svc: makeSvc({ read: { data: { ...done, trigger: "slack" } } }) }),
    ).toEqual({ resumed: false, reason: "not_paused" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("APPROVE: enqueues a continuation on the same thread with the approved turn", async () => {
    const r = await resumeAfterDecision(
      {
        tenant_id: "t1",
        agent_run_id: "run_paused",
        approved: true,
        toolName: "stripe__charge",
        outcome: "charge ok",
      },
      { enqueue, svc: makeSvc({ read: { data: pausedRow } }) },
    );
    expect(r.resumed).toBe(true);
    expect(r.run_id).toBe("cont_1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0] as {
      agent_slug: string;
      tenant_id: string;
      trigger: string;
      payload: Record<string, any>;
    };
    expect(input.agent_slug).toBe("support-lead");
    expect(input.tenant_id).toBe("t1");
    expect(input.trigger).toBe("slack");
    expect(input.payload.thread_id).toBe("th_1");
    expect(input.payload.slack).toEqual({ channel: "C1" });
    expect(input.payload.resume_of_run_id).toBe("run_paused");
    expect(input.payload.user_message).toContain("approved and executed");
    expect(input.payload.user_message).toContain("charge ok");
  });

  it("an approval-paused Slack ask child resumes as the child: marker kept, ask correlation dropped", async () => {
    const askChild = {
      ...pausedRow,
      id: "child_paused",
      agent_slug: "seo",
      payload: {
        slack: { channel_id: "C1", thread_ts: "1.0", event_id: "Ev1" },
        slack_handoff_child: true,
        ask_id: "ask-1",
        ask_parent_run_id: "parent-1",
        ask_depth: 1,
      },
    };
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "child_paused", approved: true, toolName: "x" },
      { enqueue, svc: makeSvc({ read: { data: askChild, error: null } }) },
    );
    expect(r.resumed).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = enqueue.mock.calls[0][0];
    expect(call.trigger).toBe("slack");
    expect(call.payload).toMatchObject({ slack_handoff_child: true, resume_of_run_id: "child_paused" });
    expect(call.payload.ask_id).toBeUndefined();
  });

  it("REJECT: enqueues a continuation with the NOT-approved turn", async () => {
    const r = await resumeAfterDecision(
      {
        tenant_id: "t1",
        agent_run_id: "run_paused",
        approved: false,
        toolName: "slack__post",
      },
      { enqueue, svc: makeSvc({ read: { data: pausedRow } }) },
    );
    expect(r.resumed).toBe(true);
    const input = enqueue.mock.calls[0][0] as {
      agent_slug: string;
      tenant_id: string;
      trigger: string;
      payload: Record<string, any>;
    };
    expect(input.payload.user_message).toContain("was NOT approved");
    expect(input.payload.user_message.toLowerCase()).toContain("do not retry");
  });

  it("FAIL-OPEN: a read error never throws — returns reason:error", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      {
        enqueue,
        svc: makeSvc({ read: { error: { message: "db down" } } }),
      },
    );
    expect(r.resumed).toBe(false);
    expect(r.reason).toBe("error");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("CHAT resume: keeps the internal turn on the run payload without minting a visible user row", async () => {
    const r = await resumeAfterDecision(
      {
        tenant_id: "t1",
        agent_run_id: "run_paused",
        approved: true,
        toolName: "github__open_pr",
        outcome: "opened PR #46",
      },
      { enqueue, svc: makeSvc({ read: { data: chatPausedRow } }) },
    );
    expect(r.resumed).toBe(true);
    const input = enqueue.mock.calls[0][0] as {
      trigger: string;
      payload: Record<string, any>;
    };
    expect(input.trigger).toBe("chat");
    expect(input.payload.user_message_id).toBeUndefined();
    expect(input.payload.thread_id).toBe("th_chat");
    expect(input.payload.user_message).toBeUndefined();
    expect(input.payload.internal_resume_turn).toContain("approved and executed");
  });

  it("CHAT resume: does not depend on an agent_thread_messages insert", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "github__open_pr" },
      {
        enqueue,
        svc: makeSvc({
          read: { data: chatPausedRow },
          ins: { data: null, error: { message: "insert failed" } },
        }),
      },
    );
    expect(r.resumed).toBe(true);
    expect(r.reason).toBe("resumed");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("still reports resumed when the flip errors (continuation already enqueued)", async () => {
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      {
        enqueue,
        svc: makeSvc({ read: { data: pausedRow }, flip: { error: { message: "flip failed" } } }),
      },
    );
    expect(r.resumed).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("approve-resume-dispatch — staff ?model= inheritance", () => {
  it("the continuation is enqueued with parent_run_id = the paused run (drives inheritance)", async () => {
    const enqueue = vi.fn().mockResolvedValue({ run_id: "cont_1" });
    await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      { enqueue, svc: makeSvc({ read: { data: { ...pausedRow, payload: { ...pausedRow.payload, staff_model: { key: "qwen" } } } } }) },
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ parent_run_id: "run_paused" }));
  });

  it("cap refusal → no continuation, and the paused row is NOT flipped (stays paused)", async () => {
    const { StaffModelCapError } = await import("../staff-model-inherit");
    const enqueue = vi.fn().mockRejectedValue(new StaffModelCapError(200, 200));
    const svc = makeSvc({ read: { data: pausedRow } }) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const realUpdate = svc.update;
    const updates: unknown[] = [];
    svc.update = (patch: unknown) => {
      updates.push(patch);
      return realUpdate(patch);
    };
    const r = await resumeAfterDecision(
      { tenant_id: "t1", agent_run_id: "run_paused", approved: true, toolName: "x" },
      { enqueue, svc: svc as never },
    );
    expect(r.resumed).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

it.each(["linkedin_organic", "x_ads", "tiktok_organic", "tiktok_ads", "chatgpt_ads", "instagram_organic", "x_organic"])("%s continuation installs a pre-dispatch channel stamp hook", async slug => {
  const enqueue = vi.fn().mockResolvedValue({ run_id: "child" });
  const result = await resumeAfterDecision({ tenant_id: "t1", agent_run_id: "parent", approved: true, toolName: "example" }, {
    enqueue,
    svc: makeSvc({ read: { data: { ...chatPausedRow, agent_slug: slug, channel_slug: slug } } }),
  });
  expect(result.resumed).toBe(true);
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ parent_run_id: "run_paused", before_dispatch: expect.any(Function) }));
  await enqueue.mock.calls[0][0].before_dispatch("child");
  expect(stamp).toHaveBeenLastCalledWith("t1", "child", slug);
});
