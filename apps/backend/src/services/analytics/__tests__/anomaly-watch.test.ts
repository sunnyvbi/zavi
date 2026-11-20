
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import {
  planIncidents,
  minorMoves,
  findSignals,
  watchTenant,
  watchWindow,
  watchDirection,
  isZeroCollapse,
  contributorsFor,
  ALERT_SEVERITY,
  WATCHED_METRICS,
  FAMILY_OF,
  type ActiveIncident,
  type Signal,
  type Observation,
  type WatchDeps,
  type NewIncident,
  type IncidentPatch,
  type Family,
} from "../anomaly-watch";
import { METRIC_CATALOG, type CatalogMetricMeta } from "../metric-registry";
import { METRIC_IMPLS, type FetchResult } from "../metric-catalog";
import { addDays } from "../metric-time";
import type { IncidentAlert } from "../anomaly-alert";
import type { MetricAnomalyWake } from "../anomaly";

const TODAY = "2026-09-28";
const NOW = new Date(`${TODAY}T05:41:00Z`);
const TZ = "UTC";

function sig(key: string, severity: number, over: Partial<Signal> = {}): Signal {
  const meta = METRIC_CATALOG[key];
  return {
    key,
    family: (FAMILY_OF as Record<string, Family>)[key] ?? "tracking",
    kind: "anomaly",
    metric_id: key,
    label: meta?.label ?? key,
    unit: meta?.unit ?? "count",
    currency: null,
    date: "2026-09-27",
    direction: "down",
    bad: true,
    severity,
    z: -severity,
    weekday_z: -severity,
    value: 40,
    typical: 100,
    ...over,
  };
}

const obs = (signals: Signal[], observed: Family[] = ["acquisition", "conversion", "revenue", "ads_meta", "ads_google", "tracking"]): Observation => ({
  signals,
  observed: new Set(observed),
});

function active(family: Family, over: Partial<ActiveIncident> = {}): ActiveIncident {
  return {
    id: `inc-${family}`,
    family,
    status: "open",
    primary_key: "sessions",
    severity: 4,
    notice_severity: 4,
    notices: 1,
    normal_streak: 0,
    last_eval_on: "2026-09-27",
    pending_notice: false,
    signals: [sig("sessions", 4)],
    ...over,
  };
}

describe("planIncidents: bundling and the bar", () => {
  it("four bad metrics on one day bundle into incidents by family, one primary each", () => {
    const plan = planIncidents(
      [],
      obs([sig("sessions", 5), sig("search_clicks", 3.5), sig("key_events", 4), sig("net_revenue", 3.2)]),
      TODAY,
    );
    expect(plan.map((a) => `${a.kind}:${a.family}`).sort()).toEqual(["open:acquisition", "open:conversion", "open:revenue"]);
    const acq = plan.find((a) => a.family === "acquisition") as Extract<(typeof plan)[number], { kind: "open" }>;
    expect(acq.primary.key).toBe("sessions");
    expect(acq.supporting.map((s) => s.key)).toEqual(["search_clicks"]);
  });

  it(`the bar is min(|z|, |weekday_z|) >= ${ALERT_SEVERITY}; below it and good moves go to What moved only`, () => {
    const below = sig("sessions", 2.9);
    const good = sig("signups", 6, { bad: false, direction: "up" });
    expect(planIncidents([], obs([below, good]), TODAY)).toEqual([]);
    expect(minorMoves([below, good, sig("net_revenue", 4)]).map((s) => s.key)).toEqual(["sessions", "signups"]);
  });

  it("a bad move below the bar in the same family rides along as supporting", () => {
    const plan = planIncidents([], obs([sig("key_events", 4), sig("conversion_rate", 2.4)]), TODAY);
    expect(plan).toHaveLength(1);
    expect((plan[0] as { supporting: Signal[] }).supporting.map((s) => s.key)).toEqual(["conversion_rate"]);
  });

  it("tracking symptoms open their own incident", () => {
    const rf = sig("read_failed:google_analytics", 3, { family: "tracking", kind: "read_failed", metric_id: null });
    const plan = planIncidents([], obs([rf]), TODAY);
    expect(plan).toEqual([expect.objectContaining({ kind: "open", family: "tracking" })]);
  });
});

