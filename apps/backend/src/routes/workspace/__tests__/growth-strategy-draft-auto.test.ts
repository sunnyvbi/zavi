
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const T = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "11111111-1111-1111-1111-111111111111";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  enqueue: vi.fn(async () => ({ run_id: "run-new" as string | null })),
  lookupFailure: null as "throw" | "error" | null,
  setupOn: false,
  delivery: vi.fn(), recover: vi.fn(),
}));
vi.mock("@/services/growth/strategy-delivery", () => ({ readStrategyDelivery: h.delivery, applySavedStrategy: h.recover }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => h.setupOn) }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: T, user_id: "u1", access_token: "tok" })),
}));

function likeToRegExp(pattern: string): RegExp {
  const esc = pattern
    .split("%")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${esc}$`);
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = [];
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.order = () => q;
      q.eq = (c: string, v: unknown) => {
        filters.push((r) => r[c] === v);
        return q;
      };
      q.like = (c: string, p: string) => {
        const re = likeToRegExp(p);
        filters.push((r) => typeof r[c] === "string" && re.test(r[c] as string));
        return q;
      };
      q.in = (c: string, vs: unknown[]) => {
        filters.push((r) => vs.includes(r[c]));
        return q;
      };
      q.limit = async (n: number) => {
        if (h.lookupFailure === "throw") throw new Error("private database details");
        if (h.lookupFailure === "error") return {data:null,error:{message:"private database details"}};
        return ({
        data: (h.db[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, n),
        error: null,
      }); };
      return q;
    },
  }),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => {
    throw new Error("the auto path must not reach for tenantClient here");
  },
}));

vi.mock("@/services/growth/auto-first-run", () => ({
  AUTO_SERVE_TENANTS_CREATED_AFTER: "2026-09-22T00:00:00.000Z",
}));

vi.mock("../growth-interview", () => ({
  readNote: vi.fn(async () => ({ id: null, metadata: {} })),
}));

vi.mock("../growth-intake-research", () => ({
  readTodaysResearch: vi.fn(async () => ({ status: "ready", reason: null, payload: null, fetched_at: null })),
}));

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...a: unknown[]) => h.enqueue(...(a as [])),
  FleetHaltedError: class FleetHaltedError extends Error {},
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

import { workspaceGrowthStrategyDraft } from "../growth-strategy-draft";

function mockRes() {
  const out: { statusCode: number; body: any } = { statusCode: 200, body: null };
  const res = {
    status(c: number) {
      out.statusCode = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

const autoReq = { query: { auto: "1" } } as unknown as Request;

async function autoDraft() {
  const { res, out } = mockRes();
  await workspaceGrowthStrategyDraft(autoReq, res);
  return out;
}

beforeEach(() => {
  h.enqueue.mockClear();
  h.lookupFailure = null;
  h.delivery.mockReset().mockResolvedValue(null);
  h.recover.mockReset().mockResolvedValue({ phase: "applied", plan_id: "plan" });
  h.setupOn = false;
  h.db = {
    tenants: [{ id: T, created_at: "2026-09-25T10:00:00.123456+00:00" }],
    growth_plan: [],
    agent_runs: [],
  };
});

describe("auto-draft eligibility reads", () => {
  it("a new tenant that never had a plan is drafted for (the control)", async () => {
    const out = await autoDraft();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(out.body).toEqual({ status: "queued", run_id: "run-new" });
  });

  it("a founder who pressed Start over is NOT drafted for again", async () => {
    h.db.growth_plan = [{ id: "p1", tenant_id: T, status: "superseded" }];
    const out = await autoDraft();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(out.body).toEqual({ skipped: "plan_exists" });
  });

  it("another tenant's plan does not count as this tenant's", async () => {
    h.db.growth_plan = [{ id: "p2", tenant_id: OTHER, status: "live" }];
    await autoDraft();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a draft still running from yesterday blocks a second one", async () => {
    h.db.agent_runs = [
      { id: "run-old", tenant_id: T, agent_slug: "cgo", cron_dedupe_key: `cgo:draft:${T}:2026-09-25`, status: "running" },
    ];
    const out = await autoDraft();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(out.body).toEqual({ skipped: "draft_in_flight", run_id: "run-old" });
  });

  it("a queued or blocked draft blocks too — both still hold credits", async () => {
    for (const status of ["queued", "blocked"]) {
      h.db.agent_runs = [
        { id: "run-old", tenant_id: T, agent_slug: "cgo", cron_dedupe_key: `cgo:draft:${T}:2026-09-25`, status },
      ];
      await autoDraft();
    }
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("a FINISHED draft from yesterday does not block today's", async () => {
    h.db.agent_runs = [
      { id: "run-old", tenant_id: T, agent_slug: "cgo", cron_dedupe_key: `cgo:draft:${T}:2026-09-25`, status: "dispatch_error" },
    ];
    await autoDraft();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("another tenant's running draft, or a running non-draft cgo turn, does not block", async () => {
    h.db.agent_runs = [
      { id: "r1", tenant_id: OTHER, agent_slug: "cgo", cron_dedupe_key: `cgo:draft:${OTHER}:2026-09-25`, status: "running" },
      { id: "r2", tenant_id: T, agent_slug: "cgo", cron_dedupe_key: null, status: "running" },
    ];
    await autoDraft();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("a tenant created before the floor is refused before any spend", async () => {
    h.db.tenants = [{ id: T, created_at: "2026-09-21T23:59:59.999999+00:00" }];
    const out = await autoDraft();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(out.body).toEqual({ skipped: "tenant_predates_auto_draft" });
  });
});

describe("welcome setup", () => {
  it("yields to the welcome setup when it is on", async () => {
    h.setupOn = true;
    const out = await autoDraft();
    expect(out.body).toEqual({ skipped: "setup_flow" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("manual save recovery", () => {
  it.each(["throw", "error"] as const)("retries a %s status lookup after dedupe without reporting a failed strategy", async failure => {
    h.enqueue.mockImplementationOnce(async () => {
      h.lookupFailure = failure;
      return {run_id:null};
    });
    const {res,out}=mockRes();
    await workspaceGrowthStrategyDraft({query:{}} as Request,res);
    expect(out.statusCode).toBe(200); expect(out.body).toEqual({retry:true});
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    h.lookupFailure=null;
    const key=`cgo:draft:${T}:${new Date().toISOString().slice(0,10)}`;
    h.db.agent_runs=[{id:"running-run",tenant_id:T,cron_dedupe_key:key,status:"running"}];
    h.delivery.mockRejectedValue(new Error("receipt read is unnecessary while running"));
    const second=mockRes();
    await workspaceGrowthStrategyDraft({query:{}} as Request,second.res);
    expect(second.out.body).toEqual({status:"already_running",run_id:"running-run"});
    expect(h.delivery).not.toHaveBeenCalled(); expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("recovers the saved draft before attempting credit admission", async () => {
    const key = `cgo:draft:${T}:${new Date().toISOString().slice(0, 10)}`;
    h.db.agent_runs = [{ id: "old-run", tenant_id: T, cron_dedupe_key: key, status: "parse_failed" }];
    h.delivery.mockResolvedValue({ artifact: { strategy: {} }, phase: "failed" });
    const { res, out } = mockRes();
    await workspaceGrowthStrategyDraft({ query: {} } as Request, res);
    expect(out.body).toEqual({ status: "saved", run_id: "old-run" });
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.recover).toHaveBeenCalledWith(T, "old-run");
  });
  it("a saved-draft read failure does not start another paid run", async () => {
    const key = `cgo:draft:${T}:${new Date().toISOString().slice(0, 10)}`;
    h.db.agent_runs = [{ id: "old-run", tenant_id: T, cron_dedupe_key: key }];
    h.delivery.mockRejectedValue(new Error("private database details"));
    const { res, out } = mockRes();
    await workspaceGrowthStrategyDraft({ query: {} } as Request, res);
    expect(out.statusCode).toBe(503); expect(JSON.stringify(out.body)).not.toContain("private database");
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
