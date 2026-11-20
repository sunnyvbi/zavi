
import { describe, expect, it } from "vitest";
import { nextSteps } from "./progress-state";
import { isRenderableStep, type ProgressStep } from "./api";

const step = (label: string): ProgressStep => ({ type: "step", key: label, label, state: "done" });
const SLACK = [step("Checked Slack"), step("Checked Stripe")];
const BRAIN = [step("Checked your company brain")];

describe("a progress reply that outlived its turn", () => {
  it("is dropped, leaving what is on screen alone", () => {
    expect(
      nextSteps({ incoming: SLACK, mySeq: 1, currentSeq: 2, previous: [] }),
    ).toEqual([]);
    expect(
      nextSteps({ incoming: SLACK, mySeq: 1, currentSeq: 2, previous: BRAIN }),
    ).toEqual(BRAIN);
  });

  it("is dropped however far behind it is", () => {
    for (const currentSeq of [2, 7, 99]) {
      expect(nextSteps({ incoming: SLACK, mySeq: 1, currentSeq, previous: [] })).toEqual([]);
    }
  });
});

describe("a reply for the current turn", () => {
  it("is shown", () => {
    expect(
      nextSteps({ incoming: SLACK, mySeq: 3, currentSeq: 3, previous: [] }),
    ).toEqual(SLACK);
  });

  it("REPLACES the list even when it is empty", () => {
    expect(
      nextSteps({ incoming: [], mySeq: 3, currentSeq: 3, previous: SLACK }),
    ).toEqual([]);
  });

  it("does not merge — the reply is the whole truth for that turn", () => {
    expect(
      nextSteps({ incoming: BRAIN, mySeq: 3, currentSeq: 3, previous: SLACK }),
    ).toEqual(BRAIN);
  });
});

describe("isRenderableStep", () => {
  const ok = { type: "step", key: "k", label: "Request received", state: "done" };
  const call = { key: "t", name: "search", input: '{"q":"pricing"}', output: "4 notes", ms: 0, state: "done" };
  const group = { type: "group", key: "g", label: "Checked your database", count: 1, state: "done", tools: [call] };
  const thought = { type: "thought", key: "th", text: "Hmm, that total looks wrong — checking one row." };

  it("accepts a step, a thought and a group", () => {
    expect(isRenderableStep(ok)).toBe(true);
    expect(isRenderableStep(thought)).toBe(true);
    expect(isRenderableStep(group)).toBe(true);
  });

  it("bounds a thought, and refuses an empty one", () => {
    expect(isRenderableStep({ ...thought, text: "" })).toBe(false);
    expect(isRenderableStep({ ...thought, text: "x".repeat(401) })).toBe(false);
    expect(isRenderableStep({ ...thought, text: 7 })).toBe(false);
  });

  it("rejects a group whose calls are malformed, or missing", () => {
    expect(isRenderableStep({ ...group, tools: [] })).toBe(false);
    expect(isRenderableStep({ ...group, tools: [{ ...call, name: "" }] })).toBe(false);
    expect(isRenderableStep({ ...group, tools: [{ ...call, ms: "quick" }] })).toBe(false);
    expect(isRenderableStep({ ...group, tools: [{ ...call, output: "x".repeat(401) }] })).toBe(false);
    expect(isRenderableStep({ ...ok, type: "chart" })).toBe(false);
  });

  it("allows `__` in a call name but never in a group label", () => {
    expect(isRenderableStep({ ...group, tools: [{ ...call, name: "memory__search" }] })).toBe(true);
    expect(isRenderableStep({ ...group, label: "memory__search" })).toBe(false);
  });

  it("rejects a raw tool name, which passes every other check", () => {
    expect(
      isRenderableStep({ ...ok, label: "mcp__server__slack__read_thread" }),
    ).toBe(false);
    expect(isRenderableStep({ ...ok, label: "memory__search" })).toBe(false);
  });

  it("rejects the wrong shape rather than drawing it", () => {
    expect(isRenderableStep(null)).toBe(false);
    expect(isRenderableStep("a string")).toBe(false);
    expect(isRenderableStep({ ...ok, state: "exploded" })).toBe(false);
    expect(isRenderableStep({ ...ok, label: "" })).toBe(false);
    expect(isRenderableStep({ ...ok, key: 7 })).toBe(false);
    expect(isRenderableStep({ ...ok, label: "x".repeat(81) })).toBe(false);
  });

  it("does NOT enforce the backend's vocabulary — an English phrase passes", () => {
    expect(isRenderableStep({ ...ok, label: "Something nobody wrote yet" })).toBe(true);
  });
});
