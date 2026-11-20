import { describe, it, expect, beforeEach } from "vitest";
import { BUILD_FIXES_EXHAUSTED, SITE_DATABASE_WAITING, isFounderBuildLine } from "@zavi/shared";
import {
  deriveAppReady,
  publishUrlFromResources,
  claimPublishPreviewKick,
  __resetPublishPreviewKicks,
  PUBLISH_PREVIEW_KICK_TTL_MS,
  type AppReadyNode,
} from "../app-ready";
import { buildSiteGoalGraph } from "@/services/agents/product-pipeline";

const URL = "https://acme.onrender.com";
const ENQ = Date.parse("2026-09-29T10:00:00.000Z");

type S = "pending" | "dispatched" | "done" | "failed";

function graph(
  s: { provision?: S; spec?: S; scaffold?: S; build?: S; deploy?: S },
  extra: { deploy?: Partial<AppReadyNode>; scaffold?: Partial<AppReadyNode>; preview?: boolean } = {},
): AppReadyNode[] {
  const g: AppReadyNode[] = [
    { status: s.provision ?? "done", payload: { stage: "provision" } },
    { status: s.spec ?? "done", payload: { stage: "spec" } },
    { status: s.scaffold ?? "done", payload: { stage: "scaffold" }, ...extra.scaffold },
  ];
  if (extra.preview) g.push({ status: "done", payload: { stage: "preview" } });
  g.push({ status: s.build ?? "pending", payload: { stage: "build" } });
  g.push({
    status: s.deploy ?? "pending",
    ...extra.deploy,
    payload: { stage: "deploy", ...(extra.deploy?.payload ?? {}) },
  });
  return g;
}

const none = { app_ready: false, publish: { status: "none", started_at: null, url: null, retryable: false } };
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const PAUSED_RECENT = "2026-09-28T12:00:00.000Z";
const PAUSED_OLD = "2026-09-20T12:00:00.000Z";

