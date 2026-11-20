import { describe, it, expect } from "vitest";
import { resolveRunOwner, resolveChatTurnChain, runIdentityInputs, runMayUseThread, slackSenderOf, MAX_RESUME_HOPS, BROKEN, NO_OWNER } from "../run-owner";
import { buildRunActor } from "../actor-envelope";

type Row = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  trigger: string;
  enqueued_by: string | null;
  payload: Record<string, unknown>;
};

function fakeDb(rows: Row[], opts: { failOn?: string; threads?: Array<{ id: string; tenant_id: string; user_id: string }> } = {}) {
  return {
    from(table: string) {
      expect(["agent_runs", "agent_threads"]).toContain(table);
      const source: Array<{ id: string; tenant_id: string }> = table === "agent_runs" ? rows : (opts.threads ?? []);
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          f[col] = v;
          return q;
        },
        maybeSingle: async () => {
          if (opts.failOn && f.id === opts.failOn) return { data: null, error: { message: "boom" } };
          const r = source.find((x) => x.id === f.id && x.tenant_id === f.tenant_id) ?? null;
          return { data: r, error: null };
        },
      };
      return q;
    },
  } as never;
}

const T = "tenant-A";
const OWNER = "user-owner";
const MATE = "user-teammate";

const chatTurn: Row = {
  id: "run-turn",
  tenant_id: T,
  agent_slug: "operator",
  trigger: "chat",
  enqueued_by: OWNER,
  payload: { thread_id: "thread-1", user_message_id: "msg-1" },
};
const approvalResume: Row = {
  id: "run-resume",
  tenant_id: T,
  agent_slug: "operator",
  trigger: "chat",
  enqueued_by: null,
  payload: { thread_id: "thread-1", resume_of_run_id: "run-turn", internal_resume_turn: "approved" },
};

describe("resolveRunOwner", () => {
  it("a user-created run is owned by its enqueuer; a payload user_id is ignored", async () => {
    const forged: Row = { ...chatTurn, id: "run-x", enqueued_by: MATE, payload: { ...chatTurn.payload, user_id: OWNER } };
    expect(await resolveRunOwner(fakeDb([forged]), T, "run-x")).toEqual({ owner_user_id: MATE });
  });

  it("a user-created run cannot borrow an owner through a forged resume_of_run_id", async () => {
    const forged: Row = { ...approvalResume, id: "run-x", enqueued_by: MATE };
    expect((await resolveRunOwner(fakeDb([chatTurn, forged]), T, "run-x")).owner_user_id).toBe(MATE);
  });

  it("a server approval resume carries the original owner", async () => {
    expect((await resolveRunOwner(fakeDb([chatTurn, approvalResume]), T, "run-resume")).owner_user_id).toBe(OWNER);
  });

  it("a resume of a resume walks back to the owner", async () => {
    const second: Row = { ...approvalResume, id: "run-resume-2", payload: { ...approvalResume.payload, resume_of_run_id: "run-resume" } };
    const db = fakeDb([chatTurn, approvalResume, second]);
    expect((await resolveRunOwner(db, T, "run-resume-2")).owner_user_id).toBe(OWNER);
  });

  it("a resume that points at another thread, agent or tenant gets no owner", async () => {
    const otherThread: Row = { ...chatTurn, id: "run-other", payload: { thread_id: "thread-2", user_message_id: "m" } };
    const r1: Row = { ...approvalResume, id: "r1", payload: { ...approvalResume.payload, resume_of_run_id: "run-other" } };
    const otherAgent: Row = { ...chatTurn, id: "run-agent", agent_slug: "pm" };
    const r2: Row = { ...approvalResume, id: "r2", payload: { ...approvalResume.payload, resume_of_run_id: "run-agent" } };
    const otherTenant: Row = { ...chatTurn, id: "run-tenant", tenant_id: "tenant-B" };
    const r3: Row = { ...approvalResume, id: "r3", payload: { ...approvalResume.payload, resume_of_run_id: "run-tenant" } };
    const db = fakeDb([otherThread, r1, otherAgent, r2, otherTenant, r3]);
    for (const id of ["r1", "r2", "r3"]) expect((await resolveRunOwner(db, T, id)).owner_user_id).toBeNull();
  });

  it("a cycle stops after the hop limit with no owner", async () => {
    const a: Row = { ...approvalResume, id: "a", payload: { thread_id: "thread-1", resume_of_run_id: "b" } };
    const b: Row = { ...approvalResume, id: "b", payload: { thread_id: "thread-1", resume_of_run_id: "a" } };
    expect(MAX_RESUME_HOPS).toBeGreaterThan(0);
    expect((await resolveRunOwner(fakeDb([a, b]), T, "a")).owner_user_id).toBeNull();
  });

  it("MCP / a2a / staff-console runs (enqueued_by null) have no owner, whatever their payload says", async () => {
    const mcp: Row = { ...chatTurn, id: "mcp", trigger: "mcp", enqueued_by: null, payload: { user_id: OWNER } };
    const staff: Row = { ...chatTurn, id: "staff", enqueued_by: null, payload: { thread_id: "t", user_message_id: "m", origin: "staff_console", user_id: OWNER } };
    const db = fakeDb([mcp, staff]);
    expect((await resolveRunOwner(db, T, "mcp")).owner_user_id).toBeNull();
    expect((await resolveRunOwner(db, T, "staff")).owner_user_id).toBeNull();
  });

  it("a read failure throws (the run fails closed)", async () => {
    await expect(resolveRunOwner(fakeDb([chatTurn, approvalResume], { failOn: "run-turn" }), T, "run-resume")).rejects.toThrow(
      /run read failed/,
    );
  });
});

