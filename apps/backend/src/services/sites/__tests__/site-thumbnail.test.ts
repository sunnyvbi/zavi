import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createSiteThumbnailStore, isSiteThumbnailPath, newSiteThumbnailPath } from "../site-thumbnail";
import { captureBuildThumbnail, handleSiteThumbnailRequest, healSiteThumbnail, healThumbnailEvent, parseSiteThumbnailRequest, runThumbnailEvent, type BuildThumbnailDeps } from "../site-thumbnail-capture";
import { captureHomeScreenshot, runSiteGate } from "../site-gate";
import { createSiteDeployHandler, memoryCheckpoints, type SiteDeployDeps } from "../site-deploy";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "./fake-site-store";
import { GATE_CONFIG_PATH, type GateRunnerExec } from "../gate-runner/sandbox-runner";
import type { GateRunnerConfig } from "../gate-runner/config";
import { fakeLaunch, type FakeSite } from "../gate-runner/__tests__/fake-browser";
import type { SiteSandbox } from "../contract";

const req = createRequire(__filename);
const runner = req("../gate-runner/runner.cjs") as {
  runGate: (o: { baseUrl: string; config: GateRunnerConfig; launch: () => Promise<unknown> }) => Promise<Record<string, unknown> & { ok: boolean }>;
};

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const SITE = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "https://5173-sbxthumb01.e2b.app";

function fakeExec(site: FakeSite, configs: GateRunnerConfig[] = []): { exec: GateRunnerExec; visits: () => string[] } {
  const visits: string[] = [];
  const exec: GateRunnerExec = async (input) => {
    const config = JSON.parse(input.files[GATE_CONFIG_PATH]) as GateRunnerConfig;
    configs.push(config);
    const fake = fakeLaunch(site);
    const out = await runner.runGate({ baseUrl: input.env.GATE_BASE_URL, config, launch: fake.launch });
    visits.push(...fake.calls.goto.map((u: string) => new URL(u).pathname));
    return { exitCode: out.ok ? 0 : 1, stdout: `${JSON.stringify(out)}\n`, stderr: "" };
  };
  return { exec, visits: () => visits };
}

describe("captureHomeScreenshot: the home page at desktop width, through the trusted runner", () => {
  it("reads only the home page (no links followed) and answers its screenshot", async () => {
    const configs: GateRunnerConfig[] = [];
    const { exec, visits } = fakeExec({ origin: ORIGIN, routes: { "/": { text: "Bloom Bakery fresh bread", links: ["/menu", "/about"] }, "/menu": { text: "Menu" } } }, configs);
    const shot = await captureHomeScreenshot({ preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE }, { runner: exec });
    expect(shot).not.toBeNull();
    expect(Buffer.from(shot!, "base64").toString()).toMatch(/^shot:\d+:\/$/);
    expect(configs[0]).toMatchObject({ scan_only: true, read_only: true, thumbnail: true, scan_links: false, routes: ["/"] });
    expect(configs[0].screenshots).toBeUndefined();
    expect(visits()).not.toContain("/menu");
  });

  it("a build error on the page is never a thumbnail", async () => {
    const { exec } = fakeExec({ origin: ORIGIN, routes: { "/": { text: "Bloom", overlay: true } } });
    expect(await captureHomeScreenshot({ preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE }, { runner: exec })).toBeNull();
  });

  it("a runner that cannot start, or a scan with no result, THROWS so the worker retries", async () => {
    const down: GateRunnerExec = async () => {
      throw new Error("e2b down");
    };
    await expect(captureHomeScreenshot({ preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE }, { runner: down })).rejects.toThrow(/could not run/);
    const empty: GateRunnerExec = async () => ({ exitCode: 1, stdout: "", stderr: "killed" });
    await expect(captureHomeScreenshot({ preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE }, { runner: empty })).rejects.toThrow(/without a result/);
    const infra: GateRunnerExec = async () => ({ exitCode: 1, stdout: `${JSON.stringify({ ok: false, journeys: [], infrastructure_error: true, error: "browser crashed" })}\n`, stderr: "" });
    await expect(captureHomeScreenshot({ preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE }, { runner: infra })).rejects.toThrow(/browser crashed/);
  });

  it("a heal whose budget read fails throws (retried), never reads as over budget", async () => {
    const save = vi.fn(async () => true);
    const d = {
      claimHeal: vi.fn(async () => { throw new Error("rpc down"); }),
      loadRun: vi.fn(),
      siteTarget: vi.fn(async () => ({ previewUrl: null, liveUrl: "https://x.zaviagent.com", hasThumbnail: false })),
      probe: vi.fn(async () => true),
      capture: vi.fn(async () => "c2hvdA=="),
      thumbnails: { save, removeAll: vi.fn() },
      sleep: vi.fn(async () => {}),
      now: () => 0,
    };
    await expect(healSiteThumbnail({ tenantId: TENANT, siteId: SITE }, d)).rejects.toThrow(/rpc down/);
    expect(d.capture).not.toHaveBeenCalled();
  });
});

