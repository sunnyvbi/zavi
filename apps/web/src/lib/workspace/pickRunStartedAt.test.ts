
import { describe, it, expect } from "vitest";
import { pickRunStartedAt } from "./useChatThread";

const RS = "2026-06-30T10:00:00.000Z";
const USER = "2026-06-30T10:00:01.000Z";
const STARTED = "2026-06-30T10:00:02.000Z";
const ENQ = "2026-06-30T10:00:03.000Z";

describe("pickRunStartedAt", () => {
  it("run_start created_at wins over everything (ETA-basis invariant)", () => {
    expect(
      pickRunStartedAt({
        rsCreatedAt: RS,
        userMsgCreatedAt: USER,
        runTimes: { started_at: STARTED, enqueued_at: ENQ },
      }),
    ).toBe(RS);
  });

  it("falls back to user message created_at when no run_start", () => {
    expect(
      pickRunStartedAt({
        rsCreatedAt: null,
        userMsgCreatedAt: USER,
        runTimes: { started_at: STARTED, enqueued_at: ENQ },
      }),
    ).toBe(USER);
  });

  it("falls back to the run row's started_at when no event and no user msg", () => {
    expect(
      pickRunStartedAt({
        rsCreatedAt: null,
        userMsgCreatedAt: null,
        runTimes: { started_at: STARTED, enqueued_at: ENQ },
      }),
    ).toBe(STARTED);
  });

  it("falls back to enqueued_at when started_at is null (queued run row)", () => {
    expect(
      pickRunStartedAt({
        rsCreatedAt: null,
        userMsgCreatedAt: null,
        runTimes: { started_at: null, enqueued_at: ENQ },
      }),
    ).toBe(ENQ);
  });

  it("treats undefined the same as null in the chain", () => {
    expect(
      pickRunStartedAt({
        runTimes: { started_at: null, enqueued_at: ENQ },
      }),
    ).toBe(ENQ);
  });

  it("returns null only when every source is absent", () => {
    expect(
      pickRunStartedAt({
        rsCreatedAt: null,
        userMsgCreatedAt: null,
        runTimes: null,
      }),
    ).toBeNull();
    expect(pickRunStartedAt({})).toBeNull();
  });
});
