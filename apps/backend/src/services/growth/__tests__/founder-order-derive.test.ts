import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

import { resolveFounderChatOrder } from "../founder-order";
import { isFounderChatOrder } from "@/services/agents/untrusted-context";
import { logEvent } from "@/services/logging/logEvent";

const T = "tenant-A";

type Run = { id: string; tenant_id: string; agent_slug: string; trigger: string; enqueued_by: string | null; payload: Record<string, unknown> };
type Msg = { id: string; tenant_id: string; thread_id: string; sender_role: string };

function fakeDb(runs: Run[], msgs: Msg[], opts: { failTable?: string } = {}) {
  return {
    from(table: string) {
      expect(["agent_runs", "agent_thread_messages"]).toContain(table);
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          f[col] = v;
          return q;
        },
        maybeSingle: async () => {
          if (opts.failTable === table) return { data: null, error: { message: "boom" } };
          const src = (table === "agent_runs" ? runs : msgs) as Array<Record<string, unknown>>;
          const r = src.find((x) => Object.entries(f).every(([k, v]) => x[k] === v)) ?? null;
          return { data: r, error: null };
        },
      };
      return q;
    },
  } as never;
}

const typed: Run = {
  id: "run-turn",
  tenant_id: T,
  agent_slug: "cgo",
  trigger: "chat",
  enqueued_by: "user-owner",
  payload: { thread_id: "thread-1", user_message_id: "msg-1" },
};
const userMsg: Msg = { id: "msg-1", tenant_id: T, thread_id: "thread-1", sender_role: "user" };
const resume = (over: Partial<Run> = {}): Run => ({
  id: "run-resume",
  tenant_id: T,
  agent_slug: "cgo",
  trigger: "chat",
  enqueued_by: null,
  payload: { thread_id: "thread-1", resume_of_run_id: "run-turn", internal_resume_turn: "approved" },
  ...over,
});
const claimOf = (r: Run) => ({ id: r.id, tenant_id: r.tenant_id, trigger: r.trigger, payload: r.payload, enqueued_by: r.enqueued_by, agent_slug: r.agent_slug });
const ownerRole = { roleOf: async () => "owner", founderMessageOf: async () => null, slackMemberOf: async () => null };

