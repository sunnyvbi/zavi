
import { describe, it, expect, vi, beforeEach } from "vitest";

type TableResult = { data: unknown; error: { message: string } | null };

const tableResults = new Map<string, TableResult[]>();
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = {
  data: true,
  error: null,
};

function nextResult(table: string): TableResult {
  const q = tableResults.get(table);
  if (!q || q.length === 0) throw new Error(`no mock result queued for table ${table}`);
  return q.length > 1 ? (q.shift() as TableResult) : q[0];
}

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "lte", "lt", "gte", "like", "in", "order", "limit"]) {
    b[m] = vi.fn(() => b);
  }
  b.maybeSingle = vi.fn(async () => nextResult(table));
  (b as { then?: unknown }).then = (
    res: (v: TableResult) => unknown,
    rej: (e: unknown) => unknown,
  ) => Promise.resolve(nextResult(table)).then(res, rej);
  return b;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  }),
}));

const callMcpTool = vi.fn();
vi.mock("@/services/mcp/execute", () => ({
  callMcpTool: (...a: unknown[]) => callMcpTool(...a),
}));

vi.mock("@/services/tools/meta-ads/_client", () => ({
  fbGet: vi.fn(),
  metaAdsCreds: vi.fn(),
  metaActionValue: vi.fn(() => 0),
}));
vi.mock("@/services/tools/growth/native_funnel", () => ({
  readNativeFunnel: vi.fn(),
}));

import {
  readPrDeliveryOutcome,
  readEmailDeliveryOutcome,
  reconcilePendingOutcomes,
  type PendingOutcomeRow,
} from "../action-outcomes";

const prRow = (overrides: Partial<PendingOutcomeRow> = {}): PendingOutcomeRow => ({
  id: 7,
  tenant_id: "ten-1",
  decision_id: "dec-1",
  subject_type: "pr",
  subject_id: "acme/webapp#engineer/fix-login",
  target_metric: "pr_state",
  baseline_metrics: null,
  measurement_window_days: 7,
  reconcile_after: "2026-07-01T00:00:00.000Z",
  attempt_count: 0,
  action_class: "engineer.ship-pr",
  decision_outcome: "approved",
  outcome_tier: "delivery",
  ...overrides,
});

const emailRow = (overrides: Partial<PendingOutcomeRow> = {}): PendingOutcomeRow =>
  prRow({
    id: 8,
    decision_id: "dec-2",
    subject_type: "email",
    subject_id: "dec-2",
    target_metric: "delivered",
    measurement_window_days: 1,
    action_class: "outbound.send",
    ...overrides,
  });

const decision = (overrides: Record<string, unknown> = {}) => ({
  data: {
    status: "acted",
    dispatch_error: null,
    dispatched_at: "2026-06-25T00:00:00.000Z",
    agent_run_id: "run-1",
    ...overrides,
  },
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  tableResults.clear();
  rpcCalls.length = 0;
  rpcResult = { data: true, error: null };
});

describe("readEmailDeliveryOutcome", () => {
  it("acted → measured delivered:true (dispatch result IS the delivery outcome)", async () => {
    tableResults.set("decisions", [decision()]);
    const r = await readEmailDeliveryOutcome(emailRow());
    expect(r).toMatchObject({
      kind: "measured",
      snapshot: { delivered: true, dispatch_status: "acted" },
    });
  });

  it("rejected with dispatch_error → measured delivered:false, error carried", async () => {
    tableResults.set("decisions", [
      decision({ status: "rejected", dispatch_error: "sendgrid 500" }),
    ]);
    const r = await readEmailDeliveryOutcome(emailRow());
    expect(r).toMatchObject({
      kind: "measured",
      snapshot: {
        delivered: false,
        dispatch_status: "dispatch_error",
        dispatch_error: "sendgrid 500",
      },
    });
  });

  it("still 'approved' (never dispatched in the window) → no_data, never fabricated", async () => {
    tableResults.set("decisions", [decision({ status: "approved" })]);
    const r = await readEmailDeliveryOutcome(emailRow());
    expect(r).toEqual({ kind: "no_data" });
  });

  it("decision row missing → error read", async () => {
    tableResults.set("decisions", [{ data: null, error: null }]);
    const r = await readEmailDeliveryOutcome(emailRow());
    expect(r.kind).toBe("error");
  });
});

