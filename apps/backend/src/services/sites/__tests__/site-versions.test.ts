import { describe, expect, it, vi } from "vitest";
import { newSiteDeployId } from "@/services/hosting/site-publish";
import {
  ERR_NEVER_PUBLISHED,
  ERR_NOT_KEPT,
  ERR_NOT_RECORDED,
  ERR_SITE_GONE,
  ERR_UNREADABLE,
  siteVersionPreview,
  type SiteVersionDeps,
  type SiteVersionRun,
} from "../site-versions";
import type { SiteRow } from "../contract";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const SITE = "05cd71e6-ca9a-402a-8c5b-7955a2cf9d5f";
const OTHER_SITE = "672aee95-6e65-47ec-bf78-09f84b10bee0";
const at = (iso: string) => Date.parse(iso);

const LIVE_SHA = "abdc24b39e0b20287484ead2e2abd5701f520025";
const FIRST_SHA = "fe849893fb0fee1d7564802b2c023bdb484b7866";
const LIVE_DEPLOY = "d0muqzh2uy-1d58fa82";
const RACED_DEPLOY = "d0muqzh5j8-a3a92a63";
const site = (patch: Partial<SiteRow> = {}) =>
  ({ id: SITE, tenant_id: T, status: "live", live_sha: LIVE_SHA, live_deploy_id: LIVE_DEPLOY, ...patch }) as SiteRow;

const buildRun: SiteVersionRun = {
  id: "build-1",
  created_at: "2026-10-02T12:47:17.785Z",
  goal_graph: [
    { id: "provision", status: "done", payload: { stage: "provision", site_id: SITE } },
    { id: "build", status: "done", payload: { stage: "build", site_id: SITE } },
  ],
};
const firstPublish: SiteVersionRun = {
  id: "publish-1",
  created_at: "2026-10-02T12:53:18.206Z",
  goal_graph: [
    {
      id: "site-republish",
      status: "done",
      started_at: "2026-10-02T12:53:21.695Z",
      finished_at: "2026-10-02T12:58:18.274Z",
      payload: { stage: "deploy", refine_mode: true, republish: true, publish_request: true, site_id: SITE, site_desired_sha: FIRST_SHA, parent_conductor_run_id: "build-1" },
    },
  ],
};
const refineRun = (deployPayload: Record<string, unknown> = {}, status = "done"): SiteVersionRun => ({
  id: "refine-1",
  created_at: "2026-10-02T13:05:50.829Z",
  goal_graph: [
    { id: "refine", status: "done", payload: { stage: "build", refine_mode: true, site_id: SITE, parent_conductor_run_id: "build-1" } },
    {
      id: "refine-deploy",
      status,
      started_at: "2026-10-02T13:13:01.025Z",
      finished_at: status === "done" ? "2026-10-02T13:13:40.799Z" : undefined,
      payload: { stage: "deploy", site_id: SITE, site_desired_sha: LIVE_SHA, ...deployPayload },
    },
  ],
});

function harness(opts: {
  runs?: SiteVersionRun[];
  firstPublish?: SiteVersionRun | null;
  site?: SiteRow | null;
  stored?: string[];
  changedBetween?: boolean;
} = {}) {
  const runs = opts.runs ?? [buildRun];
  const stored = opts.stored ?? [];
  const minted: string[] = [];
  const deps: SiteVersionDeps = {
    loadRun: vi.fn(async (tenant_id, id) => (tenant_id === T ? runs.find((r) => r.id === id) ?? null : null)),
    loadFirstPublish: vi.fn(async (tenant_id, root) => (tenant_id === T && root === "build-1" ? opts.firstPublish ?? null : null)),
    changedBetween: vi.fn(async () => opts.changedBetween ?? false),
    loadSite: vi.fn(async (tenant_id, id) => (tenant_id === T && id === SITE ? (opts.site === undefined ? site() : opts.site) : null)),
    hasDeploy: vi.fn(async ({ deploy_id }) => stored.includes(deploy_id)),
    versionPreviewUrl: vi.fn(async ({ deploy_id }) => {
      minted.push(deploy_id);
      return { url: `https://bike.zaviagent.com/__zavi_preview/${deploy_id}/?t=x&zavi_embed=1`, expires_at: "2026-10-02T14:00:00.000Z" };
    }),
  };
  return { deps, minted };
}

