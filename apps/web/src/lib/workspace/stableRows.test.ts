import { describe, expect, it } from "vitest";
import { shareStableRowMap, shareStableRows } from "./stableRows";

type Row = { id: string; body: { text: string }; artifacts?: string[] };

const row = (id: string, text: string, artifacts?: string[]): Row => ({
  id,
  body: { text },
  ...(artifacts ? { artifacts } : {}),
});

describe("shareStableRows", () => {
  it("returns the previous array when a refetch changed nothing", () => {
    const prev = [row("a", "hi"), row("b", "there")];
    const next = [row("a", "hi"), row("b", "there")];
    expect(shareStableRows(prev, next)).toBe(prev);
  });

  it("keeps unchanged rows' identity and swaps only the changed one", () => {
    const prev = [row("a", "hi"), row("b", "draft")];
    const next = [row("a", "hi"), row("b", "final")];
    const out = shareStableRows(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
  });

  it("treats a late-attached field as a change (artifact chips appear)", () => {
    const prev = [row("a", "report")];
    const next = [row("a", "report", ["file.pdf"])];
    const out = shareStableRows(prev, next);
    expect(out[0]).toBe(next[0]);
  });

  it("reuses rows by id when a new row is appended", () => {
    const prev = [row("a", "hi")];
    const next = [row("a", "hi"), row("b", "new")];
    const out = shareStableRows(prev, next);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
  });

  it("does not return prev when a row was removed", () => {
    const prev = [row("a", "hi"), row("b", "gone")];
    const next = [row("a", "hi")];
    const out = shareStableRows(prev, next);
    expect(out).toEqual([prev[0]]);
    expect(out).not.toBe(prev);
  });

  it("does not return prev when rows were reordered", () => {
    const prev = [row("a", "1"), row("b", "2")];
    const next = [row("b", "2"), row("a", "1")];
    const out = shareStableRows(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
  });

  it("switching to another thread yields that thread's rows", () => {
    const prev = [row("a", "thread A")];
    const next = [row("x", "thread B")];
    expect(shareStableRows(prev, next)).toEqual(next);
  });
});

describe("shareStableRowMap", () => {
  it("keeps an empty map's identity", () => {
    const prev = new Map<string, Row[]>();
    expect(shareStableRowMap(prev, new Map())).toBe(prev);
  });

  it("returns prev when every run's rows are unchanged", () => {
    const prev = new Map([["run1", [row("t1", "tool")]]]);
    const next = new Map([["run1", [row("t1", "tool")]]]);
    expect(shareStableRowMap(prev, next)).toBe(prev);
  });

  it("returns a new map when a run gained activity", () => {
    const prev = new Map([["run1", [row("t1", "tool")]]]);
    const next = new Map([["run1", [row("t1", "tool"), row("t2", "tool")]]]);
    const out = shareStableRowMap(prev, next);
    expect(out).not.toBe(prev);
    expect(out.get("run1")?.[0]).toBe(prev.get("run1")?.[0]);
  });
});
