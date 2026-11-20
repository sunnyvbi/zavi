
import { describe, it, expect } from "vitest";
import { groupByRun, runProgress, splitClosed } from "./runGroup";

const act = (id: string, run: string, position: number, of = 5) => ({
  id,
  emitted_at: "2026-09-03T00:00:00Z",
  run_group: { run_id: run, position, of },
});

const lone = (id: string) => ({
  id,
  emitted_at: "2026-09-03T00:00:00Z",
  run_group: null,
});

describe("groupByRun", () => {
  it("folds one run's actions into a single row", () => {
    const rows = groupByRun([
      act("a", "run-1", 1),
      act("b", "run-1", 2),
      act("c", "run-1", 3),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe("run-1");
    expect(rows[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("orders a run's actions by position — the agent's own ranking", () => {
    const rows = groupByRun([
      act("c", "run-1", 3),
      act("a", "run-1", 1),
      act("b", "run-1", 2),
    ]);
    expect(rows[0].items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps two different runs apart", () => {
    const rows = groupByRun([act("a", "run-1", 1), act("b", "run-2", 1)]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.run_id)).toEqual(["run-1", "run-2"]);
  });

  it("gives a decision with no run_group its own row, unchanged", () => {
    const rows = groupByRun([lone("legacy"), act("a", "run-1", 1)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: "legacy", run_id: null });
    expect(rows[0].items).toHaveLength(1);
  });

  it("never merges two run-less decisions together", () => {
    const rows = groupByRun([lone("x"), lone("y")]);
    expect(rows).toHaveLength(2);
  });

  it("preserves the caller's ordering of rows", () => {
    const rows = groupByRun([lone("first"), act("a", "run-9", 1), lone("last")]);
    expect(rows.map((r) => r.key)).toEqual(["first", "run-9", "last"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupByRun([])).toEqual([]);
  });
});

describe("runProgress", () => {
  it("reports done as the total the emitter stamped minus what is left", () => {
    const rows = groupByRun([
      act("a", "run-1", 3),
      act("b", "run-1", 4),
      act("c", "run-1", 5),
    ]);
    expect(runProgress(rows[0])).toEqual({ remaining: 3, total: 5, done: 2, notDone: 0 });
  });

  it("reports zero done when every action is still pending", () => {
    const rows = groupByRun([act("a", "r", 1, 2), act("b", "r", 2, 2)]);
    expect(runProgress(rows[0])).toEqual({ remaining: 2, total: 2, done: 0, notDone: 0 });
  });

  it("never reports a negative done on a stale total", () => {
    const rows = groupByRun([act("a", "r", 1, 1), act("b", "r", 2, 1)]);
    expect(runProgress(rows[0])?.done).toBe(0);
  });

  it("is null for a row that is not a run", () => {
    expect(runProgress(groupByRun([lone("x")])[0])).toBeNull();
  });

  it("counts a snoozed action as deferred, not as done", () => {
    const rows = groupByRun([act("a", "run-1", 2, 3), act("b", "run-1", 3, 3)]);
    expect(runProgress(rows[0], 1)).toEqual({
      remaining: 2,
      total: 3,
      done: 0,
      notDone: 1,
    });
  });

  it("still counts an acted action as done, alongside a snoozed one", () => {
    const rows = groupByRun([act("c", "run-1", 3, 4), act("d", "run-1", 4, 4)]);
    expect(runProgress(rows[0], 1)).toEqual({
      remaining: 2,
      total: 4,
      done: 1,
      notDone: 1,
    });
  });

  it("counts nothing as deferred when the founder acted on all of them", () => {
    const rows = groupByRun([act("c", "run-1", 3, 4), act("d", "run-1", 4, 4)]);
    expect(runProgress(rows[0], 0)?.done).toBe(2);
  });
});

describe("splitClosed — shared by the panel row and the drawer header", () => {
  it("splits what left the list into finished and deferred", () => {
    expect(splitClosed(5, 2, 1)).toEqual({ remaining: 2, done: 2, notDone: 1 });
  });

  it("never lets a deferred count that raced the rows go negative", () => {
    expect(splitClosed(3, 3, 2)).toEqual({ remaining: 3, done: 0, notDone: 0 });
    expect(splitClosed(3, 1, 9)).toEqual({ remaining: 1, done: 0, notDone: 2 });
  });

  it("ignores a nonsense negative deferred count", () => {
    expect(splitClosed(3, 1, -4)).toEqual({ remaining: 1, done: 2, notDone: 0 });
  });
});

