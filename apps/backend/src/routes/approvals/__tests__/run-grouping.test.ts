
import { describe, it, expect } from "vitest";
import { runGroupOf } from "@/routes/approvals/list";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("runGroupOf", () => {
  it("labels each channel action with its position in the run", () => {
    const rows = [
      {
        agent_run_id: "run-1",
        body: { position: 1, of: 5, step: { title: "Add an H1" } },
      },
      {
        agent_run_id: "run-1",
        body: { position: 2, of: 5, step: { title: "Fix /sell" } },
      },
    ];
    expect(runGroupOf(rows[0])).toEqual({
      run_id: "run-1",
      position: 1,
      of: 5,
    });
    expect(runGroupOf(rows[1])?.position).toBe(2);
  });

  it("leaves run_group null for a decision that is not part of a fanned-out run", () => {
    expect(runGroupOf({ agent_run_id: "run-2", body: {} })).toBeNull();
  });

  it("is null when the run id is missing, even with a position", () => {
    expect(runGroupOf({ agent_run_id: null, body: { position: 1, of: 2 } })).toBeNull();
  });

  it("is null for a partial or non-numeric position/of rather than guessing", () => {
    expect(runGroupOf({ agent_run_id: "r", body: { position: 1 } })).toBeNull();
    expect(runGroupOf({ agent_run_id: "r", body: { of: 3 } })).toBeNull();
    expect(
      runGroupOf({ agent_run_id: "r", body: { position: "1", of: "3" } }),
    ).toBeNull();
  });

  it("tolerates a null body", () => {
    expect(runGroupOf({ agent_run_id: "r", body: null })).toBeNull();
  });
});

describe("approvals list route", () => {
  const src = readFileSync(join(__dirname, "../list.ts"), "utf8");

  it("projects run_group on every returned decision, not just the enriched path", () => {
    expect(src.match(/run_group: runGroupOf\(d\)/g)).toHaveLength(2);
  });
});

describe("runGroupOf — a redo's replacement", () => {
  it("groups a replacement under the run it replaces an action in", () => {
    expect(
      runGroupOf({
        agent_run_id: "redo-run-9",
        body: {
          origin_run_id: "original-run-1",
          position: 3,
          of: 5,
          redo_of_decision_id: "dec-old",
        },
      }),
    ).toEqual({ run_id: "original-run-1", position: 3, of: 5 });
  });

  it("keeps the replacement in the SAME slot, so the count does not move", () => {
    const g = runGroupOf({
      agent_run_id: "redo-run-9",
      body: { origin_run_id: "original-run-1", position: 3, of: 5 },
    });
    expect(g?.position).toBe(3);
    expect(g?.of).toBe(5);
  });

  it("falls back to the run itself when there is no origin stamp", () => {
    expect(
      runGroupOf({ agent_run_id: "run-2", body: { position: 1, of: 2 } }),
    ).toEqual({ run_id: "run-2", position: 1, of: 2 });
  });

  it("ignores a non-string origin_run_id rather than trusting it", () => {
    expect(
      runGroupOf({
        agent_run_id: "run-2",
        body: { origin_run_id: 42, position: 1, of: 2 },
      }),
    ).toEqual({ run_id: "run-2", position: 1, of: 2 });
  });
});