describe("deriveAppReady", () => {
  it("building: build stage dispatched → not ready, nothing publishing", () => {
    expect(deriveAppReady({ status: "active" }, graph({ build: "dispatched" }), { url: URL })).toEqual(none);
  });

  it("building: scaffold still running → not ready", () => {
    expect(
      deriveAppReady({ status: "active" }, graph({ scaffold: "dispatched", build: "pending" }), { url: URL }),
    ).toEqual(none);
  });

  it("build done + deploy pending (not yet enqueued) → ready, publishing, no started_at", () => {
    expect(deriveAppReady({ status: "active" }, graph({ build: "done", deploy: "pending" }), { url: URL })).toEqual({
      app_ready: true,
      publish: { status: "publishing", started_at: null, url: URL, retryable: false },
    });
  });

  it("build done + deploy enqueued → publishing with started_at from deploy_enqueued_at", () => {
    const g = graph({ build: "done", deploy: "pending" }, { deploy: { payload: { deploy_enqueued_at: ENQ } } });
    expect(deriveAppReady({ status: "active" }, g, { url: URL })).toEqual({
      app_ready: true,
      publish: { status: "publishing", started_at: "2026-09-29T10:00:00.000Z", url: URL, retryable: false },
    });
  });

  it("deploy node dispatched → publishing", () => {
    const g = graph({ build: "done", deploy: "dispatched" }, { deploy: { payload: { deploy_enqueued_at: ENQ } } });
    expect(deriveAppReady({ status: "active" }, g, { url: URL }).publish.status).toBe("publishing");
    expect(deriveAppReady({ status: "active" }, g, { url: URL }).app_ready).toBe(true);
  });

  it("build done with a preview stage in the graph still finds the build node", () => {
    const g = graph({ build: "done", deploy: "pending" }, { preview: true });
    expect(deriveAppReady({ status: "active" }, g, {}).app_ready).toBe(true);
  });

  it("run done → app_ready false, publish live with url and started_at", () => {
    const g = graph({ build: "done", deploy: "done" }, { deploy: { payload: { deploy_enqueued_at: ENQ } } });
    expect(deriveAppReady({ status: "done" }, g, { url: URL })).toEqual({
      app_ready: false,
      publish: { status: "live", started_at: "2026-09-29T10:00:00.000Z", url: URL, retryable: false },
    });
  });

  it("paused with run failure_class deploy_failed → app still ready, publish failed", () => {
    const g = graph(
      { build: "done", deploy: "failed" },
      { deploy: { failure_class: "deploy_failed", payload: { deploy_enqueued_at: ENQ } } },
    );
    expect(
      deriveAppReady(
        { status: "paused", failure_class: "deploy_failed", paused_at: PAUSED_RECENT, spend_usd: 3, max_usd: 20 },
        g,
        { url: URL, now: NOW },
      ),
    ).toEqual({
      app_ready: true,
      publish: { status: "failed", started_at: "2026-09-29T10:00:00.000Z", url: URL, retryable: true },
    });
  });

  it("paused acceptance_failed read only from the graph (run column null) → publish failed", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "acceptance_failed" } });
    expect(deriveAppReady({ status: "paused", failure_class: null, paused_at: PAUSED_RECENT }, g, { url: URL, now: NOW })).toEqual({
      app_ready: true,
      publish: { status: "failed", started_at: null, url: URL, retryable: true },
    });
  });

  it("failed (not paused) with deploy_failed after build done → publish failed", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    expect(deriveAppReady({ status: "failed", failure_class: "deploy_failed" }, g, { url: URL }).publish.status).toBe(
      "failed",
    );
  });

  it("failed (never paused) deploy_failed within the window with budget left → Retry publish is offered", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    const run = { status: "failed", failure_class: "deploy_failed", paused_at: null, spend_usd: 1, max_usd: 20 };
    expect(deriveAppReady({ ...run, updated_at: PAUSED_RECENT }, g, { url: URL, now: NOW })).toEqual({
      app_ready: true,
      publish: { status: "failed", started_at: null, url: URL, retryable: true },
    });
    expect(deriveAppReady({ ...run, updated_at: PAUSED_OLD }, g, { url: URL, now: NOW }).publish.retryable).toBe(false);
    expect(
      deriveAppReady({ ...run, updated_at: PAUSED_RECENT, spend_usd: 20 }, g, { url: URL, now: NOW }).publish.retryable,
    ).toBe(false);
    expect(
      deriveAppReady({ ...run, updated_at: PAUSED_RECENT, failure_class: "user_cancelled" }, g, { url: URL, now: NOW }).publish
        .retryable,
    ).toBe(false);
  });

  it("paused because the deploy node failed on another class still reports publish failed", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "budget_halted" } });
    expect(deriveAppReady({ status: "paused", failure_class: "budget_halted" }, g, { url: URL }).publish.status).toBe(
      "failed",
    );
  });

  it("save-then-status gap: active run with deploy node already done stays publishing", () => {
    const g = graph({ build: "done", deploy: "done" }, { deploy: { payload: { deploy_enqueued_at: ENQ } } });
    expect(deriveAppReady({ status: "active" }, g, { url: URL })).toEqual({
      app_ready: true,
      publish: { status: "publishing", started_at: "2026-09-29T10:00:00.000Z", url: URL, retryable: false },
    });
  });

  it("save-then-status gap: active run with deploy node just failed stays publishing", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    expect(deriveAppReady({ status: "active" }, g, { url: URL })).toEqual({
      app_ready: true,
      publish: { status: "publishing", started_at: null, url: URL, retryable: false },
    });
  });

  it("active with the deploy node failed AND another failed node is not publishing", () => {
    const g = graph({ build: "done", deploy: "failed" });
    g[1] = { status: "failed", payload: { stage: "spec" } };
    expect(deriveAppReady({ status: "active" }, g, { url: URL })).toEqual(none);
  });

  it("paused deploy_failed past the 7-day window → not retryable", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    const r = deriveAppReady({ status: "paused", failure_class: "deploy_failed", paused_at: PAUSED_OLD }, g, { url: URL, now: NOW });
    expect(r.publish).toMatchObject({ status: "failed", retryable: false });
    expect(r.app_ready).toBe(true);
  });

  it("paused with no paused_at → not retryable (continue refuses as expired)", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    expect(
      deriveAppReady({ status: "paused", failure_class: "deploy_failed", paused_at: null }, g, { now: NOW }).publish.retryable,
    ).toBe(false);
  });

  it("expired by the sweep (failed, class kept, recent paused_at) → not retryable", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    const r = deriveAppReady({ status: "failed", failure_class: "deploy_failed", paused_at: PAUSED_RECENT }, g, { now: NOW });
    expect(r.publish).toMatchObject({ status: "failed", retryable: false });
  });

  it("failed + acceptance_failed → not retryable", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "acceptance_failed" } });
    const r = deriveAppReady({ status: "failed", failure_class: "acceptance_failed", paused_at: PAUSED_RECENT }, g, { now: NOW });
    expect(r.publish).toMatchObject({ status: "failed", retryable: false });
  });

  it("paused with the budget spent → not retryable", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    const base = { status: "paused", failure_class: "deploy_failed", paused_at: PAUSED_RECENT };
    expect(deriveAppReady({ ...base, spend_usd: 20, max_usd: 20 }, g, { now: NOW }).publish.retryable).toBe(false);
    expect(deriveAppReady({ ...base, spend_usd: "19.99", max_usd: "20" }, g, { now: NOW }).publish.retryable).toBe(true);
    expect(deriveAppReady({ ...base, spend_usd: 50, max_usd: null }, g, { now: NOW }).publish.retryable).toBe(true);
  });

  it("paused with a never-retry class on the run → not retryable", () => {
    const g = graph({ build: "done", deploy: "failed" }, { deploy: { failure_class: "deploy_failed" } });
    expect(
      deriveAppReady({ status: "paused", failure_class: "user_cancelled", paused_at: PAUSED_RECENT }, g, { now: NOW }).publish,
    ).toMatchObject({ status: "failed", retryable: false });
  });

  it("paused deploy_failed with no failed node left in the graph → not retryable", () => {
    const g = graph({ build: "done", deploy: "pending" });
    expect(
      deriveAppReady({ status: "paused", failure_class: "deploy_failed", paused_at: PAUSED_RECENT }, g, { now: NOW }).publish,
    ).toMatchObject({ status: "failed", retryable: false });
  });

  it("failed at scaffold → not ready, publish none", () => {
    const g = graph({ scaffold: "failed", build: "pending" }, { scaffold: { failure_class: "stage_failed" } });
    expect(deriveAppReady({ status: "failed", failure_class: "stage_failed" }, g, { url: URL })).toEqual(none);
  });

  it("paused at build (build failed) with deploy_failed class somehow on the row → not ready", () => {
    const g = graph({ build: "failed" });
    expect(deriveAppReady({ status: "paused", failure_class: "deploy_failed" }, g, { url: URL })).toEqual(none);
  });

  it("active run with a failed node other than deploy (repair in flight) → not publishing", () => {
    const g = graph({ build: "done", deploy: "pending" });
    g[1] = { status: "failed", payload: { stage: "spec" } };
    expect(deriveAppReady({ status: "active" }, g, { url: URL })).toEqual(none);
  });

  it("cancelled after build done → none", () => {
    expect(deriveAppReady({ status: "cancelled" }, graph({ build: "done", deploy: "pending" }), { url: URL })).toEqual(
      none,
    );
  });

  it("active with build done but no deploy node → none (nothing to publish)", () => {
    const g = graph({ build: "done" }).filter((n) => n.payload?.stage !== "deploy");
    expect(deriveAppReady({ status: "active" }, g, { url: URL })).toEqual(none);
  });

  it("refine run never reports app_ready, even with a done build node and pending deploy", () => {
    const g: AppReadyNode[] = [
      { status: "done", payload: { stage: "build", refine_mode: true } },
      { status: "pending", payload: { stage: "deploy", deploy_enqueued_at: ENQ } },
    ];
    expect(deriveAppReady({ status: "active" }, g, { url: URL })).toEqual(none);
    expect(deriveAppReady({ status: "done" }, g, { url: URL })).toEqual(none);
  });

  it("superseded/retired (current=false) → none even for a publishing or live run", () => {
    expect(
      deriveAppReady({ status: "active" }, graph({ build: "done", deploy: "pending" }), { url: URL, current: false }),
    ).toEqual(none);
    expect(
      deriveAppReady({ status: "done" }, graph({ build: "done", deploy: "done" }), { url: URL, current: false }),
    ).toEqual(none);
  });

  it("null graph → none", () => {
    expect(deriveAppReady({ status: "active" }, null)).toEqual(none);
  });

  it("unknown url stays null while publishing", () => {
    expect(deriveAppReady({ status: "active" }, graph({ build: "done", deploy: "pending" })).publish.url).toBeNull();
  });
});

