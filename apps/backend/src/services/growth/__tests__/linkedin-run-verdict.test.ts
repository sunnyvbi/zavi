import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  readError: null as { message: string } | null,
  run: null as Record<string, unknown> | null,
  rpc: vi.fn(),
  approve: vi.fn(),
  alert: vi.fn(),
  filters: [] as Array<[string, unknown]>,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantRpc: (...a: unknown[]) => m.rpc(...a),
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => (m.filters.push([c, v]), chain),
        is: (c: string, v: unknown) => (m.filters.push([c, v]), chain),
        maybeSingle: async () => ({ data: table === "agent_runs" ? m.run : null, error: m.readError }),
        then: (ok: (r: unknown) => unknown) => ok({ data: m.rows, error: m.readError }),
      };
      return chain;
    },
  }),
}));
vi.mock("../cgo-ads", () => ({
  cgoApproveChannelAction: (...a: unknown[]) => m.approve(...a),
  isFounderRequested: (b: { origin?: string } | null) => b?.origin === "user_initiated_chat",
}));
vi.mock("../cgo-blockers", () => ({ alertFounderSafely: (...a: unknown[]) => m.alert(...a) }));
vi.mock("@/services/ads-wallet/linkedin-growth", () => ({ LINKEDIN_LAUNCH: "linkedin_ads.launch_campaign" }));

import { LINKEDIN_LAUNCH_CLOSED_NOT_GO, LINKEDIN_LAUNCH_NOT_STARTED, linkedinRunSaidGo, settleLinkedinRunLaunchCards } from "../linkedin-run-verdict";

const agentCard = (id: string, run_id = "run-1", created_at = "2026-11-03T10:05:00Z") => ({ id, run_id, created_at, exec_payload: { origin: "agent" }, edited_body: null });

beforeEach(() => {
  m.rows = [agentCard("a1")];
  m.readError = null;
  m.run = null;
  m.filters = [];
  m.rpc.mockReset();
  m.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  m.approve.mockReset();
  m.approve.mockResolvedValue(true);
  m.alert.mockReset();
  m.alert.mockResolvedValue({ sent: 1, urgent_ids: [] });
});

