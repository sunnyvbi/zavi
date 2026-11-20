
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/agents/index", () => ({ dispatchers: {} }));
const email = vi.hoisted(() => ({ send: vi.fn(async (_a: unknown) => ({ sent: true, count: 1 })) }));
vi.mock("@/email/sendAgentResult", () => ({ sendAgentResultEmail: (a: unknown) => email.send(a) }));
vi.mock("../reminder-delivery-deps", () => ({
  reminderDeliveryDeps: () => ({ scrub: (t: string) => t, postToThread: vi.fn(), postToSlack: vi.fn() }),
}));

import {
  deliverCustomAgentResult,
  finishCustomAgentRun,
  noteCustomAgentCreditSkip,
  recordCustomAgentFailure,
  composeCustomPauseNotice,
  composeCustomCreditsNotice,
  composeCustomResultBody,
  customAgentPagePath,
  customAgentRunPath,
  composeCustomEmailBody,
  CUSTOM_READY_EMAIL_CTA,
  defaultCustomDeliveryDeps,
  CUSTOM_NOTICE_EMAIL_CTA,
  CUSTOM_WHATSAPP_PENDING,
  sendOrParkWhatsApp,
  flushCustomAgentWhatsAppPending,
  settleCustomAgentAltTerminal,
  type WhatsAppSeams,
  type ParkResult,
  type FlushSeams,
  type PendingWhatsAppRow,
  CUSTOM_SUMMARY_MAX,
  type CustomDeliveryDeps,
  type CustomRunSeams,
  setupBlockKey,
} from "../custom-agent-runs";
import { customTriggerIdFromPayload, buildCustomSchedulePayload } from "../custom-agent-payload";
import type { CustomDeliver } from "../custom-agents";

const T1 = "11111111-1111-4111-8111-111111111111";
const THREAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_THREAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRIG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "22222222-2222-4222-8222-222222222222";
const SLUG = "c-abcdef1234";

function senders(over: Partial<CustomDeliveryDeps> = {}) {
  const d = {
    scrub: vi.fn((t: string) => t),
    postToThread: vi.fn(async () => null),
    postToSlack: vi.fn(async () => null),
    postToSlackDm: vi.fn(async () => null),
    postToWhatsApp: vi.fn(async () => null),
    postToEmail: vi.fn(async () => null),
    threadInTenant: vi.fn(async (_t: string, id: string) => id === THREAD),
    ...over,
  };
  return d as typeof d & CustomDeliveryDeps;
}

const deliver = (d: CustomDeliver, deps: CustomDeliveryDeps) =>
  deliverCustomAgentResult({ tenant_id: T1, run_id: "run-1", agent_name: "Standup", deliver: d, text: "hello" }, deps);

