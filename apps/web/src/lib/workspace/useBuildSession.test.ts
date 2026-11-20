import { describe, expect, it } from "vitest";
import {
  INITIAL_SESSION,
  activitySignature,
  applyStatus,
  isRefineBusy,
  latestBusyRefine,
  previewRevisionOf,
  seededSnapshot,
  isPlainUndoNotice,
  shouldPollRefines,
  undoSuccessNotice,
} from "./useBuildSession";

describe("latestBusyRefine", () => {
  it("returns the newest non-terminal change", () => {
    expect(latestBusyRefine([
      { id: "r1", message: "x", status: "active", created_at: "" },
      { id: "r2", message: "y", status: "done", created_at: "" },
      { id: "r3", message: "z", status: "running", created_at: "" },
    ])?.id).toBe("r3");
    expect(latestBusyRefine([
      { id: "r1", message: "x", status: "done", created_at: "" },
    ])).toBeNull();
  });
});

describe("seededSnapshot", () => {
  it("renders a just-started build as loaded + building before any poll", () => {
    const s = seededSnapshot({ id: "b1", objective: "a CRM", startedAt: 1_700_000_000_000 });
    expect(s.loaded).toBe(true);
    expect(s.notFound).toBe(false);
    expect(s.run?.id).toBe("b1");
    expect(s.run?.status).toBe("provisioning");
    expect(s.previewUrl).toBeNull();
  });
});

describe("applyStatus", () => {
  it("marks a missing run as not found", () => {
    expect(applyStatus(INITIAL_SESSION, { run: null }).notFound).toBe(true);
  });

  it("copies the run, preview and target, and honours is_current", () => {
    const s = applyStatus(INITIAL_SESSION, {
      run: {
        id: "b1",
        objective: "Build product: X — a CRM",
        status: "done",
        created_at: "2026-09-01T10:00:00Z",
        updated_at: "2026-09-01T10:30:00Z",
        stages: [{ stage: "build", status: "done" }],
        failure: null,
      },
      target: { repo_url: "https://github.com/x/y", live_url: "https://x.onrender.com" },
      preview: { url: "https://x.onrender.com", kind: "final" },
      is_current: false,
    });
    expect(s.loaded).toBe(true);
    expect(s.run?.status).toBe("done");
    expect(s.isCurrent).toBe(false);
    expect(s.previewUrl).toBe("https://x.onrender.com");
    expect(s.previewKind).toBe("final");
    expect(s.liveUrl).toBe("https://x.onrender.com");
    expect(s.repoUrl).toBe("https://github.com/x/y");
  });

  it("never exposes a preview url the server did not vouch for", () => {
    const s = applyStatus(INITIAL_SESSION, {
      run: { id: "b1", status: "active" },
      preview: { url: "https://dead.example", kind: "none" },
    });
    expect(s.previewUrl).toBeNull();
    expect(s.isCurrent).toBe(true);
  });

  it("clears a prior load error once a read succeeds", () => {
    const failed = { ...INITIAL_SESSION, loaded: true, loadError: "HTTP 500" };
    expect(applyStatus(failed, { run: { id: "b1", status: "active" } }).loadError).toBeNull();
  });
});

describe("refine helpers", () => {
  it("reports busy only while a refine is non-terminal", () => {
    expect(isRefineBusy([{ id: "r1", message: "x", status: "done", created_at: "" }])).toBe(false);
    expect(isRefineBusy([{ id: "r1", message: "x", status: "active", created_at: "" }])).toBe(true);
  });

  it("changes the activity signature when a run or refine settles", () => {
    const a = applyStatus(INITIAL_SESSION, { run: { id: "b1", status: "active" } });
    const b = applyStatus(a, { run: { id: "b1", status: "done" } });
    expect(activitySignature(a)).not.toBe(activitySignature(b));
    const c = { ...b, refines: [{ id: "r1", message: "x", status: "active", created_at: "" }] };
    const d = { ...b, refines: [{ id: "r1", message: "x", status: "done", created_at: "" }] };
    expect(activitySignature(c)).not.toBe(activitySignature(d));
  });
});

describe("shouldPollRefines", () => {
  const running = [{ id: "r1", message: "m", status: "active", created_at: "x" }];
  const done = [{ id: "r1", message: "m", status: "done", created_at: "x" }];

  it("polls off the JUST-FETCHED list, not the stale one", () => {
    expect(shouldPollRefines(running, [])).toBe(true);
  });

  it("stops when the fetched list has settled, even if the stale one was busy", () => {
    expect(shouldPollRefines(done, running)).toBe(false);
  });

  it("keeps polling off the last known list when the fetch failed", () => {
    expect(shouldPollRefines(null, running)).toBe(true);
    expect(shouldPollRefines(null, done)).toBe(false);
  });
});

describe("previewRevisionOf", () => {
  const r = (id: string, status: string) => ({ id, message: "m", status, created_at: "" });

  it("is initial before any refine has finished", () => {
    expect(previewRevisionOf([])).toBe("initial");
    expect(previewRevisionOf([r("a", "queued")])).toBe("initial");
  });

  it("does not move when a change is submitted or starts running", () => {
    const before = previewRevisionOf([r("a", "done")]);
    expect(previewRevisionOf([r("a", "done"), r("b", "queued")])).toBe(before);
    expect(previewRevisionOf([r("a", "done"), r("b", "running")])).toBe(before);
  });

  it("moves once the change lands, or fails", () => {
    const before = previewRevisionOf([r("a", "done")]);
    expect(previewRevisionOf([r("a", "done"), r("b", "done")])).not.toBe(before);
    expect(previewRevisionOf([r("a", "done"), r("b", "failed")])).not.toBe(before);
  });
});

