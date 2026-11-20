import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClient: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClient }));

vi.mock("../chief-of-staff-precision-flag", () => ({
  isCosPrecisionCalibrationEnabled: vi.fn(async () => false),
}));

import {
  loadChiefOfStaffContinuity,
  renderContinuityBlock,
  type ChiefOfStaffContinuity,
} from "../chief-of-staff-continuity";

const NO_COMMITMENTS = { commitments: [], pending_approvals: 0, precision: null };

describe("renderContinuityBlock", () => {
  it("returns empty string when there is no prior digest (first run)", () => {
    const c: ChiefOfStaffContinuity = {
      since: null,
      prior_digests: [],
      activity_since: [],
      ...NO_COMMITMENTS,
    };
    expect(renderContinuityBlock(c)).toBe("");
  });

  it("renders prior digests + the reconcile directive", () => {
    const c: ChiefOfStaffContinuity = {
      since: "2026-05-24T15:00:00Z",
      prior_digests: [
        { finished_at: "2026-05-24T15:00:00Z", text: "Tier 1: dispute spike $4.2k" },
      ],
      activity_since: [],
      ...NO_COMMITMENTS,
    };
    const block = renderContinuityBlock(c);
    expect(block).toContain("## Your continuity");
    expect(block).toContain("reconcil");
    expect(block).toContain("dispute spike $4.2k");
    expect(block).toContain("2026-05-24T15:00:00Z");
  });

  it("flags the never-acted case when no specialist ran since the last digest", () => {
    const c: ChiefOfStaffContinuity = {
      since: "2026-05-24T15:00:00Z",
      prior_digests: [{ finished_at: "2026-05-24T15:00:00Z", text: "Tier 1: ROAS collapse" }],
      activity_since: [],
      ...NO_COMMITMENTS,
    };
    const block = renderContinuityBlock(c);
    expect(block).toContain("No specialist agent has run since your last digest");
  });

  it("lists fleet activity since the last digest with slug + status for loop-closing", () => {
    const c: ChiefOfStaffContinuity = {
      since: "2026-05-24T15:00:00Z",
      prior_digests: [{ finished_at: "2026-05-24T15:00:00Z", text: "Tier 1: dispute spike" }],
      activity_since: [
        {
          agent_slug: "dispute-response",
          status: "success",
          finished_at: "2026-05-24T18:00:00Z",
          snippet: "Drafted 3 chargeback packets, $4.2k.",
        },
        {
          agent_slug: "performance-marketer",
          status: "parse_failed",
          finished_at: "2026-05-24T19:00:00Z",
          snippet: "",
        },
      ],
      ...NO_COMMITMENTS,
    };
    const block = renderContinuityBlock(c);
    expect(block).toContain("dispute-response");
    expect(block).toContain("`success`");
    expect(block).toContain("Drafted 3 chargeback packets");
    expect(block).toContain("performance-marketer");
    expect(block).toContain("`parse_failed`");
    expect(block).toContain("do NOT re-raise");
  });

  it("renders the ground-truth commitment ledger header + a delivered/rejected/pending row", () => {
    const c: ChiefOfStaffContinuity = {
      since: "2026-06-01T15:00:00Z",
      prior_digests: [{ finished_at: "2026-06-01T15:00:00Z", text: "digest" }],
      activity_since: [],
      commitments: [
        {
          decision_id: "d-approved",
          target_agent_slug: "dispute-response",
          intent: "Draft evidence for du_1A2B ($4,200)",
          decision_status: "approved",
          emitted_at: "2026-06-01T16:00:00Z",
          dispatched_at: "2026-06-01T16:01:00Z",
          dispatch_error: null,
          run_status: "success",
          run_finished_at: "2026-06-01T16:30:00Z",
        },
        {
          decision_id: "d-rejected",
          target_agent_slug: "performance-marketer",
          intent: "Rebalance Meta spend (CAC +38% WoW)",
          decision_status: "rejected",
          emitted_at: "2026-06-01T16:05:00Z",
          dispatched_at: null,
          dispatch_error: null,
          run_status: null,
          run_finished_at: null,
        },
        {
          decision_id: "d-pending",
          target_agent_slug: "support-lead",
          intent: "Clear backlog of 9 unanswered tickets",
          decision_status: "proposed",
          emitted_at: "2026-06-01T16:10:00Z",
          dispatched_at: null,
          dispatch_error: null,
          run_status: null,
          run_finished_at: null,
        },
      ],
      pending_approvals: 1,
      precision: null,
    };
    const block = renderContinuityBlock(c);
    expect(block).toContain("Your commitment ledger (ground truth");
    expect(block).toContain("dispute-response");
    expect(block).toContain("APPROVED → delivered");
    expect(block).toContain("REJECTED (declined — not a miss)");
    expect(block).toContain("NEVER mark a rejected dispatch `missed`");
    expect(block).toContain("PENDING your approval");
    expect(block).toContain("still awaiting your founder's click");
  });

  it("renders the empty-ledger guard against fabricated misses", () => {
    const c: ChiefOfStaffContinuity = {
      since: "2026-06-01T15:00:00Z",
      prior_digests: [{ finished_at: "2026-06-01T15:00:00Z", text: "digest" }],
      activity_since: [],
      ...NO_COMMITMENTS,
    };
    const block = renderContinuityBlock(c);
    expect(block).toContain("Your commitment ledger (ground truth");
    expect(block).toContain("Do NOT fabricate `missed` accountability rows");
  });

  it("surfaces a dispatch error on an approved-but-failed dispatch", () => {
    const c: ChiefOfStaffContinuity = {
      since: "2026-06-01T15:00:00Z",
      prior_digests: [{ finished_at: "2026-06-01T15:00:00Z", text: "digest" }],
      activity_since: [],
      commitments: [
        {
          decision_id: "d-err",
          target_agent_slug: "engineer",
          intent: "Ship the rate-limit fix",
          decision_status: "approved",
          emitted_at: "2026-06-01T16:00:00Z",
          dispatched_at: "2026-06-01T16:01:00Z",
          dispatch_error: "target 'engineer' is not a visible agent for this tenant",
          run_status: null,
          run_finished_at: null,
        },
      ],
      pending_approvals: 0,
      precision: null,
    };
    const block = renderContinuityBlock(c);
    expect(block).toContain("APPROVED → dispatch failed");
    expect(block).toContain("dispatch error: target 'engineer' is not a visible agent");
  });
});