describe("planIncidents: open, worsen, never repeat, recover", () => {
  it("worsens only when the primary is at least 1 sd worse than the severity last told", () => {
    expect(planIncidents([active("acquisition")], obs([sig("sessions", 5)]), TODAY)[0].kind).toBe("worsen");
    expect(planIncidents([active("acquisition")], obs([sig("sessions", 4.9)]), TODAY)[0].kind).toBe("update");
    expect(planIncidents([active("acquisition")], obs([sig("sessions", 4)]), TODAY)[0].kind).toBe("update");
  });

  it("recovers after 2 settled normal days in a row", () => {
    const day1 = planIncidents([active("acquisition")], obs([]), TODAY);
    expect(day1).toEqual([{ kind: "normal", id: "inc-acquisition", family: "acquisition", normal_streak: 1, recover: false }]);
    const day2 = planIncidents([active("acquisition", { normal_streak: 1 })], obs([]), TODAY);
    expect(day2).toEqual([{ kind: "normal", id: "inc-acquisition", family: "acquisition", normal_streak: 2, recover: true }]);
  });

  it("a sibling metric reading fine does not recover an incident whose own primary was not measured", () => {
    const inc = active("acquisition", { primary_key: "search_clicks", normal_streak: 1 });
    const siblingOnly = { ...obs([]), observedKeys: new Set(["sessions", "read_failed:google_analytics"]) };
    expect(planIncidents([inc], siblingOnly, TODAY)[0].kind).toBe("hold");
    const own = { ...obs([]), observedKeys: new Set(["search_clicks"]) };
    expect(planIncidents([inc], own, TODAY)[0]).toMatchObject({ kind: "normal", recover: true });
  });

  it("a day not measured, or still off below the bar, is not a normal day", () => {
    expect(planIncidents([active("acquisition", { normal_streak: 1 })], obs([], ["revenue"]), TODAY)[0].kind).toBe("hold");
    expect(planIncidents([active("acquisition", { normal_streak: 1 })], obs([sig("sessions", 2.2)]), TODAY)[0].kind).toBe("hold");
  });

  it("a second run the same day does nothing, except deliver a notice left pending", () => {
    const same = active("acquisition", { last_eval_on: TODAY });
    expect(planIncidents([same], obs([sig("sessions", 9)]), TODAY)).toEqual([]);
    expect(planIncidents([{ ...same, pending_notice: true }], obs([sig("sessions", 9)]), TODAY)).toEqual([
      { kind: "retry_notice", id: "inc-acquisition", family: "acquisition" },
    ]);
  });
});

type Row = Omit<ActiveIncident, "status"> & { status: "open" | "worsened" | "recovered"; last_notice_mode?: string; last_message_subject?: string; wake_status?: string; tenant_id: string };

