import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { fakeSiteStore, siteRow, T1, T2 } from "@/services/sites/__tests__/fake-site-store";
import type { UnpublishedChanges } from "@/services/sites/site-pending";
import type { SiteRow } from "@/services/sites/contract";

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  pendingChanges: null as UnpublishedChanges | null,
  resolveSite: vi.fn(async () => null),
  sessionRows: [] as Array<Record<string, unknown>>,
  sandboxes: [] as Array<Record<string, unknown>>,
  sandboxReads: [] as Array<{ tenant_id: string; repo: unknown }>,
  store: null as unknown,
  flags: {} as Record<string, boolean | Error>,
  flagReads: [] as Array<{ key: string; tenant_id: unknown }>,
  kick: null as unknown as (input: { tenant_id: string; node: { payload: { target: { github_full_name: string } } } }) => void,
  kicks: [] as Array<{ tenant_id: string; repo: string }>,
  configChecks: [] as string[],
  previewStatus: {} as Record<string, number>,
  leases: new Map<string, { kind: string; token: string }>(),
}));
vi.mock("@/services/sites/site-preview-lease", () => ({
  siteLeaseHeld: async (_t: string, site_id: string) => h.leases.get(site_id)?.kind ?? null,
  claimSiteLease: async (_t: string, site_id: string, kind: string) => {
    const cur = h.leases.get(site_id);
    if (cur) return { token: null, held: cur.kind };
    const token = `${kind}-${Math.random()}`;
    h.leases.set(site_id, { kind, token });
    return { token };
  },
  releaseSiteLease: async (_t: string, site_id: string, by: { token?: string; kind?: string }) => {
    const cur = h.leases.get(site_id);
    if (cur && (by.token ? cur.token === by.token : cur.kind === by.kind)) h.leases.delete(site_id);
  },
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string, tenant_id?: unknown) => {
      h.flagReads.push({ key, tenant_id });
      if (key in h.flags) {
        const v = h.flags[key];
        if (v instanceof Error) throw v;
        return v;
      }
      return (actual.getBoolSetting as (k: string, t?: unknown) => Promise<boolean>)(key, tenant_id);
    }),
  };
});
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u", access_token: "tok" }),
}));
vi.mock("@/services/sites/store", () => ({ siteStore: () => h.store }));
vi.mock("@/services/sites/site-pending", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/sites/site-pending")>();
  return { ...actual, loadUnpublishedSiteChanges: (...args: Parameters<typeof actual.loadUnpublishedSiteChanges>) => h.pendingChanges ? Promise.resolve(h.pendingChanges) : actual.loadUnpublishedSiteChanges(...args) };
});
vi.mock("@/services/sites/sandbox-resolver", () => ({ createSiteSandboxResolver: () => ({ forSite: h.resolveSite }) }));

vi.mock("@/services/agents/conductor-driver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/agents/conductor-driver")>();
  return { ...actual, kickSandboxPreview: (input: Parameters<typeof h.kick>[0]) => h.kick(input) };
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

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      if (table === "conductor_runs") {
        return chain((calls) => {
          const sel = String(calls.find(([m]) => m === "select")?.[1][0] ?? "");
          if (sel.includes("refine_mode:goal_graph")) return { data: h.sessionRows, error: null };
          const siteEq = calls.find(([m, a]) => m === "eq" && a[0] === "goal_graph->0->payload->>site_id")?.[1][1];
          if (siteEq !== undefined) {
            const statuses = (calls.find(([m, a]) => m === "in" && a[0] === "status")?.[1][1] ?? []) as string[];
            const hit = h.runs.filter(
              (r) =>
                statuses.includes(String(r.status)) &&
                (r.goal_graph as Array<{ payload?: { site_id?: unknown } }>)[0]?.payload?.site_id === siteEq,
            );
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          }
          const id = calls.find(([m, a]) => m === "eq" && a[0] === "id")?.[1][1];
          const rows = id ? h.runs.filter((r) => r.id === id) : h.runs;
          return { data: rows, error: null };
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
        h.sandboxReads.push({ tenant_id, repo });
        return { data: h.sandboxes.find((s) => s.tenant_id === tenant_id && s.repo_full_name === repo) ?? null, error: null };
      }),
  }),
}));

import { getAutopilotBuildSessions, getAutopilotBuildStatus, shouldWakeSitePreview } from "../autopilot";
import { __resetPublishPreviewKicks, PUBLISH_PREVIEW_KICK_TTL_MS } from "@/services/build/app-ready";

