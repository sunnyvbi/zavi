import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));

const rows: Record<string, unknown[]> = {};
const failing = new Set<string>();

vi.mock("@/services/tenant-client", () => {
  const chain = (table: string): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "gte", "order", "limit", "is", "neq", "not"]) {
      self[m] = () => self;
    }
    self.maybeSingle = async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null });
    self.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        failing.has(table) ? { data: null, error: { message: "boom" } } : { data: rows[table] ?? [], error: null },
      ).then(resolve);
    return self;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: (table: string) => chain(table) }),
    tenantRpc: vi.fn(async () => ({ data: null, error: null })),
  };
});
vi.mock("@/services/growth/preview-plan", () => ({ planIncludesChannel: vi.fn(async () => true) }));
vi.mock("@/services/channels/preview-run-starts", () => ({ previewRunStarts: vi.fn(async () => new Map()) }));

import { stepDecisionBodies } from "@/agents/lib/channel-recipe-step";
import {
  listChannelActions,
  planDay,
  recordChannelRunActions,
  scheduledAtForDay,
  timeInZone,
  seriesOf,
  stagedPostsForCards,
  type ScoreContext,
} from "../channel-actions";

const SERIES = {
  id: "friday-teardown",
  name: "The Friday teardown",
  format: "One competitor listing, three fixes, 30 seconds",
  episode: 1,
  next: ["Teardown 2: the pricing page", "Teardown 3: the signup form"],
};

const ENVELOPE = {
  rendered_markdown: "plan",
  steps: [
    {
      title: "Post the teardown reel",
      body: "b",
      blocking: false,
      effort: "minutes",
      evidence: ["read this run"],
      action_type: "video_post",
      publish_on: "2026-10-02",
      series: SERIES,
      deliverable: { kind: "script", label: "Episode 1", content: "Hook: three fixes for one listing." },
    },
  ],
};

const CTX: ScoreContext = {
  channel_in_plan: true,
  goal_metric_keys: new Set(),
  rejected_title_keys: new Set(),
  rejected_ids: new Set(),
};

describe("writer pass-through", () => {
  it("stores the step's publish_on and series in the body it records", async () => {
    const rpc = vi.fn(async (_tid: unknown, name: string, _args: Record<string, unknown>) =>
      name === "record_channel_run_actions"
        ? { data: { inserted: 1, metrics: 0, stale_accepted: 0, stale_dropped: 0, ids: [{ position: 1, id: "a1" }] }, error: null }
        : { data: { ok: true }, error: null },
    );
    await recordChannelRunActions(
      {
        tenantId: "t-1",
        runId: "run-1",
        channelSlug: "instagram_organic",
        envelope: ENVELOPE,
        bodies: stepDecisionBodies(ENVELOPE),
        redo: null,
      },
      {
        rpc: rpc as never,
        loadScoreContext: async () => CTX,
        ledger: { figureWasRead: () => false, ledgerIsEmpty: () => true },
        stagedPosts: async () => [],
        runImages: async () => [],
        siteBuilder: async () => "unknown",
        loadMatchPool: async () => [],
        matchCards: async () => null,
      },
    );
    const call = rpc.mock.calls.find((c) => c[1] === "record_channel_run_actions");
    const step = ((call?.[2].p_actions as Array<{ body: { step: Record<string, unknown> } }>)[0]).body.step;
    expect(step.publish_on).toBe("2026-10-02");
    expect(step.series).toEqual(SERIES);
  });
});

function row(id: string, body: unknown, run_id = "run-1") {
  return {
    id,
    channel_slug: "x_organic",
    run_id,
    position: 1,
    run_of: 1,
    blocking: false,
    action_type: "text_post",
    title: id,
    title_key: id,
    body,
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 0,
    score_inputs: {},
    proposed_at: "2026-09-29T10:00:00Z",
    repeat_of: null,
    redo_of: null,
    exec_class: null,
    exec_payload: null,
    exec_status: null,
    edited_body: null,
  };
}

const post = (content: string, extra: Record<string, unknown> = {}) => ({
  step: { title: "Post", deliverable: { kind: "post", label: "Post", content }, ...extra },
});

