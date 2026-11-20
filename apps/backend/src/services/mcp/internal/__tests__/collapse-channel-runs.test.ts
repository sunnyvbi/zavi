
import { describe, it, expect } from "vitest";
import { collapseChannelRuns } from "@/services/mcp/internal/praxis-corpus";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("collapseChannelRuns", () => {
  it("collapses a channel run to ONE row so it cannot crowd out other pending work", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({
        decision_id: `seo-${i}`,
        decision_class: "channel.recipe_step",
        agent_run_id: "run-1",
        body: { position: i + 1, of: 5, step: { title: `s${i}` } },
      })),
      {
        decision_id: "old-1",
        decision_class: "engineer.ship-pr",
        agent_run_id: "run-9",
        body: {},
      },
    ];
    const out = collapseChannelRuns(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      decision_class: "channel.recipe_step",
      actions_in_run: 5,
    });
    expect(out.find((r) => r.decision_id === "old-1")).toBeTruthy();
  });

  it("keeps the FIRST action of the run — emit order is the agent's ranking", () => {
    const rows = [
      {
        decision_id: "a",
        decision_class: "channel.recipe_step",
        agent_run_id: "r",
        body: { position: 1 },
      },
      {
        decision_id: "b",
        decision_class: "channel.recipe_step",
        agent_run_id: "r",
        body: { position: 2 },
      },
    ];
    expect(collapseChannelRuns(rows)[0].decision_id).toBe("a");
  });

  it("leaves non-channel decisions exactly as they were", () => {
    const rows = [
      {
        decision_id: "a",
        decision_class: "engineer.ship-pr",
        agent_run_id: "r",
        body: {},
      },
    ];
    expect(collapseChannelRuns(rows)).toEqual(rows);
  });

  it("does not merge two DIFFERENT runs of the same channel class", () => {
    const rows = [
      { decision_id: "a", decision_class: "channel.recipe_step", agent_run_id: "r1" },
      { decision_id: "b", decision_class: "channel.recipe_step", agent_run_id: "r2" },
    ];
    expect(collapseChannelRuns(rows)).toHaveLength(2);
  });

  it("passes through a channel row with no run id rather than merging on null", () => {
    const rows = [
      { decision_id: "a", decision_class: "channel.recipe_step", agent_run_id: null },
      { decision_id: "b", decision_class: "channel.recipe_step", agent_run_id: null },
    ];
    expect(collapseChannelRuns(rows)).toHaveLength(2);
  });

  it("does not mutate the caller's rows", () => {
    const rows = [
      { decision_id: "a", decision_class: "channel.recipe_step", agent_run_id: "r" },
      { decision_id: "b", decision_class: "channel.recipe_step", agent_run_id: "r" },
    ];
    collapseChannelRuns(rows);
    expect(rows[0]).not.toHaveProperty("actions_in_run");
  });
});

describe("praxis-corpus pending window", () => {
  const src = readFileSync(join(__dirname, "../praxis-corpus.ts"), "utf8");

  it("collapses BEFORE capping the returned rows", () => {
    expect(src).toMatch(/\.limit\(PENDING_FETCH_CAP\)/);
    expect(src).toMatch(/collapseChannelRuns\(mapped\)\.slice\(0, PENDING_ROW_CAP\)/);
  });

  it("tells the agent it is seeing runs, not individual actions", () => {
    expect(src).toMatch(/A channel run appears ONCE, not once per action/);
  });

  it("exposes runs_n so 'stuck in proposed' does not read N times worse than reality", () => {
    expect(src).toMatch(/runs_n: b\.proposed_runs\.size/);
  });
});