describe("a change's History row opens the build that change made live", () => {
  it("uses the deploy id recorded on the change's own deploy node", async () => {
    const live = newSiteDeployId(at("2026-10-02T13:13:20Z"));
    const later = newSiteDeployId(at("2026-10-02T13:30:00Z"));
    const h = harness({ runs: [refineRun({ site_live_deploy_id: live })], stored: [live, later] });
    const out = await siteVersionPreview(T, "refine-1", h.deps);
    expect(out).toMatchObject({ kind: "live", deploy_id: live, expires_at: "2026-10-02T14:00:00.000Z" });
    expect(h.minted).toEqual([live]);
  });

  it("a recorded build that cleanup already deleted is reported, never swapped for a neighbour", async () => {
    const recorded = newSiteDeployId(at("2026-10-02T13:13:20Z"));
    const neighbour = newSiteDeployId(at("2026-10-02T13:13:30Z"));
    const h = harness({ runs: [refineRun({ site_live_deploy_id: recorded })], stored: [neighbour] });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NOT_KEPT });
    expect(h.minted).toEqual([]);
  });

  it("a change published before ids were recorded opens the site's live build when its commit is the live one, never a later build of the same commit", async () => {
    const h = harness({ runs: [refineRun()], stored: [LIVE_DEPLOY, RACED_DEPLOY] });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toMatchObject({ kind: "live", deploy_id: LIVE_DEPLOY });
    expect(h.minted).toEqual([LIVE_DEPLOY]);
  });

  it("an older change published before ids were recorded is not guessed at", async () => {
    const h = harness({ runs: [refineRun({ site_desired_sha: FIRST_SHA })], stored: [LIVE_DEPLOY, RACED_DEPLOY, newSiteDeployId(at("2026-10-02T12:57:25Z"))] });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NOT_RECORDED });
    expect(h.minted).toEqual([]);
  });

  it("a change whose publish failed has no version, and never borrows the first build's", async () => {
    const h = harness({
      runs: [refineRun({}, "failed")],
      firstPublish: firstPublish,
      stored: [newSiteDeployId(at("2026-10-02T12:55:00Z"))],
    });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
  });
});

describe("a change that stopped at its preview opens the publish that put it live", () => {
  const draftRefine: SiteVersionRun = {
    id: "refine-1",
    created_at: "2026-10-02T13:05:50.829Z",
    goal_graph: [{ id: "refine", status: "done", payload: { stage: "build", refine_mode: true, site_id: SITE, parent_conductor_run_id: "build-1", stop_at_preview: true } }],
  };
  const publishAfter = (deploy: string): SiteVersionRun => ({
    id: "publish-2",
    created_at: "2026-10-02T13:20:00.000Z",
    goal_graph: [{ id: "site-republish", status: "done", payload: { stage: "deploy", refine_mode: true, republish: true, publish_request: true, site_id: SITE, parent_conductor_run_id: "build-1", site_live_deploy_id: deploy } }],
  });

  it("reads the first publish after the change (the site's republish, parent = the root build)", async () => {
    const deploy = newSiteDeployId(at("2026-10-02T13:21:00Z"));
    const h = harness({ runs: [draftRefine], firstPublish: publishAfter(deploy), stored: [deploy] });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toMatchObject({ kind: "live", deploy_id: deploy });
    expect(h.deps.loadFirstPublish).toHaveBeenCalledWith(T, "build-1", draftRefine.created_at);
  });

  it("a change superseded by another change before that publish was never published on its own", async () => {
    const deploy = newSiteDeployId(at("2026-10-02T13:21:00Z"));
    const h = harness({ runs: [draftRefine], firstPublish: publishAfter(deploy), stored: [deploy], changedBetween: true });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
    expect(h.minted).toEqual([]);
  });

  it("a change never published says so", async () => {
    const h = harness({ runs: [draftRefine], firstPublish: null });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
  });
});