describe("run identity through approve -> resume -> handoff", () => {
  const parentActor = {
    actor_user_id: OWNER,
    actor_source: "chat",
    resolved_tenant_member: true,
    provenance_label: "signed-in user",
  };
  const handoffChild: Row = {
    id: "run-child",
    tenant_id: T,
    agent_slug: "ugc",
    trigger: "handoff",
    enqueued_by: null,
    payload: { operator_thread_id: "thread-1", user_id: OWNER, inherited_actor: parentActor },
  };
  const opThreads = [{ id: "thread-1", tenant_id: T, user_id: OWNER }];
  const childResume: Row = {
    id: "run-child-resume",
    tenant_id: T,
    agent_slug: "ugc",
    trigger: "handoff",
    enqueued_by: null,
    payload: { resume_of_run_id: "run-child", user_message: "approved", handoff_child: true },
  };

  it("the resumed chat run gets the owner as userId and as a chat actor (so it may hand off)", async () => {
    const owner = await resolveRunOwner(fakeDb([chatTurn, approvalResume]), T, "run-resume");
    const ids = runIdentityInputs("chat", owner, approvalResume.payload, approvalResume.enqueued_by);
    expect(ids.userId).toBe(OWNER);
    const actor = await buildRunActor({} as never, "chat", { tenant_id: T, enqueued_by: ids.userId ?? null, inherited_actor: ids.inheritedActor });
    expect(actor.actor_user_id).toBe(OWNER);
    expect(actor.actor_source).toBe("chat");
  });

  it("the specialist handed off after the resume carries the owner", async () => {
    const owner = await resolveRunOwner(fakeDb([handoffChild], { threads: opThreads }), T, "run-child");
    expect(owner.owner_user_id).toBe(OWNER);
    const ids = runIdentityInputs("handoff", owner, handoffChild.payload, handoffChild.enqueued_by);
    const actor = await buildRunActor({} as never, "handoff", { tenant_id: T, enqueued_by: ids.userId ?? null, inherited_actor: ids.inheritedActor });
    expect(actor.actor_user_id).toBe(OWNER);
  });

  it("a resumed specialist gets back the actor its resume payload dropped", async () => {
    const owner = await resolveRunOwner(fakeDb([handoffChild, childResume], { threads: opThreads }), T, "run-child-resume");
    expect(owner.owner_user_id).toBe(OWNER);
    const ids = runIdentityInputs("handoff", owner, childResume.payload, childResume.enqueued_by);
    const actor = await buildRunActor({} as never, "handoff", { tenant_id: T, enqueued_by: ids.userId ?? null, inherited_actor: ids.inheritedActor });
    expect(actor.actor_user_id).toBe(OWNER);
  });

  it("a user-created handoff row cannot claim another member through payload.user_id or inherited_actor", async () => {
    const forged: Row = { ...handoffChild, id: "forged", enqueued_by: MATE };
    const owner = await resolveRunOwner(fakeDb([forged]), T, "forged");
    expect(owner.owner_user_id).toBe(MATE);
    const ids = runIdentityInputs("handoff", owner, forged.payload, forged.enqueued_by);
    expect(ids.inheritedActor).toBeUndefined();
    const actor = await buildRunActor({} as never, "handoff", { tenant_id: T, enqueued_by: ids.userId ?? null, inherited_actor: ids.inheritedActor });
    expect(actor.actor_user_id).toBeNull();
  });
});