const SA = "aaaaaaaa-0000-4000-8000-000000000001";
const SB = "bbbbbbbb-0000-4000-8000-000000000002";
const RA = "a0000000-0000-4000-8000-00000000000a";
const RB = "b0000000-0000-4000-8000-00000000000b";

let seq = 0;
let previewUrl = "";

const unpublishedGraph = (site_id: string) => [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id, fast_single_pass: true } },
];

function run(id: string, site_id: string, status: string) {
  return { id, objective: "Build product: Alpha — a", status, goal_graph: unpublishedGraph(site_id), spend_usd: 0, max_usd: 10, created_at: "2026-09-30T01:00:00Z", updated_at: "2026-09-30T01:00:00Z" };
}

function res() {
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
  return r;
}

async function status(run_id: string) {
  const r = res();
  await getAutopilotBuildStatus({ query: { run_id } } as never, r as never);
  return r;
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function sites(over: Partial<SiteRow> = {}) {
  h.store = fakeSiteStore([
    siteRow({ id: SA, label: "alpha", root_conductor_run_id: RA, status: "building", ...over }),
    siteRow({ id: SB, label: "beta", root_conductor_run_id: RB, status: "building" }),
    siteRow({ id: "cccccccc-0000-4000-8000-000000000003", tenant_id: T2, label: "alpha", root_conductor_run_id: "c0000000-0000-4000-8000-00000000000c", status: "building" }),
  ]).store;
}

beforeAll(async () => {
  await import("@/services/agents/conductor-driver");
});

beforeEach(() => {
  seq += 1;
  previewUrl = `https://5173-sbx${seq}.e2b.app`;
  __resetPublishPreviewKicks();
  h.flags = {};
  h.pendingChanges = null;
  h.resolveSite.mockClear();
  h.flagReads = [];
  h.kicks = [];
  h.sandboxReads = [];
  h.configChecks = [];
  h.kick = (input) => {
    if ((input as { onlyIfAnswering?: boolean }).onlyIfAnswering) {
      h.configChecks.push(input.node.payload.target.github_full_name);
      return;
    }
    h.kicks.push({ tenant_id: input.tenant_id, repo: input.node.payload.target.github_full_name });
  };
  h.sessionRows = [];
  sites();
  h.runs = [run(RA, SA, "done"), run(RB, SB, "done")];
  h.sandboxes = [
    { id: "row-a", tenant_id: T1, repo_full_name: "Praxis-build/alpha", preview_url: previewUrl, preview_status: "live" },
    { id: "row-b", tenant_id: T1, repo_full_name: "Praxis-build/beta", preview_url: `${previewUrl}-b`, preview_status: "live" },
    { id: "row-foreign", tenant_id: T2, repo_full_name: "Praxis-build/alpha", preview_url: `${previewUrl}-t2`, preview_status: "live" },
  ];
  h.previewStatus = { [previewUrl]: 502 };
  vi.stubGlobal("fetch", async (url: string) => ({
    status: h.previewStatus[String(url)] ?? 502,
    text: async () => "<html></html>",
    headers: new Headers({ "content-type": "text/html" }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("build-status wakes the sleeping preview of a finished, unpublished site", () => {
  it("a finished build whose sandbox went to sleep: one wake for this tenant's own repo, and the poll still answers", async () => {
    const r = await status(RA);
    expect(r.statusCode).toBe(200);
    expect(r.body.preview).toEqual({ url: null, kind: "none" });
    expect(r.body.site).toMatchObject({ id: SA, status: "building", live_url: null });
    await settle();
    expect(h.kicks).toEqual([{ tenant_id: T1, repo: "Praxis-build/alpha" }]);
    expect(h.sandboxReads.every((x) => x.tenant_id === T1)).toBe(true);
  });

  it("a site wake boots the site's own preview, with the click-to-edit picker", async () => {
    const seen: unknown[] = [];
    h.kick = (input) => {
      seen.push((input as { site?: unknown }).site);
    };
    await status(RA);
    await settle();
    expect(seen).toEqual([true]);
  });

  it("a preview already marked dead is woken too, and that poll says starting", async () => {
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "dead", preview_url: null };
    expect((await status(RA)).body.preview_state).toBe("starting");
    await settle();
    expect(h.kicks).toEqual([{ tenant_id: T1, repo: "Praxis-build/alpha" }]);
  });

  it("polls inside the same minute wake the sandbox once, not once per poll", async () => {
    for (let i = 0; i < 5; i++) await status(RA);
    await settle();
    expect(h.kicks).toHaveLength(1);
  });

  it("wakes again once the minute has passed and the preview is still dead", async () => {
    const now = vi.spyOn(Date, "now");
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    await status(RA);
    now.mockReturnValue(t0 + PUBLISH_PREVIEW_KICK_TTL_MS - 1);
    await status(RA);
    await settle();
    expect(h.kicks).toHaveLength(1);
    now.mockReturnValue(t0 + PUBLISH_PREVIEW_KICK_TTL_MS + 1);
    await status(RA);
    await settle();
    expect(h.kicks).toHaveLength(2);
  });

  it("two unpublished sites in one workspace are woken separately, each for its own repo", async () => {
    h.previewStatus[`${previewUrl}-b`] = 502;
    await status(RA);
    await status(RB);
    await settle();
    expect(h.kicks).toEqual([
      { tenant_id: T1, repo: "Praxis-build/alpha" },
      { tenant_id: T1, repo: "Praxis-build/beta" },
    ]);
  });

  it("a wake that throws never breaks or delays the status answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.kick = () => {
      throw new Error("e2b down");
    };
    const r = await status(RA);
    expect(r.statusCode).toBe(200);
    expect(r.body.run.id).toBe(RA);
    await settle();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("site preview wake failed"))).toBe(true);
  });

  it("the answer does not wait for the wake", async () => {
    let woke = false;
    h.kick = () => {
      woke = true;
    };
    const r = await status(RA);
    expect(r.body.preview.kind).toBe("none");
    expect(woke).toBe(false);
    await settle();
    expect(woke).toBe(true);
  });

  it("a preview that answers is never woken or restarted, only checked once for an older runtime config", async () => {
    h.previewStatus[previewUrl] = 200;
    const r = await status(RA);
    expect(r.body.preview).toEqual({ url: previewUrl, kind: "instant" });
    await settle();
    expect(h.kicks).toEqual([]);
    await vi.waitFor(() => expect(h.configChecks).toEqual(["Praxis-build/alpha"]), { timeout: 15_000 });
  });

  it("a preview that is already starting is not started twice", async () => {
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "starting", preview_url: null };
    await status(RA);
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it("a site with no sandbox row has nothing to wake", async () => {
    h.sandboxes = h.sandboxes.filter((s) => s.id !== "row-a");
    await status(RA);
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it.each(["active", "provisioning", "paused", "failed"])("a %s build is not woken (the build owns its preview)", async (runStatus) => {
    h.runs = [run(RA, SA, runStatus)];
    await status(RA);
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it("a published site previews its own address and never wakes a sandbox", async () => {
    sites({ status: "live", live_deploy_id: "d1", live_sha: "abc1234", live_url: "https://alpha.zaviagent.com" });
    vi.stubGlobal("fetch", async () => ({ status: 200, text: async () => "", headers: new Headers({ "x-zavi-deploy-id": "d1" }) }));
    const r = await status(RA);
    expect(r.body.preview).toEqual({ url: "https://alpha.zaviagent.com", kind: "final" });
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it.each(["failed", "publishing", "provisioning"] as const)("a %s site is not woken", async (siteStatus) => {
    sites({ status: siteStatus });
    await status(RA);
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it.each(["deleting", "deleted", "fell_back_old"] as const)("a %s site is never woken", async (siteStatus) => {
    sites({ status: siteStatus });
    await status(RA);
    await settle();
    expect(h.kicks).toEqual([]);
  });
});

describe("a live site's waiting preview leaves an active edit alone", () => {
  it("never resolves or wakes the sandbox while another edit on that site owns it", async () => {
    sites({ status: "live", live_deploy_id: "d1", live_sha: "abc1234", live_url: "https://alpha.zaviagent.com" });
    h.pendingChanges = { changes: [{ id: "prior-edit", kind: "edit", at: "2026-10-02T10:00:00Z", message: "Change the hero" }], capped: false };
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "dead", preview_url: null };
    h.runs.push({ ...run("e0000000-0000-4000-8000-00000000000e", SA, "active"), goal_graph: [{ status: "pending", payload: { stage: "build", refine_mode: true, site_id: SA } }] });
    await status(RA);
    await settle();
    expect(h.resolveSite).not.toHaveBeenCalled();
    expect(h.kicks).toEqual([]);
  });

  it("still wakes that site's waiting preview when the active edit belongs to another site", async () => {
    sites({ status: "live", live_deploy_id: "d1", live_sha: "abc1234", live_url: "https://alpha.zaviagent.com" });
    h.pendingChanges = { changes: [{ id: "prior-edit", kind: "edit", at: "2026-10-02T10:00:00Z", message: "Change the hero" }], capped: false };
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "dead", preview_url: null };
    h.runs.push({ ...run("e0000000-0000-4000-8000-00000000000e", SB, "active"), goal_graph: [{ status: "pending", payload: { stage: "build", refine_mode: true, site_id: SB } }] });
    await status(RA);
    await settle();
    expect(h.resolveSite).toHaveBeenCalledWith(T1, SA);
    expect(h.kicks).toEqual([{ tenant_id: T1, repo: "Praxis-build/alpha" }]);
  });
});

describe("shouldWakeSitePreview", () => {
  const base = () => ({
    site: siteRow({ id: SA, label: "alpha", status: "building" }),
    run_status: "done" as unknown,
    preview_kind: "none" as "none" | "instant" | "final",
    sandbox: { preview_status: "live" as string | null } as { preview_status: string | null } | null,
  });

  it("wakes only a finished, unpublished, building site with a dead preview and a sandbox row", () => {
    expect(shouldWakeSitePreview(base())).toBe(true);
    expect(shouldWakeSitePreview({ ...base(), sandbox: { preview_status: "dead" } })).toBe(true);
    expect(shouldWakeSitePreview({ ...base(), sandbox: { preview_status: null } })).toBe(true);
    expect(shouldWakeSitePreview({ ...base(), run_status: "active" })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), run_status: undefined })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), preview_kind: "instant" })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), preview_kind: "final" })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), sandbox: null })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), sandbox: { preview_status: "starting" } })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), site: siteRow({ id: SA, status: "building", github_full_name: null }) })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), site: siteRow({ id: SA, status: "building", live_deploy_id: "d1" }) })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), site: siteRow({ id: SA, status: "failed" }) })).toBe(false);
  });

  it("a live site with changes waiting for Publish wakes its sandbox unless the preview already answers", () => {
    const live = siteRow({ id: SA, status: "live", live_deploy_id: "d1" });
    expect(shouldWakeSitePreview({ ...base(), site: live, preview_kind: "final", unpublished: true })).toBe(true);
    expect(shouldWakeSitePreview({ ...base(), site: live, preview_kind: "instant", unpublished: true })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), site: live, preview_kind: "final", unpublished: false })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), site: live, preview_kind: "final", unpublished: true, sandbox: null })).toBe(true);
    expect(shouldWakeSitePreview({ ...base(), site: live, preview_kind: "final", unpublished: true, sandbox: { preview_status: "starting" } })).toBe(false);
    expect(shouldWakeSitePreview({ ...base(), site: live, preview_kind: "final", unpublished: true, run_status: "active" })).toBe(false);
  });
});

