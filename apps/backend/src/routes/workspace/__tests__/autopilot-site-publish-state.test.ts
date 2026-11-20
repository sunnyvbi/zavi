import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { fakeSiteStore, siteRow, T1, T2 } from "@/services/sites/__tests__/fake-site-store";
import type { SiteRow } from "@/services/sites/contract";
import { BUILD_FIXES_EXHAUSTED } from "@zavi/shared";

type PublishRunRow = { id: string; tenant_id: string; kind: string; status: string; created_at: string; failure_class?: string; goal_graph: Array<Record<string, unknown>> };

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  publishRuns: [] as PublishRunRow[],
  publishQueries: [] as Array<Array<[string, unknown[]]>>,
  publishQueryError: null as null | string,
  publishQueryThrows: false,
  sandboxes: [] as Array<Record<string, unknown>>,
  store: null as unknown,
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return { ...actual, getBoolSetting: vi.fn(async () => true) };
});
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
const kicks = vi.hoisted(() => [] as unknown[]);
vi.mock("@/services/agents/conductor-driver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/agents/conductor-driver")>();
  return { ...actual, kickSandboxPreview: (...a: unknown[]) => kicks.push(a[0]) };
});

function chain(resolve: (calls: Array<[string, unknown[]]>) => unknown) {
  const calls: Array<[string, unknown[]]> = [];
  const api: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "or", "order", "gte", "is", "not"]) {
    api[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      return api;
    };
  }
  api.limit = (...a: unknown[]) => {
    calls.push(["limit", a]);
    return resolve(calls);
  };
  api.maybeSingle = () => resolve(calls);
  api.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(calls)).then(ok, bad);
  return api;
}

const SITE_PATH = "goal_graph->0->payload->>site_id";
const REPUBLISH_PATH = "goal_graph->0->payload->>republish";

function publishRunQuery(calls: Array<[string, unknown[]]>) {
  h.publishQueries.push(calls.map(([m, a]) => [m, [...a]] as [string, unknown[]]));
  if (h.publishQueryThrows) throw new Error("socket hang up");
  if (h.publishQueryError) return { data: null, error: { message: h.publishQueryError } };
  const eq = (col: string) => calls.find(([m, a]) => m === "eq" && a[0] === col)?.[1][1];
  let rows = h.publishRuns.filter((r) => {
    const node = r.goal_graph[0] as { payload?: { site_id?: unknown; republish?: unknown } } | undefined;
    return (
      r.tenant_id === eq("tenant_id") &&
      r.kind === eq("kind") &&
      node?.payload?.site_id === eq(SITE_PATH) &&
      String(node?.payload?.republish) === eq(REPUBLISH_PATH)
    );
  });
  const order = calls.find(([m]) => m === "order");
  if (order && order[1][0] === "created_at" && (order[1][1] as { ascending?: boolean })?.ascending === false) {
    rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  const lim = calls.find(([m]) => m === "limit")?.[1][0];
  return { data: typeof lim === "number" ? rows.slice(0, lim) : rows, error: null };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        return chain((calls) => {
          const sel = String(calls.find(([m]) => m === "select")?.[1][0] ?? "");
          if (sel === "id, status, created_at, failure_class, goal_graph") return publishRunQuery(calls);
          const id = calls.find(([m, a]) => m === "eq" && a[0] === "id")?.[1][1];
          return { data: id ? h.runs.filter((r) => r.id === id) : h.runs, error: null };
        });
      }
      return chain(() => ({ data: [], error: null }));
    },
  }),
  serviceClient: () => ({ from: () => chain(() => ({ data: null, error: null })), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant_id: string) => ({
    from: (table: string) =>
      chain((calls) => {
        if (table !== "tenant_sandbox") return { data: null, error: null };
        const repo = calls.find(([m, a]) => m === "eq" && a[0] === "repo_full_name")?.[1][1];
        return { data: h.sandboxes.find((s) => s.tenant_id === tenant_id && s.repo_full_name === repo) ?? null, error: null };
      }),
  }),
}));

