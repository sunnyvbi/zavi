import { describe, expect, it, vi } from "vitest";
import { genOf, PLAN_PASS, runEmailPlanPass, type PassDeps, type PlanJob } from "../pass";

const T = "tenant-northwind";
const ITEM = "11111111-1111-4111-8111-111111111111";
const CARD = { rail: "channel_actions" as const, id: "22222222-2222-4222-8222-222222222222", class: "email_campaign.create_and_send", body: { tool: "mailchimp" } };
const NOW = new Date("2026-10-20T16:30:00Z");

const job = (kind: "draft" | "deadline", key = kind === "deadline" ? `deadline:${ITEM}:g2` : `draft:${ITEM}:v1`): PlanJob => ({
  id: `job-${kind}`,
  tenant_id: T,
  item_id: ITEM,
  kind,
  job_key: key,
  lease_token: "lease-1",
  attempts: 1,
});

function harness(over: Partial<PassDeps> = {}, rpcs: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const completed: Array<{ key: string; outcome: string; retry?: number }> = [];
  const sent: string[] = [];
  const deps: PassDeps = {
    now: () => NOW,
    repair: async () => 0,
    alertStuckHolds: async () => 0,
    outboxPending: async () => [],
    claimJobs: async () => [],
    completeJob: async (j, outcome, _e, retry) => {
      completed.push({ key: j.job_key, outcome, retry });
      return 1;
    },
    rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name in rpcs) return typeof rpcs[name] === "function" ? (rpcs[name] as (a: unknown) => unknown)(args) : rpcs[name];
      if (name === "mark_email_plan_outbox_sent") return 1;
      return { ok: true };
    }) as PassDeps["rpc"],
    send: async (e) => {
      sent.push(e.id);
    },
    unattended: vi.fn(async () => ({ allow: true, count: 300, reasons: [] })),
    startRun: vi.fn(async () => ({ ok: true, run_id: "run-1" })),
    schedulesMissing: async () => [],
    claimSchedules: async () => [],
    claimZoneChecks: async () => [],
    zoneOf: async () => "America/Los_Angeles",
    nextFire: () => new Date("2026-10-26T15:00:00Z"),
    weeklyEligible: async () => true,
    log: () => {},
    ...over,
  };
  return { deps, calls, completed, sent };
}

const queued = { ok: true, outcome: "queued", event: { id: `approve:${CARD.id}:1`, name: "channel-action.approved", data: { action_id: CARD.id } } };

