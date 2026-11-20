import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables = vi.hoisted(() => ({ decisions: [] as Row[], agent_runs: [] as Row[], channel_actions: [] as Row[] }));

function val(row: Row, path: string): unknown {
  const m = /^(\w+)((?:->>?\w+)*)$/.exec(path);
  if (!m) return row[path];
  let v: unknown = row[m[1]];
  for (const step of m[2].match(/->>?\w+/g) ?? []) {
    const text = step.startsWith("->>");
    const key = step.replace(/^->>?/, "");
    v = v && typeof v === "object" ? (v as Row)[key] : undefined;
    if (text && v != null && typeof v !== "string") v = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return v ?? null;
}
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: keyof typeof tables) => {
      const filters: Array<(r: Row) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let range: [number, number] | null = null;
      let lim = Infinity;
      let patch: Row | null = null;
      let cols: string | null = null;
      const q: Record<string, unknown> = {};
      q.select = (c?: string) => { cols = c ?? null; return q; };
      q.eq = (c: string, v: unknown) => { filters.push((r) => val(r, c) === v); return q; };
      q.in = (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(val(r, c))); return q; };
      q.is = (c: string, v: null) => { filters.push((r) => val(r, c) === v); return q; };
      q.not = (c: string, _op: string, v: null) => { filters.push((r) => val(r, c) !== v); return q; };
      q.lte = (c: string, v: string) => { filters.push((r) => String(val(r, c) ?? "") <= v); return q; };
      q.gte = (c: string, v: string) => { filters.push((r) => String(val(r, c) ?? "") >= v); return q; };
      q.order = (c: string, o?: { ascending?: boolean }) => { order = { col: c, asc: o?.ascending !== false }; return q; };
      q.range = (a: number, b: number) => { range = [a, b]; return q; };
      q.limit = (n: number) => { lim = n; return q; };
      q.update = (p: Row) => { patch = p; return q; };
      const run = () => {
        let rows = tables[table].filter((r) => filters.every((f) => f(r)));
        if (patch) {
          for (const r of rows) Object.assign(r, structuredClone(patch));
          return { data: cols ? rows.map((r) => ({ id: r.id })) : null, error: null };
        }
        if (order) { const { col, asc } = order; rows = [...rows].sort((a, b) => String(val(a, col) ?? "").localeCompare(String(val(b, col) ?? "")) * (asc ? 1 : -1)); }
        if (range) rows = rows.slice(range[0], range[1] + 1);
        rows = rows.slice(0, lim);
        const data = rows.map((r) => {
          if (!cols || cols === "*") return structuredClone(r);
          return Object.fromEntries(cols.split(",").map((c) => c.trim()).map((c) => { const i = c.indexOf(":"); return i > 0 ? [c.slice(0, i), val(r, c.slice(i + 1))] : [c, structuredClone(r[c])]; }));
        });
        return { data, error: null };
      };
      q.maybeSingle = async () => { const r = run(); return { data: (r.data as Row[])[0] ?? null, error: null }; };
      q.then = (res: (x: unknown) => unknown) => Promise.resolve(run()).then(res);
      return q;
    },
  }),
}));

import { activationTarget, applyReadouts, clampTest, createdOf, dueTestsFrom, honestReadout, launchStateOf, markFindingsDelivered, parseMoveTest, readDueTests, readUndeliveredFindings, receiptKind, summarizeTests, type DueTest } from "../cgo-tests";