describe("settleLinkedinRunLaunchCards", () => {
  it("a founder-rooted card nobody ordered closes on a not-yet verdict", async () => {
    m.rows = [{ id: "f1", run_id: "run-1", exec_payload: { origin: "user_initiated_chat" }, edited_body: null }];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "not_here" })).toEqual({ approved: [], closed: ["f1"], unsent: [] });
  });

  it("a founder's explicit order survives a not-yet verdict", async () => {
    m.rows = [{ id: "f1", run_id: "run-1", exec_payload: { origin: "user_initiated_chat", explicit_order: true }, edited_body: null }];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "unsure" })).toEqual({ approved: [], closed: [], unsent: [] });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("a founder-rooted card on a go verdict waits for the founder, Autopilot never approves it", async () => {
    m.rows = [{ id: "f1", run_id: "run-1", exec_payload: { origin: "user_initiated_chat" }, edited_body: null }];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here" })).toEqual({ approved: [], closed: [], unsent: [] });
    expect(m.approve).not.toHaveBeenCalled();
  });

  it.each([
    ["not_here", { verdict: "not_here", reason: "Buyer is not on LinkedIn." }],
    ["unsure", { verdict: "unsure", reason: "Too little to tell." }],
  ])("%s closes the card the model filed and never approves it", async (_name, fit) => {
    const out = await settleLinkedinRunLaunchCards("t-1", "run-1", fit);
    expect(out).toEqual({ approved: [], closed: ["a1"], unsent: [] });
    expect(m.approve).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenCalledTimes(1);
    const [, name, args] = m.rpc.mock.calls[0];
    expect(name).toBe("set_channel_action");
    expect(args).toMatchObject({ p_action_id: "a1", p_status: "rejected", p_source: "cgo", p_actor_user_id: null, p_event_key: "linkedin-run-not-go:run-1:a1" });
    expect(args.p_note).toContain(LINKEDIN_LAUNCH_CLOSED_NOT_GO);
  });

  it.each([
    ["no fit at all", undefined],
    ["a null fit", null],
    ["a fit with no verdict", { reason: "The model gave no verdict." }],
    ["a null verdict", { verdict: null }],
    ["a garbled verdict", { verdict: "HERE" }],
    ["a verdict that is not text", { verdict: { here: true } }],
  ])("must catch: %s leaves the card pending for the founder, neither closed nor approved", async (_name, fit) => {
    m.rows = [agentCard("a1"), agentCard("a2")];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", fit)).toEqual({ approved: [], closed: [], unsent: [] });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.approve).not.toHaveBeenCalled();
  });

  it("a card left pending by an unreadable verdict cannot be approved by Autopilot later: the run did not record a go", async () => {
    m.run = { fit_verdict: null };
    expect(await linkedinRunSaidGo("t-1", "run-1")).toBe(false);
    m.run = null;
    expect(await linkedinRunSaidGo("t-1", "run-1")).toBe(false);
  });

  it("a go verdict runs the Autopilot door and closes nothing", async () => {
    const out = await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here", reason: "Fits." });
    expect(out).toEqual({ approved: ["a1"], closed: [], unsent: [] });
    expect(m.approve).toHaveBeenCalledWith("t-1", "a1", { runSaidGo: true });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it("a go verdict the door holds is not reported as approved", async () => {
    m.approve.mockResolvedValue(false);
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here" })).toEqual({ approved: [], closed: [], unsent: [] });
  });

  it("a founder's order and a founder's edit are never closed or approved by the verdict", async () => {
    m.rows = [
      { id: "ordered", run_id: "run-1", exec_payload: { origin: "user_initiated_chat", explicit_order: true }, edited_body: null },
      { id: "edited", run_id: "run-1", exec_payload: { origin: "agent" }, edited_body: { rationale: "mine" } },
    ];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "not_here" })).toEqual({ approved: [], closed: [], unsent: [] });
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here" })).toEqual({ approved: [], closed: [], unsent: [] });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.approve).not.toHaveBeenCalled();
  });

  it("only untouched open launch cards are read", async () => {
    await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here" });
    expect(m.filters).toEqual(expect.arrayContaining([["tenant_id", "t-1"], ["exec_class", "linkedin_ads.launch_campaign"], ["status", "pending"], ["exec_status", null]]));
  });

  it.each(["not_here", "unsure"])("a newer %s verdict closes a launch card an earlier go run left open, and leaves a later run's card alone", async (verdict) => {
    m.run = { enqueued_at: "2026-11-03T10:00:00Z" };
    m.rows = [agentCard("old", "run-0", "2026-11-02T09:00:00Z"), agentCard("mine"), agentCard("newer", "run-2", "2026-11-03T10:30:00Z")];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict })).toEqual({ approved: [], closed: ["old", "mine"], unsent: [] });
    expect(m.rpc.mock.calls.map((c) => c[2].p_action_id)).toEqual(["old", "mine"]);
    expect(m.rpc.mock.calls[0][2]).toMatchObject({ p_status: "rejected", p_event_key: "linkedin-run-not-go:run-1:old" });
  });

  it("an earlier run's card stays when this run's start cannot be read: nothing is closed on a guess", async () => {
    m.run = null;
    m.rows = [agentCard("old", "run-0", "2026-11-02T09:00:00Z"), agentCard("mine")];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "not_here" })).toEqual({ approved: [], closed: ["mine"], unsent: [] });
  });

  it("a go verdict approves only its own run's cards, never an earlier run's", async () => {
    m.run = { enqueued_at: "2026-11-03T10:00:00Z" };
    m.rows = [agentCard("old", "run-0", "2026-11-02T09:00:00Z"), agentCard("mine")];
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here" })).toEqual({ approved: ["mine"], closed: [], unsent: [] });
    expect(m.approve.mock.calls.map((c) => c[1])).toEqual(["mine"]);
  });

  it("an approval whose start event was lost is re-sent once and counts as approved", async () => {
    m.approve.mockRejectedValueOnce(new Error("inngest down")).mockResolvedValueOnce(true);
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here" })).toEqual({ approved: ["a1"], closed: [], unsent: [] });
    expect(m.approve).toHaveBeenCalledTimes(2);
    expect(m.approve.mock.calls[1]).toEqual(["t-1", "a1", { runSaidGo: true }]);
    expect(m.alert).not.toHaveBeenCalled();
  });

  it("an approval that still cannot start tells the founder, and the other launch cards are still settled", async () => {
    m.rows = [agentCard("a1"), agentCard("a2")];
    m.approve.mockImplementation(async (_t: string, id: string) => {
      if (id === "a1") throw new Error("inngest down");
      return true;
    });
    expect(await settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "here" })).toEqual({ approved: ["a2"], closed: [], unsent: ["a1"] });
    expect(m.approve.mock.calls.filter((c) => c[1] === "a1")).toHaveLength(2);
    expect(m.alert).toHaveBeenCalledTimes(1);
    const [tenant, , blockers] = m.alert.mock.calls[0];
    expect(tenant).toBe("t-1");
    expect(blockers).toEqual([expect.objectContaining({ id: "stuck:a1", kind: "stuck", notify_now: true, action_id: "a1", what: LINKEDIN_LAUNCH_NOT_STARTED })]);
  });

  it("a close the database refuses is an error, not a silent open card", async () => {
    m.rpc.mockResolvedValue({ data: { ok: false, code: "exec_in_flight" }, error: null });
    await expect(settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "not_here" })).rejects.toThrow(/exec_in_flight/);
  });

  it("an unreadable card list is an error", async () => {
    m.readError = { message: "down" };
    await expect(settleLinkedinRunLaunchCards("t-1", "run-1", { verdict: "not_here" })).rejects.toThrow(/down/);
  });
});

describe("linkedinRunSaidGo", () => {
  it.each([
    [{ fit_verdict: "here" }, true],
    [{ fit_verdict: "not_here" }, false],
    [{ fit_verdict: "unsure" }, false],
    [{ fit_verdict: null }, false],
    [null, false],
  ])("recorded %j reads as %s", async (run, want) => {
    m.run = run;
    expect(await linkedinRunSaidGo("t-1", "run-1")).toBe(want);
  });

  it("a card with no run, or a failed read, is not a go", async () => {
    expect(await linkedinRunSaidGo("t-1", null)).toBe(false);
    m.run = { fit_verdict: "here" };
    m.readError = { message: "down" };
    expect(await linkedinRunSaidGo("t-1", "run-1")).toBe(false);
  });
});