describe("publishUrlFromResources", () => {
  it("prefers a live custom domain over the hosting url", () => {
    expect(
      publishUrlFromResources(
        [
          { resource_kind: "hosting", external_ref: { url: URL } },
          { resource_kind: "domain", external_ref: { hostname: "acme.zaviagent.com", status: "live" } },
        ],
        URL,
      ),
    ).toBe("https://acme.zaviagent.com");
  });

  it("falls back to the hosting url when the domain is not live", () => {
    expect(
      publishUrlFromResources([{ resource_kind: "domain", external_ref: { hostname: "acme.zaviagent.com", status: "pending" } }], URL),
    ).toBe(URL);
  });

  it("null when nothing is known", () => {
    expect(publishUrlFromResources(null, null)).toBeNull();
  });
});

describe("claimPublishPreviewKick", () => {
  beforeEach(() => __resetPublishPreviewKicks());

  it("claims once per run inside the window, again after it lapses", () => {
    const t = 1_000_000;
    expect(claimPublishPreviewKick("run-a", t)).toBe(true);
    expect(claimPublishPreviewKick("run-a", t + 1)).toBe(false);
    expect(claimPublishPreviewKick("run-a", t + PUBLISH_PREVIEW_KICK_TTL_MS - 1)).toBe(false);
    expect(claimPublishPreviewKick("run-b", t + 1)).toBe(true);
    expect(claimPublishPreviewKick("run-a", t + PUBLISH_PREVIEW_KICK_TTL_MS)).toBe(true);
  });

  it("stays bounded without dropping a fresh claim for the run being polled", () => {
    const t = 5_000_000;
    for (let i = 0; i < 600; i += 1) claimPublishPreviewKick(`r-${i}`, t);
    expect(claimPublishPreviewKick("r-599", t + 10)).toBe(false);
  });
});