describe("resolveFounderChatOrder (server-derived, chat only)", () => {
  const cases: Array<[string, Run[], Msg[], Run, boolean]> = [
    ["a typed chat turn", [typed], [userMsg], typed, true],
    [
      "the incident turn (Founder Rules active)",
      [{ ...typed, payload: { ...typed.payload, rule_set_hash: "abc", message: "okay lets do those changes" } }],
      [userMsg],
      { ...typed, payload: { ...typed.payload, rule_set_hash: "abc", message: "okay lets do those changes" } },
      true,
    ],
    ["a verified email reply", [{ ...typed, trigger: "email" }], [userMsg], { ...typed, trigger: "email" }, false],
    ["a top-action run", [{ ...typed, trigger: "channel_recipe", payload: { ...typed.payload, top_action: { id: "x" } } }], [userMsg], { ...typed, trigger: "channel_recipe", payload: { ...typed.payload, top_action: { id: "x" } } }, false],
    ["a staff-console chat", [{ ...typed, payload: { ...typed.payload, origin: "staff_console" } }], [userMsg], { ...typed, payload: { ...typed.payload, origin: "staff_console" } }, false],
    ["a captured page", [{ ...typed, payload: { ...typed.payload, page_context: { mode: "screenshot" } } }], [userMsg], { ...typed, payload: { ...typed.payload, page_context: { mode: "screenshot" } } }, false],
    ["an unrelated resume (chain does not hold)", [resume({ payload: { thread_id: "thread-1", resume_of_run_id: "gone" } })], [userMsg], resume({ payload: { thread_id: "thread-1", resume_of_run_id: "gone" } }), true],
    ["a resume with a human root in the same tenant and thread", [typed, resume()], [userMsg], resume(), true],
    ["a resume whose root is in another tenant", [{ ...typed, tenant_id: "tenant-B" }, resume()], [{ ...userMsg, tenant_id: "tenant-B" }], resume(), true],
    ["a synthetic chat root (no enqueuer, no message)", [{ ...typed, enqueued_by: null, payload: { thread_id: "thread-1" } }], [], { ...typed, enqueued_by: null, payload: { thread_id: "thread-1" } }, false],
    ["a server-created root that names a message", [{ ...typed, enqueued_by: null }], [userMsg], { ...typed, enqueued_by: null }, false],
    ["a root message written by the assistant", [typed], [{ ...userMsg, sender_role: "assistant" }], typed, false],
    ["a typed turn whose message row is missing", [typed], [], typed, true],
    ["a root message on another thread", [typed], [{ ...userMsg, thread_id: "thread-2" }], typed, false],
    ["a resume whose root carried a captured page", [{ ...typed, payload: { ...typed.payload, page_context: { url: "x" } } }, resume()], [userMsg], resume(), false],
    ["a user-created run that claims to resume another", [{ ...typed, payload: { ...typed.payload, resume_of_run_id: "other" } }], [userMsg], { ...typed, payload: { ...typed.payload, resume_of_run_id: "other" } }, false],
  ];
  for (const [name, runs, msgs, run, want] of cases) {
    it(`${name} -> ${want}`, async () => {
      expect((await resolveFounderChatOrder(fakeDb(runs, msgs), claimOf(run), ownerRole)).founder).toBe(want);
    });
  }

  const unverifiedHere = { founder: true, unverified: true, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id: "run-turn" };
  it("must-catch: a run read error is an UNVERIFIED founder order (waits for a tap), logged at error", async () => {
    expect(await resolveFounderChatOrder(fakeDb([typed], [userMsg], { failTable: "agent_runs" }), claimOf(typed), ownerRole)).toEqual(unverifiedHere);
    expect(vi.mocked(logEvent)).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "founder_order.marker_unverified" }));
  });

  it("must-catch: a message read error is an unverified founder order too", async () => {
    expect(await resolveFounderChatOrder(fakeDb([typed], [userMsg], { failTable: "agent_thread_messages" }), claimOf(typed), ownerRole)).toEqual(unverifiedHere);
  });

  it("must-not-touch: a run that can never be a founder order stays not one on a read error (captured page, staff console, cron, user-created handoff)", async () => {
    const boom = { roleOf: async () => Promise.reject(new Error("db down")), founderMessageOf: async () => Promise.reject(new Error("db down")), slackMemberOf: async () => Promise.reject(new Error("db down")) };
    const page = { ...typed, payload: { ...typed.payload, page_context: { url: "x" } } };
    const staff = { ...typed, payload: { ...typed.payload, origin: "staff_console" } };
    for (const r of [page, staff, { ...typed, trigger: "cron" }, { ...typed, trigger: "handoff" }, { ...typed, trigger: "email" }]) {
      expect(await resolveFounderChatOrder(fakeDb([r], [userMsg], { failTable: "agent_runs" }), claimOf(r), boom)).toEqual({ founder: false, card_thread_id: null, card_agent_slug: null, card_run_id: null });
    }
  });

  it("G1: only an owner or admin's chat is a founder order; a member, a viewer or no row is not", async () => {
    const res = (role: () => Promise<string | null>) =>
      resolveFounderChatOrder(fakeDb([typed], [userMsg]), claimOf(typed), { roleOf: role, founderMessageOf: async () => null });
    expect(await res(async () => "owner")).toEqual({ founder: true, card_thread_id: "thread-1", card_agent_slug: "cgo", card_run_id: "run-turn", order_root_id: "run-turn" });
    expect((await res(async () => "admin")).founder).toBe(true);
    for (const r of ["member", "viewer", null]) expect((await res(async () => r)).founder, String(r)).toBe(false);
    expect(await res(async () => Promise.reject(new Error("db down")))).toMatchObject({ founder: true, unverified: true });
  });

  it("a resume's card goes to the root run (the run the founder's message belongs to)", async () => {
    expect(await resolveFounderChatOrder(fakeDb([typed, resume()], [userMsg]), claimOf(resume()), ownerRole)).toMatchObject({ founder: true, card_run_id: "run-turn", card_thread_id: "thread-1" });
  });
});

