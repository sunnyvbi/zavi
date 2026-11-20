import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  flagEnabled: vi.fn(async () => true),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));
vi.mock("../chief-of-staff-precision-flag", () => ({
  isCosPrecisionCalibrationEnabled: mocks.flagEnabled,
}));

import {
  loadChiefOfStaffContinuity,
  renderContinuityBlock,
  approvalsDeepLink,
} from "../chief-of-staff-continuity";

type Result = { data: unknown[] | null; error: { message: string } | null };

function makeClient(opts: {
  priorDigests: Result;
  activitySince?: Result;
  decisions: Result;
  runJoin?: Result;
}) {
  let agentRunsCall = 0;
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gt", "not", "order", "limit", "in"]) b[m] = () => b;
      b.then = (resolve: (r: Result) => unknown) => {
        let r: Result;
        if (table === "agent_runs") {
          agentRunsCall += 1;
          if (agentRunsCall === 1) r = opts.priorDigests;
          else if (agentRunsCall === 2) r = opts.activitySince ?? { data: [], error: null };
          else r = opts.runJoin ?? { data: [], error: null };
        } else if (table === "decisions") {
          r = opts.decisions;
        } else {
          r = { data: [], error: null };
        }
        return Promise.resolve(r).then(resolve);
      };
      return b;
    },
  };
}

describe("approvalsDeepLink", () => {
  it("deep-links the chief of staff's own chat, where its dispatches wait (no /approvals, no per-id route)", () => {
    const url = approvalsDeepLink();
    expect(url).toMatch(/\/workspace\?agent=chief-of-staff$/);
    expect(url).not.toMatch(/\/approvals\//);
  });
});

describe("loadChiefOfStaffContinuity — P1-2 precision injection", () => {
  beforeEach(() => {
    mocks.serviceClient.mockReset();
    mocks.flagEnabled.mockResolvedValue(true);
  });

  it("flag OFF → precision is null and no calibration block renders", async () => {
    mocks.flagEnabled.mockResolvedValue(false);
    const client = makeClient({
      priorDigests: { data: [{ finished_at: "2026-06-09T15:00:00Z", output_text: "prior" }], error: null },
      decisions: {
        data: [
          { body: { target_agent_slug: "a", intent: "x" }, status: "rejected", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:00:00Z", id: "d1" },
        ],
        error: null,
      },
    });
    mocks.serviceClient.mockReturnValue(client);
    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c!.precision).toBeNull();
    expect(renderContinuityBlock(c!)).not.toContain("Promotion-gate calibration");
  });

  it("flag ON + settled sample → injects a precision calibration block into the continuity render", async () => {
    const decisions: Result = {
      data: [
        { id: "d1", body: { target_agent_slug: "support-lead", intent: "fraud cluster review" }, status: "rejected", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:00:00Z" },
        { id: "d2", body: { target_agent_slug: "x", intent: "y" }, status: "rejected", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:01:00Z" },
        { id: "d3", body: { target_agent_slug: "z", intent: "w" }, status: "rejected", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:02:00Z" },
        { id: "d4", body: { target_agent_slug: "q", intent: "r" }, status: "acted", dispatch_error: null, dispatched_at: "2026-06-09T16:03:00Z", emitted_at: "2026-06-09T16:03:00Z" },
      ],
      error: null,
    };
    const client = makeClient({
      priorDigests: { data: [{ finished_at: "2026-06-09T15:00:00Z", output_text: "prior digest" }], error: null },
      decisions,
    });
    mocks.serviceClient.mockReturnValue(client);

    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c!.precision).not.toBeNull();
    expect(c!.precision!.settled).toBe(4);
    expect(c!.precision!.precision).toBeCloseTo(0.25);

    const block = renderContinuityBlock(c!);
    expect(block).toContain("## Your continuity");
    expect(block).toContain("Promotion-gate calibration");
    expect(block).toContain("25%");
    expect(block).toContain("REJECTED these dispatches");
    expect(block).toContain("support-lead");
  });

  it("FIRST-RUN tenant (no prior digest) still surfaces calibration via the minimal block + deep-links pending to /approvals", async () => {
    const decisions: Result = {
      data: [
        { id: "d1", body: { target_agent_slug: "performance-marketer", intent: "Rebalance Meta" }, status: "rejected", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:00:00Z" },
        { id: "d2", body: { target_agent_slug: "x", intent: "y" }, status: "rejected", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:01:00Z" },
        { id: "d3", body: { target_agent_slug: "z", intent: "w" }, status: "rejected", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:02:00Z" },
      ],
      error: null,
    };
    const client = makeClient({
      priorDigests: { data: [], error: null },
      decisions,
    });
    mocks.serviceClient.mockReturnValue(client);

    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c!.prior_digests).toHaveLength(0);
    expect(c!.precision).not.toBeNull();
    expect(c!.precision!.rejected_intents.length).toBeGreaterThan(0);

    const block = renderContinuityBlock(c!);
    expect(block).toContain("## Your continuity (promotion-gate calibration)");
    expect(block).toContain("REJECTED these dispatches");
    expect(block).toContain("performance-marketer");
    expect(block).not.toContain("What you surfaced last time");
  });

  it("commitment ledger pending callout deep-links to the chief of staff chat", async () => {
    const decisions: Result = {
      data: [
        { id: "p1", body: { target_agent_slug: "dispute-response", intent: "draft evidence" }, status: "proposed", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-09T16:00:00Z" },
      ],
      error: null,
    };
    const client = makeClient({
      priorDigests: { data: [{ finished_at: "2026-06-09T15:00:00Z", output_text: "prior" }], error: null },
      decisions,
    });
    mocks.serviceClient.mockReturnValue(client);

    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c!.pending_approvals).toBe(1);
    const block = renderContinuityBlock(c!);
    expect(block).toContain("still awaiting your founder's click");
    expect(block).toContain("/workspace?agent=chief-of-staff");
  });
});