type Result = { data: unknown[] | null; error: { message: string } | null };

function makeSequencedClient(opts: {
  priorDigests: Result;
  activitySince?: Result;
  decisions: Result;
  runJoin?: Result;
}) {
  let agentRunsCall = 0;
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gt", "not", "order", "limit", "in"]) {
        b[m] = () => b;
      }
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

describe("loadChiefOfStaffContinuity — commitment ledger", () => {
  beforeEach(() => {
    mocks.serviceClient.mockReset();
  });

  it("first run (no prior digest) returns empty ledger, never queries decisions", async () => {
    let queriedDecisions = false;
    const client = {
      from: (table: string) => {
        if (table === "decisions") queriedDecisions = true;
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "neq", "gt", "not", "order", "limit", "in"]) {
          b[m] = () => b;
        }
        b.then = (resolve: (r: Result) => unknown) =>
          Promise.resolve<Result>({ data: [], error: null }).then(resolve);
        return b;
      },
    };
    mocks.serviceClient.mockReturnValue(client);
    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c).not.toBeNull();
    expect(c!.commitments).toEqual([]);
    expect(c!.pending_approvals).toBe(0);
    expect(queriedDecisions).toBe(false);
  });

  it("loads dispatch-specialist decisions + joins their specialist runs by payload->>source_decision_id", async () => {
    const client = makeSequencedClient({
      priorDigests: {
        data: [{ finished_at: "2026-06-01T15:00:00Z", output_text: "prior digest" }],
        error: null,
      },
      decisions: {
        data: [
          {
            id: "dec-1",
            body: { target_agent_slug: "dispute-response", intent: "Draft du_1A2B evidence" },
            status: "approved",
            dispatch_error: null,
            dispatched_at: "2026-06-01T16:01:00Z",
            emitted_at: "2026-06-01T16:00:00Z",
          },
          {
            id: "dec-2",
            body: { target_agent_slug: "performance-marketer", intent: "Rebalance Meta" },
            status: "rejected",
            dispatch_error: null,
            dispatched_at: null,
            emitted_at: "2026-06-01T16:05:00Z",
          },
        ],
        error: null,
      },
      runJoin: {
        data: [
          {
            status: "success",
            finished_at: "2026-06-01T16:30:00Z",
            payload: { source_decision_id: "dec-1" },
          },
        ],
        error: null,
      },
    });
    mocks.serviceClient.mockReturnValue(client);

    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c).not.toBeNull();
    expect(c!.commitments).toHaveLength(2);

    const approved = c!.commitments.find((m) => m.decision_id === "dec-1")!;
    expect(approved.target_agent_slug).toBe("dispute-response");
    expect(approved.decision_status).toBe("approved");
    expect(approved.run_status).toBe("success");
    expect(approved.run_finished_at).toBe("2026-06-01T16:30:00Z");

    const rejected = c!.commitments.find((m) => m.decision_id === "dec-2")!;
    expect(rejected.decision_status).toBe("rejected");
    expect(rejected.run_status).toBeNull();

    expect(c!.pending_approvals).toBe(0);
  });

  it("THE BUG THIS FIXES: a REJECTED dispatch never grades as missed — verdict ⊢ ground truth", async () => {
    const client = makeSequencedClient({
      priorDigests: {
        data: [{ finished_at: "2026-06-01T15:00:00Z", output_text: "d" }],
        error: null,
      },
      decisions: {
        data: [
          {
            id: "dec-rej",
            body: { target_agent_slug: "performance-marketer", intent: "Rebalance Meta spend" },
            status: "rejected",
            dispatch_error: null,
            dispatched_at: null,
            emitted_at: "2026-06-01T16:00:00Z",
          },
        ],
        error: null,
      },
    });
    mocks.serviceClient.mockReturnValue(client);

    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c!.commitments[0].decision_status).toBe("rejected");

    const block = renderContinuityBlock(c!);
    expect(block).toContain("REJECTED (declined — not a miss)");
    expect(block).toContain("NEVER mark a rejected dispatch `missed`");
    expect(block).not.toMatch(/performance-marketer[^\n]*missed/);
  });

  it("counts proposed (still-awaiting-click) decisions as pending_approvals", async () => {
    const client = makeSequencedClient({
      priorDigests: {
        data: [{ finished_at: "2026-06-01T15:00:00Z", output_text: "d" }],
        error: null,
      },
      decisions: {
        data: [
          { id: "p1", body: { target_agent_slug: "a", intent: "x" }, status: "proposed", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-01T16:00:00Z" },
          { id: "p2", body: { target_agent_slug: "b", intent: "y" }, status: "proposed", dispatch_error: null, dispatched_at: null, emitted_at: "2026-06-01T16:01:00Z" },
          { id: "a1", body: { target_agent_slug: "c", intent: "z" }, status: "approved", dispatch_error: null, dispatched_at: "2026-06-01T16:02:00Z", emitted_at: "2026-06-01T16:02:00Z" },
        ],
        error: null,
      },
    });
    mocks.serviceClient.mockReturnValue(client);
    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c!.pending_approvals).toBe(2);
  });

  it("degrades to empty ledger (keeps prior digests) when the decisions read errors", async () => {
    const client = makeSequencedClient({
      priorDigests: {
        data: [{ finished_at: "2026-06-01T15:00:00Z", output_text: "d" }],
        error: null,
      },
      decisions: { data: null, error: { message: "boom" } },
    });
    mocks.serviceClient.mockReturnValue(client);
    const c = await loadChiefOfStaffContinuity("t-1");
    expect(c).not.toBeNull();
    expect(c!.prior_digests).toHaveLength(1);
    expect(c!.commitments).toEqual([]);
    expect(c!.pending_approvals).toBe(0);
  });
});