describe("runMayUseThread (terminal writes: bubble, thread events, handoff result)", () => {
  const threads = [
    { id: "thread-1", tenant_id: T, user_id: OWNER },
    { id: "thread-mate", tenant_id: T, user_id: MATE },
  ];
  it("the owner's run may post into the owner's thread", async () => {
    expect(await runMayUseThread(fakeDb([chatTurn], { threads }), T, "run-turn", "thread-1")).toBe(true);
  });
  it("a teammate's run pointed at the owner's thread may not", async () => {
    const forged: Row = { ...chatTurn, id: "run-x", enqueued_by: MATE };
    expect(await runMayUseThread(fakeDb([forged], { threads }), T, "run-x", "thread-1")).toBe(false);
  });
  it("a user-created handoff naming a teammate's operator thread may not post its result there", async () => {
    const forged: Row = { id: "h", tenant_id: T, agent_slug: "ugc", trigger: "handoff", enqueued_by: MATE, payload: { operator_thread_id: "thread-1", user_id: OWNER } };
    expect(await runMayUseThread(fakeDb([forged], { threads }), T, "h", "thread-1")).toBe(false);
  });
  it("a server handoff child posts into its owner's operator thread", async () => {
    const child: Row = { id: "h", tenant_id: T, agent_slug: "ugc", trigger: "handoff", enqueued_by: null, payload: { operator_thread_id: "thread-1", user_id: OWNER } };
    expect(await runMayUseThread(fakeDb([child], { threads }), T, "h", "thread-1")).toBe(true);
  });
  it("an ownerless server run (staff console, a2a) keeps its thread", async () => {
    const staff: Row = { ...chatTurn, id: "staff", enqueued_by: null, payload: { thread_id: "thread-mate", origin: "staff_console" } };
    expect(await runMayUseThread(fakeDb([staff], { threads }), T, "staff", "thread-mate")).toBe(true);
  });
  it("a thread in another tenant is never the owner's", async () => {
    const other = [{ id: "thread-1", tenant_id: "tenant-B", user_id: OWNER }];
    expect(await runMayUseThread(fakeDb([chatTurn], { threads: other }), T, "run-turn", "thread-1")).toBe(false);
  });
});

describe("security bot: the owner never comes from a forged payload", () => {
  const threads = [
    { id: "thread-1", tenant_id: T, user_id: OWNER },
    { id: "thread-mate", tenant_id: T, user_id: MATE },
  ];
  it("a teammate's run with a forged payload user_id AND a forged resume_of_run_id to the owner's run stays the teammate's, and may not use the owner's thread", async () => {
    const forged: Row = {
      id: "forged",
      tenant_id: T,
      agent_slug: "operator",
      trigger: "chat",
      enqueued_by: MATE,
      payload: { thread_id: "thread-1", user_id: OWNER, resume_of_run_id: "run-turn", internal_resume_turn: "x", inherited_actor: { actor_user_id: OWNER, actor_source: "chat", resolved_tenant_member: true, provenance_label: "signed-in user" } },
    };
    const db = fakeDb([chatTurn, forged], { threads });
    const owner = await resolveRunOwner(db, T, "forged");
    expect(owner).toEqual({ owner_user_id: MATE });
    expect(await runMayUseThread(db, T, "forged", "thread-1")).toBe(false);
  });
  it("a resume_of_run_id pointing at another tenant's run resolves to no owner", async () => {
    const foreign: Row = { ...chatTurn, id: "foreign", tenant_id: "tenant-B" };
    const resume: Row = { ...approvalResume, id: "r", payload: { ...approvalResume.payload, resume_of_run_id: "foreign" } };
    expect((await resolveRunOwner(fakeDb([foreign, resume]), T, "r")).owner_user_id).toBeNull();
  });
  it("a server handoff child whose stamped user_id does not own its operator thread has no owner", async () => {
    const child: Row = { id: "h", tenant_id: T, agent_slug: "ugc", trigger: "handoff", enqueued_by: null, payload: { operator_thread_id: "thread-mate", user_id: OWNER } };
    expect((await resolveRunOwner(fakeDb([child], { threads }), T, "h")).owner_user_id).toBeNull();
  });
  it("a resume chain ending at a user-created run never returns that payload's inherited_actor", async () => {
    const root: Row = { ...chatTurn, trigger: "handoff", payload: { thread_id: "thread-1", inherited_actor: { actor_user_id: MATE } } };
    const resume: Row = { ...approvalResume, trigger: "handoff" };
    const owner = await resolveRunOwner(fakeDb([root, resume]), T, "run-resume");
    expect(owner).toEqual({ owner_user_id: OWNER });
  });
});