function fakeDeps(signalsByDay: Record<string, Signal[]>, over: Partial<WatchDeps> & { modeOn?: boolean; muted?: string[] } = {}) {
  const rows: Row[] = [];
  const sent: IncidentAlert[] = [];
  const woke: Array<{ tenant_id: string; a: MetricAnomalyWake }> = [];
  const moves: Array<{ tenant_id: string; key: string }> = [];
  const tenantsSeen = new Set<string>();
  let n = 0;
  const see = (t: string) => tenantsSeen.add(t);
  const deps: WatchDeps = {
    resolveTz: async (t) => (see(t), TZ),
    fetch: async () => ({ ok: false, reason: "not_connected", message: "" }),
    explain: async (t) => (see(t), { status: "read_failed", metric_id: "x", message: "", caveats: [] }),
    loadActive: async (t) => (see(t), rows.filter((r) => r.tenant_id === t && r.status !== "recovered").map((r) => ({ ...r }) as ActiveIncident)),
    insertIncident: async (t, row: NewIncident) => {
      see(t);
      if (rows.some((r) => r.tenant_id === t && r.family === row.family && r.status !== "recovered")) return null;
      const r: Row = { ...row, tenant_id: t, id: `inc-${++n}`, notice_severity: null, notices: 0, normal_streak: 0 } as Row;
      rows.push(r);
      return { ...r } as ActiveIncident;
    },
    updateIncident: async (t, id, patch: IncidentPatch) => {
      see(t);
      const r = rows.find((x) => x.id === id && x.tenant_id === t);
      if (r) Object.assign(r, patch);
    },
    recordMoves: async (t, ms) => {
      see(t);
      for (const m of ms) moves.push({ tenant_id: t, key: m.key });
    },
    mode: async () => (over.modeOn ? "on" : "shadow"),
    mutedKeys: async (t) => (see(t), new Set(over.muted ?? [])),
    wake: async (t, a) => {
      see(t);
      woke.push({ tenant_id: t, a });
      return { enqueued: true, run_id: `run-${woke.length}` };
    },
    send: async (a) => {
      see(a.tenant_id);
      sent.push(a);
      return "slack";
    },
    companyName: async (t) => (see(t), "Acme"),
    workspaceUrl: (t) => `https://www.zaviagent.com/workspace?company=${t}`,
    muteUrl: (t, k) => `https://www.zaviagent.com/workspace?company=${t}&mute_alert=${k}`,
    ...over,
  };
  return { deps, rows, sent, woke, moves, tenantsSeen, signalsByDay };
}

async function runDay(f: ReturnType<typeof fakeDeps>, tenant: string, day: string, signals: Signal[], observed?: Family[]) {
  return watchTenant(tenant, new Set(["google_analytics"]), new Date(`${day}T05:41:00Z`), f.deps, async () => obs(signals, observed));
}

describe("watchTenant: shadow mode (the default)", () => {
  it("records incidents and the would-have-sent copy, sends nothing, wakes nothing", async () => {
    const f = fakeDeps({});
    const r = await runDay(f, "t-1", TODAY, [sig("sessions", 5), sig("search_clicks", 3.5), sig("key_events", 4), sig("signups", 6, { bad: false, direction: "up" })]);
    expect(r).toMatchObject({ opened: 2, notices: 2, sent: 0, woke: 0, moves: 1 });
    expect(f.sent).toEqual([]);
    expect(f.woke).toEqual([]);
    const acq = f.rows.find((x) => x.family === "acquisition")!;
    expect(acq).toMatchObject({ last_notice_mode: "shadow", pending_notice: false, notices: 1 });
    expect(acq.last_message_subject).toBe("Acme: Problem: Sessions fell to 40 on Sun, Sep 27");
  });
});

