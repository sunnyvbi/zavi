import { describe, expect, it, vi } from "vitest";
import {
  handleSitePreviewSnapshotRequest,
  notePreviewChanged,
  noteRunPreviewChanged,
  SITE_PREVIEW_SNAPSHOT_EVENT,
  SNAPSHOT_BUILD_DEFERS,
  type SnapshotCaptureDeps,
} from "../site-preview-snapshot-capture";
import type { SitePreviewSnapshotStore } from "../site-preview-snapshot";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const S = "aaaaaaaa-0000-4000-8000-00000000000a";
const RUN = "bbbbbbbb-0000-4000-8000-00000000000b";

function snapshots(over: Partial<SitePreviewSnapshotStore> = {}) {
  return {
    save: vi.fn(async () => true),
    markChanged: vi.fn(async () => true),
    fresh: vi.fn(async () => []),
    removeAll: vi.fn(async () => undefined),
    ...over,
  } satisfies SitePreviewSnapshotStore;
}

function deps(over: Partial<SnapshotCaptureDeps> = {}) {
  let clock = 1_000_000;
  const d: SnapshotCaptureDeps = {
    claim: vi.fn(async () => true),
    loadRun: vi.fn(async () => ({ goal_graph: [{ payload: { site_id: S } }], status: "done" })),
    previewUrl: vi.fn(async () => "https://5173-sbx.e2b.app/"),
    hasActiveBuild: vi.fn(async () => false),
    probe: vi.fn(async () => true),
    capture: vi.fn(async () => ({ desktop: "D", mobile: "M" })),
    snapshots: snapshots(),
    send: vi.fn(async () => undefined),
    sleep: vi.fn(async () => {
      clock += 5_000;
    }),
    now: () => clock,
    ...over,
  };
  return d;
}

const owner = async () => T;

