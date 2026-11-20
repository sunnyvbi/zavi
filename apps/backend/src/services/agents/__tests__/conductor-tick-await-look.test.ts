import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = { id: string; tenant_id: string; kind: string; status: string; updated_at: string; goal_graph: unknown };
type Call = [string, ...unknown[]];

const h = vi.hoisted(() => ({
  tick: vi.fn(),
  rows: [] as Row[],
  queries: [] as Call[][],
  failParked: false,
  driverDeps: { repairConfig: { enabled: false } } as Record<string, unknown>,
}));

function jsonbContains(left: unknown, right: unknown): boolean {
  if (Array.isArray(right)) {
    if (!Array.isArray(left)) return false;
    return right.every((r) => left.some((l) => jsonbContains(l, r)));
  }
  if (right !== null && typeof right === "object") {
    if (left === null || typeof left !== "object" || Array.isArray(left)) return false;
    return Object.entries(right as Record<string, unknown>).every(
      ([k, v]) => k in (left as Record<string, unknown>) && jsonbContains((left as Record<string, unknown>)[k], v),
    );
  }
  return left === right;
}

function parseJsonbFilter(value: unknown): unknown {
  if (typeof value !== "string") throw new Error(`jsonb filter must be a JSON string, got ${typeof value}`);
  return JSON.parse(value);
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: false, error: null }),
    from: () => {
      const calls: Call[] = [];
      h.queries.push(calls);
      const run = () => {
        let out = [...h.rows];
        let limit = Infinity;
        for (const c of calls) {
          if (c[0] === "eq") out = out.filter((r) => (r as Record<string, unknown>)[c[1] as string] === c[2]);
          if (c[0] === "not") {
            if (c[1] !== "goal_graph" || c[2] !== "cs") throw new Error("unexpected not filter");
            const marker = parseJsonbFilter(c[3]);
            out = out.filter((r) => !jsonbContains(r.goal_graph, marker));
          }
          if (c[0] === "contains") {
            if (c[1] !== "goal_graph") throw new Error("unexpected contains column");
            if (h.failParked) return { data: null, error: { message: "boom" } };
            const marker = parseJsonbFilter(c[2]);
            out = out.filter((r) => jsonbContains(r.goal_graph, marker));
          }
          if (c[0] === "order") {
            const asc = (c[2] as { ascending: boolean }).ascending;
            out.sort((a, b) => (asc ? 1 : -1) * a.updated_at.localeCompare(b.updated_at));
          }
          if (c[0] === "limit") limit = c[1] as number;
        }
        return { data: out.slice(0, limit), error: null };
      };
      const builder: Record<string, unknown> = {
        select: (...a: unknown[]) => (calls.push(["select", ...a]), builder),
        eq: (...a: unknown[]) => (calls.push(["eq", ...a]), builder),
        order: (...a: unknown[]) => (calls.push(["order", ...a]), builder),
        not: (...a: unknown[]) => (calls.push(["not", ...a]), builder),
        contains: (...a: unknown[]) => (calls.push(["contains", ...a]), builder),
        limit: (...a: unknown[]) => (calls.push(["limit", ...a]), Promise.resolve(run())),
        maybeSingle: () => Promise.resolve({ data: { goal_graph: [] }, error: null }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/services/agents/conductor", () => ({ conductorTick: h.tick }));
vi.mock("@/services/agents/conductor-driver", () => ({
  realConductorTickDeps: h.driverDeps,
  isConductorEnabled: async () => true,
  resolveConductorRepairEnabled: async () => false,
}));
vi.mock("@/services/agents/continue-build", () => ({
  expireStalePausedBuilds: vi.fn(async () => 0),
  resumeStrandedSiteRepublishes: vi.fn(async () => 0),
}));
vi.mock("@/services/agents/conductor-ledger", () => ({
  appendConductorAction: vi.fn().mockResolvedValue(undefined),
  isLoggableTick: () => false,
}));
vi.mock("@/services/agents/conductor-observability", () => ({ logBuildTick: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/agents/cron-stopped", () => ({ isWorkerCronStopped: () => false }));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => false }));
vi.mock("@/services/agents/conductor-owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../conductor-owner")>()),
  conductorOwnerOnlyEnabled: async () => false,
}));

import {
  conductorTickFn,
  conductorTickRequestedFn,
  MAX_AWAITING_LOOK_PER_SWEEP,
} from "../../../../workers/functions/conductor-tick";
import { inngest } from "../../../../workers/client";
import { buildSiteGoalGraph } from "../product-pipeline";
import { AWAITING_LOOK_GRAPH_MARKER } from "@/services/sites/look-wait";

type Handler = (ctx: { event?: unknown; logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void } }) => Promise<Record<string, unknown>>;
const cronFn = (conductorTickFn as unknown as { fn: Handler }).fn;
const eventFn = (conductorTickRequestedFn as unknown as { fn: Handler }).fn;
const warnings: string[] = [];
const logger = { error: () => {}, info: () => {}, warn: (m: string) => void warnings.push(m) };
const send = vi.spyOn(inngest, "send");

function uuid(prefix: string, i: number): string {
  return `${prefix}${i.toString().padStart(4, "0")}-0000-4000-8000-000000000000`;
}

function siteGraph(awaitLook: boolean) {
  return buildSiteGoalGraph(
    { tenant_id: "tnt", company_name: "Acme", idea: "a bakery site", max_usd: 5 },
    {
      site_id: "site-1",
      target: { github_full_name: "o/r", repo_url: "https://github.com/o/r", default_branch: "main" },
      seed_sha: "a".repeat(40),
      publish_on_request: false,
      await_look: awaitLook,
    },
  );
}

function parkedRow(i: number): Row {
  return { id: uuid("aaaa", i), tenant_id: "tnt", kind: "build_app", status: "active", updated_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, goal_graph: siteGraph(true) };
}

function liveRow(i: number): Row {
  return { id: uuid("bbbb", i), tenant_id: "tnt", kind: "build_app", status: "active", updated_at: `2026-02-01T00:00:${String(i).padStart(2, "0")}Z`, goal_graph: siteGraph(false) };
}

function fannedOutIds(): string[] {
  const events = send.mock.calls[0]![0] as unknown as Array<{ data: { conductor_run_id: string } }>;
  return events.map((e) => e.data.conductor_run_id);
}

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
  vi.stubEnv("PRAXIS_DRAIN_SHARED_QUEUE", "");
  h.tick.mockReset();
  h.queries.length = 0;
  h.failParked = false;
  warnings.length = 0;
  send.mockReset();
  send.mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("conductor-tick cron and runs parked on the look pick", () => {
  it("the marker matches a parked first build and nothing else", () => {
    expect(jsonbContains(siteGraph(true), AWAITING_LOOK_GRAPH_MARKER)).toBe(true);
    expect(jsonbContains(siteGraph(false), AWAITING_LOOK_GRAPH_MARKER)).toBe(false);
    const dispatched = siteGraph(true).map((n) => (n.payload.stage === "build" ? { ...n, status: "dispatched" } : n));
    expect(jsonbContains(dispatched, AWAITING_LOOK_GRAPH_MARKER)).toBe(false);
  });

  it("thirty old parked runs never crowd the 25 live runs out of the sweep, and 25 parked runs are still re-ticked", async () => {
    h.rows = [...Array.from({ length: 30 }, (_, i) => parkedRow(i)), ...Array.from({ length: 30 }, (_, i) => liveRow(i))];
    const out = await cronFn({ event: { name: "inngest/scheduled.timer", data: {} }, logger });

    const main = h.queries.find((q) => q.some((c) => c[0] === "not"))!;
    expect(main).toContainEqual(["not", "goal_graph", "cs", JSON.stringify(AWAITING_LOOK_GRAPH_MARKER)]);
    expect(main).toContainEqual(["limit", 25]);
    const parked = h.queries.find((q) => q.some((c) => c[0] === "contains"))!;
    expect(parked).toContainEqual(["eq", "status", "active"]);
    expect(parked).toContainEqual(["limit", MAX_AWAITING_LOOK_PER_SWEEP]);
    expect(MAX_AWAITING_LOOK_PER_SWEEP).toBe(25);

    const ids = fannedOutIds();
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    const live = ids.filter((id) => id.startsWith("bbbb"));
    const park = ids.filter((id) => id.startsWith("aaaa"));
    expect(live).toEqual(Array.from({ length: 25 }, (_, i) => uuid("bbbb", i)));
    expect(park).toHaveLength(25);
    expect(out).toEqual({ fanned_out: 50 });
    expect(h.tick).not.toHaveBeenCalled();
  });

  it("a failed parked read only warns: the live sweep still fans out", async () => {
    h.rows = [parkedRow(0), liveRow(0)];
    h.failParked = true;
    const out = await cronFn({ event: { name: "inngest/scheduled.timer", data: {} }, logger });
    expect(fannedOutIds()).toEqual([uuid("bbbb", 0)]);
    expect(out).toEqual({ fanned_out: 1 });
    expect(warnings.some((w) => w.includes("look-awaiting"))).toBe(true);
  });

  it("a targeted tick (the kick after a pick) reaches a parked run: no marker filter, no parked query", async () => {
    h.rows = [parkedRow(0)];
    h.tick.mockResolvedValue({ action: "dispatched", node_id: "b", child_run_id: "c" });
    const out = await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: uuid("aaaa", 0) } }, logger });
    expect(h.tick).toHaveBeenCalledTimes(1);
    expect(h.tick.mock.calls[0]![0]).toBe(uuid("aaaa", 0));
    expect(out.ticked).toBe(1);
    expect(h.queries.some((q) => q.some((c) => c[0] === "not" || c[0] === "contains"))).toBe(false);
  });

  it("a run still waiting on the look gets no follow-up tick; an ordinary wait does", async () => {
    h.rows = [parkedRow(0)];
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 0, awaiting: "look" });
    const parked = await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: uuid("aaaa", 0) } }, logger });
    expect(parked.followed_up).toBe(0);
    expect(parked.results).toEqual([{ id: uuid("aaaa", 0), action: "waiting", awaiting: "look" }]);
    expect(send).not.toHaveBeenCalled();

    h.tick.mockResolvedValue({ action: "waiting", in_flight: 0 });
    const waiting = await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: uuid("aaaa", 0) } }, logger });
    expect(waiting.followed_up).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a parked run gets one tick timed for its auto start, so the build starts with the tab closed", async () => {
    h.rows = [parkedRow(0)];
    const id = uuid("aaaa", 0);
    const at = new Date(Date.now() + 45_000).toISOString();
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 0, awaiting: "look", auto_start_at: at });
    const out = await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: id } }, logger });
    expect(out.followed_up).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    const ev = send.mock.calls[0]![0] as unknown as { id: string; name: string; data: { conductor_run_id: string }; ts: number };
    expect(ev).toEqual({ id: `conductor-look-auto-${id}-${Date.parse(at) + 1000}`, name: "conductor/tick.requested", data: { conductor_run_id: id }, ts: Date.parse(at) + 1000 });

    await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: id } }, logger });
    const again = send.mock.calls[1]![0] as unknown as { id: string };
    expect(again.id).toBe(ev.id);
  });

  it("no timed tick when the start time has passed or is missing, and a failed send only warns", async () => {
    h.rows = [parkedRow(0)];
    const id = uuid("aaaa", 0);
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 0, awaiting: "look", auto_start_at: new Date(Date.now() - 1000).toISOString() });
    await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: id } }, logger });
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 0, awaiting: "look" });
    await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: id } }, logger });
    expect(send).not.toHaveBeenCalled();

    send.mockRejectedValueOnce(new Error("inngest down"));
    h.tick.mockResolvedValue({ action: "waiting", in_flight: 0, awaiting: "look", auto_start_at: new Date(Date.now() + 30_000).toISOString() });
    const out = await eventFn({ event: { name: "conductor/tick.requested", data: { conductor_run_id: id } }, logger });
    expect(out.results).toEqual([{ id, action: "waiting", awaiting: "look" }]);
    expect(warnings.some((w) => w.includes("look auto start tick failed"))).toBe(true);
  });
});