describe("listChannelActions serves one day per card", () => {
  const setRows = () => {
    rows.channel_actions = [
      row("staged", post("Stop reconciling payouts weekly.", { publish_on: "2026-10-01" })),
      row("planned", post("A different post entirely.", { publish_on: "2026-10-03", series: SERIES })),
      row("none", post("No day on this one.")),
      row("bad-series", post("Odd series.", { series: { id: "x", name: "n" } })),
    ];
    rows.decisions = [
      { id: "d1", agent_run_id: "run-1", body: { payload: { text: "Stop reconciling payouts weekly." }, scheduled_at: "2026-10-04T16:30:00Z" } },
      { id: "d2", agent_run_id: "run-9", body: { payload: { text: "A different post entirely." }, scheduled_at: "2026-10-09T16:30:00Z" } },
    ];
    rows.tenants = [{ timezone: "America/Los_Angeles" }];
    rows.tenant_channels = [];
    rows.autopilot_goals = [];
  };

  it("scheduled_at of the staged post wins (as a tenant-local day); else publish_on; else null", async () => {
    setRows();
    const out = await listChannelActions("t-1", "x_organic", { all: true });
    const byId = new Map(out.actions.map((a) => [a.id, a]));
    expect(byId.get("staged")).toMatchObject({ plan_day: "2026-10-04", plan_day_source: "scheduled", series: null });
    expect(byId.get("planned")).toMatchObject({ plan_day: "2026-10-03", plan_day_source: "planned", series: SERIES });
    expect(byId.get("none")).toMatchObject({ plan_day: null, plan_day_source: null, series: null });
    expect(byId.get("bad-series")?.series).toBeNull();
  });

  it("a failed proposals read keeps every card's planned day and the list", async () => {
    setRows();
    failing.add("decisions");
    try {
      const out = await listChannelActions("t-1", "x_organic", { all: true });
      const byId = new Map(out.actions.map((a) => [a.id, a]));
      expect(out.actions).toHaveLength(4);
      expect(byId.get("staged")).toMatchObject({ plan_day: "2026-10-01", plan_day_source: "planned" });
    } finally {
      failing.delete("decisions");
    }
  });

  it("an ambiguous pairing keeps the planned day", async () => {
    setRows();
    rows.decisions = [
      ...(rows.decisions as unknown[]),
      { id: "d3", agent_run_id: "run-1", body: { payload: { text: "Stop reconciling payouts weekly." }, scheduled_at: "2026-10-08T16:30:00Z" } },
    ];
    const out = await listChannelActions("t-1", "x_organic", { all: true });
    expect(out.actions.find((a) => a.id === "staged")).toMatchObject({ plan_day: "2026-10-01", plan_day_source: "planned" });
  });
});

describe("stagedPostsForCards", () => {
  const card = (id: string, text: string) => ({ id, run_id: "run-1", body: post(text) });
  const proposal = (id: string, text: string, status = "proposed") => ({ id, agent_run_id: "run-1", status, body: { payload: { text }, scheduled_at: null } });

  it("throws on a failed read, so a writer can never mistake it for 'not staged'", async () => {
    failing.add("decisions");
    try {
      await expect(stagedPostsForCards("t-1" as never, [card("a", "Hello there")])).rejects.toThrow(/staged posts read failed/);
    } finally {
      failing.delete("decisions");
    }
  });

  it("pairs one-to-one only; two cards on one proposal, or one card on two, are ambiguous", async () => {
    const opening = "x".repeat(130);
    rows.decisions = [proposal("p1", `${opening} one`), proposal("p2", "Unique post")];
    const m = await stagedPostsForCards("t-1" as never, [
      card("a", `${opening} alpha`),
      card("b", `${opening} beta`),
      card("c", "Unique post"),
    ]);
    expect(m.get("a")).toEqual({ kind: "ambiguous" });
    expect(m.get("b")).toEqual({ kind: "ambiguous" });
    expect(m.get("c")).toEqual({ kind: "paired", decision_id: "p2", scheduled_at: null });

    rows.decisions = [proposal("p1", `${opening} one`), proposal("p3", `${opening} two`)];
    const m2 = await stagedPostsForCards("t-1" as never, [card("a", `${opening} alpha`)]);
    expect(m2.get("a")).toEqual({ kind: "ambiguous" });
    rows.decisions = [];
  });

  it("lets the write path distinguish a matching decided proposal from a card that was never staged", async () => {
    rows.decisions = [proposal("p1", "Already approved post", "approved")];
    const decided = await stagedPostsForCards(
      "t-1" as never,
      [card("a", "Already approved post")],
      { includeDecided: true },
    );
    expect(decided.get("a")).toEqual({ kind: "not_pending", status: "approved" });
    const decoration = await stagedPostsForCards("t-1" as never, [card("a", "Already approved post")]);
    expect(decoration.has("a")).toBe(false);
    rows.decisions = [];
  });

  it("does not let a decided proposal block a different card that only shares its first 120 characters", async () => {
    const opening = "same opening ".repeat(12);
    rows.decisions = [proposal("p1", `${opening}first ending`, "approved")];
    const pairings = await stagedPostsForCards(
      "t-1" as never,
      [card("a", `${opening}first ending`), card("b", `${opening}different ending`)],
      { includeDecided: true },
    );
    expect(pairings.get("a")).toEqual({ kind: "not_pending", status: "approved" });
    expect(pairings.has("b")).toBe(false);
    rows.decisions = [];
  });

  it("recognizes an approved X thread by its exact root and tail", async () => {
    rows.decisions = [{
      id: "p1",
      agent_run_id: "run-1",
      status: "approved",
      body: { payload: { text: "Root post", thread: ["Second post", "Third post"] }, scheduled_at: null },
    }];
    const pairings = await stagedPostsForCards(
      "t-1" as never,
      [card("a", "Root post\n---\nSecond post\n---\nThird post")],
      { includeDecided: true },
    );
    expect(pairings.get("a")).toEqual({ kind: "not_pending", status: "approved" });
    rows.decisions = [];
  });

  it("lets a rejected or expired proposal's open card be planned again", async () => {
    for (const status of ["rejected", "expired"]) {
      rows.decisions = [proposal("p1", "Try this post again", status)];
      const pairings = await stagedPostsForCards(
        "t-1" as never,
        [card("a", "Try this post again")],
        { includeDecided: true },
      );
      expect(pairings.has("a"), status).toBe(false);
    }
    rows.decisions = [];
  });

  it("still recognizes a decided edited proposal by the original copy stored with the draft", async () => {
    rows.decisions = [{
      id: "p1",
      agent_run_id: "run-1",
      status: "approved",
      body: {
        payload: { text: "Founder-edited copy" },
        post_draft_original: { payload: { text: "Original card copy" } },
        scheduled_at: null,
      },
    }];
    const pairings = await stagedPostsForCards(
      "t-1" as never,
      [card("a", "Original card copy")],
      { includeDecided: true },
    );
    expect(pairings.get("a")).toEqual({ kind: "not_pending", status: "approved" });
    rows.decisions = [];
  });
});