describe("watchTenant: on", () => {
  it("one message and one wake when a bad incident opens; nothing for an unchanged day; one message (no wake) when it worsens by 1 sd; recovered after 2 normal days", async () => {
    const f = fakeDeps({}, { modeOn: true });
    await runDay(f, "t-1", "2026-09-28", [sig("sessions", 4), sig("search_clicks", 3.4)]);
    expect(f.sent).toHaveLength(1);
    expect(f.woke).toHaveLength(1);
    expect(f.woke[0].a).toMatchObject({ incident_id: "inc-1", family: "acquisition", metric_id: "sessions" });
    expect(f.sent[0]).toMatchObject({ kind: "opened", notice_seq: 1, woke: true });
    expect(f.sent[0].supporting).toHaveLength(1);

    await runDay(f, "t-1", "2026-09-29", [sig("sessions", 4.5)]);
    expect(f.sent).toHaveLength(1);

    await runDay(f, "t-1", "2026-09-30", [sig("sessions", 5.1)]);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ kind: "worsened", notice_seq: 2, woke: false });
    expect(f.woke).toHaveLength(1);

    await runDay(f, "t-1", "2026-10-01", []);
    expect(f.rows[0].status).toBe("worsened");
    await runDay(f, "t-1", "2026-10-02", []);
    expect(f.rows[0].status).toBe("recovered");
    expect(f.sent).toHaveLength(2);
  });

  it("the message goes out even when the wake is refused (no goal, Autopilot off on Free)", async () => {
    const f = fakeDeps({}, { modeOn: true, wake: async () => ({ enqueued: false, skipped: "no_active_goals" }) });
    const r = await runDay(f, "t-1", TODAY, [sig("net_revenue", 7)]);
    expect(r).toMatchObject({ opened: 1, sent: 1, woke: 0 });
    expect(f.sent[0].woke).toBe(false);
    expect(f.rows[0].wake_status).toBe("skipped:no_active_goals");
  });

  it("always eligible without an explanation: revenue collapse, runaway ad spend, tracking breaking", async () => {
    const f = fakeDeps({}, { modeOn: true });
    const r = await runDay(f, "t-1", TODAY, [
      sig("new_customers", 5),
      sig("meta_ad_spend", 6, { direction: "up" }),
      sig("read_failed:stripe", 3, { family: "tracking", kind: "read_failed", metric_id: null, label: "Stripe", value: null, typical: null }),
    ]);
    expect(r).toMatchObject({ opened: 3, sent: 3 });
    expect(f.sent.every((s) => s.contributors.length === 0)).toBe(true);
  });

  it("a muted metric (or mute-all) sends nothing and wakes nothing, but is still recorded", async () => {
    const f = fakeDeps({}, { modeOn: true, muted: ["sessions"] });
    await runDay(f, "t-1", TODAY, [sig("sessions", 5), sig("key_events", 4)]);
    expect(f.sent.map((s) => s.primary.label)).toEqual(["Key events"]);
    expect(f.rows.find((x) => x.family === "acquisition")!.last_notice_mode).toBe("muted");
    const all = fakeDeps({}, { modeOn: true, muted: ["*"] });
    await runDay(all, "t-1", TODAY, [sig("sessions", 5), sig("key_events", 4)]);
    expect(all.sent).toEqual([]);
    expect(all.woke).toEqual([]);
  });

  it("a notice left pending by a crash is delivered by the retry, once", async () => {
    const f = fakeDeps({}, { modeOn: true });
    const failing = { ...f.deps, send: async () => { throw new Error("killed"); } };
    await runDay({ ...f, deps: failing }, "t-1", TODAY, [sig("sessions", 5)]);
    f.rows[0].pending_notice = true;
    f.rows[0].notices = 0;
    await runDay(f, "t-1", TODAY, [sig("sessions", 5)]);
    expect(f.sent).toHaveLength(1);
    await runDay(f, "t-1", TODAY, [sig("sessions", 5)]);
    expect(f.sent).toHaveLength(1);
  });

  it("a send that fails stays owed and goes out on the next sweep, once", async () => {
    let fail = true;
    const f = fakeDeps({}, { modeOn: true });
    const flaky = { ...f.deps, send: async (a: IncidentAlert) => { if (fail) throw new Error("sendgrid down"); f.sent.push(a); return "email" as const; } };
    await runDay({ ...f, deps: flaky }, "t-1", "2026-09-28", [sig("net_revenue", 6)]);
    expect(f.rows[0]).toMatchObject({ pending_notice: true, notices: 0 });
    fail = false;
    await runDay({ ...f, deps: flaky }, "t-1", "2026-09-29", [sig("net_revenue", 6)]);
    expect(f.sent).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ pending_notice: false, notices: 1 });
    await runDay({ ...f, deps: flaky }, "t-1", "2026-09-30", [sig("net_revenue", 6)]);
    expect(f.sent).toHaveLength(1);
  });

  it("no Slack and no owner address found is not delivered: the notice stays owed", async () => {
    const f = fakeDeps({}, { modeOn: true, send: async () => "none" });
    await runDay(f, "t-1", TODAY, [sig("net_revenue", 6)]);
    expect(f.rows[0]).toMatchObject({ pending_notice: true, notices: 0, last_channel: "none" });
  });

  it("every read and write carries the tenant the sweep passed", async () => {
    const f = fakeDeps({}, { modeOn: true });
    await runDay(f, "tenant-x", TODAY, [sig("sessions", 5), sig("signups", 3, { bad: false, direction: "up" })]);
    expect([...f.tenantsSeen]).toEqual(["tenant-x"]);
    expect(f.rows.every((r) => r.tenant_id === "tenant-x")).toBe(true);
  });
});