describe("deliverCustomAgentResult: one switch, all six kinds", () => {
  it("chat_thread posts into this tenant's thread", async () => {
    const d = senders();
    expect(await deliver({ kind: "chat_thread", thread_id: THREAD }, d)).toBeNull();
    expect(d.postToThread).toHaveBeenCalledWith({ tenant_id: T1, thread_id: THREAD, body: "hello" });
  });

  it("chat_thread REJECTS another tenant's thread and sends nothing", async () => {
    const d = senders();
    expect(await deliver({ kind: "chat_thread", thread_id: OTHER_THREAD }, d)).toMatch(/not found for tenant/);
    expect(d.postToThread).not.toHaveBeenCalled();
  });

  it("slack_thread posts in the thread", async () => {
    const d = senders();
    await deliver({ kind: "slack_thread", channel_id: "C123", thread_ts: "1.2", team_id: "T9" }, d);
    expect(d.postToSlack).toHaveBeenCalledWith({ tenant_id: T1, channel_id: "C123", thread_ts: "1.2", team_id: "T9", text: "hello" });
  });

  it("slack_channel posts in the channel", async () => {
    const d = senders();
    await deliver({ kind: "slack_channel", channel_id: "C123" }, d);
    expect(d.postToSlack).toHaveBeenCalledWith({ tenant_id: T1, channel_id: "C123", text: "hello" });
  });

  it("slack_dm DMs the member, and falls back to the thread when the DM fails", async () => {
    const ok = senders();
    await deliver({ kind: "slack_dm", slack_user_id: "U1" }, ok);
    expect(ok.postToSlackDm).toHaveBeenCalledWith({ tenant_id: T1, slack_user_id: "U1", text: "hello" });

    const dmFails = senders({ postToSlackDm: vi.fn(async () => "missing_scope") });
    const err = await deliver(
      { kind: "slack_dm", slack_user_id: "U1", fallback: { kind: "slack_thread", channel_id: "C1", thread_ts: "9.9" } },
      dmFails,
    );
    expect(err).toBeNull();
    expect(dmFails.postToSlack).toHaveBeenCalledWith({ tenant_id: T1, channel_id: "C1", thread_ts: "9.9", text: "hello" });
  });

  it("whatsapp sends on the bound number", async () => {
    const d = senders();
    await deliver({ kind: "whatsapp", wa_id: "15550001", phone_number_id: "PN1" }, d);
    expect(d.postToWhatsApp).toHaveBeenCalledWith({ tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", text: "hello" });
  });

  it("email goes to the tenant's list; no address rides in", async () => {
    const d = senders();
    await deliver({ kind: "email" } as CustomDeliver, d);
    expect(d.postToEmail).toHaveBeenCalledWith({ tenant_id: T1, run_id: "run-1", agent_name: "Standup", body: "hello" });
  });

  it("a destination outside the schema is refused before any send", async () => {
    const d = senders();
    const err = await deliver({ kind: "email", to: "x@evil.test" } as unknown as CustomDeliver, d);
    expect(err).toBe("destination malformed");
    expect(d.postToEmail).not.toHaveBeenCalled();
  });

  it("the body is scrubbed on the way out", async () => {
    const d = senders({ scrub: vi.fn(() => "SCRUBBED") });
    await deliver({ kind: "slack_channel", channel_id: "C123" }, d);
    expect(d.postToSlack).toHaveBeenCalledWith(expect.objectContaining({ text: "SCRUBBED" }));
  });

  it("a throwing sender is an error string, never a throw", async () => {
    const d = senders({ postToSlack: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await deliver({ kind: "slack_channel", channel_id: "C123" }, d)).toBe("boom");
  });
});

type AgentState = { id: string; name: string; status: string; default_deliver: unknown; failures: number; last_key: string | null; credits_notice_at: string | null };
type TriggerState = { id: string; agent_id: string; deliver: unknown; summary: string | null };

function world(opts: { deliver?: unknown; agentDeliver?: unknown; send?: Partial<CustomDeliveryDeps> } = {}) {
  const agent: AgentState = {
    id: AGENT,
    name: "Standup",
    status: "active",
    default_deliver: opts.agentDeliver === undefined ? { kind: "chat_thread", thread_id: THREAD } : opts.agentDeliver,
    failures: 0,
    last_key: null,
    credits_notice_at: null,
  };
  const trig: TriggerState = { id: TRIG, agent_id: AGENT, deliver: opts.deliver ?? null, summary: null };
  const deps = senders(opts.send);
  const seams: CustomRunSeams = {
    loadAgent: async (t, id) => (t === T1 && id === agent.id ? { id: agent.id, name: agent.name, status: agent.status, default_deliver: agent.default_deliver } : null),
    loadAgentBySlug: async (t, slug) => (t === T1 && slug === SLUG ? { id: agent.id, name: agent.name, status: agent.status, default_deliver: agent.default_deliver } : null),
    loadTrigger: async (t, id) => (t === T1 && id === trig.id ? { id: trig.id, agent_id: trig.agent_id, deliver: trig.deliver } : null),
    recordOutcome: vi.fn(async (a) => {
      if (a.key && agent.last_key === a.key) return { failures: agent.failures, just_paused: false, applied: false };
      agent.last_key = a.key;
      agent.credits_notice_at = null;
      if (a.outcome === "delivered") {
        agent.failures = 0;
        if (a.summary != null) trig.summary = a.summary.slice(0, 2048);
        return { failures: 0, just_paused: false, applied: true };
      }
      agent.failures += 1;
      const pause = agent.failures >= 3 && agent.status === "active";
      if (pause) agent.status = "paused";
      return { failures: agent.failures, just_paused: pause, applied: true };
    }),
    claimCreditsNotice: vi.fn(async () => {
      if (agent.credits_notice_at) return false;
      agent.credits_notice_at = "now";
      return true;
    }),
    delivery: async () => deps,
    warn: vi.fn(),
  };
  return { agent, trig, deps, seams };
}

const finish = (w: ReturnType<typeof world>, over: Partial<Parameters<typeof finishCustomAgentRun>[0]> = {}) =>
  finishCustomAgentRun(
    {
      tenant_id: T1,
      run_id: over.run_id ?? "run-1",
      agent_slug: SLUG,
      custom_agent_id: AGENT,
      custom_trigger_id: TRIG,
      payload: { custom_agent: { trigger_id: TRIG } },
      status: "success",
      output_text: "Shipped 3 PRs.",
      will_retry: false,
      ...over,
    },
    w.seams,
  );

describe("finishCustomAgentRun", () => {
  it("delivers the result, writes the summary and resets failures", async () => {
    const w = world();
    w.agent.failures = 2;
    expect(await finish(w)).toBe("delivered");
    expect(w.deps.postToThread).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: THREAD, body: expect.stringContaining("Shipped 3 PRs.") }),
    );
    expect(w.trig.summary).toBe("Shipped 3 PRs.");
    expect(w.agent.failures).toBe(0);
  });

  it("the summary is plain truncation to 2 KB and feeds the next fire's payload", async () => {
    const w = world();
    await finish(w, { output_text: "x".repeat(5000) });
    expect(w.trig.summary).toHaveLength(CUSTOM_SUMMARY_MAX);
    const next = buildCustomSchedulePayload({ id: TRIG, last_result_summary: w.trig.summary });
    expect(next.task_description).toContain("Since last time");
    expect(next.task_description).toContain(w.trig.summary!);
  });

  it("the trigger's own destination wins over the agent default", async () => {
    const w = world({ deliver: { kind: "slack_channel", channel_id: "C777" } });
    await finish(w);
    expect(w.deps.postToSlack).toHaveBeenCalledWith(expect.objectContaining({ channel_id: "C777" }));
    expect(w.deps.postToThread).not.toHaveBeenCalled();
  });

  it("no destination anywhere: nothing sent, counts as done, summary kept", async () => {
    const w = world({ agentDeliver: null });
    expect(await finish(w)).toBe("no_destination");
    expect(w.trig.summary).toBe("Shipped 3 PRs.");
  });

  it("a member cancel never counts and sends nothing", async () => {
    const w = world();
    expect(await finish(w, { status: "cancelled" })).toBe("skipped_cancelled");
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });

  it("a failed run that infra-retry will re-run is not counted yet", async () => {
    const w = world();
    expect(await finish(w, { status: "error", will_retry: true })).toBe("skipped_retrying");
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });

  it("a run our model provider refused is not the agent's failure: not counted, the outage retry may run it", async () => {
    const w = world();
    expect(
      await finish(w, {
        status: "error",
        error: "money-path run not auto-retried (c-1a2b): Claude Code returned an error result: You've hit your limit · resets 7pm (UTC)",
      }),
    ).toBe("skipped_outage");
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
    expect(await finish(w, { status: "error", error: "boom" })).toBe("failed_run");
    expect(w.seams.recordOutcome).toHaveBeenCalledTimes(1);
  });

  it("a failed run counts once, even if the hook runs twice for it", async () => {
    const w = world();
    await finish(w, { status: "error" });
    await finish(w, { status: "error" });
    expect(w.agent.failures).toBe(1);
  });

  it("an undeliverable result counts as a failure and keeps the old summary", async () => {
    const w = world({ send: { postToThread: vi.fn(async () => "insert failed") } });
    w.trig.summary = "old";
    expect(await finish(w)).toBe("failed_delivery");
    expect(w.agent.failures).toBe(1);
    expect(w.trig.summary).toBe("old");
  });

  it("3 failures in a row pause the agent and send exactly ONE notice", async () => {
    const w = world();
    await finish(w, { run_id: "r1", status: "error" });
    await finish(w, { run_id: "r2", status: "failed" });
    expect(w.agent.status).toBe("active");
    await finish(w, { run_id: "r3", status: "error" });
    expect(w.agent.status).toBe("paused");
    await finish(w, { run_id: "r4", status: "error" });
    const notices = (w.deps.postToThread as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { body: string }).body === composeCustomPauseNotice("Standup"),
    );
    expect(notices).toHaveLength(1);
  });

  it("a delivered success between failures resets the streak", async () => {
    const w = world();
    await finish(w, { run_id: "r1", status: "error" });
    await finish(w, { run_id: "r2", status: "error" });
    await finish(w, { run_id: "r3" });
    await finish(w, { run_id: "r4", status: "error" });
    expect(w.agent.failures).toBe(1);
    expect(w.agent.status).toBe("active");
  });

  it("a trigger that is not this agent's is ignored", async () => {
    const w = world();
    w.trig.agent_id = "someone-else";
    expect(await finish(w)).toBe("skipped_missing");
    expect(w.deps.postToThread).not.toHaveBeenCalled();
  });
});