describe("readPrDeliveryOutcome", () => {
  const runParsed = (parsed: Record<string, unknown> | null) => ({
    data: parsed === null ? null : { parsed },
    error: null,
  });

  it("dispatch rejected → measured delivered:false pr_state failed_to_open", async () => {
    tableResults.set("decisions", [
      decision({ status: "rejected", dispatch_error: "merge_gate_failed" }),
    ]);
    const r = await readPrDeliveryOutcome(prRow());
    expect(r).toMatchObject({
      kind: "measured",
      snapshot: { delivered: false, pr_state: "failed_to_open" },
    });
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("webhook-stamped merged → measured pr_state merged, NO live github call", async () => {
    tableResults.set("decisions", [decision()]);
    tableResults.set("agent_runs", [
      runParsed({
        pr_url: "https://github.com/acme/webapp/pull/5",
        pr_number: 5,
        pr_repo: "acme/webapp",
        merged: true,
      }),
    ]);
    const r = await readPrDeliveryOutcome(prRow());
    expect(r).toMatchObject({
      kind: "measured",
      snapshot: { delivered: true, pr_number: 5, pr_state: "merged" },
    });
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it("webhook-stamped closed_unmerged → pr_state closed", async () => {
    tableResults.set("decisions", [decision()]);
    tableResults.set("agent_runs", [
      runParsed({
        pr_url: "https://github.com/acme/webapp/pull/6",
        pr_number: 6,
        pr_repo: "acme/webapp",
        pr_state: "closed_unmerged",
      }),
    ]);
    const r = await readPrDeliveryOutcome(prRow());
    expect(r).toMatchObject({ kind: "measured", snapshot: { pr_state: "closed" } });
  });

  it("no terminal stamp → live github get_pr read (still-open case)", async () => {
    tableResults.set("decisions", [decision()]);
    tableResults.set("agent_runs", [
      runParsed({
        pr_url: "https://github.com/acme/webapp/pull/7",
        pr_number: 7,
        pr_repo: "acme/webapp",
      }),
    ]);
    callMcpTool.mockResolvedValue({
      is_error: false,
      content: JSON.stringify({ number: 7, state: "open", merged: false }),
    });
    const r = await readPrDeliveryOutcome(prRow());
    expect(callMcpTool).toHaveBeenCalledWith(
      { tenant_id: "ten-1", run_id: "run-1" },
      "github",
      "get_pr",
      { owner: "acme", repo: "webapp", pull_number: 7 },
    );
    expect(r).toMatchObject({
      kind: "measured",
      snapshot: { delivered: true, pr_state: "open" },
    });
  });

  it("live read says merged → pr_state merged", async () => {
    tableResults.set("decisions", [decision()]);
    tableResults.set("agent_runs", [
      runParsed({ pr_url: "u", pr_number: 8, pr_repo: "acme/webapp" }),
    ]);
    callMcpTool.mockResolvedValue({
      is_error: false,
      content: JSON.stringify({ number: 8, state: "closed", merged: true }),
    });
    const r = await readPrDeliveryOutcome(prRow());
    expect(r).toMatchObject({ kind: "measured", snapshot: { pr_state: "merged" } });
  });

  it("live read fails → PR stays delivered, state degrades to 'unknown' (never erased)", async () => {
    tableResults.set("decisions", [decision()]);
    tableResults.set("agent_runs", [
      runParsed({ pr_url: "u", pr_number: 9, pr_repo: "acme/webapp" }),
    ]);
    callMcpTool.mockResolvedValue({ is_error: true, content: "github_app_revoked" });
    const r = await readPrDeliveryOutcome(prRow());
    expect(r).toMatchObject({
      kind: "measured",
      snapshot: { delivered: true, pr_state: "unknown" },
    });
  });

  it("acted but pr_url writeback missing → no_data (honest gap, no guess)", async () => {
    tableResults.set("decisions", [decision()]);
    tableResults.set("agent_runs", [runParsed({})]);
    const r = await readPrDeliveryOutcome(prRow());
    expect(r).toEqual({ kind: "no_data" });
  });

  it("acted with no agent_run_id → no_data", async () => {
    tableResults.set("decisions", [decision({ agent_run_id: null })]);
    const r = await readPrDeliveryOutcome(prRow());
    expect(r).toEqual({ kind: "no_data" });
  });
});

describe("reconcilePendingOutcomes — delivery rows", () => {
  it("routes a pr row to the pr read and stamps measured with EMPTY delta", async () => {
    tableResults.set("action_outcomes", [{ data: [prRow()], error: null }]);
    tableResults.set("decisions", [decision()]);
    tableResults.set("agent_runs", [
      {
        data: {
          parsed: {
            pr_url: "https://github.com/acme/webapp/pull/5",
            pr_number: 5,
            pr_repo: "acme/webapp",
            merged: true,
          },
        },
        error: null,
      },
    ]);

    const res = await reconcilePendingOutcomes("2026-07-02T00:00:00.000Z");
    expect(res).toMatchObject({ scanned: 1, measured: 1, errors: 0, no_data: 0 });

    const stamp = rpcCalls.find((c) => c.fn === "reconcile_action_outcome");
    expect(stamp).toBeTruthy();
    expect(stamp?.args.p_status).toBe("measured");
    expect(stamp?.args.p_outcome_metrics).toMatchObject({
      delivered: true,
      pr_state: "merged",
    });
    expect(stamp?.args.p_delta_metrics).toEqual({});
  });

  it("routes an email row to the dispatch-result read", async () => {
    tableResults.set("action_outcomes", [{ data: [emailRow()], error: null }]);
    tableResults.set("decisions", [decision()]);

    const res = await reconcilePendingOutcomes("2026-07-02T00:00:00.000Z");
    expect(res).toMatchObject({ scanned: 1, measured: 1 });
    const stamp = rpcCalls.find((c) => c.fn === "reconcile_action_outcome");
    expect(stamp?.args.p_outcome_metrics).toMatchObject({ delivered: true });
    expect(stamp?.args.p_delta_metrics).toEqual({});
  });
});
