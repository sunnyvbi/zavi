import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ serviceClientMock: vi.fn() }));

vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn() }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
const findFinalCreateForMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/meta-ads/strategist-gate/review-state", () => ({
  findFinalCreateFor: findFinalCreateForMock,
}));
const cgoApproveAdDecisionMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/growth/cgo-ads", () => ({ cgoApproveAdDecision: cgoApproveAdDecisionMock }));
const resolveCreateAdSetBidMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/tools/meta-ads/write/_ad-set-bid", () => ({ resolveCreateAdSetBid: resolveCreateAdSetBidMock }));

import {
  scanAutoCronRows,
  AUTO_CRON_CLASSES_WHILE_STOPPED,
  __testOnly_handlers,
} from "../dispatch-decision";
import { buildPendingStrategistBody } from "@/services/meta-ads/strategist-gate/pending-body";
import { ExpectedToolError } from "@/services/tools/types";

type Call = [string, ...unknown[]];
let calls: Call[];

beforeEach(() => {
  calls = [];
  const q: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "in", "or", "order"]) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return q;
    };
  }
  q.limit = async (n: number) => {
    calls.push(["limit", n]);
    return { data: [{ id: "d-1", tenant_id: "t-1", decision_class: "x" }], error: null };
  };
  mocks.serviceClientMock.mockReturnValue(q);
});

describe("scanAutoCronRows", () => {
  it("while stopped, scans only the parked strategist class", async () => {
    const rows = await scanAutoCronRows(true);
    expect(rows).toHaveLength(1);
    expect(calls).toContainEqual(["in", "decision_class", ["perfmkt.create_ad_set_pending_strategist"]]);
    expect(calls).toContainEqual(["eq", "status", "proposed"]);
    expect(calls).toContainEqual(["eq", "autonomy_at_emit", "auto"]);
  });

  it("one fair queue: only rows eligible now, oldest eligible first", async () => {
    const now = new Date("2026-10-12T10:00:00.000Z");
    await scanAutoCronRows(true, now);
    expect(calls).toContainEqual(["or", 'dispatch_eligible_at.is.null,dispatch_eligible_at.lte."2026-10-12T10:00:00.000Z"']);
    const orders = calls.filter((c) => c[0] === "order");
    expect(orders[0]).toEqual(["order", "dispatch_eligible_at", { ascending: true, nullsFirst: true }]);
    expect(orders[1]).toEqual(["order", "id", { ascending: true }]);
  });

  it("when allowlisted, scans every auto class", async () => {
    await scanAutoCronRows(false);
    expect(calls.some((c) => c[0] === "in")).toBe(false);
  });

  it("keeps money-moving classes out of the while-stopped set", () => {
    expect([...AUTO_CRON_CLASSES_WHILE_STOPPED]).toEqual(["perfmkt.create_ad_set_pending_strategist"]);
  });

  it("throws on a scan error so Inngest records the failure", async () => {
    const q = mocks.serviceClientMock();
    q.limit = async () => ({ data: null, error: { message: "boom" } });
    await expect(scanAutoCronRows(true)).rejects.toThrow("auto-cron scan failed: boom");
  });
});