describe("deriveAppReady: publish reason and fix progress", () => {
  it("a paused run whose deploy failed reports failed with founder copy, never the deploy error", () => {
    const r = deriveAppReady(
      { status: "paused", failure_class: "repair_exhausted", paused_at: PAUSED_RECENT, updated_at: PAUSED_RECENT },
      graph({ build: "done", deploy: "failed" }, {
        deploy: { failure_class: "repair_exhausted", error: "The site's smoke check failed: login journey\nEvidence: {\"long\":\"log\"}" },
      }),
      { url: URL, now: NOW },
    );
    expect(r.publish).toMatchObject({ status: "failed", reason: BUILD_FIXES_EXHAUSTED });
    expect(r.publish.reason).not.toMatch(/smoke check|journey|Evidence/);
  });

  it("an active run with a site fix pass in flight is publishing + fixing, without the gate's raw signal", () => {
    const r = deriveAppReady(
      { status: "active" },
      graph({ build: "done", deploy: "dispatched" }, {
        deploy: { site_repair_pending: true, last_failure_signal: "The site did not build: npm run build failed (exit 1):\nerr" },
      }),
      { url: URL, now: NOW },
    );
    expect(r.publish).toMatchObject({ status: "publishing", fixing: true });
    expect("reason" in r.publish).toBe(false);
  });

  it("an active run waiting for site database capacity is publishing + waiting with the founder line", () => {
    const r = deriveAppReady(
      { status: "active" },
      graph({ build: "done", deploy: "pending" }, { deploy: { payload: { site_capacity_wait_since: ENQ } } }),
      { url: URL, now: NOW },
    );
    expect(r.publish).toMatchObject({ status: "publishing", waiting: true, reason: SITE_DATABASE_WAITING });
    expect(isFounderBuildLine(r.publish.reason)).toBe(true);
  });

  it("a plain publish carries neither field", () => {
    const r = deriveAppReady({ status: "active" }, graph({ build: "done", deploy: "dispatched" }), { url: URL, now: NOW });
    expect(r.publish).toEqual({ status: "publishing", started_at: null, url: URL, retryable: false });
  });
});