describe("handleSitePreviewSnapshotRequest", () => {
  it("saves desktop and mobile with one taken_at stamped after the preview answered", async () => {
    let ready = false;
    let clock = 0;
    const d = deps({
      now: () => clock,
      sleep: vi.fn(async () => {
        clock += 5_000;
        ready = true;
      }),
      probe: vi.fn(async () => ready),
    });
    const out = await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, d);
    expect(out).toEqual({ status: "saved", devices: ["desktop", "mobile"] });
    const calls = (d.snapshots.save as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.device)).toEqual(["desktop", "mobile"]);
    expect(calls[0].taken_at.getTime()).toBe(5_000);
    expect(calls[1].taken_at).toBe(calls[0].taken_at);
  });

  it("drops a request whose payload tenant does not own the site, before any capture", async () => {
    const d = deps();
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: OTHER_T, site_id: S }, owner, d)).toEqual({ status: "skipped", reason: "tenant_mismatch" });
    expect(d.capture).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
  });

  it("never captures while a build runs, and asks again later instead of dropping the request", async () => {
    const d = deps({ hasActiveBuild: vi.fn(async () => true) });
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, d)).toEqual({ status: "skipped", reason: "build_active_deferred" });
    expect(d.capture).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledWith({ name: SITE_PREVIEW_SNAPSHOT_EVENT, data: { tenant_id: T, site_id: S, deferred: 1 } });
  });

  it("throws away a capture when a build started while it ran, and asks again later", async () => {
    let calls = 0;
    const d = deps({ hasActiveBuild: vi.fn(async () => ++calls > 1) });
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, d)).toEqual({ status: "skipped", reason: "build_active_deferred" });
    expect(d.capture).toHaveBeenCalledTimes(1);
    expect(d.snapshots.save).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("never photographs a preview whose files do not match the site's main (an undo the box never got)", async () => {
    for (const state of ["stale", "unknown"] as const) {
      const d = deps({ treeState: vi.fn(async () => state) });
      expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, d)).toEqual({ status: "skipped", reason: `preview_tree_${state}` });
      expect(d.capture).not.toHaveBeenCalled();
      expect(d.snapshots.save).not.toHaveBeenCalled();
    }
    const failing = deps({ treeState: vi.fn(async () => Promise.reject(new Error("github down"))) });
    expect((await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, failing)).status).toBe("skipped");
    expect(failing.capture).not.toHaveBeenCalled();
  });

  it("a preview that matches main is photographed", async () => {
    const d = deps({ treeState: vi.fn(async () => "same" as const) });
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, d)).toEqual({ status: "saved", devices: ["desktop", "mobile"] });
    expect(d.treeState).toHaveBeenCalledWith(T, S);
  });

  it("a deferred request that finds the build gone captures as usual", async () => {
    const d = deps();
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S, deferred: 3 }, owner, d)).toEqual({ status: "saved", devices: ["desktop", "mobile"] });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("stops asking after the bounded number of deferrals (a build stuck forever cannot loop it)", async () => {
    const d = deps({ hasActiveBuild: vi.fn(async () => true) });
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S, deferred: SNAPSHOT_BUILD_DEFERS }, owner, d)).toEqual({ status: "skipped", reason: "build_active" });
    expect(d.send).not.toHaveBeenCalled();
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S, deferred: 9999 }, owner, d)).toEqual({ status: "skipped", reason: "build_active" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("does not spend the tenant's hourly budget on a site with no preview", async () => {
    const d = deps({ previewUrl: vi.fn(async () => null) });
    expect((await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, d)).status).toBe("skipped");
    expect(d.claim).not.toHaveBeenCalled();
  });

  it("gives up when the preview never answers, without capturing", async () => {
    const d = deps({ probe: vi.fn(async () => false), readyTimeoutMs: 20_000 });
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, d)).toEqual({ status: "skipped", reason: "preview_not_ready" });
    expect(d.capture).not.toHaveBeenCalled();
  });

  it("stores nothing when the page did not render cleanly, and only desktop when mobile is missing", async () => {
    const broken = deps({ capture: vi.fn(async () => null) });
    expect((await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, broken)).status).toBe("skipped");
    expect(broken.snapshots.save).not.toHaveBeenCalled();
    const desktopOnly = deps({ capture: vi.fn(async () => ({ desktop: "D", mobile: null })) });
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, site_id: S }, owner, desktopOnly)).toEqual({ status: "saved", devices: ["desktop"] });
  });

  it("rejects a malformed payload", async () => {
    expect(await handleSitePreviewSnapshotRequest({ tenant_id: T, run_id: RUN }, owner, deps())).toEqual({ status: "skipped", reason: "bad_request" });
  });
});

describe("notePreviewChanged", () => {
  it("marks the site changed before asking for a new snapshot, keyed by site", async () => {
    const order: string[] = [];
    const d = deps({
      snapshots: snapshots({ markChanged: vi.fn(async () => (order.push("mark"), true)) }),
      send: vi.fn(async () => order.push("send")),
    });
    await notePreviewChanged(T, S, d);
    expect(order).toEqual(["mark", "send"]);
    expect(d.send).toHaveBeenCalledWith({ name: SITE_PREVIEW_SNAPSHOT_EVENT, data: { tenant_id: T, site_id: S } });
  });

  it("still asks for a new snapshot when the mark fails, so the old one gets replaced", async () => {
    const d = deps({ snapshots: snapshots({ markChanged: vi.fn(async () => Promise.reject(new Error("db"))) }) });
    await notePreviewChanged(T, S, d);
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe("noteRunPreviewChanged", () => {
  it("marks the built site changed and requests its snapshot", async () => {
    const d = deps({ loadRun: vi.fn(async () => ({ goal_graph: [{ payload: { site_id: S } }], status: "done" })) });
    await noteRunPreviewChanged(T, RUN, d);
    expect(d.snapshots.markChanged).toHaveBeenCalledWith(T, S);
    expect(d.send).toHaveBeenCalledWith({ name: SITE_PREVIEW_SNAPSHOT_EVENT, data: { tenant_id: T, site_id: S } });
  });

  it("does nothing for a run that is not a site build", async () => {
    const d = deps({ loadRun: vi.fn(async () => ({ goal_graph: [], status: "done" })) });
    await noteRunPreviewChanged(T, RUN, d);
    expect(d.snapshots.markChanged).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });
});