describe("perfmkt.create_ad_set_pending_strategist handler", () => {
  const CREATE = {
    campaign_id: "camp-1",
    name: "First-Time Renter - Broad Markets",
    daily_budget_usd: 20,
    optimization_goal: "LINK_CLICKS",
    billing_event: "IMPRESSIONS",
    targeting: { geo_locations: { countries: ["US"] } },
    rationale: "Broad test.",
  };
  const row = (body: unknown) => ({
    id: "pending-1",
    tenant_id: "t-1",
    agent_run_id: "run-1",
    decision_class: "perfmkt.create_ad_set_pending_strategist",
    body: body as Record<string, unknown>,
    status: "proposed",
    handler: "perfmkt.create_ad_set_pending_strategist",
  });
  const handler = (__testOnly_handlers as Record<string, (d: unknown) => Promise<{ ok: boolean; error?: string }>>)[
    "perfmkt.create_ad_set_pending_strategist"
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rpc: ReturnType<typeof vi.fn<any[], any>>;

  beforeEach(() => {
    rpc = vi.fn<any[], any>(async () => ({ data: "final-1", error: null }));
    mocks.serviceClientMock.mockReturnValue({ rpc });
    findFinalCreateForMock.mockReset();
    cgoApproveAdDecisionMock.mockReset();
    cgoApproveAdDecisionMock.mockResolvedValue(false);
    resolveCreateAdSetBidMock.mockReset();
    resolveCreateAdSetBidMock.mockImplementation(async (_t: string, body: unknown) => body);
  });

  it("settles the bid before the card: the emitted body carries the resolved bid", async () => {
    resolveCreateAdSetBidMock.mockImplementation(async (_t: string, body: Record<string, unknown>) => ({
      ...body,
      campaign_bid_strategy: "COST_CAP",
      bid_amount_usd: 4.5,
    }));
    const r = await handler(row(buildPendingStrategistBody(CREATE as never, {})));
    expect(r.ok).toBe(true);
    expect(resolveCreateAdSetBidMock).toHaveBeenCalledWith("t-1", expect.objectContaining({ campaign_id: "camp-1" }));
    const body = (rpc.mock.calls[0][1] as Record<string, unknown>).p_body as Record<string, unknown>;
    expect(body.bid_amount_usd).toBe(4.5);
    expect(body.campaign_bid_strategy).toBe("COST_CAP");
  });

  it("a bid the campaign cannot take is final: nothing to approvals, not retried", async () => {
    resolveCreateAdSetBidMock.mockRejectedValue(
      new ExpectedToolError("meta_ads_bid_unavailable", "this campaign uses COST_CAP, so the ad set needs bid_amount_usd"),
    );
    const r = (await handler(row(buildPendingStrategistBody(CREATE as never, {})))) as { ok: boolean; error?: string; retry_later?: boolean };
    expect(r.ok).toBe(false);
    expect(r.retry_later).toBeUndefined();
    expect(r.error).toMatch(/nothing was sent to approvals/);
    expect(rpc).not.toHaveBeenCalled();
    expect(cgoApproveAdDecisionMock).not.toHaveBeenCalled();
  });

  it("a brief Meta failure on the bid read asks to be retried, emitting nothing", async () => {
    resolveCreateAdSetBidMock.mockRejectedValue(new ExpectedToolError("meta_ads_timeout", "Meta Graph API did not respond within 15s"));
    const r = (await handler(row(buildPendingStrategistBody(CREATE as never, {})))) as { ok: boolean; retry_later?: boolean };
    expect(r.ok).toBe(false);
    expect(r.retry_later).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(cgoApproveAdDecisionMock).not.toHaveBeenCalled();
  });

  it("emits the real create for operator approval, keyed to the parked row", async () => {
    const r = await handler(row(buildPendingStrategistBody(CREATE as never, {})));
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("emit_decision");
    expect(args.p_decision_class).toBe("meta_ads.create_ad_set");
    expect(args.p_agent_run_id).toBe("run-1");
    const body = args.p_body as Record<string, unknown>;
    expect(body.daily_budget_usd).toBe(20);
    expect(body.strategist_gate).toEqual({ origin_pending_decision_id: "pending-1" });
  });

  it("reuses the card already emitted on a re-run", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "duplicate key value violates unique constraint" } });
    findFinalCreateForMock.mockResolvedValue({ id: "final-0" });
    const r = await handler(row(buildPendingStrategistBody(CREATE as never, {})));
    expect(r.ok).toBe(true);
    expect(findFinalCreateForMock).toHaveBeenCalledWith("pending-1", "t-1");
  });

  it("refuses a body that is not a parked create, emitting nothing", async () => {
    const r = await handler(row(CREATE));
    expect(r.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(cgoApproveAdDecisionMock).not.toHaveBeenCalled();
  });

  it("passes the emitted create through the CGO's decisions door, with the body it emitted", async () => {
    cgoApproveAdDecisionMock.mockResolvedValue(true);
    const r = (await handler(row(buildPendingStrategistBody(CREATE as never, {})))) as { ok: boolean; notice?: string };
    expect(r.ok).toBe(true);
    expect(cgoApproveAdDecisionMock).toHaveBeenCalledTimes(1);
    const [tenant, id, cls, body] = cgoApproveAdDecisionMock.mock.calls[0] as [string, string, string, Record<string, unknown>];
    expect([tenant, id, cls]).toEqual(["t-1", "final-1", "meta_ads.create_ad_set"]);
    expect(body).toEqual((rpc.mock.calls[0][1] as Record<string, unknown>).p_body);
    expect(r.notice).toMatch(/Autopilot approved/);
  });

  it("off Autopilot (the door says no) the card waits for the founder, as before", async () => {
    const r = (await handler(row(buildPendingStrategistBody(CREATE as never, {})))) as { ok: boolean; notice?: string };
    expect(r.ok).toBe(true);
    expect(r.notice).toMatch(/Sent the new ad set to approvals/);
  });

  it("a re-run that finds the card already emitted asks the door about that card", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "duplicate key value violates unique constraint" } });
    findFinalCreateForMock.mockResolvedValue({ id: "final-0" });
    await handler(row(buildPendingStrategistBody(CREATE as never, {})));
    expect(cgoApproveAdDecisionMock.mock.calls[0]?.[1]).toBe("final-0");
  });
});