const T = "t1";
const CLASS = "cgo.dispatch-specialist";
const TEST = { variable: "the video's first 3 seconds", budget_usd: 50, baseline: "$52 per booking", success_if: "under $40 per booking", stop_if: "over $80 after 5 days", readout_on: "2026-10-14" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const card = (n: number, status: string, body: Row = {}) => ({ id: id(n), tenant_id: T, decision_class: CLASS, status, emitted_at: "2026-10-07T00:00:00Z", body: { dispatched_by: "cgo", target_agent_slug: "meta_ads", intent: "test a new hook", goal_id: "g1", hypothesis_id: "h1", test: TEST, ...body } });
const act = (runId: string, status: string, exec_class: string | null, exec_status: string | null, at = "2026-10-08T12:00:00Z") => ({ tenant_id: T, run_id: runId, status, exec_class, exec_status, status_at: at });

beforeEach(() => { tables.decisions = []; tables.agent_runs = []; tables.channel_actions = []; });

describe("the test on a move", () => {
  it("parses; a malformed test is dropped, never the move", () => {
    expect(parseMoveTest(TEST)).toEqual(TEST);
    expect(parseMoveTest({ ...TEST, variable: "" })).toBeUndefined();
    expect(parseMoveTest({ ...TEST, readout_on: "next week" })).toBeUndefined();
  });
  it("readout held to 2..30 days; the model's budget is kept as written, never cut to the order's daily claim", () => {
    expect(clampTest({ ...TEST, readout_on: "2026-10-07" }, "2026-10-07").readout_on).toBe("2026-10-09");
    expect(clampTest({ ...TEST, readout_on: "2027-01-01" }, "2026-10-07").readout_on).toBe("2026-11-06");
    expect(clampTest({ ...TEST, budget_usd: 500 }, "2026-10-07")).toMatchObject({ envelope: "server", budget_usd: 500, readout_on: "2026-10-14" });
  });
});

describe("launched means a receipt, not a successful model run", () => {
  it("REVIEW: a successful run whose cgo_reply is rejected is blocked, not launched", () => {
    const s = launchStateOf("meta_ads", [{ id: "r", status: "success", source_decision_id: "d", cgo_reply: { status: "rejected", reason: "goes against my open card" } }], []);
    expect(s.state).toBe("blocked");
    expect(s.why).toContain("rejected");
  });
  it("REVIEW: a running run is in progress, never 'run failed'", () => {
    expect(launchStateOf("meta_ads", [{ id: "r", status: "running", source_decision_id: "d" }], []).state).toBe("in_progress");
  });
  it("a card waiting on approval or execution is in progress; an executed one is launched at its time", () => {
    const runs = [{ id: "r", status: "success", source_decision_id: "d" }];
    expect(launchStateOf("meta_ads", runs, [act("r", "pending", "meta_ads.create_ad", null)]).state).toBe("in_progress");
    expect(launchStateOf("meta_ads", runs, [act("r", "acted", "meta_ads.create_ad", "executed", "2026-10-09T03:00:00Z")])).toMatchObject({ state: "launched", launched_at: "2026-10-09T03:00:00Z" });
  });
  it("a pause a person made past the cut guard is the founder's call, never a result or a wait", () => {
    const runs = [{ id: "r", status: "success", source_decision_id: "d" }];
    const P = "meta_ads.pause_past_cut_guard";
    expect(launchStateOf("meta_ads", runs, [act("r", "pending", P, null)]).state).toBe("blocked");
    const done = launchStateOf("meta_ads", runs, [act("r", "acted", P, "executed", "2026-10-09T03:00:00Z")]);
    expect(done).toMatchObject({ state: "blocked", launched_at: null });
    expect(done.why).toContain("founder paused it past Zavi's hold");
    expect(launchStateOf("meta_ads", runs, [act("r", "acted", P, "executed", "2026-10-09T03:00:00Z"), act("r", "acted", "meta_ads.create_ad", "executed", "2026-10-09T04:00:00Z")])).toMatchObject({ state: "launched", launched_at: "2026-10-09T04:00:00Z" });
  });
  it("cards that all closed without running, or a channel run that filed nothing, are blocked", () => {
    const runs = [{ id: "r", status: "success", source_decision_id: "d" }];
    expect(launchStateOf("meta_ads", runs, [act("r", "pending", "meta_ads.create_ad", "failed"), act("r", "stale", null, null)]).state).toBe("blocked");
    expect(launchStateOf("meta_ads", runs, []).state).toBe("blocked");
    expect(launchStateOf("research", runs, []).state).toBe("launched");
  });
  it("a person's step counts once the founder did it", () => {
    expect(launchStateOf("email_marketing", [{ id: "r", status: "success", source_decision_id: "d" }], [act("r", "acted", null, null)]).state).toBe("launched");
  });
});

describe("REVIEW (recheck): the receipt must be the TESTED thing going live", () => {
  const runs = [{ id: "r", status: "success", source_decision_id: "d" }];
  const done = (exec_class: string, payload: Record<string, unknown> = {}, notice = "", at = "2026-10-08T12:00:00Z") =>
    ({ run_id: "r", status: "acted", exec_class, exec_status: "executed", status_at: at, exec_payload: payload, exec_result: notice ? { notice } : {} });
  const failed = (exec_class: string) => ({ run_id: "r", status: "pending", exec_class, exec_status: "failed", status_at: null });

  it("pausing an old ad succeeded but creating the experimental ad failed: NOT launched", () => {
    const s = launchStateOf("meta_ads", runs, [done("meta_ads.set_status", { object_id: "old", status: "PAUSED" }), failed("meta_ads.create_ad")]);
    expect(s.state).not.toBe("launched");
    expect(s.state).toBe("blocked");
  });
  it("a Google campaign created PAUSED awaiting activation: NOT launched, still in progress", () => {
    const create = done("google_ads.create_campaign", {}, 'Created Google Ads SEARCH campaign "Test" (`24311682859`) with ad group `200179640106` — PAUSED, $5/day.');
    expect(launchStateOf("google_ads", runs, [create])).toMatchObject({ state: "in_progress", why: expect.stringContaining("paused") });
  });
  it("...and launched once an executed ENABLED change on THAT campaign (exact identity) switches it on, at its time", () => {
    const create = { ...done("google_ads.create_campaign"), exec_result: { notice: "PAUSED", created: { platform: "google", object_type: "campaign", id: "24311682859", status: "PAUSED" } } };
    const otherOn = { exec_class: "google_ads.set_status", exec_payload: { level: "campaign", campaign_id: "999", status: "ENABLED" }, status_at: "2026-10-09T00:00:00Z" };
    expect(launchStateOf("google_ads", runs, [create], [otherOn]).state).toBe("in_progress");
    const on = { exec_class: "google_ads.set_status", exec_payload: { level: "campaign", campaign_id: "24311682859", status: "ENABLED" }, status_at: "2026-10-10T08:00:00Z" };
    expect(launchStateOf("google_ads", runs, [create], [otherOn, on])).toMatchObject({ state: "launched", launched_at: "2026-10-10T08:00:00Z" });
  });
  it("receipt kinds come from the handlers: launch copies/new ads live, creates prepared, pauses never", () => {
    expect(receiptKind({ exec_class: "meta_ads.duplicate_ad_set" })).toBe("live");
    expect(receiptKind({ exec_class: "meta_ads.create_ad" })).toBe("live");
    expect(receiptKind({ exec_class: "meta_ads.create_ad_set" })).toBe("prepared");
    expect(receiptKind({ exec_class: "google_ads.create_campaign" })).toBe("prepared");
    expect(receiptKind({ exec_class: "chatgpt_ads.create_campaign_bundle" })).toBe("prepared");
    expect(receiptKind({ exec_class: "chatgpt_ads.create_and_launch" })).toBe("live");
    expect(receiptKind({ exec_class: "chatgpt_ads.set_status", exec_payload: { status: "PAUSED" } })).toBe("reduction");
    expect(receiptKind({ exec_class: "tiktok_ads.update_budget" })).toBe("change");
    expect(receiptKind({ exec_class: "tiktok_ads.set_status", exec_payload: { status: "ACTIVE" } })).toBe("live");
    expect(receiptKind({ exec_class: "tiktok_ads.set_status", exec_payload: { status: "PAUSED" } })).toBe("reduction");
    expect(receiptKind({ exec_class: "meta_ads.set_status_review", exec_payload: { status: "ACTIVE" } })).toBe("live");
    expect(receiptKind({ exec_class: "google_ads.set_status", exec_payload: { status: "PAUSED" } })).toBe("reduction");
    expect(receiptKind({ exec_class: "google_ads.remove_resource" })).toBe("reduction");
    expect(receiptKind({ exec_class: "meta_ads.update_ad_set_budget" })).toBe("change");
    expect(receiptKind({ exec_class: "tiktok_ads.something_new" })).toBe("none");
  });
  it("activation targets carry platform + object type + id from each platform's status payload", () => {
    expect(activationTarget({ exec_class: "meta_ads.set_status", exec_payload: { level: "adset", object_id: "2", status: "ACTIVE" } })).toEqual({ platform: "meta", object_type: "ad_set", id: "2" });
    expect(activationTarget({ exec_class: "meta_ads.set_status_review", exec_payload: { level: "campaign", object_id: "1", status: "ACTIVE" } })).toEqual({ platform: "meta", object_type: "campaign", id: "1" });
    expect(activationTarget({ exec_class: "google_ads.set_status", exec_payload: { level: "ad_group", campaign_id: "1", ad_group_id: "7", status: "ENABLED" } })).toEqual({ platform: "google", object_type: "ad_group", id: "7" });
    expect(createdOf({ exec_result: { notice: "x" } })).toBeNull();
  });
});

describe("RECHECK 5665940: exact created-object identity and inline activation", () => {
  const runs = [{ id: "r", status: "success", source_decision_id: "d" }];
  const metaAdSet = {
    run_id: "r", status: "acted", exec_class: "meta_ads.create_ad_set", exec_status: "executed", status_at: "2026-10-08T12:00:00Z",
    exec_payload: { campaign_id: "111111111111111", name: "Test ad set" },
    exec_result: { notice: "Created ad set — PAUSED", created: { platform: "meta", object_type: "ad_set", id: "222222222222222", status: "PAUSED" } },
  };
  it("activating the PARENT campaign does not launch the new paused ad set", () => {
    const parentOn = { exec_class: "meta_ads.set_status", exec_payload: { level: "campaign", object_id: "111111111111111", status: "ACTIVE" }, status_at: "2026-10-09T00:00:00Z" };
    expect(launchStateOf("meta_ads", runs, [metaAdSet], [parentOn]).state).toBe("in_progress");
  });
  it("activating the NEW ad set itself launches it, at that time", () => {
    const on = { exec_class: "meta_ads.set_status", exec_payload: { level: "adset", object_id: "222222222222222", status: "ACTIVE" }, status_at: "2026-10-09T00:00:00Z" };
    expect(launchStateOf("meta_ads", runs, [metaAdSet], [on])).toMatchObject({ state: "launched", launched_at: "2026-10-09T00:00:00Z" });
  });
  it("same id, wrong type or platform does not count", () => {
    const wrongType = { exec_class: "meta_ads.set_status", exec_payload: { level: "campaign", object_id: "222222222222222", status: "ACTIVE" }, status_at: "2026-10-09T00:00:00Z" };
    const wrongPlatform = { exec_class: "google_ads.set_status", exec_payload: { level: "campaign", campaign_id: "222222222222222", status: "ENABLED" }, status_at: "2026-10-09T00:00:00Z" };
    expect(launchStateOf("meta_ads", runs, [metaAdSet], [wrongType, wrongPlatform]).state).toBe("in_progress");
  });
  it("a Google create switched on and READ BACK in the same step launches at that time, with no second action", () => {
    const g = { ...metaAdSet, exec_class: "google_ads.create_campaign", exec_result: { notice: "Autopilot switched it on.", created: { platform: "google", object_type: "campaign", id: "24311682859", status: "ENABLED", activated_at: "2026-10-08T12:00:05Z" } } };
    expect(launchStateOf("google_ads", runs, [g], [])).toMatchObject({ state: "launched", launched_at: "2026-10-08T12:00:05Z" });
  });
  it("an inline enable Google did NOT confirm (UNVERIFIED) never starts the clock, and is not waited on forever", () => {
    const g = { ...metaAdSet, exec_class: "google_ads.create_campaign", exec_result: { notice: "Google reports an unreadable status", created: { platform: "google", object_type: "campaign", id: "24311682859", status: "UNVERIFIED" } } };
    expect(launchStateOf("google_ads", runs, [g], []).state).toBe("blocked");
    const on = { exec_class: "google_ads.set_status", exec_payload: { level: "campaign", campaign_id: "24311682859", status: "ENABLED" }, status_at: "2026-10-09T00:00:00Z" };
    expect(launchStateOf("google_ads", runs, [g], [on])).toMatchObject({ state: "launched", launched_at: "2026-10-09T00:00:00Z" });
  });
  it("a new Meta ad that reads back held by a paused parent did not launch the test", () => {
    const ad = (status: string) => ({ ...metaAdSet, exec_class: "meta_ads.create_ad", exec_result: { notice: "Created ad", created: { platform: "meta", object_type: "ad", id: "333", status } } });
    expect(launchStateOf("meta_ads", runs, [ad("PAUSED")], []).state).toBe("blocked");
    expect(launchStateOf("meta_ads", runs, [ad("ACTIVE")], [])).toMatchObject({ state: "launched", launched_at: "2026-10-08T12:00:00Z" });
  });
  it("a legacy create with no structured record is never linked by guessing: it keeps waiting", () => {
    const legacy = { ...metaAdSet, exec_result: { notice: "Created ad set — PAUSED" } };
    const on = { exec_class: "meta_ads.set_status", exec_payload: { level: "adset", object_id: "222222222222222", status: "ACTIVE" }, status_at: "2026-10-09T00:00:00Z" };
    expect(launchStateOf("meta_ads", runs, [legacy], [on]).state).toBe("in_progress");
  });
});

describe("which tests are due", () => {
  it("a launched test is due one window after launch, not after the proposal", () => {
    const c = card(1, "acted");
    const runs = [{ id: "r1", status: "success", source_decision_id: id(1) }];
    const acts = [act("r1", "acted", "meta_ads.create_ad", "executed", "2026-10-10T00:00:00Z")];
    expect(dueTestsFrom([c], runs, acts, "2026-10-14")).toEqual([]);
    expect(dueTestsFrom([c], runs, acts, "2026-10-17")[0]).toMatchObject({ state: "launched", launched_on: "2026-10-10" });
  });
  it("in-progress work is not due (never finalized early); blocked and never-ran are due on the readout date", () => {
    const runs = [{ id: "r1", status: "running", source_decision_id: id(1) }];
    expect(dueTestsFrom([card(1, "acted")], runs, [], "2026-10-20")).toEqual([]);
    expect(dueTestsFrom([card(2, "acted")], [], [], "2026-10-14")[0]).toMatchObject({ state: "never_ran" });
  });

  it("a card whose dispatch failed is read out (never ran), not left unread", async () => {
    tables.decisions.push(card(12, "dispatch_failed", { test: { ...TEST, readout_on: "2026-10-05" } }));
    const r = await readDueTests(T, CLASS, new Date("2026-10-14T12:00:00Z"));
    expect(r.due).toEqual([expect.objectContaining({ decision_id: id(12), state: "never_ran" })]);
  });
  it("REVIEW: ten rejected test cards ahead of a valid overdue one do not hide it (status filtered in the database)", async () => {
    for (let n = 1; n <= 10; n++) tables.decisions.push(card(n, "rejected", { test: { ...TEST, readout_on: "2026-10-01" } }));
    tables.decisions.push(card(11, "acted", { test: { ...TEST, readout_on: "2026-10-05" } }));
    const r = await readDueTests(T, CLASS, new Date("2026-10-14T12:00:00Z"));
    expect(r.due.map((d) => d.decision_id)).toEqual([id(11)]);
  });
  it("more than one page of due tests: all found up to the cap, the rest counted", async () => {
    for (let n = 1; n <= 63; n++) tables.decisions.push(card(n, "acted", { test: { ...TEST, readout_on: `2026-10-0${(n % 5) + 1}` } }));
    const r = await readDueTests(T, CLASS, new Date("2026-10-14T12:00:00Z"));
    expect(r.due).toHaveLength(10);
    expect(r.more).toBe(53);
  });
});

describe("saving a readout honestly", () => {
  const due = (state: DueTest["state"], n = 1): DueTest => ({ decision_id: id(n), goal_id: "g1", hypothesis_id: "h1", agent: "meta_ads", intent: "x", test: TEST, state, why: state === "launched" ? "the change executed" : "the specialist rejected it: no", launched_on: state === "launched" ? "2026-10-08" : null });

  it("not launched -> not_measured whatever the model wrote; a verdict with no number -> not_measured", () => {
    expect(honestReadout(due("blocked"), { decision_id: id(1), verdict: "worked", result: "looks great" }).verdict).toBe("not_measured");
    expect(honestReadout(due("launched"), { decision_id: id(1), verdict: "worked", result: "it felt better" }).verdict).toBe("not_measured");
    expect(honestReadout(due("launched"), { decision_id: id(1), verdict: "worked", result: "$36 per booking over 7 days" }).verdict).toBe("worked");
  });
  it("saves once, with an undelivered finding; a concurrent second save does not overwrite", async () => {
    tables.decisions.push(card(1, "acted"));
    const args = { tenant_id: T, run_id: "run9", due: [due("launched")], cardClass: CLASS, now: new Date("2026-10-15T10:00:00Z") };
    const [a, b] = await Promise.all([
      applyReadouts({ ...args, readouts: [{ decision_id: id(1), verdict: "worked", result: "$36 per booking" }] }),
      applyReadouts({ ...args, readouts: [{ decision_id: id(1), verdict: "did_not_work", result: "$60 per booking" }] }),
    ]);
    expect(a.saved + b.saved).toBe(1);
    const tr = (tables.decisions[0].body as Row).test_readout as Row;
    expect(tr.delivered).toBe(false);
    expect(String(tr.finding)).toContain(tr.verdict === "worked" ? "WORKED" : "DID NOT WORK");
  });
  it("REVIEW: readout saved but the tracker did not store it -> re-sent until marked delivered", async () => {
    tables.decisions.push(card(1, "acted"));
    await applyReadouts({ tenant_id: T, run_id: "r", readouts: [{ decision_id: id(1), verdict: "worked", result: "$36" }], due: [due("launched")], cardClass: CLASS, now: new Date() });
    expect((await readUndeliveredFindings(T, CLASS)).map((f) => f.decision_id)).toEqual([id(1)]);
    await markFindingsDelivered(T, CLASS, [id(1)]);
    expect(await readUndeliveredFindings(T, CLASS)).toEqual([]);
    expect(((tables.decisions[0].body as Row).test_readout as Row).verdict).toBe("worked");
  });
  it("a readout for a card that is not due, or a malformed item, is dropped", async () => {
    tables.decisions.push(card(1, "acted"));
    const r = await applyReadouts({ tenant_id: T, run_id: "r", readouts: [{ decision_id: id(2), verdict: "worked", result: "1" }, { nonsense: true }, "x"], due: [due("launched")], cardClass: CLASS, now: new Date() });
    expect(r).toEqual({ saved: 0, findings: [] });
  });
});

describe("the Growth page's tests, last 30 days (Growth J6)", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const ev = (runs: Array<{ id: string; status: string; source_decision_id: string }> = [], actions: ReturnType<typeof act>[] = []) => ({ runs, actions, activations: [] });

  it("counts read verdicts, a test that never went live, and a running test with its read date", () => {
    const won = card(1, "acted", { test_readout: { verdict: "worked", read_at: "2026-10-15T00:00:00Z", launched_on: "2026-10-08" } });
    const lost = card(2, "acted", { test_readout: { verdict: "did_not_work", read_at: "2026-10-16T00:00:00Z", launched_on: "2026-10-08" } });
    const never = card(3, "dispatch_failed", { test: { ...TEST, readout_on: "2026-10-14" } });
    const running = { ...card(4, "acted", { test: { ...TEST, readout_on: "2026-10-25" } }), emitted_at: "2026-10-18T00:00:00Z" };
    const out = summarizeTests(
      [won, lost, never, running],
      ev([{ id: "r4", status: "success", source_decision_id: id(4) }], [act("r4", "acted", "meta_ads.create_ad", "executed", "2026-10-18T06:00:00Z")]),
      now,
      30,
    );
    expect(out).toMatchObject({ won: 1, lost: 1, never_launched: 1, running: 1, next_read_on: "2026-10-25" });
    expect(out.items.find((i) => i.decision_id === id(3))).toMatchObject({ verdict: null, launch: "never_ran", channel_slug: "meta_ads", title: "test a new hook" });
    expect(out.items.find((i) => i.decision_id === id(1))).toMatchObject({ verdict: "worked", launch: "launched", read_on: "2026-10-15" });
  });

  it("leaves out tests outside the window, unapproved moves, and moves with no test", () => {
    const old = { ...card(5, "acted", { test_readout: { verdict: "worked", read_at: "2026-08-01T00:00:00Z" } }), emitted_at: "2026-07-20T00:00:00Z" };
    const proposed = card(6, "proposed");
    const noTest = card(7, "acted", { test: undefined });
    expect(summarizeTests([old, proposed, noTest], ev(), now, 30).items).toEqual([]);
  });

  it("an approved test whose run has not started yet is running until its read date, not 'never launched'", () => {
    const fresh = { ...card(8, "approved", { test: { ...TEST, readout_on: "2026-10-27" } }), emitted_at: "2026-10-20T00:00:00Z" };
    expect(summarizeTests([fresh], ev(), now, 30)).toMatchObject({ running: 1, never_launched: 0 });
  });
});