describe("finishCustomAgentRun: the stamp is best-effort, delivery is not", () => {
  it("stamp present: delivers via the stamped ids", async () => {
    const w = world();
    expect(await finish(w, { payload: null })).toBe("delivered");
  });

  it("stamp missing: falls back to the payload's trigger id for this run's own agent", async () => {
    const w = world();
    expect(await finish(w, { custom_agent_id: null, custom_trigger_id: null })).toBe("delivered");
    expect(w.deps.postToThread).toHaveBeenCalledTimes(1);
    expect(w.trig.summary).toBe("Shipped 3 PRs.");
  });

  it("stamp missing: a payload trigger of ANOTHER agent is rejected, nothing sent", async () => {
    const w = world();
    w.trig.agent_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    expect(await finish(w, { custom_agent_id: null, custom_trigger_id: null })).toBe("skipped_missing");
    expect(w.deps.postToThread).not.toHaveBeenCalled();
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });

  it("stamp missing: a run in another tenant cannot reach this tenant's trigger", async () => {
    const w = world();
    expect(
      await finish(w, { tenant_id: T2, custom_agent_id: null, custom_trigger_id: null }),
    ).toBe("skipped_missing");
    expect(w.deps.postToThread).not.toHaveBeenCalled();
  });

  it("stamp missing and no payload trigger: nothing delivered", async () => {
    const w = world();
    expect(await finish(w, { custom_agent_id: null, custom_trigger_id: null, payload: {} })).toBe("skipped_missing");
  });
});

describe("a setup-blocked result is emailed once (PR2 item 7)", () => {
  const blockA = setupBlockKey({ envelope_kind: "setup_required", missing_connectors: ["slack", "github"], missing_vault_keys: [] })!;
  const blockB = setupBlockKey({ envelope_kind: "setup_required", missing_connectors: ["hubspot"], missing_vault_keys: [] })!;
  const withStore = (w: ReturnType<typeof world>) => {
    const store = { last: null as string | null };
    w.seams.readSetupBlockEmailed = vi.fn(async (t, id) => (t === T1 && id === TRIG ? store.last : null));
    w.seams.writeSetupBlockEmailed = vi.fn(async (_t, _a, _id, key) => {
      store.last = key;
    });
    return store;
  };
  const run = (w: ReturnType<typeof world>, n: number, setup: string | null) =>
    finish(w, { run_id: `r-${n}`, setup_required: setup, output_text: setup ? "Setup needed: connect Slack." : "Real result." });

  it("the key is stable: same connectors in any order are one block; a non-setup result has none", () => {
    expect(setupBlockKey({ envelope_kind: "setup_required", missing_connectors: ["github", "slack"], missing_vault_keys: [] })).toBe(blockA);
    expect(blockA).not.toBe(blockB);
    expect(setupBlockKey({ envelope_kind: "other" })).toBeNull();
    expect(setupBlockKey(null)).toBeNull();
  });

  it("two consecutive blocked results -> one email (ready email path)", async () => {
    const w = world();
    withStore(w);
    await run(w, 1, blockA);
    await run(w, 2, blockA);
    expect(w.deps.postToEmail).toHaveBeenCalledTimes(1);
    expect(w.deps.postToThread).toHaveBeenCalledTimes(2);
  });

  it("an email destination: the second identical block is not sent, and is not a failure", async () => {
    const w = world({ deliver: { kind: "email" } });
    withStore(w);
    expect(await run(w, 1, blockA)).toBe("delivered");
    expect(await run(w, 2, blockA)).toBe("setup_repeat_not_emailed");
    expect(w.deps.postToEmail).toHaveBeenCalledTimes(1);
    expect(w.agent.failures).toBe(0);
  });

  it("setup A -> real -> setup A emails all three; a different setup reason is emailed", async () => {
    const w = world();
    const store = withStore(w);
    await run(w, 1, blockA);
    await run(w, 2, null);
    expect(store.last).toBeNull();
    await run(w, 3, blockA);
    await run(w, 4, blockB);
    expect(w.deps.postToEmail).toHaveBeenCalledTimes(4);
    expect(store.last).toBe(blockB);
  });

  it("a watch trigger's setup block: the first is emailed once and is not a failure; the second identical is not emailed", async () => {
    const w = world();
    withStore(w);
    w.seams.loadTrigger = async (t, id) => (t === T1 && id === TRIG ? { id: TRIG, agent_id: AGENT, deliver: null, kind: "watch", last_fingerprint: null } : null);
    expect(await run(w, 1, blockA)).toBe("delivered");
    expect(await run(w, 2, blockA)).toBe("delivered");
    expect(w.deps.postToEmail).toHaveBeenCalledTimes(1);
    expect(w.agent.failures).toBe(0);
    expect(w.agent.status).toBe("active");
  });

  it("the marker is written only after a send that went out", async () => {
    const w = world({ send: { postToEmail: vi.fn(async () => "smtp down") } });
    const store = withStore(w);
    await run(w, 1, blockA);
    expect(store.last).toBeNull();
    await run(w, 2, blockA);
    expect(w.deps.postToEmail).toHaveBeenCalledTimes(2);
  });
});

