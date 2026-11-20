import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient() must not be called when svc is injected");
  },
}));

import { getDeployBlockingRuns } from "@/services/agents/inflight-runs";
import { MONEY_PATH_SLUGS } from "@/services/agents/infra-retry";

type Resp = { data: unknown; error: { message: string } | null };

function makeSvc(resp: Resp) {
  const trace: Record<string, unknown> = {
    table: null as string | null,
    select: null as string | null,
    eq: [] as Array<[string, unknown]>,
    not: [] as Array<[string, string, unknown]>,
    or: null as string | null,
  };
  const b: Record<string, unknown> = {
    from(table: string) {
      trace.table = table;
      return b;
    },
    select(c: string) {
      trace.select = c;
      return b;
    },
    eq(c: string, v: unknown) {
      (trace.eq as Array<[string, unknown]>).push([c, v]);
      return b;
    },
    not(c: string, op: string, v: unknown) {
      (trace.not as Array<[string, string, unknown]>).push([c, op, v]);
      return b;
    },
    or(filter: string) {
      trace.or = filter;
      return b;
    },
    then(resolve: (r: Resp) => void) {
      resolve(resp);
    },
  };
  return { svc: b as never, trace };
}

const row = (agent_slug: string, last_progress_at = new Date().toISOString()) => ({
  agent_slug,
  last_progress_at,
});

describe("getDeployBlockingRuns", () => {
  it("pins the predicate: status='running' AND last_progress_at NOT NULL AND slug NOT IN money", async () => {
    const { svc, trace } = makeSvc({ data: [], error: null });
    await getDeployBlockingRuns(svc);
    expect(trace.table).toBe("agent_runs");
    expect(trace.select).toBe("agent_slug,last_progress_at");
    expect(trace.eq).toContainEqual(["status", "running"]);
    expect(trace.not).toContainEqual(["last_progress_at", "is", null]);
    const moneyClause = (trace.not as Array<[string, string, unknown]>).find(
      ([c]) => c === "agent_slug",
    );
    expect(moneyClause).toBeTruthy();
    for (const slug of MONEY_PATH_SLUGS) {
      expect(String(moneyClause![2])).toContain(slug);
    }
  });

  it("INCIDENT REPLAY: a progressed non-money daily-brief run blocks the swap", async () => {
    const { svc } = makeSvc({ data: [row("growth-lead")], error: null });
    const r = await getDeployBlockingRuns(svc);
    expect(r.count).toBe(1);
    expect(r.slugs).toEqual(["growth-lead"]);
    expect(r.safe_to_swap).toBe(false);
  });

  it("zero in-flight → safe_to_swap=true (deploy proceeds immediately)", async () => {
    const { svc } = makeSvc({ data: [], error: null });
    const r = await getDeployBlockingRuns(svc);
    expect(r.count).toBe(0);
    expect(r.slugs).toEqual([]);
    expect(r.safe_to_swap).toBe(true);
  });

  it("multiple briefs → distinct sorted slug-set, count = row count", async () => {
    const { svc } = makeSvc({
      data: [row("pm"), row("growth-lead"), row("chief-of-staff"), row("pm")],
      error: null,
    });
    const r = await getDeployBlockingRuns(svc);
    expect(r.count).toBe(4);
    expect(r.slugs).toEqual(["chief-of-staff", "growth-lead", "pm"]);
    expect(r.safe_to_swap).toBe(false);
  });

  it("body is content-free — NO tenant_id or run content leaks (C14)", async () => {
    const { svc } = makeSvc({ data: [row("pm")], error: null });
    const r = await getDeployBlockingRuns(svc);
    expect(Object.keys(r).sort()).toEqual(["count", "safe_to_swap", "slugs", "stale_ignored"]);
    expect(JSON.stringify(r)).not.toMatch(/tenant|run_id|output|prompt/i);
  });

  it("FAIL-SAFE: a DB read error → safe_to_swap=false (defer, never throw, never blind-swap)", async () => {
    const { svc } = makeSvc({ data: null, error: { message: "boom" } });
    const r = await getDeployBlockingRuns(svc);
    expect(r.count).toBe(0);
    expect(r.safe_to_swap).toBe(false);
    expect(r.slugs).toEqual([]);
  });

  it("money-path exclusion uses the SHARED MONEY_PATH_SLUGS (includes performance-marketer + dispute-response)", () => {
    expect(MONEY_PATH_SLUGS.has("performance-marketer")).toBe(true);
    expect(MONEY_PATH_SLUGS.has("dispute-response")).toBe(true);
  });
});