describe("the first build's row opens its first publish", () => {
  it("a build published on request reads the publish run that followed it", async () => {
    const published = newSiteDeployId(at("2026-10-02T12:57:00Z"));
    const recordedPublish = {
      ...firstPublish,
      goal_graph: [{ ...(firstPublish.goal_graph as Array<{ payload: object }>)[0], payload: { ...(firstPublish.goal_graph as Array<{ payload: object }>)[0].payload, site_live_deploy_id: published } }],
    } as SiteVersionRun;
    const h = harness({ firstPublish: recordedPublish, stored: [LIVE_DEPLOY, published] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toMatchObject({ kind: "live", deploy_id: published });
    expect(h.deps.loadFirstPublish).toHaveBeenCalledWith(T, "build-1", buildRun.created_at);
  });

  it("a first publish from before ids were recorded, whose commit is no longer live, says so", async () => {
    const h = harness({ firstPublish, stored: [LIVE_DEPLOY] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NOT_RECORDED });
  });

  it("a first build changed again before its first publish was never published on its own", async () => {
    const h = harness({ firstPublish, site: site({ live_sha: FIRST_SHA }), stored: [LIVE_DEPLOY], changedBetween: true });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
  });

  it("a first build that is still the live version opens the live build", async () => {
    const h = harness({ firstPublish, site: site({ live_sha: FIRST_SHA }), stored: [LIVE_DEPLOY] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toMatchObject({ kind: "live", deploy_id: LIVE_DEPLOY });
  });

  it("a build that was never published has nothing to show", async () => {
    const h = harness({ firstPublish: null, stored: [newSiteDeployId(at("2026-10-02T12:57:00Z"))] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
  });

  it("a publish run of another site is never used", async () => {
    const other = { ...firstPublish, goal_graph: [{ ...(firstPublish.goal_graph as object[])[0], payload: { stage: "deploy", site_id: OTHER_SITE } }] } as SiteVersionRun;
    const h = harness({ firstPublish: other, stored: [newSiteDeployId(at("2026-10-02T12:57:00Z"))] });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_NEVER_PUBLISHED });
  });
});

describe("what is not a site version", () => {
  it("an old-flow run, an unknown run, or another tenant's run falls through to the old version preview", async () => {
    const oldFlow: SiteVersionRun = { id: "old-1", created_at: buildRun.created_at, goal_graph: [{ id: "build", status: "done", payload: { stage: "build" } }] };
    const h = harness({ runs: [oldFlow, buildRun] });
    expect(await siteVersionPreview(T, "old-1", h.deps)).toEqual({ kind: "not_site" });
    expect(await siteVersionPreview(T, "nope", h.deps)).toEqual({ kind: "not_site" });
    expect(await siteVersionPreview(OTHER_T, "build-1", h.deps)).toEqual({ kind: "not_site" });
    expect(h.minted).toEqual([]);
  });

  it("a site that fell back to the old flow uses the old preview", async () => {
    const h = harness({ site: site({ status: "fell_back_old" }) });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "not_site" });
  });

  it("a deleted or missing site says so", async () => {
    expect(await siteVersionPreview(T, "build-1", harness({ site: site({ status: "deleted" }) }).deps)).toEqual({ kind: "unavailable", error: ERR_SITE_GONE });
    expect(await siteVersionPreview(T, "build-1", harness({ site: null }).deps)).toEqual({ kind: "unavailable", error: ERR_SITE_GONE });
  });

  it("an unreadable run is a retryable error, never a fall-through to the old (sandbox, credentialed) preview path", async () => {
    const h = harness();
    h.deps.loadRun = vi.fn(async () => {
      throw new Error("conductor_runs read failed: timeout");
    });
    expect(await siteVersionPreview(T, "build-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_UNREADABLE });
    expect(h.minted).toEqual([]);
  });

  it("a storage read that fails is a retryable error, not a missing version", async () => {
    const h = harness({ runs: [refineRun({ site_live_deploy_id: LIVE_DEPLOY })] });
    h.deps.hasDeploy = vi.fn(async () => {
      throw new Error("r2 list failed (500)");
    });
    expect(await siteVersionPreview(T, "refine-1", h.deps)).toEqual({ kind: "unavailable", error: ERR_UNREADABLE });
  });
});