describe("recordCustomAgentFailure (fire-time invalid config)", () => {
  it("the third invalid fire pauses and notifies once", async () => {
    const w = world();
    for (const b of ["b1", "b2", "b3"]) {
      await recordCustomAgentFailure({ tenant_id: T1, agent_id: AGENT, trigger_id: TRIG, key: `invalid:${TRIG}:${b}` }, w.seams);
    }
    expect(w.agent.status).toBe("paused");
    expect(w.deps.postToThread).toHaveBeenCalledTimes(1);
  });
});

describe("noteCustomAgentCreditSkip: one notice per episode", () => {
  it("first skip notifies, later skips are silent, a run ends the episode", async () => {
    const w = world();
    expect(await noteCustomAgentCreditSkip(T1, TRIG, w.seams)).toBe("notified");
    expect(await noteCustomAgentCreditSkip(T1, TRIG, w.seams)).toBe("already_notified");
    expect(w.deps.postToThread).toHaveBeenCalledTimes(1);
    expect(w.deps.postToThread).toHaveBeenCalledWith(
      expect.objectContaining({ body: composeCustomCreditsNotice("Standup") }),
    );
    await finish(w);
    expect(w.agent.credits_notice_at).toBeNull();
    expect(await noteCustomAgentCreditSkip(T1, TRIG, w.seams)).toBe("notified");
  });

  it("a notice that did not go out is given back, so the next skip tries again", async () => {
    const w = world({ send: { postToThread: vi.fn(async () => "thread insert failed") } });
    w.seams.releaseCreditsNotice = vi.fn(async () => {
      w.agent.credits_notice_at = null;
    });
    expect(await noteCustomAgentCreditSkip(T1, TRIG, w.seams)).toBe("skipped");
    expect(w.seams.releaseCreditsNotice).toHaveBeenCalledWith(T1, w.agent.id);
    expect(w.agent.credits_notice_at).toBeNull();
    expect(await noteCustomAgentCreditSkip(T1, TRIG, w.seams)).toBe("skipped");
    expect(w.deps.postToThread).toHaveBeenCalledTimes(2);
  });

  it("a credit skip is not a failure", async () => {
    const w = world();
    await noteCustomAgentCreditSkip(T1, TRIG, w.seams);
    expect(w.agent.failures).toBe(0);
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });
});

describe("customTriggerIdFromPayload", () => {
  it("reads only a uuid under custom_agent.trigger_id", () => {
    expect(customTriggerIdFromPayload(buildCustomSchedulePayload({ id: TRIG, last_result_summary: null }))).toBe(TRIG);
    expect(customTriggerIdFromPayload({ custom_agent: { trigger_id: "x; drop" } })).toBeNull();
    expect(customTriggerIdFromPayload({ trigger_id: TRIG })).toBeNull();
    expect(customTriggerIdFromPayload(null)).toBeNull();
  });
});

describe("notices by email link to the agent's page", () => {
  it("a pause notice to an email destination carries the agent id", async () => {
    const w = world({ agentDeliver: { kind: "email" } });
    for (const r of ["r1", "r2", "r3"]) await finish(w, { run_id: r, status: "error" });
    expect(w.deps.postToEmail).toHaveBeenCalledWith(
      expect.objectContaining({ notice_agent_id: AGENT, body: composeCustomPauseNotice("Standup") }),
    );
  });

  it("a result email does not (it links to the run)", async () => {
    const w = world({ agentDeliver: { kind: "email" } });
    await finish(w);
    expect((w.deps.postToEmail as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty("notice_agent_id");
  });

  it("the production email sender turns it into the Agent Builder deep link", async () => {
    email.send.mockClear();
    const deps = await defaultCustomDeliveryDeps((t) => t);
    await deps.postToEmail({ tenant_id: T1, run_id: "", agent_name: "Standup", body: "b", notice_agent_id: AGENT });
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_slug: "Standup",
        link: { path: `/workspace?tab=agent-builder&agent=${AGENT}`, text: CUSTOM_NOTICE_EMAIL_CTA },
      }),
    );
    expect(customAgentPagePath(AGENT)).toBe(`/workspace?tab=agent-builder&agent=${AGENT}`);
    await deps.postToEmail({ tenant_id: T1, run_id: "run-9", agent_name: "Standup", body: "b" });
    expect(email.send.mock.calls[1][0]).not.toHaveProperty("link");
  });
});

describe("notice copy", () => {
  it("empty output reads plainly", () => {
    expect(composeCustomResultBody("A", "  ")).toBe('From your agent "A":\n\nThe run finished without any output.');
  });

  it("has no em-dashes", () => {
    for (const s of [composeCustomPauseNotice("A"), composeCustomCreditsNotice("A")]) {
      expect(s).not.toMatch(/—/);
    }
  });
});

describe("20260927220000_custom_agent_schedules.sql", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../../../supabase/migrations/20260927220000_custom_agent_schedules.sql"),
    "utf-8",
  );
  const s1 = readFileSync(
    join(__dirname, "../../../../../../supabase/migrations/20260926120000_custom_agents.sql"),
    "utf-8",
  );

  it("record_custom_agent_outcome is service-role only and pins pg_temp", () => {
    expect(sql).toMatch(/record_custom_agent_outcome[\s\S]*security definer set search_path = public, pg_temp/);
    expect(sql).toMatch(/auth\.role\(\) is distinct from 'service_role'/);
    expect(sql).toMatch(/revoke all on function record_custom_agent_outcome\([^)]*\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function record_custom_agent_outcome\([^)]*\) to service_role;/);
  });

  it("re-created set_custom_agent_status is S1's body plus exactly the marked line", () => {
    const body = (src: string) => {
      const start = src.indexOf("create or replace function set_custom_agent_status(");
      return src.slice(start, src.indexOf("end $$;", start) + "end $$;".length);
    };
    const mine = body(sql)
      .split("\n")
      .filter((l) => !l.includes("-- custom agents (S2)"))
      .join("\n");
    expect(mine).toBe(body(s1));
  });
});

const PARK = { agent_id: AGENT, trigger_id: TRIG, run_id: "run-1", summary: "Shipped 3 PRs." };