describe("build-sessions tells the web whether a build publishes on request", () => {
  async function sessions() {
    const r = res();
    await getAutopilotBuildSessions({ query: {} } as never, r as never);
    return r;
  }

  it("is on by default and is read for the auth tenant", async () => {
    const r = await sessions();
    expect(r.statusCode).toBe(200);
    expect(r.body.ui_flags.publish_on_request).toBe(true);
    expect(h.flagReads.filter((x) => x.key === "build_publish_on_request")).toEqual([{ key: "build_publish_on_request", tenant_id: T1 }]);
  });

  it("follows the tenant's setting when it is off, without moving the other flags", async () => {
    h.flags = { build_publish_on_request: false, build_publish_waits_for_app: true };
    const r = await sessions();
    expect(r.body.ui_flags.publish_on_request).toBe(false);
    expect(r.body.ui_flags.publish_waits_for_app).toBe(true);
  });

  it("is independent of publish_waits_for_app", async () => {
    h.flags = { build_publish_on_request: true, build_publish_waits_for_app: false };
    const r = await sessions();
    expect(r.body.ui_flags.publish_on_request).toBe(true);
    expect(r.body.ui_flags.publish_waits_for_app).toBe(false);
  });

  it("an unreadable setting answers with the registry default instead of failing the list", async () => {
    h.flags = { build_publish_on_request: new Error("settings down") };
    const r = await sessions();
    expect(r.statusCode).toBe(200);
    expect(r.body.ui_flags.publish_on_request).toBe(true);
  });
});