import { __resetSitePreviewConfigChecks, getAutopilotBuildStatus } from "../autopilot";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const RA = "a0000000-0000-4000-8000-00000000000a";
const RB = "b0000000-0000-4000-8000-00000000000b";
const PREVIEW = "https://5173-sbx-a.e2b.app";
const GATE = "The site's smoke check failed: the booking form returns a 500\nEvidence: POST /api/data/bookings -> 500";

const onRequestGraph = (site_id: string) => [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id, fast_single_pass: true } },
];
const autoPublishGraph = (site_id: string, deploy: string) => [...onRequestGraph(site_id), { status: deploy, payload: { stage: "deploy", site_id } }];

function rootRun(id: string, graph: unknown[], status = "done") {
  return { id, objective: "Build product: Alpha", status, goal_graph: graph, spend_usd: 0, max_usd: 10, created_at: "2026-10-01T01:00:00Z", updated_at: "2026-10-01T01:10:00Z" };
}

function publishRun(over: Partial<PublishRunRow> & { site_id?: string; error?: string; republish?: unknown } = {}): PublishRunRow {
  const { site_id = SA, error, republish = true, ...row } = over;
  return {
    id: `cr-${h.publishRuns.length + 1}`,
    tenant_id: T1,
    kind: "build_app",
    status: "active",
    created_at: "2026-10-02T05:00:00+00:00",
    goal_graph: [{ status: "pending", payload: { stage: "deploy", refine_mode: true, republish, site_id, site_sha: "abc1234" }, ...(error ? { error } : {}) }],
    ...row,
  };
}

function sites(over: Partial<SiteRow> = {}) {
  h.store = fakeSiteStore([
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "building", updated_at: "2026-10-02T04:00:00Z", ...over }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "building" }),
  ]).store;
}

async function status(run_id = RA) {
  const r = {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    json(b: unknown) {
      r.body = b;
      return r;
    },
  };
  await getAutopilotBuildStatus({ query: { run_id } } as never, r as never);
  return r;
}