type WaRow = { id: string; tenant_id: string; wa_id: string; phone_number_id: string; run_id: string | null; text: string; nudged_at: string | null; delivered_at: string | null };
function waSeams(over: Partial<WhatsAppSeams> = {}, seed: WaRow[] = []) {
  const rows: WaRow[] = seed.map((r) => ({ ...r }));
  let n = 0;
  const seams = {
    ownsNumber: vi.fn(() => true),
    binding: vi.fn(async () => ({ window_expires_at: "2026-09-28T00:00:00.000Z" })),
    windowIsOpen: vi.fn(() => false),
    send: vi.fn(async () => ({ ok: true as const })),
    nudge: vi.fn(async () => ({ ok: true })),
    hasPending: vi.fn(async (a: { tenant_id: string; wa_id: string; phone_number_id: string }) =>
      rows.some((r) => r.tenant_id === a.tenant_id && r.wa_id === a.wa_id && r.phone_number_id === a.phone_number_id && !r.delivered_at && r.nudged_at != null),
    ),
    park: vi.fn(async (a: { tenant_id: string; wa_id: string; phone_number_id: string; text: string; park: { run_id: string | null } }): Promise<ParkResult> => {
      const ex = a.park.run_id ? rows.find((r) => r.run_id === a.park.run_id) : undefined;
      if (ex) return { kind: "duplicate", id: ex.id, nudged: ex.nudged_at != null, delivered: ex.delivered_at != null };
      const id = `row-${++n}`;
      rows.push({ id, tenant_id: a.tenant_id, wa_id: a.wa_id, phone_number_id: a.phone_number_id, run_id: a.park.run_id, text: a.text, nudged_at: null, delivered_at: null });
      return { kind: "inserted", id };
    }),
    markNudged: vi.fn(async (a: { tenant_id: string; id: string }): Promise<string | null> => {
      const r = rows.find((x) => x.id === a.id && x.tenant_id === a.tenant_id);
      if (!r) return "no parked row matched";
      r.nudged_at = "now";
      return null;
    }),
    discard: vi.fn(async (a: { tenant_id: string; id: string }) => {
      const i = rows.findIndex((x) => x.id === a.id && x.tenant_id === a.tenant_id);
      if (i >= 0) rows.splice(i, 1);
      return null as string | null;
    }),
    warn: vi.fn(),
    ...over,
  };
  return { seams: seams as unknown as WhatsAppSeams & typeof seams, rows, parked: rows };
}

describe("sendOrParkWhatsApp", () => {
  const msg = { tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", text: "result" };
  const NOTICE = { agent_id: AGENT, trigger_id: null, run_id: null, summary: null };

  it("window open: sends the text, nothing parked, no template", async () => {
    const w = waSeams({ windowIsOpen: vi.fn(() => true) });
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBeNull();
    expect(w.seams.send).toHaveBeenCalledTimes(1);
    expect(w.seams.nudge).not.toHaveBeenCalled();
    expect(w.rows).toHaveLength(0);
  });

  it("window closed: parks, nudges, stamps nudged_at, returns PENDING", async () => {
    const w = waSeams();
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.seams.nudge).toHaveBeenCalledWith({ wa_id: "15550001" });
    expect(w.rows).toEqual([expect.objectContaining({ tenant_id: T1, run_id: "run-1", text: "result", nudged_at: "now" })]);
  });

  it("a rejected nudge deletes the row it parked (by id) and is a failed delivery", async () => {
    const w = waSeams({ nudge: vi.fn(async () => ({ ok: false, error: "template rejected" })) });
    const err = await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams);
    expect(err).toMatch(/nudge template failed: template rejected/);
    expect(w.seams.discard).toHaveBeenCalledWith({ tenant_id: T1, id: "row-1" });
    expect(w.rows).toHaveLength(0);
  });

  it("a nudge that THROWS deletes the row and returns an error", async () => {
    const w = waSeams({ nudge: vi.fn(async () => { throw new Error("meta 500"); }) });
    const err = await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams);
    expect(err).toMatch(/nudge template failed: meta 500/);
    expect(w.rows).toHaveLength(0);
  });

  it("if the row cannot be removed after a failed nudge, it is an error, not pending", async () => {
    const w = waSeams({
      nudge: vi.fn(async () => ({ ok: false, error: "rejected" })),
      discard: vi.fn(async () => "db down"),
    });
    const err = await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams);
    expect(err).toMatch(/could not be removed: db down/);
    expect(err).not.toBe(CUSTOM_WHATSAPP_PENDING);
  });

  it("a failed park sends no nudge", async () => {
    const w = waSeams({ park: vi.fn(async (): Promise<ParkResult> => ({ kind: "error", error: "db down" })) });
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toMatch(/whatsapp park failed: db down/);
    expect(w.seams.nudge).not.toHaveBeenCalled();
  });

  it("duplicate park of an already-nudged run: handled, no second nudge", async () => {
    const w = waSeams({}, [
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-1", text: "result", nudged_at: "t", delivered_at: null },
    ]);
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.seams.nudge).not.toHaveBeenCalled();
    expect(w.rows).toHaveLength(1);
  });

  it("crash after park (row exists, never nudged): the retry sends the nudge for it", async () => {
    const w = waSeams({}, [
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-1", text: "result", nudged_at: null, delivered_at: null },
    ]);
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.seams.nudge).toHaveBeenCalledTimes(1);
    expect(w.rows).toEqual([expect.objectContaining({ id: "old", nudged_at: "now" })]);
  });

  it("duplicate park + failed nudge KEEPS the existing row and stays pending (a flush still sends it)", async () => {
    const w = waSeams({ nudge: vi.fn(async () => ({ ok: false, error: "rejected" })) }, [
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-1", text: "result", nudged_at: null, delivered_at: null },
    ]);
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.seams.discard).not.toHaveBeenCalled();
    expect(w.rows.map((r) => r.id)).toEqual(["old"]);
  });

  it("duplicate park of a row a flush has CLAIMED: pending (the flush owns the receipt), no nudge, never delivered", async () => {
    const w = waSeams({}, [
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-1", text: "result", nudged_at: "t", delivered_at: "t2" },
    ]);
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.seams.nudge).not.toHaveBeenCalled();
    const w2 = waSeams({}, [
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-1", text: "result", nudged_at: null, delivered_at: "t2" },
    ]);
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w2.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w2.seams.nudge).not.toHaveBeenCalled();
  });

  it("an un-nudged duplicate covered by ANOTHER nudged row: stamped, no second template", async () => {
    const w = waSeams({}, [
      { id: "cover", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-0", text: "earlier", nudged_at: "t", delivered_at: null },
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-1", text: "result", nudged_at: null, delivered_at: null },
    ]);
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.seams.nudge).not.toHaveBeenCalled();
    expect(w.rows.find((r) => r.id === "old")!.nudged_at).toBe("now");
  });

  it("a nudged_at stamp that fails is not reported as recorded: warned, row left un-nudged, still pending", async () => {
    const w = waSeams({ markNudged: vi.fn(async () => "db down") });
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.rows[0].nudged_at).toBeNull();
    expect(w.seams.warn).toHaveBeenCalledWith(expect.stringContaining("nudge not recorded"));
  });

  it("already waiting (a NUDGED row exists): parks the new one without a second nudge", async () => {
    const w = waSeams({}, [
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-0", text: "earlier", nudged_at: "t", delivered_at: null },
    ]);
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toBe(CUSTOM_WHATSAPP_PENDING);
    expect(w.seams.nudge).not.toHaveBeenCalled();
    expect(w.rows).toHaveLength(2);
  });

  it("an un-nudged row does not count as waiting: the new result still nudges", async () => {
    const w = waSeams({}, [
      { id: "old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: "run-0", text: "earlier", nudged_at: null, delivered_at: null },
    ]);
    await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams);
    expect(w.seams.nudge).toHaveBeenCalledTimes(1);
  });

  it("a failed nudge for a NOTICE (null run_id) never deletes another notice", async () => {
    const w = waSeams({ nudge: vi.fn(async () => ({ ok: false, error: "rejected" })) }, [
      { id: "n-old", tenant_id: T1, wa_id: "15550001", phone_number_id: "PN1", run_id: null, text: "same notice text", nudged_at: null, delivered_at: null },
    ]);
    await sendOrParkWhatsApp({ ...msg, text: "same notice text", park: NOTICE }, w.seams);
    expect(w.rows.map((r) => r.id)).toEqual(["n-old"]);
  });

  it("not this host's number: defers, sends nothing", async () => {
    const w = waSeams({ ownsNumber: vi.fn(() => false) });
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toMatch(/^__defer__:/);
    expect(w.seams.binding).not.toHaveBeenCalled();
  });

  it("a thread no longer bound to this tenant: error, nothing parked", async () => {
    const w = waSeams({ binding: vi.fn(async () => null) });
    expect(await sendOrParkWhatsApp({ ...msg, park: PARK }, w.seams)).toMatch(/no longer enabled/);
    expect(w.rows).toHaveLength(0);
  });
});