describe("build-status tells the pane when a finished build's preview is gone", () => {
  beforeEach(() => h.leases.clear());
  const holdRestart = (site_id: string) => h.leases.set(site_id, { kind: "restart", token: "r" });

  it("a finished build whose preview just went down says starting on the poll that wakes it", async () => {
    const r = await status(RA);
    expect(r.body.preview).toEqual({ url: null, kind: "none" });
    expect(r.body.preview_state).toBe("starting");
    await settle();
    expect(h.kicks).toHaveLength(1);
  });

  it("a preview whose probe fails inside the dead grace still says starting on a later poll that does not wake", async () => {
    await status(RA);
    const r = await status(RA);
    expect(r.body.preview_state).toBe("starting");
    await settle();
    expect(h.kicks).toHaveLength(1);
  });

  it("a sandbox row marked starting says starting and is not woken again", async () => {
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "starting", preview_url: null };
    const r = await status(RA);
    expect(r.body.preview_state).toBe("starting");
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it("a sandbox left starting long ago (a boot that never served) says stopped so Restart is offered", async () => {
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "starting", preview_url: null, updated_at: new Date(Date.now() - 6 * 60_000).toISOString() };
    expect((await status(RA)).body.preview_state).toBe("stopped");
    h.sandboxes[0] = { ...h.sandboxes[0], updated_at: new Date(Date.now() - 60_000).toISOString() };
    expect((await status(RA)).body.preview_state).toBe("starting");
  });

  it("a dead preview already woken this minute says stopped", async () => {
    await status(RA);
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "dead", preview_url: null };
    const r = await status(RA);
    expect(r.body.preview_state).toBe("stopped");
  });

  it("an edit running on this site says starting and leaves the sandbox to it", async () => {
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "dead", preview_url: null };
    h.runs.push({ ...run("e0000000-0000-4000-8000-00000000000e", SA, "active"), goal_graph: [{ status: "pending", payload: { stage: "build", refine_mode: true, site_id: SA } }] });
    const r = await status(RA);
    expect(r.body.preview_state).toBe("starting");
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it("an edit running on another site does not hold this one", async () => {
    h.sandboxes[0] = { ...h.sandboxes[0], preview_status: "dead", preview_url: null };
    h.runs.push({ ...run("e0000000-0000-4000-8000-00000000000e", SB, "active"), goal_graph: [{ status: "pending", payload: { stage: "build", refine_mode: true, site_id: SB } }] });
    await status(RA);
    const r = await status(RA);
    expect(r.body.preview_state).toBe("stopped");
  });

  it("a site whose sandbox is gone says stopped and has nothing to wake", async () => {
    h.sandboxes = h.sandboxes.filter((s) => s.id !== "row-a");
    const r = await status(RA);
    expect(r.body.preview_state).toBe("stopped");
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it("while a restart is under way (its lease, held by any container) it says starting and leaves the sandbox to the restart", async () => {
    holdRestart(SA);
    const r = await status(RA);
    expect(r.body.preview_state).toBe("starting");
    await settle();
    expect(h.kicks).toEqual([]);
  });

  it("a preview that answers carries no state, and ends the restart", async () => {
    holdRestart(SA);
    h.previewStatus[previewUrl] = 200;
    const r = await status(RA);
    expect(r.body.preview.kind).toBe("instant");
    expect(r.body).not.toHaveProperty("preview_state");
    await settle();
    expect(h.leases.has(SA)).toBe(false);
  });

  it("a wake takes the site lease while it resumes the box and gives it back", async () => {
    const r = await status(RA);
    expect(r.body.preview_state).toBe("starting");
    await settle();
    expect(h.kicks).toHaveLength(1);
    expect(h.leases.has(SA)).toBe(false);
  });

  it("a running build carries no state", async () => {
    h.runs = [run(RA, SA, "active")];
    expect((await status(RA)).body).not.toHaveProperty("preview_state");
  });

  it("a published site carries no state", async () => {
    sites({ status: "live", live_deploy_id: "d1", live_sha: "abc1234", live_url: "https://alpha.zaviagent.com" });
    vi.stubGlobal("fetch", async () => ({ status: 200, text: async () => "", headers: new Headers({ "x-zavi-deploy-id": "d1" }) }));
    expect((await status(RA)).body).not.toHaveProperty("preview_state");
  });
});

describe("build-sessions tells the web whether the Figma frame row shows", () => {
  async function sessions() {
    const r = res();
    await getAutopilotBuildSessions({ query: {} } as never, r as never);
    return r;
  }

  it("reads build_figma_handoff for the auth tenant and follows it off", async () => {
    const on = await sessions();
    expect(on.body.ui_flags.figma_handoff).toBe(true);
    expect(h.flagReads.filter((x) => x.key === "build_figma_handoff")).toEqual([{ key: "build_figma_handoff", tenant_id: T1 }]);
    h.flags = { build_figma_handoff: false };
    const off = await sessions();
    expect(off.body.ui_flags.figma_handoff).toBe(false);
    expect(off.body.ui_flags.publish_on_request).toBe(true);
  });
});
