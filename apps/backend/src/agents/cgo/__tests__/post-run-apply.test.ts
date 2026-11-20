
import { beforeEach, describe, expect, it, vi } from "vitest";

const delivery = vi.hoisted(() => ({ advance: vi.fn(), deliver: vi.fn() }));
vi.mock("@/services/growth/strategy-delivery", () => ({ advanceStrategyDelivery: delivery.advance, deliverStrategy: delivery.deliver }));

type Meta = Record<string, unknown>;
let prior: { id: string; metadata: Meta } | null = null;
let runCreatedAt: string | null = null;
const writes: Array<{ id?: string; metadata: Meta }> = [];
const applies: Array<{ tenant: string; by: string }> = [];

vi.mock("../plan-review", () => ({
  isPlanReviewEnabled: () => false,
  reviewAndRevisePlan: async () => { throw new Error("not in these tests"); },
}));

vi.mock("@/services/growth/strategy-note", () => ({
  CURRENT_STRATEGY_TAG: "current-growth-strategy",
  readStrategyNote: vi.fn(async () =>
    prior ? { ...prior, title: "t", body_markdown: "", tags: [] } : null,
  ),
  readRunCreatedAt: vi.fn(async () => runCreatedAt),
  carryApplyState: (m: Meta) => {
    const out: Meta = {};
    for (const k of ["applied_fingerprint", "applied_spine", "applied_goal_id", "reset_at"])
      if (m[k] !== undefined) out[k] = m[k];
    return out;
  },
  startedBeforeReset: (run: string | null, reset: unknown) =>
    !!run && typeof reset === "string" && Date.parse(run) < Date.parse(reset),
}));

vi.mock("@/services/memory", () => ({
  writeNote: vi.fn(async (_t: string, input: { id?: string; metadata: Meta }) => {
    writes.push(input);
  }),
}));

vi.mock("@/services/growth/apply-strategy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/growth/apply-strategy")>()),
  applyGrowthStrategy: vi.fn(async (tenant: string, opts: { by: string }) => {
    applies.push({ tenant, by: opts.by });
    return { applied: true, wrote: {}, problems: [] };
  }),
}));

vi.mock("../strategy", () => ({
  TOOL_LABELS: {},
  observedTools: () => new Set<string>(),
  guardBasisEvidence: () => [],
  guardCompanyFacts: () => undefined,
  gapsFromUnusedTools: () => [],
  renderStrategy: () => "# strategy",
  parseStrategy: () => ({
    ok: true,
    strategy: {
      north_star: { metric: "signups" },
      constraint: { statement: "few visitors", confidence: "medium" },
      channel_bets: [{ channel_slug: "seo", intent: "rank", falsifier: "no lift" }],
      basis_evidence: [],
    },
  }),
}));

const founder = vi.hoisted(() => ({ overlay: { constraint: null as string | null, stopped: new Set<string>() } }));
vi.mock("../founder-overlay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../founder-overlay")>()),
  readFounderOverlay: vi.fn(async () => founder.overlay),
}));

import { cgoPostProcess } from "../post-run";
import { strategyFingerprint } from "@/services/growth/apply-strategy";

const PARSED_STRATEGY = {
  north_star: { metric: "signups" },
  constraint: { statement: "few visitors", confidence: "medium" },
  channel_bets: [{ channel_slug: "seo", intent: "rank", falsifier: "no lift" }],
  basis_evidence: [],
};
const APPLIED_FINGERPRINT = strategyFingerprint(PARSED_STRATEGY as never);

const ctx = (over: Record<string, unknown> = {}) =>
  ({ tenant_id: "t1", runId: "run-1", agent: {}, ...over }) as never;
const result = { raw_response_text: "<strategy>…</strategy>", output_text: "" };

beforeEach(() => {
  prior = {
    id: "note-1",
    metadata: {
      accepted: true,
      applied_fingerprint: APPLIED_FINGERPRINT,
      applied_goal_id: "g1",
      applied_spine: "signups::few visitors",
    },
  };
  runCreatedAt = "2026-09-11T10:00:00Z";
  delivery.advance.mockReset().mockResolvedValue({ phase: "checking" });
  delivery.deliver.mockReset().mockResolvedValue({ phase: "applied", plan_id: "p1" });
  writes.length = 0;
  applies.length = 0;
  founder.overlay = { constraint: null, stopped: new Set() };
});

