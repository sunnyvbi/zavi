import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSb } from "@/services/agents/__tests__/fake-sb";
import { fakeSiteStore, siteRow, T1 } from "@/services/sites/__tests__/fake-site-store";
import { siteRepublishGraph } from "@/services/agents/refine-product";
import type { SiteRow } from "@/services/sites/contract";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  send: vi.fn(async (_a: { siteName: string; liveUrl: string; admin?: unknown }) => ({ sent: true })),
  flags: { away: true, owner: false } as Record<string, boolean>,
  markers: new Map<string, string>(),
  invite: vi.fn(async () => ({ token: "tok", invite: { id: "inv-1" } })),
  activate: vi.fn(async () => undefined),
  signup: vi.fn(async () => true),
}));
vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => fakeSb(h.tables),
  asTenantId: (t: string) => t,
  consumeTenantRateLimit: vi.fn(async () => true),
  stampTenantMarker: vi.fn(async (t: string, b: string, at: Date) => {
    h.markers.set(`${t}:${b}`, at.toISOString());
  }),
  tenantMarkerAt: vi.fn(async (t: string, b: string) => {
    const v = h.markers.get(`${t}:${b}`);
    return v ? Date.parse(v) : null;
  }),
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sendBuildLiveEmail: h.send,
  resolveTenantOwnerEmail: async () => "founder@example.test",
}));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.zaviagent.com" }));
vi.mock("@/services/website/site-signup", () => ({ siteHasSignupPage: h.signup }));
vi.mock("@/services/website/app-invites", () => ({
  createOwnerAdminInvite: h.invite,
  activateAppInvite: h.activate,
  hasOwnerAdminInvite: async () => false,
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string) => {
    if (key === "build_live_email_only_if_away") return h.flags.away;
    if (key === "build_auto_site_owner") return h.flags.owner;
    return false;
  }),
}));

import { maybeSendBuildLiveEmail } from "../build-live-email";
import { recordBuildWatch, founderWatchingBuild, BUILD_WATCH_FRESH_MS } from "../build-watch";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const verified = "2026-10-01T01:00:00Z";
const deploy = (site_id?: string) => ({
  id: "d",
  status: "done",
  hosting_verified_at: verified,
  payload: { stage: "deploy", ...(site_id ? { site_id } : {}) },
});

