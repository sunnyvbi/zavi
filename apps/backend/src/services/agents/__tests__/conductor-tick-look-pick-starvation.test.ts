import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

type Row = { id: string; tenant_id: string; kind: string; status: string; updated_at: string; goal_graph: unknown };
type Call = [string, ...unknown[]];

const h = vi.hoisted(() => ({
  tick: vi.fn(),
  rows: [] as Row[],
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Call[] }>,
  failUpdate: false,
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

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => {
    throw new Error("the route must read through its injected deps");
  },
  serviceClient: () => ({
    rpc: async () => ({ data: false, error: null }),
    from: (table: string) => {
      if (table !== "conductor_runs") throw new Error(`unexpected table ${table}`);
      const calls: Call[] = [];
      const run = () => {
        let out = [...h.rows];
        let limit = Infinity;
        for (const c of calls) {
          if (c[0] === "eq") out = out.filter((r) => (r as Record<string, unknown>)[c[1] as string] === c[2]);
          if (c[0] === "not") out = out.filter((r) => !jsonbContains(r.goal_graph, JSON.parse(c[3] as string)));
          if (c[0] === "contains") out = out.filter((r) => jsonbContains(r.goal_graph, JSON.parse(c[2] as string)));
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
        update: (patch: Record<string, unknown>) => {
          const filters: Call[] = [];
          const chain: Record<string, unknown> = {
            eq: (...a: unknown[]) => (filters.push(["eq", ...a]), chain),
            select: () => chain,
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
              h.updates.push({ patch, filters });
              if (h.failUpdate) return Promise.resolve({ data: null, error: { message: "db blip" } }).then(resolve, reject);
              const touched: unknown[] = [];
              for (const r of h.rows) {
                if (filters.every((f) => (r as Record<string, unknown>)[f[1] as string] === f[2])) {
                  Object.assign(r, patch);
                  touched.push({ id: (r as { id?: unknown }).id });
                }
              }
              return Promise.resolve({ data: touched, error: null }).then(resolve, reject);
            },
          };
          return chain;
        },
      };
      return builder;
    },
  }),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: "u1", access_token: "tok" })) }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn(async () => true) }));
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

import { conductorTickFn, conductorTickRequestedFn, MAX_AWAITING_LOOK_PER_SWEEP } from "../../../../workers/functions/conductor-tick";
import { inngest } from "../../../../workers/client";
import { buildSiteGoalGraph } from "../product-pipeline";
import { makePostSiteDesignDirection, type SiteDesignRouteDeps } from "@/routes/workspace/site-design";
import { touchLookPickedRun } from "@/services/sites/look-wait";
import { designDirections, withCompleteLook } from "@/services/sites/design-directions";
import type { DesignBrief } from "@/services/sites/design-brief";
import type { SiteRow } from "@/services/sites/contract";
import type { SiteDesignRow, SiteDesignStore } from "@/services/sites/site-design-store";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PICKED = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "33333333-3333-4333-8333-333333333333";

type Handler = (ctx: { event?: unknown; logger: { error: (m: string) => void; info: (m: string) => void; warn: (m: string) => void } }) => Promise<Record<string, unknown>>;
const eventFn = (conductorTickRequestedFn as unknown as { fn: Handler }).fn;
const cronFn = (conductorTickFn as unknown as { fn: Handler }).fn;
const logger = { error: () => {}, info: () => {}, warn: () => {} };
const send = vi.spyOn(inngest, "send");

const BRIEF: DesignBrief = withCompleteLook(
  {
    industry: "photography",
    mood: "quiet bold modern",
    mode: "light",
    colors: {
      background: "#ffffff",
      foreground: "#111111",
      muted: "#f2f2f2",
      "muted-foreground": "#555555",
      primary: "#111111",
      "primary-foreground": "#ffffff",
      border: "#e5e5e5",
    },
    fonts: { heading: "Archivo", body: "Figtree" },
    look: { base: "studio", layout: "minimal", alternates: ["luxe", "editorial"] },
    source: "model",
  },
  "",
);

function parkedGraph(site_id: string) {
  return buildSiteGoalGraph(
    { tenant_id: TENANT, company_name: "Acme", idea: "a bakery site", max_usd: 5 },
    {
      site_id,
      target: { github_full_name: "o/r", repo_url: "https://github.com/o/r", default_branch: "main" },
      seed_sha: "a".repeat(40),
      publish_on_request: false,
      await_look: true,
    },
  );
}