describe("cgoPostProcess (auto-apply)", () => {
  it("writes the founder's diagnosis over the drafted one and drops a bet on a stopped channel", async () => {
    founder.overlay = { constraint: "Hosts cancel too often", stopped: new Set(["seo"]) };
    await cgoPostProcess(ctx(), result as never);
    const written = writes[0].metadata.strategy as { constraint: { statement: string }; channel_bets: unknown[] };
    expect(written.constraint.statement).toBe("Hosts cancel too often");
    expect(written.channel_bets).toEqual([]);
  });

  it("hands the initial draft's delivery the overlaid strategy too", async () => {
    founder.overlay = { constraint: "Hosts cancel too often", stopped: new Set() };
    await cgoPostProcess(ctx(), result as never, { stage: "draft_strategy" });
    expect(delivery.deliver.mock.calls[0][2]).toMatchObject({ constraint: { statement: "Hosts cancel too often" } });
  });

  it("writes the strategy, then applies it as the agent", async () => {
    await cgoPostProcess(ctx(), result as never);
    expect(writes).toHaveLength(1);
    expect(applies).toEqual([{ tenant: "t1", by: "agent" }]);
  });

  it("carries what was applied, because writeNote replaces metadata", async () => {
    await cgoPostProcess(ctx(), result as never);
    expect(writes[0].id).toBe("note-1");
    expect(writes[0].metadata).toMatchObject({
      applied_fingerprint: APPLIED_FINGERPRINT,
      applied_goal_id: "g1",
      accepted: true,
    });
  });

  it("reads the prior accepted flag for real (listNotes never returned metadata)", async () => {
    prior = { id: "note-1", metadata: { accepted: false } };
    await cgoPostProcess(ctx(), result as never);
    expect(writes[0].metadata.accepted).toBe(false);
  });

  it("drops accepted when the new strategy is not the one that was applied", async () => {
    prior = {
      id: "note-1",
      metadata: {
        accepted: true,
        applied_fingerprint: "some-other-fingerprint",
        applied_spine: "revenue::no demand",
      },
    };
    await cgoPostProcess(ctx(), result as never);
    expect(writes[0].metadata.accepted).toBe(false);
  });

  it("drops accepted when the spine matches but the strategy changed", async () => {
    prior = {
      id: "note-1",
      metadata: {
        accepted: true,
        applied_spine: "signups::few visitors",
        applied_fingerprint: "fingerprint-of-an-older-set-of-bets",
      },
    };
    await cgoPostProcess(ctx(), result as never);
    expect(writes[0].metadata.accepted).toBe(false);
  });

  it("drops accepted when nothing records which strategy was applied", async () => {
    prior = { id: "note-1", metadata: { accepted: true } };
    await cgoPostProcess(ctx(), result as never);
    expect(writes[0].metadata.accepted).toBe(false);
  });

  it("discards a strategy from a run that began before Start over", async () => {
    prior = { id: "note-1", metadata: { accepted: false, reset_at: "2026-09-11T10:05:00Z" } };
    runCreatedAt = "2026-09-11T10:00:00Z";
    await cgoPostProcess(ctx(), result as never);
    expect(writes).toHaveLength(0);
    expect(applies).toHaveLength(0);
  });

  it("applies a strategy from a run that began after Start over", async () => {
    prior = { id: "note-1", metadata: { accepted: false, reset_at: "2026-09-11T09:00:00Z" } };
    runCreatedAt = "2026-09-11T10:00:00Z";
    await cgoPostProcess(ctx(), result as never);
    expect(writes).toHaveLength(1);
    expect(applies).toHaveLength(1);
  });

  it("never writes or applies from a shadow or best-of-N draft run", async () => {
    await cgoPostProcess(ctx({ shadow_mode: true }), result as never);
    await cgoPostProcess(ctx({ draft_mode: true }), result as never);
    expect(writes).toHaveLength(0);
    expect(applies).toHaveLength(0);
  });
});

describe("initial draft delivery", () => {
  const initial = () => ctx();
  it("only reports success after receiving the committed plan receipt", async () => {
    const output = { ...result, parse_ok: true };
    await cgoPostProcess(initial(), output as never, { stage: "draft_strategy" });
    expect(delivery.advance).toHaveBeenCalledWith("t1", "run-1", "checking");
    expect(delivery.deliver).toHaveBeenCalledOnce();
    expect(output.parse_ok).toBe(true);
    expect(writes).toHaveLength(0); expect(applies).toHaveLength(0);
  });
  it("a failed save leaves the run failed even when the model output parsed", async () => {
    delivery.deliver.mockRejectedValue(new Error("database unavailable"));
    const output = { ...result, parse_ok: true };
    await expect(cgoPostProcess(initial(), output as never, { stage: "draft_strategy" })).rejects.toThrow("database unavailable");
    expect(output.parse_ok).toBe(false);
  });
  it("a reset run stops before review and delivery", async () => {
    delivery.advance.mockResolvedValue({ phase: "superseded" });
    const output = { ...result, parse_ok: true };
    await cgoPostProcess(initial(), output as never, { stage: "draft_strategy" });
    expect(output.parse_ok).toBe(false); expect(delivery.deliver).not.toHaveBeenCalled();
  });
});

describe("cgoPostProcess as a handoff child (Home chat)", () => {
  it("writes and applies nothing, even when the answer carries a <strategy> block", async () => {
    await cgoPostProcess(ctx({ trigger: "handoff" }), result as never, { operator_thread_id: "th-1", intent: "what holds growth back?" });
    expect(writes).toHaveLength(0);
    expect(applies).toHaveLength(0);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("writes nothing for a Slack handoff child (trigger slack + slack_handoff_child)", async () => {
    await cgoPostProcess(ctx({ trigger: "slack" }), result as never, {
      slack: { channel: "C1", thread_ts: "1.2" },
      source: "slack",
      slack_handoff_child: true,
    });
    expect(writes).toHaveLength(0);
    expect(applies).toHaveLength(0);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("writes nothing for an email handoff child (trigger email + handoff_child)", async () => {
    await cgoPostProcess(ctx({ trigger: "email" }), result as never, {
      email: { thread_id: "e1" },
      source: "email",
      handoff_child: true,
    });
    expect(writes).toHaveLength(0);
    expect(applies).toHaveLength(0);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("still runs a strategy job that arrived as a handoff (stage draft_strategy)", async () => {
    await cgoPostProcess(ctx({ trigger: "handoff" }), result as never, { stage: "draft_strategy" });
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
  });
});
