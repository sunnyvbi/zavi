import { describe, it, expect } from "vitest";
import { workStateFor } from "../list";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-04T02:00:00.000Z");
const STALE = 2 * HOUR;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("workStateFor — the tile tells the truth about the run", () => {
  it("no run ever ⇒ idle (nobody has asked for work)", () => {
    expect(workStateFor(undefined, NOW, STALE)).toBe("idle");
  });

  it("a run in flight ⇒ running", () => {
    expect(
      workStateFor({ status: "running", started_at: at(2 * 60_000) }, NOW, STALE),
    ).toBe("running");
  });

  it("a queued run ⇒ running (it is real work, just not picked up yet)", () => {
    expect(
      workStateFor({ status: "queued", started_at: at(30_000) }, NOW, STALE),
    ).toBe("running");
  });

  it("a run stuck past the reap window ⇒ needs_review, NOT running", () => {
    expect(
      workStateFor({ status: "running", started_at: at(3 * HOUR) }, NOW, STALE),
    ).toBe("needs_review");
  });

  it("a failed run ⇒ needs_review (the drawer renders 'didn't finish')", () => {
    for (const status of ["failed", "dispatch_error", "parse_failed", "cancelled"]) {
      expect(
        workStateFor({ status, started_at: at(10 * 60_000) }, NOW, STALE),
      ).toBe("needs_review");
    }
  });

  it("a successful run ⇒ delivered", () => {
    expect(
      workStateFor({ status: "success", started_at: at(10 * 60_000) }, NOW, STALE),
    ).toBe("delivered");
  });

  it("the RUN wins over a stale cache that says running", () => {
    expect(
      workStateFor(
        { status: "failed", started_at: at(4 * HOUR) },
        NOW,
        STALE,
      ),
    ).toBe("needs_review");
  });

  it("a missing started_at believes the status rather than inventing an age", () => {
    expect(workStateFor({ status: "queued", started_at: null }, NOW, STALE)).toBe(
      "running",
    );
    expect(workStateFor({ status: "running", started_at: "nonsense" }, NOW, STALE)).toBe(
      "running",
    );
  });

  it("never returns a state the drawer cannot render", () => {
    const allowed = new Set(["idle", "running", "needs_review", "delivered"]);
    for (const status of ["queued", "running", "success", "failed", "weird_new_status"]) {
      expect(allowed.has(workStateFor({ status, started_at: at(60_000) }, NOW, STALE))).toBe(true);
    }
  });
});
