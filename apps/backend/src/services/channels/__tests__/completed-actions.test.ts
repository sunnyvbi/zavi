import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn() }));

type Row = Record<string, unknown>;
const rows: Record<string, Row[]> = {};
const failing = new Set<string>();

vi.mock("@/services/tenant-client", () => {
  const chain = (table: string): Record<string, unknown> => {
    const filters: Array<(r: Row) => boolean> = [];
    let selected = "";
    let span: [number, number] | null = null;
    const self: Record<string, unknown> = {};
    self.select = (cols: string) => { selected = cols; return self; };
    const at = (r: Row, k: string) => {
      const [col, key] = k.split("->>");
      if (key === undefined) return r[col];
      const j = r[col] as Record<string, unknown> | null | undefined;
      return j && typeof j === "object" ? (j[key] ?? null) : null;
    };
    self.eq = (k: string, v: unknown) => { filters.push((r) => at(r, k) === undefined || at(r, k) === v); return self; };
    self.in = (k: string, vs: unknown[]) => { filters.push((r) => r[k] === undefined || vs.includes(r[k])); return self; };
    for (const m of ["gte", "order", "limit", "is", "neq", "not", "lte", "like"]) self[m] = () => self;
    self.range = (a: number, b: number) => { span = [a, Math.min(b, a + 999)]; return self; };
    self.maybeSingle = async () => ({ data: (rows[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
    self.then = (resolve: (v: unknown) => unknown) => {
      void selected;
      if (failing.has(table)) return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
      const all = (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const data = span ? all.slice(span[0], span[1] + 1) : all.slice(0, 1000);
      return Promise.resolve({ data, error: null }).then(resolve);
    };
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

import { listChannelActions, listCompletedChannelActions } from "../channel-actions";
import { COMPLETED_MAX, outcomeOf, pickCompleted, shownUntil } from "../completed-actions";
import { readoutDay } from "@/services/growth/cgo-tests";

const NOW = Date.parse("2026-10-18T05:00:00Z");
const DAY = 86_400_000;
const CGO = "cgo.dispatch-specialist";
const TEST = { variable: "daily budget $110 to $120", baseline: "Oct 10 to 16: 13 conversions", success_if: "cost per conversion stays under $80", readout_on: "2026-10-24" };

function card(id: string, over: Row = {}): Row {
  return {
    tenant_id: "t1",
    id,
    channel_slug: "google_ads",
    run_id: `run-${id}`,
    position: 1,
    run_of: 1,
    blocking: false,
    action_type: "update_ad",
    title: `Card ${id}`,
    title_key: `card ${id}`,
    body: { step: { title: `Card ${id}`, body: "b" } },
    status: "acted",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 0,
    score_inputs: null,
    proposed_at: "2026-10-17T01:55:00Z",
    repeat_of: null,
    redo_of: null,
    exec_class: "google_ads.update_campaign_budget_review",
    exec_payload: { campaign_id: "1", daily_budget_usd: 120 },
    exec_status: "executed",
    exec_result: { notice: "Set the daily budget to $120/day." },
    executed_at: "2026-10-18T04:31:11Z",
    edited_body: null,
    card_kind: null,
    primary_label: null,
    done_label: null,
    how_to: null,
    steps_done: null,
    cgo_hold: null,
    ...over,
  };
}

const move = (body: Row) => ({ id: "m1", decision_class: CGO, emitted_at: "2026-10-17T01:54:00Z", body });

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
  failing.clear();
});

describe("readoutDay", () => {
  it("is the readout date when the change went live on time", () => {
    expect(readoutDay("2026-10-17T01:54:00Z", TEST, "2026-10-18T04:31:00Z")).toBe("2026-10-25");
    expect(readoutDay("2026-10-17T01:54:00Z", TEST, "2026-10-17T02:00:00Z")).toBe("2026-10-24");
    expect(readoutDay("2026-10-17T01:54:00Z", TEST, null)).toBe("2026-10-24");
  });
});

describe("outcomeOf", () => {
  it("reads an Autopilot test, launch-adjusted, with no verdict yet", () => {
    const o = outcomeOf(move({ dispatched_by: "cgo", test: TEST }), CGO, "2026-10-17T02:00:00Z");
    expect(o).toEqual({ readout_on: "2026-10-24", success_if: TEST.success_if });
  });
  it("carries the saved verdict and its result", () => {
    const o = outcomeOf(
      move({ dispatched_by: "cgo", test: TEST, test_readout: { verdict: "did_not_work", result: "Cost per conversion rose to $91.", read_at: "2026-10-24T10:00:00Z" } }),
      CGO,
      "2026-10-17T02:00:00Z",
    );
    expect(o).toMatchObject({ verdict: "did_not_work", result: "Cost per conversion rose to $91.", read_at: "2026-10-24T10:00:00Z" });
  });
  it("reads the day from the move's launch, not this card's own run", () => {
    expect(outcomeOf(move({ dispatched_by: "cgo", test: TEST }), CGO, "2026-10-18T04:00:00Z")?.readout_on).toBe("2026-10-25");
  });
  it("promises no day while the tested change is not live (a paused create)", () => {
    expect(outcomeOf(move({ dispatched_by: "cgo", test: TEST }), CGO, null)).toEqual({ readout_on: null, success_if: TEST.success_if });
  });
  it("is null for a move that is not Autopilot's, has no test, or a bad verdict is ignored", () => {
    expect(outcomeOf(move({ dispatched_by: "founder", test: TEST }), CGO, "2026-10-17T02:00:00Z")).toBeNull();
    expect(outcomeOf(move({ dispatched_by: "cgo" }), CGO, "2026-10-17T02:00:00Z")).toBeNull();
    expect(outcomeOf({ ...move({ dispatched_by: "cgo", test: TEST }), decision_class: "other" }, CGO, "2026-10-17T02:00:00Z")).toBeNull();
    expect(outcomeOf(null, CGO, "2026-10-17T02:00:00Z")).toBeNull();
    const bad = outcomeOf(move({ dispatched_by: "cgo", test: TEST, test_readout: { verdict: "great" } }), CGO, "2026-10-17T02:00:00Z");
    expect(bad?.verdict).toBeUndefined();
  });
});

describe("shownUntil / pickCompleted", () => {
  const ran = "2026-10-18T04:31:11Z";
  it("keeps a plain change seven days, a waiting test until its verdict, and a verdict seven more days", () => {
    expect(shownUntil(ran, null)).toBe(Date.parse(ran) + 7 * DAY);
    expect(shownUntil(ran, { readout_on: "2026-10-24", success_if: "x" })).toBeNull();
    expect(shownUntil(ran, { readout_on: "2026-10-24", success_if: "x", verdict: "worked", read_at: "2026-10-25T00:00:00Z" })).toBe(Date.parse("2026-11-01T00:00:00Z"));
  });

  it("drops what aged out, sorts newest first and keeps waiting tests ahead of the cap", () => {
    const old = { id: "old", executed_at: new Date(NOW - 8 * DAY).toISOString() };
    const oldTest = { id: "oldTest", executed_at: new Date(NOW - 20 * DAY).toISOString() };
    const recent = Array.from({ length: COMPLETED_MAX + 2 }, (_, i) => ({ id: `r${i}`, executed_at: new Date(NOW - (i + 1) * 3_600_000).toISOString() }));
    const outcomes = new Map([["oldTest", { readout_on: "2026-10-30", success_if: "x" }]]);
    const picked = pickCompleted([old, oldTest, ...recent], outcomes, NOW);
    expect(picked).toHaveLength(COMPLETED_MAX);
    expect(picked.map((p) => p.id)).not.toContain("old");
    expect(picked.map((p) => p.id)).toContain("oldTest");
    expect(picked[0].id).toBe("r0");
    expect(picked.find((p) => p.id === "oldTest")?.outcome).toEqual({ readout_on: "2026-10-30", success_if: "x" });
  });

  it("never serves read_at on the wire", () => {
    const picked = pickCompleted([{ id: "a", executed_at: new Date(NOW - DAY).toISOString() }], new Map([["a", { readout_on: "2026-10-24", success_if: "x", verdict: "worked" as const, result: "12 more", read_at: new Date(NOW).toISOString() }]]), NOW);
    expect(picked[0].outcome).toEqual({ readout_on: "2026-10-24", success_if: "x", verdict: "worked", result: "12 more" });
  });
});

describe("listCompletedChannelActions", () => {
  const MOVE = { tenant_id: "t1", id: "m1", status: "acted", decision_class: CGO, emitted_at: "2026-10-17T01:54:00Z", dispatched_by: "cgo", target_agent_slug: "google_ads", test: TEST, test_readout: null };
  const run = (id: string) => ({ tenant_id: "t1", id, status: "success", finished_at: "2026-10-17T02:00:00Z", source_decision_id: "m1", cgo_reply: null });

  it("serves the executed card with its run time and the Autopilot test behind it", async () => {
    rows.channel_actions = [card("a1", { status_at: "2026-10-18T04:31:11Z" })];
    rows.agent_runs = [run("run-a1")];
    rows.decisions = [MOVE];
    const done = await listCompletedChannelActions("t1", "google_ads", NOW);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: "a1", exec_status: "executed", executed_at: "2026-10-18T04:31:11Z", outcome: { readout_on: "2026-10-25", success_if: TEST.success_if } });
    expect(done[0]).not.toHaveProperty("exec_payload");
    expect(done[0]).not.toHaveProperty("exec_result");
  });

  it("gives two cards of one move the same day: the move went live with the first", async () => {
    rows.channel_actions = [
      card("a1", { run_id: "run-1", executed_at: "2026-10-17T03:00:00Z", status_at: "2026-10-17T03:00:00Z" }),
      card("a2", { run_id: "run-2", executed_at: "2026-10-18T04:31:11Z", status_at: "2026-10-18T04:31:11Z" }),
    ];
    rows.agent_runs = [run("run-1"), run("run-2")];
    rows.decisions = [MOVE];
    const done = await listCompletedChannelActions("t1", "google_ads", NOW);
    expect(done.map((d) => [d.id, d.outcome?.readout_on])).toEqual([["a2", "2026-10-24"], ["a1", "2026-10-24"]]);
  });

  it("keeps a waiting test that sits past the API's first 1000 rows", async () => {
    const plain = Array.from({ length: 1200 }, (_, i) =>
      card(`p${i}`, { run_id: `plain-${i}`, executed_at: new Date(NOW - 3_600_000 - i * 60_000).toISOString(), status_at: new Date(NOW - 3_600_000 - i * 60_000).toISOString() }),
    );
    const waiting = card("w1", { run_id: "run-w1", executed_at: new Date(NOW - 20 * DAY).toISOString(), status_at: new Date(NOW - 20 * DAY).toISOString() });
    rows.channel_actions = [...plain, waiting];
    rows.agent_runs = [run("run-w1")];
    rows.decisions = [{ ...MOVE, test: { ...TEST, readout_on: "2026-11-05" } }];
    const done = await listCompletedChannelActions("t1", "google_ads", NOW);
    expect(done).toHaveLength(COMPLETED_MAX);
    expect(done.map((d) => d.id)).toContain("w1");
  });

  it("throws when the result read fails, so a waiting test is never shown as a plain change", async () => {
    rows.channel_actions = [card("a1")];
    failing.add("agent_runs");
    await expect(listCompletedChannelActions("t1", "google_ads", NOW)).rejects.toThrow(/done card runs/);
  });

  it("serves a refused change (closed after the platform said no) beside the executed ones, newest first, for seven days", async () => {
    const refused = (id: string, closedAt: string, bucket = "blocked_on_us") =>
      card(id, {
        status: "stale",
        exec_status: "failed",
        executed_at: null,
        status_at: closedAt,
        note: "Meta Ads refused this change. We've been alerted.",
        exec_result: { error: "Meta Ads (#100) Invalid parameter", code: "meta_ads_bid_unavailable", bucket },
      });
    rows.channel_actions = [
      card("a1", { executed_at: "2026-10-17T04:00:00Z" }),
      refused("r1", "2026-10-18T01:00:00Z"),
      refused("r-old", new Date(NOW - 8 * DAY).toISOString()),
      refused("r-temp", "2026-10-18T02:00:00Z", "temporary"),
    ];
    const done = await listCompletedChannelActions("t1", "google_ads", NOW);
    expect(done.map((d) => d.id)).toEqual(["r1", "a1"]);
    expect(done[0]).toMatchObject({ exec_status: "failed", exec_bucket: "blocked_on_us", exec_code: "meta_ads_bid_unavailable", note: "Meta Ads refused this change. We've been alerted.", outcome: null });
    expect(done[0].executed_at).toBeNull();
    expect(JSON.stringify(done[0])).not.toContain("Invalid parameter");
  });

  it("leaves out a manual done step and a card from another channel", async () => {
    rows.channel_actions = [card("a1", { exec_status: null }), card("a2", { channel_slug: "meta_ads" })];
    expect(await listCompletedChannelActions("t1", "google_ads", NOW)).toEqual([]);
  });
});

describe("listChannelActions withCompleted", () => {
  it("returns the done cards beside the open list, and only when asked", async () => {
    rows.channel_actions = [card("open", { status: "pending", exec_status: null, executed_at: null }), card("done")];
    const withDone = await listChannelActions("t1", "google_ads", { all: true, nowMs: NOW, withCompleted: true });
    expect(withDone.actions.map((a) => a.id)).toEqual(["open"]);
    expect(withDone.completed?.map((a) => a.id)).toEqual(["done"]);
    const plain = await listChannelActions("t1", "google_ads", { all: true, nowMs: NOW });
    expect(plain).not.toHaveProperty("completed");
  });

  it("leaves a card that settled between the reads out of the ranking, its slot and its count", async () => {
    const open = Array.from({ length: 6 }, (_, i) => card(`o${i}`, { status: "pending", exec_status: null, executed_at: null, title_key: `o${i}` }));
    rows.channel_actions = [...open, card("o0", { status: "acted" })];
    const out = await listChannelActions("t1", "google_ads", { nowMs: NOW, withCompleted: true });
    expect(out.completed?.map((a) => a.id)).toEqual(["o0"]);
    expect(out.actions.map((a) => a.id)).not.toContain("o0");
    expect(out.actions.length + out.more).toBe(5);
  });

  it("with a viewer, executable cards carry who approved and their history; ids never reach the wire", async () => {
    rows.channel_actions = [
      card("open", { status: "pending", exec_status: "dispatching", executed_at: null, approved_by: "u-owner", approved_by_source: "cgo", exec_claimed_at: "2026-10-18T04:20:00Z" }),
      card("done", { approved_by: "u-viewer", approved_by_source: null, exec_claimed_at: "2026-10-18T04:30:00Z" }),
    ];
    rows.channel_action_events = [
      { tenant_id: "t1", id: 1, action_id: "open", event: "approved", actor_kind: "system", at: "2026-10-18T04:19:00Z", note: "n", actor_user_id: "u-owner" },
      { tenant_id: "t1", id: 2, action_id: "done", event: "approved", actor_kind: "founder", at: "2026-10-18T04:29:00Z", note: "n", actor_user_id: "u-viewer" },
      { tenant_id: "t1", id: 3, action_id: "done", event: "executed", actor_kind: "system", at: "2026-10-18T04:31:11Z", note: "n", actor_user_id: null },
    ];
    const out = await listChannelActions("t1", "google_ads", { all: true, nowMs: NOW, withCompleted: true, viewerUserId: "u-viewer" });
    expect(out.actions[0]).toMatchObject({ id: "open", approval: { by: "autopilot", name: null, at: "2026-10-18T04:19:00Z" }, exec_started_at: "2026-10-18T04:20:00Z" });
    expect(out.completed?.[0]).toMatchObject({
      id: "done",
      approval: { by: "you", at: "2026-10-18T04:29:00Z" },
      timeline: [
        { kind: "approved", at: "2026-10-18T04:29:00Z", by: "you" },
        { kind: "sent", at: "2026-10-18T04:30:00Z" },
        { kind: "executed", at: "2026-10-18T04:31:11Z" },
      ],
    });
    const wire = JSON.stringify(out);
    for (const leak of ["u-owner", "u-viewer", "approved_by", "exec_claimed_at", "actor_user_id"]) expect(wire).not.toContain(leak);
  });

  it("serves the cards without approval when the events read fails", async () => {
    rows.channel_actions = [card("open", { status: "pending", exec_status: "dispatching", executed_at: null, approved_by: "u-viewer" }), card("done")];
    failing.add("channel_action_events");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await listChannelActions("t1", "google_ads", { all: true, nowMs: NOW, withCompleted: true, viewerUserId: "u-viewer" });
    spy.mockRestore();
    expect(out.actions.map((a) => a.id)).toEqual(["open"]);
    expect(out.completed?.map((a) => a.id)).toEqual(["done"]);
    expect(out.actions[0]).not.toHaveProperty("approval");
    expect(out.completed?.[0]).not.toHaveProperty("timeline");
  });

  it("omits completed (the page keeps what it showed) when the done read fails, and still serves the open list", async () => {
    rows.channel_actions = [card("open", { status: "pending", exec_status: null, executed_at: null }), card("done")];
    failing.add("agent_runs");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const out = await listChannelActions("t1", "google_ads", { all: true, nowMs: NOW, withCompleted: true });
    spy.mockRestore();
    expect(out.actions.map((a) => a.id)).toEqual(["open"]);
    expect(out).not.toHaveProperty("completed");
  });
});

describe("listCompletedChannelActions: a post the founder pressed Post on went live", () => {
  const TEXT = "Our first paid ads test is live.\n\nHere is what we learned.";
  const URL_LIVE = "https://www.linkedin.com/feed/update/urn:li:share:7523360022953852928";
  const postCard = (over: Row = {}) =>
    card("lp1", {
      channel_slug: "linkedin_organic",
      run_id: "run-li",
      action_type: "text_post",
      title: "Review and edit your post on first paid ads tests",
      body: { step: { title: "Review and edit your post on first paid ads tests", body: "b", deliverable: { kind: "post", content: TEXT } } },
      status: "acted",
      status_at: "2026-10-18T03:00:02Z",
      card_kind: "post",
      primary_label: "Post on LinkedIn",
      done_label: "Posted",
      exec_class: null,
      exec_payload: null,
      exec_status: null,
      exec_result: null,
      executed_at: null,
      ...over,
    });
  const decision = { tenant_id: "t1", id: "d-li", agent_run_id: null, decision_class: "social.publish.v2", status: "acted", home_channel: "linkedin_organic", body: { channel: "linkedin", payload: { text: TEXT }, origin: "user_initiated_composer" } };
  const published = (over: Row = {}) => ({ tenant_id: "t1", id: "sp1", decision_id: "d-li", agent_run_id: null, channel: "linkedin", transport: "native", status: "published", external_url: URL_LIVE, created_at: "2026-10-18T03:00:01Z", updated_at: "2026-10-18T03:00:40Z", ...over });
  const ids = async () => (await listCompletedChannelActions("t1", "linkedin_organic", NOW)).map((d) => d.id);

  it("lists the card under done with the live post's link when the post was filed with no run id (the composer path)", async () => {
    rows.channel_actions = [postCard()];
    rows.decisions = [decision];
    rows.social_posts = [published()];
    const done = await listCompletedChannelActions("t1", "linkedin_organic", NOW);
    expect(done.map((d) => d.id)).toEqual(["lp1"]);
    expect(done[0]).toMatchObject({
      exec_status: "executed",
      executed_at: "2026-10-18T03:00:40Z",
      exec_receipt: { line: "Posted on LinkedIn.", url: URL_LIVE },
      outcome: null,
    });
    const page = await listChannelActions("t1", "linkedin_organic", { all: true, nowMs: NOW, withCompleted: true });
    expect(page.completed?.map((a) => a.id)).toEqual(["lp1"]);
  });

  it("still pairs a staged proposal's post by its run", async () => {
    rows.channel_actions = [postCard({ status_at: "2026-10-18T05:00:00Z" })];
    rows.decisions = [{ ...decision, agent_run_id: "run-li" }];
    rows.social_posts = [published({ agent_run_id: "run-li", created_at: "2026-10-17T09:00:00Z" })];
    expect(await ids()).toEqual(["lp1"]);
    rows.social_posts = [published({ agent_run_id: "run-other", created_at: "2026-10-18T05:00:00Z" })];
    expect(await ids()).toEqual([]);
  });

  it("keeps the done line with no link when the publish returned no URL, and never links off the platform", async () => {
    rows.channel_actions = [postCard()];
    rows.decisions = [decision];
    rows.social_posts = [published({ external_url: null })];
    expect((await listCompletedChannelActions("t1", "linkedin_organic", NOW))[0].exec_receipt).toEqual({ line: "Posted on LinkedIn." });
    rows.social_posts = [published({ external_url: "https://evil.example/feed/update/x" })];
    expect((await listCompletedChannelActions("t1", "linkedin_organic", NOW))[0].exec_receipt).toEqual({ line: "Posted on LinkedIn." });
  });

  it("leaves out a card marked done by hand, a failed post, the same words posted long before or after, different words and another platform", async () => {
    rows.decisions = [decision, { ...decision, id: "d-other", body: { channel: "linkedin", payload: { text: "Something else entirely." } } }];
    rows.channel_actions = [postCard()];
    rows.social_posts = [];
    expect(await ids()).toEqual([]);
    rows.social_posts = [published({ status: "failed" })];
    expect(await ids()).toEqual([]);
    rows.social_posts = [published({ created_at: "2026-10-18T02:40:00Z" })];
    expect(await ids()).toEqual([]);
    rows.social_posts = [published({ created_at: "2026-10-18T03:20:00Z" })];
    expect(await ids()).toEqual([]);
    rows.social_posts = [published({ decision_id: "d-other" })];
    expect(await ids()).toEqual([]);
    rows.social_posts = [published({ channel: "x" })];
    expect(await ids()).toEqual([]);
  });

  it("links the post nearest the card's close when the same words went out twice", async () => {
    rows.channel_actions = [postCard()];
    rows.decisions = [decision, { ...decision, id: "d-li-2" }];
    rows.social_posts = [
      published({ id: "sp-far", decision_id: "d-li-2", created_at: "2026-10-18T02:50:00Z", external_url: "https://www.linkedin.com/feed/update/urn:li:share:1" }),
      published(),
    ];
    expect((await listCompletedChannelActions("t1", "linkedin_organic", NOW))[0].exec_receipt?.url).toBe(URL_LIVE);
  });

  it("matches the founder's edit, not the pre-edit words, and drops a post older than seven days", async () => {
    const edited = "Edited before posting: our first paid ads test is live.";
    rows.channel_actions = [postCard({ edited_body: { step: { deliverable: { content: edited } } } })];
    rows.decisions = [decision];
    rows.social_posts = [published()];
    expect(await ids()).toEqual([]);
    rows.decisions = [{ ...decision, body: { channel: "linkedin", payload: { text: edited } } }];
    expect(await ids()).toEqual(["lp1"]);
    rows.channel_actions = [postCard({ edited_body: { step: { deliverable: { content: edited } } }, status_at: new Date(NOW - 8 * DAY).toISOString() })];
    rows.social_posts = [published({ created_at: new Date(NOW - 8 * DAY).toISOString(), updated_at: new Date(NOW - 8 * DAY).toISOString() })];
    expect(await ids()).toEqual([]);
  });

  it("throws when the post read fails, so the page keeps the done cards it showed", async () => {
    rows.channel_actions = [postCard()];
    rows.decisions = [decision];
    failing.add("social_posts");
    await expect(listCompletedChannelActions("t1", "linkedin_organic", NOW)).rejects.toThrow(/posted cards posts read failed/);
  });
});