describe("the deadline", () => {
  it("reads the generation off the job key", () => {
    expect(genOf(`deadline:${ITEM}:g12`)).toBe(12);
    expect(genOf("draft:x:v1")).toBeNull();
  });

  it("nobody acted: Auto send is read now and passed to the SQL door; its event is emitted and marked", async () => {
    const h = harness(
      { claimJobs: async () => [job("deadline")] },
      { email_plan_deadline_state: { ok: true, schedule_gen: 2, needs_unattended: true, card: CARD }, fire_email_planned_send: queued },
    );
    const r = await runEmailPlanPass(h.deps);
    expect(h.deps.unattended).toHaveBeenCalledWith(T, CARD);
    expect(h.calls.find((c) => c.name === "fire_email_planned_send")?.args).toEqual({ p_id: ITEM, p_gen: 2, p_unattended: { allow: true, count: 300, reasons: [] } });
    expect(h.sent).toEqual([`approve:${CARD.id}:1`]);
    expect(h.calls.some((c) => c.name === "mark_email_plan_outbox_sent" && c.args.p_event_id === `approve:${CARD.id}:1`)).toBe(true);
    expect(h.completed).toEqual([{ key: `deadline:${ITEM}:g2`, outcome: "done", retry: 60 }]);
    expect(r).toMatchObject({ jobs: 1, deadlines: 1, errors: 0 });
  });

  it("must catch R11: an approved-for-the-time or vetoed item never reads Auto send", async () => {
    const h = harness(
      { claimJobs: async () => [job("deadline")] },
      { email_plan_deadline_state: { ok: true, schedule_gen: 2, needs_unattended: false, card: CARD }, fire_email_planned_send: { ok: true, outcome: "skipped", reason: "vetoed" } },
    );
    await runEmailPlanPass(h.deps);
    expect(h.deps.unattended).not.toHaveBeenCalled();
    expect(h.calls.find((c) => c.name === "fire_email_planned_send")?.args.p_unattended).toEqual({ allow: false, count: null, reasons: [] });
    expect(h.sent).toEqual([]);
  });

  it("an old generation's deadline (the item moved) does nothing", async () => {
    const h = harness({ claimJobs: async () => [job("deadline", `deadline:${ITEM}:g1`)] }, { email_plan_deadline_state: { ok: true, schedule_gen: 2, needs_unattended: true, card: CARD } });
    await runEmailPlanPass(h.deps);
    expect(h.calls.some((c) => c.name === "fire_email_planned_send")).toBe(false);
    expect(h.completed[0].outcome).toBe("done");
  });

  it("must catch: a crash between the approval and the emit is re-emitted once, with the same id, by a later pass", async () => {
    const first = harness(
      {
        claimJobs: async () => [job("deadline")],
        send: async () => {
          throw new Error("inngest down");
        },
      },
      { email_plan_deadline_state: { ok: true, schedule_gen: 2, needs_unattended: true, card: CARD }, fire_email_planned_send: queued },
    );
    await runEmailPlanPass(first.deps);
    expect(first.calls.some((c) => c.name === "mark_email_plan_outbox_sent")).toBe(false);
    expect(first.completed[0].outcome).toBe("done");
    const later = harness({
      outboxPending: async () => [
        { tenant_id: T, event_id: queued.event.id, event_name: queued.event.name, event_data: queued.event.data, created_at: "2026-10-20T16:00:00Z" },
        { tenant_id: T, event_id: "approve:fresh:1", event_name: "channel-action.approved", event_data: { action_id: "fresh" }, created_at: NOW.toISOString() },
      ],
    });
    const r = await runEmailPlanPass(later.deps);
    expect(later.sent).toEqual([queued.event.id]);
    expect(r.resent).toBe(1);
  });

  it("a deadline claimed a moment early comes back in a minute; an error comes back in two", async () => {
    const early = harness({ claimJobs: async () => [job("deadline")] }, { email_plan_deadline_state: { ok: true, schedule_gen: 2 }, fire_email_planned_send: { ok: true, outcome: "not_yet" } });
    await runEmailPlanPass(early.deps);
    expect(early.completed).toEqual([{ key: `deadline:${ITEM}:g2`, outcome: "retry", retry: 60 }]);
    const broken = harness(
      { claimJobs: async () => [job("deadline")] },
      {
        email_plan_deadline_state: () => {
          throw new Error("db");
        },
      },
    );
    const r = await runEmailPlanPass(broken.deps);
    expect(broken.completed).toEqual([{ key: `deadline:${ITEM}:g2`, outcome: "retry", retry: 120 }]);
    expect(r.errors).toBe(1);
  });
});

