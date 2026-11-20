import { describe, it, expect, vi, beforeEach } from "vitest";

const stopRequested = vi.fn(async (_runId: string) => false);
vi.mock("@/services/agents/run-stop", () => ({
  isRunStopRequested: (runId: string) => stopRequested(runId),
}));

const sandboxLookup = vi.fn(async () => null);
vi.mock("@/services/sandbox/lifecycle", async (orig) => ({
  ...(await orig<typeof import("@/services/sandbox/lifecycle")>()),
  getSandboxIdForRun: (...args: unknown[]) => sandboxLookup(...(args as [])),
}));

import { runCtoPostRun } from "../post-run";
import type { AgentContext } from "@/services/agents/types";

const ctx = {
  runId: "old-scaffold-run",
  tenant_id: "t1",
  agent: { slug: "engineer" },
  emitProgress: vi.fn(async () => {}),
} as unknown as AgentContext;

const envelope = {
  kind: "pr_proposal",
  title: "Scaffold the laptop rental storefront",
  summary: "Adds the storefront pages",
  repo: "zavi-apps/rentals-t1",
  branch: "zavi/scaffold",
  files: [],
};

const payload = {
  stage: "scaffold",
  idea: "A laptop rental storefront",
  repo_hint: "zavi-apps/rentals-t1",
  target: { github_full_name: "zavi-apps/rentals-t1" },
};

describe("an engineer run the founder stopped never ships", () => {
  beforeEach(() => {
    stopRequested.mockReset();
    sandboxLookup.mockClear();
  });

  it("suppresses before it reads the sandbox diff when Stop was pressed", async () => {
    stopRequested.mockResolvedValue(true);
    const out = await runCtoPostRun(ctx, envelope, payload);
    expect(stopRequested).toHaveBeenCalledWith("old-scaffold-run");
    expect(out).toEqual({ kind: "suppress", reason: "run_stopped" });
    expect(sandboxLookup).not.toHaveBeenCalled();
  });

  it("a run nobody stopped goes on to read the sandbox", async () => {
    stopRequested.mockResolvedValue(false);
    await runCtoPostRun(ctx, envelope, payload).catch(() => undefined);
    expect(sandboxLookup).toHaveBeenCalled();
  });
});