beforeEach(() => {
  kicks.length = 0;
  __resetSitePreviewConfigChecks();
  h.publishRuns = [];
  h.publishQueries = [];
  h.publishQueryError = null;
  h.publishQueryThrows = false;
  sites();
  h.runs = [rootRun(RA, onRequestGraph(SA)), rootRun(RB, onRequestGraph(SB))];
  h.sandboxes = [{ id: "row-a", tenant_id: T1, repo_full_name: "Praxis-build/alpha", preview_url: PREVIEW, preview_status: "live" }];
  vi.stubGlobal("fetch", async () => ({ status: 200, text: async () => "<html></html>", headers: new Headers({ "content-type": "text/html", "x-zavi-deploy-id": "d1" }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("build-status on a live site preview", () => {
  beforeAll(async () => {
    await import("@/services/agents/conductor-driver");
  }, 60_000);

  it("asks the sandbox once to bring its preview runtime up to date, so a reload shows the text tool without a second reload", async () => {
    const r = await status();
    expect(r.body.preview).toEqual({ url: PREVIEW, kind: "instant" });
    await vi.waitFor(() => expect(kicks).toHaveLength(1), { timeout: 5_000 });
    expect(kicks[0]).toMatchObject({ tenant_id: T1, site: true, onlyIfAnswering: true, node: { payload: { target: { github_full_name: "Praxis-build/alpha" } } } });
    await status();
    await status();
    await new Promise((res) => setTimeout(res, 10));
    expect(kicks).toHaveLength(1);
  }, 20_000);
});

describe("build-status publish block for a build that publishes on request", () => {
  it("never published: none, the app is ready and the preview is served", async () => {
    const r = await status();
    expect(r.statusCode).toBe(200);
    expect(r.body.run.status).toBe("done");
    expect(r.body.app_ready).toBe(true);
    expect(r.body.publish).toEqual({ status: "none", started_at: null, url: null, retryable: false });
    expect(r.body.preview).toEqual({ url: PREVIEW, kind: "instant" });
    expect(r.body.site).toMatchObject({ id: SA, status: "building", live_url: null });
  });

  it.each([
    "The site setup could not finish a step.",
    "check: the page is missing its heading",
    GATE,
    "publish failed",
  ])("a last_error on the site (%j) with no failed publish run never reads as a failed publish", async (last_error) => {
    sites({ last_error });
    const r = await status();
    expect(r.body.publish).toEqual({ status: "none", started_at: null, url: null, retryable: false });
    expect(r.body.app_ready).toBe(true);
  });

  it("right after the click, before the site row has moved: publishing, started at the publish run's start", async () => {
    h.publishRuns = [publishRun({ status: "active", created_at: "2026-10-02T05:00:00+00:00" })];
    const r = await status();
    expect(r.body.site.status).toBe("building");
    expect(r.body.app_ready).toBe(true);
    expect(r.body.publish).toEqual({ status: "publishing", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false });
    expect(r.body.run.status).toBe("done");
    expect(r.body.preview).toEqual({ url: PREVIEW, kind: "instant" });
  });

  it("while the site is publishing: publishing", async () => {
    sites({ status: "publishing", desired_sha: "abc1234", updated_at: "2026-10-02T05:00:07Z" });
    h.publishRuns = [publishRun({ status: "active", created_at: "2026-10-02T05:00:00+00:00" })];
    const r = await status();
    expect(r.body.app_ready).toBe(true);
    expect(r.body.publish).toEqual({ status: "publishing", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false });
  });

  it("the publish failed: failed with founder copy (never the check's raw text), not retryable through Continue, and the app stays ready", async () => {
    sites({ status: "building", last_error: GATE });
    h.publishRuns = [publishRun({ status: "failed", created_at: "2026-10-02T05:00:00+00:00", failure_class: "repair_exhausted", error: GATE })];
    const r = await status();
    expect(r.body.app_ready).toBe(true);
    expect(r.body.publish).toEqual({
      status: "failed",
      started_at: "2026-10-02T05:00:00.000Z",
      url: null,
      retryable: false,
      reason: BUILD_FIXES_EXHAUSTED,
    });
    expect(JSON.stringify(r.body)).not.toMatch(/smoke check|Evidence|journey/);
    expect(r.body.run.status).toBe("done");
    expect(r.body.run.failure).toBeNull();
    expect(r.body.preview).toEqual({ url: PREVIEW, kind: "instant" });
    expect(r.body.site.status).toBe("building");
  });

  it("the publish failed but the site row was left publishing: still failed, because the run is what failed", async () => {
    sites({ status: "publishing" });
    h.publishRuns = [publishRun({ status: "failed", error: "Site hosting is not configured." })];
    const r = await status();
    expect(r.body.publish).toEqual({ status: "failed", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false });
  });

  it("a failed publish with no recorded reason carries no reason key", async () => {
    h.publishRuns = [publishRun({ status: "failed" })];
    const r = await status();
    expect(r.body.publish).toEqual({ status: "failed", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false });
  });

  it("a retry after a failure: publishing again, with a started_at that differs from the failed attempt's", async () => {
    h.publishRuns = [
      publishRun({ id: "cr-old", status: "failed", created_at: "2026-10-02T05:00:00+00:00", error: GATE }),
      publishRun({ id: "cr-new", status: "active", created_at: "2026-10-02T05:09:30+00:00" }),
    ];
    const r = await status();
    expect(r.body.publish).toEqual({ status: "publishing", started_at: "2026-10-02T05:09:30.000Z", url: null, retryable: false });
    h.publishRuns[1].status = "failed";
    h.publishRuns[1].goal_graph[0].error = "Site hosting is not configured.";
    const again = await status();
    expect(again.body.publish).toEqual({ status: "failed", started_at: "2026-10-02T05:09:30.000Z", url: null, retryable: false });
  });

  it("published: live with the address, as before, and the publish run is not even read", async () => {
    sites({ status: "live", live_deploy_id: "d1", live_sha: "abc1234", live_url: "https://alpha.zaviagent.com", last_error: null });
    h.publishRuns = [publishRun({ status: "done" })];
    const r = await status();
    expect(r.body.publish).toEqual({ status: "live", started_at: null, url: "https://alpha.zaviagent.com", retryable: false });
    expect(r.body.app_ready).toBe(false);
    expect(r.body.target.live_url).toBe("https://alpha.zaviagent.com");
    expect(h.publishQueries).toEqual([]);
  });

  it("a live site whose later republish failed stays live", async () => {
    sites({ status: "live", live_deploy_id: "d1", live_sha: "abc1234", live_url: "https://alpha.zaviagent.com" });
    h.publishRuns = [publishRun({ status: "failed", error: GATE })];
    const r = await status();
    expect(r.body.publish.status).toBe("live");
  });

  it("reads only this tenant's newest publish run of this site", async () => {
    h.publishRuns = [
      publishRun({ id: "other-site", site_id: SB, status: "failed", created_at: "2026-10-02T06:00:00+00:00", error: "beta broke" }),
      publishRun({ id: "other-tenant", tenant_id: T2, status: "failed", created_at: "2026-10-02T07:00:00+00:00", error: "theirs" }),
      publishRun({ id: "an-edit", republish: null, status: "failed", created_at: "2026-10-02T08:00:00+00:00", error: "the edit failed" }),
    ];
    const r = await status();
    expect(r.body.publish).toEqual({ status: "none", started_at: null, url: null, retryable: false });
    expect(h.publishQueries).toHaveLength(1);
    const q = h.publishQueries[0];
    expect(q).toEqual(
      expect.arrayContaining([
        ["eq", ["tenant_id", T1]],
        ["eq", ["kind", "build_app"]],
        ["eq", [SITE_PATH, SA]],
        ["eq", [REPUBLISH_PATH, "true"]],
        ["order", ["created_at", { ascending: false }]],
        ["limit", [1]],
      ]),
    );

    const beta = await status(RB);
    expect(beta.body.publish).toMatchObject({ status: "failed" });
    expect(JSON.stringify(beta.body.publish)).not.toContain("beta broke");
  });

  it("a row that is not a publish of this site is ignored even if the database hands it back", async () => {
    const stray = publishRun({ id: "stray", site_id: SB, status: "failed", error: "beta broke" });
    h.publishRuns = [{ ...stray, goal_graph: [{ ...stray.goal_graph[0], payload: { ...(stray.goal_graph[0].payload as object), site_id: SA, republish: "true" } }] }];
    const edit = await status();
    expect(edit.body.publish.status).toBe("none");
  });

  it.each([
    ["an error answer", () => { h.publishQueryError = "statement timeout"; }],
    ["a throw", () => { h.publishQueryThrows = true; }],
  ])("when the publish run cannot be read (%s) the status still answers from the site row", async (_name, arm) => {
    arm();
    const building = await status();
    expect(building.statusCode).toBe(200);
    expect(building.body.publish).toEqual({ status: "none", started_at: null, url: null, retryable: false });
    sites({ status: "publishing", updated_at: "2026-10-02T05:00:07Z" });
    const publishing = await status();
    expect(publishing.statusCode).toBe(200);
    expect(publishing.body.app_ready).toBe(true);
    expect(publishing.body.publish).toEqual({ status: "publishing", started_at: "2026-10-02T05:00:07.000Z", url: null, retryable: false });
  });
});

describe("builds that are not publish-on-request are untouched", () => {
  it("a build with its own deploy step never reads a publish run, whatever its state", async () => {
    h.publishRuns = [publishRun({ status: "failed", error: GATE })];
    h.runs = [rootRun(RA, autoPublishGraph(SA, "pending"), "active")];
    const publishing = await status();
    expect(publishing.body.publish.status).toBe("publishing");

    h.runs = [{ ...rootRun(RA, autoPublishGraph(SA, "failed"), "paused"), failure_class: "deploy_failed" }];
    const paused = await status();
    expect(paused.body.publish.status).toBe("failed");
    expect(paused.body.publish.reason).toBeUndefined();

    sites({ status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com" });
    h.runs = [rootRun(RA, autoPublishGraph(SA, "done"), "done")];
    const live = await status();
    expect(live.body.publish).toMatchObject({ status: "live", url: "https://alpha.zaviagent.com" });
    expect(h.publishQueries).toEqual([]);
  });

  it("a build that is still running is not ready and reads no publish run", async () => {
    h.runs = [rootRun(RA, [{ status: "done", payload: { stage: "provision" } }, { status: "dispatched", payload: { stage: "build", site_id: SA } }], "active")];
    h.publishRuns = [publishRun({ status: "failed", error: GATE })];
    const r = await status();
    expect(r.body.app_ready).toBe(false);
    expect(r.body.publish).toEqual({ status: "none", started_at: null, url: null, retryable: false });
    expect(h.publishQueries).toEqual([]);
  });

  it("a hidden site reads no publish run", async () => {
    sites({ status: "deleted" });
    h.publishRuns = [publishRun({ status: "failed", error: GATE })];
    const r = await status();
    expect(r.body.app_ready).toBe(false);
    expect(h.publishQueries).toEqual([]);
  });
});

describe("a first publish that activated its deploy and then failed its check", () => {
  const NOT_SERVING = "The site was published but alpha.zaviagent.com is not serving it yet.";
  const activatedThenFailed = (over: Partial<SiteRow> = {}) =>
    sites({
      status: "building",
      desired_sha: "abc1234",
      live_sha: "abc1234",
      live_deploy_id: "d1",
      live_url: "https://alpha.zaviagent.com",
      last_error: NOT_SERVING,
      ...over,
    });

  it("reports the failed publish with its reason, never live, and agrees with the site's address", async () => {
    activatedThenFailed();
    h.publishRuns = [publishRun({ status: "failed", created_at: "2026-10-02T05:00:00+00:00", error: `${NOT_SERVING}\nEvidence: 404` })];
    const r = await status();
    expect(r.statusCode).toBe(200);
    expect(r.body.site).toMatchObject({ id: SA, status: "building", live_url: null });
    expect(r.body.target.live_url).toBeNull();
    expect(r.body.app_ready).toBe(true);
    expect(r.body.publish).toEqual({
      status: "failed",
      started_at: "2026-10-02T05:00:00.000Z",
      url: null,
      retryable: false,
    });
    expect(h.publishQueries).toHaveLength(1);
    expect(JSON.stringify(r.body.publish)).not.toContain("live");
  });

  it("Publish pressed again: publishing, started at the new attempt, never live", async () => {
    activatedThenFailed();
    h.publishRuns = [
      publishRun({ id: "cr-old", status: "failed", created_at: "2026-10-02T05:00:00+00:00", error: NOT_SERVING }),
      publishRun({ id: "cr-new", status: "active", created_at: "2026-10-02T05:09:30+00:00" }),
    ];
    const r = await status();
    expect(r.body.publish).toEqual({ status: "publishing", started_at: "2026-10-02T05:09:30.000Z", url: null, retryable: false });
  });

  it("the publish run cannot be read: still never live", async () => {
    activatedThenFailed();
    h.publishQueryError = "statement timeout";
    const r = await status();
    expect(r.statusCode).toBe(200);
    expect(r.body.publish.status).not.toBe("live");
    expect(r.body.publish.url).toBeNull();
    expect(r.body.site.live_url).toBeNull();
  });

  it.each(["paused", "waking"] as const)("a %s site that was live keeps reading as published", async (status_) => {
    activatedThenFailed({ status: status_, last_error: null });
    h.publishRuns = [publishRun({ status: "failed", error: NOT_SERVING })];
    const r = await status();
    expect(r.body.publish).toEqual({ status: "live", started_at: null, url: "https://alpha.zaviagent.com", retryable: false });
    expect(h.publishQueries).toEqual([]);
  });
});