describe("the day-before draft", () => {
  const begin = {
    ok: true,
    attempt: 2,
    version: 3,
    route: "zavi_list",
    list_id: "33333333-3333-4333-8333-333333333333",
    list_name: "Patients",
    planned_at: "2026-10-21T16:30:00Z",
    planned_tz: "America/Los_Angeles",
    angle: "Flu shots are in",
    why: "Clicks beat the line in October",
  };

  it("starts ONE planned-draft run with a stable id per item, version and attempt, and looks again in 4 minutes", async () => {
    const h = harness({ claimJobs: async () => [job("draft")] }, { begin_email_plan_draft: begin });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).toHaveBeenCalledWith(
      T,
      {
        email_plan: {
          mode: "planned_draft",
          item_id: ITEM,
          version: 3,
          route: "zavi_list",
          list_id: begin.list_id,
          list_name: "Patients",
          planned_at: begin.planned_at,
          planned_label: "Wed, Oct 21, 09:30 (America/Los_Angeles)",
          angle: "Flu shots are in",
          why: "Clicks beat the line in October",
        },
      },
      `email-plan-draft:${ITEM}:v3:a2`,
    );
    expect(h.completed).toEqual([{ key: `draft:${ITEM}:v1`, outcome: "retry", retry: 4 * 60 }]);
  });

  it("must catch J2: begin is asked for THIS job and its lease, never the item alone", async () => {
    const h = harness({ claimJobs: async () => [job("draft")] }, { begin_email_plan_draft: { ok: true, attempt: null, reason: "superseded" } });
    await runEmailPlanPass(h.deps);
    expect(h.calls.find((c) => c.name === "begin_email_plan_draft")?.args).toEqual({ p_id: ITEM, p_job_id: "job-draft", p_lease_token: "lease-1" });
    expect(h.deps.startRun).not.toHaveBeenCalled();
  });

  it("email paused: no paid run, and the job comes back in 45 minutes instead of closing", async () => {
    const h = harness({ claimJobs: async () => [job("draft")] }, { begin_email_plan_draft: { ok: true, attempt: null, status: "planned", reason: "paused" } });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).not.toHaveBeenCalled();
    expect(h.completed).toEqual([{ key: `draft:${ITEM}:v1`, outcome: "retry", retry: 45 * 60 }]);
  });

  it("email paused too close to the planned time: done, no run", async () => {
    const h = harness({ claimJobs: async () => [job("draft")] }, { begin_email_plan_draft: { ok: true, attempt: null, status: "planned", reason: "paused_too_late" } });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).not.toHaveBeenCalled();
    expect(h.completed).toEqual([{ key: `draft:${ITEM}:v1`, outcome: "done", retry: 45 * 60 }]);
  });

  it("drafted, changed or out of attempts: done, no run", async () => {
    const h = harness({ claimJobs: async () => [job("draft")] }, { begin_email_plan_draft: { ok: true, attempt: null, status: "ready" } });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).not.toHaveBeenCalled();
    expect(h.completed[0].outcome).toBe("done");
  });
});

describe("the Monday planning run (F7)", () => {
  it("a new workspace gets its first Monday 08:00 in its reporting zone", async () => {
    const nextFire = vi.fn(() => new Date("2026-10-26T15:00:00Z"));
    const h = harness({ schedulesMissing: async () => [T], nextFire });
    const r = await runEmailPlanPass(h.deps);
    expect(nextFire).toHaveBeenCalledWith("America/Los_Angeles", NOW);
    expect(h.calls.find((c) => c.name === "set_email_plan_schedule")?.args).toEqual({ p_next: "2026-10-26T15:00:00.000Z", p_tz: "America/Los_Angeles" });
    expect(r.scheduled).toBe(1);
  });

  it("an eligible workspace gets one weekly_plan run (stable id per local week); the next Monday is written", async () => {
    const h = harness({ claimSchedules: async () => [{ tenant_id: T, lease_token: "L", timezone: "America/Los_Angeles" }] });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).toHaveBeenCalledWith(T, { email_plan: { mode: "weekly_plan", timezone: "America/Los_Angeles", week_of: "2026-10-20" } }, `email-plan-week:${T}:2026-10-20`);
    expect(h.calls.find((c) => c.name === "finish_email_plan_schedule")?.args).toEqual({
      p_token: "L",
      p_next: "2026-10-26T15:00:00.000Z",
      p_request: `email-plan-week:${T}:2026-10-20`,
      p_tz: "America/Los_Angeles",
    });
  });

  it("must catch H8: no next Monday computed leaves next_run_at as it is (null), never a guessed date", async () => {
    const h = harness({ claimSchedules: async () => [{ tenant_id: T, lease_token: "L", timezone: "UTC" }], nextFire: () => null });
    await runEmailPlanPass(h.deps);
    expect(h.calls.find((c) => c.name === "finish_email_plan_schedule")?.args.p_next).toBeNull();
  });

  it("must catch H8: a workspace whose reporting zone changed is moved to its new Monday; an unchanged one is left alone", async () => {
    const h = harness({
      claimZoneChecks: async () => [
        { tenant_id: T, lease_token: "", timezone: "UTC" },
        { tenant_id: "same", lease_token: "", timezone: "America/Los_Angeles" },
      ],
    });
    const r = await runEmailPlanPass(h.deps);
    expect(h.calls.filter((c) => c.name === "set_email_plan_schedule")).toEqual([
      { name: "set_email_plan_schedule", args: { p_next: "2026-10-26T15:00:00.000Z", p_tz: "America/Los_Angeles" } },
    ]);
    expect(r.rezoned).toBe(1);
  });

  it("staff are told about sends held over 24h on every pass; a failed alert pass is counted, not thrown", async () => {
    const limits: number[] = [];
    const ok = await runEmailPlanPass(harness({ alertStuckHolds: async (n) => (limits.push(n), 2) }).deps);
    expect(ok).toMatchObject({ stuck_alerted: 2, errors: 0 });
    expect(limits).toEqual([50]);
    const down = await runEmailPlanPass(harness({ alertStuckHolds: async () => Promise.reject(new Error("db down")) }).deps);
    expect(down).toMatchObject({ stuck_alerted: 0, errors: 1 });
  });

  it("an ineligible workspace is not run, only moved to its next Monday", async () => {
    const h = harness({
      claimSchedules: async () => [{ tenant_id: T, lease_token: "L", timezone: "UTC" }],
      weeklyEligible: async () => false,
      nextFire: (_tz: string, after: Date) => new Date(after.getTime() + 6 * 24 * 3_600_000),
    });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).not.toHaveBeenCalled();
    const finish = h.calls.find((c) => c.name === "finish_email_plan_schedule")?.args;
    expect(finish?.p_request).toBeNull();
    expect(new Date(String(finish?.p_next)).getTime() - NOW.getTime()).toBeGreaterThan(5 * 24 * 3_600_000);
  });

  it("must catch: an eligibility read that throws keeps the week: it starts nothing and tries again soon, with a warning, not next Monday", async () => {
    const logs: string[] = [];
    const h = harness({
      claimSchedules: async () => [{ tenant_id: T, lease_token: "L", timezone: "UTC" }],
      weeklyEligible: async () => {
        throw new Error("settings down");
      },
      nextFire: (_tz: string, after: Date) => (after.getTime() < NOW.getTime() ? new Date(NOW.getTime() - 60_000) : new Date(NOW.getTime() + 6 * 24 * 3_600_000)),
      log: (code: string) => void logs.push(code),
    });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).not.toHaveBeenCalled();
    const finish = h.calls.find((c) => c.name === "finish_email_plan_schedule")?.args;
    expect(finish?.p_request).toBeNull();
    expect(new Date(String(finish?.p_next)).getTime() - NOW.getTime()).toBeLessThan(3_600_000);
    expect(logs).toContain("email_plan.weekly_lists_unread");
  });
});