describe("findSignals", () => {
  const LA = "America/Los_Angeles";

  function seriesFetch(shape: (d: string, until: string) => Record<string, number>): (id: string, ctx: unknown, w: { since: string; until: string }) => Promise<FetchResult> {
    return async (_id, _ctx, w) => {
      const daily: Array<{ date: string; parts: Record<string, number> }> = [];
      for (let d = w.since; d <= w.until; d = addDays(d, 1)) daily.push({ date: d, parts: shape(d, w.until) });
      return { ok: true, daily, currency: "USD", row_count: daily.length, truncated: false, caveats: [], params: {} };
    };
  }
  const steady = (d: string) => 1000 + (d.charCodeAt(9) % 7) * 10;

  it("reads the last settled day, carries weekday_z, and one GA4 read serves three metrics", async () => {
    const fetch = vi.fn(seriesFetch((d, until) => {
      const s = d === until ? 300 : steady(d);
      return { sessions: s, key_events: Math.round(s / 50) };
    }));
    const o = await findSignals("tenant-a", new Set(["google_analytics"]), LA, NOW, { fetch });
    const s = o.signals.find((x) => x.key === "sessions")!;
    expect(s).toMatchObject({ family: "acquisition", kind: "anomaly", bad: true, date: "2026-09-25" });
    expect(s.weekday_z).not.toBeNull();
    expect(s.severity).toBeCloseTo(Math.min(Math.abs(s.z!), Math.abs(s.weekday_z!)), 6);
    expect(fetch.mock.calls.filter(([id]) => ["sessions", "key_events", "conversion_rate"].includes(id as string))).toHaveLength(1);
    expect(o.observed.has("acquisition")).toBe(true);
    for (const c of fetch.mock.calls) expect(c[1]).toMatchObject({ tenant_id: "tenant-a", tz: LA, grain: "day" });
  });

  it("runaway ad spend is bad, a spend drop is not", async () => {
    const up = await findSignals("t", new Set(["meta_ads"]), "UTC", NOW, {
      fetch: seriesFetch((d, until) => ({ spend: d === until ? 5000 : steady(d), clicks: 100, conversions: 10, value: 0 })),
    });
    expect(up.signals.find((s) => s.key === "meta_ad_spend")).toMatchObject({ bad: true, direction: "up", family: "ads_meta" });
    expect(watchDirection(METRIC_CATALOG.meta_ad_spend)).toBe("down");
  });

  it("a metric at zero on non-zero history is a tracking symptom, not a demand drop", async () => {
    const o = await findSignals("t", new Set(["google_analytics"]), "UTC", NOW, {
      fetch: seriesFetch((d, until) => (d === until ? { sessions: 0, key_events: 0 } : { sessions: steady(d), key_events: 20 })),
    });
    const z = o.signals.find((s) => s.key === "sessions")!;
    expect(z).toMatchObject({ family: "tracking", kind: "zero", bad: true });
    expect(z.severity).toBeGreaterThanOrEqual(ALERT_SEVERITY);
    expect(o.signals.some((s) => s.key === "sessions" && s.family === "acquisition")).toBe(false);
  });

  it("a metric with no number on the settled day (CPA with 0 conversions) is not counted as measured", async () => {
    const o = await findSignals("t", new Set(["meta_ads"]), "UTC", NOW, {
      fetch: seriesFetch((d, until) => ({ spend: steady(d), clicks: 100, conversions: d === until ? 0 : 10, value: 0 })),
    });
    expect(o.observedKeys?.has("meta_cpa")).toBe(false);
    expect(o.observedKeys?.has("meta_ad_spend")).toBe(true);
  });

  it("a read that errored is one tracking symptom per source; not connected is silence", async () => {
    const failed = await findSignals("t", new Set(["google_analytics"]), "UTC", NOW, {
      fetch: async () => ({ ok: false, reason: "read_failed", message: "500" }),
    });
    expect(failed.signals).toEqual([expect.objectContaining({ key: "read_failed:google_analytics", family: "tracking", kind: "read_failed" })]);
    const nc = await findSignals("t", new Set(["google_analytics"]), "UTC", NOW, {
      fetch: async () => ({ ok: false, reason: "not_connected", message: "" }),
    });
    expect(nc.signals).toEqual([]);
  });

  it("isZeroCollapse needs 6 prior same weekdays, all above zero", () => {
    const pts = (vals: number[]) => vals.map((v, i) => ({ date: addDays("2026-09-27", -7 * (vals.length - 1 - i)), value: v }));
    expect(isZeroCollapse(pts([5, 5, 5, 5, 5, 5, 0]), "2026-09-27")).toBe(true);
    expect(isZeroCollapse(pts([5, 5, 5, 5, 5, 0]), "2026-09-27")).toBe(false);
    expect(isZeroCollapse(pts([5, 0, 5, 5, 5, 5, 0]), "2026-09-27")).toBe(false);
  });
});