describe("slackSenderOf", () => {
  const payload = { slack: { user: "U-OWNER", team_id: "T1" } };
  it("a server-created Slack run names its sender", () => {
    expect(slackSenderOf("slack", null, payload)).toEqual({ user: "U-OWNER", team_id: "T1" });
  });
  it("a member-enqueued 'slack' run with a teammate's Slack id names nobody", () => {
    expect(slackSenderOf("slack", MATE, payload)).toBeUndefined();
  });
  it("any other trigger names nobody", () => {
    expect(slackSenderOf("chat", null, payload)).toBeUndefined();
  });
});

describe("fail closed: a chain that should reach an owner but does not is BROKEN and denied", () => {
  const threads = [{ id: "thread-1", tenant_id: T, user_id: OWNER }];
  const resumeOf = (id: string, prev: string, over: Partial<Row> = {}): Row => ({
    ...approvalResume,
    id,
    payload: { ...approvalResume.payload, resume_of_run_id: prev },
    ...over,
  });
  const shapes: Array<[string, Row[], string]> = [
    ["the run row is missing", [], "nope"],
    ["the resumed origin is missing", [resumeOf("r", "gone")], "r"],
    ["the origin is another agent", [{ ...chatTurn, agent_slug: "pm" }, resumeOf("r", "run-turn")], "r"],
    ["the origin is another trigger", [{ ...chatTurn, trigger: "handoff" }, resumeOf("r", "run-turn")], "r"],
    ["the origin is on another thread", [{ ...chatTurn, payload: { thread_id: "thread-2" } }, resumeOf("r", "run-turn")], "r"],
    ["the origin is in another tenant", [{ ...chatTurn, tenant_id: "tenant-B" }, resumeOf("r", "run-turn")], "r"],
    [
      "the chain is longer than the hop limit",
      Array.from({ length: MAX_RESUME_HOPS + 2 }, (_, i) => resumeOf(`h${i}`, `h${i + 1}`)).concat([{ ...chatTurn, id: `h${MAX_RESUME_HOPS + 2}` }]),
      "h0",
    ],
    ["a cycle", [resumeOf("a", "b"), resumeOf("b", "a")], "a"],
    ["a server chat turn that is not staff console", [{ ...chatTurn, id: "s", enqueued_by: null }], "s"],
    ["a handoff child with no user_id", [{ id: "h", tenant_id: T, agent_slug: "ugc", trigger: "handoff", enqueued_by: null, payload: { operator_thread_id: "thread-1" } }], "h"],
    ["a handoff child with no operator thread", [{ id: "h", tenant_id: T, agent_slug: "ugc", trigger: "handoff", enqueued_by: null, payload: { user_id: OWNER } }], "h"],
    ["a handoff child whose user_id does not own its thread", [{ id: "h", tenant_id: T, agent_slug: "ugc", trigger: "handoff", enqueued_by: null, payload: { operator_thread_id: "thread-1", user_id: MATE } }], "h"],
    ["another trigger carrying resume_of_run_id", [chatTurn, { ...chatTurn, id: "x", trigger: "a2a", enqueued_by: null, payload: { thread_id: "thread-1", resume_of_run_id: "run-turn" } }], "x"],
  ];
  for (const [name, rows, id] of shapes) {
    it(`${name}: BROKEN, and the run may not use the thread`, async () => {
      const db = fakeDb(rows, { threads });
      expect(await resolveRunOwner(db, T, id)).toEqual(BROKEN);
      expect(await runMayUseThread(db, T, id, "thread-1")).toBe(false);
    });
  }

  it("genuinely ownerless server roots stay allowed: cron/a2a with no resume, staff console and its resume", async () => {
    const a2a: Row = { ...chatTurn, id: "a2a", trigger: "a2a", enqueued_by: null, payload: { thread_id: "thread-1" } };
    const staff: Row = { ...chatTurn, id: "staff", enqueued_by: null, payload: { thread_id: "thread-1", origin: "staff_console" } };
    const staffResume: Row = { ...approvalResume, id: "staff-r", payload: { thread_id: "thread-1", resume_of_run_id: "staff" } };
    const db = fakeDb([a2a, staff, staffResume], { threads });
    for (const id of ["a2a", "staff", "staff-r"]) {
      expect(await resolveRunOwner(db, T, id)).toEqual(NO_OWNER);
      expect(await runMayUseThread(db, T, id, "thread-1")).toBe(true);
    }
  });
});