describe("own-runs-only filter (worker_id)", () => {
  const ORIG = process.env.PRAXIS_CONTAINER_ROLE;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PRAXIS_CONTAINER_ROLE;
    else process.env.PRAXIS_CONTAINER_ROLE = ORIG;
  });

  it("the prod container waits for its OWN runs and for unstamped (NULL) rows", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    const { svc, trace } = makeSvc({ data: [], error: null });
    await getDeployBlockingRuns(svc);
    expect(trace.or).toBe("worker_id.is.null,worker_id.eq.canonical");
  });

  it("a dev stack against prod data scopes to itself, so it cannot block prod", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "";
    process.env.HOSTNAME = "ravis-mbp.local";
    const { svc, trace } = makeSvc({ data: [], error: null });
    await getDeployBlockingRuns(svc);
    expect(trace.or).toBe("worker_id.is.null,worker_id.eq.dev:ravis-mbp.local");
  });

  it("a hostname with filter syntax cannot change the predicate", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "";
    process.env.HOSTNAME = "box,worker_id.eq.canonical)";
    const { svc, trace } = makeSvc({ data: [], error: null });
    await getDeployBlockingRuns(svc);
    expect(trace.or).toBe("worker_id.is.null,worker_id.eq.dev:box-worker_id.eq.canonical-");
  });
});

describe("stale cutoff (wedged runs stop blocking a deploy)", () => {
  const ORIG = process.env.PRAXIS_DEPLOY_GUARD_STALE_MS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PRAXIS_DEPLOY_GUARD_STALE_MS;
    else process.env.PRAXIS_DEPLOY_GUARD_STALE_MS = ORIG;
  });
  const NOW = Date.parse("2026-09-29T12:00:00Z");
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

  it("INCIDENT REPLAY: a run silent for 26 min is not counted; the deploy may swap", async () => {
    delete process.env.PRAXIS_DEPLOY_GUARD_STALE_MS;
    const { svc } = makeSvc({ data: [row("engineer", ago(26))], error: null });
    const r = await getDeployBlockingRuns(svc, NOW);
    expect(r.count).toBe(0);
    expect(r.slugs).toEqual([]);
    expect(r.safe_to_swap).toBe(true);
    expect(r.stale_ignored).toBe(1);
  });

  it("a run that progressed recently still blocks", async () => {
    delete process.env.PRAXIS_DEPLOY_GUARD_STALE_MS;
    const { svc } = makeSvc({
      data: [row("engineer", ago(26)), row("growth-lead", ago(19))],
      error: null,
    });
    const r = await getDeployBlockingRuns(svc, NOW);
    expect(r.count).toBe(1);
    expect(r.slugs).toEqual(["growth-lead"]);
    expect(r.safe_to_swap).toBe(false);
    expect(r.stale_ignored).toBe(1);
  });

  it("PRAXIS_DEPLOY_GUARD_STALE_MS overrides the 20-min default", async () => {
    process.env.PRAXIS_DEPLOY_GUARD_STALE_MS = String(5 * 60_000);
    const { svc } = makeSvc({ data: [row("growth-lead", ago(6))], error: null });
    const r = await getDeployBlockingRuns(svc, NOW);
    expect(r.count).toBe(0);
    expect(r.stale_ignored).toBe(1);
  });

  it("a junk override falls back to the default", async () => {
    process.env.PRAXIS_DEPLOY_GUARD_STALE_MS = "not-a-number";
    const { svc } = makeSvc({ data: [row("growth-lead", ago(6))], error: null });
    const r = await getDeployBlockingRuns(svc, NOW);
    expect(r.count).toBe(1);
  });

  it("an unparseable timestamp stays counted (unknown errs toward waiting)", async () => {
    const { svc } = makeSvc({ data: [row("pm", "garbage")], error: null });
    const r = await getDeployBlockingRuns(svc, NOW);
    expect(r.count).toBe(1);
    expect(r.stale_ignored).toBe(0);
  });
});