describe("finishCustomAgentRun: WhatsApp pending and defer", () => {
  const waDest = { kind: "whatsapp", wa_id: "15550001", phone_number_id: "PN1" };

  it("window closed: result parked, NOT counted delivered, summary not written yet", async () => {
    const w = world({ agentDeliver: waDest, send: { postToWhatsApp: vi.fn(async () => CUSTOM_WHATSAPP_PENDING) } });
    w.agent.failures = 2;
    expect(await finish(w)).toBe("pending_whatsapp");
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
    expect(w.agent.failures).toBe(2);
    expect(w.trig.summary).toBeNull();
    expect(w.deps.postToWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ park: { agent_id: AGENT, trigger_id: TRIG, run_id: "run-1", summary: "Shipped 3 PRs." } }),
    );
  });

  it("a failed nudge counts toward the pause like any failed send", async () => {
    const w = world({
      agentDeliver: waDest,
      send: { postToWhatsApp: vi.fn(async () => "whatsapp window closed and nudge template failed: rejected") },
    });
    for (const r of ["r1", "r2", "r3"]) expect(await finish(w, { run_id: r })).toBe("failed_delivery");
    expect(w.agent.status).toBe("paused");
  });

  it("another host's number: not a failure, never pauses", async () => {
    const w = world({
      agentDeliver: waDest,
      send: { postToWhatsApp: vi.fn(async () => "__defer__:whatsapp number PN1 is not served by this host") },
    });
    for (const r of ["r1", "r2", "r3", "r4"]) expect(await finish(w, { run_id: r })).toBe("deferred");
    expect(w.agent.failures).toBe(0);
    expect(w.agent.status).toBe("active");
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });

  it("a destination that could not be checked (Discord down): not a failure, never pauses", async () => {
    const w = world({
      agentDeliver: waDest,
      send: { postToWhatsApp: vi.fn(async () => "__transient__:discord channel lookup failed") },
    });
    for (const r of ["r1", "r2", "r3", "r4"]) expect(await finish(w, { run_id: r })).toBe("transient_delivery");
    expect(w.agent.failures).toBe(0);
    expect(w.agent.status).toBe("active");
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });
});

