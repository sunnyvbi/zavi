import { describe, expect, it } from "vitest";
import { nextMove, readRedditAutopilotState, type AutopilotStateDeps } from "./autopilot-state";

const GOAL = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NOW = new Date("2026-10-12T12:00:00Z");
const limits = { ad_account_id: "acct", name: "limits", rationale: "r", origin: "specialist", daily_limit_usd: 25, campaign_lifetime_limit_usd: 300, objectives: ["CLICKS"], geolocations: ["US"], expires_at: "2026-12-01T00:00:00.000Z", goal_id: GOAL };
type Op = { operation_key: string; step: string; state: string; request: Record<string, unknown> | null; result: unknown };
const prepared = (key: string, account = "acct"): Op[] => [
  { operation_key: key, step: "plan", state: "complete", request: { ad_account_id: account }, result: null },
  { operation_key: key, step: "manifest", state: "complete", request: null, result: { id: `c-${key}` } },
];
const enabled = (key: string): Op => ({ operation_key: key, step: `enable_c-${key}`, state: "complete", request: null, result: null });

function deps(over: Partial<AutopilotStateDeps> = {}): AutopilotStateDeps {
  return {
    authority: async () => limits,
    goals: async () => [{ id: GOAL, objective: "More bookings", target_metric: "bookings", status: "active" }],
    runGoal: async () => GOAL,
    openCards: async () => [],
    operations: async () => [],
    activeCampaigns: async () => [],
    verifyPrepared: async () => ({ ok: true }),
    ...over,
  };
}
const read = (d: AutopilotStateDeps) => readRedditAutopilotState("t", "acct", "run-1", NOW, d);

describe("readRedditAutopilotState", () => {
  it("no grant: the founder's authorization is next, with the active goals and this run's goal to name", async () => {
    const r = await read(deps({ authority: async () => null }));
    expect(r.authority).toEqual({ state: "none", limits: null });
    expect(r.active_goals).toEqual([{ goal_id: GOAL, objective: "More bookings", target_metric: "bookings" }]);
    expect(r.run_goal_id).toBe(GOAL);
    expect(r.next.tool).toBe("reddit_ads__propose_authorize_account");
  });

  it("an expired grant, or one whose goal is no longer active, is renewed first", async () => {
    expect((await read(deps({ authority: async () => ({ ...limits, expires_at: "2026-10-01T00:00:00.000Z" }) }))).authority.state).toBe("expired");
    const r = await read(deps({ goals: async () => [] }));
    expect(r.authority.state).toBe("goal_inactive");
    expect(r.next.tool).toBe("reddit_ads__propose_authorize_account");
  });

  it("granted and nothing prepared: prepare; prepared and paused: launch it; another account's operation does not count", async () => {
    let r = await read(deps({ operations: async () => prepared("op_other_1", "other") }));
    expect(r.authority).toMatchObject({ state: "granted", limits: { daily_limit_usd: 25, goal_id: GOAL } });
    expect(r.prepared_not_launched).toEqual([]);
    expect(r.next.tool).toBe("reddit_ads__propose_prepare_campaign");
    r = await read(deps({ operations: async () => prepared("op_spring_1") }));
    expect(r.prepared_not_launched).toEqual(["op_spring_1"]);
    expect(r.next).toMatchObject({ tool: "reddit_ads__propose_launch_campaign", why: expect.stringContaining("op_spring_1") });
  });

  it("an open lifecycle card for this account is the next step: no new card", async () => {
    const r = await read(deps({ openCards: async (_t, cls) => (cls === "reddit_ads.prepare_campaign" ? [{ action_id: "card-1", exec_payload: { ad_account_id: "acct", operation_key: "op_spring_1" } }] : []) }));
    expect(r.open_cards).toEqual([{ action_id: "card-1", exec_class: "reddit_ads.prepare_campaign", operation_key: "op_spring_1" }]);
    expect(r.next.tool).toBeNull();
  });

  it("a Zavi campaign still switched on: no second test; once it is off, the next one is prepared", async () => {
    const ops = async () => [...prepared("op_spring_1"), enabled("op_spring_1")];
    let r = await read(deps({ operations: ops, activeCampaigns: async (_t, _a, ids) => ids }));
    expect(r.running).toEqual([{ operation_key: "op_spring_1", campaign_id: "c-op_spring_1" }]);
    expect(r.next.tool).toBeNull();
    r = await read(deps({ operations: ops, activeCampaigns: async () => [] }));
    expect(r.prepared_not_launched).toEqual([]);
    expect(r.next.tool).toBe("reddit_ads__propose_prepare_campaign");
  });

  it("any read that fails is unreadable, and then no card is named (never a guess)", async () => {
    const boom = async () => {
      throw new Error("down");
    };
    for (const d of [deps({ authority: boom }), deps({ openCards: boom }), deps({ operations: boom }), deps({ operations: async () => [...prepared("op_spring_1"), enabled("op_spring_1")], activeCampaigns: boom })]) {
      expect((await read(d)).next.tool).toBeNull();
    }
  });
});

describe("a prepared campaign is offered to launch only while Reddit still shows it exactly as prepared", () => {
  it("edited, archived or deleted since: never offered to launch; the next card re-prepares with a new key", async () => {
    const r = await read(deps({ operations: async () => prepared("op_spring_1"), verifyPrepared: async () => ({ ok: false, why: "its ad group g1 was changed in Reddit after preparation" }) }));
    expect(r.prepared_not_launched).toEqual([]);
    expect(r.prepared_drifted).toEqual([{ operation_key: "op_spring_1", why: "its ad group g1 was changed in Reddit after preparation" }]);
    expect(r.next).toMatchObject({ tool: "reddit_ads__propose_prepare_campaign", why: expect.stringContaining("NEW operation_key") });
  });

  it("one drifted and one intact: the intact one is launched", async () => {
    const r = await read(deps({ operations: async () => [...prepared("op_new_22"), ...prepared("op_old_11")], verifyPrepared: async (_t, _a, key) => (key === "op_old_11" ? { ok: false, why: "archived" } : { ok: true }) }));
    expect(r.prepared_not_launched).toEqual(["op_new_22"]);
    expect(r.next.tool).toBe("reddit_ads__propose_launch_campaign");
  });

  it("the live check cannot be read: no card is named", async () => {
    const r = await read(deps({ operations: async () => prepared("op_spring_1"), verifyPrepared: async () => { throw new Error("reddit down"); } }));
    expect(r.prepared_not_launched).toBe("unreadable");
    expect(r.next.tool).toBeNull();
  });
});

describe("nextMove", () => {
  it("is pure and orders open card > running > authority > prepared > prepare", () => {
    expect(nextMove("none", [{ action_id: "a", exec_class: "reddit_ads.authorize_account", operation_key: null }], [], []).tool).toBeNull();
    expect(nextMove("granted", [], ["k"], []).tool).toBe("reddit_ads__propose_launch_campaign");
    expect(nextMove("none", [], ["k"], []).tool).toBe("reddit_ads__propose_authorize_account");
  });
});
describe("prepared campaigns still in Reddit review", () => {
  it("are offered to launch but never called ready", () => {
    const next = nextMove("granted", [], ["op_spring_1"], [], [], [{ operation_key: "op_spring_1", ad_status: "PENDING_APPROVAL" }]);
    expect(next.tool).toBe("reddit_ads__propose_launch_campaign");
    expect(next.why).toContain("still reviewing");
    expect(nextMove("granted", [], ["op_spring_1"], []).why).not.toContain("reviewing");
  });
});
