
import { describe, it, expect } from "vitest";
import { pickTurnStartedAt } from "./useChatThread";

const USER = "2026-06-30T10:00:01.000Z";
const STARTED = "2026-06-30T10:00:02.000Z";
const ENQ = "2026-06-30T10:00:03.000Z";

describe("pickTurnStartedAt", () => {
  it("anchors to the user-send time (the turn clock)", () => {
    expect(
      pickTurnStartedAt({
        userMsgCreatedAt: USER,
        runTimes: { started_at: STARTED, enqueued_at: ENQ },
      }),
    ).toBe(USER);
  });

  it("INVARIANT: a fresh run_start on a re-fired turn cannot move the anchor", () => {
    const firstFire = pickTurnStartedAt({
      userMsgCreatedAt: USER,
      runTimes: { started_at: STARTED, enqueued_at: ENQ },
    });
    const afterRefire = pickTurnStartedAt({
      userMsgCreatedAt: USER,
      runTimes: { started_at: "2026-06-30T10:20:00.000Z", enqueued_at: ENQ },
    });
    expect(afterRefire).toBe(firstFire);
    expect(afterRefire).toBe(USER);
  });

  it("falls back to the run's started_at when there is no user message (cron/handoff)", () => {
    expect(
      pickTurnStartedAt({
        userMsgCreatedAt: null,
        runTimes: { started_at: STARTED, enqueued_at: ENQ },
      }),
    ).toBe(STARTED);
  });

  it("falls back to enqueued_at when started_at is null (queued run row)", () => {
    expect(
      pickTurnStartedAt({
        userMsgCreatedAt: null,
        runTimes: { started_at: null, enqueued_at: ENQ },
      }),
    ).toBe(ENQ);
  });

  it("treats undefined the same as null in the chain", () => {
    expect(
      pickTurnStartedAt({ runTimes: { started_at: null, enqueued_at: ENQ } }),
    ).toBe(ENQ);
  });

  it("returns null only when every source is absent", () => {
    expect(
      pickTurnStartedAt({ userMsgCreatedAt: null, runTimes: null }),
    ).toBeNull();
    expect(pickTurnStartedAt({})).toBeNull();
  });
});
