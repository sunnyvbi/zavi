import { describe, expect, it } from "vitest";
import type { ConductorNode } from "@/services/agents/conductor";
import { continueRefusal, resumeGraph } from "@/services/agents/continue-build";

const NOW = Date.parse("2026-10-05T06:00:00.000Z");
const SITE = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function stoppedMidBuild(): ConductorNode[] {
  return [
    {
      id: "n-provision",
      status: "done",
      child_run_id: "child-provision",
      payload: { stage: "provision", site_id: SITE },
    },
    {
      id: "n-build",
      status: "dispatched",
      child_run_id: "child-build-stopping",
      payload: { stage: "build", site_id: SITE, resume_epoch: 0 },
    },
  ] as unknown as ConductorNode[];
}

const row = (failure_class: string, goal_graph: ConductorNode[]) => ({
  kind: "build_app",
  status: "failed",
  paused_at: null,
  updated_at: "2026-10-05T05:58:00.000Z",
  failure_class,
  spend_usd: 1.2,
  max_usd: 20,
  goal_graph,
});

describe("Continue after a founder pressed Stop mid-stage (l1.5 option B safety proof)", () => {
  it("Stop leaves the interrupted stage dispatched on its stopping child, so Continue has no failed stage to resume", () => {
    const graph = stoppedMidBuild();
    expect(continueRefusal(row("user_cancelled", graph), NOW)).toBe("not_resumable");
    expect(continueRefusal(row("stage_failed", graph), NOW)).toBe("not_resumable");
  });

  it("lifting the class gate alone would resume onto the stopping child: the interrupted stage is not reset or re-keyed", () => {
    const resumed = resumeGraph(stoppedMidBuild());
    const build = resumed.find((n) => (n.payload as { stage?: string }).stage === "build")!;
    expect(build.status).toBe("dispatched");
    expect(build.child_run_id).toBe("child-build-stopping");
    expect((build.payload as { resume_epoch?: number }).resume_epoch).toBe(0);
  });

  it("a crash, by contrast, leaves a failed stage that resume resets onto a fresh dispatch key", () => {
    const graph = stoppedMidBuild();
    graph[1] = { ...graph[1], status: "failed", failure_class: "stage_failed" } as ConductorNode;
    expect(continueRefusal(row("stage_failed", graph), NOW)).toBeNull();
    const build = resumeGraph(graph)[1]!;
    expect(build.status).toBe("pending");
    expect(build.child_run_id).toBeNull();
    expect((build.payload as { resume_epoch?: number }).resume_epoch).toBe(1);
  });
});
