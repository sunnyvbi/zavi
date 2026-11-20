import { beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/logging/logEvent", () => ({ logEvent }));

import { logBuildTick } from "../conductor-observability";

describe("conductor build logs", () => {
  beforeEach(() => logEvent.mockClear());

  it("logs a failed stage with short text and correlated fields", async () => {
    await logBuildTick({
      tenant_id: "tenant-1",
      conductor_run_id: "build-1",
      result: { action: "completed_after_repair_exhausted", node_id: "build", root_cause: "lint failed", attempts: 2 },
      graph: [{
        id: "build",
        status: "failed",
        target_agent_slug: "engineer",
        payload: { stage: "build" },
        estimate_usd: 3,
        child_run_id: "agent-1",
        started_at: "2026-07-22T00:00:00Z",
        finished_at: "2026-07-22T00:00:05Z",
        error: "lint failed",
        failure_class: "repair_exhausted",
        repair_attempts: 2,
      }],
    });

    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      source: "conductor.build",
      code: "completed_after_repair_exhausted",
      tenant_id: "tenant-1",
      run_id: "build-1",
      message: "build: lint failed",
      meta: expect.objectContaining({
        build_stage: "build",
        node_status: "failed",
        node_id: "build",
        run_id_ref: "agent-1",
        agent_slug: "engineer",
        ms: 5000,
        failure_class: "repair_exhausted",
        retry_count: 2,
      }),
    }));
  });

  it("logs a platform config error as an error even when the graph no longer carries the node", async () => {
    await logBuildTick({
      tenant_id: "tenant-1",
      conductor_run_id: "build-1",
      result: {
        action: "completed_platform_config_error",
        node_id: "scaffold",
        root_cause: "resolve-repo-creds: GITHUB_PROVISION_TOKEN not configured",
        attempts: 0,
      },
      graph: [],
    });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      code: "completed_platform_config_error",
    }));
  });

  it("does not log steady waiting ticks", async () => {
    await logBuildTick({
      tenant_id: "tenant-1",
      conductor_run_id: "build-1",
      result: { action: "waiting", in_flight: 1 },
      graph: [],
    });
    expect(logEvent).not.toHaveBeenCalled();
  });
});