describe("flushCustomAgentWhatsAppPending (inbound message)", () => {
  type Row = PendingWhatsAppRow & { tenant_id: string; wa_id: string; phone_number_id: string; delivered_at: string | null };
  function flushWorld(rows: Row[], sendOk = true) {
    const recorded: unknown[] = [];
    const sent: string[] = [];
    const wa = waSeams({
      binding: vi.fn(async () => ({ window_expires_at: "2099-01-01T00:00:00.000Z" })),
      send: vi.fn(async (a: { text: string }) => {
        if (!sendOk) return { ok: false as const, sent: 0, error: "boom" };
        sent.push(a.text);
        return { ok: true as const };
      }),
    });
    const seams: FlushSeams = {
      loadPending: async (t, pn, wid, limit) =>
        rows.filter((r) => r.tenant_id === t && r.phone_number_id === pn && r.wa_id === wid && !r.delivered_at).slice(0, limit),
      claim: async (t, id) => {
        const r = rows.find((x) => x.id === id && x.tenant_id === t);
        if (!r || r.delivered_at) return false;
        r.delivered_at = "now";
        return true;
      },
      unclaim: async (t, id) => {
        const r = rows.find((x) => x.id === id && x.tenant_id === t);
        if (r) r.delivered_at = null;
      },
      whatsapp: async () => wa.seams,
      recordOutcome: vi.fn(async (a) => (recorded.push(a), { failures: 0, just_paused: false, applied: true })),
      warn: vi.fn(),
    };
    return { seams, sent, recorded, rows };
  }
  const row = (over: Partial<Row>): Row => ({
    id: "p1",
    tenant_id: T1,
    agent_id: AGENT,
    trigger_id: TRIG,
    run_id: "run-1",
    wa_id: "15550001",
    phone_number_id: "PN1",
    text: "the result",
    summary: "Shipped 3 PRs.",
    delivered_at: null,
    ...over,
  });
  const inbound = { tenant_id: T1, phone_number_id: "PN1", wa_id: "15550001" };

  it("delivers the parked result once, marks it delivered, counts it delivered with its summary", async () => {
    const w = flushWorld([row({})]);
    expect(await flushCustomAgentWhatsAppPending(inbound, w.seams)).toBe(1);
    expect(await flushCustomAgentWhatsAppPending(inbound, w.seams)).toBe(0);
    expect(w.sent).toEqual(["the result"]);
    expect(w.rows[0].delivered_at).not.toBeNull();
    expect(w.recorded).toEqual([
      expect.objectContaining({ tenant_id: T1, agent_id: AGENT, trigger_id: TRIG, outcome: "delivered", key: "run:run-1", summary: "Shipped 3 PRs." }),
    ]);
  });

  it("a parked NOTICE is sent but counts nothing", async () => {
    const w = flushWorld([row({ run_id: null, trigger_id: null, summary: null, text: "notice" })]);
    await flushCustomAgentWhatsAppPending(inbound, w.seams);
    expect(w.sent).toEqual(["notice"]);
    expect(w.recorded).toHaveLength(0);
  });

  it("another tenant's row for the same wa_id is never delivered", async () => {
    const w = flushWorld([row({ id: "pB", tenant_id: T2, text: "tenant B secret" })]);
    expect(await flushCustomAgentWhatsAppPending(inbound, w.seams)).toBe(0);
    expect(w.sent).toHaveLength(0);
    expect(w.rows[0].delivered_at).toBeNull();
  });

  it("a failed send is given back for the next message", async () => {
    const w = flushWorld([row({})], false);
    expect(await flushCustomAgentWhatsAppPending(inbound, w.seams)).toBe(0);
    expect(w.rows[0].delivered_at).toBeNull();
    expect(w.recorded).toHaveLength(0);
  });
});

describe("settleCustomAgentAltTerminal", () => {
  const reaped = (over: Record<string, unknown> = {}) => ({
    id: "run-w",
    tenant_id: T1,
    agent_slug: SLUG,
    trigger: "cron",
    status: "failed",
    error: "watchdog_reap: no progress for >30min (trigger=cron)",
    infra_retry_count: 0,
    last_progress_at: "2026-09-28T16:01:00.000Z",
    payload: { custom_agent: { trigger_id: TRIG } },
    custom_agent_id: AGENT,
    custom_trigger_id: TRIG,
    ...over,
  });

  it("a watchdog-reaped scheduled custom run counts one failure (idempotent)", async () => {
    const w = world();
    expect(await settleCustomAgentAltTerminal(reaped(), w.seams)).toBe("failed_run");
    expect(await settleCustomAgentAltTerminal(reaped(), w.seams)).toBe("failed_run");
    expect(w.agent.failures).toBe(1);
  });

  it("three reaped runs pause the agent with one notice", async () => {
    const w = world();
    for (const id of ["a", "b", "c"]) await settleCustomAgentAltTerminal(reaped({ id }), w.seams);
    expect(w.agent.status).toBe("paused");
    expect(w.deps.postToThread).toHaveBeenCalledTimes(1);
  });

  it("a reap with no progress still counts: a custom run is never infra-retried (it may have written)", async () => {
    const w = world();
    expect(await settleCustomAgentAltTerminal(reaped({ last_progress_at: null }), w.seams)).toBe("failed_run");
    expect(w.agent.failures).toBe(1);
  });

  it("a built-in agent or a non-cron run is untouched", async () => {
    const w = world();
    expect(await settleCustomAgentAltTerminal(reaped({ agent_slug: "operator" }), w.seams)).toBe("not_custom");
    expect(await settleCustomAgentAltTerminal(reaped({ trigger: "manual" }), w.seams)).toBe("not_custom");
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });
});

describe("S3b: a scheduled run that handed off waits for the helper", () => {
  it("parked: nothing sent, nothing counted, until the join delivers", async () => {
    const w = world();
    const park = vi.fn(async () => true);
    w.seams.parkForHandoff = park;
    expect(await finish(w)).toBe("waiting_handoff");
    expect(park).toHaveBeenCalledWith({ tenant_id: T1, run_id: "run-1", output: "Shipped 3 PRs." });
    expect(w.deps.postToThread).not.toHaveBeenCalled();
    expect(w.seams.recordOutcome).not.toHaveBeenCalled();
  });

  it("the join's call (handoff_joined) delivers the combined text, never parks again", async () => {
    const w = world();
    const park = vi.fn(async () => true);
    w.seams.parkForHandoff = park;
    expect(await finish(w, { handoff_joined: true, output_text: "Mine.\n\nWhat Research found:\nTheirs." })).toBe("delivered");
    expect(park).not.toHaveBeenCalled();
    expect(w.deps.postToThread).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((w.deps.postToThread as ReturnType<typeof vi.fn>).mock.calls[0])).toContain("What Research found");
  });

  it("nothing to wait for: delivered at once as before", async () => {
    const w = world();
    w.seams.parkForHandoff = vi.fn(async () => false);
    expect(await finish(w)).toBe("delivered");
  });

  it("a failed run never parks (its failure is counted now)", async () => {
    const w = world();
    const park = vi.fn(async () => true);
    w.seams.parkForHandoff = park;
    expect(await finish(w, { status: "error" })).toBe("failed_run");
    expect(park).not.toHaveBeenCalled();
  });
});

