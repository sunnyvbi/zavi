import { describe, expect, it } from "vitest";
import { BUILD_CHECKS_FAILED, BUILD_FIXES_EXHAUSTED } from "@zavi/shared";
import { deriveAppReady, sitePublishState } from "@/services/build/app-ready";

const SMOKE = "The site's smoke check failed: journey \"open-times\" failed\nEvidence: no bookable times";

describe("what build-status sends the card for a publish whose final check failed", () => {
  it("a pressed publish that ran out of fixes carries the shared fixes-exhausted line, never the raw signal", () => {
    const state = sitePublishState({
      site_status: "building",
      run: {
        status: "failed",
        created_at: "2026-10-05T05:48:00.000Z",
        reason: `The site still failed its checks after 1 fix attempt(s): ${SMOKE}`,
        failure_class: "repair_exhausted",
      },
    });
    expect(state).toMatchObject({ status: "failed", reason: BUILD_FIXES_EXHAUSTED });
    expect(JSON.stringify(state)).not.toContain("open-times");
  });

  it("a pressed publish held back by the acceptance check carries the shared checks-failed line", () => {
    const state = sitePublishState({
      run: { status: "failed", created_at: "2026-10-05T05:48:00.000Z", reason: SMOKE, failure_class: "acceptance_failed" },
    });
    expect(state).toMatchObject({ status: "failed", reason: BUILD_CHECKS_FAILED });
  });

  it("a first publish whose fix pass is running is marked fixing, with no raw signal", () => {
    const graph = [
      { status: "done", payload: { stage: "build" } },
      { status: "dispatched", payload: { stage: "deploy" }, site_repair_pending: true, last_failure_signal: SMOKE },
    ];
    const state = deriveAppReady({ status: "active" }, graph);
    expect(state.publish).toMatchObject({ status: "publishing", fixing: true });
    expect(state.publish.reason).toBeUndefined();
  });

  it("a pressed publish running a fix pass is fixing; once the fix settles, or the run stops, it is not", () => {
    const run = { status: "active", created_at: "2026-10-05T05:48:00.000Z", reason: null };
    expect(sitePublishState({ run: { ...run, repairing: true } })).toEqual({
      status: "publishing",
      started_at: "2026-10-05T05:48:00.000Z",
      url: null,
      retryable: false,
      fixing: true,
    });
    expect(sitePublishState({ run: { ...run, repairing: false } })).not.toHaveProperty("fixing");
    expect(sitePublishState({ run: { ...run, status: "failed", repairing: true } })).not.toHaveProperty("fixing");
  });
});
