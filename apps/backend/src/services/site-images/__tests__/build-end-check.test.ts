import { describe, expect, it, vi } from "vitest";
import {
  PHOTOS_NEVER_CALLED_NUDGE,
  PHOTOS_NONE_LANDED_NUDGE,
  isFirstSiteBuildPass,
  photoCheckFromMarker,
  sitePhotosStopHook,
  sitePhotosStopHookFor,
} from "../build-end-check";

const marker = (images: unknown[]) => JSON.stringify({ version: 1, generated: images.length, images });

describe("the photo check at the end of a first build", () => {
  it("reads the marker: none is never called, empty is none landed, photos are ok, junk is unknown", () => {
    expect(photoCheckFromMarker(null)).toEqual({ kind: "never_called" });
    expect(photoCheckFromMarker(marker([]))).toEqual({ kind: "none_landed" });
    expect(photoCheckFromMarker(marker([{ slug: "hero" }]))).toEqual({ kind: "ok", count: 1 });
    expect(photoCheckFromMarker("{oops")).toEqual({ kind: "unknown" });
  });

  it("blocks the stop once with the right instruction, then lets the build finish whatever happened", async () => {
    const onNudge = vi.fn();
    const never = sitePhotosStopHook({ readMarker: async () => null, noPhotosAsked: false, onNudge });
    expect(await never({ hook_event_name: "Stop", stop_hook_active: false })).toEqual({ decision: "block", reason: PHOTOS_NEVER_CALLED_NUDGE });
    expect(await never({ hook_event_name: "Stop", stop_hook_active: false })).toEqual({});
    expect(onNudge).toHaveBeenCalledWith("never_called");

    const empty = sitePhotosStopHook({ readMarker: async () => marker([]), noPhotosAsked: false });
    expect(await empty({ stop_hook_active: false })).toEqual({ decision: "block", reason: PHOTOS_NONE_LANDED_NUDGE });
  });

  it("never blocks a site with photos, a founder who asked for none, an unreadable marker, or a stop already continued", async () => {
    expect(await sitePhotosStopHook({ readMarker: async () => marker([{ slug: "hero" }]), noPhotosAsked: false })({})).toEqual({});
    expect(await sitePhotosStopHook({ readMarker: async () => null, noPhotosAsked: true })({})).toEqual({});
    expect(await sitePhotosStopHook({ readMarker: async () => { throw new Error("down"); }, noPhotosAsked: false })({})).toEqual({});
    expect(await sitePhotosStopHook({ readMarker: async () => null, noPhotosAsked: false })({ stop_hook_active: true })).toEqual({});
  });

  it("only a new site's first pass with add_site_images gets the hook", async () => {
    const first = { fast_single_pass: true, stage: "build", site_id: "s1", idea: "A bakery" };
    expect(isFirstSiteBuildPass(first)).toBe(true);
    expect(isFirstSiteBuildPass({ ...first, repair_mode: true })).toBe(false);
    expect(isFirstSiteBuildPass({ ...first, refine_mode: true })).toBe(false);
    expect(isFirstSiteBuildPass({ stage: "build", site_id: "s1" })).toBe(false);
    const base = { tenant_id: "t1", run_id: "r1", repoRoot: "/home/user/repo", getSandboxId: async () => "sb" };
    expect(await sitePhotosStopHookFor({ ...base, payload: first, site_images: false })).toBeNull();
    expect(await sitePhotosStopHookFor({ ...base, payload: { ...first, repair_mode: true }, site_images: true })).toBeNull();
    expect(typeof (await sitePhotosStopHookFor({ ...base, payload: first, site_images: true }))).toBe("function");
  });
});