describe("every scheduled result is also emailed (\"<name> is ready\")", () => {
  const readyCall = (w: ReturnType<typeof world>) =>
    (w.deps.postToEmail as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0].ready_agent_id);

  it("a chat result is delivered to chat AND emailed, with the bare output and this agent's id", async () => {
    const w = world();
    expect(await finish(w)).toBe("delivered");
    expect(w.deps.postToThread).toHaveBeenCalledTimes(1);
    const call = readyCall(w);
    expect(call?.[0]).toEqual({ tenant_id: T1, run_id: "run-1", agent_name: "Standup", body: "Shipped 3 PRs.", ready_agent_id: AGENT });
  });

  it("goes through the same egress scrub as every destination", async () => {
    const w = world({ send: { scrub: vi.fn((t: string) => t.replace("secret", "[redacted]")) } });
    await finish(w, { output_text: "the secret plan" });
    expect(readyCall(w)?.[0].body).toBe("the [redacted] plan");
  });

  it("an email destination is not emailed twice", async () => {
    const w = world({ agentDeliver: { kind: "email" } });
    await finish(w);
    expect(w.deps.postToEmail).toHaveBeenCalledTimes(1);
    expect(readyCall(w)).toBeUndefined();
  });

  it("nothing is emailed for a failed run, a failed delivery, a transient one, or no destination", async () => {
    const failed = world();
    await finish(failed, { status: "error" });
    const undeliverable = world({ send: { postToThread: vi.fn(async () => "boom") } });
    await finish(undeliverable);
    const none = world({ agentDeliver: null });
    await finish(none);
    for (const w of [failed, undeliverable, none]) expect(readyCall(w)).toBeUndefined();
  });

  it("a handoff-parked result is not emailed until the join delivers it", async () => {
    const w = world();
    w.seams.parkForHandoff = vi.fn(async () => true);
    expect(await finish(w)).toBe("waiting_handoff");
    expect(readyCall(w)).toBeUndefined();
    expect(await finish(w, { handoff_joined: true })).toBe("delivered");
    expect(readyCall(w)).toBeDefined();
  });

  it("an email failure is logged as a code (no addresses) and does not change the outcome", async () => {
    const postToEmail = vi.fn(async (p: { ready_agent_id?: string }) =>
      p.ready_agent_id ? "a@b.com: 550 mailbox full" : null,
    );
    const w = world({ send: { postToEmail } as Partial<CustomDeliveryDeps> });
    expect(await finish(w)).toBe("delivered");
    const warns = (w.seams.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warns.some((m) => m.includes("ready email not sent") && m.endsWith("send_failed"))).toBe(true);
    expect(warns.join(" ")).not.toContain("a@b.com");
  });

  it("the production sender links to this run's results page with the locked CTA", async () => {
    email.send.mockClear();
    const deps = await defaultCustomDeliveryDeps((t) => t);
    await deps.postToEmail({ tenant_id: T1, run_id: "run-7", agent_name: "Standup", body: "b", ready_agent_id: AGENT });
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_slug: "Standup",
        thread_owner_slug: "operator",
        ready: true,
        link: { path: customAgentRunPath(AGENT, "run-7", T1), text: CUSTOM_READY_EMAIL_CTA },
      }),
    );
    expect(customAgentRunPath(AGENT, "run-7", T1)).toBe(
      `/workspace?tab=agent-builder&agent=${AGENT}&run=run-7&company=${T1}`,
    );
    expect(CUSTOM_READY_EMAIL_CTA).toBe("See it in Zavi");
  });

  it("the email body is the output alone; a watch leads with its summary", () => {
    expect(composeCustomEmailBody("  body  ")).toBe("body");
    expect(composeCustomEmailBody("details", "Price dropped")).toBe("Price dropped\n\ndetails");
    expect(composeCustomEmailBody("")).toBe("The run finished without any output.");
  });
});

describe("a scheduled run that does not settle pages ops (ids only)", () => {
  const withPager = (w: ReturnType<typeof world>) => {
    const alertFailure = vi.fn(async () => {});
    w.seams.alertFailure = alertFailure;
    return alertFailure;
  };

  it("a failed run pages once with its ids and kind, and never its output", async () => {
    const w = world();
    const pager = withPager(w);
    expect(await finish(w, { status: "error", output_text: "private customer text" })).toBe("failed_run");
    expect(pager).toHaveBeenCalledTimes(1);
    expect(pager).toHaveBeenCalledWith({ tenant_id: T1, run_id: "run-1", agent_slug: SLUG, agent_id: AGENT, kind: "run_failed" });
    expect(JSON.stringify(pager.mock.calls)).not.toContain("private customer text");
  });

  it("pages a failed run even when its agent row is gone", async () => {
    const w = world();
    const pager = withPager(w);
    expect(await finish(w, { status: "failed", custom_agent_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" })).toBe("skipped_missing");
    expect(pager).toHaveBeenCalledWith(expect.objectContaining({ kind: "run_failed" }));
  });

  it("pages a delivery failure, and a finished run whose trigger is gone", async () => {
    const undeliverable = world({ send: { postToThread: vi.fn(async () => "boom") } });
    const p1 = withPager(undeliverable);
    expect(await finish(undeliverable)).toBe("failed_delivery");
    expect(p1).toHaveBeenCalledWith(expect.objectContaining({ kind: "delivery_failed" }));

    const orphan = world();
    const p2 = withPager(orphan);
    expect(await finish(orphan, { custom_trigger_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", payload: {} })).toBe("skipped_missing");
    expect(p2).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent_or_trigger_missing" }));
  });

  it("pages a transient delivery outage without counting it toward auto-pause", async () => {
    const w = world({ send: { postToThread: vi.fn(async () => "__transient__:discord down") } });
    const pager = withPager(w);
    expect(await finish(w)).toBe("transient_delivery");
    expect(pager).toHaveBeenCalledWith(expect.objectContaining({ kind: "delivery_failed" }));
    expect(w.agent.failures).toBe(0);
  });

    it("does not page a success, a cancel, or a run that will be retried", async () => {
    const w = world();
    const pager = withPager(w);
    await finish(w);
    await finish(w, { run_id: "r2", status: "cancelled" });
    await finish(w, { run_id: "r3", status: "error", will_retry: true });
    expect(pager).not.toHaveBeenCalled();
  });

  it("a pager that throws never breaks the hook", async () => {
    const w = world();
    w.seams.alertFailure = vi.fn(async () => {
      throw new Error("sendgrid down");
    });
    expect(await finish(w, { status: "error" })).toBe("failed_run");
  });
});
