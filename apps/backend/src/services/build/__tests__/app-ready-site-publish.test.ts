import { describe, expect, it } from "vitest";
import { BUILD_CHECKS_FAILED, BUILD_NO_CREDITS_TO_START, BUILD_PROVIDER_BUSY, SITE_DATABASE_SLOW, SITE_DATABASE_WAITING, isFounderBuildLine } from "@zavi/shared";
import { awaitsPublishOnRequest, deriveAppReady, type AppReadyNode, type SitePublishSignal } from "../app-ready";

const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
const NONE = { status: "none", started_at: null, url: null, retryable: false };

const onRequest: AppReadyNode[] = [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build", site_id: SITE } },
];
const withDeploy = (deploy: Partial<AppReadyNode>): AppReadyNode[] => [...onRequest, { payload: { stage: "deploy", site_id: SITE }, ...deploy }];
const oldFlow: AppReadyNode[] = [
  { status: "done", payload: { stage: "provision" } },
  { status: "done", payload: { stage: "build" } },
];

const ready = (signal?: SitePublishSignal | null, url: string | null = null) =>
  deriveAppReady({ status: "done" }, onRequest, { url, current: true, ...(signal === undefined ? {} : { site_publish: signal }) });

describe("deriveAppReady for a finished build that publishes on request", () => {
  it.each([
    ["no signal at all", undefined],
    ["a null signal", null],
    ["a building site with no publish run", { site_status: "building", site_updated_at: "2026-10-02T04:00:00Z", run: null }],
    ["a building site whose last publish run is done", { site_status: "building", run: { status: "done", created_at: "2026-10-02T05:00:00Z" } }],
    ["a publish run in a status it does not know", { site_status: "building", run: { status: "paused", created_at: "2026-10-02T05:00:00Z", reason: "x" } }],
  ] as Array<[string, SitePublishSignal | null | undefined]>)("%s: none, and the app is ready", (_name, signal) => {
    expect(ready(signal)).toEqual({ app_ready: true, publish: NONE });
  });

  it.each(["active", "provisioning"])("a publish run that is %s: publishing, started at the run's start", (status) => {
    expect(ready({ site_status: "building", site_updated_at: "2026-10-02T04:00:00Z", run: { status, created_at: "2026-10-02T05:00:00+00:00" } })).toEqual({
      app_ready: true,
      publish: { status: "publishing", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false },
    });
  });

  it("a publish run waiting for site database capacity says so in founder words", () => {
    expect(ready({ site_status: "publishing", run: { status: "active", created_at: "2026-10-02T05:00:00Z", waiting_database: true } }).publish).toEqual({
      status: "publishing",
      started_at: "2026-10-02T05:00:00.000Z",
      url: null,
      retryable: false,
      waiting: true,
      reason: SITE_DATABASE_WAITING,
    });
  });

  it("a publish that gave up waiting is a failed publish with the founder line (never the raw shard error)", () => {
    const p = ready({ site_status: "building", run: { status: "failed", created_at: "2026-10-02T05:00:00Z", reason: SITE_DATABASE_SLOW, failure_class: "deploy_failed" } }).publish;
    expect(p).toMatchObject({ status: "failed", reason: SITE_DATABASE_SLOW });
    expect(isFounderBuildLine(p.reason)).toBe(true);
  });

  it("two attempts never share a started_at", () => {
    const first = ready({ site_status: "publishing", run: { status: "active", created_at: "2026-10-02T05:00:00Z" } });
    const second = ready({ site_status: "publishing", run: { status: "active", created_at: "2026-10-02T05:09:30Z" } });
    expect(first.publish.started_at).not.toBe(second.publish.started_at);
  });

  it("a publishing site with no readable run: publishing, started at the site's last change", () => {
    expect(ready({ site_status: "publishing", site_updated_at: "2026-10-02T05:00:07Z", run: null }).publish).toEqual({
      status: "publishing",
      started_at: "2026-10-02T05:00:07.000Z",
      url: null,
      retryable: false,
    });
    expect(ready({ site_status: "publishing", site_updated_at: "not a date" }).publish.started_at).toBeNull();
  });

  it("an in-flight run with no start time falls back to the site's last change", () => {
    expect(ready({ site_status: "publishing", site_updated_at: "2026-10-02T05:00:07Z", run: { status: "active", created_at: null } }).publish.started_at).toBe(
      "2026-10-02T05:00:07.000Z",
    );
  });

  it.each(["failed", "halted"])("a publish run that is %s: failed with founder copy, never retryable, app still ready", (status) => {
    const state = ready({
      site_status: "building",
      run: { status, created_at: "2026-10-02T05:00:00Z", failure_class: "acceptance_failed", reason: "The site's smoke check failed: login\nEvidence: 500" },
    });
    expect(state).toEqual({
      app_ready: true,
      publish: { status: "failed", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false, reason: BUILD_CHECKS_FAILED },
    });
  });

  it("the raw failure signal never reaches the founder, whatever the class", () => {
    for (const failure_class of [null, "deploy_failed", "acceptance_failed", "repair_exhausted", "stage_failed", "something_new"]) {
      for (const reason of [
        "The site's smoke check failed: journey checkout returned 500\nEvidence: POST /api/data/orders -> 500",
        "Publishing kept failing: pooled backend unavailable: shard naqobauofmyxxixfcwwm lacks schema 0011_site_publish_fence",
      ]) {
        const out = ready({ site_status: "building", run: { status: "failed", failure_class, reason } }).publish.reason;
        if (out !== undefined) expect(isFounderBuildLine(out)).toBe(true);
        expect(out ?? "").not.toMatch(/smoke check|journey|shard|schema|Evidence/);
      }
    }
  });

  it("credits, capacity and a backend-authored line keep their specific copy", () => {
    expect(ready({ run: { status: "failed", reason: "repair dispatch failed (insufficient_credits)" } }).publish.reason).toBe(BUILD_NO_CREDITS_TO_START);
    expect(ready({ run: { status: "failed", failure_class: "provider_capacity", reason: "overloaded" } }).publish.reason).toBe(BUILD_PROVIDER_BUSY);
    const authored = "Zavi couldn't confirm this site while publishing. Try again.";
    expect(ready({ run: { status: "failed", failure_class: "deploy_failed", reason: `deploy: ${authored}` } }).publish.reason).toBe(authored);
  });

  it("a failed run wins over a site row still marked publishing", () => {
    expect(ready({ site_status: "publishing", run: { status: "failed", created_at: "2026-10-02T05:00:00Z", reason: "nope" } }).publish.status).toBe("failed");
  });

  it("a failed run with no reason, or one that only says publishing failed, has no reason key", () => {
    expect("reason" in ready({ run: { status: "failed", created_at: "2026-10-02T05:00:00Z" } }).publish).toBe(false);
    expect("reason" in ready({ run: { status: "failed", reason: "   \n  " } }).publish).toBe(false);
    expect("reason" in ready({ run: { status: "failed", reason: "x".repeat(900) } }).publish).toBe(false);
  });

  it("once the site has an address it is live as before, whatever the publish signal says", () => {
    const url = "https://alpha.zaviagent.com";
    for (const signal of [undefined, null, { site_status: "live", run: { status: "failed", reason: "x" } }, { site_status: "publishing", run: { status: "active" } }] as Array<SitePublishSignal | null | undefined>) {
      expect(ready(signal, url)).toEqual({ app_ready: false, publish: { status: "live", started_at: null, url, retryable: false } });
    }
  });
});