describe("a weekly list read that failed", () => {
  it("starts no paid run and tries again soon, not next Monday", async () => {
    const logs: string[] = [];
    const h = harness({
      claimSchedules: async () => [{ tenant_id: T, lease_token: "L", timezone: "UTC" }],
      weeklyEligible: async () => "retry",
      nextFire: (_tz: string, after: Date) => (after.getTime() < NOW.getTime() ? new Date(NOW.getTime() - 60_000) : new Date(NOW.getTime() + 6 * 24 * 3_600_000)),
      log: (code: string) => void logs.push(code),
    });
    await runEmailPlanPass(h.deps);
    expect(h.deps.startRun).not.toHaveBeenCalled();
    const finish = h.calls.find((c) => c.name === "finish_email_plan_schedule")?.args;
    expect(finish?.p_request).toBeNull();
    expect(new Date(String(finish?.p_next)).getTime() - NOW.getTime()).toBeLessThan(3_600_000);
    expect(logs).toContain("email_plan.weekly_lists_unread");
  });
});

describe("a failed Monday planning run is retried soon, not skipped for the week", () => {
  const monday = (from: Date) => {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 15, 0, 0));
    while (d.getUTCDay() !== 1 || d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  };
  const failing = (at: string) => {
    const logs: Array<{ code: string; tenant?: string; level?: string }> = [];
    const h = harness({
      now: () => new Date(at),
      claimSchedules: async () => [{ tenant_id: T, lease_token: "L", timezone: "America/Los_Angeles" }],
      startRun: vi.fn(async () => ({ ok: false, reason: "admission_failed" })),
      nextFire: (_tz, from) => monday(from),
      log: (code, _m, tenant, level) => logs.push({ code, tenant, level }),
    });
    return { h, logs };
  };
  const nextOf = (h: ReturnType<typeof harness>) => h.calls.find((c) => c.name === "finish_email_plan_schedule")?.args.p_next;

  it("right after the Monday fire it comes back in 15 minutes, logged at warn", async () => {
    const { h, logs } = failing("2026-10-19T15:02:00Z");
    const r = await runEmailPlanPass(h.deps);
    expect(nextOf(h)).toBe("2026-10-19T15:17:00.000Z");
    expect(r.weekly).toBe(0);
    expect(logs).toEqual([{ code: "email_plan.weekly_not_started", tenant: T, level: "warn" }]);
  });

  it("the wait grows with how late the run already is, capped at 4 hours", async () => {
    const three = failing("2026-10-19T18:00:00Z");
    await runEmailPlanPass(three.h.deps);
    expect(nextOf(three.h)).toBe("2026-10-19T21:00:00.000Z");
    const ten = failing("2026-10-20T01:00:00Z");
    await runEmailPlanPass(ten.h.deps);
    expect(nextOf(ten.h)).toBe("2026-10-20T05:00:00.000Z");
  });

  it("after a day of failures it gives up for the week and moves to the next Monday", async () => {
    const { h } = failing("2026-10-20T16:00:00Z");
    await runEmailPlanPass(h.deps);
    expect(nextOf(h)).toBe("2026-10-26T15:00:00.000Z");
  });

  it("a run that started still moves to the next Monday", async () => {
    const h = harness({
      now: () => new Date("2026-10-19T15:02:00Z"),
      claimSchedules: async () => [{ tenant_id: T, lease_token: "L", timezone: "UTC" }],
      nextFire: (_tz, from) => monday(from),
    });
    const r = await runEmailPlanPass(h.deps);
    expect(r.weekly).toBe(1);
    expect(nextOf(h)).toBe("2026-10-26T15:00:00.000Z");
  });
});

