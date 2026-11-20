import { describe, expect, it } from "vitest";
import { evaluateTrial, type OrganicTrialEvaluationInput } from "../x-organic-trial-evaluation";

const PUBLISHED = "2026-01-10T12:00:00.000Z";
const DUE = "2026-01-13T12:00:00.000Z";
const NOW = Date.parse(DUE);
const input = (patch: Partial<OrganicTrialEvaluationInput> = {}): OrganicTrialEvaluationInput => ({
  posts: ["103", "101", "102"].map(id => ({ id, publishedAt: PUBLISHED })),
  metrics: [{ id: "103", replies: 2 }, { id: "101", replies: 5 }, { id: "102", replies: 1 }],
  fetchedAt: DUE,
  now: NOW,
  ...patch,
});

describe("evaluateTrial", () => {
  it("keeps the trial waiting one millisecond before three complete days", () => {
    expect(evaluateTrial(input({ now: NOW - 1, fetchedAt: new Date(NOW - 1).toISOString() })))
      .toEqual({ kind: "waiting_window", dueAt: DUE });
  });

  it("selects the largest measured reply count at the exact deadline", () => {
    expect(evaluateTrial(input())).toEqual({
      kind: "winner", dueAt: DUE, observedAt: DUE,
      winner: { id: "101", replies: 5 }, tiedIds: [],
    });
  });

  it("starts the window from the last actual publication, not the first", () => {
    const delayed = input();
    delayed.posts = [...delayed.posts.slice(0, 2), { id: "102", publishedAt: "2026-01-11T18:00:00.000Z" }];
    expect(evaluateTrial(delayed)).toEqual({ kind: "waiting_window", dueAt: "2026-01-14T18:00:00.000Z" });
  });

  it("uses elapsed days across a daylight-saving change", () => {
    const date = "2026-03-07T12:00:00-05:00";
    const due = "2026-03-10T17:00:00.000Z";
    const args = input({ posts: input().posts.map(p => ({ ...p, publishedAt: date })), now: Date.parse(due), fetchedAt: due });
    expect(evaluateTrial(args)).toMatchObject({ kind: "winner", dueAt: due });
  });

  it("supports a positive integral configured observation window", () => {
    expect(evaluateTrial(input({ days: 4 })))
      .toEqual({ kind: "waiting_window", dueAt: "2026-01-14T12:00:00.000Z" });
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("does not run early with invalid days %s", days => {
    expect(evaluateTrial(input({ days }))).toEqual({ kind: "waiting_publication", dueAt: null });
  });

  it.each([NaN, Infinity, -Infinity])("does not select a winner with invalid clock %s", now => {
    expect(evaluateTrial(input({ now }))).toEqual({ kind: "waiting_publication", dueAt: null });
  });

  it.each([[], input().posts.slice(0, 2), [...input().posts, { id: "104", publishedAt: PUBLISHED }]].map(posts => ({ posts })))
    ("requires exactly three publication receipts", ({ posts }) => {
      expect(evaluateTrial(input({ posts }))).toEqual({ kind: "waiting_publication", dueAt: null });
    });

  it.each([null, "", "not-a-date", "2026-01-14T00:00:00Z", "2026-01-10", "2026-01-10T12:00:00", "2025-02-29T12:00:00Z"])
    ("waits for a valid actual publication rather than %s", publishedAt => {
      expect(evaluateTrial(input({ posts: [...input().posts.slice(0, 2), { id: "102", publishedAt }] })))
        .toEqual({ kind: "waiting_publication", dueAt: null });
    });

  it("rejects duplicate publication receipts", () => {
    expect(evaluateTrial(input({ posts: [input().posts[0], input().posts[0], input().posts[2]] })))
      .toEqual({ kind: "waiting_publication", dueAt: null });
  });

  it.each(["", " ", "101 "])("rejects an invalid or ambiguous post id %j", id => {
    expect(evaluateTrial(input({ posts: [{ id, publishedAt: PUBLISHED }, ...input().posts.slice(1)] })))
      .toEqual({ kind: "waiting_publication", dueAt: null });
  });

  it.each([null, "bad-time", "2026-01-13T11:59:59.999Z", "2026-01-13T12:00:00.001Z"])
    ("does not use absent, stale or future metric timestamps (%s)", fetchedAt => {
      expect(evaluateTrial(input({ fetchedAt }))).toEqual({ kind: "waiting_metrics", dueAt: DUE });
    });

  it("does not call a missing post's replies zero", () => {
    expect(evaluateTrial(input({ metrics: input().metrics.slice(0, 2) })))
      .toEqual({ kind: "waiting_metrics", dueAt: DUE });
  });

  it.each([null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ("does not rank partial or invalid reply counts (%s)", replies => {
      expect(evaluateTrial(input({ metrics: [...input().metrics.slice(0, 2), { id: "102", replies }] })))
        .toEqual({ kind: "waiting_metrics", dueAt: DUE });
    });

  it.each([1, 99])("does not silently choose between duplicate metric rows (%s)", replies => {
    expect(evaluateTrial(input({ metrics: [...input().metrics, { id: "102", replies }] })))
      .toEqual({ kind: "waiting_metrics", dueAt: DUE });
  });

  it("never chooses an unrelated popular post", () => {
    const result = evaluateTrial(input({ metrics: [...input().metrics, { id: "unrelated", replies: 100000 }] }));
    expect(result).toMatchObject({ kind: "winner", winner: { id: "101", replies: 5 } });
  });

  it("does not let unknown metrics on an unrelated post block this trial", () => {
    expect(evaluateTrial(input({ metrics: [...input().metrics, { id: "unrelated", replies: null }] })))
      .toMatchObject({ kind: "winner" });
  });

  it("reports all measured zeroes without an ad winner", () => {
    expect(evaluateTrial(input({ metrics: input().metrics.map(p => ({ ...p, replies: 0 })) })))
      .toEqual({ kind: "no_replies", dueAt: DUE, observedAt: DUE });
  });

  it("breaks a positive tie lexically and reports which posts tied", () => {
    const metrics = [{ id: "103", replies: 7 }, { id: "101", replies: 7 }, { id: "102", replies: 2 }];
    const a = input({ metrics });
    const b = input({ posts: [...a.posts].reverse(), metrics: [...metrics].reverse() });
    const expected = { kind: "winner", dueAt: DUE, observedAt: DUE, winner: { id: "101", replies: 7 }, tiedIds: ["101", "103"] };
    expect(evaluateTrial(a)).toEqual(expected);
    expect(evaluateTrial(b)).toEqual(expected);
  });

  it("does not modify the publication or metric inputs", () => {
    const args = input();
    const before = JSON.stringify(args);
    evaluateTrial(args);
    expect(JSON.stringify(args)).toBe(before);
  });
});
