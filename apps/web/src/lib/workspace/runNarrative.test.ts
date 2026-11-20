import { describe, it, expect } from "vitest";
import type { RunPanel, RunPanelGroup, RunPanelItem } from "@zavi/shared";
import { asSettledPanel, liveLineText, narrativeSegments, secondsBetween, stepRows, usedToolsLabel } from "./runNarrative";

const g = (key: string, label: string, state: RunPanelGroup["state"] = "done"): RunPanelGroup => ({
  type: "group", key, label, count: 1, state, tools: [],
});
const t = (key: string, text: string): RunPanelItem => ({ type: "thought", key, text });

describe("narrativeSegments", () => {
  it("each sentence owns the steps after it", () => {
    const s = narrativeSegments([t("a", "Checking now."), g("g1", "Read Google Ads"), g("g2", "Checked imports"), t("b", "Both accepted."), g("g3", "Queried the queue")]);
    expect(s.map((x) => [x.key, x.thought?.text, x.groups.map((y) => y.key)])).toEqual([
      ["a", "Checking now.", ["g1", "g2"]],
      ["b", "Both accepted.", ["g3"]],
    ]);
  });

  it("steps before any sentence form a leading segment with no sentence", () => {
    const s = narrativeSegments([g("g1", "Read X"), t("a", "Now Y.")]);
    expect(s[0]?.key).toBe("g1");
    expect(s[0]?.thought).toBeUndefined();
    expect(s[1]?.key).toBe("a");
  });

  it("two sentences in a row: the first has no steps", () => {
    const s = narrativeSegments([t("a", "One."), t("b", "Two."), g("g1", "Read X")]);
    expect(s.map((x) => x.groups.length)).toEqual([0, 1]);
  });

  it("drops start-up and drafting steps", () => {
    expect(narrativeSegments([{ type: "step", key: "s", label: "Request received", state: "done" }])).toEqual([]);
  });
});

describe("the folded and live step lines (chat UX option A, 2026-10-23)", () => {
  const db = (key: string, count: number, state: RunPanelGroup["state"] = "done"): RunPanelGroup => ({ ...g(key, "Checked your database", state), count });
  it("folds finished steps to a tool count, with the run time when known", () => {
    expect(usedToolsLabel([db("1", 2), g("2", "Checked your ads"), db("3", 4)])).toBe("Used 7 tools");
    expect(usedToolsLabel([g("1", "Checked your ads")], 41)).toBe("Used 1 tool · 41s");
    expect(usedToolsLabel([g("1", "Checked your ads")], 72)).toBe("Used 1 tool · 1m 12s");
    expect(usedToolsLabel([g("1", "Checked your ads")], 0.2)).toBe("Used 1 tool");
  });
  it("names each kind of step once when opened, adding up its calls", () => {
    expect(stepRows([db("1", 2), g("2", "Checked your ads"), db("3", 4, "failed")]).map((r) => [r.label, r.count, r.state])).toEqual([
      ["Checked your database", 6, "failed"],
      ["Checked your ads", 1, "done"],
    ]);
  });
  it("the live line is the running step, else reading results, else thinking", () => {
    expect(liveLineText([g("1", "Read Google Ads"), g("2", "Queried the queue", "running")])).toBe("Queried the queue…");
    expect(liveLineText([g("1", "Read Google Ads")])).toBe("Reading the results…");
    expect(liveLineText([])).toBe("Thinking…");
  });
  it("measures a run only from two good times in order", () => {
    expect(secondsBetween("2026-10-23T12:00:00Z", "2026-10-23T12:00:41Z")).toBe(41);
    expect(secondsBetween(null, "2026-10-23T12:00:41Z")).toBeNull();
    expect(secondsBetween("2026-10-23T12:01:00Z", "2026-10-23T12:00:00Z")).toBeNull();
  });
});

describe("asSettledPanel — a specialist whose reply landed while the poll still says running", () => {
  const running: RunPanel = {
    state: "running",
    summary: "Checked your ads…",
    toolCount: 1,
    items: [
      { type: "thought", key: "a", text: "Pulling the campaign numbers." },
      { type: "group", key: "g", label: "Checked your ads", count: 1, state: "running", tools: [{ key: "t", name: "report", state: "running" } as RunPanelGroup["tools"][number]] },
      { type: "thought", key: "b", text: "Spend is flat week over week.", live: true },
      { type: "step", key: "drafting", label: "Writing your answer", state: "running" },
    ],
  };
  it("draws it settled: the closing sentence (the answer) is dropped and nothing spins", () => {
    const p = asSettledPanel(running);
    expect(p.state).toBe("finished");
    expect(p.items.map((i) => i.type)).toEqual(["thought"]);
    expect((p.items[0] as { text: string }).text).toBe("Pulling the campaign numbers.");
  });
  it("never claims a call succeeded that the poll still shows running (the reply may be a failure)", () => {
    const p = asSettledPanel(running);
    expect(p.items.some((i) => i.type === "group" && i.state === "done")).toBe(false);
  });
  it("keeps finished and failed calls as they were", () => {
    const failed: RunPanelGroup = { type: "group", key: "f", label: "Checked your ads", count: 1, state: "failed", tools: [] };
    const p = asSettledPanel({ ...running, items: [running.items[0], failed, ...running.items.slice(1)] });
    expect(p.items).toContainEqual(failed);
  });
  it("leaves an already-settled panel untouched", () => {
    const done = { ...running, state: "finished" as const };
    expect(asSettledPanel(done)).toBe(done);
  });
});