describe("deriveAppReady: a site build that publishes on request (no deploy node)", () => {
  const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
  const SITE_URL = "https://acme.zaviagent.com";
  const previewReady = { app_ready: true, publish: { status: "none", started_at: null, url: null, retryable: false } };

  function siteGraph(publish_on_request: boolean, build: S, deploy?: Partial<AppReadyNode>): AppReadyNode[] {
    const built = buildSiteGoalGraph(
      { tenant_id: "11111111-1111-4111-8111-111111111111", company_name: "Acme", idea: "A booking site for a barber" },
      {
        site_id: SITE_ID,
        target: { github_full_name: "praxis-built/acme-aaa111", repo_url: "https://github.com/praxis-built/acme-aaa111", default_branch: "main" },
        seed_sha: "5eed5eed",
        publish_on_request,
      },
    );
    return built.map((n) => ({
      status: n.payload.stage === "build" ? build : n.status,
      payload: { ...n.payload },
      ...(n.payload.stage === "deploy" ? deploy : {}),
    }));
  }

  it("done with no deploy node and never published: preview ready, publish none, no address", () => {
    const g = siteGraph(true, "done");
    expect(g.map((n) => n.payload?.stage)).toEqual(["provision", "build"]);
    expect(deriveAppReady({ status: "done" }, g, { url: null, current: true })).toEqual(previewReady);
    expect(deriveAppReady({ status: "done" }, g)).toEqual(previewReady);
  });

  it("done with a deploy node still reports live with its address (setting off)", () => {
    const g = siteGraph(false, "done", { status: "done", payload: { stage: "deploy", site_id: SITE_ID, deploy_enqueued_at: ENQ } });
    expect(deriveAppReady({ status: "done" }, g, { url: SITE_URL, current: true })).toEqual({
      app_ready: false,
      publish: { status: "live", started_at: "2026-09-29T10:00:00.000Z", url: SITE_URL, retryable: false },
    });
    expect(deriveAppReady({ status: "done" }, g, { url: null, current: true }).publish.status).toBe("live");
  });

  it("done with no deploy node, published afterwards from the Publish button (the site has an address): live at that address", () => {
    expect(deriveAppReady({ status: "done" }, siteGraph(true, "done"), { url: SITE_URL, current: true })).toEqual({
      app_ready: false,
      publish: { status: "live", started_at: null, url: SITE_URL, retryable: false },
    });
  });

  it("an old-flow done run with no deploy node (no site) keeps reporting live", () => {
    const g: AppReadyNode[] = [
      { status: "done", payload: { stage: "provision" } },
      { status: "done", payload: { stage: "scaffold" } },
      { status: "done", payload: { stage: "build" } },
    ];
    expect(deriveAppReady({ status: "done" }, g, { url: null, current: true })).toEqual({
      app_ready: false,
      publish: { status: "live", started_at: null, url: null, retryable: false },
    });
    const blankSite: AppReadyNode[] = g.map((n) => ({ ...n, payload: { ...n.payload, site_id: "  " } }));
    expect(deriveAppReady({ status: "done" }, blankSite, { url: null, current: true }).publish.status).toBe("live");
  });

  it("is not ready before the build node is done, whatever the run says", () => {
    for (const build of ["pending", "dispatched", "failed"] as const) {
      for (const status of ["active", "done", "paused", "failed"]) {
        expect(deriveAppReady({ status }, siteGraph(true, build), { url: null, current: true })).toEqual(none);
      }
    }
  });

  it("only a done run is preview ready: active (the save-then-status gap), paused, failed and cancelled stay none", () => {
    for (const status of ["active", "paused", "failed", "halted"]) {
      expect(deriveAppReady({ status, failure_class: status === "failed" ? "user_cancelled" : null }, siteGraph(true, "done"), { url: null, current: true })).toEqual(none);
    }
  });

  it("a hidden site (current=false) is never preview ready", () => {
    expect(deriveAppReady({ status: "done" }, siteGraph(true, "done"), { url: null, current: false })).toEqual(none);
  });

  it("a finished edit run on a never-published site (one engineer node) is not a build: none", () => {
    const edit: AppReadyNode[] = [{ status: "done", payload: { stage: "build", refine_mode: true, site_id: SITE_ID } }];
    expect(deriveAppReady({ status: "done" }, edit, { url: null, current: true })).toEqual(none);
  });
});