describe("applyStatus — app ready and publish", () => {
  const status = (id: string, runStatus: string, appReady: boolean, publish: unknown) =>
    ({ run: { id, status: runStatus, stages: [] }, app_ready: appReady, publish }) as never;
  const publishing = { status: "publishing", started_at: "2026-09-29T07:12:40Z", url: "https://b.onrender.com" };

  it("carries app_ready and publish, and pins the first ready observation", () => {
    const t1 = Date.parse("2026-09-29T07:13:00Z");
    const first = applyStatus(INITIAL_SESSION, status("run-1", "active", true, publishing), t1);
    expect(first.appReady).toBe(true);
    expect(first.appReadyAt).toBe("2026-09-29T07:13:00.000Z");
    expect(first.publish).toEqual({ status: "publishing", startedAt: "2026-09-29T07:12:40Z", url: "https://b.onrender.com", retryable: false });
    const later = applyStatus(first, status("run-1", "active", true, publishing), t1 + 600_000);
    expect(later.appReadyAt).toBe("2026-09-29T07:13:00.000Z");
    const live = applyStatus(later, status("run-1", "done", false, { status: "live", started_at: null, url: "https://b.com" }), t1 + 900_000);
    expect(live.appReady).toBe(false);
    expect(live.appReadyAt).toBeNull();
    expect(live.publish.status).toBe("live");
  });

  it("does not inherit another run's ready time", () => {
    const first = applyStatus(INITIAL_SESSION, status("run-1", "active", true, publishing), Date.parse("2026-09-29T07:13:00Z"));
    const other = applyStatus(first, status("run-2", "active", true, publishing), Date.parse("2026-09-29T09:00:00Z"));
    expect(other.appReadyAt).toBe("2026-09-29T09:00:00.000Z");
  });

  it("reads a response without the new fields as not ready and nothing publishing", () => {
    const snap = applyStatus(INITIAL_SESSION, { run: { id: "run-1", status: "active" } });
    expect(snap.appReady).toBe(false);
    expect(snap.publish).toEqual({ status: "none", startedAt: null, url: null, retryable: false });
  });
});

describe("undo on a site that was never published", () => {
  const LIVE_DID_NOT_UPDATE =
    "The change was undone, but the live site didn't update. Publish your site again to put the undo live.";

  it("preview_only says the change was undone in the preview and never mentions a live site", () => {
    const notice = undoSuccessNotice({ preview_only: true, republished: false, draft_reset: true });
    expect(notice).toBe("The change was undone in your preview. Click Publish to put it live.");
    expect(notice).not.toMatch(/live site|Publish your site again/);
  });

  it("republished false without preview_only keeps today's warning", () => {
    expect(undoSuccessNotice({ republished: false, draft_reset: true })).toBe(LIVE_DID_NOT_UPDATE);
    expect(undoSuccessNotice({ republished: false, preview_only: false })).toBe(LIVE_DID_NOT_UPDATE);
    expect(undoSuccessNotice({ republished: false, preview_only: "true" })).toBe(LIVE_DID_NOT_UPDATE);
  });

  it("a republished undo is unchanged: no notice", () => {
    expect(undoSuccessNotice({ republished: true, draft_reset: true })).toBeNull();
    expect(undoSuccessNotice(null)).toBeNull();
  });

  it("preview_stale adds that the preview may be out of date and catches up with the next change", () => {
    const notice = undoSuccessNotice({ preview_only: true, preview_stale: true, republished: false, draft_reset: true });
    expect(notice).toBe(
      "The change was undone in your preview. Click Publish to put it live. The preview may be out of date. It catches up with your next change.",
    );
    expect(isPlainUndoNotice(notice!)).toBe(true);
    expect(isPlainUndoNotice("The change was undone in your preview. Click Publish to put it live.")).toBe(true);
    expect(undoSuccessNotice({ preview_only: true, preview_stale: false })).toBe("The change was undone in your preview. Click Publish to put it live.");
  });

  it("a warning that needs the user to act is never styled as a plain line", () => {
    expect(isPlainUndoNotice(undoSuccessNotice({ republished: false })!)).toBe(false);
    expect(isPlainUndoNotice(undoSuccessNotice({ preview_only: true, draft_reset: false })!)).toBe(false);
  });

  it("preview_only still warns when the preview draft was not reset", () => {
    expect(undoSuccessNotice({ preview_only: true, republished: false, draft_reset: false })).toBe(
      "The change was undone in your preview. Click Publish to put it live. Your preview may still show the old change. Discard the preview draft before your next edit.",
    );
  });
});

describe("photos missing (build status)", () => {
  it("reads only a missing-photos block, with a default line and free unless paid", async () => {
    const { readPhotosMissing } = await import("./useBuildSession");
    expect(readPhotosMissing(undefined)).toBeNull();
    expect(readPhotosMissing({ status: "ok" })).toBeNull();
    expect(readPhotosMissing({ status: "missing", reason: "No photos.", retry: "paid" })).toEqual({ reason: "No photos.", retry: "paid" });
    expect(readPhotosMissing({ status: "missing", retry: "x" })).toEqual({ reason: "Photos couldn't be added to your site.", retry: "free" });
  });
});