describe("scheduledAtForDay", () => {
  const now = Date.UTC(2026, 9, 1, 12, 0);
  it("is 09:00 that day in the tenant's zone (DST-correct)", () => {
    expect(scheduledAtForDay("2026-10-05", "America/Los_Angeles", now)).toBe("2026-10-05T16:00:00.000Z");
    expect(scheduledAtForDay("2026-12-05", "America/Los_Angeles", now)).toBe("2026-12-05T17:00:00.000Z");
    expect(scheduledAtForDay("2026-10-05", "Asia/Kolkata", now)).toBe("2026-10-05T03:30:00.000Z");
  });
  it("is the picked time that day in the tenant's zone", () => {
    expect(scheduledAtForDay("2026-10-05", "America/Los_Angeles", now, "12:43")).toBe("2026-10-05T19:43:00.000Z");
    expect(scheduledAtForDay("2026-10-05", "Asia/Kolkata", now, "00:05")).toBe("2026-10-04T18:35:00.000Z");
  });
  it("refuses an explicit time that has passed", () => {
    expect(scheduledAtForDay("2026-10-01", "America/Los_Angeles", now, "04:00")).toBeNull();
  });
  it("refuses a nonexistent or ambiguous DST wall clock instead of silently changing it", () => {
    expect(scheduledAtForDay("2027-03-14", "America/New_York", now, "02:30")).toBeNull();
    expect(scheduledAtForDay("2027-11-07", "America/New_York", now, "01:30")).toBeNull();
  });
  it("timeInZone reads an instant as the tenant's wall clock, 24h", () => {
    expect(timeInZone("2026-10-05T19:43:00Z", "America/Los_Angeles")).toBe("12:43");
    expect(timeInZone("2026-10-05T07:05:00Z", "America/Los_Angeles")).toBe("00:05");
    expect(timeInZone("nope", "America/Los_Angeles")).toBeNull();
  });
  it("is 15 minutes from now when that 09:00 has passed", () => {
    expect(scheduledAtForDay("2026-09-20", "America/Los_Angeles", now)).toBe(new Date(now + 15 * 60_000).toISOString());
  });
});

describe("planDay / seriesOf (pure)", () => {
  it("reads a scheduled instant as the tenant's local day", () => {
    expect(planDay({}, "2026-10-04T20:00:00Z", "Pacific/Auckland")).toEqual({ plan_day: "2026-10-05", plan_day_source: "scheduled" });
  });
  it("a staged proposal without a time keeps the planned day", () => {
    expect(planDay({ step: { publish_on: "2026-10-01" } }, null)).toEqual({ plan_day: "2026-10-01", plan_day_source: "planned" });
  });
  it("an invalid stored day serves null", () => {
    expect(planDay({ step: { publish_on: "Monday" } })).toEqual({ plan_day: null, plan_day_source: null });
    expect(planDay(null)).toEqual({ plan_day: null, plan_day_source: null });
  });
  it("a series with no next serves an empty list", () => {
    const { next: _n, ...rest } = SERIES;
    void _n;
    expect(seriesOf({ step: { series: rest } })).toEqual({ ...rest, next: [] });
  });
});