describe("contributorsFor", () => {
  it("quotes contributors only when the explanation moved the same way", () => {
    const e = {
      status: "ok" as const,
      metric_id: "sessions",
      label: "Sessions",
      unit: "count" as const,
      direction: "up" as const,
      window: { since: "a", until: "a" },
      compare_window: { since: "b", until: "b" },
      total: 40,
      compare_total: 100,
      change: -60,
      change_pct: -60,
      dimensions: [],
      drivers: [{ dimension: "device" as const, segment: "mobile", contribution: -50, share_pct: 83, confidence: "high" as const }],
      currency: null,
      caveats: [],
    };
    expect(contributorsFor({ direction: "down" }, e)).toHaveLength(1);
    expect(contributorsFor({ direction: "up" }, e)).toEqual([]);
  });
});

describe("the watched set", () => {
  it("every watched metric is in the catalog, has an implementation and a family", () => {
    for (const id of WATCHED_METRICS) {
      const m = METRIC_CATALOG[id] as CatalogMetricMeta | undefined;
      expect(m, id).toBeDefined();
      expect(METRIC_IMPLS[id], id).toBeDefined();
      expect(m!.point_in_time ?? false, id).toBe(false);
      expect(FAMILY_OF[id], id).toBeDefined();
    }
    expect(WATCHED_METRICS).toContain("meta_ad_spend");
    expect(WATCHED_METRICS).toContain("google_ad_spend");
  });

  it("never reads today, and reads late sources further back", () => {
    expect(watchWindow(METRIC_CATALOG.net_revenue, NOW, "UTC").until).toBe(addDays(TODAY, -1));
    expect(watchWindow(METRIC_CATALOG.search_clicks, NOW, "UTC").until).toBe(addDays(TODAY, -4));
    expect(watchWindow(METRIC_CATALOG.meta_conversions, NOW, "UTC").until).toBe(addDays(TODAY, -4));
    expect(watchWindow(METRIC_CATALOG.meta_ad_spend, NOW, "UTC").until).toBe(addDays(TODAY, -1));
    expect(watchWindow(METRIC_CATALOG.google_ad_spend, NOW, "UTC").until).toBe(addDays(TODAY, -1));
    expect(watchWindow(METRIC_CATALOG.sessions, NOW, "UTC").since).toBe(addDays(TODAY, -2 - 56));
  });
});