describe("site thumbnail paths", () => {
  it("are per tenant and per site, a new name each time", () => {
    const a = newSiteThumbnailPath(TENANT, SITE)!;
    const b = newSiteThumbnailPath(TENANT, SITE)!;
    expect(a).toMatch(new RegExp(`^${TENANT}/${SITE}/site-thumb-[0-9a-f]{12}\\.jpg$`));
    expect(a).not.toBe(b);
    expect(newSiteThumbnailPath("not-a-uuid", SITE)).toBeNull();
    expect(isSiteThumbnailPath(TENANT, SITE, a)).toBe(true);
    expect(isSiteThumbnailPath(OTHER, SITE, a)).toBe(false);
    expect(isSiteThumbnailPath(TENANT, OTHER, a)).toBe(false);
    expect(isSiteThumbnailPath(TENANT, SITE, `${TENANT}/${SITE}/../x/site-thumb-0123456789ab.jpg`)).toBe(false);
    expect(isSiteThumbnailPath(TENANT, SITE, null)).toBe(false);
  });
});

function fakeBucket() {
  const objects = new Set<string>();
  const uploads: Array<{ path: string; upsert: boolean; type: string }> = [];
  const bucket = {
    upload: vi.fn(async (path: string, _b: Buffer, o: { contentType: string; upsert: boolean }) => {
      uploads.push({ path, upsert: o.upsert, type: o.contentType });
      objects.add(path);
      return { error: null };
    }),
    remove: vi.fn(async (paths: string[]) => {
      for (const p of paths) objects.delete(p);
      return { error: null };
    }),
    list: vi.fn(async (prefix: string) => ({
      data: [...objects].filter((p) => p.startsWith(`${prefix}/`)).map((p) => ({ name: p.slice(prefix.length + 1) })),
      error: null,
    })),
  };
  return { bucket, objects, uploads };
}