describe("a planned draft whose run filed nothing for a reason a retry cannot fix", () => {
  const LIST = "seed-new-signups";
  const audiences = (list: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify([{ type: "text", text: JSON.stringify({ tool: "mailchimp", audiences: list, ...extra }) }]);
  const listCall = (preview: string) => ({ name: "mcp__server__email_campaign__list_audiences", status: "ok", input_preview: '{"tool":"mailchimp"}', output_preview: preview });
  const toolSearch = {
    name: "ToolSearch",
    status: "ok",
    output_preview: '[{"type":"tool_reference","tool_name":"mcp__server__email__propose_campaign"},{"type":"tool_reference","tool_name":"mcp__server__email_campaign__list_audiences"}]',
  };
  const REPRO = [toolSearch, listCall(audiences([{ id: "81ac1df0cc", name: "upcar.ai", member_count: 2 }]))];
  const refused = (code: string) => ({ name: "mcp__server__email__propose_campaign", status: "tool_error", code, output_preview: `{"error":"${code}"}` });

  function plan(toolCalls: unknown[], runStatus = "success") {
    const item = { status: "planned", status_reason: null as string | null, attempts: 0, version: 1 };
    const runs: Array<{ item: string; version: number; status: string; finished_at: string | null; enqueued_at?: string | null; payload: unknown; tool_calls: unknown }> = [];
    const pending = { due: true };
    const h = harness(
      {
        claimJobs: async () => (pending.due ? [job("draft", `draft:${ITEM}:v1:g1`)] : []),
        completeJob: async (_j, outcome) => {
          pending.due = outcome === "retry";
          return 1;
        },
        startRun: vi.fn(async (_t: string, extra: Record<string, unknown>) => {
          runs.push({ item: ITEM, version: item.version, status: runStatus, finished_at: NOW.toISOString(), payload: { email_plan: extra.email_plan }, tool_calls: toolCalls });
          return { ok: true, run_id: `run-${runs.length}` };
        }),
        lastDraftRun: vi.fn(async (_t: string, itemId: string, version: number) => runs.filter((r) => r.item === itemId && r.version === version).at(-1) ?? null),
      },
      {
        begin_email_plan_draft: () => {
          if (item.status !== "planned" && item.status !== "drafting") return { ok: true, attempt: null, status: item.status };
          if (item.attempts >= 3) {
            Object.assign(item, { status: "skipped", status_reason: "no_draft" });
            pending.due = false;
            return { ok: true, attempt: null, status: "skipped", reason: "out_of_attempts" };
          }
          item.attempts += 1;
          item.status = "drafting";
          return { ok: true, attempt: item.attempts, version: item.version, route: "mailchimp", list_id: LIST, list_name: "New signups", planned_at: "2026-10-21T16:30:00Z", planned_tz: "UTC", angle: "Welcome" };
        },
        block_email_plan_draft: (a: Record<string, unknown>) => {
          if (item.status !== "drafting" || a.p_version !== item.version) return { ok: true, blocked: false };
          Object.assign(item, { status: "blocked", status_reason: `draft_blocked:${String(a.p_code)}` });
          pending.due = false;
          return { ok: true, blocked: true };
        },
      },
    );
    const tick = async (n: number) => {
      for (let i = 0; i < n; i += 1) await runEmailPlanPass(h.deps);
    };
    return { h, item, runs, tick };
  }

  it("must catch 8186: the list is gone from Mailchimp, so ONE run is started, never a second, and the item waits on the founder with the reason", async () => {
    const p = plan(REPRO);
    await p.tick(5);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
    expect(p.item).toMatchObject({ status: "blocked", status_reason: "draft_blocked:email_audience_missing", attempts: 1 });
    const block = p.h.calls.find((c) => c.name === "block_email_plan_draft");
    expect(block?.args).toEqual({ p_id: ITEM, p_job_id: "job-draft", p_lease_token: "lease-1", p_version: 1, p_code: "email_audience_missing" });
    expect(p.h.calls.filter((c) => c.name === "begin_email_plan_draft")).toHaveLength(1);
  });

  it.each([
    ["the email tool is not connected any more", [refused("email_tool_not_connected")], "email_tool_not_connected"],
    ["the list is a test list", [refused("email_test_list")], "email_test_list"],
    ["the sender is unknown", [refused("email_sender_unknown")], "email_sender_unknown"],
    ["the list has nobody on it", [listCall(audiences([{ id: LIST, name: "New signups", member_count: 0 }]))], "email_audience_empty"],
    ["the tool has no lists at all", [listCall(audiences([], { note: "Mailchimp has no lists yet." }))], "email_audience_missing"],
  ])("a fixed blocker (%s) stops after one run with its own code", async (_label, calls, code) => {
    const p = plan(calls);
    await p.tick(4);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
    expect(p.item.status_reason).toBe(`draft_blocked:${code}`);
  });

  it.each([
    ["the card cap was reached", [...REPRO, refused("email_card_cap_reached")]],
    ["the propose tool was unavailable", [refused("email_campaign_propose_unavailable")]],
    ["the list is there and the model just stopped", [listCall(audiences([{ id: LIST, name: "New signups", member_count: 40 }]))]],
    ["the list read was cut short", [listCall(`${audiences([{ id: "81ac1df0cc", name: "upcar.ai", member_count: 2 }]).slice(0, 60)}…[truncated 99 bytes]`)]],
    ["the list read said it was partial", [listCall(audiences([{ id: "81ac1df0cc", name: "upcar.ai", member_count: 2 }], { note: "Mailchimp has more lists than Zavi read." }))]],
    ["the read came from another tool", [listCall(JSON.stringify([{ type: "text", text: JSON.stringify({ tool: "klaviyo", audiences: [] }) }]))]],
    ["nothing was read", []],
  ])("a transient miss (%s) still retries to 3 runs and ends no_draft", async (_label, calls) => {
    const p = plan(calls);
    await p.tick(6);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(3);
    expect(p.item).toMatchObject({ status: "skipped", status_reason: "no_draft" });
    expect(p.h.calls.some((c) => c.name === "block_email_plan_draft")).toBe(false);
  });

  it("a run that failed (not a refusal) is retried even when it read a list without the planned one", async () => {
    const p = plan(REPRO, "failed");
    await p.tick(6);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(3);
    expect(p.item.status).toBe("skipped");
  });

  it.each(["queued", "running"])("attempt 1 still %s: no second paid run, no attempt spent, and the item resumes when it ends", async (status) => {
    const p = plan([], status);
    await p.tick(1);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
    expect(p.item.attempts).toBe(1);
    await p.tick(5);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
    expect(p.item.attempts).toBe(1);
    expect(p.h.calls.filter((c) => c.name === "block_email_plan_draft")).toEqual([]);
    p.runs[0].status = "failed";
    await p.tick(1);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(2);
    expect(p.item.attempts).toBe(2);
  });

  it("an unreadable last run starts nothing paid, then drafting resumes once it reads again", async () => {
    const p = plan([], "running");
    await p.tick(1);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
    const read = p.h.deps.lastDraftRun;
    p.h.deps.lastDraftRun = vi.fn(async () => {
      throw new Error("db down");
    });
    await p.tick(4);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
    expect(p.item.attempts).toBe(1);
    p.h.deps.lastDraftRun = read;
    p.runs[0].status = "failed";
    await p.tick(1);
    expect(p.h.deps.startRun).toHaveBeenCalledTimes(2);
  });

  it("a refused block falls back to drafting, never stalls the item", async () => {
    const q = plan(REPRO);
    const rpc = q.h.deps.rpc;
    q.h.deps.rpc = (async (t: string, name: string, args: Record<string, unknown>) => {
      if (name === "block_email_plan_draft") throw new Error("block_email_plan_draft failed");
      return rpc(t, name, args);
    }) as PassDeps["rpc"];
    await q.tick(6);
    expect(q.h.deps.startRun).toHaveBeenCalledTimes(3);
  });

  describe("the mirror's two stuck runs, as their traces were stored", () => {
    const CARD_ID = "5ae98193-7bdd-46f3-b4ba-6b9d022335fe";
    const stored = (error: string, message: string) => ({
      name: "mcp__server__email__propose_campaign",
      status: "tool_error",
      output_preview: JSON.stringify(JSON.stringify({ message, error })),
    });
    const BODY_INVALID = stored("email_campaign_body_invalid", "The send proposal was not in the expected shape, so nothing was filed. This is a Zavi bug, not something to retry.");
    const REPEAT = stored("channel_card_already_done", `Not filed: the founder already approved the same change (card ${CARD_ID}).`);
    const TURNED_DOWN = stored("channel_card_already_rejected", `Not filed: the founder already turned down the same change (card ${CARD_ID}).`);

    it.each([
      ["run dc3e6779, a Zavi bug refusal", BODY_INVALID, "email_campaign_body_invalid", "Zavi could not file the draft. Try Draft now again."],
      ["run 341396a9, a repeat of an approved email", REPEAT, "channel_card_already_done", "You already approved a similar email to this list, so Zavi did not draft this one. Change the topic, or skip it."],
      ["a repeat of a turned down email", TURNED_DOWN, "channel_card_already_rejected", "You turned down a similar email to this list, so Zavi did not draft this one. Change the topic, or skip it."],
    ])("must catch %s: one paid run, blocked at once, nothing approved or sent", async (_label, call, code, words) => {
      const p = plan([toolSearch, call]);
      await p.tick(6);
      expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
      expect(p.h.calls.filter((c) => c.name === "begin_email_plan_draft")).toHaveLength(1);
      expect(p.item).toMatchObject({ status: "blocked", status_reason: `draft_blocked:${code}`, attempts: 1 });
      expect(p.h.calls.map((c) => c.name).filter((n) => /approve|fire_|schedule/.test(n))).toEqual([]);
      expect(p.h.sent).toEqual([]);
      const { plannedReason } = await import("@/services/email-cards/cards");
      const shown = plannedReason(p.item.status_reason, "sendgrid");
      expect(shown).toBe(words);
      expect(shown).not.toMatch(/[a-z]+_[a-z]+|[0-9a-f]{8}-[0-9a-f]{4}/);
    });

    it.each([
      ["the email tool could not be read", "email_tool_read_failed", "SendGrid could not be read just now."],
      ["settings could not be read", "email_settings_unreadable", "Zavi could not read the sender."],
      ["the test lists could not be read", "email_test_lists_unreadable", "Try again."],
      ["the sender check failed", "bulk_check_failed", "Try again in a minute."],
      ["the plan could not be read", "plan_unreadable", "Try again."],
      ["the template could not be drafted", "email_template_missing", "Nothing was proposed."],
      ["the model wrote a bad link", "email_render_bad_url", "The button is not a full web address."],
      ["the model left out a field", "email_content_incomplete", "Nothing was proposed."],
      ["the card count was full", "email_card_cap_reached", "Nothing was proposed."],
    ])("a retryable refusal (%s) still gets all 3 paid runs", async (_label, code, message) => {
      const p = plan([toolSearch, stored(code, message)]);
      await p.tick(6);
      expect(p.h.deps.startRun).toHaveBeenCalledTimes(3);
      expect(p.h.calls.some((c) => c.name === "block_email_plan_draft")).toBe(false);
      expect(p.item).toMatchObject({ status: "skipped", status_reason: "no_draft" });
    });

    it("a run out of credits ends failed, not refused, and is retried", async () => {
      const p = plan([toolSearch, BODY_INVALID], "failed");
      await p.tick(6);
      expect(p.h.deps.startRun).toHaveBeenCalledTimes(3);
      expect(p.item.status).toBe("skipped");
    });

    function clocked(toolCalls: unknown[], runStatus = "success") {
      const clock = { at: NOW.getTime() };
      const p = plan(toolCalls, runStatus);
      const retries: Array<number | undefined> = [];
      const complete = p.h.deps.completeJob;
      p.h.deps.now = () => new Date(clock.at);
      p.h.deps.completeJob = async (j, outcome, e, retry) => {
        retries.push(retry);
        return complete(j, outcome, e, retry);
      };
      const start = p.h.deps.startRun;
      p.h.deps.startRun = vi.fn(async (t: string, extra: Record<string, unknown>, request: string) => {
        const out = await start(t, extra, request);
        Object.assign(p.runs.at(-1)!, { enqueued_at: new Date(clock.at).toISOString() });
        return out;
      });
      p.h.deps.draftItem = async () => ({ route: "sendgrid", list_id: LIST, status: p.item.status, card_id: null });
      return { ...p, clock, retries, advance: (m: number) => void (clock.at += m * 60_000) };
    }

    it("must catch the 45 minute wait: the next look, minutes after the run ended, blocks the item", async () => {
      const p = clocked([toolSearch, REPEAT]);
      await p.tick(1);
      expect(p.retries).toEqual([PLAN_PASS.draftPollSeconds]);
      expect(PLAN_PASS.draftPollSeconds).toBeLessThanOrEqual(5 * 60);
      p.advance(5);
      await p.tick(1);
      expect(p.item.status).toBe("blocked");
      expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
    });

    it("looking sooner never starts paid runs sooner: a run with no card waits out the full 45 minutes", async () => {
      const p = clocked([toolSearch]);
      await p.tick(1);
      for (let m = 5; m < 45; m += 5) {
        p.advance(5);
        await p.tick(1);
        expect(p.h.deps.startRun).toHaveBeenCalledTimes(1);
      }
      expect(p.item.attempts).toBe(1);
      p.advance(5);
      await p.tick(1);
      expect(p.h.deps.startRun).toHaveBeenCalledTimes(2);
    });

    it("must catch a dead Draft now: after a founder's retry the old refusal does not block the fresh run", async () => {
      const p = clocked([toolSearch, BODY_INVALID]);
      await p.tick(1);
      p.advance(5);
      await p.tick(1);
      expect(p.item.status).toBe("blocked");
      Object.assign(p.item, { status: "planned", status_reason: null });
      p.h.deps.claimJobs = async () => [job("draft", `draft:${ITEM}:v1:g1:now`)];
      await runEmailPlanPass(p.h.deps);
      expect(p.h.deps.startRun).toHaveBeenCalledTimes(2);
      expect(p.item).toMatchObject({ status: "drafting", attempts: 2 });
    });
  });

  it("the founder reads the reason in their tool's words, not the generic fallback", async () => {
    const { plannedReason, PLANNED_REASON_FALLBACK } = await import("@/services/email-cards/cards");
    const words = plannedReason("draft_blocked:email_audience_missing", "mailchimp");
    expect(words).toBe("The list isn't in your Mailchimp account any more, so Zavi could not draft this email. Skip it, and plan one to a list you still have.");
    expect(plannedReason("draft_blocked:email_tool_not_connected", "klaviyo")).toMatch(/^Klaviyo is not connected any more/);
    expect(plannedReason("draft_blocked:bulk_sending_paused", "zavi_list")).not.toBe(PLANNED_REASON_FALLBACK);
    expect(plannedReason("draft_blocked:something_new", "mailchimp")).toMatch(/trying again will not fix it/);
  });
});