function otherParked(i: number): Row {
  return {
    id: `aaaa${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
    tenant_id: "other",
    kind: "build_app",
    status: "active",
    updated_at: `2026-03-01T00:00:${String(i).padStart(2, "0")}Z`,
    goal_graph: parkedGraph(`site-${i}`),
  };
}

function site(): SiteRow {
  return { id: SITE_ID, tenant_id: TENANT, root_conductor_run_id: PICKED, status: "building", live_sha: null, label: "ana", hostname: "ana.zaviagent.com" } as unknown as SiteRow;
}

function routeDeps(kick: () => Promise<unknown>): SiteDesignRouteDeps {
  let row: SiteDesignRow = {
    site_id: SITE_ID,
    tenant_id: TENANT,
    conductor_run_id: PICKED,
    brief: BRIEF,
    directions: designDirections(BRIEF),
    theme_mode: "theme_css",
    chosen_direction: "brand",
    chosen_at: null,
    applied_direction: "brand",
    sealed_at: null,
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
  };
  const store = {
    get: async () => row,
    choose: async (_t: string, _s: string, direction: string) => {
      row = { ...row, chosen_direction: direction, chosen_at: "2026-10-07T01:00:00Z" };
      return row;
    },
  } as unknown as SiteDesignStore;
  return {
    loadRun: async (_tok, _tenant, id) => {
      const r = h.rows.find((x) => x.id === id);
      return r ? { id: r.id, status: r.status, goal_graph: r.goal_graph } : null;
    },
    loadSite: async () => site(),
    store,
    applyLive: () => undefined,
    waitsForLook: async () => true,
    kick,
    pickParked: async (input) => {
      await (store as unknown as { choose: (t: string, s: string, d: string) => Promise<unknown> }).choose(input.tenant_id, SITE_ID, input.direction);
      await touchLookPickedRun(input.tenant_id, input.conductor_run_id);
      return { state: "picked" };
    },
  };
}

async function pick(deps: SiteDesignRouteDeps) {
  let status = 200;
  let json: unknown = null;
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: unknown) {
      json = b;
      return res;
    },
  } as unknown as Response;
  await makePostSiteDesignDirection(() => deps)({ body: { run_id: PICKED, direction: "luxe" } } as Request, res);
  return { status, json: json as { started?: boolean } };
}

async function cronIds(): Promise<string[]> {
  send.mockClear();
  await cronFn({ event: { name: "inngest/scheduled.timer", data: {} }, logger });
  const events = (send.mock.calls[0]?.[0] ?? []) as unknown as Array<{ data: { conductor_run_id: string } }>;
  return events.map((e) => e.data.conductor_run_id);
}

beforeEach(() => {
  vi.stubEnv("PRAXIS_CONTAINER_ROLE", "canonical");
  vi.stubEnv("PRAXIS_DRAIN_SHARED_QUEUE", "");
  h.tick.mockReset();
  h.updates.length = 0;
  h.failUpdate = false;
  send.mockReset();
  send.mockResolvedValue({ ids: [] } as never);
  h.rows = [
    { id: PICKED, tenant_id: TENANT, kind: "build_app", status: "active", updated_at: "2026-01-01T00:00:00Z", goal_graph: parkedGraph(SITE_ID) },
    ...Array.from({ length: 30 }, (_, i) => otherParked(i)),
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bounded parked scans rotate without starving builds", () => {
  it("checks every parked run across sweeps even when nobody picks a look", async () => {
    h.tick.mockResolvedValue({ action: "waiting", awaiting: "look" });
    const first = await cronIds();
    for (const id of first) {
      await eventFn({ event: { data: { conductor_run_id: id } }, logger });
    }
    const second = await cronIds();
    expect(new Set([...first, ...second]).size).toBe(h.rows.length);
    expect(h.updates).toHaveLength(first.length);
    expect(h.updates.every((u) => Object.keys(u.patch).join() === "updated_at")).toBe(true);
  });
  it("before any pick, the oldest parked run is inside the parked window", async () => {
    expect(MAX_AWAITING_LOOK_PER_SWEEP).toBe(25);
    const ids = await cronIds();
    expect(ids).toHaveLength(25);
    expect(ids).toContain(PICKED);
  });

  it("the parked scan rotates to a picked run even when its direct kick failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await pick(routeDeps(async () => {
      throw new Error("inngest down");
    }));
    warn.mockRestore();
    expect(r.status).toBe(200);
    expect(r.json.started).toBe(true);
    expect(h.updates).toHaveLength(1);
    expect(Object.keys(h.updates[0]!.patch)).toEqual(["updated_at"]);
    expect(h.updates[0]!.filters).toEqual([
      ["eq", "tenant_id", TENANT],
      ["eq", "id", PICKED],
      ["eq", "status", "active"],
    ]);
    const ids = await cronIds();
    expect(ids).toHaveLength(25);
    expect(ids).not.toContain(PICKED);
    h.tick.mockResolvedValue({ action: "waiting", awaiting: "look" });
    for (const id of ids) {
      await eventFn({ event: { name: "zavi/conductor.tick.requested", data: { conductor_run_id: id } }, logger });
    }
    expect(await cronIds()).toContain(PICKED);
  });

  it("the touch never reaches a run of another tenant or one that is no longer active", async () => {
    h.rows[0]!.status = "cancelled";
    await touchLookPickedRun(TENANT, PICKED);
    expect(await touchLookPickedRun("other", PICKED)).toBe(false);
    expect(h.rows[0]!.updated_at).toBe("2026-01-01T00:00:00Z");
  });

  it("a failed touch throws so the route can log it", async () => {
    h.failUpdate = true;
    await expect(touchLookPickedRun(TENANT, PICKED)).rejects.toThrow("db blip");
  });
});