describe("SiteThumbnailStore.save", () => {
  const AT = new Date("2026-10-09T10:00:00Z");
  const b64 = Buffer.from("jpeg").toString("base64");

  it("stores a re-encoded copy under a new name, points the site at it and deletes the one it replaced", async () => {
    const { bucket, objects, uploads } = fakeBucket();
    const old = `${TENANT}/${SITE}/site-thumb-aaaaaaaaaaaa.jpg`;
    objects.add(old);
    const resize = vi.fn(async () => Buffer.from("small"));
    const setPointer = vi.fn(async () => ({ outcome: "set" as const, replaced: old }));
    const store = createSiteThumbnailStore({ bucket: () => bucket, resize, setPointer });
    expect(await store.save({ tenant_id: TENANT, site_id: SITE, jpeg_b64: b64, taken_at: AT })).toBe(true);
    expect(resize).toHaveBeenCalledWith(Buffer.from("jpeg"));
    expect(uploads[0]).toMatchObject({ upsert: false, type: "image/jpeg" });
    expect(isSiteThumbnailPath(TENANT, SITE, uploads[0].path)).toBe(true);
    expect(setPointer).toHaveBeenCalledWith(TENANT, SITE, uploads[0].path, AT);
    expect([...objects]).toEqual([uploads[0].path]);
  });

  it("never deletes a replaced path that is not this site's own thumbnail", async () => {
    const { bucket } = fakeBucket();
    const store = createSiteThumbnailStore({ bucket: () => bucket, resize: async (x) => x, setPointer: async () => ({ outcome: "set" as const, replaced: `${OTHER}/${SITE}/site-thumb-aaaaaaaaaaaa.jpg` }) });
    expect(await store.save({ tenant_id: TENANT, site_id: SITE, jpeg_b64: b64, taken_at: AT })).toBe(true);
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it("an unknown pointer outcome (the RPC threw) keeps the upload: it may be what the site now points at", async () => {
    const { bucket, objects } = fakeBucket();
    const store = createSiteThumbnailStore({ bucket: () => bucket, resize: async (x) => x, setPointer: async () => { throw new Error("socket hang up"); } });
    expect(await store.save({ tenant_id: TENANT, site_id: SITE, jpeg_b64: b64, taken_at: AT })).toBe(false);
    expect(objects.size).toBe(1);
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it("a newer screenshot already recorded, or the site gone, removes the upload and answers false", async () => {
    for (const setPointer of [
      async () => ({ outcome: "stale" as const, replaced: null }),
      async () => ({ outcome: "not_found" as const, replaced: null }),
    ]) {
      const { bucket, objects } = fakeBucket();
      const store = createSiteThumbnailStore({ bucket: () => bucket, resize: async (x) => x, setPointer });
      expect(await store.save({ tenant_id: TENANT, site_id: SITE, jpeg_b64: b64, taken_at: AT })).toBe(false);
      expect(objects.size).toBe(0);
    }
  });

  it("removeAll deletes every thumbnail of this site (also ones an earlier replace left behind), nothing else", async () => {
    const { bucket, objects } = fakeBucket();
    const mine = [`${TENANT}/${SITE}/site-thumb-aaaaaaaaaaaa.jpg`, `${TENANT}/${SITE}/site-thumb-bbbbbbbbbbbb.jpg`];
    const keep = [`${TENANT}/${SITE}/notes.txt`, `${TENANT}/${OTHER}/site-thumb-cccccccccccc.jpg`, `${OTHER}/${SITE}/site-thumb-dddddddddddd.jpg`];
    for (const p of [...mine, ...keep]) objects.add(p);
    await createSiteThumbnailStore({ bucket: () => bucket }).removeAll({ tenant_id: TENANT, site_id: SITE });
    expect([...objects].sort()).toEqual([...keep].sort());
  });

  it("removeAll throws on a storage error, so teardown keeps it pending", async () => {
    const { bucket, objects } = fakeBucket();
    objects.add(`${TENANT}/${SITE}/site-thumb-aaaaaaaaaaaa.jpg`);
    const failing = { ...bucket, remove: vi.fn(async () => ({ error: { message: "storage down" } })) };
    await expect(createSiteThumbnailStore({ bucket: () => failing }).removeAll({ tenant_id: TENANT, site_id: SITE })).rejects.toThrow(/storage down/);
  });

  it("an image sharp cannot read, an upload error, or a bad id answers false without throwing", async () => {
    const { bucket } = fakeBucket();
    const setPointer = vi.fn(async () => ({ outcome: "set" as const, replaced: null }));
    const broken = createSiteThumbnailStore({ bucket: () => bucket, resize: async () => { throw new Error("bad jpeg"); }, setPointer });
    expect(await broken.save({ tenant_id: TENANT, site_id: SITE, jpeg_b64: b64, taken_at: AT })).toBe(false);
    const refused = createSiteThumbnailStore({
      bucket: () => ({ ...bucket, upload: async () => ({ error: { message: "mime refused" } }) }),
      resize: async (x) => x,
      setPointer,
    });
    expect(await refused.save({ tenant_id: TENANT, site_id: SITE, jpeg_b64: b64, taken_at: AT })).toBe(false);
    expect(await refused.save({ tenant_id: "nope", site_id: SITE, jpeg_b64: b64, taken_at: AT })).toBe(false);
    expect(setPointer).not.toHaveBeenCalled();
  });
});

describe("captureBuildThumbnail: the preview a build or edit left becomes the thumbnail", () => {
  const buildGraph = [{ payload: { stage: "provision", site_id: SITE } }, { payload: { stage: "build", site_id: SITE } }];
  const editGraph = [{ payload: { stage: "build", site_id: SITE, refine_mode: true } }];

  function deps(over: Partial<BuildThumbnailDeps> = {}) {
    let clock = 0;
    const save = vi.fn(async () => true);
    const d: BuildThumbnailDeps = {
      claimHeal: vi.fn(async () => true),
      loadRun: vi.fn(async () => ({ goal_graph: buildGraph, status: "done" })),
      siteTarget: vi.fn(async () => ({ previewUrl: `${ORIGIN}/`, liveUrl: null, hasThumbnail: false })),
      probe: vi.fn(async () => true),
      capture: vi.fn(async () => "c2hvdA=="),
      thumbnails: { save, removeAll: vi.fn() },
      sleep: vi.fn(async (ms: number) => {
        clock += ms;
      }),
      now: () => clock,
      readyTimeoutMs: 20_000,
      readyPollMs: 5_000,
      ...over,
    };
    return { d, save };
  }

  it("saves the home screenshot of a finished build's preview", async () => {
    const { d, save } = deps();
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, d)).toEqual({ status: "saved" });
    expect(d.capture).toHaveBeenCalledWith({ preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE });
    expect(save).toHaveBeenCalledWith({ tenant_id: TENANT, site_id: SITE, jpeg_b64: "c2hvdA==", taken_at: expect.any(Date) });
  });

  it("an edit takes one too", async () => {
    const { d } = deps({ loadRun: vi.fn(async () => ({ goal_graph: editGraph, status: "done" })) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, d)).toEqual({ status: "saved" });
  });

  it("skips a run that publishes itself (its gate took one), a run not done, and a non-site run", async () => {
    const own = deps({ loadRun: vi.fn(async () => ({ goal_graph: [...buildGraph, { payload: { stage: "deploy", site_id: SITE } }], status: "done" })) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, own.d)).toMatchObject({ reason: "publishes_itself" });
    const failed = deps({ loadRun: vi.fn(async () => ({ goal_graph: buildGraph, status: "failed" })) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, failed.d)).toMatchObject({ reason: "run_failed" });
    const plain = deps({ loadRun: vi.fn(async () => ({ goal_graph: [{ payload: { stage: "build" } }], status: "done" })) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, plain.d)).toMatchObject({ reason: "not_a_site_build" });
    for (const x of [own, failed, plain]) expect(x.d.capture).not.toHaveBeenCalled();
  });

  it("waits for the preview to answer, and gives up without a screenshot when it never does", async () => {
    let n = 0;
    const late = deps({ probe: vi.fn(async () => ++n > 2) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, late.d)).toEqual({ status: "saved" });
    const dead = deps({ probe: vi.fn(async () => false) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, dead.d)).toMatchObject({ reason: "preview_not_ready" });
    expect(dead.d.capture).not.toHaveBeenCalled();
  });

  it("no preview or no clean screenshot: nothing stored; a failing read THROWS so the worker retries", async () => {
    const none = deps({ siteTarget: vi.fn(async () => ({ previewUrl: null, liveUrl: null, hasThumbnail: false })) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, none.d)).toMatchObject({ reason: "no_preview" });
    const unclean = deps({ capture: vi.fn(async () => null) });
    expect(await captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, unclean.d)).toMatchObject({ reason: "no_clean_screenshot" });
    expect(unclean.save).not.toHaveBeenCalled();
    const boom = deps({ loadRun: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(captureBuildThumbnail({ tenantId: TENANT, runId: RUN }, boom.d)).rejects.toThrow(/db down/);
  });
});

describe("durable requests and self-heal", () => {
  const LIVE = "https://bloom.zaviagent.com";
  const owner = vi.fn(async () => TENANT);
  function deps(over: Partial<BuildThumbnailDeps> = {}) {
    const save = vi.fn(async () => true);
    const d: BuildThumbnailDeps = {
      claimHeal: vi.fn(async () => true),
      loadRun: vi.fn(async () => ({ goal_graph: [{ payload: { stage: "build", site_id: SITE } }], status: "done" })),
      siteTarget: vi.fn(async () => ({ previewUrl: `${ORIGIN}/`, liveUrl: LIVE, hasThumbnail: false })),
      probe: vi.fn(async () => true),
      capture: vi.fn(async () => "c2hvdA=="),
      thumbnails: { save, removeAll: vi.fn() },
      sleep: vi.fn(async () => {}),
      now: () => 0,
      ...over,
    };
    return { d, save };
  }

  it("one event per run and one heal per site per hour (Inngest drops a duplicate id)", () => {
    expect(runThumbnailEvent(TENANT, RUN)).toEqual({ id: `site-thumbnail-${RUN}`, name: "site/thumbnail.requested", data: { tenant_id: TENANT, run_id: RUN } });
    const a = healThumbnailEvent(TENANT, SITE, Date.parse("2026-10-09T10:05:00Z"));
    expect(healThumbnailEvent(TENANT, SITE, Date.parse("2026-10-09T10:55:00Z")).id).toBe(a.id);
    expect(healThumbnailEvent(TENANT, SITE, Date.parse("2026-10-09T11:05:00Z")).id).not.toBe(a.id);
  });

  it("a malformed request is dropped", async () => {
    expect(parseSiteThumbnailRequest({ tenant_id: "x", run_id: RUN })).toBeNull();
    expect(parseSiteThumbnailRequest({ tenant_id: TENANT })).toBeNull();
    expect(await handleSiteThumbnailRequest({ tenant_id: TENANT, site_id: "../x", heal: true }, owner, deps().d)).toEqual({ status: "skipped", reason: "bad_request" });
  });

  it("the worker routes a run request to the capture and a heal to the heal, with the tenant read from the row", async () => {
    const run = deps();
    expect(await handleSiteThumbnailRequest({ tenant_id: TENANT, run_id: RUN }, owner, run.d)).toEqual({ status: "saved" });
    expect(owner).toHaveBeenCalledWith({ run_id: RUN });
    expect(run.d.loadRun).toHaveBeenCalledWith(TENANT, RUN);
    const heal = deps();
    expect(await handleSiteThumbnailRequest({ tenant_id: TENANT, site_id: SITE, heal: true }, owner, heal.d)).toEqual({ status: "saved" });
    expect(owner).toHaveBeenCalledWith({ site_id: SITE });
    expect(heal.d.loadRun).not.toHaveBeenCalled();
  });

  it("C8: a payload tenant that does not own the run or site drops the request; nothing is read or written for either tenant", async () => {
    for (const data of [{ tenant_id: OTHER, run_id: RUN }, { tenant_id: OTHER, site_id: SITE, heal: true }]) {
      const h = deps();
      expect(await handleSiteThumbnailRequest(data, owner, h.d)).toEqual({ status: "skipped", reason: "tenant_mismatch" });
      expect(h.d.loadRun).not.toHaveBeenCalled();
      expect(h.d.siteTarget).not.toHaveBeenCalled();
      expect(h.save).not.toHaveBeenCalled();
    }
    const gone = deps();
    expect(await handleSiteThumbnailRequest({ tenant_id: TENANT, run_id: RUN }, vi.fn(async () => null), gone.d)).toEqual({ status: "skipped", reason: "not_found" });
  });

  it("an unreadable owner lookup throws, so Inngest retries", async () => {
    await expect(handleSiteThumbnailRequest({ tenant_id: TENANT, run_id: RUN }, vi.fn(async () => { throw new Error("db down"); }), deps().d)).rejects.toThrow(/db down/);
  });

  it("heal screenshots the preview when it answers, else the live address", async () => {
    const up = deps();
    await healSiteThumbnail({ tenantId: TENANT, siteId: SITE }, up.d);
    expect(up.d.capture).toHaveBeenCalledWith({ preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE });
    const asleep = deps({ probe: vi.fn(async () => false) });
    await healSiteThumbnail({ tenantId: TENANT, siteId: SITE }, asleep.d);
    expect(asleep.d.capture).toHaveBeenCalledWith({ preview_url: LIVE, tenant_id: TENANT, site_id: SITE });
    expect(asleep.save).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, site_id: SITE, jpeg_b64: "c2hvdA==" }));
  });

  it("heal never touches a site that has a thumbnail by now, is gone, was tried this hour, or has nothing to show", async () => {
    for (const [over, reason] of [
      [{ siteTarget: vi.fn(async () => ({ previewUrl: null, liveUrl: LIVE, hasThumbnail: true })) }, "has_thumbnail"],
      [{ siteTarget: vi.fn(async () => null) }, "no_site"],
      [{ claimHeal: vi.fn(async () => false) }, "over_budget"],
      [{ siteTarget: vi.fn(async () => ({ previewUrl: null, liveUrl: null, hasThumbnail: false })) }, "nothing_to_screenshot"],
    ] as const) {
      const h = deps(over as Partial<BuildThumbnailDeps>);
      expect(await healSiteThumbnail({ tenantId: TENANT, siteId: SITE }, h.d)).toMatchObject({ status: "skipped", reason });
      expect(h.d.capture).not.toHaveBeenCalled();
    }
  });
});

