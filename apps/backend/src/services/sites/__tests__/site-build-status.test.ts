import { describe, it, expect, beforeEach, vi } from "vitest";
import { siteRow } from "./fake-site-store";
import {
  resetSiteLiveChecks,
  siteDeployedUrl,
  siteLiveState,
  siteLiveUrl,
  siteSessionSummary,
  SITE_LIVE_CHECK_TTL_MS,
  sitePreview,
  resetSitePreviewDeadTracking,
} from "../site-build-status";

const live = siteRow({ id: "aaaaaaaa-0000-4000-8000-000000000001", label: "alpha", status: "live", live_deploy_id: "d1" });

beforeEach(() => resetSiteLiveChecks());

describe("siteLiveUrl", () => {
  it("a live site has its address; a paused, waking or failed one has none", () => {
    expect(siteLiveUrl(live)).toBe("https://alpha.zaviagent.com");
    for (const status of ["paused", "waking", "failed"] as const) {
      expect(siteLiveUrl({ ...live, status })).toBeNull();
      expect(siteDeployedUrl({ ...live, status })).toBe("https://alpha.zaviagent.com");
    }
    expect(siteSessionSummary({ ...live, status: "paused" }).live_url).toBeNull();
  });

  it("never an address before a deploy was activated", () => {
    expect(siteLiveUrl({ ...live, live_deploy_id: null })).toBeNull();
  });
});

describe("siteLiveState", () => {
  const verify = vi.fn(async () => true);
  beforeEach(() => verify.mockReset().mockResolvedValue(true));

  it("offline check off: the stored state decides, no probe", async () => {
    expect(await siteLiveState(live, { offlineCheck: false, verify })).toEqual({ live_url: "https://alpha.zaviagent.com", site_offline: false });
    expect(await siteLiveState({ ...live, status: "paused" }, { offlineCheck: false, verify })).toEqual({ live_url: null, site_offline: false });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(["failed", "paused", "waking"] as const)("a published %s site is offline with no address", async (status) => {
    expect(await siteLiveState({ ...live, status }, { offlineCheck: true, verify })).toEqual({ live_url: null, site_offline: true });
    expect(verify).not.toHaveBeenCalled();
  });

  it("a site that never went live is not offline", async () => {
    const r = await siteLiveState({ ...live, status: "failed", live_deploy_id: null }, { offlineCheck: true, verify });
    expect(r).toEqual({ live_url: null, site_offline: false });
  });

  it("a live site serving its deploy is live (probed with its own hostname + deploy)", async () => {
    expect(await siteLiveState(live, { offlineCheck: true, verify })).toEqual({ live_url: "https://alpha.zaviagent.com", site_offline: false });
    expect(verify).toHaveBeenCalledWith("alpha.zaviagent.com", "d1");
  });

  it("a live site serving another deploy (or erroring) is offline", async () => {
    verify.mockResolvedValue(false);
    expect(await siteLiveState(live, { offlineCheck: true, verify })).toEqual({ live_url: null, site_offline: true });
    resetSiteLiveChecks();
    const throwing = async (): Promise<boolean> => {
      throw new Error("probe failed");
    };
    expect(await siteLiveState(live, { offlineCheck: true, verify: throwing })).toEqual({ live_url: null, site_offline: true });
  });

  it("cached for 60s and single-flight per hostname + deploy", async () => {
    let t = 1_000;
    let release: (v: boolean) => void = () => undefined;
    verify.mockImplementation(() => new Promise<boolean>((r) => (release = r)));
    const deps = { offlineCheck: true, verify, now: () => t };
    const a = siteLiveState(live, deps);
    const b = siteLiveState(live, deps);
    await Promise.resolve();
    release(true);
    expect((await a).site_offline).toBe(false);
    expect((await b).site_offline).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);

    t += SITE_LIVE_CHECK_TTL_MS - 1;
    await siteLiveState(live, deps);
    expect(verify).toHaveBeenCalledTimes(1);

    verify.mockResolvedValue(false);
    const beta = { ...live, label: "beta", hostname: "beta.zaviagent.com", live_deploy_id: "d9" };
    expect((await siteLiveState(beta, deps)).site_offline).toBe(true);
    expect((await siteLiveState(live, deps)).site_offline).toBe(false);

    t += 2;
    expect((await siteLiveState(live, deps)).site_offline).toBe(true);
    expect(verify).toHaveBeenCalledTimes(3);
  });
});

describe("sitePreview — a just-started preview is not cleared on its first failed probe", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const row = { id: "row-1", preview_url: "https://5173-sbx.e2b.app", preview_status: "live" };
  const site = { id: "s1", tenant_id: T, github_full_name: "o/r", live_deploy_id: null, live_url: null, hostname: "h", status: "building" } as never;

  it("dead inside the grace window: no preview shown, row NOT cleared; cleared only after the window", async () => {
    resetSitePreviewDeadTracking();
    let now = 1_000_000;
    const clearDead = vi.fn(async () => undefined);
    const deps = { loadSandbox: async () => row, probe: async () => "dead", clearDead, now: () => now, deadGraceMs: 60_000 };
    expect(await sitePreview(T, site, deps)).toEqual({ url: null, kind: "none" });
    expect(clearDead).not.toHaveBeenCalled();
    now += 30_000;
    await sitePreview(T, site, deps);
    expect(clearDead).not.toHaveBeenCalled();
    now += 31_000;
    await sitePreview(T, site, deps);
    expect(clearDead).toHaveBeenCalledWith("row-1");
  });

  it("an ok probe resets the window", async () => {
    resetSitePreviewDeadTracking();
    let now = 1_000_000;
    let state = "dead";
    const clearDead = vi.fn(async () => undefined);
    const deps = { loadSandbox: async () => row, probe: async () => state, clearDead, now: () => now, deadGraceMs: 60_000 };
    await sitePreview(T, site, deps);
    state = "ok";
    now += 50_000;
    expect(await sitePreview(T, site, deps)).toEqual({ url: row.preview_url, kind: "instant" });
    state = "dead";
    now += 50_000;
    await sitePreview(T, site, deps);
    expect(clearDead).not.toHaveBeenCalled();
  });
});

describe("sitePreview — a live site with changes waiting for Publish", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const row = { id: "row-2", preview_url: "https://5173-sbx-live.e2b.app", preview_status: "live" };
  const live = { id: "s2", tenant_id: T, github_full_name: "o/r", live_deploy_id: "dep-1", live_url: "https://bakery.zaviagent.com", hostname: "bakery.zaviagent.com", status: "live" } as never;
  const deps = (probe: string) => ({ loadSandbox: async () => row, probe: async () => probe, clearDead: vi.fn(async () => undefined) });

  it("nothing waiting: the live address", async () => {
    resetSitePreviewDeadTracking();
    expect(await sitePreview(T, live, deps("ok"))).toEqual({ url: "https://bakery.zaviagent.com", kind: "final" });
  });

  it("changes waiting: the sandbox preview that holds them", async () => {
    resetSitePreviewDeadTracking();
    expect(await sitePreview(T, live, { ...deps("ok"), unpublishedChanges: true })).toEqual({ url: row.preview_url, kind: "instant" });
  });

  it("changes waiting but the sandbox is down: the live address, never nothing", async () => {
    resetSitePreviewDeadTracking();
    expect(await sitePreview(T, live, { ...deps("dead"), unpublishedChanges: true })).toEqual({ url: "https://bakery.zaviagent.com", kind: "final" });
  });
});