function seed() {
  h.tables = {
    conductor_runs: [
      { id: "run-a", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Alpha — x", goal_graph: [{ payload: { stage: "provision", site_id: A } }, deploy(A)] },
      {
        id: "edit-a",
        tenant_id: T1,
        kind: "build_app",
        status: "done",
        objective: "[refine] change the headline",
        goal_graph: [{ status: "done", payload: { stage: "build", refine_mode: true, fast_edit: true, small_edit: true, site_id: A } }, deploy(A)],
      },
      { id: "rerun-a", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Alpha — x", goal_graph: [{ payload: { stage: "provision", site_id: A } }, deploy(A)] },
      { id: "run-b", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Beta — y", goal_graph: [{ payload: { stage: "provision", site_id: B } }, deploy(B)] },
      { id: "old-run", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Oldie — z", goal_graph: [{ payload: { stage: "build" } }, deploy()] },
      { id: "old-edit", tenant_id: T1, kind: "build_app", status: "done", objective: "[refine] tweak", goal_graph: [{ payload: { stage: "build", refine_mode: true } }, deploy()] },
    ],
    tenant_resources: [{ tenant_id: T1, resource_kind: "hosting", status: "ready", external_ref: { url: "https://oldie.onrender.com" } }],
    tenants: [{ id: T1, display_name: "Acme" }],
  };
}

function site() {
  return siteRow({ id: A, label: "alpha", root_conductor_run_id: "run-a", status: "live", live_deploy_id: "d1", live_url: "https://alpha.zaviagent.com", owner_email: null });
}

function siteB() {
  return siteRow({ id: B, label: "beta", root_conductor_run_id: "run-b", status: "live", live_deploy_id: "d2", live_url: "https://beta.zaviagent.com", owner_email: null });
}

function onceLedger() {
  const claimed = new Set<string>();
  const claimSiteEmail = vi.fn(async (tenant_id: string, site_id: string) => {
    const key = `${tenant_id}:${site_id}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });
  const releaseSiteEmail = vi.fn(async (tenant_id: string, site_id: string) => {
    claimed.delete(`${tenant_id}:${site_id}`);
  });
  return { claimSiteEmail, releaseSiteEmail };
}

const away = async () => false;
const watchingNow = async () => true;

describe("build_live_email_only_if_away", () => {
  beforeEach(() => {
    h.send.mockReset();
    h.send.mockImplementation(async () => ({ sent: true }));
    h.invite.mockClear();
    h.activate.mockClear();
    h.flags = { away: true, owner: false };
    h.markers.clear();
    seed();
  });

  it("a site going live for the first time while the founder is away is emailed once", async () => {
    const { store } = fakeSiteStore([site()]);
    const ledger = onceLedger();
    const r = await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger });
    expect(r).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0].liveUrl).toBe("https://alpha.zaviagent.com");
    expect(ledger.claimSiteEmail).toHaveBeenCalledWith(T1, A);
  });

  it("a one-minute small edit on a live site never emails, and never spends the site's one email", async () => {
    const { store } = fakeSiteStore([site()]);
    const ledger = onceLedger();
    for (let i = 0; i < 5; i++) {
      expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "edit-a" }, { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(ledger.claimSiteEmail).not.toHaveBeenCalled();
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger })).toEqual({ sent: true });
  });

  it("an undo republish never emails", async () => {
    h.tables.conductor_runs.push({
      id: "undo-a",
      tenant_id: T1,
      kind: "build_app",
      status: "done",
      objective: "[refine] republish alpha.zaviagent.com",
      goal_graph: siteRepublishGraph(site(), "abcdef1").map((n) => ({ ...n, status: "done", hosting_verified_at: verified })),
    });
    const { store } = fakeSiteStore([site()]);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "undo-a" }, { store, watching: away, ...onceLedger() })).toEqual({ sent: false, reason: "edit" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a watched go-live spends no claim, so a later finished run of that site while away still emails", async () => {
    const { store } = fakeSiteStore([site()]);
    const ledger = onceLedger();
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: watchingNow, ...ledger })).toEqual({ sent: false, reason: "watching" });
    expect(ledger.claimSiteEmail).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "already_sent" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a send that reports nothing sent releases the claim, so a later attempt sends", async () => {
    const { store } = fakeSiteStore([site()]);
    const ledger = onceLedger();
    h.send.mockResolvedValueOnce({ sent: false });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "no_owner_email" });
    expect(ledger.releaseSiteEmail).toHaveBeenCalledWith(T1, A);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("a send that throws releases the claim and reports error, so a later attempt sends", async () => {
    const { store } = fakeSiteStore([site()]);
    const ledger = onceLedger();
    h.send.mockRejectedValueOnce(new Error("sendgrid 503"));
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "error" });
    expect(ledger.releaseSiteEmail).toHaveBeenCalledWith(T1, A);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("watching is per build session: the founder watching site A does not suppress site B going live", async () => {
    const { store } = fakeSiteStore([site(), siteB()]);
    const ledger = onceLedger();
    const watching = vi.fn(async (_t: string, sessionId: string) => sessionId === "run-a");
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-b" }, { store, watching, ...ledger })).toEqual({ sent: true });
    expect(watching).toHaveBeenCalledWith(T1, "run-b");
    expect(h.send.mock.calls[0][0].liveUrl).toBe("https://beta.zaviagent.com");
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching, ...ledger })).toEqual({ sent: false, reason: "watching" });
    expect(watching).toHaveBeenLastCalledWith(T1, "run-a");
  });

  it("a later non-refine run of a site is watched under the site's root session, not its own run id", async () => {
    const { store } = fakeSiteStore([site()]);
    await recordBuildWatch(T1, "run-a", new Date(Date.now() - 5_000));
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "rerun-a" }, { store, ...onceLedger() })).toEqual({ sent: false, reason: "watching" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a site with no root run is watched under the finishing run's own id", async () => {
    const { store } = fakeSiteStore([{ ...site(), root_conductor_run_id: null }]);
    const watching = vi.fn(async () => true);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching, ...onceLedger() })).toEqual({ sent: false, reason: "watching" });
    expect(watching).toHaveBeenCalledWith(T1, "run-a");
  });

  it("two completions of the same site build race and only one email goes out", async () => {
    const { store } = fakeSiteStore([site()]);
    const ledger = onceLedger();
    const results = await Promise.all([
      maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger }),
      maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, watching: away, ...ledger }),
    ]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.reason === "already_sent")).toHaveLength(1);
    expect(ledger.releaseSiteEmail).not.toHaveBeenCalled();
  });

  it("uses the real watch ping: a ping 90s before the build finishes suppresses the email, one 3 minutes before does not", async () => {
    const { store } = fakeSiteStore([site()]);
    await recordBuildWatch(T1, "run-a", new Date(Date.now() - 90_000));
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, ...onceLedger() })).toEqual({ sent: false, reason: "watching" });
    await recordBuildWatch(T1, "run-a", new Date(Date.now() - 3 * 60_000));
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, ...onceLedger() })).toEqual({ sent: true });
  });

  it("uses the real watch ping: a fresh ping on another build session does not suppress this site's email", async () => {
    const { store } = fakeSiteStore([site(), siteB()]);
    await recordBuildWatch(T1, "run-a", new Date(Date.now() - 5_000));
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-b" }, { store, ...onceLedger() })).toEqual({ sent: true });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "run-a" }, { store, ...onceLedger() })).toEqual({ sent: false, reason: "watching" });
  });

  it("old flow: a refine never emails, a first build emails only when away", async () => {
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "old-edit" }, { watching: away })).toEqual({ sent: false, reason: "edit" });
    const watched = vi.fn(watchingNow);
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "old-run" }, { watching: watched })).toEqual({ sent: false, reason: "watching" });
    expect(watched).toHaveBeenCalledWith(T1, "old-run");
    expect(h.send).not.toHaveBeenCalled();
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "old-run" }, { watching: away })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("old flow: a watched first build still sends when the email carries the owner admin login", async () => {
    h.flags.owner = true;
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "old-run" }, { watching: watchingNow })).toEqual({ sent: true });
    expect(h.send.mock.calls[0][0].admin).toBeTruthy();
    expect(h.activate).toHaveBeenCalledTimes(1);
  });

  it("with the key off every finished edit emails, as before", async () => {
    h.flags.away = false;
    const { store } = fakeSiteStore([site()]);
    const ledger = onceLedger();
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "edit-a" }, { store, watching: watchingNow, ...ledger })).toEqual({ sent: true });
    expect(await maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: "old-edit" }, { watching: watchingNow })).toEqual({ sent: true });
    expect(ledger.claimSiteEmail).not.toHaveBeenCalled();
  });
});

describe("the first publish from the Publish button (build_publish_on_request)", () => {
  const P = "dddddddd-0000-4000-8000-000000000004";
  const siteP = (over: Partial<SiteRow> = {}) =>
    siteRow({ id: P, label: "pearl", root_conductor_run_id: "run-p", status: "live", live_sha: "abcdef1", live_deploy_id: "dp1", live_url: "https://pearl.zaviagent.com", owner_email: null, ...over });
  const previewRoot = [
    { id: "p", status: "done", payload: { stage: "provision", site_id: P } },
    { id: "b", status: "done", payload: { stage: "build", fast_single_pass: true, site_id: P } },
  ];
  const publishRun = (id: string, sha: string) => ({
    id,
    tenant_id: T1,
    kind: "build_app",
    status: "done",
    objective: "[refine] republish pearl.zaviagent.com",
    goal_graph: siteRepublishGraph(siteP(), sha).map((n) => ({ ...n, status: "done", hosting_verified_at: verified })),
  });
  const send = (id: string, deps: Parameters<typeof maybeSendBuildLiveEmail>[1]) => maybeSendBuildLiveEmail({ tenant_id: T1, conductor_run_id: id }, deps);

  beforeEach(() => {
    h.send.mockReset();
    h.send.mockImplementation(async () => ({ sent: true }));
    h.flags = { away: true, owner: false };
    h.markers.clear();
    seed();
    h.tables.conductor_runs.push(
      { id: "run-p", tenant_id: T1, kind: "build_app", status: "done", objective: "Build product: Pearl — a jewellery shop", goal_graph: previewRoot },
      publishRun("pub-1", "abcdef1"),
      publishRun("pub-2", "abcdef2"),
      publishRun("undo-p", "abcdef3"),
      {
        id: "edit-p",
        tenant_id: T1,
        kind: "build_app",
        status: "done",
        objective: "[refine] change the headline",
        goal_graph: [{ id: "e", status: "done", payload: { stage: "build", refine_mode: true, site_id: P } }, deploy(P)],
      },
    );
  });

  it("the build that ended at its preview sends nothing and spends nothing", async () => {
    const { store } = fakeSiteStore([siteP({ status: "building", live_sha: null, live_deploy_id: null, live_url: null })]);
    const ledger = onceLedger();
    expect(await send("run-p", { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "not_deployed" });
    expect(ledger.claimSiteEmail).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("the first publish emails once, at the site's own address; a second publish, an edit and an undo republish send nothing", async () => {
    const { store } = fakeSiteStore([siteP()]);
    const ledger = onceLedger();
    const watching = vi.fn(away);
    expect(await send("pub-1", { store, watching, ...ledger })).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][0]).toMatchObject({ siteName: "Pearl", liveUrl: "https://pearl.zaviagent.com" });
    expect(watching).toHaveBeenCalledWith(T1, "run-p");
    for (const later of ["pub-2", "edit-p", "undo-p", "pub-1"]) {
      expect(await send(later, { store, watching, ...ledger })).toEqual({ sent: false, reason: "edit" });
    }
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(ledger.releaseSiteEmail).not.toHaveBeenCalled();
  });

  it("a watched first publish sends nothing and is still the site's one go-live: publishing again while away does not email", async () => {
    const { store } = fakeSiteStore([siteP()]);
    const ledger = onceLedger();
    expect(await send("pub-1", { store, watching: watchingNow, ...ledger })).toEqual({ sent: false, reason: "watching" });
    expect(ledger.claimSiteEmail).toHaveBeenCalledTimes(1);
    expect(ledger.releaseSiteEmail).not.toHaveBeenCalled();
    for (const later of ["pub-2", "edit-p", "undo-p"]) {
      expect(await send(later, { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it("two publishes finishing at once send one email between them", async () => {
    const { store } = fakeSiteStore([siteP()]);
    const ledger = onceLedger();
    const results = await Promise.all([
      send("pub-1", { store, watching: away, ...ledger }),
      send("pub-2", { store, watching: away, ...ledger }),
    ]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(results.filter((r) => r.reason === "edit")).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a first publish whose send fails gives the claim back, so the next publish is the one that emails", async () => {
    const { store } = fakeSiteStore([siteP()]);
    const ledger = onceLedger();
    h.send.mockRejectedValueOnce(new Error("sendgrid 503"));
    expect(await send("pub-1", { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "error" });
    expect(ledger.releaseSiteEmail).toHaveBeenCalledWith(T1, P);
    expect(await send("pub-2", { store, watching: away, ...ledger })).toEqual({ sent: true });
    expect(await send("undo-p", { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("a root build whose own deploy never completed counts as never published: the first publish emails once", async () => {
    const root = h.tables.conductor_runs.find((r) => r.id === "run-p")!;
    root.goal_graph = [...previewRoot, { id: "d", status: "failed", payload: { stage: "deploy", site_id: P } }];
    root.status = "paused";
    const { store } = fakeSiteStore([siteP()]);
    const ledger = onceLedger();
    expect(await send("pub-1", { store, watching: away, ...ledger })).toEqual({ sent: true });
    expect(await send("pub-2", { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("a site whose root build published itself never treats a republish as a first publish, and its one email is not spent", async () => {
    const root = h.tables.conductor_runs.find((r) => r.id === "run-p")!;
    root.goal_graph = [...previewRoot, deploy(P)];
    const { store } = fakeSiteStore([siteP()]);
    const ledger = onceLedger();
    for (const id of ["pub-1", "edit-p", "undo-p"]) {
      expect(await send(id, { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    }
    expect(ledger.claimSiteEmail).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a root build that cannot be found, or a site with no root, is never a first publish", async () => {
    const ledger = onceLedger();
    const orphan = fakeSiteStore([siteP({ root_conductor_run_id: "run-gone" })]).store;
    expect(await send("pub-1", { store: orphan, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    const rootless = fakeSiteStore([siteP({ root_conductor_run_id: null })]).store;
    expect(await send("pub-1", { store: rootless, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    expect(ledger.claimSiteEmail).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a root run that belongs to another tenant is never read: its preview-only graph cannot make this publish a first publish", async () => {
    h.tables.conductor_runs = h.tables.conductor_runs.filter((r) => r.id !== "run-p");
    h.tables.conductor_runs.push({ id: "run-p", tenant_id: "22222222-2222-4222-8222-222222222222", kind: "build_app", status: "done", objective: "x", goal_graph: previewRoot });
    const { store } = fakeSiteStore([siteP()]);
    const ledger = onceLedger();
    expect(await send("pub-1", { store, watching: away, ...ledger })).toEqual({ sent: false, reason: "edit" });
    expect(ledger.claimSiteEmail).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("founderWatchingBuild", () => {
  beforeEach(() => h.markers.clear());

  it("is true only within the freshness window, per tenant and per build session", async () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(await founderWatchingBuild(T1, "run-a", now)).toBe(false);
    await recordBuildWatch(T1, "run-a", new Date(now - BUILD_WATCH_FRESH_MS + 1_000));
    expect(await founderWatchingBuild(T1, "run-a", now)).toBe(true);
    expect(await founderWatchingBuild(T1, "run-b", now)).toBe(false);
    expect(await founderWatchingBuild("other-tenant", "run-a", now)).toBe(false);
    expect(await founderWatchingBuild(T1, "run-a", now + 2_000)).toBe(false);
  });
});