describe("resolveChatTurnChain", () => {
  const resume = (id: string, prev: string, over: Partial<Row> = {}): Row => ({
    ...approvalResume,
    id,
    payload: { thread_id: "thread-1", resume_of_run_id: prev, internal_resume_turn: "approved" },
    ...over,
  });

  it("a plain chat turn is its own one-run chain", async () => {
    expect(await resolveChatTurnChain(fakeDb([chatTurn]), T, "run-turn")).toEqual({
      ok: true,
      root_run_id: "run-turn",
      chain: ["run-turn"],
      payloads: [chatTurn.payload],
      user_message_id: "msg-1",
      thread_id: "thread-1",
      root_payload: chatTurn.payload,
      root_enqueued_by: chatTurn.enqueued_by,
    });
  });

  it("a resume of a resume walks back to the user-typed root, oldest first", async () => {
    const r1 = resume("r1", "run-turn");
    const r2 = resume("r2", "r1");
    const res = await resolveChatTurnChain(fakeDb([chatTurn, r1, r2]), T, "r2");
    expect(res).toMatchObject({ ok: true, root_run_id: "run-turn", chain: ["run-turn", "r1", "r2"], user_message_id: "msg-1", thread_id: "thread-1" });
  });

  it("a non-chat run is not_chat (another distiller owns it)", async () => {
    const cron: Row = { ...chatTurn, id: "c", trigger: "cron", payload: {} };
    expect(await resolveChatTurnChain(fakeDb([cron]), T, "c")).toEqual({ ok: false, reason: "not_chat" });
  });

  const broken: Array<[string, Row[], string]> = [
    ["a missing run", [], "nope"],
    ["a missing origin", [resume("r1", "gone")], "r1"],
    ["an origin in another tenant", [{ ...chatTurn, tenant_id: "tenant-B" }, resume("r1", "run-turn")], "r1"],
    ["an origin on another thread", [{ ...chatTurn, payload: { thread_id: "thread-2", user_message_id: "msg-1" } }, resume("r1", "run-turn")], "r1"],
    ["an origin of another agent", [{ ...chatTurn, agent_slug: "cgo" }, resume("r1", "run-turn")], "r1"],
    ["a root without a user message", [{ ...chatTurn, payload: { thread_id: "thread-1" } }, resume("r1", "run-turn")], "r1"],
    ["a root without a thread", [{ ...chatTurn, payload: { user_message_id: "msg-1" } }], "run-turn"],
    ["a cycle", [resume("a", "b"), resume("b", "a")], "a"],
    [
      "more hops than the limit",
      [chatTurn, ...Array.from({ length: MAX_RESUME_HOPS + 1 }, (_, i) => resume(`h${i}`, i === 0 ? "run-turn" : `h${i - 1}`))],
      `h${MAX_RESUME_HOPS}`,
    ],
  ];
  for (const [name, rows, id] of broken) {
    it(`${name}: broken`, async () => {
      expect(await resolveChatTurnChain(fakeDb(rows), T, id)).toEqual({ ok: false, reason: "broken" });
    });
  }

  it("exactly MAX_RESUME_HOPS resumes still resolve", async () => {
    const rows = [chatTurn, ...Array.from({ length: MAX_RESUME_HOPS }, (_, i) => resume(`h${i}`, i === 0 ? "run-turn" : `h${i - 1}`))];
    const res = await resolveChatTurnChain(fakeDb(rows), T, `h${MAX_RESUME_HOPS - 1}`);
    expect(res.ok && res.chain.length).toBe(MAX_RESUME_HOPS + 1);
  });

  it("throws on a failed read", async () => {
    await expect(resolveChatTurnChain(fakeDb([chatTurn, resume("r1", "run-turn")], { failOn: "run-turn" }), T, "r1")).rejects.toThrow(/run read failed/);
  });
});
