import { describe, it, expect, vi, beforeEach } from "vitest";

let live = false;
let down = false;
const reads: string[] = [];
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async (key: string) => {
    reads.push(key);
    if (down) throw new Error("settings read failed");
    return live;
  },
}));

import { liveReviewMeta } from "../post-run";

beforeEach(() => {
  reads.length = 0;
  down = false;
});

describe("liveReviewMeta", () => {
  it("queued on, switched off since: does not act", async () => {
    live = false;
    expect((await liveReviewMeta("t", { note_kind: "scheduled", autopilot: true })).autopilot).toBe(false);
    expect(reads).toEqual(["cgo_autopilot_enabled"]);
  });

  it("queued on, still on: acts", async () => {
    live = true;
    expect((await liveReviewMeta("t", { autopilot: true })).autopilot).toBe(true);
  });

  it("a failed read throws (the run fails before writing a note), never a silent advice run", async () => {
    down = true;
    await expect(liveReviewMeta("t", { autopilot: true })).rejects.toThrow("settings read failed");
  });

  it("queued as advice, switched on since: stays advice, no read needed", async () => {
    live = true;
    expect((await liveReviewMeta("t", { autopilot: false })).autopilot).toBe(false);
    expect(reads).toEqual([]);
  });
});
