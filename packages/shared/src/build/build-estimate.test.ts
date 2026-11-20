import { describe, expect, it } from "vitest";
import {
  WAITING_FOR_PICK,
  buildEstimateText,
  buildRemainingMs,
  stageExpectedMs,
  type EstimateStage,
} from "./build-estimate";
import * as shared from "../index";

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T10:00:00Z");

const parked: EstimateStage[] = [
  { status: "done", expected_ms: stageExpectedMs("provision", true) },
  { status: "done", expected_ms: stageExpectedMs("spec", true) },
  { status: "pending", expected_ms: stageExpectedMs("scaffold", true) },
  { status: "pending", expected_ms: stageExpectedMs("build", true) },
  { status: "pending", expected_ms: stageExpectedMs("qa", true) },
  { status: "pending", expected_ms: stageExpectedMs("deploy", true) },
];

const running: EstimateStage[] = [
  { status: "done", expected_ms: 1 * MIN },
  { status: "running", started_at: new Date(T0).toISOString(), expected_ms: 10 * MIN },
  { status: "pending", expected_ms: 3 * MIN },
];

describe("build estimate while the build waits for the founder's look pick", () => {
  it("a parked build has a full budget left, which is exactly the number the founder must not see", () => {
    expect(buildRemainingMs(parked, T0)).toBe((25 + 7 + 8 + 3) * MIN);
    expect(buildEstimateText(parked, T0)).toBe("About 43 minutes left");
  });

  it("awaiting a pick: no minutes, the text is the waiting line and nothing else", () => {
    expect(buildRemainingMs(parked, T0, { awaitingPick: true })).toBeNull();
    const text = buildEstimateText(parked, T0, { awaitingPick: true });
    expect(text).toBe("Waiting for you to pick a website");
    expect(text).toBe(WAITING_FOR_PICK);
    expect(text).not.toMatch(/minute|left/i);
  });

  it("never counts down: the waiting line stays the same however long the founder takes", () => {
    for (const at of [T0, T0 + 30_001, T0 + 6 * 60 * MIN]) {
      expect(buildEstimateText(running, at, { awaitingPick: true })).toBe(WAITING_FOR_PICK);
      expect(buildRemainingMs(running, at, { awaitingPick: true })).toBeNull();
    }
    expect(WAITING_FOR_PICK).not.toMatch(/\d|start|recommended/i);
  });

  it("waiting wins over stages that would otherwise give no estimate", () => {
    expect(buildEstimateText([], T0, { awaitingPick: true })).toBe(WAITING_FOR_PICK);
    expect(buildEstimateText([{ status: "pending", expected_ms: null }], T0, { awaitingPick: true })).toBe(WAITING_FOR_PICK);
  });

  it("once the pick lands (awaitingPick false or absent) the real estimate comes straight back", () => {
    expect(buildEstimateText(running, T0 + 4 * MIN, { awaitingPick: false })).toBe("About 9 minutes left");
    expect(buildEstimateText(running, T0 + 4 * MIN, {})).toBe("About 9 minutes left");
    expect(buildEstimateText(running, T0 + 4 * MIN)).toBe("About 9 minutes left");
    expect(buildRemainingMs(running, T0 + 4 * MIN, { awaitingPick: false })).toBe(9 * MIN);
  });

  it("only a literal true means waiting: a truthy non-boolean from a loose payload does not hide the estimate", () => {
    const loose = { awaitingPick: "true" } as unknown as { awaitingPick: boolean };
    expect(buildEstimateText(running, T0 + 4 * MIN, loose)).toBe("About 9 minutes left");
  });

  it("the waiting line and option reach every app through the package entry", () => {
    expect(shared.WAITING_FOR_PICK).toBe("Waiting for you to pick a website");
    expect(shared.buildEstimateText(parked, T0, { awaitingPick: true })).toBe(WAITING_FOR_PICK);
  });
});

describe("site build estimate near the end", () => {
  it("is within about 2 minutes of a typical site build (build stage p50 5.3 min on staging, 2026-10-13)", () => {
    const start = Date.parse("2026-10-13T07:00:00Z");
    const stages = [
      { status: "done", expected_ms: stageExpectedMs("provision", true) },
      { status: "running", started_at: new Date(start).toISOString(), expected_ms: stageExpectedMs("build", true) },
    ];
    const fourMinutesIn = start + 4 * 60_000;
    const left = buildRemainingMs(stages, fourMinutesIn)!;
    expect(left).toBeLessThanOrEqual(1.3 * 60_000 + 2 * 60_000);
    expect(buildEstimateText(stages, fourMinutesIn)).toBe("About 3 minutes left");
  });
});
