import { describe, it, expect } from "vitest";
import { productPmBacklogSchema } from "../output-schema";

describe("productPmBacklogSchema — documented minimal skip shapes", () => {
  it("accepts the minimal no_signal envelope (agent.md shape 2)", () => {
    const r = productPmBacklogSchema.safeParse({
      status: "no_signal",
      status_reason: "Landscape explanation requested — not a backlog scan run.",
      rendered_markdown: "## No actionable signal\n\nThis was a status question.",
    });
    expect(r.success).toBe(true);
  });

  it("accepts the minimal insufficient_data envelope (agent.md shape 3)", () => {
    const r = productPmBacklogSchema.safeParse({
      status: "insufficient_data",
      status_reason: "Connector gap — corpus too small.",
      rendered_markdown: "## Need more context\n\nNo agent runs in window.",
    });
    expect(r.success).toBe(true);
  });

  it("still REJECTS an actionable envelope with empty backlog (A2A guard intact)", () => {
    const r = productPmBacklogSchema.safeParse({
      status: "actionable",
      rendered_markdown: "x",
      summary: { bullets: ["found a thing"] },
      backlog: [],
      dispatched_actions: [],
      recommended_actions_not_dispatched: [],
      sources_all: [],
      snapshot_run_id: "run_x",
    });
    expect(r.success).toBe(false);
  });

  it("still REJECTS an actionable envelope missing the heavy delivery fields", () => {
    const r = productPmBacklogSchema.safeParse({
      status: "actionable",
      status_reason: "stuff",
      rendered_markdown: "x",
    });
    expect(r.success).toBe(false);
  });
});