describe("publish gate: a passing full gate's home screenshot becomes the thumbnail", () => {
  const SHA = "abcdef1234567";
  function sandbox(): SiteSandbox {
    const run = vi.fn(async (cmd: string) => {
      if (cmd.includes("zavi-site.json")) return { exitCode: 0, stdout: JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }] } }), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    return { run, readFile: vi.fn(), listFiles: vi.fn() } as unknown as SiteSandbox;
  }

  async function publish(gateOk: boolean) {
    const { store, sites } = fakeSiteStore([siteRow({ id: SITE, tenant_id: T1, label: "alpha", backend_mode: "static" })]);
    const save = vi.fn(async () => true);
    const gateInputs: Array<{ thumbnail?: boolean }> = [];
    const deps: SiteDeployDeps = {
      store,
      sandboxes: { forSite: vi.fn(async () => sandbox()) },
      supabase: { applySql: vi.fn(), verifyCatalog: vi.fn(async () => []) },
      publisher: { stage: vi.fn(async (i: { sha: string }) => ({ deploy_id: "d000000001-00000001", preview_url: "https://p/__zavi_preview/x/?t=tok-1-abcdefgh", sha: i.sha })), previewUrl: async () => "https://unused.example/" },
      generations: fakeGenerations(sites).generations,
      requestActivate: vi.fn(async () => {}),
      activationState: () => "pending",
      verifySiteDeploy: vi.fn(async () => ({ ok: false, error: "not yet" }) as const),
      checkpoints: memoryCheckpoints(),
      runGate: vi.fn(async (i) => {
        gateInputs.push(i);
        return (gateOk
          ? { ok: true, reason: "ok", evidence: "{}", owner_journey: "not_required", thumbnail: "c2hvdA==" }
          : { ok: false, reason: "journey home failed", evidence: "{}", owner_journey: "not_required" }) as never;
      }),
      thumbnails: { save, removeAll: vi.fn() },
      sleep: async () => {},
      activationWaitMs: 0,
    };
    const out = await createSiteDeployHandler(deps).step({ tenant_id: T1, conductor_run_id: "run-1", site_id: SITE, sha: SHA, attempt: 0 });
    return { out, save, gateInputs };
  }

  it("asks the gate for the screenshot and stores it once the gate passes", async () => {
    const { save, gateInputs } = await publish(true);
    expect(gateInputs[0]?.thumbnail).toBe(true);
    expect(save).toHaveBeenCalledWith({ tenant_id: T1, site_id: SITE, jpeg_b64: "c2hvdA==", taken_at: expect.any(Date) });
  });

  it("a failed gate (a repair) stores nothing", async () => {
    const { out, save } = await publish(false);
    expect(out.kind).toBe("repair");
    expect(save).not.toHaveBeenCalled();
  });

  it("runSiteGate returns the home desktop shot only on a pass, and only when asked", async () => {
    const run = async (routes: FakeSite["routes"], thumbnail: boolean) => {
      const { exec } = fakeExec({ origin: ORIGIN, routes });
      return runSiteGate(
        { sandbox: sandbox(), preview_url: `${ORIGIN}/`, owner_link: null, allow_writes: false, sha: SHA, tenant_id: TENANT, site_id: SITE, backend_mode: "static", thumbnail },
        { runner: exec, env: { SITE_GATE_VISION_REVIEW: "0" } as NodeJS.ProcessEnv },
      );
    };
    const ok = await run({ "/": { text: "Bloom Bakery fresh bread" } }, true);
    expect(ok.reason).toBe("smoke journeys passed");
    expect(Buffer.from(ok.thumbnail ?? "", "base64").toString()).toMatch(/^shot:\d+:\/$/);
    expect((await run({ "/": { text: "Bloom Bakery fresh bread" } }, false)).thumbnail).toBeUndefined();
    const failed = await run({ "/": { text: "" } }, true);
    expect(failed.ok).toBe(false);
    expect(failed.thumbnail).toBeUndefined();
  });
});