describe("resolveFounderChatOrder: handoff children (G2)", () => {
  const ref = { kind: "chat", id: "msg-1", author_user_id: "user-owner", run_id: "run-turn" };
  const child = (over: Partial<Run> = {}): Run => ({
    id: "run-child",
    tenant_id: T,
    agent_slug: "google_ads",
    trigger: "handoff",
    enqueued_by: null,
    payload: { operator_thread_id: "thread-1", intent: "cut it", founder_message_ref: ref, handoff_child: true },
    ...over,
  });
  const fm = vi.fn(async () => ({ ref, text: "okay lets do those changes", author_user_id: "user-owner" }));
  const deps = (role = "owner") => ({ roleOf: async () => role, founderMessageOf: fm as never });

  it("a server-created child of the owner's chat turn is a founder order; its card goes to the founder's thread, as the root run", async () => {
    const r = await resolveFounderChatOrder(fakeDb([typed, child()], [userMsg]), claimOf(child()), deps());
    expect(r).toEqual({ founder: true, card_thread_id: "thread-1", card_agent_slug: "cgo", card_run_id: "run-turn", order_root_id: "run-turn" });
    expect(fm).toHaveBeenCalledWith(expect.objectContaining({ id: "run-child", trigger: "handoff", enqueued_by: null }));
  });

  it("not when a user created the run (its ref is user-written), the ref does not resolve, the thread differs, or the author is a member", async () => {
    expect((await resolveFounderChatOrder(fakeDb([typed, child({ enqueued_by: "user-owner" })], [userMsg]), claimOf(child({ enqueued_by: "user-owner" })), deps())).founder).toBe(false);
    expect((await resolveFounderChatOrder(fakeDb([typed, child()], [userMsg]), claimOf(child()), { roleOf: async () => "owner", founderMessageOf: async () => null })).founder).toBe(false);
    const other = child({ payload: { ...child().payload, operator_thread_id: "thread-9" } });
    expect((await resolveFounderChatOrder(fakeDb([typed, other], [userMsg]), claimOf(other), deps())).founder).toBe(false);
    expect((await resolveFounderChatOrder(fakeDb([typed, child()], [userMsg]), claimOf(child()), deps("member"))).founder).toBe(false);
    const noRef = child({ payload: { operator_thread_id: "thread-1" } });
    expect((await resolveFounderChatOrder(fakeDb([typed, noRef], [userMsg]), claimOf(noRef), deps())).founder).toBe(false);
  });

  it("isFounderChatOrder accepts a marked handoff child, never one on a captured page", () => {
    expect(isFounderChatOrder({ run_trigger: "handoff", founder_chat_order: true })).toBe(true);
    expect(isFounderChatOrder({ run_trigger: "handoff", founder_chat_order: true, captured_page_context: true })).toBe(false);
    expect(isFounderChatOrder({ run_trigger: "a2a", founder_chat_order: true })).toBe(false);
  });
});

describe("isFounderChatOrder", () => {
  it("needs the marker AND a human-authored chat run", () => {
    expect(isFounderChatOrder({ run_trigger: "chat", founder_chat_order: true })).toBe(true);
    expect(isFounderChatOrder({ run_trigger: "chat", founder_chat_order: true, captured_page_context: true })).toBe(false);
    expect(isFounderChatOrder({ run_trigger: "chat", founder_chat_order: true, untrusted_context: true })).toBe(false);
    expect(isFounderChatOrder({ run_trigger: "email", founder_chat_order: true })).toBe(false);
    expect(isFounderChatOrder({ run_trigger: "chat" })).toBe(false);
  });
});