describe("the publish signal changes nothing else", () => {
  const failedPublish: SitePublishSignal = { site_status: "building", run: { status: "failed", created_at: "2026-10-02T05:00:00Z", reason: "from the publish run" } };

  it("a build with its own deploy step ignores it in every state", () => {
    const cases: Array<[{ status: string; failure_class?: string }, AppReadyNode[]]> = [
      [{ status: "active" }, withDeploy({ status: "pending" })],
      [{ status: "paused", failure_class: "deploy_failed" }, withDeploy({ status: "failed", error: "from the deploy node" })],
      [{ status: "done" }, withDeploy({ status: "done" })],
      [{ status: "failed", failure_class: "user_cancelled" }, withDeploy({ status: "pending" })],
    ];
    for (const [run, graph] of cases) {
      const before = deriveAppReady(run, graph, { url: null, current: true, now: 0 });
      const after = deriveAppReady(run, graph, { url: null, current: true, now: 0, site_publish: failedPublish });
      expect(after).toEqual(before);
      expect(after.publish.reason === "from the publish run").toBe(false);
    }
  });

  it("an old-flow build with no site, a refine graph, a build still running and a stale build ignore it", () => {
    const cases: Array<[{ status: string }, AppReadyNode[], { url: string | null; current: boolean }]> = [
      [{ status: "done" }, oldFlow, { url: null, current: true }],
      [{ status: "done" }, oldFlow, { url: "https://old.onrender.com", current: true }],
      [{ status: "done" }, [{ status: "done", payload: { stage: "build", site_id: SITE, refine_mode: true } }], { url: null, current: true }],
      [{ status: "active" }, [{ status: "done", payload: { stage: "provision" } }, { status: "dispatched", payload: { stage: "build", site_id: SITE } }], { url: null, current: true }],
      [{ status: "done" }, onRequest, { url: null, current: false }],
      [{ status: "failed" }, onRequest, { url: null, current: true }],
      [{ status: "paused" }, onRequest, { url: null, current: true }],
    ];
    for (const [run, graph, opts] of cases) {
      expect(deriveAppReady(run, graph, { ...opts, site_publish: failedPublish })).toEqual(deriveAppReady(run, graph, opts));
    }
  });
});

describe("awaitsPublishOnRequest", () => {
  it("is true only for a done site build with no deploy step and no address", () => {
    expect(awaitsPublishOnRequest({ status: "done" }, onRequest, null)).toBe(true);
    expect(awaitsPublishOnRequest({ status: "done" }, onRequest, undefined)).toBe(true);
    expect(awaitsPublishOnRequest({ status: "done" }, onRequest, "https://alpha.zaviagent.com")).toBe(false);
    expect(awaitsPublishOnRequest({ status: "active" }, onRequest, null)).toBe(false);
    expect(awaitsPublishOnRequest({ status: "paused" }, onRequest, null)).toBe(false);
    expect(awaitsPublishOnRequest({ status: "done" }, withDeploy({ status: "done" }), null)).toBe(false);
    expect(awaitsPublishOnRequest({ status: "done" }, oldFlow, null)).toBe(false);
    expect(awaitsPublishOnRequest({ status: "done" }, [{ status: "pending", payload: { stage: "build", site_id: SITE } }], null)).toBe(false);
    expect(awaitsPublishOnRequest({ status: "done" }, [{ status: "done", payload: { stage: "build", site_id: SITE, refine_mode: true } }], null)).toBe(false);
    expect(awaitsPublishOnRequest({ status: "done" }, null, null)).toBe(false);
  });
});
