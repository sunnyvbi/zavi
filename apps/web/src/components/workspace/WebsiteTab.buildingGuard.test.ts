// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { shouldShowStoppedBuildPane, shouldShowWebsiteBuildProgress } from "./WebsiteTab";

const bools = [false, true] as const;

function* states() {
  for (const building of bools)
    for (const appReady of bools)
      for (const checkpoint of bools)
        for (const liveFramed of bools)
          for (const sandboxDraftShown of bools)
            for (const buildStarting of bools)
              for (const buildFailed of bools)
                for (const stoppedByFounder of bools)
                  for (const previewUrl of [null, "https://3000-sbx.e2b.app"])
                    for (const settledNonce of [0, 1])
                      yield { building, appReady, checkpoint, liveFramed, sandboxDraftShown, buildStarting, buildFailed, stoppedByFounder, previewUrl, settledNonce };
}

describe("the Build preview never frames an app that is still building", () => {
  it("every state a still-building guard would cover is already taken by the progress pane or the stopped pane", () => {
    let covered = 0;
    for (const s of states()) {
      const stillBuilding = s.building && !s.appReady && !s.checkpoint && !s.liveFramed && !s.sandboxDraftShown;
      if (!stillBuilding) continue;
      covered += 1;
      const stopped = shouldShowStoppedBuildPane({
        isBuild: true,
        stoppedByFounder: s.stoppedByFounder,
        buildStarting: s.buildStarting,
        viewingCheckpoint: s.checkpoint,
      });
      const progress = shouldShowWebsiteBuildProgress(
        s.previewUrl,
        s.building,
        s.buildStarting,
        s.buildFailed,
        s.settledNonce,
        s.appReady || s.checkpoint || s.liveFramed || s.sandboxDraftShown,
      );
      expect(stopped || progress).toBe(true);
    }
    expect(covered).toBe(32);
  });
});