describe("resolveFounderChatOrder: resumes of a handoff child, and the owner's Slack DM (bug #2)", () => {
  const ref = { kind: "chat", id: "msg-1", author_user_id: "user-owner", run_id: "run-turn" };
  const child: Run & { enqueued_at: string } = {
    id: "run-child",
    tenant_id: T,
    agent_slug: "google_ads",
    trigger: "handoff",
    enqueued_by: null,
    payload: { operator_thread_id: "thread-1", founder_message_ref: ref, handoff_child: true },
    enqueued_at: "2026-10-18T04:14:00Z",
  };
  const childResume: Run = { id: "run-child-2", tenant_id: T, agent_slug: "google_ads", trigger: "handoff", enqueued_by: null, payload: { resume_of_run_id: "run-child", internal_resume_turn: "approved" } };
  const fm = vi.fn(async () => ({ ref, text: "okay lets do those changes", author_user_id: "user-owner" }));
  const deps = { roleOf: async () => "owner", founderMessageOf: fm as never, slackMemberOf: async () => null };

  it("must-catch: a resume of the founder's handoff child keeps founder authority (judged on the child it continues)", async () => {
    fm.mockClear();
    expect(await resolveFounderChatOrder(fakeDb([typed, child, childResume], [userMsg]), claimOf(childResume), deps)).toEqual({ founder: true, card_thread_id: "thread-1", card_agent_slug: "cgo", card_run_id: "run-turn", order_root_id: "run-turn" });
    expect(fm).toHaveBeenCalledWith(expect.objectContaining({ id: "run-child" }));
  });

  it("must-catch: a chat child with no operator thread is unverified, not Autopilot's", async () => {
    const noThread = { ...child, payload: { founder_message_ref: ref, handoff_child: true } };
    expect(await resolveFounderChatOrder(fakeDb([typed, noThread], [userMsg]), claimOf(noThread), deps)).toMatchObject({ founder: true, unverified: true });
  });

  it("a resume whose chain breaks (another agent, a missing original) is unverified, never Autopilot's; a user-created run is not a founder order", async () => {
    const otherAgent = { ...child, agent_slug: "meta_ads" };
    expect(await resolveFounderChatOrder(fakeDb([typed, otherAgent, childResume], [userMsg]), claimOf(childResume), deps)).toMatchObject({ founder: true, unverified: true, card_thread_id: null });
    expect(await resolveFounderChatOrder(fakeDb([typed, childResume], [userMsg]), claimOf(childResume), deps)).toMatchObject({ founder: true, unverified: true });
    const userMade = { ...childResume, enqueued_by: "user-owner" };
    expect((await resolveFounderChatOrder(fakeDb([typed, child, userMade], [userMsg]), claimOf(userMade), deps)).founder).toBe(false);
  });

  it("must-catch: a child whose founder ref could not be read at handoff is unverified; a child with no founder message at all is not a founder order", async () => {
    const marked = { ...child, payload: { operator_thread_id: "thread-1", handoff_child: true, founder_message_ref_unreadable: true } };
    expect(await resolveFounderChatOrder(fakeDb([typed, marked], [userMsg]), claimOf(marked), deps)).toMatchObject({ founder: true, unverified: true });
    const none = { ...child, payload: { operator_thread_id: "thread-1", handoff_child: true } };
    expect((await resolveFounderChatOrder(fakeDb([typed, none], [userMsg]), claimOf(none), deps)).founder).toBe(false);
  });

  it("must-catch: a handoff child whose founder message cannot be read is an unverified founder order with no chat card", async () => {
    const boom = { ...deps, founderMessageOf: async () => Promise.reject(new Error("db down")) };
    expect(await resolveFounderChatOrder(fakeDb([typed, child], [userMsg]), claimOf(child), boom)).toEqual({ founder: true, unverified: true, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id: "run-turn" });
  });

  it("must-not-touch: an email child (kind email) is never a founder order, even on a read error", async () => {
    const emailChild = { ...child, payload: { ...child.payload, founder_message_ref: { ...ref, kind: "email" } } };
    const boom = { ...deps, founderMessageOf: async () => Promise.reject(new Error("db down")) };
    expect((await resolveFounderChatOrder(fakeDb([emailChild], []), claimOf(emailChild), boom)).founder).toBe(false);
  });

  const dm: Run = {
    id: "run-slack",
    tenant_id: T,
    agent_slug: "operator",
    trigger: "slack",
    enqueued_by: null,
    payload: { slack: { channel_id: "D0B448H4PKP", user: "U123", team_id: "T999", event_id: "Ev1", text: "cut the google one to $10" } },
  };
  const slackDeps = (member: string | null, role = "owner") => ({ roleOf: async () => role, founderMessageOf: async () => null, slackMemberOf: vi.fn(async () => member) });

  it("must-catch: the owner's Slack DM to Zavi, sender linked to the owner, is a founder order (no chat card)", async () => {
    const d = slackDeps("user-owner");
    expect(await resolveFounderChatOrder(fakeDb([dm], []), claimOf(dm), d)).toEqual({ founder: true, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id: "run-slack" });
    expect(d.slackMemberOf).toHaveBeenCalledWith(T, dm.payload.slack);
  });

  it("must-not-touch: a Slack channel message, an unlinked sender, a member, or a user-created Slack row is not", async () => {
    const channel = { ...dm, payload: { slack: { ...(dm.payload.slack as object), channel_id: "C0123" } } };
    expect((await resolveFounderChatOrder(fakeDb([channel], []), claimOf(channel), slackDeps("user-owner"))).founder).toBe(false);
    expect((await resolveFounderChatOrder(fakeDb([dm], []), claimOf(dm), slackDeps(null))).founder).toBe(false);
    expect((await resolveFounderChatOrder(fakeDb([dm], []), claimOf(dm), slackDeps("user-m", "member"))).founder).toBe(false);
    const userMade = { ...dm, enqueued_by: "user-owner" };
    expect((await resolveFounderChatOrder(fakeDb([userMade], []), claimOf(userMade), slackDeps("user-owner"))).founder).toBe(false);
  });

  it("must-catch: a Slack DM whose sender lookup fails is unverified (waits for a tap), never Autopilot's", async () => {
    const d = { ...slackDeps("x"), slackMemberOf: async () => Promise.reject(new Error("rpc down")) };
    expect(await resolveFounderChatOrder(fakeDb([dm], []), claimOf(dm), d)).toMatchObject({ founder: true, unverified: true, card_thread_id: null });
  });

  it("must-catch: a handoff child of the owner's Slack DM is a founder order", async () => {
    const sref = { kind: "slack", id: "Ev1", author_user_id: "U123", run_id: "run-slack" };
    const sChild: Run = { id: "run-sc", tenant_id: T, agent_slug: "google_ads", trigger: "handoff", enqueued_by: null, payload: { founder_message_ref: sref, slack_handoff_child: true } };
    const d = { roleOf: async () => "owner", founderMessageOf: async () => ({ ref: sref, text: "cut it", author_user_id: "user-owner" }), slackMemberOf: async () => null };
    expect(await resolveFounderChatOrder(fakeDb([dm, sChild], []), claimOf(sChild), d as never)).toEqual({ founder: true, card_thread_id: null, card_agent_slug: null, card_run_id: null, order_root_id: "run-slack" });
    const inChannel = { ...dm, payload: { slack: { ...(dm.payload.slack as object), channel_id: "C0123" } } };
    expect((await resolveFounderChatOrder(fakeDb([inChannel, sChild], []), claimOf(sChild), d as never)).founder).toBe(false);
  });

  it("isFounderChatOrder accepts a marked Slack run, never on a captured page", () => {
    expect(isFounderChatOrder({ run_trigger: "slack", founder_chat_order: true })).toBe(true);
    expect(isFounderChatOrder({ run_trigger: "slack" })).toBe(false);
    expect(isFounderChatOrder({ run_trigger: "slack", founder_chat_order: true, untrusted_context: true })).toBe(false);
  });
});
